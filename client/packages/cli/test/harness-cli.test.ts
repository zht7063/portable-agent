import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKeyring, NoKeyring, type Keyring } from '@pa/key-helper';
import { findCredentialLeaks } from '@pa/core';
import { runHarness } from '../src/commands/harness.js';

const SECRET = 'sk-' + 'C'.repeat(48);
async function run(args: string[], keyring: Keyring = new MemoryKeyring()) {
  const home = await mkdtemp(join(tmpdir(), 'pa-cli-h-'));
  const outs: unknown[] = []; const errs: string[] = [];
  const code = await runHarness([...args, '--home', home], {
    out: (v) => outs.push(v), err: (s) => errs.push(s), keyring, platform: 'linux',
    env: { HOME: '/nonexistent-real-home', PATH: '/usr/bin:/bin' },
    exec: async () => ({ code: null, stdout: '', stderr: '' }),
  });
  return { code, outs, errs, home };
}

describe('pa harness (dev CLI)', () => {
  it('detect/status use the temp HOME only', async () => {
    const d = await run(['detect']);
    expect(d.code).toBe(0);
    expect(JSON.stringify(d.outs)).toContain(d.home);
    expect(JSON.stringify(d.outs)).not.toContain('nonexistent-real-home');
    const s = await run(['status']);
    expect(s.outs[0]).toMatchObject({ profiles: [], files: [], snapshots: 0, keyring: { available: true, backend: 'memory' } });
  });
  it('key-check reports presence only (never the key)', async () => {
    const k = new MemoryKeyring();
    await k.set('default/pi', SECRET);
    const r = await run(['key-check', 'default', 'pi'], k);
    expect(r.code).toBe(0);
    expect(r.outs[0]).toEqual({ available: true, backend: 'memory', profileId: 'default', results: [{ harness: 'pi', found: true }] });
    expect(JSON.stringify(r.outs)).not.toContain(SECRET);
    expect(findCredentialLeaks(r.outs)).toEqual([]);
    expect((await run(['key-check', 'default'], k)).code).toBe(1);
    expect((await run(['key-check', 'default'], new NoKeyring('no dbus'))).outs[0]).toMatchObject({ available: false, fallback: 'env' });
  });
  it('apply/rollback need --yes; unregistered adapters are NOT_IMPLEMENTED; relative --home rejected', async () => {
    expect((await run(['apply', 'pi'])).errs[0]).toMatch(/--yes/);
    await expect(run(['rollback', 'codex', '--yes'])).rejects.toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } });
    const errs: string[] = [];
    expect(await runHarness(['detect', '--home', 'rel'], { out: () => {}, err: (s) => errs.push(s) })).toBe(1);
  });
  it('env-scan --no-login-shell reports names only', async () => {
    const r = await run(['env-scan', '--no-login-shell']);
    expect(r.code).toBe(0);
    expect(r.outs[0]).toMatchObject({ findings: [], skipped: [] });
  });
});

describe('pa harness pi (H1)', () => {
  async function session(keyring: Keyring = new MemoryKeyring()) {
    const home = await mkdtemp(join(tmpdir(), 'pa-cli-pi-'));
    const r = async (args: string[]) => {
      const outs: unknown[] = []; const errs: string[] = [];
      const code = await runHarness([...args, '--home', home, '--helper', '/opt/pa/bin/pa-key'], {
        out: (v) => outs.push(v), err: (s) => errs.push(s), keyring, platform: 'linux',
        env: { HOME: '/nonexistent-real-home', PATH: '/usr/bin:/bin' }, exec: async () => ({ code: null, stdout: '', stderr: '' }),
      }).catch((e: unknown) => { errs.push(String((e as { message?: string }).message ?? e)); return 99; });
      return { code, outs, errs };
    };
    return { home, r };
  }
  const prof = { id: 'default', serverUrl: 'http://127.0.0.1:9', keyId: 3, keyMode: 'command', models: { main: 'deepseek-flash' } };

  it('profile set -> plan -> apply --yes -> rollback --detach (command mode needs an existing keychain entry)', async () => {
    const kr = new MemoryKeyring();
    const { home, r } = await session(kr);
    const f = join(home, 'profile.json');
    await writeFile(f, JSON.stringify(prof));
    expect((await r(['profile', 'set', f])).code).toBe(0);
    expect((await r(['plan', 'pi', '--profile', 'default'])).outs[0]).toMatchObject({ id: 'pi', conflicts: [] });
    const noKey = await r(['apply', 'pi', '--profile', 'default', '--yes']);
    expect(noKey.code).toBe(99);
    expect(noKey.errs.join()).toMatch(/keychain entry/);
    await kr.set('default/pi', SECRET);
    const a = await r(['apply', 'pi', '--profile', 'default', '--yes']);
    expect(a.code).toBe(0);
    const m = JSON.parse(await readFile(join(home, '.pi', 'agent', 'models.json'), 'utf8'));
    expect(m.providers.pa.apiKey).toBe(`!'/opt/pa/bin/pa-key' default pi`);
    expect(JSON.stringify(a.outs)).not.toContain(SECRET);
    expect((await r(['rollback', 'pi', '--detach', '--yes'])).code).toBe(0);
    expect(JSON.parse(await readFile(join(home, '.pi', 'agent', 'models.json'), 'utf8'))).toEqual({ providers: {} });
    expect((await r(['profile', 'list'])).outs[0]).toMatchObject({ profiles: [{ id: 'default' }] });
  });
});
