import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, claudeApiKeyHelper, claudeBaseUrl, claudeEnv, claudeManagedPaths, ControlledFs, createHarness, nodeFsOps, StateStore, type ExecFn } from '@pa/core/harness';
import { findCredentialLeaks, type HarnessProfile } from '@pa/core';

const SECRET = 'sk-' + 'Q'.repeat(40);
const exec: ExecFn = async (cmd) => (cmd === 'claude' ? { code: 0, stdout: '2.1.250 (Claude Code)\n', stderr: '' } : { code: null, stdout: '', stderr: '' });
const profile = (o: Partial<HarnessProfile> = {}): HarnessProfile => ({ id: 'default', serverUrl: 'http://rain.test:3000/v1', keyId: 7, keyMode: 'command', models: { main: 'deepseek-v4-pro', small: 'deepseek-flash' }, ...o });

async function setup(o: { sub?: string; env?: Record<string, string>; cwd?: boolean; afterDetach?: (ids: string[]) => Promise<void>; beforeWrite?: (p: HarnessProfile) => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pa-cc-'));
  const home = join(root, 'home'); await mkdir(home);
  const data = join(root, 'data');
  const fs = new ControlledFs({ ops: nodeFsOps, roots: [home, data], dataDir: data });
  const state = new StateStore(fs);
  const env = { home, env: { ...(o.env ?? {}), ...(o.sub ? { CLAUDE_CONFIG_DIR: join(home, o.sub) } : {}) }, platform: 'linux' as const };
  const helper = join(data, 'bin', 'pa-key');
  const cwd = join(root, 'proj'); await mkdir(cwd);
  const cc = new ClaudeAdapter({ fs, state, env, exec, helperPath: helper, cwd: o.cwd ? cwd : undefined, afterDetach: o.afterDetach, beforeWrite: o.beforeWrite });
  const h = createHarness({ fs, state, env, exec, adapters: { claude: cc } });
  const dir = env.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
  return { h, cc, state, home, dir, cwd, helper, settings: join(dir, 'settings.json') };
}
const json = async (p: string) => JSON.parse(await readFile(p, 'utf8'));

describe('claude adapter: values', () => {
  it('apiKeyHelper: quoted helper in command mode, runtime env expansion in env mode, plaintext refused', () => {
    expect(claudeApiKeyHelper(profile(), "/x/it's/pa-key", 'linux')).toBe(`'/x/it'\\''s/pa-key' default claude`);
    expect(claudeApiKeyHelper(profile(), 'C:\\a b\\pa-key.cmd', 'win32')).toBe('"C:\\a b\\pa-key.cmd" default claude');
    expect(claudeApiKeyHelper(profile({ keyMode: 'env' }), '/x', 'linux')).toBe(`printf '%s' "$PA_API_KEY"`);
    expect(claudeApiKeyHelper(profile({ keyMode: 'env', envVar: 'RAIN_KEY' }), '/x', 'win32')).toBe('echo %RAIN_KEY%');
    expect(() => claudeApiKeyHelper(profile({ keyMode: 'plaintext' }), '/x', 'linux')).toThrow(/Plaintext/);
    expect(() => claudeApiKeyHelper(profile(), 'rel', 'linux')).toThrow(/absolute/);
  });
  it('base URL drops /v1; model mapping defaults (opus/sonnet->main, haiku->small)', () => {
    expect(claudeBaseUrl('http://h:3000/v1/')).toBe('http://h:3000');
    expect(claudeBaseUrl('https://h/api')).toBe('https://h/api');
    expect(() => claudeBaseUrl('http://u:p@h')).toThrow();
    expect(claudeEnv(profile())).toEqual({
      ANTHROPIC_BASE_URL: 'http://rain.test:3000', ANTHROPIC_MODEL: 'deepseek-v4-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
    });
    const e = claudeEnv(profile({ claude: { setModel: false }, models: { main: 'm', opus: 'o', sonnet: 's', haiku: 'h' } }));
    expect(e.ANTHROPIC_MODEL).toBeUndefined();
    expect([e.ANTHROPIC_DEFAULT_OPUS_MODEL, e.ANTHROPIC_DEFAULT_SONNET_MODEL, e.ANTHROPIC_DEFAULT_HAIKU_MODEL]).toEqual(['o', 's', 'h']);
  });
  it('managed settings paths per OS', () => {
    expect(claudeManagedPaths('linux')[0]).toBe('/etc/claude-code/managed-settings.json');
    expect(claudeManagedPaths('darwin')[0]).toBe('/Library/Application Support/ClaudeCode/managed-settings.json');
    expect(claudeManagedPaths('win32')[0]).toBe('C:\\Program Files\\ClaudeCode\\managed-settings.json');
  });
});

describe('claude adapter: plan/apply/rollback', () => {
  it('creates settings.json with owned keys only, keeps user keys, never writes a key', async () => {
    const s = await setup();
    await mkdir(s.dir, { recursive: true });
    await writeFile(s.settings, JSON.stringify({ theme: 'dark', env: { FOO: '1' } }, null, 2));
    await s.h.upsertProfile(profile());
    const plan = await s.h.plan('claude', 'default');
    expect(plan.conflicts).toEqual([]);
    expect(findCredentialLeaks(plan)).toEqual([]);
    const r = await s.h.apply('claude', plan);
    expect(r.written).toEqual([s.settings]);
    const j = await json(s.settings);
    expect(j.theme).toBe('dark');
    expect(j.env.FOO).toBe('1');
    expect(j.apiKeyHelper).toBe(`'${s.helper}' default claude`);
    expect(j.env.ANTHROPIC_BASE_URL).toBe('http://rain.test:3000');
    expect(j.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(j.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(await readFile(s.settings, 'utf8')).not.toContain('sk-');
    // idempotent
    const again = await s.h.plan('claude', 'default');
    expect(again.changes.every((c) => c.kind === 'unchanged')).toBe(true);
  });

  it('honours CLAUDE_CONFIG_DIR', async () => {
    const s = await setup({ sub: 'cc' });
    await s.h.upsertProfile(profile());
    await s.h.apply('claude', await s.h.plan('claude', 'default'));
    expect((await json(join(s.home, 'cc', 'settings.json'))).apiKeyHelper).toContain('default claude');
  });

  it('existing apiKeyHelper / BASE_URL is a collision; keep-external skips; original helper never stored', async () => {
    const s = await setup();
    await mkdir(s.dir, { recursive: true });
    await writeFile(s.settings, JSON.stringify({ apiKeyHelper: `echo ${SECRET}`, env: { ANTHROPIC_BASE_URL: 'https://other', ANTHROPIC_MODEL: 'x' } }));
    await s.h.upsertProfile(profile());
    const plan = await s.h.plan('claude', 'default');
    expect(plan.conflicts.map((c) => c.kind)).toEqual(['name-collision']);
    expect(JSON.stringify(plan)).not.toContain(SECRET);
    await expect(s.h.apply('claude', plan)).rejects.toThrow(/Unresolved/);
    const keep = await s.h.apply('claude', plan, [{ conflictId: plan.conflicts[0]!.id, resolution: 'keep-external' }]);
    expect(keep.written).toEqual([]);
    const r = await s.h.apply('claude', plan, [{ conflictId: plan.conflicts[0]!.id, resolution: 'overwrite' }]);
    expect(r.written).toEqual([s.settings]);
    expect(JSON.stringify(await s.state.load())).not.toContain(SECRET);
    // detach restores remembered non-secret values, removes apiKeyHelper
    await s.h.rollback('claude', 'detach');
    const j = await json(s.settings);
    expect(j.apiKeyHelper).toBeUndefined();
    expect(j.env.ANTHROPIC_BASE_URL).toBe('https://other');
    expect(j.env.ANTHROPIC_MODEL).toBe('x');
    expect(j.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  });

  it('external edit of an owned key is a conflict; rollback last restores previous bytes', async () => {
    const s = await setup();
    await mkdir(s.dir, { recursive: true });
    const before = '{\n  "theme": "light"\n}\n';
    await writeFile(s.settings, before);
    await s.h.upsertProfile(profile());
    await s.h.apply('claude', await s.h.plan('claude', 'default'));
    const j = await json(s.settings); j.env.ANTHROPIC_MODEL = 'hand-edited';
    await writeFile(s.settings, JSON.stringify(j));
    const plan = await s.h.plan('claude', 'default');
    expect(plan.conflicts[0]?.kind).toBe('external-owned-change');
    await s.h.rollback('claude', 'first-write');
    expect(await readFile(s.settings, 'utf8')).toBe(before);
  });

  it('warnings: credential env vars, settings env creds (value hidden), shell overrides, project settings', async () => {
    const s = await setup({ cwd: true, env: { ANTHROPIC_API_KEY: SECRET, ANTHROPIC_MODEL: 'other' } });
    await mkdir(s.dir, { recursive: true });
    await writeFile(s.settings, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SECRET } }));
    await mkdir(join(s.cwd, '.claude'));
    await writeFile(join(s.cwd, '.claude', 'settings.local.json'), '{}');
    await s.h.upsertProfile(profile({ keyMode: 'env' }));
    const plan = await s.h.plan('claude', 'default');
    const w = plan.warnings.join('\n');
    expect(w).toMatch(/ANTHROPIC_API_KEY is set in the environment/);
    expect(w).toMatch(/settings.json env.ANTHROPIC_AUTH_TOKEN is set/);
    expect(w).toMatch(/ANTHROPIC_MODEL is exported/);
    expect(w).toMatch(/export PA_API_KEY/);
    expect(w).toMatch(/settings.local.json/);
    expect(JSON.stringify(plan)).not.toContain(SECRET);
    const d = (await s.h.detect()).find((x) => x.id === 'claude')!;
    expect(d.installed).toBe(true);
    expect(d.notes.join('\n')).toMatch(/settings.local.json/);
  });

  it('refuses plaintext profiles at plan time', async () => {
    const s = await setup();
    await s.h.upsertProfile(profile({ keyMode: 'plaintext' }));
    await expect(s.h.plan('claude', 'default')).rejects.toThrow(/Plaintext/);
  });
});
