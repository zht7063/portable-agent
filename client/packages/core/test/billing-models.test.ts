import { describe, expect, it } from 'vitest';
import { MemoryTokenStore, createCore, quotaToUsd } from '../src/index.js';
import { fail, json, loginData, mockFetch, ok, refreshCookie } from './mock-http.js';

async function authed(routes: Parameters<typeof mockFetch>[0]) {
  const m = mockFetch({ 'POST /api/user/login': () => ok(loginData('jwt', 9_999_999_999), { cookies: [refreshCookie('c')] }), ...routes });
  const core = createCore({ serverUrl: 'http://srv', store: new MemoryTokenStore(), fetch: m.fetch });
  await core.auth.login({ username: 'tester', password: 'longenough1' });
  return { core, calls: m.calls };
}

describe('billing', () => {
  it('quota conversion', () => { expect(quotaToUsd(500000)).toBe(1); expect(quotaToUsd(499972)).toBeCloseTo(0.999944); });
  it('balance maps /api/user/self', async () => {
    const { core } = await authed({ 'GET /api/user/self': () => ok({ quota: 499972, used_quota: 28, request_count: 2, id: 3 }) });
    expect(await core.billing.balance()).toEqual({ quota: 499972, usedQuota: 28, usd: 499972 / 500000, requestCount: 2 });
  });
  it('topupInfo flags', async () => {
    const { core } = await authed({ 'GET /api/user/topup/info': () => ok({ enable_redemption: true, payment_compliance_confirmed: true, min_topup: 1 }) });
    expect(await core.billing.topupInfo()).toEqual({ enableRedemption: true, paymentComplianceConfirmed: true });
  });
  it('redeem posts {key} then refreshes balance', async () => {
    const { core, calls } = await authed({
      'POST /api/user/topup': () => ok(500000),
      'GET /api/user/self': () => ok({ quota: 500000, used_quota: 0 }),
    });
    expect(await core.billing.redeem({ code: '  CODE123  ' })).toEqual({ added: 500000, quota: 500000 });
    expect(calls.find((c) => c.path === '/api/user/topup')!.body).toEqual({ key: 'CODE123' });
  });
  it('redeem failure and validation', async () => {
    const { core } = await authed({ 'POST /api/user/topup': () => fail('Redemption failed') });
    await expect(core.billing.redeem({ code: 'x' })).rejects.toMatchObject({ error: { code: 'VALIDATION', message: 'Redemption failed' } });
    await expect(core.billing.redeem({ code: ' ' })).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
  });
  it('429 maps to RATE_LIMITED with retryAfter', async () => {
    const { core } = await authed({ 'POST /api/user/topup': () => new Response('{"message":"too many"}', { status: 429, headers: { 'retry-after': '60' } }) });
    await expect(core.billing.redeem({ code: 'x' })).rejects.toMatchObject({ error: { code: 'RATE_LIMITED', retryAfter: 60 } });
  });
});

describe('models', () => {
  it('session list', async () => {
    const { core } = await authed({ 'GET /api/user/models': () => ok(['deepseek-flash', 'deepseek-v4-pro']) });
    expect(await core.models.list()).toEqual([{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }]);
  });
  it('relay list with sk', async () => {
    const { core, calls } = await authed({ 'GET /v1/models': () => json({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }], success: true }) });
    expect(await core.models.listWithKey('sk-abc')).toEqual([{ id: 'deepseek-flash' }]);
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer sk-abc');
  });
  it('relay 401 error is redacted', async () => {
    const { core } = await authed({ 'GET /v1/models': () => json({ error: { message: 'Invalid token sk-abcdefghijklmnop', type: 'new_api_error' } }, { status: 401 }) });
    await expect(core.models.listWithKey('sk-abcdefghijklmnop')).rejects.toMatchObject({ error: { code: 'UNAUTHORIZED', message: 'Invalid token sk-***' } });
  });
});
