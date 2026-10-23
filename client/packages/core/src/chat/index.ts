import { PaException, toPaError } from '../contract/errors.js';
import type { ChatReq, ChatRes, ChatStreamEvent, FinishReason, Usage } from '../contract/ipc.js';
import type { HttpClient } from '../http/client.js';
import { SseParser } from './sse.js';

/** deepseek-flash reasons first; small max_tokens yields empty content + finish_reason=length. */
export const DEFAULT_MAX_TOKENS = 2048;

export interface ChatModule {
  complete(req: ChatReq, signal?: AbortSignal): Promise<ChatRes>;
  stream(req: ChatReq & { reqId: string }, emit: (e: ChatStreamEvent) => void, signal?: AbortSignal): Promise<void>;
}

export interface ChatTimeouts {
  /** Max wait from sending the request until response headers arrive (connect + first byte). */
  firstByteMs: number;
  /** Max gap between body chunks (stream) / max wait for the full body (non-stream). */
  idleMs: number;
}
export const DEFAULT_CHAT_TIMEOUTS: ChatTimeouts = { firstByteMs: 60_000, idleMs: 90_000 };

/** AbortController that aborts with a TIMEOUT PaException when an armed deadline passes; follows the caller's signal. */
class Deadline {
  readonly ac = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(parent?: AbortSignal) {
    if (parent?.aborted) this.ac.abort(parent.reason);
    else parent?.addEventListener('abort', () => this.ac.abort(parent.reason), { once: true });
  }
  arm(ms: number, phase: string) {
    this.clear();
    if (ms > 0 && Number.isFinite(ms)) {
      this.timer = setTimeout(() => this.ac.abort(new PaException({ code: 'TIMEOUT', message: `Chat ${phase} timed out after ${Math.round(ms / 1000)}s` })), ms);
    }
  }
  clear() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  /** Error to report: our TIMEOUT if we fired it, CANCELLED if the caller aborted, else the original. */
  error(e: unknown) {
    const reason = this.ac.signal.reason;
    if (this.ac.signal.aborted && reason instanceof PaException) return reason.error;
    if (this.ac.signal.aborted || (e as Error)?.name === 'AbortError') return { code: 'CANCELLED' as const, message: 'Request cancelled' };
    return toPaError(e);
  }
}

/** Resolves the full sk for a request (keyId -> KeysModule.secret, or default key). */
export type KeyResolver = (keyId?: number) => Promise<string>;

interface RawUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
const toUsage = (u?: RawUsage | null): Usage | undefined =>
  u ? { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, totalTokens: u.total_tokens ?? 0 } : undefined;

export const truncatedWarning = (content: string, finish: FinishReason) =>
  finish === 'length' && !content.trim() ? ('TRUNCATED_EMPTY_CONTENT' as const) : undefined;

function body(req: ChatReq, stream: boolean) {
  if (!req.model) throw new PaException({ code: 'VALIDATION', message: 'Model required' });
  if (!req.messages?.length) throw new PaException({ code: 'VALIDATION', message: 'Messages required' });
  return {
    model: req.model,
    messages: req.messages,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

export function createChat(http: HttpClient, resolveKey: KeyResolver, timeouts: Partial<ChatTimeouts> = {}): ChatModule {
  const t: ChatTimeouts = { ...DEFAULT_CHAT_TIMEOUTS, ...timeouts };
  /** Race a body read against the armed deadline (some fetch impls ignore abort once headers arrived). */
  const guarded = <T>(dl: Deadline, p: Promise<T>) => new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(dl.ac.signal.reason ?? new DOMException('Aborted', 'AbortError'));
    // Always consume p so a late rejection after we bailed out is never unhandled.
    p.then(resolve, reject).finally(() => dl.ac.signal.removeEventListener('abort', onAbort));
    if (dl.ac.signal.aborted) onAbort();
    else dl.ac.signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    async complete(req, signal) {
      const sk = await resolveKey(req.keyId);
      const payload = body(req, false);
      const dl = new Deadline(signal);
      type Raw = { choices?: { message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: FinishReason }[]; usage?: RawUsage };
      let d: Raw;
      try {
        dl.arm(t.firstByteMs, 'first byte');
        const res = await guarded(dl, http.send('POST', '/v1/chat/completions', { auth: { sk }, body: payload, signal: dl.ac.signal, noTimeout: true }));
        dl.arm(t.idleMs, 'response');
        d = await guarded(dl, res.json() as Promise<Raw>);
      } catch (e) {
        throw new PaException(dl.error(e));
      } finally { dl.clear(); }
      const c = d.choices?.[0];
      const content = c?.message?.content ?? '';
      const finishReason = c?.finish_reason ?? null;
      const reasoning = c?.message?.reasoning_content ?? undefined;
      const warning = truncatedWarning(content, finishReason);
      return { content, finishReason, ...(reasoning ? { reasoning } : {}), ...(toUsage(d.usage) ? { usage: toUsage(d.usage) } : {}), ...(warning ? { warning } : {}) };
    },

    async stream(req, emit, signal) {
      const { reqId } = req;
      let content = '';
      let finish: FinishReason = null;
      let doneSent = false;
      const dl = new Deadline(signal);
      try {
        const sk = await resolveKey(req.keyId);
        const payload = body(req, true);
        dl.arm(t.firstByteMs, 'first byte');
        const res = await guarded(dl, http.send('POST', '/v1/chat/completions', { auth: { sk }, body: payload, signal: dl.ac.signal, noTimeout: true, headers: { Accept: 'text/event-stream' } }));
        if (!res.body) throw new PaException({ code: 'SERVER', message: 'Empty stream' });
        const parser = new SseParser();
        const decoder = new TextDecoder();
        const handle = (payload: string) => {
          if (payload.trim() === '[DONE]') {
            if (!doneSent) { doneSent = true; const w = truncatedWarning(content, finish); emit({ reqId, type: 'done', finishReason: finish, ...(w ? { warning: w } : {}) }); }
            return;
          }
          let j: { choices?: { delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: FinishReason }[]; usage?: RawUsage | null; error?: { message?: string } };
          try { j = JSON.parse(payload); } catch { return; }
          if (j.error) throw new PaException({ code: 'SERVER', message: j.error.message ?? 'Stream error' });
          for (const ch of j.choices ?? []) {
            const r = ch.delta?.reasoning_content;
            if (r) emit({ reqId, type: 'reasoning', delta: r });
            const t = ch.delta?.content;
            if (t) { content += t; emit({ reqId, type: 'content', delta: t }); }
            if (ch.finish_reason) finish = ch.finish_reason;
          }
          const u = toUsage(j.usage);
          if (u) emit({ reqId, type: 'usage', usage: u });
        };
        const reader = res.body.getReader();
        for (;;) {
          dl.arm(t.idleMs, 'stream idle');
          const { value, done } = await guarded(dl, reader.read()).catch((e) => { void reader.cancel().catch(() => {}); throw e; });
          if (done) break;
          for (const p of parser.push(decoder.decode(value, { stream: true }))) handle(p);
        }
        for (const p of parser.flush()) handle(p);
        if (!doneSent) { doneSent = true; const w = truncatedWarning(content, finish); emit({ reqId, type: 'done', finishReason: finish, ...(w ? { warning: w } : {}) }); }
      } catch (e) {
        emit({ reqId, type: 'error', error: dl.error(e) });
      } finally { dl.clear(); }
    },
  };
}
