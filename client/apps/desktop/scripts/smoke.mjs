/* global process, console */
// Electron smoke test: launches the built app with a temp userData dir (fresh, anonymous; no network writes).
// Root/containers need --no-sandbox; set PA_SMOKE_NO_SANDBOX=1 (or run as root). Needs a display (use xvfb-run on CI).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electron from 'electron';

const userData = mkdtempSync(join(tmpdir(), 'pa-smoke-'));
const args = ['.'];
if (process.env.PA_SMOKE_NO_SANDBOX === '1' || process.getuid?.() === 0) args.push('--no-sandbox');
const r = spawnSync(electron, args, { env: { ...process.env, PA_SMOKE: '1', PA_USER_DATA: userData }, encoding: 'utf8', timeout: 60000 });
rmSync(userData, { recursive: true, force: true });
const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('PA_SMOKE '));
console.log(line ?? `no smoke output (exit ${r.status})\n${r.stderr?.slice(-2000)}`);
process.exit(r.status === 0 && line ? 0 : 1);
