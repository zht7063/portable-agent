import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PaException } from '../../contract/errors.js';
import type { FileFingerprint, HarnessId } from '../../contract/harness.js';
import type { FsOps } from './ops.js';

export const DEFAULT_SNAPSHOT_RETAIN = 10;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface ControlledFsOptions {
  ops: FsOps;
  /** Allowlisted roots (absolute). Every read/write target must resolve inside one of them. */
  roots: string[];
  /** Client data dir; backups and state live under <dataDir>/harness. Must be inside a root. */
  dataDir: string;
  now?: () => Date;
  retain?: number;
  /** Test hook: runs after the temp file is written, before rename. */
  beforeRename?: (target: string, tmp: string) => Promise<void> | void;
}

export interface BackupEntry { path: string; data: Uint8Array | null }
interface BackupMeta { path: string; existed: boolean; mode?: number }

const sha256 = (d: Uint8Array | string) => createHash('sha256').update(d).digest('hex');
const enc = (p: string) => encodeURIComponent(p);
const eqFp = (a: FileFingerprint | null, b: FileFingerprint | null) =>
  a === b || (!!a && !!b && a.sha256 === b.sha256 && a.size === b.size && a.mtimeMs === b.mtimeMs);
const fail = (message: string): never => { throw new PaException({ code: 'VALIDATION', message }); };

/**
 * Controlled file layer for harness configs: path allowlist, sha256+mtime fingerprints,
 * atomic write (tmp in same dir -> fsync -> rename -> fsync dir), first-write backup + rolling snapshots.
 * Never logs or returns file contents except to the caller that asked for them.
 */
export class ControlledFs {
  readonly ops: FsOps;
  readonly dataDir: string;
  private readonly roots: string[];
  private readonly now: () => Date;
  private readonly retain: number;
  private readonly beforeRename?: ControlledFsOptions['beforeRename'];

  constructor(o: ControlledFsOptions) {
    if (!o.roots.length) fail('ControlledFs needs at least one allowed root');
    for (const r of [...o.roots, o.dataDir]) if (!isAbsolute(r)) fail('Allowed roots must be absolute paths');
    this.ops = o.ops;
    this.roots = o.roots.map((r) => resolve(r));
    this.dataDir = resolve(o.dataDir);
    this.now = o.now ?? (() => new Date());
    this.retain = Math.max(1, o.retain ?? DEFAULT_SNAPSHOT_RETAIN);
    this.beforeRename = o.beforeRename;
    if (!this.inRoots(this.dataDir, this.roots)) fail('dataDir must be inside an allowed root');
  }

  get backupDir(): string { return join(this.dataDir, 'harness', 'backups'); }

