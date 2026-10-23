/**
 * Session / auth-state interface.
 * Credentials (access JWT, refresh cookie) live only inside core (in the Electron main process).
 * The UI only ever sees `SessionView`.
 */

export type SessionStatus = 'anonymous' | 'authenticated' | 'refreshing' | 'expired';
export type StorageKind = 'memory' | 'file' | 'safeStorage';

/** What gets persisted by a TokenStore. Never crosses IPC. The access JWT is NOT persisted. */
export interface StoredSession {
  serverUrl: string;
  /** Raw value of the `new_api_refresh` cookie (rotated on every refresh). */
  refreshCookie: string;
  sid?: string;
  userId: number;
  username: string;
  /** Unix seconds; session lifetime (~30 days). */
  sessionExpiresAt?: number;
}

/** Pluggable persistence. core ships MemoryTokenStore; CLI uses a file store; desktop injects a safeStorage store. */
export interface TokenStore {
  readonly kind: StorageKind;
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

/** Redacted, UI-safe view of the session. */
export interface SessionView {
  status: SessionStatus;
  userId?: number;
  username?: string;
  /** Unix seconds. */
  accessExpiresAt?: number;
  storage: StorageKind;
  serverUrl: string;
}

export type Unsubscribe = () => void;

/** Implemented by core/session/manager (M1a). M0 ships the interface + a stub. */
export interface SessionManager {
  view(): SessionView;
  /** Returns a valid access token, refreshing ~60s before expiry; concurrent callers share one refresh. */
  getAccessToken(): Promise<string>;
  /** Called by http on 401: refresh once, returns true if the caller should retry. */
  onUnauthorized(): Promise<boolean>;
  /** Restore from TokenStore on startup. */
  restore(): Promise<SessionView>;
  /** Install a new session from a login/refresh response (cookie already parsed). */
  establish(input: { accessToken: string; accessExpiresAt: number; stored: StoredSession }): Promise<void>;
  clear(): Promise<void>;
  onChange(listener: (view: SessionView) => void): Unsubscribe;
}
