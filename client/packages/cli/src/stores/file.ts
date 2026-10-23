import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { StoredSession, TokenStore } from '@pa/core';

/** Dev-only plaintext store (mode 0600). Default: ~/.config/portable-agent-cli/session.json */
export class FileTokenStore implements TokenStore {
  readonly kind = 'file' as const;
  constructor(readonly path = join(homedir(), '.config', 'portable-agent-cli', 'session.json')) {}
  async load(): Promise<StoredSession | null> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as StoredSession;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async save(s: StoredSession): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, JSON.stringify(s), { mode: 0o600 });
    await chmod(this.path, 0o600);
  }
  async clear(): Promise<void> { await rm(this.path, { force: true }); }
}
