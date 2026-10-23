/**
 * Shared plan/apply/rollback/detach engine for adapters whose managed files are JSON/JSONC (Pi, Claude Code).
 * Never writes a key; never reads auth files. See docs/harness.md.
 */
import { PaException } from '../../contract/errors.js';
import type { ApplyResult, ConflictAck, Conflict, Detection, FileFingerprint, HarnessAdapter, HarnessId, HarnessProfile, LiveSnapshot, Plan, PlannedKeyChange, RollbackTarget } from '../../contract/harness.js';
import type { ControlledFs } from '../fs/controlled.js';
import type { ExecFn } from '../exec.js';
import { getPath, mergeOwnedJson, parseJsonc, type JsonEdit } from '../merge/json.js';
import { maskValue } from '../mask.js';
import type { HarnessEnv } from '../paths.js';
import { canonicalJson, classifyChange, hashOwnedValues, type HistoryEntry, type ManagedFileState, type StateStore } from '../state.js';

export interface AdapterOptions {
  fs: ControlledFs;
  state: StateStore;
  env: HarnessEnv;
  exec: ExecFn;
  /** Absolute path of the pa-key wrapper (D4). */
  helperPath: string;
  /** Working directory for project-level hints (read-only checks). */
  cwd?: string;
  /** Host hook run right before writing (e.g. provision the keychain entry in command mode). Abort by throwing. */
  beforeWrite?: (profile: HarnessProfile) => Promise<void>;
  /** Host hook after detach (e.g. revoke the keychain entry). */
  afterDetach?: (profileIds: string[]) => Promise<void>;
  now?: () => Date;
}

export const bad = (message: string): never => { throw new PaException({ code: 'VALIDATION', message }); };
export const dotted = (p: (string | number)[]) => p.join('.');
export const undot = (s: string) => s.split('.');
export const PROVIDER_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const ownedValues = (root: unknown, settings: string[]): Record<string, unknown> =>
  Object.fromEntries(settings.map((s) => [s, getPath(root, undot(s)) ?? null]));

