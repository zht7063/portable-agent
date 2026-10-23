/**
 * Claude Code adapter, H2.
 * Owned settings in <CLAUDE_CONFIG_DIR|~/.claude>/settings.json (verified against code.claude.com/docs, 2026-10):
 *   apiKeyHelper                       shell command whose stdout is sent as X-Api-Key and Authorization: Bearer
 *   env.ANTHROPIC_BASE_URL             server origin (Claude Code appends /v1/messages)
 *   env.ANTHROPIC_MODEL                models.main (unless claude.setModel === false)
 *   env.ANTHROPIC_DEFAULT_OPUS_MODEL   models.opus   ?? models.main
 *   env.ANTHROPIC_DEFAULT_SONNET_MODEL models.sonnet ?? models.main
 *   env.ANTHROPIC_DEFAULT_HAIKU_MODEL  models.haiku  ?? models.small ?? models.main
 * Never writes ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN. Never touches ~/.claude.json.
 * command mode: apiKeyHelper = "<pa-key> <profile> claude"; env mode: apiKeyHelper prints $<ENV> at run time
 * (the key never lands in a file). plaintext is refused.
 */
import { join } from 'node:path';
import type { Detection, HarnessProfile } from '../../contract/harness.js';
import { configDir } from '../paths.js';
import { PROFILE_ID_RE } from '../state.js';
import { detectBasic } from '../detect.js';
import { getPath } from '../merge/json.js';
import { serverBase } from './pi.js';
import { bad, ENV_RE, helperCommand, JsonHarnessAdapter, type AdapterOptions, type Desired, type FilePlan } from './base.js';

export type ClaudeAdapterOptions = AdapterOptions;

/** Managed-settings locations (presence only), per docs "Managed settings". */
export function claudeManagedPaths(platform: NodeJS.Platform): string[] {
  const dir = platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : '/etc/claude-code';
  const sep = platform === 'win32' ? '\\' : '/';
  return [`${dir}${sep}managed-settings.json`, `${dir}${sep}managed-settings.d`];
}

export function claudeApiKeyHelper(p: HarnessProfile, helperPath: string, platform: NodeJS.Platform): string {
  if (p.keyMode === 'command') return helperCommand(helperPath, p.id, 'claude', platform);
  if (p.keyMode === 'env') {
    const v = p.envVar ?? 'PA_API_KEY';
    if (!ENV_RE.test(v)) bad('Invalid env var name');
    // Runs via /bin/sh (cmd on Windows); expands the variable at request time, so no key is stored.
    return platform === 'win32' ? `echo %${v}%` : `printf '%s' "$${v}"`;
  }
  return bad('Plaintext key mode is not supported for Claude Code (keys are never written to config files)');
}

/** Claude Code appends /v1/messages itself, so a trailing /v1 is dropped. */
export function claudeBaseUrl(serverUrl: string): string { return serverBase(serverUrl).replace(/\/v1$/, ''); }

export function claudeEnv(p: HarnessProfile): Record<string, string> {
  const m = p.models;
  const out: Record<string, string> = { ANTHROPIC_BASE_URL: claudeBaseUrl(p.serverUrl) };
  if (p.claude?.setModel !== false) out.ANTHROPIC_MODEL = m.main;
  out.ANTHROPIC_DEFAULT_OPUS_MODEL = m.opus ?? m.main;
  out.ANTHROPIC_DEFAULT_SONNET_MODEL = m.sonnet ?? m.main;
  out.ANTHROPIC_DEFAULT_HAIKU_MODEL = m.haiku ?? m.small ?? m.main;
  return out;
}

const CRED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export class ClaudeAdapter extends JsonHarnessAdapter {
  readonly id = 'claude' as const;
  constructor(o: ClaudeAdapterOptions) { super(o); }

  get dir() { return configDir(this.id, this.o.env); }
  get settingsPath() { return join(this.dir, 'settings.json'); }
  protected configPaths() { return [this.settingsPath]; }

  private async statAny(p: string) { return (await this.o.fs.ops.stat(p).catch(() => null)) !== null; }

  async detect(): Promise<Detection> {
    const d = await detectBasic(this.id, this.o);
    if (this.o.env.env.CLAUDE_CONFIG_DIR) d.notes.push('Using CLAUDE_CONFIG_DIR');
    for (const p of claudeManagedPaths(this.o.env.platform)) {
      if (await this.statAny(p)) d.notes.push(`Managed settings found (${p}); they override user settings (not read or modified)`);
    }
    if (this.o.cwd) {
      for (const f of ['settings.json', 'settings.local.json']) {
        if (await this.statAny(join(this.o.cwd, '.claude', f))) d.notes.push(`Project .claude/${f} found in the current directory; it overrides user settings (not modified)`);
      }
    }
    return d;
  }

  protected desiredFor(p: HarnessProfile): Map<string, Desired> {
    if (!PROFILE_ID_RE.test(p.id)) bad('Invalid profile id');
    if (p.envVar !== undefined && !ENV_RE.test(p.envVar)) bad('Invalid env var name');
    const d: Desired = new Map<string, unknown>([['apiKeyHelper', claudeApiKeyHelper(p, this.o.helperPath, this.o.env.platform)]]);
    for (const [k, v] of Object.entries(claudeEnv(p))) d.set(`env.${k}`, v);
    return new Map([[this.settingsPath, d]]);
  }

  protected collisionSettings(): string[] { return ['apiKeyHelper', 'env.ANTHROPIC_BASE_URL']; }

  /** apiKeyHelper may embed a credential, so the previous value is never stored (detach removes it). */
  protected rememberOriginal(_path: string, setting: string): boolean { return setting !== 'apiKeyHelper'; }

  protected async planWarnings(p: HarnessProfile, files: FilePlan[]): Promise<string[]> {
    const w: string[] = [];
    const e = this.o.env.env;
    for (const v of CRED_ENV) if (e[v]) w.push(`${v} is set in the environment; unset it so Claude Code uses apiKeyHelper`);
    const root = files[0]?.root;
    for (const v of CRED_ENV) if (getPath(root, ['env', v]) !== undefined) w.push(`settings.json env.${v} is set (value not shown); remove it so Claude Code uses apiKeyHelper`);
    const want = claudeEnv(p);
    for (const v of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']) {
      if (e[v] && want[v] && e[v] !== want[v]) w.push(`${v} is exported in the shell with a different value`);
    }
    if (p.keyMode === 'env' && !e[p.envVar ?? 'PA_API_KEY']) w.push(`Env key mode: export ${p.envVar ?? 'PA_API_KEY'} in the shell that starts claude`);
    if (p.keyMode === 'env' && this.o.env.platform === 'win32') w.push('Env key mode on Windows uses "echo %VAR%" (not verified yet)');
    for (const mp of claudeManagedPaths(this.o.env.platform)) if (await this.statAny(mp)) w.push(`Managed settings present (${mp}); they take precedence over these user settings`);
    if (this.o.cwd) {
      for (const f of ['settings.json', 'settings.local.json']) {
        if (await this.statAny(join(this.o.cwd, '.claude', f))) w.push(`Project .claude/${f} may override these user settings`);
      }
    }
    return w;
  }
}
