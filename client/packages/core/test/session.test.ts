import { describe, expect, it } from 'vitest';
import { DefaultSessionManager, MemoryTokenStore, createCore, quotaToUsd, toSk, redact, DEFAULT_MAX_TOKENS } from '../src/index.js';

const stored = { serverUrl: 'http://x', refreshCookie: 'c1', userId: 3, username: 'u' };

describe('MemoryTokenStore', () => {
  it('save/load/clear and returns copies', async () => {
    const s = new MemoryTokenStore();
    expect(await s.load()).toBeNull();
    await s.save(stored);
    const got = await s.load();
    expect(got).toEqual(stored);
    got!.refreshCookie = 'mutated';
    expect((await s.load())!.refreshCookie).toBe('c1');
    await s.clear();
    expect(await s.load()).toBeNull();
  });
});

describe('DefaultSessionManager (M0 skeleton)', () => {
  it('transitions and emits redacted views', async () => {
    const store = new MemoryTokenStore();
    const m = new DefaultSessionManager({ store, serverUrl: 'http://x' });
    const seen: string[] = [];
    m.onChange((v) => seen.push(v.status));
    expect(m.view().status).toBe('anonymous');
    await m.establish({ accessToken: 'jwt', accessExpiresAt: 100, stored });
    expect(m.view()).toEqual({ status: 'authenticated', userId: 3, username: 'u', accessExpiresAt: 100, storage: 'memory', serverUrl: 'http://x' });
    expect(JSON.stringify(m.view())).not.toContain('jwt');
    expect(JSON.stringify(m.view())).not.toContain('c1');
    expect(await m.getAccessToken()).toBe('jwt');
    const m2 = new DefaultSessionManager({ store, serverUrl: 'http://x' });
    expect((await m2.restore()).status).toBe('expired');
    await m.clear();
    expect(seen).toEqual(['authenticated', 'anonymous']);
    await expect(m.getAccessToken()).rejects.toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });
});

describe('core helpers and stubs', () => {
  it('helpers', () => {
    expect(quotaToUsd(500000)).toBe(1);
    expect(toSk('abc')).toBe('sk-abc');
    expect(toSk('sk-abc')).toBe('sk-abc');
    expect(DEFAULT_MAX_TOKENS).toBe(2048);
    expect(redact('Bearer sk-abcdefghijkl new_api_refresh=zzz;')).toBe('Bearer sk-*** new_api_refresh=***;');
  });
  it('createCore wires defaults; module stubs reject with NOT_IMPLEMENTED', async () => {
    const core = createCore({ store: new MemoryTokenStore() });
    expect(core.http.baseUrl).toBe('http://38.246.253.190:3000');
    expect(core.http.insecure).toBe(true);
    await expect(Promise.resolve().then(() => core.billing.balance())).rejects.toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } });
  });
});
