import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  accountFor, createKeyring, installWrapper, keyringStatus, MemoryKeyring, NapiKeyring, NoKeyring, renderWrapper, runPaKey, SecretToolKeyring,
  type ExecLite,
} from '@pa/key-helper';

const SECRET = 'sk-' + 'K'.repeat(48);
const io = () => { const o = { out: '', err: '' }; return { o, io: { stdout: (s: string) => { o.out += s; }, stderr: (s: string) => { o.err += s; } } }; };

describe('pa-key', () => {
  it('prints exactly the key, nothing else', async () => {
    const k = new MemoryKeyring();
    await k.set(accountFor('default', 'claude'), SECRET);
    const { o, io: i } = io();
    expect(await runPaKey(['default', 'claude'], k, i)).toBe(0);
    expect(o.out).toBe(SECRET);
    expect(o.err).toBe('');
  });
  it('missing entry -> exit 3; unavailable -> exit 4 (env mode hint); bad args -> exit 2; stderr never has secrets', async () => {
    const k = new MemoryKeyring();
    await k.set(accountFor('default', 'pi'), SECRET);
    for (const [args, keyring, code] of [
      [['default', 'codex'], k, 3],
      [['default', 'pi'], new MemoryKeyring(false), 4],
      [['default', 'pi'], new NoKeyring('no dbus'), 4],
      [['default'], k, 2],
      [['../x', 'pi'], k, 2],
      [['default', 'gemini'], k, 2],
      [['default', 'pi', 'extra'], k, 2],
    ] as const) {
      const { o, io: i } = io();
      expect(await runPaKey([...args], keyring, i)).toBe(code);
      expect(o.out).toBe('');
      expect(o.err).not.toContain(SECRET);
      expect(o.err).not.toMatch(/sk-/);
    }
  });
});

