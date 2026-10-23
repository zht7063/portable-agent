/* global process, console */
// Smoke test for the local unpacked build (release/<platform>-unpacked). Temp HOME + userData; no network writes.
// Checks: app boots (PA_SMOKE line), pa-key wrapper installed in userData/bin and runnable, no keyring-linux in package.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(app, 'release', 'linux-unpacked');
const exe = join(dir, 'portable-agent');
if (!existsSync(exe)) { console.log(`no packaged app at ${exe}; run npm run pack:dir`); process.exit(1); }
const root = mkdtempSync(join(tmpdir(), 'pa-pack-smoke-'));
const userData = join(root, 'userData');
const args = [];
if (process.env.PA_SMOKE_NO_SANDBOX === '1' || process.getuid?.() === 0) args.push('--no-sandbox');
const env = { PATH: process.env.PATH ?? '', DISPLAY: process.env.DISPLAY ?? '', XAUTHORITY: process.env.XAUTHORITY ?? '', HOME: root, PA_SMOKE: '1', PA_USER_DATA: userData, PA_SERVER_URL: process.env.PA_SERVER_URL ?? 'http://127.0.0.1:9' };
const r = spawnSync(exe, args, { env, encoding: 'utf8', timeout: 60000 });
const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('PA_SMOKE '));
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? [p, ...walk(p)] : [p]; });
const files = walk(join(dir, 'resources'));
const wrapper = join(userData, 'bin', 'pa-key');
const out = { boot: !!line, smoke: line ? JSON.parse(line.slice(9)) : null, wrapper: existsSync(wrapper), wrapperMode: existsSync(wrapper) ? (statSync(wrapper).mode & 0o777).toString(8) : null,
  scriptUnpacked: existsSync(join(dir, 'resources', 'app.asar.unpacked', 'dist', 'key-helper', 'pa-key.cjs')),
  keyringLinuxShipped: files.some((f) => /keyring-linux/.test(f)) || readFileSync(join(dir, 'resources', 'app.asar')).includes('keyring-linux-x64'),
  helper: null };
if (out.wrapper) {
  // No keychain entry exists in this temp HOME: expect a clean non-zero exit with empty stdout (proves the wrapper runs pa-key.cjs).
  const h = spawnSync(wrapper, ['default', 'codex'], { env: { PATH: env.PATH, HOME: root }, encoding: 'utf8', timeout: 20000 });
  out.helper = { code: h.status, stdoutEmpty: h.stdout === '', stderr: (h.stderr ?? '').trim().split('\n')[0]?.slice(0, 160) };
}
rmSync(root, { recursive: true, force: true });
console.log(`PA_PACK_SMOKE ${JSON.stringify(out)}`);
const ok = out.boot && out.wrapper && out.scriptUnpacked && !out.keyringLinuxShipped && out.helper && out.helper.code !== 0 && out.helper.code !== null && out.helper.stdoutEmpty;
process.exit(ok ? 0 : 1);
