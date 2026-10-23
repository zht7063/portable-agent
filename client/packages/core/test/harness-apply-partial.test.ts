import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ControlledFs, createHarness, nodeFsOps, PiAdapter, StateStore, type ExecFn, type FsOps } from '@pa/core/harness';
import type { HarnessProfile } from '@pa/core';

const exec: ExecFn = async () => ({ code: null, stdout: '', stderr: '' });
const profile: HarnessProfile = { id: 'default', serverUrl: 'http://rain.test:3000', keyId: 7, keyMode: 'command', models: { main: 'deepseek-flash' }, pi: { setDefault: true } };

describe('apply failing midway (Aegis #2)', () => {
  it('records state for files already written, keeps history, and rollback last restores them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pa-partial-'));
    const home = join(root, 'home'); const data = join(root, 'data'); const dir = join(home, '.pi', 'agent');
    await mkdir(dir, { recursive: true });
    const models = join(dir, 'models.json'); const settings = join(dir, 'settings.json');
    await writeFile(models, '{"providers":{"mine":{"baseUrl":"http://x"}}}\n');
    await writeFile(settings, '{"theme":"dark"}\n');
    let failOn: string | null = null; const order: string[] = [];
    const ops: FsOps = { ...nodeFsOps, async rename(from, to) {
      if (to === models || to === settings) { order.push(basename(to)); if (order.length === 2 && failOn === 'second') throw new Error('disk full'); }
      return nodeFsOps.rename(from, to);
    } };
    const fs = new ControlledFs({ ops, roots: [home, data], dataDir: data });
    const state = new StateStore(fs);
    const env = { home, env: {}, platform: 'linux' as const };
    const h = createHarness({ fs, state, env, exec, adapters: { pi: new PiAdapter({ fs, state, env, exec, helperPath: join(data, 'bin', 'pa-key') }) } });
    await h.upsertProfile(profile);
    const plan = await h.plan('pi', 'default');
    expect(new Set(plan.changes.map((c) => c.file))).toEqual(new Set([models, settings]));
    const orig = { m: await readFile(models, 'utf8'), s: await readFile(settings, 'utf8') };
    failOn = 'second';
    await expect(h.apply('pi', plan)).rejects.toThrow();
    const [firstName] = order; const first = firstName === 'models.json' ? models : settings; const second = first === models ? settings : models;
    const st = await state.load();
    expect(Object.keys(st.files)).toEqual([first]); // written file tracked, failed one not
    expect(st.history.filter((x) => x.harness === 'pi' && x.action === 'apply')).toHaveLength(1);
    expect(await readFile(second, 'utf8')).toBe(second === models ? orig.m : orig.s);
    // a re-plan sees the written file as clean (no spurious conflict) and only the missing change remains
    failOn = null;
    const again = await h.plan('pi', 'default');
    expect(again.conflicts).toEqual([]);
    expect(again.changes.filter((c) => c.kind !== 'unchanged').every((c) => c.file === second)).toBe(true);
    // rollback last restores the partially applied file without needing an overwrite confirmation
    await h.rollback('pi', 'last');
    expect(await readFile(models, 'utf8')).toBe(orig.m);
    expect(await readFile(settings, 'utf8')).toBe(orig.s);
  });
});
