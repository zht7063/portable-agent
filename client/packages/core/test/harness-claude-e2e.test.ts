/**
 * Opt-in offline E2E: PA_HARNESS_E2E=1 CLAUDE_BIN=/path/to/claude. Real Claude Code binary, temp HOME and
 * CLAUDE_CONFIG_DIR, fake Anthropic Messages server on 127.0.0.1 (never rain), fake pa-key printing a dummy value.
 * Verifies request path, auth headers (apiKeyHelper output), model ids and alias mapping.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, ControlledFs, createHarness, nodeExec, nodeFsOps, StateStore } from '@pa/core/harness';

const run = process.env.PA_HARNESS_E2E === '1' && !!process.env.CLAUDE_BIN && process.platform !== 'win32';
interface Seen { url?: string; xApiKey?: string; auth?: string; model?: string }

function fakeAnthropic(seen: Seen[]) {
  return createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const j = (b ? JSON.parse(b) : {}) as { model?: string; stream?: boolean };
      seen.push({ url: req.url, xApiKey: String(req.headers['x-api-key'] ?? ''), auth: String(req.headers.authorization ?? ''), model: j.model });
      if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":1}'); return; }
      const msg = { id: 'msg_1', type: 'message', role: 'assistant', model: j.model, content: [] as unknown[], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } };
      if (!j.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...msg, content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn' })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (e: string, d: object) => res.write(`event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`);
      ev('message_start', { message: msg });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'pong' } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      ev('message_stop', {});
      res.end();
    });
  });
}

function claude(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.CLAUDE_BIN!, args, { cwd, env: { PATH: process.env.PATH ?? '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (c) => (out += c));
    const t = setTimeout(() => { p.kill(); reject(new Error('claude timed out')); }, 90_000);
    p.on('close', () => { clearTimeout(t); resolve(out); });
  });
}

describe.skipIf(!run)('claude code e2e (offline)', () => {
  it('apiKeyHelper output is sent as X-Api-Key and Bearer; /v1/messages; ANTHROPIC_MODEL and alias mapping apply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pa-cc-e2e-'));
    const home = join(root, 'home'); const data = join(root, 'data'); const cfg = join(home, '.claude');
    await mkdir(join(data, 'bin'), { recursive: true });
    const helper = join(data, 'bin', 'pa key');
    await writeFile(helper, `#!/bin/sh\necho "$@" > '${join(root, 'called')}'\nprintf dummy-local-value\n`);
    await chmod(helper, 0o700);
    const seen: Seen[] = [];
    const srv = fakeAnthropic(seen);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = (srv.address() as AddressInfo).port;
      const fs = new ControlledFs({ ops: nodeFsOps, roots: [home, data], dataDir: data });
      const state = new StateStore(fs);
      const env = { home, env: { CLAUDE_CONFIG_DIR: cfg }, platform: process.platform };
      const h = createHarness({ fs, state, env, exec: nodeExec, adapters: { claude: new ClaudeAdapter({ fs, state, env, exec: nodeExec, helperPath: helper }) } });
      await h.upsertProfile({ id: 'default', serverUrl: `http://127.0.0.1:${port}/v1`, keyId: 1, keyMode: 'command', models: { main: 'deepseek-v4-pro', small: 'deepseek-flash' } });
      await h.apply('claude', await h.plan('claude', 'default'));
      const runEnv = { HOME: home, CLAUDE_CONFIG_DIR: cfg };
      expect(await claude(['-p', 'ping'], root, runEnv)).toContain('pong');
      expect((await readFile(join(root, 'called'), 'utf8')).trim()).toBe('default claude');
      const main = seen.filter((s) => s.url?.startsWith('/v1/messages') && !s.url.includes('count_tokens'));
      expect(main.length).toBeGreaterThan(0);
      for (const s of seen) expect({ x: s.xApiKey, a: s.auth }).toEqual({ x: 'dummy-local-value', a: 'Bearer dummy-local-value' });
      expect(main.map((s) => s.model)).toContain('deepseek-v4-pro');
      seen.length = 0;
      expect(await claude(['-p', 'ping', '--model', 'haiku'], root, runEnv)).toContain('pong');
      expect(seen.map((s) => s.model)).toContain('deepseek-flash');
      expect(seen.every((s) => !/^claude-/.test(s.model ?? ''))).toBe(true);
      // env mode: helper expands PA_API_KEY at run time
      await h.upsertProfile({ id: 'default', serverUrl: `http://127.0.0.1:${port}`, keyId: 1, keyMode: 'env', models: { main: 'deepseek-v4-pro' } });
      await h.apply('claude', await h.plan('claude', 'default'));
      seen.length = 0;
      expect(await claude(['-p', 'ping'], root, { ...runEnv, PA_API_KEY: 'dummy-env-value' })).toContain('pong');
      expect(seen[0]).toMatchObject({ xApiKey: 'dummy-env-value', auth: 'Bearer dummy-env-value' });
    } finally { srv.close(); }
  }, 300_000);
});
