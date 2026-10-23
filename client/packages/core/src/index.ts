export * from './contract/index.js';
export { MemoryTokenStore } from './session/stores/memory.js';
export { DefaultSessionManager, systemClock, REFRESH_SKEW_S, type Clock, type Refresher, type RefreshResult } from './session/manager.js';
export { readSetCookie, cookieHeader, REFRESH_COOKIE } from './session/cookie.js';
export { HttpClient, redact, unwrap, type FetchLike, type NewApiEnvelope } from './http/client.js';
export * from './auth/index.js';
export * from './billing/index.js';
export * from './models/index.js';
export * from './keys/index.js';
export * from './chat/index.js';
export { SseParser } from './chat/sse.js';

import { PaException } from './contract/errors.js';
import type { TokenStore } from './contract/session.js';
import { DefaultSessionManager, type Clock } from './session/manager.js';
import { HttpClient, type FetchLike } from './http/client.js';
import { createAuth } from './auth/index.js';
import { createBilling } from './billing/index.js';
import { createModels } from './models/index.js';
import { createKeys, MemoryKeyVault, type KeyVault } from './keys/index.js';
import { createChat } from './chat/index.js';

export const DEFAULT_SERVER_URL = 'http://38.246.253.190:3000';

export interface CoreOptions { serverUrl?: string; store: TokenStore; vault?: KeyVault; fetch?: FetchLike; clock?: Clock; timeoutMs?: number }

export function createCore(opts: CoreOptions) {
  const serverUrl = (opts.serverUrl ?? DEFAULT_SERVER_URL).replace(/\/+$/, '');
  const http = new HttpClient({ baseUrl: serverUrl, fetch: opts.fetch, timeoutMs: opts.timeoutMs });
  const session = new DefaultSessionManager({ store: opts.store, serverUrl, clock: opts.clock });
  http.setAuthProvider(session);
  const keys = createKeys(http, opts.vault ?? new MemoryKeyVault());
  let defaultKeyId: number | undefined;
  const chat = createChat(http, async (keyId) => {
    const id = keyId ?? defaultKeyId;
    if (id === undefined) throw new PaException({ code: 'VALIDATION', message: 'Select an API key first' });
    return keys.secret(id);
  });
  return {
    http,
    session,
    auth: createAuth(http, session),
    billing: createBilling(http),
    models: createModels(http),
    keys,
    chat,
    setDefaultKey(id: number | undefined) { defaultKeyId = id; },
  };
}
export type Core = ReturnType<typeof createCore>;
