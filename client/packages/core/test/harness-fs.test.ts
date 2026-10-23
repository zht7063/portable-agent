import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlledFs, nodeFsOps } from '@pa/core/harness';

async function setup(extra: Partial<ConstructorParameters<typeof ControlledFs>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pa-hfs-'));
  const home = join(root, 'home');
  const data = join(root, 'data');
  await mkdir(home, { recursive: true });
  const fs = new ControlledFs({ ops: nodeFsOps, roots: [home, data], dataDir: data, ...extra });
  return { root, home, data, fs };
}
const mode = async (p: string) => (await stat(p)).mode & 0o777;

describe('harness fs: path allowlist', () => {
  it('rejects relative paths, paths outside roots and symlink escapes', async () => {
    const { root, home, fs } = await setup();
    await expect(fs.assertAllowed('rel/x.json')).rejects.toThrow(/absolute/);
    await expect(fs.assertAllowed(join(root, 'elsewhere.json'))).rejects.toThrow(/outside/);
    await expect(fs.assertAllowed(join(home, '..', '..', 'x'))).rejects.toThrow(/outside/);
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(home, '.claude'));
    await expect(fs.atomicWrite(join(home, '.claude', 'settings.json'), '{}')).rejects.toThrow(/resolves outside/);
    expect(await readdir(join(root, 'outside'))).toEqual([]);
    await expect(fs.assertAllowed(join(home, '.pi', 'agent', 'models.json'))).resolves.toBe(join(home, '.pi', 'agent', 'models.json'));
  });
  it('requires dataDir inside a root and absolute roots', () => {
    expect(() => new ControlledFs({ ops: nodeFsOps, roots: ['/tmp/a'], dataDir: '/tmp/b' })).toThrow(/dataDir/);
    expect(() => new ControlledFs({ ops: nodeFsOps, roots: ['rel'], dataDir: 'rel' })).toThrow(/absolute/);
    expect(() => new ControlledFs({ ops: nodeFsOps, roots: [], dataDir: '/tmp' })).toThrow();
  });
});

describe('harness fs: atomic write', () => {
  it('creates new files 0600 (dirs 0700) and keeps the mode of existing files', async () => {
    const { home, fs } = await setup();
    const p = join(home, '.codex', 'config.toml');
    const fp = await fs.atomicWrite(p, 'model = "x"\n');
    expect(await readFile(p, 'utf8')).toBe('model = "x"\n');
    expect(await mode(p)).toBe(0o600);
    expect(await mode(join(home, '.codex'))).toBe(0o700);
    expect(fp).toEqual(await fs.fingerprint(p));
    await chmod(p, 0o640);
    await fs.atomicWrite(p, 'y');
    expect(await mode(p)).toBe(0o640);
  });
  it('failure before rename leaves the original intact and removes the temp file', async () => {
    const { home, fs: base } = await setup();
    const p = join(home, 'settings.json');
    await writeFile(p, 'ORIGINAL');
    const fs = new ControlledFs({ ops: nodeFsOps, roots: [home, base.dataDir], dataDir: base.dataDir, beforeRename: () => { throw new Error('boom'); } });
    await expect(fs.atomicWrite(p, 'NEW')).rejects.toThrow('boom');
    expect(await readFile(p, 'utf8')).toBe('ORIGINAL');
    expect((await readdir(home)).filter((n) => n.includes('pa-tmp'))).toEqual([]);
  });
  it('expect fingerprint: aborts when the file differs, and when it changes between write and rename (TOCTOU)', async () => {
    const { home, data } = await setup();
    const p = join(home, 'settings.json');
    await writeFile(p, 'A');
    let sneak = false;
    const fs = new ControlledFs({ ops: nodeFsOps, roots: [home, data], dataDir: data, beforeRename: async () => { if (sneak) await writeFile(p, 'EXTERNAL'); } });
    const fp = await fs.fingerprint(p);
    await writeFile(p, 'B');
    await expect(fs.atomicWrite(p, 'C', { expect: fp })).rejects.toThrow(/re-run plan/);
    expect(await readFile(p, 'utf8')).toBe('B');
    sneak = true;
    await expect(fs.atomicWrite(p, 'C', { expect: await fs.fingerprint(p) })).rejects.toThrow(/re-run plan/);
    expect(await readFile(p, 'utf8')).toBe('EXTERNAL');
    expect((await readdir(home)).filter((n) => n.includes('pa-tmp'))).toEqual([]);
    sneak = false;
    await expect(fs.atomicWrite(join(home, 'new.json'), 'x', { expect: null })).resolves.toBeTruthy();
    await expect(fs.atomicWrite(join(home, 'new.json'), 'x', { expect: null })).rejects.toThrow(/re-run plan/);
  });
  it('remove honours expect', async () => {
    const { home, fs } = await setup();
    const p = join(home, 'f');
    await writeFile(p, 'A');
    await expect(fs.remove(p, { expect: null })).rejects.toThrow();
    await fs.remove(p, { expect: await fs.fingerprint(p) });
    expect(await fs.fingerprint(p)).toBeNull();
  });
});

describe('harness fs: backups', () => {
  it('first-write backup happens once and never overwrites; records missing files', async () => {
    const { home, data, fs } = await setup();
    const p = join(home, '.claude', 'settings.json');
    const q = join(home, '.pi', 'agent', 'models.json');
    await mkdir(join(home, '.claude'));
    await writeFile(p, '{"user":1}');
    expect(await fs.backupFirstWrite('claude', p)).toBe(true);
    await writeFile(p, '{"changed":1}');
    expect(await fs.backupFirstWrite('claude', p)).toBe(false);
    expect(await fs.backupFirstWrite('pi', q)).toBe(true);
    const claude = await fs.loadBackup('claude', 'first-write');
    expect(claude.map((e) => [e.path, Buffer.from(e.data!).toString()])).toEqual([[p, '{"user":1}']]);
    expect(await fs.loadBackup('pi', 'first-write')).toEqual([{ path: q, data: null }]);
    const dir = join(data, 'harness', 'backups', 'first-write', 'claude');
    expect(await mode(dir)).toBe(0o700);
    for (const n of await readdir(dir)) expect(await mode(join(dir, n))).toBe(0o600);
  });
  it('snapshots keep the newest N and restore byte-identically', async () => {
    let t = Date.parse('2026-10-23T12:00:00Z');
    const { home, fs } = await setup({ retain: 3, now: () => new Date((t += 1000)) });
    const p = join(home, 'settings.json');
    const ids: string[] = [];
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x0d, 0x0a, 0x7d]);
    for (let i = 0; i < 5; i++) { await writeFile(p, i === 4 ? bytes : `v${i}`); ids.push(await fs.snapshot('claude', [p])); }
    const kept = await fs.listSnapshots('claude');
    expect(kept).toEqual(ids.slice(2));
    expect(await fs.listSnapshots('pi')).toEqual([]);
    const last = await fs.loadBackup('claude', { snapshotId: ids[4]! });
    expect(Buffer.from(last[0]!.data!)).toEqual(Buffer.from(bytes));
    await expect(fs.loadBackup('claude', { snapshotId: ids[0]! })).rejects.toThrow(/not found/);
    await expect(fs.loadBackup('claude', { snapshotId: '../../etc' })).rejects.toThrow(/Invalid/);
  });
});
