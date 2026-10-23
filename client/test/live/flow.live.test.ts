/**
 * Live flow against new-api. NEVER runs by default.
 * Enable: PA_LIVE=1 PA_USER=... PA_PASS=... [PA_SERVER_URL=...]
 * Redeem (at most once, consumes the code): additionally PA_LIVE_REDEEM=1 with NEWAPI_REDEEM_CODE_2 set.
 * Budget: ~4 rate-limited calls (login, refresh, [redeem], key reveal) of the 20/20min IP limit.
 */
import { describe, expect, it } from 'vitest';
import { MemoryTokenStore, createCore, findCredentialLeaks, type ChatStreamEvent } from '@pa/core';

const live = process.env.PA_LIVE === '1' && !!process.env.PA_USER && !!process.env.PA_PASS;

describe.skipIf(!live)('live new-api flow', () => {
  const core = createCore({ serverUrl: process.env.PA_SERVER_URL, store: new MemoryTokenStore() });
  let keyId = 0;

  it('login + refresh', async () => {
    const v = await core.auth.login({ username: process.env.PA_USER!, password: process.env.PA_PASS! });
    expect(v.status).toBe('authenticated');
    expect((await core.auth.refresh()).status).toBe('authenticated');
    expect(findCredentialLeaks(core.session.view())).toEqual([]);
  });
  it('models + balance', async () => {
    expect((await core.models.list()).length).toBeGreaterThan(0);
    expect((await core.billing.balance()).quota).toBeTypeOf('number');
  });
  it.skipIf(process.env.PA_LIVE_REDEEM !== '1' || !process.env.NEWAPI_REDEEM_CODE_2)('redeem once', async () => {
    const r = await core.billing.redeem({ code: process.env.NEWAPI_REDEEM_CODE_2! });
    expect(r.added).toBeGreaterThan(0);
  });
  it('key create/list/rename', async () => {
    const k = await core.keys.create({ name: `pa-live-${Date.now() % 100000}` });
    keyId = k.id;
    expect((await core.keys.secret(k.id)).startsWith('sk-')).toBe(true);
    expect((await core.keys.update({ id: k.id, name: `${k.name}-r` })).name).toBe(`${k.name}-r`);
  });
  it('chat non-stream + stream', async () => {
    const model = (await core.models.listWithKey(await core.keys.secret(keyId)))[0]!.id;
    const msgs = [{ role: 'user' as const, content: 'Say hi' }];
    const r = await core.chat.complete({ model, messages: msgs, keyId, maxTokens: 512 });
    expect(r.finishReason).not.toBeNull();
    const ev: ChatStreamEvent[] = [];
    await core.chat.stream({ reqId: 'live', model, messages: msgs, keyId, maxTokens: 512 }, (e) => ev.push(e));
    expect(ev.at(-1)?.type).toBe('done');
  }, 60_000);
  it('cleanup key + logout', async () => {
    if (keyId) await core.keys.delete({ id: keyId });
    expect((await core.auth.logout()).status).toBe('anonymous');
  });
});