describe('keyring backends', () => {
  it('secret-tool: secret only via stdin, never argv; lookup/clear; probe detects availability', async () => {
    const calls: { args: string[]; input?: string }[] = [];
    const store = new Map<string, string>();
    const exec: ExecLite = async (_cmd, args, o) => {
      calls.push({ args, input: o.input });
      const acct = args[args.indexOf('account') + 1]!;
      if (args[0] === 'store') { store.set(acct, o.input ?? ''); return { code: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'lookup') return store.has(acct) ? { code: 0, stdout: store.get(acct)!, stderr: '' } : { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'clear') { store.delete(acct); return { code: 0, stdout: '', stderr: '' }; }
      return { code: 2, stdout: '', stderr: 'bad' };
    };
    const k = new SecretToolKeyring(exec, { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' });
    expect(await k.available()).toEqual({ ok: true });
    await k.set('default/codex', SECRET);
    expect(await k.get('default/codex')).toBe(SECRET);
    expect(await k.delete('default/codex')).toBe(true);
    expect(await k.get('default/codex')).toBeNull();
    for (const c of calls) expect(c.args.join(' ')).not.toContain(SECRET);
    expect(calls.find((c) => c.args[0] === 'store')!.input).toBe(SECRET);
    expect(calls.find((c) => c.args[0] === 'store')!.args).toEqual(['store', '--label=Portable Agent (default/codex)', 'service', 'portable-agent', 'account', 'default/codex']);
  });
  it('secret-tool unavailable: no D-Bus, not installed, or service error', async () => {
    const never: ExecLite = async () => { throw new Error('must not run'); };
    expect(await new SecretToolKeyring(never, {}).available()).toMatchObject({ ok: false, reason: expect.stringMatching(/D-Bus/) });
    const missing: ExecLite = async () => ({ code: null, stdout: '', stderr: 'spawn failed' });
    expect(await new SecretToolKeyring(missing, { DBUS_SESSION_BUS_ADDRESS: 'x' }).available()).toMatchObject({ ok: false, reason: expect.stringMatching(/not installed/) });
    const broken: ExecLite = async () => ({ code: 1, stdout: '', stderr: 'Cannot autolaunch D-Bus without X11' });
    const k = new SecretToolKeyring(broken, { DBUS_SESSION_BUS_ADDRESS: 'x' });
    expect((await k.available()).ok).toBe(false);
    await expect(k.get('default/pi')).rejects.toThrow('keychain lookup failed');
  });
  it('napi backend (macOS/Windows) uses service "portable-agent" and account "<profile>/<harness>"', async () => {
    const seen: string[] = [];
    const store = new Map<string, string>();
    const napi = () => ({ Entry: class { constructor(private s: string, private u: string) { seen.push(`${s}|${u}`); }
      getPassword() { return store.get(this.u) ?? null; } setPassword(p: string) { store.set(this.u, p); } deletePassword() { return store.delete(this.u); } } });
    const k = createKeyring({ platform: 'darwin', napi });
    expect(k).toBeInstanceOf(NapiKeyring);
    expect(k.backend).toBe('macos-keychain');
    await k.set(accountFor('p1', 'pi'), SECRET);
    expect(await k.get('p1/pi')).toBe(SECRET);
    expect(seen[0]).toBe('portable-agent|p1/pi');
    expect(createKeyring({ platform: 'win32', napi }).backend).toBe('windows-credential-manager');
    expect(createKeyring({ platform: 'linux', env: {} }).backend).toBe('secret-service');
    expect(createKeyring({ platform: 'aix' }).backend).toBe('none');
    const bad = new NapiKeyring('macos-keychain', () => { throw new Error('dlopen'); });
    expect(await bad.available()).toEqual({ ok: false, reason: 'keychain library failed to load' });
  });
  it('status reports presence only; unavailable -> fallback env, never plaintext', async () => {
    const k = new MemoryKeyring();
    await k.set('default/claude', SECRET);
    const s = await keyringStatus(k, ['default']);
    expect(s).toEqual({ available: true, backend: 'memory', entries: [
      { profileId: 'default', harness: 'pi', present: false }, { profileId: 'default', harness: 'claude', present: true }, { profileId: 'default', harness: 'codex', present: false },
    ] });
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(await keyringStatus(new NoKeyring('no dbus'), ['default'])).toEqual({ available: false, backend: 'none', fallback: 'env', reason: 'no dbus', entries: [] });
  });
  it('accountFor validates input', () => {
    expect(() => accountFor('a/b', 'pi')).toThrow();
    expect(() => accountFor('ok', 'x' as never)).toThrow();
  });
});

describe('pa-key wrapper (D4: inside the client directory, absolute path)', () => {
  it('renders sh / cmd wrappers with ELECTRON_RUN_AS_NODE and safe quoting', () => {
    expect(renderWrapper({ dir: '/d', execPath: "/Apps/Portable Agent's.app/x", scriptPath: '/r/pa-key.cjs', platform: 'darwin' }))
      .toContain(`ELECTRON_RUN_AS_NODE=1 exec '/Apps/Portable Agent'\\''s.app/x' '/r/pa-key.cjs' "$@"`);
    expect(renderWrapper({ dir: 'C:\\d', execPath: 'C:\\Program Files\\PA\\pa.exe', scriptPath: 'C:\\PA\\pa-key.cjs', platform: 'win32' }))
      .toBe('@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files\\PA\\pa.exe" "C:\\PA\\pa-key.cjs" %*\r\n');
    expect(() => renderWrapper({ dir: '/d', execPath: 'rel', scriptPath: '/x', platform: 'linux' })).toThrow();
    expect(() => renderWrapper({ dir: 'C:\\d', execPath: 'C:\\a%b', scriptPath: 'C:\\x', platform: 'win32' })).toThrow();
  });
  it.runIf(process.platform !== 'win32')('installed wrapper is 0700 and runs the script with the bundled runtime, passing args', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pa-wrap-'));
    const script = join(dir, 'probe.cjs');
    await writeFile(script, 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), ran: process.env.ELECTRON_RUN_AS_NODE }))');
    const path = await installWrapper({ dir: join(dir, 'bin'), execPath: process.execPath, scriptPath: script });
    expect(path).toBe(join(dir, 'bin', 'pa-key'));
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    const { stdout } = await promisify(execFile)(path, ['default', 'codex'], { env: { PATH: '/usr/bin:/bin', HOME: dir } });
    expect(JSON.parse(stdout)).toEqual({ args: ['default', 'codex'], ran: '1' });
    expect(await readFile(path, 'utf8')).not.toMatch(/sk-/);
  });
});
