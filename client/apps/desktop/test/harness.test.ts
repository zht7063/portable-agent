import { describe, expect, it } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryKeyVault, MemoryTokenStore, createCore, findCredentialLeaks, type Plan } from '@pa/core';
import { MemoryKeyring, NoKeyring, type Keyring } from '@pa/key-helper';
import { createHandlers, dispatch } from '../src/main/ipc/handlers';
import { tmpHarnessHost } from './harness-fixture';

const SECRET = 'sk-' + 'H'.repeat(48);
function setup(keyring: Keyring = new MemoryKeyring()) {
  const vault = new MemoryKeyVault();
  void vault.set(7, SECRET);
  const core = createCore({ store: new MemoryTokenStore(), vault, fetch: async () => { throw new Error('no network in tests'); } });
  const t = tmpHarnessHost(keyring);
  const cfg = { serverUrl: 'http://127.0.0.1:9', defaultMaxTokens: 2048, insecureTransport: true };
  const handlers = createHandlers({ getCore: () => core, getConfig: () => cfg, setConfig: async () => cfg, copyToClipboard: () => {}, emitStream: () => {}, harness: t.host.harness });
  return { core, handlers, ...t };
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const n of await readdir(dir).catch(() => [])) {
    const p = join(dir, n);
    if ((await stat(p)).isDirectory()) out.push(...(await filesUnder(p))); else out.push(p);
  }
  return out;
}

describe('desktop harness IPC skeleton', () => {
  it('harness:detect returns credential-free detection on a temp HOME', async () => {
    const { handlers, home } = setup();
    const r = await dispatch(handlers, 'harness:detect', {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.registered).toEqual(['pi', 'claude']);
      expect(r.data.harnesses.map((h) => h.configDir)).toEqual([join(home, '.pi', 'agent'), join(home, '.claude'), join(home, '.codex')]);
    }
  });
  it('apply/rollback require confirm: true; plan without adapter -> NOT_IMPLEMENTED', async () => {
    const { handlers } = setup();
    const plan: Plan = { id: 'pi', profileId: 'p', createdAt: '', baseFingerprints: {}, changes: [], conflicts: [], warnings: [], externalUnownedChange: [] };
    expect(await dispatch(handlers, 'harness:apply', { id: 'pi', plan, confirm: false } as never)).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'This action requires explicit confirmation' } });
    expect(await dispatch(handlers, 'harness:rollback', { id: 'pi', target: 'last' } as never)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await dispatch(handlers, 'harness:apply', { id: 'codex', plan: { ...plan, id: 'codex' }, confirm: true })).toMatchObject({ ok: false, error: { code: 'NOT_IMPLEMENTED' } });
    expect(await dispatch(handlers, 'harness:apply', { id: 'pi', plan, confirm: true })).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'Unknown harness profile' } });
    expect(await dispatch(handlers, 'keys:reveal', { id: 7 } as never)).toMatchObject({ ok: false, error: { message: 'Reveal requires explicit confirmation' } });
  });
  it('provisioning writes the key into the keychain only; renderer-facing status never contains it', async () => {
    const { handlers, host, core, keyring, dataDir, home } = setup();
    await host.state.upsertProfile({ id: 'default', serverUrl: 'http://127.0.0.1:9', keyId: 7, models: { main: 'deepseek-flash' }, keyMode: 'command' });
    await host.provisionKey(core, 'default', 'claude', 7);
    expect(await keyring.get('default/claude')).toBe(SECRET);
    const r = await dispatch(handlers, 'harness:keyring:status', {});
    expect(r).toMatchObject({ ok: true, data: { available: true, entries: expect.arrayContaining([{ profileId: 'default', harness: 'claude', present: true }]) } });
    expect(findCredentialLeaks(r)).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    for (const f of [...(await filesUnder(dataDir)), ...(await filesUnder(home))]) expect(await readFile(f, 'utf8')).not.toContain(SECRET);
    await host.revokeKey('default');
    expect(await keyring.get('default/claude')).toBeNull();
  });
  it('keychain unavailable (Linux w/o Secret Service): refuses to provision, no plaintext anywhere, status says env fallback', async () => {
    const { handlers, host, core, dataDir, home } = setup(new NoKeyring('no D-Bus session'));
    await expect(host.provisionKey(core, 'default', 'codex', 7)).rejects.toMatchObject({ error: { code: 'VALIDATION', message: expect.stringMatching(/env key mode/) } });
    expect(await dispatch(handlers, 'harness:keyring:status', { profileId: 'default' })).toEqual({ ok: true, data: { available: false, backend: 'none', fallback: 'env', reason: 'no D-Bus session', entries: [] } });
    for (const f of [...(await filesUnder(dataDir)), ...(await filesUnder(home))]) expect(await readFile(f, 'utf8')).not.toContain(SECRET);
  });
});

