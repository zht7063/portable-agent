import {
  CREDENTIAL_EXCEPTION_CHANNELS,
  DEFAULT_MAX_TOKENS,
  INVOKE_CHANNELS,
  err,
  findCredentialLeaks,
  ok,
  toPaError,
  type ClientConfig,
  type Core,
  type InvokeChannel,
  type InvokeReq,
  type InvokeRes,
  type IpcInvokeMap,
} from '@pa/core';

type Handler<C extends InvokeChannel> = (req: InvokeReq<C>) => Promise<IpcInvokeMap[C]['res']>;
export type HandlerMap = { [C in InvokeChannel]: Handler<C> };

export interface HandlerDeps {
  core: Core;
  getConfig(): ClientConfig;
  setConfig(patch: Partial<ClientConfig>): ClientConfig;
  copyToClipboard(text: string): void;
}

/** Pure (no electron import) so it is unit-testable. Module calls are M0 stubs. */
export function createHandlers({ core, getConfig, setConfig, copyToClipboard }: HandlerDeps): HandlerMap {
  return {
    'auth:register': (r) => core.auth.register(r),
    'auth:login': (r) => core.auth.login(r),
    'auth:logout': () => core.auth.logout(),
    'auth:session': async () => core.session.view(),
    'billing:balance': () => core.billing.balance(),
    'billing:topupInfo': () => core.billing.topupInfo(),
    'billing:redeem': (r) => core.billing.redeem(r),
    'models:list': () => core.models.list(),
    'keys:list': () => core.keys.list(),
    'keys:create': (r) => core.keys.create(r),
    'keys:update': (r) => core.keys.update(r),
    'keys:delete': (r) => core.keys.delete(r),
    'keys:copy': async (r) => { copyToClipboard(await core.keys.secret(r.id)); return {}; },
    'keys:reveal': (r) => core.keys.reveal(r.id),
    'chat:complete': (r) => core.chat.complete({ ...r, maxTokens: r.maxTokens ?? getConfig().defaultMaxTokens }),
    'chat:stream:start': async (r) => ({ reqId: r.reqId }), // M1e/M3a: start stream, emit chat:stream:event
    'chat:stream:cancel': async () => ({}),
    'config:get': async () => getConfig(),
    'config:set': async (r) => setConfig(r),
  };
}

const exempt = new Set<string>(CREDENTIAL_EXCEPTION_CHANNELS);

/** Wraps a handler: validates channel, converts errors to Result, guards against credential leaks. */
export async function dispatch<C extends InvokeChannel>(handlers: HandlerMap, channel: C, req: InvokeReq<C>): Promise<InvokeRes<C>> {
  if (!(INVOKE_CHANNELS as readonly string[]).includes(channel)) return err('VALIDATION', 'Unknown channel');
  if (channel === 'keys:reveal' && (req as { confirm?: unknown })?.confirm !== true) return err('VALIDATION', 'Reveal requires explicit confirmation');
  try {
    const data = await (handlers[channel] as Handler<C>)(req);
    if (!exempt.has(channel) && findCredentialLeaks(data).length) return err('SERVER', 'Blocked: response contained credential material');
    return ok(data);
  } catch (e) {
    return { ok: false, error: toPaError(e) };
  }
}

export const defaultConfig = (serverUrl: string): ClientConfig => ({
  serverUrl,
  defaultMaxTokens: DEFAULT_MAX_TOKENS,
  insecureTransport: !serverUrl.startsWith('https://'),
});
