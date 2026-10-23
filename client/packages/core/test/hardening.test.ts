import { describe, expect, it } from 'vitest';
import { MemoryKeyVault, MemoryTokenStore, PaException, createCore, redact, toPaError, type ChatStreamEvent } from '../src/index.js';
import { json, loginData, mockFetch, ok, refreshCookie } from './mock-http.js';

const T0 = 1_792_747_624;
const stored = { serverUrl: 'http://srv', refreshCookie: 'c1', userId: 3, username: 'tester' };

function setup(routes: Parameters<typeof mockFetch>[0], extra: Record<string, unknown> = {}) {
  const m = mockFetch(routes);
  const store = new MemoryTokenStore();
  const vault = new MemoryKeyVault();
  const t = { t: T0 };
  const core = createCore({ serverUrl: 'http://srv', store, vault, fetch: m.fetch, clock: { now: () => t.t * 1000 }, ...extra });
  return { ...m, store, vault, core, t };
}
const refreshOk = () => ok(loginData('jwt-2', T0 + 900), { cookies: [refreshCookie('c2')] });

describe('refresh failure policy: only 401/403 log the user out', () => {
  it.each([
    ['500', () => new Response('boom', { status: 500 }), 'SERVER'],
    ['502', () => new Response('bad gateway', { status: 502 }), 'SERVER'],
    ['503 json', () => json({ success: false, message: 'maintenance' }, { status: 503 }), 'SERVER'],
    ['429', () => new Response('slow', { status: 429, headers: { 'retry-after': '5' } }), 'RATE_LIMITED'],
    ['network', () => { throw new TypeError('fetch failed'); }, 'NETWORK'],
    ['200 success:false', () => json({ success: false, message: 'temporary' }), 'VALIDATION'],
  ] as const)('%s keeps the session and surfaces the error', async (_n, h, code) => {
    const { core, store } = setup({ 'POST /api/user/auth/refresh': [h as () => Response, h as () => Response, refreshOk] });
    await store.save(stored);
    const v = await core.session.restore();
    expect(v.status).toBe('authenticated');
    expect(v.username).toBe('tester');
    expect(await store.load()).toEqual(stored);
    // API calls report the transient error, not "logged out".
    await expect(core.session.getAccessToken()).rejects.toMatchObject({ error: { code } });
    // Recovers on the next successful refresh.
    expect((await core.auth.refresh()).status).toBe('authenticated');
    expect(await core.session.getAccessToken()).toBe('jwt-2');
  });

  it('auth.refresh() throws the transient error (not SESSION_EXPIRED)', async () => {
    const { core, store } = setup({ 'POST /api/user/auth/refresh': () => new Response('x', { status: 500 }) });
    await store.save(stored);
    await core.session.restore();
    await expect(core.auth.refresh()).rejects.toMatchObject({ error: { code: 'SERVER' } });
    expect(core.session.view().status).toBe('authenticated');
  });

  it.each([401, 403])('%i clears the session', async (status) => {
    const { core, store } = setup({ 'POST /api/user/auth/refresh': () => json({ success: false, message: 'invalid session' }, { status }) });
    await store.save(stored);
    expect((await core.session.restore()).status).toBe('anonymous');
    expect(await store.load()).toBeNull();
    await expect(core.auth.refresh()).rejects.toMatchObject({ error: { code: 'SESSION_EXPIRED' } });
  });

  it('API 401 followed by a 5xx refresh fails the call but keeps the session', async () => {
    const { core, store } = setup({
      'POST /api/user/login': () => ok(loginData('jwt-1', T0 + 900), { cookies: [refreshCookie('c1')] }),
      'GET /api/user/self': () => new Response('{}', { status: 401 }),
      'POST /api/user/auth/refresh': () => new Response('down', { status: 503 }),
    });
    await core.auth.login({ username: 'tester', password: 'longenough1' });
    await expect(core.billing.balance()).rejects.toMatchObject({ error: { code: 'SERVER' } });
    expect(core.session.view().status).toBe('authenticated');
    expect(await store.load()).not.toBeNull();
  });
});

