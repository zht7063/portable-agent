// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PA_ERROR_CODES, type ClientConfig, type KeySummary, type SessionView } from '@pa/core/contract';
import { ERROR_TEXT, errText } from '../../src/renderer/src/errors';
import { App } from '../../src/renderer/src/App';
import { AuthPanel } from '../../src/renderer/src/panels/AuthPanel';
import { BillingPanel } from '../../src/renderer/src/panels/BillingPanel';
import { KeysPanel } from '../../src/renderer/src/panels/KeysPanel';
import { ChatPanel } from '../../src/renderer/src/panels/ChatPanel';
import { fail, mockPa } from './mock-pa';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const anon: SessionView = { status: 'anonymous', storage: 'memory', serverUrl: 'http://h:3000' } as SessionView;
const authed: SessionView = { status: 'authenticated', userId: 4, username: 'u', accessExpiresAt: 9e9, storage: 'memory', serverUrl: 'http://h:3000' } as SessionView;
const key = (id: number, name: string, status = 1): KeySummary => ({ id, name, maskedKey: 'abcd**********wxyz', status, remainQuota: 0, unlimitedQuota: true, usedQuota: 0, expiredTime: -1, createdTime: 0, group: '', stored: true } as KeySummary);
const balance = { quota: 500000, usedQuota: 0, usd: 1, requestCount: 0 };

describe('errText', () => {
  it('has friendly Chinese text for every error code', () => {
    for (const c of PA_ERROR_CODES) {
      expect(ERROR_TEXT[c]).toMatch(/[\u4e00-\u9fff]/);
      expect(errText({ code: c, message: 'm' })).toContain(ERROR_TEXT[c]);
    }
  });
  it('RATE_LIMITED includes retryAfter; detail only for useful codes; unknown is generic', () => {
    expect(errText({ code: 'RATE_LIMITED', message: 'x', retryAfter: 42 })).toContain('约 42 秒后可重试');
    expect(errText({ code: 'VALIDATION', message: '用户名已存在' })).toContain('用户名已存在');
    expect(errText({ code: 'NETWORK', message: 'ECONNREFUSED 1.2.3.4' })).not.toContain('ECONNREFUSED');
    expect(errText(new Error('boom'))).toBe('发生未知错误');
  });
});

describe('App', () => {
  it('shows plain-HTTP warning and login when anonymous; logs in', async () => {
    const pa = mockPa({
      'auth:session': () => anon,
      'config:get': (): ClientConfig => ({ serverUrl: 'http://h:3000', defaultMaxTokens: 2048, insecureTransport: true }),
      'auth:login': () => authed,
      'billing:balance': () => balance, 'billing:topupInfo': () => ({ enableRedemption: false }),
      'keys:list': () => [], 'models:list': () => [{ id: 'deepseek-flash' }],
    });
    render(<App />);
    expect(await screen.findByText(/明文 HTTP 原型/)).toBeTruthy();
    await userEvent.type(screen.getByPlaceholderText('用户名'), 'u');
    await userEvent.type(screen.getByPlaceholderText(/密码/), 'pw123456');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(pa.calls('auth:login')).toEqual([{ username: 'u', password: 'pw123456' }]);
    expect(await screen.findByText('$1.0000')).toBeTruthy();
    expect(await screen.findByText(/还没有 API key/)).toBeTruthy();
  });
  it('session:changed to expired returns to login', async () => {
    const pa = mockPa({
      'auth:session': () => authed, 'config:get': () => ({ serverUrl: 'https://h', defaultMaxTokens: 2048, insecureTransport: false }),
      'billing:balance': () => balance, 'billing:topupInfo': () => ({}), 'keys:list': () => [], 'models:list': () => [],
    });
    render(<App />);
    expect(await screen.findByText('对话')).toBeTruthy();
    expect(screen.queryByText(/明文 HTTP/)).toBeNull();
    act(() => pa.emit('session:changed', { ...anon, status: 'expired' } as SessionView));
    expect(await screen.findByRole('button', { name: '登录' })).toBeTruthy();
  });
});

