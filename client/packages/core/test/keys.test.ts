import { describe, expect, it } from 'vitest';
import { MemoryKeyVault, MemoryTokenStore, createCore, findCredentialLeaks } from '../src/index.js';
import { loginData, mockFetch, ok, refreshCookie } from './mock-http.js';

const raw = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, user_id: 3, key: 'hNvY**********R5lk', status: 1, name, created_time: 1, accessed_time: 1, expired_time: -1,
  remain_quota: 0, unlimited_quota: true, model_limits_enabled: false, model_limits: '', allow_ips: '', used_quota: 0, group: '', ...extra,
});
const FULL = 'A'.repeat(48);

async function setup(routes: Parameters<typeof mockFetch>[0]) {
  const m = mockFetch({ 'POST /api/user/login': () => ok(loginData('jwt', 9_999_999_999), { cookies: [refreshCookie('c')] }), ...routes });
  const vault = new MemoryKeyVault();
  const core = createCore({ serverUrl: 'http://srv', store: new MemoryTokenStore(), vault, fetch: m.fetch });
  await core.auth.login({ username: 'tester', password: 'longenough1' });
  return { core, calls: m.calls, vault };
}

describe('keys', () => {
  it('list maps masked items; negative remain_quota preserved for UI to handle', async () => {
    const { core } = await setup({ 'GET /api/token/': () => ok({ page: 1, items: [raw(2, 'bot', { remain_quota: -28, used_quota: 28 })] }) });
    const list = await core.keys.list();
    expect(list[0]).toMatchObject({ id: 2, name: 'bot', maskedKey: 'hNvY**********R5lk', remainQuota: -28, unlimitedQuota: true, stored: false });
    expect(findCredentialLeaks(list)).toEqual([]);
  });

  it('create -> locate new id -> reveal once -> cached in vault', async () => {
    const { core, calls, vault } = await setup({
      'GET /api/token/': [() => ok({ items: [raw(1, 'old')] }), () => ok({ items: [raw(1, 'old'), raw(2, 'bot')] })],
      'POST /api/token/': () => ok(),
      'POST /api/token/2/key': () => ok({ key: FULL }),
    });
    const k = await core.keys.create({ name: 'bot' });
    expect(k).toMatchObject({ id: 2, stored: true });
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/token/')!.body).toEqual({ name: 'bot', remain_quota: 0, unlimited_quota: true, expired_time: -1, group: '' });
    expect(await vault.get(2)).toBe(`sk-${FULL}`);
    expect(await core.keys.secret(2)).toBe(`sk-${FULL}`);
    expect(calls.filter((c) => c.path === '/api/token/2/key').length).toBe(1);
    expect(JSON.stringify(k)).not.toContain(FULL);
  });

  it('update: status via status_only PUT, other fields via full PUT without masked key', async () => {
    const { core, calls } = await setup({
      'GET /api/token/': () => ok({ items: [raw(2, 'bot')] }),
      'PUT /api/token/?status_only=true': (c) => ok({ ...raw(2, 'bot'), ...(c.body as object) }),
      'PUT /api/token/': (c) => ok({ ...raw(2, 'x'), ...(c.body as object), key: 'hNvY**********R5lk' }),
    });
    const k = await core.keys.update({ id: 2, name: 'renamed', status: 2 });
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.path)).toEqual(['/api/token/?status_only=true', '/api/token/']);
    expect(puts[0]!.body).toEqual({ id: 2, status: 2 });
    const body = puts[1]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ id: 2, name: 'renamed', status: 2, unlimited_quota: true });
    expect(body.key).toBeUndefined();
    expect(k).toMatchObject({ name: 'renamed', status: 2 });
  });

  it('update: status-only change sends only the status_only PUT; no-op status sends nothing', async () => {
    const { core, calls } = await setup({
      'GET /api/token/': () => ok({ items: [raw(2, 'bot')] }),
      'PUT /api/token/?status_only=true': (c) => ok({ ...raw(2, 'bot'), ...(c.body as object) }),
    });
    expect(await core.keys.update({ id: 2, status: 2 })).toMatchObject({ status: 2 });
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.path)).toEqual(['/api/token/?status_only=true']);
    await core.keys.update({ id: 2, status: 1 }); // raw(2) is already status 1
    expect(calls.filter((c) => c.method === 'PUT').length).toBe(1);
  });

  it('delete removes from server and vault', async () => {
    const { core, vault, calls } = await setup({ 'DELETE /api/token/2': () => ok() });
    await vault.set(2, 'sk-x');
    await core.keys.delete({ id: 2 });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/token/2' });
    expect(await vault.get(2)).toBeNull();
  });

  it('reveal returns prefixed key; keeps sk- if server already prefixed', async () => {
    const { core } = await setup({ 'POST /api/token/5/key': () => ok({ key: `sk-${FULL}` }) });
    expect(await core.keys.reveal(5)).toEqual({ id: 5, secret: `sk-${FULL}` });
  });
});