describe('redaction', () => {
  const secrets = [
    'sk-' + 'A1b2C3d4'.repeat(6), 'nap_' + 'x9'.repeat(16),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', 'new_api_refresh=Zm9vYmFyYmF6',
    'http://38.246.253.190:3000/api/user/self', 'https://api.example.com/v1/chat', '38.246.253.190', 'example.com:8443',
  ];
  it('strips tokens, cookies, URLs and hosts', () => {
    const msg = `fail ${secrets.join(' ; ')} Authorization: Bearer abc.def Cookie: a=b; c=d getaddrinfo ENOTFOUND rain.internal`;
    const out = redact(msg);
    for (const s of [...secrets, 'abc.def', 'a=b', 'rain.internal', '190:3000']) expect(out).not.toContain(s);
    expect(out).toContain('sk-***');
    expect(out).toContain('<url>');
    expect(redact('Username must be 1-20 characters')).toBe('Username must be 1-20 characters');
    expect(redact('用户名已存在')).toBe('用户名已存在');
  });
  it('toPaError always redacts messages', () => {
    const e = new PaException({ code: 'SERVER', message: `upstream http://10.0.0.5:8080 rejected sk-${'z'.repeat(40)}`, status: 502 });
    const p = toPaError(e);
    expect(p).toMatchObject({ code: 'SERVER', status: 502 });
    expect(p.message).not.toMatch(/10\.0\.0\.5|zzzz|http:/);
  });
  it('server error messages are redacted before reaching callers', async () => {
    const { core } = setup({ 'POST /api/user/login': () => json({ success: false, message: 'dial tcp 172.17.0.2:5432: connection refused' }, { status: 500 }) });
    const err = await core.auth.login({ username: 'tester', password: 'longenough1' }).then(() => { throw new Error('expected failure'); }, (e: unknown) => toPaError(e));
    expect(err.message).not.toContain('172.17.0.2');
  });
});

describe('chat timeouts', () => {
  const never = () => new Promise<Response>(() => {});
  const hangingSse = (first: string) => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(first)); /* then silence */ },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const req = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }], keyId: 2 };
  const mk = async (route: () => Response | Promise<Response>, timeouts = { firstByteMs: 30, idleMs: 30 }) => {
    const s = setup({ 'POST /v1/chat/completions': route }, { chatTimeouts: timeouts });
    await s.vault.set(2, 'sk-test');
    return s.core;
  };

  it('complete: first-byte timeout → TIMEOUT', async () => {
    const core = await mk(never);
    await expect(core.chat.complete(req)).rejects.toMatchObject({ error: { code: 'TIMEOUT' } });
  });
  it('complete: body idle timeout → TIMEOUT', async () => {
    const core = await mk(() => ({ ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => {}) }) as unknown as Response);
    await expect(core.chat.complete(req)).rejects.toMatchObject({ error: { code: 'TIMEOUT' } });
  });
  it('complete: caller abort → CANCELLED (not TIMEOUT)', async () => {
    const core = await mk(never, { firstByteMs: 5000, idleMs: 5000 });
    const ac = new AbortController();
    const p = core.chat.complete(req, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ error: { code: 'CANCELLED' } });
  });
  it('stream: first-byte timeout emits TIMEOUT error event', async () => {
    const core = await mk(never);
    const ev: ChatStreamEvent[] = [];
    await core.chat.stream({ ...req, reqId: 'r' }, (e) => ev.push(e));
    expect(ev).toEqual([{ reqId: 'r', type: 'error', error: expect.objectContaining({ code: 'TIMEOUT' }) }]);
  });
  it('stream: idle timeout after partial content aborts cleanly with TIMEOUT', async () => {
    const core = await mk(() => hangingSse('data: {"choices":[{"delta":{"content":"He"}}]}\n\n'));
    const ev: ChatStreamEvent[] = [];
    await core.chat.stream({ ...req, reqId: 'r' }, (e) => ev.push(e));
    expect(ev.map((e) => e.type)).toEqual(['content', 'error']);
    expect(ev[1]).toMatchObject({ error: { code: 'TIMEOUT' } });
  });
  it('stream: caller cancel → CANCELLED; steady chunks within idle window succeed', async () => {
    const core = await mk(never, { firstByteMs: 5000, idleMs: 5000 });
    const ac = new AbortController();
    const ev: ChatStreamEvent[] = [];
    const p = core.chat.stream({ ...req, reqId: 'r' }, (e) => ev.push(e), ac.signal);
    setTimeout(() => ac.abort(), 10);
    await p;
    expect(ev).toEqual([{ reqId: 'r', type: 'error', error: expect.objectContaining({ code: 'CANCELLED' }) }]);

    const slow = await mk(() => new Response(new ReadableStream({
      async start(c) {
        const e = new TextEncoder();
        for (const t of ['A', 'B', 'C']) { await new Promise((r) => setTimeout(r, 15)); c.enqueue(e.encode(`data: {"choices":[{"delta":{"content":"${t}"}}]}\n\n`)); }
        c.enqueue(e.encode('data: [DONE]\n\n')); c.close();
      },
    }), { status: 200 }), { firstByteMs: 100, idleMs: 40 });
    const ev2: ChatStreamEvent[] = [];
    await slow.chat.stream({ ...req, reqId: 's' }, (e) => ev2.push(e));
    expect(ev2.map((e) => e.type)).toEqual(['content', 'content', 'content', 'done']);
  });
});