describe('AuthPanel', () => {
  it('login error shows friendly message and clears password', async () => {
    mockPa({ 'auth:login': () => fail('UNAUTHORIZED', 'bad creds') });
    const onSession = vi.fn();
    render(<AuthPanel onSession={onSession} />);
    await userEvent.type(screen.getByPlaceholderText('用户名'), 'u');
    await userEvent.type(screen.getByPlaceholderText(/密码/), 'wrongpass');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));
    expect((await screen.findByRole('alert')).textContent).toContain(ERROR_TEXT.UNAUTHORIZED);
    expect((screen.getByPlaceholderText(/密码/) as HTMLInputElement).value).toBe('');
    expect(onSession).not.toHaveBeenCalled();
  });
  it('register switches to login on success', async () => {
    const pa = mockPa({ 'auth:register': () => ({}) });
    render(<AuthPanel onSession={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '去注册' }));
    await userEvent.type(screen.getByPlaceholderText('用户名'), 'n');
    await userEvent.type(screen.getByPlaceholderText(/密码/), 'pw123456');
    await userEvent.click(screen.getByRole('button', { name: '注册' }));
    expect(await screen.findByText('注册成功，请登录')).toBeTruthy();
    expect(pa.calls('auth:register')).toHaveLength(1);
  });
});

