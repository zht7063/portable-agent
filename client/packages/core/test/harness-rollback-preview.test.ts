import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter, ControlledFs, createHarness, nodeFsOps, StateStore, type ExecFn } from '@pa/core/harness';
import { findCredentialLeaks, type HarnessProfile } from '@pa/core';

const exec: ExecFn = async () => ({ code: null, stdout: '', stderr: '' });
const profile = (main: string): HarnessProfile => ({ id: 'default', serverUrl: 'http://rain.test:3000', keyId: 7, keyMode: 'command', models: { main }, codex: { setDefault: true } });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pa-rb-'));
  const home = join(root, 'home'); const data = join(root, 'data'); const dir = join(home, 'cx');
  await mkdir(dir, { recursive: true });
  const fs = new ControlledFs({ ops: nodeFsOps, roots: [home, data], dataDir: data });
  const state = new StateStore(fs);
  const env = { home, env: { CODEX_HOME: dir }, platform: 'linux' as const };
  const h = createHarness({ fs, state, env, exec, adapters: { codex: new CodexAdapter({ fs, state, env, exec, helperPath: join(data, 'bin', 'pa-key') }) } });
  return { h, config: join(dir, 'config.toml') };
}

describe('rollback history + preview (H4)', () => {
  it('lists snapshots newest first; previews are masked dry runs that match the real rollback', async () => {
    const s = await setup();
    const user = '# mine\nmodel = "gpt-5"\napi = "sk-' + 'Y'.repeat(30) + '"\n';
    await writeFile(s.config, user);
    expect(await s.h.history('codex')).toMatchObject({ snapshots: [], firstWrite: false, attached: false });
    expect((await s.h.previewRollback('codex', 'last')).blocked).toMatch(/Nothing to roll back/);
    await s.h.upsertProfile(profile('m1')); await s.h.apply('codex', await s.h.plan('codex', 'default'));
    await s.h.upsertProfile(profile('m2')); await s.h.apply('codex', await s.h.plan('codex', 'default'));
    const hist = await s.h.history('codex');
    expect(hist).toMatchObject({ firstWrite: true, attached: true });
    expect(hist.snapshots.map((x) => x.action)).toEqual(['apply', 'apply']);
    expect(hist.snapshots[0]!.at >= hist.snapshots[1]!.at).toBe(true);
    expect(hist.snapshots.every((x) => x.available)).toBe(true);

    const before = await readFile(s.config, 'utf8');
    const last = await s.h.previewRollback('codex', 'last');
    expect(await readFile(s.config, 'utf8')).toBe(before); // dry run
    expect(last.blocked).toBeUndefined();
    expect(last.files).toEqual([{ path: s.config, kind: 'modify' }]);
    expect(last.changes).toContainEqual({ file: s.config, setting: 'model', kind: 'modify', before: 'm2', after: 'm1' });

    const first = await s.h.previewRollback('codex', 'first-write');
    expect(first.changes).toContainEqual(expect.objectContaining({ setting: 'model', before: 'm2', after: 'gpt-5' }));
    expect(first.changes).toContainEqual(expect.objectContaining({ setting: 'model_providers.pa', kind: 'remove', after: null }));
    expect(findCredentialLeaks(first)).toEqual([]);
    expect(JSON.stringify(first)).not.toContain('YYYY');

    const det = await s.h.previewRollback('codex', 'detach');
    expect(det.changes.map((c) => c.setting).sort()).toEqual(['model', 'model_provider', 'model_providers.pa']);

    // preview of a specific snapshot == what rollback does
    const snap = hist.snapshots[0]!.snapshotId;
    const p = await s.h.previewRollback('codex', { snapshotId: snap });
    await s.h.rollback('codex', { snapshotId: snap });
    expect(p.changes.find((c) => c.setting === 'model')?.after).toBe('m1');
    expect(await readFile(s.config, 'utf8')).toContain('model = "m1"');
    expect((await s.h.history('codex')).snapshots[0]!.action).toBe('rollback');

    // detach is blocked after an external edit of a managed setting
    await writeFile(s.config, (await readFile(s.config, 'utf8')).replace('model = "m1"', 'model = "hand"'));
    expect((await s.h.previewRollback('codex', 'detach')).blocked).toMatch(/changed outside/);
    expect((await s.h.previewRollback('codex', { snapshotId: 'nope' })).blocked).toMatch(/not found/);
  });
});

describe('rollback guards external edits (Aegis #1)', () => {
  it('refuses to discard edits made after our last apply unless overwriteExternal; preview lists them', async () => {
    const s = await setup();
    await writeFile(s.config, '# mine\nmodel = "gpt-5"\n');
    await s.h.upsertProfile(profile('m1')); await s.h.apply('codex', await s.h.plan('codex', 'default'));
    // clean state: no confirmation needed
    expect((await s.h.previewRollback('codex', 'first-write')).externalEdits).toBeUndefined();
    // user edits an unrelated line after apply
    const edited = (await readFile(s.config, 'utf8')) + '\n[tui]\nanimations = false\n';
    await writeFile(s.config, edited);
    expect((await s.h.previewRollback('codex', 'last')).externalEdits).toEqual([s.config]);
    await expect(s.h.rollback('codex', 'last')).rejects.toThrow(/Modified after Portable Agent last wrote them/);
    await expect(s.h.rollback('codex', 'first-write')).rejects.toThrow(/confirm overwrite/);
    expect(await readFile(s.config, 'utf8')).toBe(edited); // untouched
    await s.h.rollback('codex', 'first-write', { overwriteExternal: true });
    expect(await readFile(s.config, 'utf8')).toBe('# mine\nmodel = "gpt-5"\n');
    // the discarded edits remain recoverable from the pre-rollback snapshot
    const snap = (await s.h.history('codex')).snapshots[0]!;
    expect(snap.action).toBe('rollback');
    await s.h.rollback('codex', { snapshotId: snap.snapshotId }, { overwriteExternal: true });
    expect(await readFile(s.config, 'utf8')).toBe(edited);
  });
});
