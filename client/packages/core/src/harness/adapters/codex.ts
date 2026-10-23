/**
 * Codex adapter, H3 (direct to <serverUrl>/v1, wire_api "responses").
 * Field names verified against openai/codex source (codex-rs model-provider-info + protocol config_types, 2026-10):
 *   model, model_provider                      top-level (only when codex.setDefault === true (opt-in))
 *   [model_providers.<id>] name, base_url, wire_api = "responses"
 *   [model_providers.<id>.auth] command, args  bearer token from a command (timeout_ms 5000 / refresh_interval_ms
 *                                              300000 defaults; cannot be combined with env_key,
 *                                              experimental_bearer_token or requires_openai_auth)
 *   env mode: env_key = "<ENV>" instead of [auth]
 * Never reads auth.json (presence only), never touches the user's login, never writes a key.
 */
import { join } from 'node:path';
import type { Detection, HarnessProfile } from '../../contract/harness.js';
import { configDir } from '../paths.js';
import { PROFILE_ID_RE } from '../state.js';
import { detectBasic } from '../detect.js';
import type { JsonEdit } from '../merge/json.js';
import { getPath } from '../merge/json.js';
import { mergeOwnedToml, parseToml } from '../merge/toml.js';
import { serverBase } from './pi.js';
import { bad, ENV_RE, isAbsPath, JsonHarnessAdapter, PROVIDER_RE, type AdapterOptions, type Desired, type FilePlan } from './base.js';

export type CodexAdapterOptions = AdapterOptions;

export function codexBaseUrl(serverUrl: string): string {
  const b = serverBase(serverUrl);
  return b.endsWith('/v1') ? b : `${b}/v1`;
}

export function codexModel(p: HarnessProfile): string { return p.models.codex ?? p.models.main; }

export function codexProvider(p: HarnessProfile, helperPath: string): Record<string, unknown> {
  const base = { name: 'Portable Agent', base_url: codexBaseUrl(p.serverUrl), wire_api: 'responses' };
  if (p.keyMode === 'command') {
    if (!isAbsPath(helperPath)) bad('Helper path must be absolute');
    // Codex executes the command directly (no shell), so no quoting is involved.
    return { ...base, auth: { command: helperPath, args: [p.id, 'codex'] } };
  }
  if (p.keyMode === 'env') {
    const v = p.envVar ?? 'PA_API_KEY';
    if (!ENV_RE.test(v)) bad('Invalid env var name');
    return { ...base, env_key: v };
  }
  return bad('Plaintext key mode is not supported for Codex (keys are never written to config files)');
}

/** Static check of our provider table (mirrors codex ModelProviderInfo::validate for the auth part). */
export function validateCodexProvider(t: Record<string, unknown>): void {
  const auth = t.auth as { command?: unknown } | undefined;
  if (t.wire_api !== 'responses') bad('wire_api must be "responses"');
  if (auth) {
    if (typeof auth.command !== 'string' || auth.command.trim() === '') bad('auth.command must not be empty');
    const clash = ['env_key', 'experimental_bearer_token', 'requires_openai_auth'].filter((k) => t[k] !== undefined && t[k] !== false);
    if (clash.length) bad(`provider auth cannot be combined with ${clash.join(', ')}`);
  }
}

export class CodexAdapter extends JsonHarnessAdapter {
  readonly id = 'codex' as const;
  constructor(o: CodexAdapterOptions) { super(o); }

  get dir() { return configDir(this.id, this.o.env); }
  get configPath() { return join(this.dir, 'config.toml'); }
  get authPath() { return join(this.dir, 'auth.json'); }
  protected configPaths() { return [this.configPath]; }
  protected parseText(text: string) { return parseToml(text); }
  protected mergeText(text: string, edits: JsonEdit[]) { return mergeOwnedToml(text, edits.map((e) => ({ path: e.path.map(String), value: e.value }))); }

  private async statAny(p: string) { return (await this.o.fs.ops.stat(p).catch(() => null)) !== null; }

  async detect(): Promise<Detection> {
    const d = await detectBasic(this.id, this.o);
    if (this.o.env.env.CODEX_HOME) d.notes.push('Using CODEX_HOME');
    if (await this.exists(this.authPath)) d.notes.push('auth.json exists (not read); switching model_provider to pa does not log you out');
    if (this.o.cwd && (await this.statAny(join(this.o.cwd, '.codex', 'config.toml')))) d.notes.push('Project .codex/config.toml found in the current directory; it may override user settings (not modified)');
    return d;
  }

  private pid(p: HarnessProfile) { return p.providerId ?? 'pa'; }

  protected desiredFor(p: HarnessProfile): Map<string, Desired> {
    if (!PROFILE_ID_RE.test(p.id)) bad('Invalid profile id');
    const pid = this.pid(p);
    if (!PROVIDER_RE.test(pid)) bad('Invalid provider id');
    if (['openai', 'amazon-bedrock', 'amazon-bedrock-runtime', 'gcp', 'ollama', 'ollama-chat', 'lmstudio', 'oss'].includes(pid)) bad('Provider id clashes with a Codex built-in provider');
    const table = codexProvider(p, this.o.helperPath);
    validateCodexProvider(table);
    const d: Desired = new Map();
    if (p.codex?.setDefault === true) { d.set('model', codexModel(p)); d.set('model_provider', pid); }
    d.set(`model_providers.${pid}`, table);
    return new Map([[this.configPath, d]]);
  }

  protected collisionSettings(_path: string, desired: Desired): string[] {
    return [...desired.keys()].filter((k) => k.startsWith('model_providers.'));
  }

  /** model / model_provider are restored on detach; a foreign provider table may hold a bearer token, never stored. */
  protected rememberOriginal(_path: string, setting: string): boolean { return setting === 'model' || setting === 'model_provider'; }

  protected async planWarnings(p: HarnessProfile, files: FilePlan[]): Promise<string[]> {
    const w: string[] = [];
    const root = files[0]?.root ?? {};
    if (await this.exists(this.authPath)) w.push('Codex auth.json exists (not read); your ChatGPT/API login stays as is, only model_provider changes');
    const prof = getPath(root, ['profile']);
    if (typeof prof === 'string') w.push(`config.toml selects profile "${prof}"; its model / model_provider may override ours`);
    if (p.keyMode === 'env' && !this.o.env.env[p.envVar ?? 'PA_API_KEY']) w.push(`Env key mode: export ${p.envVar ?? 'PA_API_KEY'} in the shell that starts codex`);
    if (p.codex?.setDefault !== true) w.push(`Default not changed; run codex -c model_provider=${this.pid(p)} -m ${codexModel(p)}`);
    if (this.o.cwd && (await this.statAny(join(this.o.cwd, '.codex', 'config.toml')))) w.push('Project .codex/config.toml may override these user settings');
    w.push('Requires the server Responses channel (configured on the server, not by this app); check the channel status before use');
    return w;
  }
}
