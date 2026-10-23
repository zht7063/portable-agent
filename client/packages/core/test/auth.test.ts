import { describe, expect, it } from 'vitest';
import { MemoryTokenStore, createCore, readSetCookie } from '../src/index.js';
import { fail, hasSession, loginData, mockFetch, ok, refreshCookie } from './mock-http.js';

const T0 = 1_792_747_624; // seconds
const clockAt = (s: { t: number }) => ({ now: () => s.t * 1000 });

function setup(routes: Parameters<typeof mockFetch>[0], t = { t: T0 }) {
  const m = mockFetch(routes);
  const store = new MemoryTokenStore();
  const core = createCore({ serverUrl: 'http://srv', store, fetch: m.fetch, clock: clockAt(t) });
  return { ...m, store, core, t };
}

describe('cookie parsing', () => {
  it('reads new_api_refresh among multiple Set-Cookie headers', () => {
    const h = new Headers();
    h.append('set-cookie', refreshCookie('abc'));
    h.append('set-cookie', hasSession);
    expect(readSetCookie(h)).toBe('abc');
    expect(readSetCookie(new Headers())).toBeNull();
  });
});

describe('auth module', () => {
  it('register validates input and posts', async () => {
    const { core, calls } = setup({ 'POST /api/user/register': () => ok() });
    await expect(core.auth.register({ username: 'u', password: 'short' })).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
    await core.auth.register({ username: 'tester', password: 'longenough1' });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/user/register', body: { username: 'tester', password: 'longenough1' } });
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('login stores cookie (not JWT) and authorizes subsequent calls', async () => {
    const { core, store, calls } = setup({
      'POST /api/user/login': () => ok(loginData('jwt-1', T0 + 900), { cookies: [refreshCookie('c1'), hasSession] }),
      'GET /api/user/models': () => ok(['deepseek-flash']),
    });
    const view = await core.auth.login({ username: 'tester', password: 'longenough1' });
    expect(view).toMatchObject({ status: 'authenticated', userId: 3, username: 'tester', accessExpiresAt: T0 + 900 });
    expect(JSON.stringify(view)).not.toMatch(/jwt-1|c1/);
    expect(await store.load()).toMatchObject({ refreshCookie: 'c1', sid: 'sid-1', userId: 3 });
    expect(JSON.stringify(await store.load())).not.toContain('jwt-1');
    await core.models.list();
    expect(calls[1]!.headers.authorization).toBe('Bearer jwt-1');
  });

  it('login failure maps to error, 2FA challenge rejected', async () => {
    const a = setup({ 'POST /api/user/login': () => fail('用户名或密码错误') });
    await expect(a.core.auth.login({ username: 'tester', password: 'longenough1' })).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
    const b = setup({ 'POST /api/user/login': () => ok({ require_2fa: true }) });
    await expect(b.core.auth.login({ username: 'tester', password: 'longenough1' })).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
  });

  it('refreshes proactively ~60s before expiry and rotates cookie', async () => {
    const t = { t: T0 };
    const { core, store, calls } = setup({
      'POST /api/user/login': () => ok(loginData('jwt-1', T0 + 900), { cookies: [refreshCookie('c1')] }),
      'POST /api/user/auth/refresh': () => ok(loginData('jwt-2', T0 + 1800), { cookies: [refreshCookie('c2')] }),
      'GET /api/user/models': () => ok([]),
    }, t);
    await core.auth.login({ username: 'tester', password: 'longenough1' });
    t.t = T0 + 845; // within 60s skew
    await core.models.list();
    const refresh = calls.find((c) => c.path === '/api/user/auth/refresh')!;
    expect(refresh.headers.cookie).toBe('new_api_refresh=c1');
    expect(refresh.headers['x-auth-session']).toBe('sid-1');
    expect(refresh.headers.authorization).toBeUndefined();
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer jwt-2');
    expect((await store.load())!.refreshCookie).toBe('c2');
  });

  it('401 -> single-flight refresh -> retry once; concurrent calls share one refresh', async () => {
    let refreshes = 0;
    const { core, calls } = setup({
      'POST /api/user/login': () => ok(loginData('jwt-1', T0 + 900), { cookies: [refreshCookie('c1')] }),
      'POST /api/user/auth/refresh': async () => { refreshes++; await new Promise((r) => setTimeout(r, 5)); return ok(loginData('jwt-2', T0 + 900), { cookies: [refreshCookie('c2')] }); },
      'GET /api/user/models': (c) => (c.headers.authorization === 'Bearer jwt-1' ? new Response('{}', { status: 401 }) : ok(['m'])),
    });
    await core.auth.login({ username: 'tester', password: 'longenough1' });
    const res = await Promise.all([core.models.list(), core.models.list(), core.models.list()]);
    expect(res.every((r) => r[0]?.id === 'm')).toBe(true);
    expect(refreshes).toBe(1);
    expect(calls.filter((c) => c.path === '/api/user/models').length).toBe(6);
  });

  it('refresh rejection clears session -> SESSION_EXPIRED/UNAUTHORIZED, emits anonymous', async () => {
    const { core, store } = setup({
      'POST /api/user/login': () => ok(loginData('jwt-1', T0 + 900), { cookies: [refreshCookie('c1')] }),
      'POST /api/user/auth/refresh': () => new Response(JSON.stringify({ success: false, message: 'AUTH_SESSION_REVOKED' }), { status: 401 }),
      'GET /api/user/models': () => new Response('{}', { status: 401 }),
    });
    await core.auth.login({ username: 'tester', password: 'longenough1' });
    const states: string[] = [];
    core.session.onChange((v) => states.push(v.status));
    await expect(core.models.list()).rejects.toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(core.session.view().status).toBe('anonymous');
    expect(await store.load()).toBeNull();
    expect(states).toContain('refreshing');
  });

  it('restore() refreshes from stored cookie; ignores stores for other servers', async () => {
    const { core, store } = setup({ 'POST /api/user/auth/refresh': () => ok(loginData('jwt-9', T0 + 900), { cookies: [refreshCookie('c9')] }) });
    await store.save({ serverUrl: 'http://srv', refreshCookie: 'c1', userId: 3, username: 'tester' });
    expect((await core.session.restore()).status).toBe('authenticated');
    expect((await store.load())!.refreshCookie).toBe('c9');

    const other = setup({});
    await other.store.save({ serverUrl: 'http://elsewhere', refreshCookie: 'x', userId: 1, username: 'a' });
    expect((await other.core.session.restore()).status).toBe('anonymous');
  });

  it('network failure during refresh keeps stored session', async () => {
    const { core, store } = setup({ 'POST /api/user/auth/refresh': () => { throw new TypeError('fetch failed'); } });
    await store.save({ serverUrl: 'http://srv', refreshCookie: 'c1', userId: 3, username: 'tester' });
    expect((await core.session.restore()).status).toBe('authenticated') // transient: still logged in;
    expect(await store.load()).not.toBeNull();
  });

  it('logout posts cookie + bearer and clears locally even if server fails', async () => {
    const { core, store, calls } = setup({
      'POST /api/user/login': () => ok(loginData('jwt-1', T0 + 900), { cookies: [refreshCookie('c1')] }),
      'POST /api/user/auth/logout': () => new Response('x', { status: 500 }),
    });
    await core.auth.login({ username: 'tester', password: 'longenough1' });
    expect((await core.auth.logout()).status).toBe('anonymous');
    const lo = calls.find((c) => c.path === '/api/user/auth/logout')!;
    expect(lo.headers).toMatchObject({ cookie: 'new_api_refresh=c1', authorization: 'Bearer jwt-1' });
    expect(await store.load()).toBeNull();
  });
});
