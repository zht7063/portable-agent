import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { KeyVault, StoredSession, TokenStore } from '@pa/core';

const DIR = join(homedir(), '.config', 'portable-agent-cli');

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
async function writeJson(path: string, v: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(v), { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Dev-only plaintext store (mode 0600). Default: ~/.config/portable-agent-cli/session.json */
export class FileTokenStore implements TokenStore {
  readonly kind = 'file' as const;
  constructor(readonly path = join(DIR, 'session.json')) {}
  load() { return readJson<StoredSession>(this.path); }
  save(s: StoredSession) { return writeJson(this.path, s); }
  async clear() { await rm(this.path, { force: true }); }
}

/** Dev-only plaintext key cache (mode 0600) so the rate-limited reveal isn't repeated per CLI run. */
export class FileKeyVault implements KeyVault {
  constructor(readonly path = join(DIR, 'keys.json')) {}
  private async all() { return (await readJson<Record<string, string>>(this.path)) ?? {}; }
  async get(id: number) { return (await this.all())[id] ?? null; }
  async has(id: number) { return (await this.get(id)) !== null; }
  async set(id: number, s: string) { const a = await this.all(); a[id] = s; await writeJson(this.path, a); }
  async delete(id: number) { const a = await this.all(); delete a[id]; await writeJson(this.path, a); }
  async clear() { await rm(this.path, { force: true }); }
}
