import { describe, expect, it } from 'vitest';
import { MemoryKeyVault, MemoryTokenStore, SseParser, createCore, type ChatStreamEvent } from '../src/index.js';
import { json, mockFetch, sseResponse } from './mock-http.js';

async function setup(routes: Parameters<typeof mockFetch>[0]) {
  const m = mockFetch(routes);
  const vault = new MemoryKeyVault();
  await vault.set(2, 'sk-test');
  const core = createCore({ serverUrl: 'http://srv', store: new MemoryTokenStore(), vault, fetch: m.fetch });
  return { core, calls: m.calls };
}
const msgs = [{ role: 'user' as const, content: 'Say hi' }];

describe('SseParser', () => {
  it('handles split chunks, CRLF and multi-line data', () => {
    const p = new SseParser();
    expect(p.push('data: {"a":')).toEqual([]);
    expect(p.push('1}\n\ndata: x\r\n\r\n: comment\n\ndata: l1\ndata: l2\n\n')).toEqual(['{"a":1}', 'x', 'l1\nl2']);
    expect(p.push('data: [DONE]')).toEqual([]);
    expect(p.flush()).toEqual(['[DONE]']);
  });
});

describe('chat.complete', () => {
  it('sends default max_tokens=2048 with sk and returns reasoning', async () => {
    const { core, calls } = await setup({
      'POST /v1/chat/completions': () => json({ choices: [{ message: { content: 'hi', reasoning_content: 'think' }, finish_reason: 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 20, total_tokens: 52 } }),
    });
    const r = await core.chat.complete({ model: 'deepseek-flash', messages: msgs, keyId: 2 });
    expect(r).toEqual({ content: 'hi', reasoning: 'think', finishReason: 'stop', usage: { promptTokens: 32, completionTokens: 20, totalTokens: 52 } });
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test');
    expect(calls[0]!.body).toMatchObject({ model: 'deepseek-flash', max_tokens: 2048 });
    expect((calls[0]!.body as Record<string, unknown>).stream).toBeUndefined();
  });

  it('flags truncated empty content (deepseek-flash with small max_tokens, as observed on rain)', async () => {
    const { core } = await setup({
      'POST /v1/chat/completions': () => json({ choices: [{ message: { content: '', reasoning_content: 'We need answer simple.' }, finish_reason: 'length' }], usage: { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 } }),
    });
    const r = await core.chat.complete({ model: 'deepseek-flash', messages: msgs, keyId: 2, maxTokens: 16 });
    expect(r).toMatchObject({ content: '', finishReason: 'length', warning: 'TRUNCATED_EMPTY_CONTENT', reasoning: 'We need answer simple.' });
  });

  it('requires a key; maps insufficient quota', async () => {
    const { core } = await setup({ 'POST /v1/chat/completions': () => json({ error: { message: 'user quota is not enough' } }, { status: 403 }) });
    await expect(core.chat.complete({ model: 'm', messages: msgs })).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
    await expect(core.chat.complete({ model: 'm', messages: msgs, keyId: 2 })).rejects.toMatchObject({ error: { code: 'INSUFFICIENT_QUOTA' } });
  });
});

describe('chat.stream', () => {
  const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  it('emits reasoning/content/usage/done in order across split chunks', async () => {
    const body = [
      chunk({ choices: [{ delta: { reasoning_content: 'thi' } }] }),
      chunk({ choices: [{ delta: { reasoning_content: 'nk' } }] }),
      chunk({ choices: [{ delta: { content: 'Hel' } }] }).slice(0, 10),
      chunk({ choices: [{ delta: { content: 'Hel' } }] }).slice(10),
      chunk({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }),
      chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
      'data: [DONE]\n\n',
    ];
    const { core, calls } = await setup({ 'POST /v1/chat/completions': () => sseResponse(body) });
    const ev: ChatStreamEvent[] = [];
    await core.chat.stream({ reqId: 'r1', model: 'deepseek-flash', messages: msgs, keyId: 2 }, (e) => ev.push(e));
    expect(calls[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_tokens: 2048 });
    expect(ev.map((e) => e.type)).toEqual(['reasoning', 'reasoning', 'content', 'content', 'usage', 'done']);
    expect(ev.filter((e) => e.type === 'content').map((e) => (e as { delta: string }).delta).join('')).toBe('Hello');
    expect(ev.at(-1)).toEqual({ reqId: 'r1', type: 'done', finishReason: 'stop' });
  });

  it('done carries TRUNCATED_EMPTY_CONTENT when only reasoning arrived', async () => {
    const { core } = await setup({ 'POST /v1/chat/completions': () => sseResponse([chunk({ choices: [{ delta: { reasoning_content: 'x' }, finish_reason: 'length' }] }), 'data: [DONE]\n\n']) });
    const ev: ChatStreamEvent[] = [];
    await core.chat.stream({ reqId: 'r', model: 'm', messages: msgs, keyId: 2, maxTokens: 16 }, (e) => ev.push(e));
    expect(ev.at(-1)).toEqual({ reqId: 'r', type: 'done', finishReason: 'length', warning: 'TRUNCATED_EMPTY_CONTENT' });
  });

  it('emits error event on HTTP error and on cancel (never throws)', async () => {
    const { core } = await setup({ 'POST /v1/chat/completions': () => json({ error: { message: 'boom' } }, { status: 500 }) });
    const ev: ChatStreamEvent[] = [];
    await core.chat.stream({ reqId: 'r', model: 'm', messages: msgs, keyId: 2 }, (e) => ev.push(e));
    expect(ev).toEqual([{ reqId: 'r', type: 'error', error: { code: 'SERVER', message: 'boom', status: 500 } }]);

    const ac = new AbortController();
    ac.abort();
    const ev2: ChatStreamEvent[] = [];
    await core.chat.stream({ reqId: 'c', model: 'm', messages: msgs, keyId: 2 }, (e) => ev2.push(e), ac.signal);
    expect(ev2).toEqual([{ reqId: 'c', type: 'error', error: { code: 'CANCELLED', message: 'Request cancelled' } }]);
  });
});
