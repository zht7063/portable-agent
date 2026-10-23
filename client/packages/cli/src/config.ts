import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { normalizeServerUrl } from '@pa/core';

export interface CliConfigData { serverUrl?: string }

/** Dev CLI config: ~/.config/portable-agent-cli/config.json (non-secret). */
export class CliConfig {
  constructor(readonly path = join(homedir(), '.config', 'portable-agent-cli', 'config.json')) {}
  async load(): Promise<CliConfigData> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as CliConfigData;
      return typeof raw.serverUrl === 'string' ? { serverUrl: normalizeServerUrl(raw.serverUrl) } : {};
    } catch { return {}; }
  }
  async save(c: CliConfigData) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, JSON.stringify({ serverUrl: c.serverUrl ? normalizeServerUrl(c.serverUrl) : undefined }), { mode: 0o600 });
  }
  async clear() { await rm(this.path, { force: true }); }
}
