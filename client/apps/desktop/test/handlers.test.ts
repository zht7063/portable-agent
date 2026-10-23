import { describe, expect, it } from 'vitest';
import { INVOKE_CHANNELS, MemoryTokenStore, createCore } from '@pa/core';
import { createHandlers, defaultConfig, dispatch } from '../src/main/ipc/handlers';

function setup() {
  const core = createCore({ store: new MemoryTokenStore() });
  let cfg = defaultConfig('http://38.246.253.190:3000');
  const copied: string[] = [];
  const handlers = createHandlers({ core, getConfig: () => cfg, setConfig: (p) => (cfg = { ...cfg, ...p }), copyToClipboard: (t) => copied.push(t) });
  return { core, handlers, copied };
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
  it('stubs map to NOT_IMPLEMENTED errors', async () => {
    const { handlers } = setup();
    expect(await dispatch(handlers, 'billing:balance', {})).toEqual({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'billing.balance not implemented (M0 stub)' } });
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
