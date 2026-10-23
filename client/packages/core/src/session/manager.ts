import { PaException } from '../contract/errors.js';
import type { SessionManager, SessionView, StoredSession, TokenStore, Unsubscribe } from '../contract/session.js';

export interface Clock { now(): number /* ms */ }
export const systemClock: Clock = { now: () => Date.now() };

/**
 * M0 skeleton: in-memory state + change events. Refresh logic (single-flight, early refresh,
 * cookie rotation) lands in M1a; getAccessToken/onUnauthorized are intentionally minimal.
 */
export class DefaultSessionManager implements SessionManager {
  private accessToken: string | null = null;
  private accessExpiresAt: number | undefined;
  private stored: StoredSession | null = null;
  private listeners = new Set<(v: SessionView) => void>();

  constructor(private readonly opts: { store: TokenStore; serverUrl: string; clock?: Clock }) {}

  view(): SessionView {
    const base = { storage: this.opts.store.kind, serverUrl: this.opts.serverUrl };
    if (!this.stored) return { status: 'anonymous', ...base };
    return {
      status: this.accessToken ? 'authenticated' : 'expired',
      userId: this.stored.userId,
      username: this.stored.username,
      accessExpiresAt: this.accessExpiresAt,
      ...base,
    };
  }

  async getAccessToken(): Promise<string> {
    if (!this.accessToken) throw new PaException({ code: 'UNAUTHORIZED', message: 'Not logged in' });
    return this.accessToken; // TODO(M1a): refresh ~60s before accessExpiresAt
  }

  async onUnauthorized(): Promise<boolean> {
    return false; // TODO(M1a): single-flight refresh via refresh cookie
  }

  async restore(): Promise<SessionView> {
    this.stored = await this.opts.store.load();
    this.emit();
    return this.view();
  }

  async establish(input: { accessToken: string; accessExpiresAt: number; stored: StoredSession }): Promise<void> {
    this.accessToken = input.accessToken;
    this.accessExpiresAt = input.accessExpiresAt;
    this.stored = input.stored;
    await this.opts.store.save(input.stored);
    this.emit();
  }

  async clear(): Promise<void> {
    this.accessToken = null;
    this.accessExpiresAt = undefined;
    this.stored = null;
    await this.opts.store.clear();
    this.emit();
  }

  onChange(listener: (v: SessionView) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    const v = this.view();
    for (const l of this.listeners) l(v);
  }
}
