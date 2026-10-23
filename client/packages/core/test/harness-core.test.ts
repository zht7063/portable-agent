import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlledFs, createHarness, maskValue, nodeFsOps, StateStore, configDir, type ExecFn } from '@pa/core/harness';
import { findCredentialLeaks, INVOKE_CHANNELS, CONFIRM_REQUIRED_CHANNELS } from '@pa/core';

async function setup(exec: ExecFn, env: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pa-hcore-'));
  const home = join(root, 'home');
  await mkdir(home);
  const fs = new ControlledFs({ ops: nodeFsOps, roots: [home, join(root, 'data')], dataDir: join(root, 'data') });
  const state = new StateStore(fs);
  return { home, state, h: createHarness({ fs, state, exec, env: { home, env, platform: 'linux' } }) };
}

describe('harness skeleton', () => {
  it('detects via --version (3s timeout) and file presence; auth.json is never read', async () => {
    const seen: string[] = [];
    const exec: ExecFn = async (cmd, args, o) => { seen.push(`${cmd} ${args.join(' ')} ${o.timeoutMs}`); return cmd === 'codex' ? { code: 0, stdout: 'codex-cli 0.130.0\n', stderr: '' } : { code: null, stdout: '', stderr: '' }; };
    const { home, h } = await setup(exec);
    await mkdir(join(home, '.codex'));
    await writeFile(join(home, '.codex', 'auth.json'), '{"OPENAI_API_KEY":"sk-' + 'Q'.repeat(30) + '"}');
    const d = await h.detect();
    expect(seen.sort()).toEqual(['claude --version 3000', 'codex --version 3000', 'pi --version 3000']);
    const codex = d.find((x) => x.id === 'codex')!;
    expect(codex).toMatchObject({ installed: true, version: '0.130.0', configDir: join(home, '.codex') });
    expect(codex.files).toEqual([{ path: join(home, '.codex', 'config.toml'), exists: false }, { path: join(home, '.codex', 'auth.json'), exists: true }]);
    expect(d.find((x) => x.id === 'pi')!.installed).toBe(false);
    expect(findCredentialLeaks(d)).toEqual([]);
    expect(h.registered()).toEqual([]);
  });
  it('honours CODEX_HOME / CLAUDE_CONFIG_DIR / PI_CODING_AGENT_DIR', () => {
    const e = { home: '/h', platform: 'linux' as const, env: { CODEX_HOME: '/c', CLAUDE_CONFIG_DIR: '/cl', PI_CODING_AGENT_DIR: '/p' } };
    expect([configDir('codex', e), configDir('claude', e), configDir('pi', e)]).toEqual(['/c', '/cl', '/p']);
  });
  it('config dir outside the allowlist is reported as absent, never touched', async () => {
    const exec: ExecFn = async () => ({ code: null, stdout: '', stderr: '' });
    const { h } = await setup(exec, { CLAUDE_CONFIG_DIR: '/etc' });
    expect((await h.detect()).find((x) => x.id === 'claude')!.files).toEqual([{ path: '/etc/settings.json', exists: false }]);
  });
  it('plan/apply/rollback without adapter -> NOT_IMPLEMENTED; unknown harness -> VALIDATION; default keyring status = env fallback', async () => {
    const { h, state } = await setup(async () => ({ code: null, stdout: '', stderr: '' }));
    await state.upsertProfile({ id: 'default', serverUrl: 'http://127.0.0.1:9', keyId: 1, models: { main: 'm' }, keyMode: 'command' });
    await expect(h.plan('pi', 'default')).rejects.toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } });
    await expect(h.rollback('codex', 'last')).rejects.toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } });
    await expect(h.plan('gemini' as never, 'default')).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
    expect(await h.keyringStatus()).toMatchObject({ available: false, fallback: 'env' });
  });
  it('contract: harness IPC channels exist and mutating ones require confirm', () => {
    for (const c of ['harness:detect', 'harness:plan', 'harness:apply', 'harness:rollback', 'harness:keyring:status']) expect(INVOKE_CHANNELS).toContain(c);
    expect(CONFIRM_REQUIRED_CHANNELS).toEqual(expect.arrayContaining(['harness:apply', 'harness:rollback', 'keys:reveal']));
  });
  it('maskValue hides secrets', () => {
    expect(maskValue('sk-' + 'a'.repeat(30))).toBe('***');
    expect(maskValue({ apiKey: 'nap_' + 'b'.repeat(20) })).toBe('***');
    expect(maskValue('deepseek-flash')).toBe('deepseek-flash');
    expect(maskValue(undefined)).toBeNull();
  });
});
