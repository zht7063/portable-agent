import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter, codexBaseUrl, codexProvider, ControlledFs, createHarness, nodeFsOps, parseToml, StateStore, validateCodexProvider, type ExecFn } from '@pa/core/harness';
import { findCredentialLeaks, type HarnessProfile } from '@pa/core';

const SECRET = 'sk-' + 'X'.repeat(40);
const exec: ExecFn = async (cmd) => (cmd === 'codex' ? { code: 0, stdout: 'codex-cli 0.164.0\n', stderr: '' } : { code: null, stdout: '', stderr: '' });
const profile = (o: Partial<HarnessProfile> = {}): HarnessProfile => ({ id: 'default', serverUrl: 'http://rain.test:3000', keyId: 7, keyMode: 'command', models: { main: 'deepseek-v4-pro', codex: 'deepseek-v4-pro-responses' }, ...o });

async function setup(o: { env?: Record<string, string>; codexHome?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pa-cx-'));
  const home = join(root, 'home'); await mkdir(home);
  const data = join(root, 'data');
  const fs = new ControlledFs({ ops: nodeFsOps, roots: [home, data], dataDir: data });
  const state = new StateStore(fs);
  const env = { home, env: { ...(o.env ?? {}), ...(o.codexHome !== false ? { CODEX_HOME: join(home, 'cx') } : {}) }, platform: 'linux' as const };
  const helper = join(data, 'bin', 'pa-key');
  const cx = new CodexAdapter({ fs, state, env, exec, helperPath: helper });
  const h = createHarness({ fs, state, env, exec, adapters: { codex: cx } });
  const dir = env.env.CODEX_HOME ?? join(home, '.codex');
  await mkdir(dir, { recursive: true });
  return { h, state, home, dir, helper, config: join(dir, 'config.toml'), auth: join(dir, 'auth.json') };
}

describe('codex adapter: values', () => {
  it('provider table: /v1 base, responses, auth command (no shell quoting) or env_key; plaintext refused', () => {
    expect(codexBaseUrl('http://h:3000')).toBe('http://h:3000/v1');
    expect(codexBaseUrl('http://h:3000/v1/')).toBe('http://h:3000/v1');
    expect(codexProvider(profile(), '/x y/pa-key')).toEqual({ name: 'Portable Agent', base_url: 'http://rain.test:3000/v1', wire_api: 'responses', auth: { command: '/x y/pa-key', args: ['default', 'codex'] } });
    expect(codexProvider(profile({ keyMode: 'env', envVar: 'RAIN' }), '/x')).toMatchObject({ env_key: 'RAIN' });
    expect(codexProvider(profile({ keyMode: 'env' }), '/x')).not.toHaveProperty('auth');
    expect(() => codexProvider(profile({ keyMode: 'plaintext' }), '/x')).toThrow(/Plaintext/);
    expect(() => codexProvider(profile(), 'rel')).toThrow(/absolute/);
    expect(() => validateCodexProvider({ wire_api: 'responses', auth: { command: 'a' }, env_key: 'X' })).toThrow(/cannot be combined with env_key/);
    expect(() => validateCodexProvider({ wire_api: 'chat' })).toThrow(/responses/);
  });
});

describe('codex adapter: plan/apply/rollback', () => {
  it('writes model/model_provider + [model_providers.pa(.auth)], keeps user content, never reads auth.json', async () => {
    const s = await setup();
    const user = '# keep me\nmodel = "gpt-5"\nmodel_reasoning_effort = "high"\n\n[mcp_servers.x]\ncommand = "npx"\n';
    await writeFile(s.config, user);
    await writeFile(s.auth, JSON.stringify({ OPENAI_API_KEY: SECRET }));
    await s.h.upsertProfile(profile());
    const plan = await s.h.plan('codex', 'default');
    expect(plan.conflicts).toEqual([]);
    expect(findCredentialLeaks(plan)).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(SECRET);
    expect(plan.warnings.join()).toMatch(/auth.json exists/);
    const r = await s.h.apply('codex', plan);
    expect(r.written).toEqual([s.config]);
    const text = await readFile(s.config, 'utf8');
    expect(text.startsWith('# keep me\nmodel = "deepseek-v4-pro-responses"\nmodel_reasoning_effort = "high"\nmodel_provider = "pa"\n')).toBe(true);
    expect(text).toContain('[mcp_servers.x]\ncommand = "npx"\n');
    const j = parseToml(text);
    expect(j.model_providers).toEqual({ pa: { name: 'Portable Agent', base_url: 'http://rain.test:3000/v1', wire_api: 'responses', auth: { command: s.helper, args: ['default', 'codex'] } } });
    expect(text).not.toContain('sk-');
    expect(JSON.parse(await readFile(s.auth, 'utf8')).OPENAI_API_KEY).toBe(SECRET); // untouched
    expect(JSON.stringify(await s.state.load())).not.toContain(SECRET);
    expect((await s.h.plan('codex', 'default')).changes.every((c) => c.kind === 'unchanged')).toBe(true);
    // detach restores the user's model and removes model_provider + our table
    await s.h.rollback('codex', 'detach');
    const back = parseToml(await readFile(s.config, 'utf8'));
    expect(back).toEqual({ model: 'gpt-5', model_reasoning_effort: 'high', mcp_servers: { x: { command: 'npx' } } });
  });

  it('existing foreign [model_providers.pa] is a collision and its token is never shown or stored', async () => {
    const s = await setup();
    await writeFile(s.config, `[model_providers.pa]\nname = "theirs"\nexperimental_bearer_token = "${SECRET}"\n`);
    await s.h.upsertProfile(profile());
    const plan = await s.h.plan('codex', 'default');
    expect(plan.conflicts.map((c) => c.kind)).toEqual(['name-collision']);
    expect(JSON.stringify(plan)).not.toContain(SECRET);
    await expect(s.h.apply('codex', plan)).rejects.toThrow(/Unresolved/);
    await s.h.apply('codex', plan, [{ conflictId: plan.conflicts[0]!.id, resolution: 'overwrite' }]);
    expect(await readFile(s.config, 'utf8')).not.toContain(SECRET);
    expect(JSON.stringify(await s.state.load())).not.toContain(SECRET);
    // first-write restores the exact original bytes (from the protected backup)
    await s.h.rollback('codex', 'first-write');
    expect(await readFile(s.config, 'utf8')).toContain('name = "theirs"');
  });

  it('env mode writes env_key; setDefault=false leaves model/model_provider alone; ~/.codex without CODEX_HOME', async () => {
    const s = await setup({ codexHome: false });
    await s.h.upsertProfile(profile({ keyMode: 'env', codex: { setDefault: false } }));
    const plan = await s.h.plan('codex', 'default');
    expect(plan.warnings.join()).toMatch(/export PA_API_KEY/);
    expect(plan.warnings.join()).toMatch(/model_provider=pa/);
    await s.h.apply('codex', plan);
    const j = parseToml(await readFile(join(s.home, '.codex', 'config.toml'), 'utf8'));
    expect(j.model).toBeUndefined();
    expect((j.model_providers as Record<string, Record<string, unknown>>).pa!.env_key).toBe('PA_API_KEY');
  });

  it('external edit is a conflict; built-in provider ids and profile overrides are handled', async () => {
    const s = await setup();
    await s.h.upsertProfile(profile());
    await s.h.apply('codex', await s.h.plan('codex', 'default'));
    await writeFile(s.config, (await readFile(s.config, 'utf8')).replace('wire_api = "responses"', 'wire_api = "responses"\nrequest_max_retries = 9'));
    expect((await s.h.plan('codex', 'default')).conflicts[0]?.kind).toBe('external-owned-change');
    await s.h.upsertProfile(profile({ providerId: 'openai' }));
    await expect(s.h.plan('codex', 'default')).rejects.toThrow(/built-in/);
    const t = await setup();
    await writeFile(t.config, 'profile = "work"\n');
    await t.h.upsertProfile(profile());
    expect((await t.h.plan('codex', 'default')).warnings.join()).toMatch(/profile "work"/);
    const d = (await t.h.detect()).find((x) => x.id === 'codex')!;
    expect(d).toMatchObject({ installed: true, version: '0.164.0' });
  });
});
