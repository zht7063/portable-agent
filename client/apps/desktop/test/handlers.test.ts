import { describe, expect, it } from 'vitest';
import { INVOKE_CHANNELS, MemoryKeyVault, MemoryTokenStore, createCore, type ChatStreamEvent } from '@pa/core';
import { createHandlers, dispatch } from '../src/main/ipc/handlers';

function setup(fetchImpl?: typeof fetch) {
  const vault = new MemoryKeyVault();
  void vault.set(2, 'sk-' + 'A'.repeat(48));
  const core = createCore({ store: new MemoryTokenStore(), vault, fetch: fetchImpl });
  const events: ChatStreamEvent[] = [];
  let cfg = { serverUrl: 'http://38.246.253.190:3000', defaultMaxTokens: 2048, insecureTransport: true };
  const copied: string[] = [];
  const handlers = createHandlers({ getCore: () => core, getConfig: () => cfg, setConfig: async (p) => (cfg = { ...cfg, ...p }), copyToClipboard: (t) => copied.push(t), emitStream: (e) => events.push(e) });
  return { core, handlers, copied, events };
}

describe('desktop IPC handlers', () => {
  it('has a handler for every channel', () => {
    const { handlers } = setup();
    expect(Object.keys(handlers).sort()).toEqual([...INVOKE_CHANNELS].sort());
  });
  it('auth:session and config:get return Result ok without credentials', async () => {
    const { handlers } = setup();
    expect(await dispatch(handlers, 'auth:session', {})).toMatchObject({ ok: true, data: { status: 'anonymous', storage: 'memory' } });
    expect(await dispatch(handlers, 'config:get', {})).toMatchObject({ ok: true, data: { defaultMaxTokens: 2048, insecureTransport: true } });
  });
  it('module errors map to Result errors', async () => {
    const { handlers } = setup();
    expect(await dispatch(handlers, 'billing:balance', {})).toEqual({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Not logged in' } });
  });
  it('keys:copy copies in main and returns nothing secret; keys:reveal returns key only with confirm', async () => {
    const { handlers, copied } = setup();
    expect(await dispatch(handlers, 'keys:copy', { id: 2 })).toEqual({ ok: true, data: {} });
    expect(copied).toEqual(['sk-' + 'A'.repeat(48)]);
    expect(await dispatch(handlers, 'keys:reveal', { id: 2, confirm: true })).toEqual({ ok: true, data: { id: 2, secret: 'sk-' + 'A'.repeat(48) } });
  });
  it('chat stream start emits events; cancel aborts; duplicate reqId rejected', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const { handlers, events } = setup(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    expect(await dispatch(handlers, 'chat:stream:start', { reqId: 'r1', model: 'm', messages: [{ role: 'user', content: 'x' }], keyId: 2 })).toEqual({ ok: true, data: { reqId: 'r1' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.map((e) => e.type)).toEqual(['content', 'done']);
    for (const e of events) expect(JSON.stringify(e)).not.toContain('sk-');

    const hang = setup((_u, init) => new Promise((_res, rej) => init!.signal!.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))));
    await dispatch(hang.handlers, 'chat:stream:start', { reqId: 'r2', model: 'm', messages: [{ role: 'user', content: 'x' }], keyId: 2 });
    expect(await dispatch(hang.handlers, 'chat:stream:start', { reqId: 'r2', model: 'm', messages: [{ role: 'user', content: 'x' }], keyId: 2 })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    await dispatch(hang.handlers, 'chat:stream:cancel', { reqId: 'r2' });
    await new Promise((r) => setTimeout(r, 20));
    expect(hang.events).toEqual([{ reqId: 'r2', type: 'error', error: { code: 'CANCELLED', message: 'Request cancelled' } }]);
  });
  it('blocks responses containing credentials', async () => {
    const { handlers } = setup();
    // @ts-expect-error simulate a buggy handler leaking a token
    handlers['auth:session'] = async () => ({ status: 'authenticated', accessToken: 'x' });
    expect(await dispatch(handlers, 'auth:session', {})).toMatchObject({ ok: false, error: { code: 'SERVER' } });
  });
  it('keys:reveal requires confirm=true; unknown channels rejected', async () => {
    const { handlers } = setup();
    // @ts-expect-error confirm missing
    expect(await dispatch(handlers, 'keys:reveal', { id: 1 })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    // @ts-expect-error unknown channel
    expect(await dispatch(handlers, 'nope', {})).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });
});
