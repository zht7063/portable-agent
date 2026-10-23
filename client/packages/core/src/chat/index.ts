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

export function createChat(http: HttpClient, resolveKey: KeyResolver): ChatModule {
  return {
    async complete(req, signal) {
      const sk = await resolveKey(req.keyId);
      const d = await http.json<{
        choices?: { message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: FinishReason }[];
        usage?: RawUsage;
      }>('POST', '/v1/chat/completions', { auth: { sk }, body: body(req, false), signal, noTimeout: true });
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
      try {
        const sk = await resolveKey(req.keyId);
        const res = await http.send('POST', '/v1/chat/completions', { auth: { sk }, body: body(req, true), signal, noTimeout: true, headers: { Accept: 'text/event-stream' } });
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
          const { value, done } = await reader.read();
          if (done) break;
          for (const p of parser.push(decoder.decode(value, { stream: true }))) handle(p);
        }
        for (const p of parser.flush()) handle(p);
        if (!doneSent) { doneSent = true; const w = truncatedWarning(content, finish); emit({ reqId, type: 'done', finishReason: finish, ...(w ? { warning: w } : {}) }); }
      } catch (e) {
        const error = (e as Error)?.name === 'AbortError' ? { code: 'CANCELLED' as const, message: 'Request cancelled' } : toPaError(e);
        emit({ reqId, type: 'error', error });
      }
    },
  };
}
