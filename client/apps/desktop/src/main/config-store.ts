import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_MAX_TOKENS, normalizeServerUrl, validateMaxTokens, type ClientConfig, type ConfigSetReq } from '@pa/core';

/** Persisted (non-secret) desktop config: userData/config.json */
export interface PersistedConfig { version: 1; serverUrl: string; defaultMaxTokens: number }

export const toClientConfig = (p: PersistedConfig): ClientConfig => ({
  serverUrl: p.serverUrl,
  defaultMaxTokens: p.defaultMaxTokens,
  insecureTransport: !p.serverUrl.startsWith('https://'),
});

export class ConfigStore {
  constructor(private readonly path: string, private readonly defaultServerUrl: string) {}

  defaults(): PersistedConfig {
    return { version: 1, serverUrl: normalizeServerUrl(this.defaultServerUrl), defaultMaxTokens: DEFAULT_MAX_TOKENS };
  }

  /** Loads config; missing or invalid fields fall back to defaults (file is never trusted blindly). */
  async load(): Promise<PersistedConfig> {
    const d = this.defaults();
    let raw: Partial<PersistedConfig>;
    try { raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<PersistedConfig>; } catch { return d; }
    let serverUrl = d.serverUrl;
    let defaultMaxTokens = d.defaultMaxTokens;
    try { if (typeof raw.serverUrl === 'string') serverUrl = normalizeServerUrl(raw.serverUrl); } catch { /* keep default */ }
    try { if (raw.defaultMaxTokens !== undefined) defaultMaxTokens = validateMaxTokens(raw.defaultMaxTokens); } catch { /* keep default */ }
    return { version: 1, serverUrl, defaultMaxTokens };
  }

  /** Validates a patch against the current config (throws PaException VALIDATION). */
  apply(cur: PersistedConfig, patch: ConfigSetReq): PersistedConfig {
    return {
      version: 1,
      serverUrl: patch.serverUrl !== undefined ? normalizeServerUrl(patch.serverUrl) : cur.serverUrl,
      defaultMaxTokens: patch.defaultMaxTokens !== undefined ? validateMaxTokens(patch.defaultMaxTokens) : cur.defaultMaxTokens,
    };
  }

  /** Atomic write (tmp + rename). */
  async save(c: PersistedConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
