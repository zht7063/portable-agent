import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlledFs, createHarness, nodeFsOps, PiAdapter, piApiKeyValue, piBaseUrl, StateStore, validateProfile, type ExecFn } from '@pa/core/harness';
import { findCredentialLeaks, type HarnessProfile } from '@pa/core';

const SECRET = 'sk-' + 'P'.repeat(40);
const exec: ExecFn = async (cmd) => (cmd === 'pi' ? { code: 0, stdout: '0.70.2\n', stderr: '' } : { code: null, stdout: '', stderr: '' });
const profile = (o: Partial<HarnessProfile> = {}): HarnessProfile => ({ id: 'default', serverUrl: 'http://rain.test:3000', keyId: 7, keyMode: 'command', models: { main: 'deepseek-flash', small: 'deepseek-v4-pro' }, ...o });

async function setup(o: { piSub?: string; env?: Record<string, string>; beforeWrite?: (p: HarnessProfile) => Promise<void>; afterDetach?: (ids: string[]) => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pa-pi-'));
  const home = join(root, 'home'); await mkdir(home);
  const data = join(root, 'data');
  const fs = new ControlledFs({ ops: nodeFsOps, roots: [home, data], dataDir: data });
  const state = new StateStore(fs);
  const env = { home, env: { ...(o.env ?? {}), ...(o.piSub ? { PI_CODING_AGENT_DIR: join(home, o.piSub) } : {}) }, platform: 'linux' as const };
  const helper = join(data, 'bin', 'pa-key');
  const pi = new PiAdapter({ fs, state, env, exec, helperPath: helper, beforeWrite: o.beforeWrite, afterDetach: o.afterDetach });
  const h = createHarness({ fs, state, env, exec, adapters: { pi } });
  const dir = env.env.PI_CODING_AGENT_DIR ?? join(home, '.pi', 'agent');
  return { h, pi, fs, state, home, dir, helper, models: join(dir, 'models.json'), settings: join(dir, 'settings.json') };
}
const json = async (p: string) => JSON.parse(await readFile(p, 'utf8'));

describe('pi adapter: values', () => {
  it('command apiKey quotes the helper path; env references a var; plaintext refused', () => {
    expect(piApiKeyValue(profile(), "/x/it's/pa-key", 'linux')).toBe(`!'/x/it'\\''s/pa-key' default pi`);
    expect(piApiKeyValue(profile(), 'C:\\Users\\a b\\pa-key.cmd', 'win32')).toBe('!"C:\\Users\\a b\\pa-key.cmd" default pi');
    expect(piApiKeyValue(profile({ keyMode: 'env' }), '/x', 'linux')).toBe('$PA_API_KEY');
    expect(piApiKeyValue(profile({ keyMode: 'env', envVar: 'RAIN_KEY' }), '/x', 'linux')).toBe('$RAIN_KEY');
    expect(() => piApiKeyValue(profile({ keyMode: 'plaintext' }), '/x', 'linux')).toThrow(/Plaintext/);
    expect(() => piApiKeyValue(profile(), 'rel/pa-key', 'linux')).toThrow(/absolute/);
  });
  it('base URL: /v1 for openai-completions, bare origin for anthropic-messages; rejects creds/query', () => {
    expect(piBaseUrl('http://h:3000', 'openai-completions')).toBe('http://h:3000/v1');
    expect(piBaseUrl('http://h:3000/v1/', 'openai-completions')).toBe('http://h:3000/v1');
    expect(piBaseUrl('http://h:3000/v1', 'anthropic-messages')).toBe('http://h:3000');
    expect(() => piBaseUrl('http://u:p@h', 'openai-completions')).toThrow();
    expect(() => piBaseUrl('ftp://h', 'openai-completions')).toThrow();
  });
  it('validateProfile drops unknown fields (a smuggled key never reaches state)', () => {
    const p = validateProfile({ ...profile(), secret: SECRET } as unknown as HarnessProfile);
    expect(JSON.stringify(p)).not.toContain(SECRET);
    expect(() => validateProfile(profile({ id: '../x' }))).toThrow();
    expect(() => validateProfile(profile({ keyId: -1 }))).toThrow();
  });
});

describe('pi adapter: plan/apply/rollback on a temp HOME', () => {
  it('fresh install: creates models.json + settings.json (0600), no key on disk, state updated', async () => {
    const seen: string[] = [];
    const s = await setup({ beforeWrite: async (p) => { seen.push(p.id); } });
    await s.h.upsertProfile(profile());
    const plan = await s.h.plan('pi', 'default');
    expect(plan.conflicts).toEqual([]);
    expect(plan.changes.map((c) => [c.setting, c.kind])).toEqual([['providers.pa', 'create'], ['defaultProvider', 'create'], ['defaultModel', 'create']]);
    expect(findCredentialLeaks(plan)).toEqual([]);
    const r = await s.h.apply('pi', plan);
    expect(seen).toEqual(['default']);
    expect(r.written).toEqual([s.models, s.settings]);
    expect(await json(s.models)).toEqual({ providers: { pa: {
      baseUrl: 'http://rain.test:3000/v1', api: 'openai-completions', apiKey: `!'${s.helper}' default pi`,
      models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
    } } });
    expect(await json(s.settings)).toEqual({ defaultProvider: 'pa', defaultModel: 'deepseek-flash' });
    expect((await stat(s.models)).mode & 0o777).toBe(0o600);
    const st = await s.state.load();
    expect(Object.keys(st.files).sort()).toEqual([s.models, s.settings].sort());
    // Re-plan is a no-op.
    const again = await s.h.plan('pi', 'default');
    expect(again.changes.every((c) => c.kind === 'unchanged')).toBe(true);
    expect((await s.h.apply('pi', again)).written).toEqual([]);
  });

  it('preserves user content/comments and restores previous defaults on detach', async () => {
    const detached: string[][] = [];
    const s = await setup({ afterDetach: async (ids) => { detached.push(ids); } });
    await mkdir(s.dir, { recursive: true });
    const models = '{\n  // my providers\n  "providers": {\n    "ollama": { "baseUrl": "http://localhost:11434/v1", "api": "openai-completions", "apiKey": "ollama", "models": [] }\n  }\n}\n';
    const settings = '{\n    "theme": "dark",\n    "defaultProvider": "anthropic",\n    "defaultModel": "claude-x"\n}\n';
    await writeFile(s.models, models); await writeFile(s.settings, settings);
    await s.h.upsertProfile(profile());
    const plan = await s.h.plan('pi', 'default');
    expect(plan.changes.find((c) => c.setting === 'defaultModel')).toMatchObject({ kind: 'modify', before: 'claude-x', after: 'deepseek-flash' });
    await s.h.apply('pi', plan);
    const m = await readFile(s.models, 'utf8');
    expect(m).toContain('// my providers');
    expect(m).toContain('"ollama": { "baseUrl"');
    expect((await json(s.settings)).theme).toBe('dark');
    const r = await s.h.rollback('pi', 'detach');
    expect(r.written.sort()).toEqual([s.models, s.settings].sort());
    expect(await readFile(s.settings, 'utf8')).toBe(settings);
    expect(JSON.parse((await readFile(s.models, 'utf8')).replace(/\/\/.*\n/, ''))).toEqual({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', apiKey: 'ollama', models: [] } } });
    expect(Object.keys((await s.state.load()).files)).toEqual([]);
    expect(detached).toEqual([['default']]);
  });

  it('existing provider named "pa" is a name-collision needing an explicit ack; keep-external skips that file', async () => {
    const s = await setup();
    await mkdir(s.dir, { recursive: true });
    await writeFile(s.models, JSON.stringify({ providers: { pa: { baseUrl: 'http://other', apiKey: SECRET, models: [] } } }, null, 2));
    await s.h.upsertProfile(profile());
    const plan = await s.h.plan('pi', 'default');
    expect(plan.conflicts.map((c) => c.kind)).toEqual(['name-collision']);
    expect(JSON.stringify(plan)).not.toContain(SECRET);
    await expect(s.h.apply('pi', plan)).rejects.toThrow(/Unresolved conflict/);
    const c = plan.conflicts[0]!.id;
    const r = await s.h.apply('pi', plan, [{ conflictId: c, resolution: 'keep-external' }]);
    expect(r.written).toEqual([s.settings]);
    expect((await json(s.models)).providers.pa.baseUrl).toBe('http://other');
    // overwrite after a fresh plan; first-write backup keeps the original, state never stores it.
    const p2 = await s.h.plan('pi', 'default');
    await s.h.apply('pi', p2, [{ conflictId: c, resolution: 'overwrite' }]);
    expect((await json(s.models)).providers.pa.baseUrl).toBe('http://rain.test:3000/v1');
    expect(await readFile((await s.state.load(), s.state.path), 'utf8')).not.toContain(SECRET);
    await s.h.rollback('pi', 'first-write');
    expect((await json(s.models)).providers.pa.apiKey).toBe(SECRET);
  });

  it('external edit of an owned value -> conflict; unowned edit -> merge notice; stale plan rejected', async () => {
    const s = await setup();
    await s.h.upsertProfile(profile());
    await s.h.apply('pi', await s.h.plan('pi', 'default'));
    const stale = await s.h.plan('pi', 'default');
    const cur = await json(s.settings);
    await writeFile(s.settings, JSON.stringify({ ...cur, theme: 'light' }, null, 2));
    await expect(s.h.apply('pi', stale)).rejects.toThrow(/re-run plan/);
    const p1 = await s.h.plan('pi', 'default');
    expect(p1.externalUnownedChange).toEqual([s.settings]);
    expect(p1.conflicts).toEqual([]);
    await writeFile(s.settings, JSON.stringify({ ...cur, theme: 'light', defaultModel: 'mine' }, null, 2));
    const p2 = await s.h.plan('pi', 'default');
    expect(p2.conflicts.map((c) => c.kind)).toEqual(['external-owned-change']);
    await expect(s.h.rollback('pi', 'detach')).rejects.toThrow(/outside Portable Agent/);
    await s.h.apply('pi', p2, [{ conflictId: p2.conflicts[0]!.id, resolution: 'overwrite' }]);
    expect((await json(s.settings))).toEqual({ defaultProvider: 'pa', defaultModel: 'deepseek-flash', theme: 'light' });
  });

  it('rollback last restores the previous apply and its state; repeated rollback walks back', async () => {
    const s = await setup();
    await s.h.upsertProfile(profile());
    await s.h.apply('pi', await s.h.plan('pi', 'default'));
    const v1 = await readFile(s.models, 'utf8');
    await s.h.upsertProfile(profile({ models: { main: 'deepseek-v4-pro' } }));
    await s.h.apply('pi', await s.h.plan('pi', 'default'));
    expect((await json(s.settings)).defaultModel).toBe('deepseek-v4-pro');
    await s.h.rollback('pi', 'last');
    expect(await readFile(s.models, 'utf8')).toBe(v1);
    await s.h.upsertProfile(profile());
    const p = await s.h.plan('pi', 'default');
    expect(p.conflicts).toEqual([]);
    expect(p.changes.every((c) => c.kind === 'unchanged')).toBe(true);
    await s.h.rollback('pi', 'last');
    await expect(stat(s.models)).rejects.toThrow();
    expect((await s.state.load()).files).toEqual({});
    await expect(s.h.rollback('pi', 'last')).rejects.toThrow(/Nothing to roll back/);
  });

  it('env mode, setDefault=false, provider rename removes the old provider; PI_CODING_AGENT_DIR honoured', async () => {
    const s = await setup({ piSub: 'custom-pi' });
    const s0 = join(s.home, 'custom-pi');
    await s.h.upsertProfile(profile({ keyMode: 'env' }));
    const p = await s.h.plan('pi', 'default');
    expect(p.warnings.join(' ')).toContain('PA_API_KEY');
    await s.h.apply('pi', p);
    expect((await json(join(s0, 'models.json'))).providers.pa.apiKey).toBe('$PA_API_KEY');
    await s.h.upsertProfile(profile({ keyMode: 'env', providerId: 'rain', pi: { setDefault: false, reasoning: ['deepseek-v4-pro'] } }));
    const p2 = await s.h.plan('pi', 'default');
    expect(p2.warnings.join(' ')).toContain('/model');
    await s.h.apply('pi', p2);
    const m = await json(join(s0, 'models.json'));
    expect(Object.keys(m.providers)).toEqual(['rain']);
    expect(m.providers.rain.models).toEqual([{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro', reasoning: true }]);
    expect(await json(join(s0, 'settings.json'))).toEqual({});
  });

  it('detect notes auth.json presence without reading it; plaintext profile cannot be planned', async () => {
    const s = await setup();
    await mkdir(s.dir, { recursive: true });
    await writeFile(join(s.dir, 'auth.json'), JSON.stringify({ pa: { key: SECRET } }));
    const d = (await s.h.detect()).find((x) => x.id === 'pi')!;
    expect(d).toMatchObject({ installed: true, version: '0.70.2' });
    expect(d.notes.join(' ')).toContain('auth.json exists');
    expect(JSON.stringify(d)).not.toContain(SECRET);
    expect(s.h.registered()).toEqual(['pi']);
    await s.h.upsertProfile(profile({ keyMode: 'plaintext' }));
    await expect(s.h.plan('pi', 'default')).rejects.toThrow(/Plaintext/);
    const p = (await s.h.upsertProfile(profile()), await s.h.plan('pi', 'default'));
    expect(p.warnings.join(' ')).toContain('auth.json');
  });

  it('beforeWrite failure aborts before any file is touched', async () => {
    const s = await setup({ beforeWrite: async () => { throw new Error('keychain locked'); } });
    await s.h.upsertProfile(profile());
    await expect(s.h.apply('pi', await s.h.plan('pi', 'default'))).rejects.toThrow('keychain locked');
    await expect(stat(s.models)).rejects.toThrow();
    expect(await s.fs.listSnapshots()).toEqual([]);
  });
});
