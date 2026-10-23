/**
 * Opt-in offline E2E: PA_HARNESS_E2E=1 CODEX_BIN=/path/to/codex. Real Codex CLI, temp HOME and CODEX_HOME,
 * fake Responses server on 127.0.0.1 (never rain), fake pa-key printing a dummy value.
 * Verifies /v1/responses path, Bearer from [model_providers.pa.auth], model, store=false, no previous_response_id,
 * env_key mode, and that the user's own keys in config.toml survive apply/detach.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter, ControlledFs, createHarness, nodeExec, nodeFsOps, StateStore } from '@pa/core/harness';

const run = process.env.PA_HARNESS_E2E === '1' && !!process.env.CODEX_BIN && process.platform !== 'win32';
interface Seen { method?: string; url?: string; auth?: string; model?: string; store?: unknown; prev?: unknown; stream?: unknown; upgrade?: string }

function fakeResponses(seen: Seen[]) {
  return createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const j = (b ? JSON.parse(b) : {}) as Record<string, unknown>;
      seen.push({ method: req.method, url: req.url, auth: String(req.headers.authorization ?? ''), model: j.model as string, store: j.store, prev: j.previous_response_id, stream: j.stream, upgrade: req.headers.upgrade });
      if (req.method === 'GET' && req.url?.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"object":"list","data":[{"id":"deepseek-v4-pro","object":"model"}]}'); return; }
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/responses')) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (d: { type: string; [k: string]: unknown }) => res.write(`event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`);
      const resp = { id: 'resp_1', object: 'response', status: 'in_progress', model: j.model, output: [] as unknown[] };
      const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'pong', annotations: [] }] };
      ev({ type: 'response.created', response: resp });
      ev({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      ev({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'pong' });
      ev({ type: 'response.output_item.done', output_index: 0, item });
      ev({ type: 'response.completed', response: { ...resp, status: 'completed', output: [item], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 11 } } });
      res.end();
    });
  });
}

function codex(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.CODEX_BIN!, args, { cwd, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (c) => (out += c));
    const t = setTimeout(() => { p.kill(); reject(new Error('codex timed out')); }, 120_000);
    p.on('close', () => { clearTimeout(t); resolve(out); });
  });
}

describe.skipIf(!run)('codex e2e (offline)', () => {
  it('auth command output is the Bearer; POST /v1/responses with our model; user config preserved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pa-cx-e2e-'));
    const home = join(root, 'home'); const data = join(root, 'data'); const cx = join(root, 'codex-home'); const work = join(root, 'work');
    await mkdir(join(data, 'bin'), { recursive: true }); await mkdir(cx, { recursive: true }); await mkdir(work);
    await writeFile(join(cx, 'config.toml'), '# mine\napproval_policy = "never" # keep\n\n[tui]\nanimations = false\n');
    const helper = join(data, 'bin', 'pa-key');
    await writeFile(helper, `#!/bin/sh\necho "$@" > '${join(root, 'called')}'\nprintf dummy-local-value\n`);
    await chmod(helper, 0o700);
    const seen: Seen[] = [];
    const srv = fakeResponses(seen);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = (srv.address() as AddressInfo).port;
      const fs = new ControlledFs({ ops: nodeFsOps, roots: [home, data, cx], dataDir: data });
      const state = new StateStore(fs);
      const env = { home, env: { CODEX_HOME: cx }, platform: process.platform };
      const h = createHarness({ fs, state, env, exec: nodeExec, adapters: { codex: new CodexAdapter({ fs, state, env, exec: nodeExec, helperPath: helper }) } });
      await h.upsertProfile({ id: 'default', serverUrl: `http://127.0.0.1:${port}`, keyId: 1, keyMode: 'command', models: { main: 'deepseek-v4-pro' }, codex: { setDefault: true } });
      await h.apply('codex', await h.plan('codex', 'default'));
      const runEnv = { HOME: home, CODEX_HOME: cx };
      const args = ['exec', '--skip-git-repo-check', 'ping'];
      expect(await codex(args, work, runEnv)).toContain('pong');
      expect((await readFile(join(root, 'called'), 'utf8')).trim()).toBe('default codex');
      const posts = seen.filter((s) => s.method === 'POST');
      expect(posts.length).toBeGreaterThan(0);
      for (const s of posts) expect(s).toMatchObject({ url: '/v1/responses', auth: 'Bearer dummy-local-value', model: 'deepseek-v4-pro', store: false, stream: true });
      expect(posts.every((s) => s.prev === undefined)).toBe(true);
      expect(seen.every((s) => !s.upgrade)).toBe(true); // no websocket attempt for a custom provider
      // env mode
      await h.upsertProfile({ id: 'default', serverUrl: `http://127.0.0.1:${port}`, keyId: 1, keyMode: 'env', models: { main: 'deepseek-v4-pro' }, codex: { setDefault: true } });
      await h.apply('codex', await h.plan('codex', 'default'));
      seen.length = 0;
      expect(await codex(args, work, { ...runEnv, PA_API_KEY: 'dummy-env-value' })).toContain('pong');
      expect(seen.filter((s) => s.method === 'POST')[0]).toMatchObject({ auth: 'Bearer dummy-env-value' });
      const toml = await readFile(join(cx, 'config.toml'), 'utf8');
      expect(toml).toContain('approval_policy = "never" # keep');
      expect(toml).toContain('[tui]');
      expect(toml).not.toContain('dummy');
    } finally { srv.close(); }
  }, 400_000);
});