  private inRoots(p: string, roots: string[]): boolean {
    return roots.some((r) => { const rel = relative(r, p); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); });
  }

  /** Throws unless `path` (and, after resolving symlinks, its nearest existing ancestor) is inside an allowed root. */
  async assertAllowed(path: string): Promise<string> {
    if (!isAbsolute(path)) fail('Harness paths must be absolute');
    const p = resolve(path);
    if (!this.inRoots(p, this.roots)) fail('Path outside the allowed harness roots');
    // Symlink escape check: the nearest existing ancestor (up to the root) must resolve inside the resolved root.
    const root = this.roots.filter((r) => this.inRoots(p, [r])).sort((a, b) => b.length - a.length)[0]!;
    const realRoot = await this.realish(root);
    for (let probe = p; ; probe = dirname(probe)) {
      const real = await this.ops.realpath(probe);
      if (real !== null) {
        if (!this.inRoots(real, [realRoot])) fail('Path resolves outside the allowed harness roots');
        break;
      }
      if (probe === root || dirname(probe) === probe) break;
    }
    return p;
  }

  /** realpath of the nearest existing ancestor + the remaining (non-existent) segments. */
  private async realish(p: string): Promise<string> {
    const rest: string[] = [];
    for (let cur = p; ; cur = dirname(cur)) {
      const real = await this.ops.realpath(cur);
      if (real !== null) return join(real, ...rest.reverse());
      if (dirname(cur) === cur) return p;
      rest.push(basename(cur));
    }
  }

  async fingerprint(path: string): Promise<FileFingerprint | null> {
    const p = await this.assertAllowed(path);
    const st = await this.ops.stat(p);
    if (!st) return null;
    if (!st.isFile) fail('Harness config path is not a regular file');
    const data = await this.ops.readFile(p);
    return { sha256: sha256(data), mtimeMs: st.mtimeMs, size: data.byteLength };
  }

  /** Reads text + fingerprint (null if missing). */
  async readText(path: string): Promise<{ text: string; fingerprint: FileFingerprint } | null> {
    const p = await this.assertAllowed(path);
    const st = await this.ops.stat(p);
    if (!st) return null;
    if (!st.isFile) fail('Harness config path is not a regular file');
    const data = await this.ops.readFile(p);
    return { text: new TextDecoder().decode(data), fingerprint: { sha256: sha256(data), mtimeMs: st.mtimeMs, size: data.byteLength } };
  }

  private async ensureDir(d: string, mode: number) {
    await this.ops.mkdir(d, mode);
  }

  private async writeBackupFile(dir: string, path: string, data: Uint8Array | null, mode?: number) {
    await this.ensureDir(dir, DIR_MODE);
    await this.ops.chmod(dir, DIR_MODE);
    const meta: BackupMeta = { path, existed: data !== null, ...(mode !== undefined ? { mode } : {}) };
    if (data) await this.writeFresh(join(dir, `${enc(path)}.bak`), data, FILE_MODE);
    await this.writeFresh(join(dir, `${enc(path)}.meta.json`), new TextEncoder().encode(JSON.stringify(meta)), FILE_MODE);
  }

  private async writeFresh(target: string, data: Uint8Array, mode: number) {
    await this.ops.rm(target);
    await this.ops.writeFile(target, data, mode);
  }

  /** Copies the original file once, ever, before we first touch it. Returns true if a backup was made now. */
  async backupFirstWrite(harness: HarnessId, path: string): Promise<boolean> {
    const p = await this.assertAllowed(path);
    const dir = join(this.backupDir, 'first-write', harness);
    if (await this.ops.stat(join(dir, `${enc(p)}.meta.json`))) return false;
    const st = await this.ops.stat(p);
    await this.writeBackupFile(dir, p, st ? await this.ops.readFile(p) : null, st?.mode);
    return true;
  }

  /** Snapshot the current state of `paths` (missing files recorded as such). Prunes to the newest N. */
  async snapshot(harness: HarnessId, paths: string[]): Promise<string> {
    const id = `${this.now().toISOString().replace(/:/g, '-')}-${randomBytes(3).toString('hex')}`;
    const dir = join(this.backupDir, 'snapshots', id, harness);
    for (const path of paths) {
      const p = await this.assertAllowed(path);
      const st = await this.ops.stat(p);
      await this.writeBackupFile(dir, p, st ? await this.ops.readFile(p) : null, st?.mode);
    }
    await this.ops.chmod(join(this.backupDir, 'snapshots', id), DIR_MODE);
    await this.prune();
    return id;
  }

  async listSnapshots(harness?: HarnessId): Promise<string[]> {
    const all = (await this.ops.readdir(join(this.backupDir, 'snapshots'))).sort();
    if (!harness) return all;
    const out: string[] = [];
    for (const id of all) if (await this.ops.stat(join(this.backupDir, 'snapshots', id, harness))) out.push(id);
    return out;
  }

  private async prune() {
    const all = await this.listSnapshots();
    for (const id of all.slice(0, Math.max(0, all.length - this.retain))) await this.ops.rm(join(this.backupDir, 'snapshots', id));
  }

  /** Loads a backup set: first-write or a snapshot id. data=null means the file did not exist. */
  async loadBackup(harness: HarnessId, source: 'first-write' | { snapshotId: string }): Promise<BackupEntry[]> {
    if (typeof source !== 'string' && !/^[0-9TZ.-]+-[0-9a-f]{6}$/.test(source.snapshotId)) fail('Invalid snapshot id');
    const dir = source === 'first-write' ? join(this.backupDir, 'first-write', harness) : join(this.backupDir, 'snapshots', source.snapshotId, harness);
    const names = (await this.ops.readdir(dir)).filter((n) => n.endsWith('.meta.json')).sort();
    if (!names.length) fail('Backup not found');
    const out: BackupEntry[] = [];
    for (const n of names) {
      const meta = JSON.parse(new TextDecoder().decode(await this.ops.readFile(join(dir, n)))) as BackupMeta;
      if (`${enc(meta.path)}.meta.json` !== n) fail('Backup metadata mismatch');
      await this.assertAllowed(meta.path);
      out.push({ path: meta.path, data: meta.existed ? await this.ops.readFile(join(dir, `${enc(meta.path)}.bak`)) : null });
    }
    return out;
  }

  /**
   * Atomically replaces `path` with `data`.
   * `expect` (when given) must equal the current fingerprint (null = file must not exist); checked before
   * writing and again right before rename (TOCTOU). New files get 0600; existing files keep their mode.
   */
  async atomicWrite(path: string, data: Uint8Array | string, opts: { expect?: FileFingerprint | null } = {}): Promise<FileFingerprint> {
    const p = await this.assertAllowed(path);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const check = async () => {
      if (opts.expect === undefined) return;
      if (!eqFp(await this.fingerprint(p), opts.expect)) fail('File changed since it was last read; re-run plan');
    };
    await check();
    const st = await this.ops.stat(p);
    const mode = st ? st.mode & 0o777 : FILE_MODE;
    const dir = dirname(p);
    await this.ensureDir(dir, DIR_MODE);
    const tmp = join(dir, `.${basename(p)}.pa-tmp-${randomBytes(6).toString('hex')}`);
    try {
      await this.ops.writeFile(tmp, bytes, mode);
      await this.beforeRename?.(p, tmp);
      await check();
      await this.ops.rename(tmp, p);
    } catch (e) {
      await this.ops.rm(tmp).catch(() => {});
      throw e;
    }
    await this.ops.fsyncDir(dir);
    const after = await this.ops.stat(p);
    return { sha256: sha256(bytes), mtimeMs: after?.mtimeMs ?? 0, size: bytes.byteLength };
  }

  /** Removes a file (used when restoring a backup of a file that did not exist). Same `expect` semantics. */
  async remove(path: string, opts: { expect?: FileFingerprint | null } = {}): Promise<void> {
    const p = await this.assertAllowed(path);
    if (opts.expect !== undefined && !eqFp(await this.fingerprint(p), opts.expect)) fail('File changed since it was last read; re-run plan');
    await this.ops.rm(p);
    await this.ops.fsyncDir(dirname(p));
  }
}

export const isUnder = (root: string, p: string) => { const rel = relative(resolve(root), resolve(p)); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(sep)); };
export { sha256 as sha256Hex };
