/**
 * Pi (pi-coding-agent) adapter, H1.
 * Owned settings (verified against pi docs, 2026-10):
 *   models.json   providers.<providerId>            (whole object)
 *   settings.json defaultProvider, defaultModel      (only when profile.pi.setDefault !== false)
 * Never reads auth.json (presence only). Never writes a key: apiKey is "!<pa-key> <profile> pi" (command)
 * or "$<ENV>" (env). plaintext is refused (D2 open).
 * Only api "openai-completions" is offered; "anthropic-messages" stays hidden until verified against real Pi.
 */
import { join } from 'node:path';
import type { Detection, HarnessProfile } from '../../contract/harness.js';
import { configDir } from '../paths.js';
import { PROFILE_ID_RE } from '../state.js';
import { detectBasic } from '../detect.js';
import { bad, dotted, ENV_RE, helperCommand, JsonHarnessAdapter, PROVIDER_RE, type AdapterOptions, type Desired } from './base.js';

export type PiAdapterOptions = AdapterOptions;

export function piApiKeyValue(p: HarnessProfile, helperPath: string, platform: NodeJS.Platform): string {
  if (p.keyMode === 'command') return `!${helperCommand(helperPath, p.id, 'pi', platform)}`;
  if (p.keyMode === 'env') return `$${p.envVar ?? 'PA_API_KEY'}`;
  return bad('Plaintext key mode is not supported for Pi (keys are never written to config files)');
}

export function serverBase(serverUrl: string): string {
  let u: URL;
  try { u = new URL(serverUrl); } catch { return bad('Invalid server URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') bad('Server URL must be http(s)');
  if (u.username || u.password || u.search || u.hash) bad('Server URL must not contain credentials, query or fragment');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** openai-completions appends /chat/completions, so the base ends in /v1. */
export function piBaseUrl(serverUrl: string): string {
  const base = serverBase(serverUrl);
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

export function piProviderConfig(p: HarnessProfile, helperPath: string, platform: NodeJS.Platform) {
  const api = p.pi?.api ?? 'openai-completions';
  if (api !== 'openai-completions') bad('Unsupported Pi api (only openai-completions is available)');
  const ids = [...new Set((p.pi?.models?.length ? p.pi.models : [p.models.main, p.models.small]).filter((m): m is string => !!m && m.trim() !== ''))];
  if (!ids.length) bad('Profile has no models');
  const reasoning = new Set(p.pi?.reasoning ?? []);
  return {
    baseUrl: piBaseUrl(p.serverUrl),
    api,
    apiKey: piApiKeyValue(p, helperPath, platform),
    models: ids.map((id) => (reasoning.has(id) ? { id, reasoning: true } : { id })),
  };
}

export class PiAdapter extends JsonHarnessAdapter {
  readonly id = 'pi' as const;
  constructor(o: PiAdapterOptions) { super(o); }

  get dir() { return configDir(this.id, this.o.env); }
  get modelsPath() { return join(this.dir, 'models.json'); }
  get settingsPath() { return join(this.dir, 'settings.json'); }
  get authPath() { return join(this.dir, 'auth.json'); }
  protected configPaths() { return [this.modelsPath, this.settingsPath]; }

  async detect(): Promise<Detection> {
    const d = await detectBasic(this.id, this.o);
    if (this.o.env.env.PI_CODING_AGENT_DIR) d.notes.push('Using PI_CODING_AGENT_DIR');
    if (await this.exists(this.authPath)) d.notes.push('auth.json exists: credentials stored there for the same provider take precedence over models.json (not read)');
    if (this.o.cwd && (await this.o.fs.ops.stat(join(this.o.cwd, '.pi')).catch(() => null))) d.notes.push('Project-level .pi/ found in the current directory; it may override user settings (not modified)');
    return d;
  }

  protected desiredFor(p: HarnessProfile): Map<string, Desired> {
    if (!PROFILE_ID_RE.test(p.id)) bad('Invalid profile id');
    const pid = p.providerId ?? 'pa';
    if (!PROVIDER_RE.test(pid)) bad('Invalid provider id');
    if (p.envVar !== undefined && !ENV_RE.test(p.envVar)) bad('Invalid env var name');
    const models: Desired = new Map([[dotted(['providers', pid]), piProviderConfig(p, this.o.helperPath, this.o.env.platform)]]);
    const settings: Desired = new Map();
    if (p.pi?.setDefault !== false) { settings.set('defaultProvider', pid); settings.set('defaultModel', p.models.main); }
    return new Map([[this.modelsPath, models], [this.settingsPath, settings]]);
  }

  protected collisionSettings(path: string, desired: Desired): string[] {
    return path === this.modelsPath ? [...desired.keys()] : [];
  }

  protected rememberOriginal(path: string): boolean { return path === this.settingsPath; }

  protected async planWarnings(profile: HarnessProfile): Promise<string[]> {
    const w: string[] = [];
    if (await this.exists(this.authPath)) w.push(`Pi auth.json exists; if it holds a credential for provider "${profile.providerId ?? 'pa'}" it overrides models.json (auth.json is not read)`);
    if (profile.keyMode === 'env' && !this.o.env.env[profile.envVar ?? 'PA_API_KEY']) w.push(`Env key mode: export ${profile.envVar ?? 'PA_API_KEY'} in the shell that starts pi`);
    if (profile.pi?.setDefault === false) w.push(`Default model not changed; in Pi run /model and pick ${profile.providerId ?? 'pa'}/${profile.models.main}`);
    return w;
  }
}
