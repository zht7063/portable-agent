export * from './contract/index.js';
export { MemoryTokenStore } from './session/stores/memory.js';
export { DefaultSessionManager, systemClock, type Clock } from './session/manager.js';
export { HttpClient, redact, unwrap, type FetchLike, type NewApiEnvelope } from './http/client.js';
export * from './auth/index.js';
export * from './billing/index.js';
export * from './models/index.js';
export * from './keys/index.js';
export * from './chat/index.js';

import type { TokenStore } from './contract/session.js';
import { DefaultSessionManager, type Clock } from './session/manager.js';
import { HttpClient, type FetchLike } from './http/client.js';
import { createAuthStub } from './auth/index.js';
import { createBillingStub } from './billing/index.js';
import { createModelsStub } from './models/index.js';
import { createKeysStub } from './keys/index.js';
import { createChatStub } from './chat/index.js';

export const DEFAULT_SERVER_URL = 'http://38.246.253.190:3000';

export interface CoreOptions { serverUrl?: string; store: TokenStore; fetch?: FetchLike; clock?: Clock }

export function createCore(opts: CoreOptions) {
  const serverUrl = opts.serverUrl ?? DEFAULT_SERVER_URL;
  const http = new HttpClient({ baseUrl: serverUrl, fetch: opts.fetch });
  const session = new DefaultSessionManager({ store: opts.store, serverUrl, clock: opts.clock });
  return {
    http,
    session,
    auth: createAuthStub(),
    billing: createBillingStub(),
    models: createModelsStub(),
    keys: createKeysStub(),
    chat: createChatStub(),
  };
}
export type Core = ReturnType<typeof createCore>;