export const posixQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const winQuote = (s: string) => (/["%]/.test(s) ? bad('Helper path contains unsupported characters') : `"${s}"`);
export const isAbsPath = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
/** Shell-quoted helper invocation: `<helper> <profileId> <harness>` (profile ids are [A-Za-z0-9_-]). */
export function helperCommand(helperPath: string, profileId: string, harness: HarnessId, platform: NodeJS.Platform): string {
  if (!isAbsPath(helperPath)) bad('Helper path must be absolute');
  return `${platform === 'win32' ? winQuote(helperPath) : posixQuote(helperPath)} ${profileId} ${harness}`;
}

export type Desired = Map<string, unknown>; // dotted setting -> value (undefined = remove)
export interface FilePlan {
  path: string; text: string; fp: FileFingerprint | null; root: Record<string, unknown>;
  entry?: ManagedFileState; desired: Desired; owned: string[]; conflict?: Conflict; externalUnowned: boolean;
}
interface Computed { plan: Plan; files: FilePlan[]; profile: HarnessProfile }

export abstract class JsonHarnessAdapter implements HarnessAdapter {
  abstract readonly id: HarnessId;
  constructor(protected readonly o: AdapterOptions) {}
  /** Managed config files (JSON/JSONC). */
  protected abstract configPaths(): string[];
  /** Per file: dotted owned setting -> desired value. Throws VALIDATION for unsupported profiles. */
  protected abstract desiredFor(p: HarnessProfile): Map<string, Desired>;
  /** Settings that, if already set (by someone else) to a different value on a file we never wrote, are a collision. */
  protected abstract collisionSettings(path: string, desired: Desired): string[];
  /** Whether the user's previous value may be remembered in state (never for settings that can hold a credential). */
  protected abstract rememberOriginal(path: string, setting: string): boolean;
  protected abstract planWarnings(p: HarnessProfile, files: FilePlan[]): Promise<string[]>;
  abstract detect(): Promise<Detection>;

  protected now() { return (this.o.now ?? (() => new Date()))().toISOString(); }
  protected async exists(p: string): Promise<boolean> {
    try { return (await this.o.fs.ops.stat(await this.o.fs.assertAllowed(p))) !== null; } catch { return false; }
  }

  /** File format hooks (JSON/JSONC by default; Codex overrides with TOML). */
  protected parseText(text: string): Record<string, unknown> { return parseJsonc(text) as Record<string, unknown>; }
  protected mergeText(text: string, edits: JsonEdit[]): string { return mergeOwnedJson(text, edits); }

  protected async load(path: string) {
    const r = await this.o.fs.readText(path);
    const text = r?.text ?? '';
    return { text, fp: r?.fingerprint ?? null, root: this.parseText(text) };
  }

  async read(): Promise<LiveSnapshot> {
    const st = await this.o.state.load();
    const owned: Record<string, string | null> = {};
    const files = [];
    for (const path of this.configPaths()) {
      const { fp, root } = await this.load(path);
      const entry = st.files[path];
      const settings = entry?.ownedSettings ?? [];
      const vals = ownedValues(root, settings);
      for (const [k, v] of Object.entries(vals)) owned[`${path}#${k}`] = maskValue(v);
      files.push({ path, fingerprint: fp, ownedValuesHash: entry ? hashOwnedValues(vals) : null });
    }
    return { id: this.id, files, owned };
  }

  private async compute(profile: HarnessProfile): Promise<Computed> {
    const st = await this.o.state.load();
    const desiredByFile = this.desiredFor(profile);
    const files: FilePlan[] = [];
    const changes: PlannedKeyChange[] = [];
    const conflicts: Conflict[] = [];
    const warnings: string[] = [];
    const externalUnownedChange: string[] = [];
    const baseFingerprints: Record<string, FileFingerprint | null> = {};
    for (const path of this.configPaths()) {
      const { text, fp, root } = await this.load(path);
      baseFingerprints[path] = fp;
      const entry = st.files[path];
      const desired = new Map(desiredByFile.get(path)!);
      // Settings we owned before but no longer want (e.g. provider id renamed, setDefault turned off): remove/restore.
      for (const s of entry?.ownedSettings ?? []) if (!desired.has(s)) desired.set(s, entry?.original?.[s] ?? undefined);
      const owned = [...desired.keys()];
      const cls = classifyChange(entry, fp, entry ? hashOwnedValues(ownedValues(root, entry.ownedSettings)) : null);
      const fpl: FilePlan = { path, text, fp, root, entry, desired, owned, externalUnowned: cls === 'external-unowned' };
      if (cls === 'external-unowned') externalUnownedChange.push(path);
      if (cls === 'conflict') {
        fpl.conflict = {
          id: `external-owned-change:${path}`, kind: 'external-owned-change', file: path,
          message: 'Settings managed by Portable Agent were changed outside the app',
          current: maskValue(ownedValues(root, entry!.ownedSettings)), proposed: maskValue(Object.fromEntries(desired)),
        };
      } else if (cls === 'untracked') {
        const hit = this.collisionSettings(path, desired).filter((s) => desired.has(s)).filter((s) => {
          const cur = getPath(root, undot(s));
          return cur !== undefined && canonicalJson(cur) !== canonicalJson(desired.get(s));
        });
        if (hit.length) {
          fpl.conflict = {
            id: `name-collision:${path}#${hit.join(',')}`, kind: 'name-collision', file: path, setting: hit.join(','),
            message: `${hit.join(', ')} already set by something else; overwrite it or keep it`,
            current: maskValue(ownedValues(root, hit)), proposed: maskValue(Object.fromEntries(hit.map((s) => [s, desired.get(s)]))),
          };
        }
      }
      if (fpl.conflict) conflicts.push(fpl.conflict);
      for (const [s, v] of desired) {
        const cur = getPath(root, undot(s));
        const kind = cur === undefined ? (v === undefined ? 'unchanged' : 'create') : v === undefined ? 'remove' : canonicalJson(cur) === canonicalJson(v) ? 'unchanged' : 'modify';
        changes.push({ file: path, setting: s, kind, before: maskValue(cur), after: maskValue(v) });
      }
      files.push(fpl);
    }
    warnings.push(...(await this.planWarnings(profile, files)));
    const plan: Plan = { id: this.id, profileId: profile.id, createdAt: this.now(), baseFingerprints, changes, conflicts, warnings, externalUnownedChange };
    return { plan, files, profile };
  }

  async plan(profile: HarnessProfile): Promise<Plan> { return (await this.compute(profile)).plan; }

  private async snapshotWithState(action: HistoryEntry['action']): Promise<HistoryEntry> {
    const st = await this.o.state.load();
    const snapshotId = await this.o.fs.snapshot(this.id, this.configPaths());
    const files = Object.fromEntries(Object.entries(st.files).filter(([p, f]) => f.harness === this.id && this.configPaths().includes(p)));
    return { harness: this.id, snapshotId, at: this.now(), action, files };
  }

  /**
   * Re-plans from the stored profile (the renderer-supplied plan is only trusted for its fingerprints and profile id),
   * requires the same base fingerprints and an acknowledgement for every conflict, then backs up and writes.
   */
  async apply(given: Plan, opts: { acknowledge: ConflictAck[] }): Promise<ApplyResult> {
    const profile = (await this.o.state.load()).profiles[given.profileId] ?? bad('Unknown harness profile');
    const c = await this.compute(profile);
    for (const path of this.configPaths()) {
      const a = given.baseFingerprints?.[path] ?? null; const b = c.plan.baseFingerprints[path] ?? null;
      if (canonicalJson(a) !== canonicalJson(b)) bad('Config changed since the plan was made; re-run plan');
    }
    const acks = new Map((opts.acknowledge ?? []).map((x) => [x.conflictId, x.resolution]));
    const skip = new Set<string>();
    for (const f of c.files) {
      if (!f.conflict) continue;
      const r = acks.get(f.conflict.id);
      if (!r || r === 'cancel') bad('Unresolved conflict; review it and choose overwrite or keep-external');
      if (r === 'keep-external') skip.add(f.path);
    }
    const todo = c.files.filter((f) => !skip.has(f.path) && c.plan.changes.some((ch) => ch.file === f.path && ch.kind !== 'unchanged'));
    const warnings = [...c.plan.warnings];
    if (!todo.length) return { id: this.id, written: [], warnings };
    await this.o.beforeWrite?.(profile);
    const hist = await this.snapshotWithState('apply');
    const written: string[] = [];
    const newEntries: Record<string, ManagedFileState> = {};
    for (const f of todo) {
      await this.o.fs.backupFirstWrite(this.id, f.path);
      const edits: JsonEdit[] = [...f.desired].map(([s, v]) => ({ path: undot(s), value: v }));
      const out = this.mergeText(f.text, edits);
      const fp = await this.o.fs.atomicWrite(f.path, out, { expect: f.fp });
      written.push(f.path);
      const keep = [...f.desired].filter(([, v]) => v !== undefined).map(([s]) => s);
      // Remember the user's previous values once (settings.json defaults only; models.json provider may hold a key).
      const remember = keep.filter((s) => this.rememberOriginal(f.path, s));
      const original = f.entry?.original ?? (remember.length ? ownedValues(f.root, remember) : undefined);
      newEntries[f.path] = {
        harness: this.id, lastWritten: fp, ownedValuesHash: hashOwnedValues(ownedValues(this.parseText(out), keep)),
        ownedSettings: keep, ...(original ? { original } : {}), updatedAt: this.now(),
      };
    }
    await this.o.state.update((s) => {
      for (const [p, e] of Object.entries(newEntries)) { if (e.ownedSettings.length) s.files[p] = e; else delete s.files[p]; }
      s.history.push(hist);
    });
    return { id: this.id, written, snapshotId: hist.snapshotId, warnings };
  }

  private async restore(entries: { path: string; data: Uint8Array | null }[]): Promise<string[]> {
    const written: string[] = [];
    for (const e of entries) {
      if (!this.configPaths().includes(e.path)) bad('Backup contains an unexpected path');
      if (e.data === null) { if (await this.exists(e.path)) { await this.o.fs.remove(e.path); written.push(e.path); } }
      else { await this.o.fs.atomicWrite(e.path, e.data); written.push(e.path); }
    }
    return written;
  }

  async rollback(target: RollbackTarget): Promise<ApplyResult> {
    if (target === 'detach') return this.detach();
    const st = await this.o.state.load();
    let source: 'first-write' | { snapshotId: string };
    let prior: HistoryEntry | undefined;
    if (target === 'first-write') source = 'first-write';
    else if (target === 'last') {
      prior = [...st.history].reverse().find((h) => h.harness === this.id && h.action === 'apply') ?? bad('Nothing to roll back');
      source = { snapshotId: prior.snapshotId };
    } else {
      source = { snapshotId: target.snapshotId };
      prior = st.history.find((h) => h.harness === this.id && h.snapshotId === target.snapshotId);
    }
    const entries = await this.o.fs.loadBackup(this.id, source);
    const hist = await this.snapshotWithState('rollback'); // current state stays recoverable
    const written = await this.restore(entries);
    await this.o.state.update((s) => {
      for (const p of this.configPaths()) delete s.files[p];
      if (prior?.files) for (const [p, e] of Object.entries(prior.files)) s.files[p] = e;
      if (target === 'last' && prior) s.history = s.history.filter((h) => h !== prior && h.snapshotId !== prior!.snapshotId);
      s.history.push(hist);
    });
    // Restored files may differ in mtime from the remembered fingerprint; owned-value hashes still classify them correctly.
    return { id: this.id, written, snapshotId: hist.snapshotId, warnings: [] };
  }

  /** Removes only our managed settings (restoring the user's previous defaults); refuses if they were edited externally. */
  private async detach(): Promise<ApplyResult> {
    const st = await this.o.state.load();
    const mine = this.configPaths().filter((p) => st.files[p]?.harness === this.id);
    if (!mine.length) return { id: this.id, written: [], warnings: ['Nothing to detach'] };
    const loaded = [];
    for (const path of mine) {
      const l = await this.load(path);
      const e = st.files[path]!;
      if (classifyChange(e, l.fp, hashOwnedValues(ownedValues(l.root, e.ownedSettings))) === 'conflict') {
        bad('Managed settings were changed outside Portable Agent; use rollback or edit the file manually');
      }
      loaded.push({ path, ...l, e });
    }
    const hist = await this.snapshotWithState('detach');
    const written: string[] = [];
    for (const l of loaded) {
      const edits = l.e.ownedSettings.map((s) => ({ path: undot(s), value: l.e.original?.[s] ?? undefined }));
      const out = this.mergeText(l.text, edits);
      if (out !== l.text) { await this.o.fs.atomicWrite(l.path, out, { expect: l.fp }); written.push(l.path); }
    }
    await this.o.state.update((s) => { for (const p of mine) delete s.files[p]; s.history.push(hist); });
    const profiles = Object.keys(st.profiles);
    await this.o.afterDetach?.(profiles);
    return { id: this.id, written, snapshotId: hist.snapshotId, warnings: [] };
  }
}
