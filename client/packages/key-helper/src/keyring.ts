import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { HARNESS_IDS, type HarnessId, type KeyringBackend, type KeyringStatus } from '@pa/core/contract';

/** Keychain service name; account = "<profileId>/<harness>" (one entry per harness, D3). */
export const KEYRING_SERVICE = 'portable-agent';
export const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function accountFor(profileId: string, harness: HarnessId): string {
  if (!PROFILE_ID_RE.test(profileId)) throw new Error('invalid profile id');
  if (!(HARNESS_IDS as readonly string[]).includes(harness)) throw new Error('invalid harness');
  return `${profileId}/${harness}`;
}

export interface Availability { ok: boolean; reason?: string }
export interface Keyring {
  readonly backend: KeyringBackend;
  available(): Promise<Availability>;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

export class MemoryKeyring implements Keyring {
  readonly backend = 'memory' as const;
  private readonly m = new Map<string, string>();
  constructor(private readonly ok = true) {}
  async available() { return this.ok ? { ok: true } : { ok: false, reason: 'memory keyring disabled' }; }
  private guard() { if (!this.ok) throw new Error('keychain unavailable'); }
  async get(a: string) { this.guard(); return this.m.get(a) ?? null; }
  async set(a: string, s: string) { this.guard(); this.m.set(a, s); }
  async delete(a: string) { this.guard(); return this.m.delete(a); }
}

/** Unavailable keychain: every op fails; callers must fall back to env mode (never plaintext files). */
export class NoKeyring implements Keyring {
  readonly backend = 'none' as const;
  constructor(private readonly reason: string) {}
  async available() { return { ok: false, reason: this.reason }; }
  async get(): Promise<string | null> { throw new Error('keychain unavailable'); }
  async set(): Promise<void> { throw new Error('keychain unavailable'); }
  async delete(): Promise<boolean> { throw new Error('keychain unavailable'); }
}

interface NapiEntry { getPassword(): string | null; setPassword(p: string): void; deletePassword(): boolean }
type NapiModule = { Entry: new (service: string, user: string) => NapiEntry };

/** macOS Keychain / Windows Credential Manager via @napi-rs/keyring (MIT). Not used on Linux (see docs/harness.md). */
export class NapiKeyring implements Keyring {
  constructor(readonly backend: 'macos-keychain' | 'windows-credential-manager', private readonly load: () => NapiModule = defaultNapiLoader) {}
  private mod?: NapiModule;
  private entry(a: string): NapiEntry { this.mod ??= this.load(); return new this.mod.Entry(KEYRING_SERVICE, a); }
  async available() { try { this.mod ??= this.load(); return { ok: true }; } catch { return { ok: false, reason: 'keychain library failed to load' }; } }
  async get(a: string) { return this.entry(a).getPassword(); }
  async set(a: string, s: string) { this.entry(a).setPassword(s); }
  async delete(a: string) { try { return this.entry(a).deletePassword(); } catch { return false; } }
}
// `require` exists in the CJS bundle shipped with the desktop app; ESM (tsx/dev) falls back to createRequire.
const defaultNapiLoader = (): NapiModule =>
  (typeof require === 'function' ? require : createRequire(import.meta.url))('@napi-rs/keyring') as NapiModule;

export interface ExecLite { (cmd: string, args: string[], o: { input?: string; env?: Record<string, string | undefined>; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string }> }
export const spawnExec: ExecLite = (cmd, args, o) => new Promise((resolve) => {
  let stdout = ''; let stderr = '';
  let child;
  try { child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: o.env as NodeJS.ProcessEnv | undefined, windowsHide: true }); }
  catch { resolve({ code: null, stdout: '', stderr: 'spawn failed' }); return; }
  const t = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs);
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
  child.on('error', () => { clearTimeout(t); resolve({ code: null, stdout: '', stderr: 'spawn failed' }); });
  child.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
  child.stdin.on('error', () => {});
  child.stdin.end(o.input ?? '');
});

/**
 * Linux Secret Service via the system `secret-tool` (libsecret). Secrets go through stdin/stdout only, never argv.
 * Requires a D-Bus session bus; otherwise unavailable -> env mode.
 */
export class SecretToolKeyring implements Keyring {
  readonly backend = 'secret-service' as const;
  constructor(private readonly exec: ExecLite = spawnExec, private readonly env: Record<string, string | undefined> = process.env) {}
  private attrs(a: string) { return ['service', KEYRING_SERVICE, 'account', a]; }
  private run(args: string[], input?: string) { return this.exec('secret-tool', args, { input, env: this.env, timeoutMs: 10_000 }); }
  async available(): Promise<Availability> {
    if (!this.env.DBUS_SESSION_BUS_ADDRESS && !this.env.XDG_RUNTIME_DIR) return { ok: false, reason: 'no D-Bus session (Secret Service unavailable)' };
    const r = await this.run(['lookup', 'service', KEYRING_SERVICE, 'account', '__pa_probe__']);
    if (r.code === null) return { ok: false, reason: 'secret-tool not installed (libsecret-tools)' };
    if (r.code !== 0 && r.stderr.trim()) return { ok: false, reason: 'Secret Service not reachable' };
    return { ok: true };
  }
  async get(a: string) {
    const r = await this.run(['lookup', ...this.attrs(a)]);
    if (r.code === 0) return r.stdout.replace(/\r?\n$/, '') || null;
    if (r.code === 1 && !r.stderr.trim()) return null;
    throw new Error('keychain lookup failed');
  }
  async set(a: string, s: string) {
    const r = await this.run(['store', `--label=Portable Agent (${a})`, ...this.attrs(a)], s);
    if (r.code !== 0) throw new Error('keychain store failed');
  }
  async delete(a: string) {
    const existed = (await this.get(a)) !== null;
    const r = await this.run(['clear', ...this.attrs(a)]);
    if (r.code !== 0 && existed) throw new Error('keychain delete failed');
    return existed;
  }
}

export interface KeyringFactoryDeps { platform?: NodeJS.Platform; env?: Record<string, string | undefined>; exec?: ExecLite; napi?: () => NapiModule }
export function createKeyring(d: KeyringFactoryDeps = {}): Keyring {
  const platform = d.platform ?? process.platform;
  if (platform === 'darwin') return new NapiKeyring('macos-keychain', d.napi);
  if (platform === 'win32') return new NapiKeyring('windows-credential-manager', d.napi);
  if (platform === 'linux' || platform === 'freebsd') return new SecretToolKeyring(d.exec, d.env ?? process.env);
  return new NoKeyring('unsupported platform');
}

/** Entry presence only; never returns key values. Linux w/o Secret Service -> fallback "env" (never plaintext). */
export async function keyringStatus(k: Keyring, profileIds: string[]): Promise<KeyringStatus> {
  const a = await k.available();
  if (!a.ok) return { available: false, backend: k.backend, fallback: 'env', ...(a.reason ? { reason: a.reason } : {}), entries: [] };
  const entries: KeyringStatus['entries'] = [];
  for (const profileId of profileIds) for (const harness of HARNESS_IDS) {
    let present = false;
    try { present = (await k.get(accountFor(profileId, harness))) !== null; } catch { present = false; }
    entries.push({ profileId, harness, present });
  }
  return { available: true, backend: k.backend, entries };
}
