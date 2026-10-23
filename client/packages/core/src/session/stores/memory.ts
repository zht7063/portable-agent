import type { StoredSession, TokenStore } from '../../contract/session.js';

export class MemoryTokenStore implements TokenStore {
  readonly kind = 'memory' as const;
  private value: StoredSession | null = null;
  async load() { return this.value ? { ...this.value } : null; }
  async save(s: StoredSession) { this.value = { ...s }; }
  async clear() { this.value = null; }
}
