import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryTokenStore, createCore, normalizeServerUrl, type SessionView } from '@pa/core';
import { ConfigStore } from '../src/main/config-store';
import { CoreHost } from '../src/main/core-host';
import { createHandlers, dispatch } from '../src/main/ipc/handlers';
import { tmpHarnessHost } from './harness-fixture';

const DEF = 'http://38.246.253.190:3000';
const tmp = async () => join(await mkdtemp(join(tmpdir(), 'pa-cfg-')), 'config.json');

describe('normalizeServerUrl', () => {
  it('accepts and normalizes http(s)', () => {
    expect(normalizeServerUrl(' http://38.246.253.190:3000/ ')).toBe(DEF);
    expect(normalizeServerUrl('https://Api.Example.com/base//')).toBe('https://api.example.com/base');
  });
  it.each(['', 'not a url', 'ftp://x', 'javascript:alert(1)', 'http://u:p@host', 'http://h/?q=1', 'http://h/#x', 'file:///etc/passwd'])('rejects %s', (u) => {
    expect(() => normalizeServerUrl(u)).toThrowError();
  });
});

describe('ConfigStore', () => {
  it('defaults when missing; persists and reloads', async () => {
    const p = await tmp();
    const s = new ConfigStore(p, DEF);
    const d = await s.load();
    expect(d).toEqual({ version: 1, serverUrl: DEF, defaultMaxTokens: 2048 });
    const next = s.apply(d, { serverUrl: 'https://new.example.com/', defaultMaxTokens: 4096 });
    await s.save(next);
    expect(JSON.parse(await readFile(p, 'utf8'))).toEqual({ version: 1, serverUrl: 'https://new.example.com', defaultMaxTokens: 4096 });
    expect(await new ConfigStore(p, DEF).load()).toEqual(next);
  });
  it('falls back per-field on corrupt/invalid file', async () => {
    const p = await tmp();
    await writeFile(p, '{not json');
    expect((await new ConfigStore(p, DEF).load()).serverUrl).toBe(DEF);
    await writeFile(p, JSON.stringify({ serverUrl: 'ftp://bad', defaultMaxTokens: 4096 }));
    expect(await new ConfigStore(p, DEF).load()).toEqual({ version: 1, serverUrl: DEF, defaultMaxTokens: 4096 });
    await writeFile(p, JSON.stringify({ serverUrl: 'https://ok.example', defaultMaxTokens: -1 }));
    expect(await new ConfigStore(p, DEF).load()).toEqual({ version: 1, serverUrl: 'https://ok.example', defaultMaxTokens: 2048 });
  });
  it('apply rejects invalid input without changing config', () => {
    const s = new ConfigStore('/nonexistent', DEF);
    const d = s.defaults();
    expect(() => s.apply(d, { serverUrl: 'nope' })).toThrowError(/Invalid server URL/);
    expect(() => s.apply(d, { defaultMaxTokens: 1.5 })).toThrowError();
  });
});

describe('CoreHost', () => {
  async function host(p: string, tokenStore = new MemoryTokenStore()) {
    const views: SessionView[] = [];
    const created: string[] = [];
    const h = await CoreHost.start({
      configStore: new ConfigStore(p, DEF),
      tokenStore,
      onSessionChange: (v) => views.push(v),
      createCoreImpl: (o) => { created.push(o.serverUrl!); return createCore({ ...o, fetch: async () => new Response('{}', { status: 503 }) }); },
    });
    return { h, views, created, tokenStore };
  }

  it('restores persisted URL on startup', async () => {
    const p = await tmp();
    await writeFile(p, JSON.stringify({ version: 1, serverUrl: 'https://saved.example', defaultMaxTokens: 1024 }));
    const { h, created } = await host(p);
    expect(h.config()).toEqual({ serverUrl: 'https://saved.example', defaultMaxTokens: 1024, insecureTransport: false });
    expect(created).toEqual(['https://saved.example']);
    expect(h.core.http.baseUrl).toBe('https://saved.example');
  });

  it('URL change persists, clears session, recreates core and emits anonymous', async () => {
    const p = await tmp();
    const { h, views, created, tokenStore } = await host(p);
    await h.core.session.establish({ accessToken: 'jwt', accessExpiresAt: 9e9, stored: { serverUrl: DEF, refreshCookie: 'c', userId: 1, username: 'u' } });
    const old = h.core;
    const cfg = await h.set({ serverUrl: 'https://new.example/' });
    expect(cfg).toEqual({ serverUrl: 'https://new.example', defaultMaxTokens: 2048, insecureTransport: false });
    expect(h.core).not.toBe(old);
    expect(created).toEqual([DEF, 'https://new.example']);
    expect(await tokenStore.load()).toBeNull();
    expect(views.at(-1)).toMatchObject({ status: 'anonymous', serverUrl: 'https://new.example' });
    expect(JSON.parse(await readFile(p, 'utf8')).serverUrl).toBe('https://new.example');
    // old core's listener detached: changes on it no longer reach the UI
    const n = views.length;
    await old.session.clear();
    expect(views.length).toBe(n);
    // restart restores
    expect((await host(p)).h.config().serverUrl).toBe('https://new.example');
  });

  it('same URL / maxTokens-only change keeps core and session', async () => {
    const p = await tmp();
    const { h, created } = await host(p);
    await h.core.session.establish({ accessToken: 'jwt', accessExpiresAt: 9e9, stored: { serverUrl: DEF, refreshCookie: 'c', userId: 1, username: 'u' } });
    const old = h.core;
    await h.set({ serverUrl: DEF + '/', defaultMaxTokens: 4096 });
    expect(h.core).toBe(old);
    expect(created.length).toBe(1);
    expect(h.core.session.view().status).toBe('authenticated');
  });

  it('invalid URL via IPC returns VALIDATION and changes nothing', async () => {
    const p = await tmp();
    const { h } = await host(p);
    const handlers = createHandlers({ getCore: () => h.core, getConfig: () => h.config(), setConfig: (x) => h.set(x), copyToClipboard: () => {}, emitStream: () => {}, harness: tmpHarnessHost().host.harness });
    expect(await dispatch(handlers, 'config:set', { serverUrl: 'javascript:alert(1)' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(h.config().serverUrl).toBe(DEF);
    await expect(readFile(p, 'utf8')).rejects.toThrow();
    // handlers follow the recreated core
    await dispatch(handlers, 'config:set', { serverUrl: 'https://b.example' });
    expect(await dispatch(handlers, 'auth:session', {})).toMatchObject({ ok: true, data: { serverUrl: 'https://b.example' } });
  });
});