describe('Pi via IPC (H1)', () => {
  function setupPi(keyring: Keyring = new MemoryKeyring()) {
    const vault = new MemoryKeyVault();
    void vault.set(7, SECRET);
    const core = createCore({ store: new MemoryTokenStore(), vault, fetch: async () => { throw new Error('no network in tests'); } });
    const t = tmpHarnessHost(keyring, () => core);
    const cfg = { serverUrl: 'http://127.0.0.1:9', defaultMaxTokens: 2048, insecureTransport: true };
    const handlers = createHandlers({ getCore: () => core, getConfig: () => cfg, setConfig: async () => cfg, copyToClipboard: () => {}, emitStream: () => {}, harness: t.host.harness });
    return { handlers, ...t };
  }
  const prof = { id: 'default', serverUrl: 'http://127.0.0.1:9', keyId: 7, keyMode: 'command' as const, models: { main: 'deepseek-flash' } };

  it('upsert -> plan -> apply(confirm) provisions the keychain; files and responses never carry the key; detach revokes', async () => {
    const kr = new MemoryKeyring();
    const s = setupPi(kr);
    expect((await dispatch(s.handlers, 'harness:profile:upsert', prof)).ok).toBe(true);
    const plan = await dispatch(s.handlers, 'harness:plan', { id: 'pi', profileId: 'default' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(findCredentialLeaks(plan.data)).toEqual([]);
    const noConfirm = await dispatch(s.handlers, 'harness:apply', { id: 'pi', plan: plan.data } as never);
    expect(noConfirm.ok).toBe(false);
    const r = await dispatch(s.handlers, 'harness:apply', { id: 'pi', plan: plan.data as Plan, confirm: true });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(await kr.get('default/pi')).toBe(SECRET);
    const models = await readFile(join(s.home, '.pi', 'agent', 'models.json'), 'utf8');
    expect(models).toContain(join(s.dataDir, 'bin', 'pa-key'));
    for (const f of await filesUnder(s.home)) expect(await readFile(f, 'utf8')).not.toContain(SECRET);
    for (const f of await filesUnder(s.dataDir)) expect(await readFile(f, 'utf8')).not.toContain(SECRET);
    const list = await dispatch(s.handlers, 'harness:profile:list', {});
    expect(list.ok && list.data.profiles.map((p) => p.id)).toEqual(['default']);
    const d = await dispatch(s.handlers, 'harness:rollback', { id: 'pi', target: 'detach', confirm: true });
    expect(d.ok).toBe(true);
    expect(await kr.get('default/pi')).toBeNull();
  });

  it('command mode without a keychain refuses to write (no plaintext fallback); env mode works', async () => {
    const s = setupPi(new NoKeyring('no secret service'));
    await dispatch(s.handlers, 'harness:profile:upsert', prof);
    const plan = await dispatch(s.handlers, 'harness:plan', { id: 'pi', profileId: 'default' });
    if (!plan.ok) throw new Error('plan failed');
    const r = await dispatch(s.handlers, 'harness:apply', { id: 'pi', plan: plan.data, confirm: true });
    expect(r.ok).toBe(false);
    expect(await filesUnder(join(s.home, '.pi'))).toEqual([]);
    await dispatch(s.handlers, 'harness:profile:upsert', { ...prof, keyMode: 'env' });
    const p2 = await dispatch(s.handlers, 'harness:plan', { id: 'pi', profileId: 'default' });
    if (!p2.ok) throw new Error('plan failed');
    expect((await dispatch(s.handlers, 'harness:apply', { id: 'pi', plan: p2.data, confirm: true })).ok).toBe(true);
    expect(JSON.parse(await readFile(join(s.home, '.pi', 'agent', 'models.json'), 'utf8')).providers.pa.apiKey).toBe('$PA_API_KEY');
  });

  it('Claude Code (H2): apply provisions default/claude, settings.json has apiKeyHelper only (no key); detach revokes', async () => {
    const kr = new MemoryKeyring();
    const s = setupPi(kr);
    await dispatch(s.handlers, 'harness:profile:upsert', prof);
    const plan = await dispatch(s.handlers, 'harness:plan', { id: 'claude', profileId: 'default' });
    if (!plan.ok) throw new Error('plan failed');
    expect(findCredentialLeaks(plan.data)).toEqual([]);
    const r = await dispatch(s.handlers, 'harness:apply', { id: 'claude', plan: plan.data, confirm: true });
    expect(r.ok).toBe(true);
    expect(await kr.get('default/claude')).toBe(SECRET);
    expect(await kr.get('default/pi')).toBeNull();
    const j = JSON.parse(await readFile(join(s.home, '.claude', 'settings.json'), 'utf8'));
    expect(j.apiKeyHelper).toBe(`'${join(s.dataDir, 'bin', 'pa-key')}' default claude`);
    expect(j.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9');
    for (const f of [...(await filesUnder(s.home)), ...(await filesUnder(s.dataDir))]) expect(await readFile(f, 'utf8')).not.toContain(SECRET);
    expect((await dispatch(s.handlers, 'harness:rollback', { id: 'claude', target: 'detach', confirm: true })).ok).toBe(true);
    expect(await kr.get('default/claude')).toBeNull();
    expect(JSON.parse(await readFile(join(s.home, '.claude', 'settings.json'), 'utf8')).apiKeyHelper).toBeUndefined();
  });
});
