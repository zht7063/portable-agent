import {
  CONFIRM_REQUIRED_CHANNELS,
  CREDENTIAL_EXCEPTION_CHANNELS,
  INVOKE_CHANNELS,
  err,
  findCredentialLeaks,
  ok,
  PaException,
  toPaError,
  type ChatStreamEvent,
  type ClientConfig,
  type ConfigSetReq,
  type Core,
  type InvokeChannel,
  type InvokeReq,
  type InvokeRes,
  type IpcInvokeMap,
} from '@pa/core';
import type { Harness } from '@pa/core/harness';

type Handler<C extends InvokeChannel> = (req: InvokeReq<C>) => Promise<IpcInvokeMap[C]['res']>;
export type HandlerMap = { [C in InvokeChannel]: Handler<C> };

export interface HandlerDeps {
  /** Current core (may be recreated when the server URL changes). */
  getCore(): Core;
  getConfig(): ClientConfig;
  setConfig(patch: ConfigSetReq): Promise<ClientConfig>;
  copyToClipboard(text: string): void;
  /** Push a chat:stream:event to the renderer. */
  emitStream(e: ChatStreamEvent): void;
  harness: Harness;
}

/** Pure (no electron import) so it is unit-testable. */
export function createHandlers({ getCore, getConfig, setConfig, copyToClipboard, emitStream, harness }: HandlerDeps): HandlerMap {
  const streams = new Map<string, AbortController>();
  const core = new Proxy({} as Core, { get: (_t, k) => getCore()[k as keyof Core] });
  const withMax = <T extends { maxTokens?: number }>(r: T): T => ({ ...r, maxTokens: r.maxTokens ?? getConfig().defaultMaxTokens });
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
    'chat:complete': (r) => core.chat.complete(withMax(r)),
    'chat:stream:start': async (r) => {
      if (!r.reqId || streams.has(r.reqId)) throw new PaException({ code: 'VALIDATION', message: 'Invalid or duplicate reqId' });
      const ac = new AbortController();
      streams.set(r.reqId, ac);
      // Fire and forget: events flow via emitStream; chat.stream never throws.
      void core.chat.stream(withMax(r), emitStream, ac.signal).finally(() => streams.delete(r.reqId));
      return { reqId: r.reqId };
    },
    'chat:stream:cancel': async (r) => { streams.get(r.reqId)?.abort(); return {}; },
    'config:get': async () => getConfig(),
    'config:set': async (r) => {
      for (const ac of streams.values()) ac.abort(); // streams belong to the old server
      return setConfig(r);
    },
    'harness:detect': async () => ({ harnesses: await harness.detect(), registered: harness.registered() }),
    'harness:plan': (r) => harness.plan(r.id, r.profileId),
    'harness:apply': (r) => harness.apply(r.id, r.plan, r.acknowledge ?? []),
    'harness:rollback': (r) => harness.rollback(r.id, r.target),
    'harness:keyring:status': (r) => harness.keyringStatus(r?.profileId),
    'harness:profile:list': async () => ({ profiles: await harness.listProfiles() }),
    'harness:profile:upsert': (r) => harness.upsertProfile(r),
    'harness:channel:probe': async (r) => {
      const checkedAt = new Date().toISOString();
      const p = (await harness.listProfiles()).find((x) => x.id === r?.profileId);
      if (!p) return { state: 'no-profile' as const, checkedAt };
      const model = p.models.codex ?? p.models.main;
      const origin = (u: string) => { try { return new URL(u).origin; } catch { return ''; } };
      if (origin(p.serverUrl) !== origin(getConfig().serverUrl)) return { state: 'unreachable' as const, model, checkedAt, detail: 'Profile server differs from the configured server' };
      const core = getCore();
      let ids: string[];
      try {
        ids = (await core.models.listWithKey(await core.keys.secret(p.keyId))).map((m) => m.id);
      } catch {
        return { state: 'unreachable' as const, model, checkedAt, detail: 'GET /v1/models failed' };
      }
      return { state: ids.includes(model) ? ('model-listed' as const) : ('model-missing' as const), model, checkedAt };
    },
  };
}

const exempt = new Set<string>(CREDENTIAL_EXCEPTION_CHANNELS);

/** Wraps a handler: validates channel, converts errors to Result, guards against credential leaks. */
export async function dispatch<C extends InvokeChannel>(handlers: HandlerMap, channel: C, req: InvokeReq<C>): Promise<InvokeRes<C>> {
  if (!(INVOKE_CHANNELS as readonly string[]).includes(channel)) return err('VALIDATION', 'Unknown channel');
  if ((CONFIRM_REQUIRED_CHANNELS as readonly string[]).includes(channel) && (req as { confirm?: unknown })?.confirm !== true) {
    return err('VALIDATION', channel === 'keys:reveal' ? 'Reveal requires explicit confirmation' : 'This action requires explicit confirmation');
  }
  try {
    const data = await (handlers[channel] as Handler<C>)(req);
    if (!exempt.has(channel) && findCredentialLeaks(data).length) return err('SERVER', 'Blocked: response contained credential material');
    return ok(data);
  } catch (e) {
    return { ok: false, error: toPaError(e) };
  }
}

