import { safeStorage } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MemoryTokenStore, type StoredSession, type TokenStore } from '@pa/core';

/** Encrypts StoredSession with Electron safeStorage. Falls back to memory-only if unavailable. */
export class SafeStorageTokenStore implements TokenStore {
  readonly kind = 'safeStorage' as const;
  constructor(private readonly path: string) {}
  async load(): Promise<StoredSession | null> {
    try {
      return JSON.parse(safeStorage.decryptString(await readFile(this.path))) as StoredSession;
    } catch {
      return null;
    }
  }
  async save(s: StoredSession): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, safeStorage.encryptString(JSON.stringify(s)), { mode: 0o600 });
  }
  async clear(): Promise<void> { await rm(this.path, { force: true }); }
}

export function createTokenStore(path: string): TokenStore {
  return safeStorage.isEncryptionAvailable() ? new SafeStorageTokenStore(path) : new MemoryTokenStore();
}