describe('BillingPanel', () => {
  it('loading → balance; redeem success reloads balance', async () => {
    let bal = { ...balance, quota: 0, usd: 0 };
    const pa = mockPa({
      'billing:balance': () => bal, 'billing:topupInfo': () => ({ enableRedemption: true }),
      'billing:redeem': () => { bal = balance; return { added: 500000, quota: 500000 }; },
    });
    render(<BillingPanel />);
    expect(screen.getByText(/加载中/)).toBeTruthy();
    expect(await screen.findByText('$0.0000')).toBeTruthy();
    expect((screen.getByRole('button', { name: '兑换' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByPlaceholderText('兑换码'), 'CODE');
    await userEvent.click(screen.getByRole('button', { name: '兑换' }));
    expect(await screen.findByText(/兑换成功/)).toBeTruthy();
    expect(await screen.findByText('$1.0000')).toBeTruthy();
    expect(pa.calls('billing:redeem')).toEqual([{ code: 'CODE' }]);
  });
  it('redeem RATE_LIMITED shows retryAfter', async () => {
    mockPa({ 'billing:balance': () => balance, 'billing:topupInfo': () => ({ enableRedemption: true }), 'billing:redeem': () => fail('RATE_LIMITED', 'slow', { retryAfter: 30 }) });
    render(<BillingPanel />);
    await userEvent.type(await screen.findByPlaceholderText('兑换码'), 'C');
    await userEvent.click(screen.getByRole('button', { name: '兑换' }));
    expect((await screen.findByRole('alert')).textContent).toContain('约 30 秒后可重试');
  });
  it('balance error shown', async () => {
    mockPa({ 'billing:balance': () => fail('NETWORK'), 'billing:topupInfo': () => ({}) });
    render(<BillingPanel />);
    expect((await screen.findByRole('alert')).textContent).toContain(ERROR_TEXT.NETWORK);
  });
});

describe('KeysPanel', () => {
  const SECRET = 'sk-' + 'Z'.repeat(48);
  const setup = () => {
    const pa = mockPa({ 'keys:list': () => [key(3, 'k3')], 'keys:copy': () => ({}), 'keys:reveal': (r: { id: number }) => ({ id: r.id, secret: SECRET }) });
    render(<KeysPanel selected={3} onSelect={vi.fn()} />);
    return pa;
  };
  it('empty state', async () => {
    mockPa({ 'keys:list': () => [] });
    render(<KeysPanel onSelect={vi.fn()} />);
    expect(await screen.findByText(/还没有 API key/)).toBeTruthy();
  });
  it('copy is primary and never reveals the secret to the renderer', async () => {
    const pa = setup();
    const copy = await screen.findByRole('button', { name: '复制' });
    expect(copy.style.fontWeight).toBe('600');
    await userEvent.click(copy);
    expect(await screen.findByText('已复制 k3 到剪贴板')).toBeTruthy();
    expect(pa.calls('keys:copy')).toEqual([{ id: 3 }]);
    expect(pa.calls('keys:reveal')).toHaveLength(0);
    expect(document.body.textContent).not.toContain(SECRET);
  });
  it('reveal requires confirm; cancel does nothing; confirm sends confirm:true; hide clears', async () => {
    const pa = setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(await screen.findByRole('button', { name: '显示' }));
    expect(pa.calls('keys:reveal')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: '显示' }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(SECRET)).toBeTruthy();
    expect(pa.calls('keys:reveal')).toEqual([{ id: 3, confirm: true }]);
    await userEvent.click(screen.getByRole('button', { name: '隐藏' }));
    expect(screen.queryByText(SECRET)).toBeNull();
  });
});

describe('ChatPanel', () => {
  const setup = () => {
    const pa = mockPa({ 'models:list': () => [{ id: 'deepseek-flash' }], 'chat:stream:start': () => ({}), 'chat:stream:cancel': () => ({}) });
    render(<ChatPanel keyId={3} defaultMaxTokens={256} />);
    return pa;
  };
  const sendPrompt = async (pa: ReturnType<typeof mockPa>) => {
    await screen.findByRole('option', { name: 'deepseek-flash' });
    await userEvent.type(screen.getByRole('textbox'), 'hi');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(pa.calls('chat:stream:start')).toHaveLength(1));
    return (pa.calls('chat:stream:start')[0] as { reqId: string }).reqId;
  };
  it('renders streamed reasoning, content, usage; ignores other reqIds', async () => {
    const pa = setup();
    const reqId = await sendPrompt(pa);
    expect(pa.calls('chat:stream:start')[0]).toMatchObject({ model: 'deepseek-flash', maxTokens: 256, keyId: 3, messages: [{ role: 'user', content: 'hi' }] });
    expect(screen.getByText(/生成中/)).toBeTruthy();
    act(() => {
      pa.emit('chat:stream:event', { reqId, type: 'reasoning', delta: '想一想' });
      pa.emit('chat:stream:event', { reqId, type: 'content', delta: 'Hel' });
      pa.emit('chat:stream:event', { reqId: 'other', type: 'content', delta: 'XXX' });
      pa.emit('chat:stream:event', { reqId, type: 'content', delta: 'lo' });
    });
    expect(screen.getByText(/Hello/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
    act(() => {
      pa.emit('chat:stream:event', { reqId, type: 'usage', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } });
      pa.emit('chat:stream:event', { reqId, type: 'done', finishReason: 'stop' });
    });
    expect(screen.getByText('想一想')).toBeTruthy();
    expect(screen.getByText(/1 \+ 2 = 3/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('XXX');
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
  });
  it('stream error event shows friendly message; stop calls cancel', async () => {
    const pa = setup();
    const reqId = await sendPrompt(pa);
    await userEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(pa.calls('chat:stream:cancel')).toEqual([{ reqId }]);
    act(() => pa.emit('chat:stream:event', { reqId, type: 'error', error: { code: 'INSUFFICIENT_QUOTA', message: 'quota' } }));
    expect((await screen.findByRole('alert')).textContent).toContain(ERROR_TEXT.INSUFFICIENT_QUOTA);
  });
  it('truncated-empty warning', async () => {
    const pa = setup();
    const reqId = await sendPrompt(pa);
    act(() => pa.emit('chat:stream:event', { reqId, type: 'done', finishReason: 'length', warning: 'TRUNCATED_EMPTY_CONTENT' }));
    expect(screen.getByText(/请调大 max_tokens/)).toBeTruthy();
  });
});
