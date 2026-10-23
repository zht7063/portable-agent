import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_ENV_VARS, parseEnv0, parseRegQuery, scanEnv, type ExecFn } from '@pa/core/harness';

const SECRET_VAL = 'sk-' + 'Z'.repeat(40);
const URL_VAL = 'http://other.example:8080';

async function home() {
  const h = await mkdtemp(join(tmpdir(), 'pa-henv-'));
  await mkdir(join(h, '.config', 'fish'), { recursive: true });
  await writeFile(join(h, '.bashrc'), `# export ANTHROPIC_API_KEY=commented\nexport ANTHROPIC_API_KEY=${SECRET_VAL}\nsource ~/.pa-extra\n`);
  await writeFile(join(h, '.pa-extra'), `ANTHROPIC_BASE_URL=${URL_VAL}\n. ./never-followed-deeper\n`);
  await writeFile(join(h, '.zshrc'), `typeset -x ANTHROPIC_MODEL=x\n`);
  await writeFile(join(h, '.config', 'fish', 'config.fish'), `set -gx CODEX_HOME /tmp/c\n`);
  return h;
}
const readText = async (p: string) => { try { return await readFile(p, 'utf8'); } catch { return null; } };

describe('env-scan', () => {
  it('reports names + sources only, never values (process, login shell, rc files with source chain)', async () => {
    const h = await home();
    const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
    const exec: ExecFn = async (cmd, args, o) => {
      calls.push({ cmd, args, env: o.env });
      return { code: 0, stderr: '', stdout: `ANTHROPIC_BASE_URL=${URL_VAL}\0ANTHROPIC_API_KEY=${SECRET_VAL}\0UNRELATED=1\0` };
    };
    const watch = [...HARNESS_ENV_VARS.claude, ...HARNESS_ENV_VARS.codex].map((w) => (w.name === 'ANTHROPIC_BASE_URL' ? { ...w, expected: 'http://127.0.0.1:9' } : w));
    const r = await scanEnv(watch, { processEnv: { SHELL: '/bin/bash', ANTHROPIC_MODEL: 'deepseek-flash', HOME: h }, platform: 'linux', home: h, exec, readText });
    const s = JSON.stringify(r);
    expect(s).not.toContain(SECRET_VAL);
    expect(s).not.toContain('other.example');
    expect(s).not.toContain('deepseek-flash');
    expect(calls[0]).toMatchObject({ cmd: '/bin/bash', args: ['-ilc', 'env -0'] });
    expect(Object.keys(calls[0]!.env!).sort()).toEqual(['HOME', 'PATH', 'SHELL', 'TERM']);
    const f = (src: string, name: string) => r.findings.filter((x) => x.source === src && x.name === name);
    expect(f('process', 'ANTHROPIC_MODEL')[0]).toMatchObject({ severity: 'info' });
    expect(f('login-shell', 'ANTHROPIC_BASE_URL')[0]).toMatchObject({ severity: 'conflict', matchesProfile: false });
    expect(f('login-shell', 'ANTHROPIC_API_KEY')[0]).toMatchObject({ severity: 'conflict' });
    expect(f('rc-file', 'ANTHROPIC_API_KEY').map((x) => x.location)).toEqual([`${join(h, '.bashrc')}:2`]);
    expect(f('rc-file', 'ANTHROPIC_BASE_URL').map((x) => x.location)).toEqual([`${join(h, '.pa-extra')}:1`]);
    expect(f('rc-file', 'ANTHROPIC_MODEL').map((x) => x.location)).toEqual([`${join(h, '.zshrc')}:1`]);
    expect(f('rc-file', 'CODEX_HOME').map((x) => x.location)).toEqual([`${join(h, '.config', 'fish', 'config.fish')}:1`]);
    expect(r.findings.some((x) => x.name === 'UNRELATED')).toBe(false);
  });
  it('matching value -> info/matchesProfile; fish uses -lic; timeout is skipped', async () => {
    const h = await mkdtemp(join(tmpdir(), 'pa-henv-'));
    const w = [{ name: 'ANTHROPIC_BASE_URL', policy: 'must-match' as const, expected: 'http://127.0.0.1:9' }];
    let args: string[] = [];
    const ok: ExecFn = async (_c, a) => { args = a; return { code: 0, stderr: '', stdout: 'ANTHROPIC_BASE_URL=http://127.0.0.1:9\0' }; };
    const r = await scanEnv(w, { processEnv: { SHELL: '/usr/bin/fish' }, platform: 'darwin', home: h, exec: ok, readText });
    expect(args[0]).toBe('-lic');
    expect(r.findings).toEqual([expect.objectContaining({ source: 'login-shell', matchesProfile: true, severity: 'info' })]);
    const slow: ExecFn = async () => ({ code: null, stdout: '', stderr: '', timedOut: true });
    const r2 = await scanEnv(w, { processEnv: { SHELL: '/bin/zsh' }, platform: 'linux', home: h, exec: slow, readText });
    expect(r2.skipped).toEqual([{ layer: 'login-shell', reason: 'timeout' }]);
    const r3 = await scanEnv(w, { processEnv: {}, platform: 'linux', home: h, exec: slow, readText }, { rcFiles: false });
    expect(r3.skipped[0]?.reason).toBe('SHELL not set');
  });
  it('windows: reads user/system environment via reg query; no rc scan', async () => {
    const out = '\r\nHKEY_CURRENT_USER\\Environment\r\n    ANTHROPIC_API_KEY    REG_SZ    secretvalue\r\n    Path    REG_EXPAND_SZ    C:\\x\r\n';
    const exec: ExecFn = async (cmd, args) => (cmd === 'reg' && args[1] === 'HKCU\\Environment' ? { code: 0, stdout: out, stderr: '' } : { code: 1, stdout: '', stderr: 'x' });
    const r = await scanEnv(HARNESS_ENV_VARS.claude, { processEnv: {}, platform: 'win32', home: 'C:\\Users\\t', exec, readText: async () => { throw new Error('no rc on windows'); } });
    expect(r.findings).toEqual([expect.objectContaining({ name: 'ANTHROPIC_API_KEY', source: 'windows-registry', location: 'HKCU', severity: 'conflict' })]);
    expect(JSON.stringify(r)).not.toContain('secretvalue');
    expect(r.skipped).toEqual([{ layer: 'windows-registry', reason: 'reg query failed' }]);
  });
  it('parsers keep only watched names', () => {
    expect([...parseEnv0('A=1\0B=2=3\0\nC=x\0', new Set(['B', 'C'])).entries()]).toEqual([['B', '2=3'], ['C', 'x']]);
    expect([...parseRegQuery('    A    REG_SZ    v\n    B    REG_DWORD    0x1', new Set(['A', 'B'])).keys()]).toEqual(['A']);
  });
});
