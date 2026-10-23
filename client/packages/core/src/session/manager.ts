import { PaException } from '../contract/errors.js';
import type { SessionManager, SessionStatus, SessionView, StoredSession, TokenStore, Unsubscribe } from '../contract/session.js';

export interface Clock { now(): number /* ms */ }
export const systemClock: Clock = { now: () => Date.now() };

export interface RefreshResult { accessToken: string; accessExpiresAt: number; stored: StoredSession }
/** Performs POST /api/user/auth/refresh with the stored cookie. Throws PaException on failure. */
export type Refresher = (stored: StoredSession) => Promise<RefreshResult>;

/** Refresh this many seconds before access_expires_at. */
export const REFRESH_SKEW_S = 60;
/** Don't proactively refresh more often than this (rc.46 may not extend access_expires_at). */
const MIN_PROACTIVE_INTERVAL_MS = 30_000;

export class DefaultSessionManager implements SessionManager {
  private accessToken: string | null = null;
  private accessExpiresAt: number | undefined;
  private stored: StoredSession | null = null;
  private refreshing: Promise<boolean> | null = null;
  private lastRefreshAt = 0;
  private refresher: Refresher | null = null;
  private listeners = new Set<(v: SessionView) => void>();
  private readonly clock: Clock;

  constructor(private readonly opts: { store: TokenStore; serverUrl: string; clock?: Clock }) {
    this.clock = opts.clock ?? systemClock;
  }

  setRefresher(r: Refresher) { this.refresher = r; }
  setServerUrl(url: string) { this.opts.serverUrl = url; }

  view(): SessionView {
    const base = { storage: this.opts.store.kind, serverUrl: this.opts.serverUrl };
    if (!this.stored) return { status: 'anonymous', ...base };
    const status: SessionStatus = this.refreshing ? 'refreshing' : this.accessToken ? 'authenticated' : 'expired';
    return { status, userId: this.stored.userId, username: this.stored.username, accessExpiresAt: this.accessExpiresAt, ...base };
  }

  /** For main-process modules that need the stored cookie (logout). Never expose over IPC. */
  storedSession(): StoredSession | null { return this.stored ? { ...this.stored } : null; }

  private nowS() { return Math.floor(this.clock.now() / 1000); }

  async getAccessToken(): Promise<string> {
    const needs = !this.accessToken || (this.accessExpiresAt !== undefined && this.nowS() >= this.accessExpiresAt - REFRESH_SKEW_S);
    if (needs && this.stored && (!this.accessToken || this.clock.now() - this.lastRefreshAt >= MIN_PROACTIVE_INTERVAL_MS)) {
      await this.refresh();
    }
    if (!this.accessToken) throw new PaException({ code: this.stored ? 'SESSION_EXPIRED' : 'UNAUTHORIZED', message: 'Not logged in' });
    return this.accessToken;
  }

  async onUnauthorized(): Promise<boolean> {
    if (!this.stored) return false;
    this.accessToken = null;
    return this.refresh();
  }

  /** Single-flight refresh. Returns true on success; on failure clears the session. */
  refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const stored = this.stored;
    if (!stored || !this.refresher) return Promise.resolve(false);
    const run = (async () => {
      try {
        const r = await this.refresher!(stored);
        this.lastRefreshAt = this.clock.now();
        this.accessToken = r.accessToken;
        this.accessExpiresAt = r.accessExpiresAt;
        this.stored = r.stored;
        await this.opts.store.save(r.stored);
        return true;
      } catch (e) {
        const code = e instanceof PaException ? e.error.code : 'NETWORK';
        // Network trouble: keep the stored session for a later retry. Auth rejection: drop it.
        if (code === 'UNAUTHORIZED' || code === 'SESSION_EXPIRED' || code === 'SERVER' || code === 'VALIDATION') {
          this.accessToken = null;
          this.accessExpiresAt = undefined;
          this.stored = null;
          await this.opts.store.clear();
        }
        return false;
      } finally {
        this.refreshing = null;
        this.emit();
      }
    })();
    this.refreshing = run;
    this.emit();
    return run;
  }

  async restore(): Promise<SessionView> {
    const s = await this.opts.store.load();
    this.stored = s && s.serverUrl === this.opts.serverUrl ? s : null;
    if (this.stored && this.refresher) await this.refresh();
    this.emit();
    return this.view();
  }

  async establish(input: RefreshResult): Promise<void> {
    this.accessToken = input.accessToken;
    this.accessExpiresAt = input.accessExpiresAt;
    this.stored = input.stored;
    this.lastRefreshAt = this.clock.now();
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
