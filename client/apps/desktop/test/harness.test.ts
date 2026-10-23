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
      expect(r.data.registered).toEqual([]);
      expect(r.data.harnesses.map((h) => h.configDir)).toEqual([join(home, '.pi', 'agent'), join(home, '.claude'), join(home, '.codex')]);
    }
  });
  it('apply/rollback require confirm: true; plan without adapter -> NOT_IMPLEMENTED', async () => {
    const { handlers } = setup();
    const plan: Plan = { id: 'pi', profileId: 'p', createdAt: '', baseFingerprints: {}, changes: [], conflicts: [], warnings: [], externalUnownedChange: [] };
    expect(await dispatch(handlers, 'harness:apply', { id: 'pi', plan, confirm: false } as never)).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'This action requires explicit confirmation' } });
    expect(await dispatch(handlers, 'harness:rollback', { id: 'pi', target: 'last' } as never)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await dispatch(handlers, 'harness:apply', { id: 'pi', plan: { ...plan, changes: [] }, confirm: true })).toMatchObject({ ok: false, error: { code: 'NOT_IMPLEMENTED' } });
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
