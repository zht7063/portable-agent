import { PaException } from '../contract/errors.js';
import type { Empty, LoginReq, RegisterReq } from '../contract/ipc.js';
import type { SessionView, StoredSession } from '../contract/session.js';
import type { HttpClient, NewApiEnvelope } from '../http/client.js';
import { unwrap } from '../http/client.js';
import { cookieHeader, readSetCookie } from '../session/cookie.js';
import type { DefaultSessionManager, RefreshResult } from '../session/manager.js';

/** Shape of data in login/refresh responses (rc.46, verified on rain). */
interface LoginData {
  access_token?: string;
  token_type?: string;
  access_expires_at?: number;
  session?: { sid?: string; expires_at?: number };
  user?: { id: number; username: string };
}

export interface AuthModule {
  register(req: RegisterReq): Promise<Empty>;
  login(req: LoginReq): Promise<SessionView>;
  /** Exposed for CLI/tests; normal flow refreshes automatically. */
  refresh(): Promise<SessionView>;
  logout(): Promise<SessionView>;
}

function validateCreds(username: string, password: string) {
  if (!username || username.length > 20) throw new PaException({ code: 'VALIDATION', message: 'Username must be 1-20 characters' });
  if (password.length < 8 || password.length > 128) throw new PaException({ code: 'VALIDATION', message: 'Password must be 8-128 characters' });
}

export function createAuth(http: HttpClient, session: DefaultSessionManager): AuthModule {
  const toResult = (data: LoginData, cookie: string | null, prev?: StoredSession): RefreshResult => {
    if (!data?.access_token || !data.access_expires_at) {
      throw new PaException({ code: 'VALIDATION', message: 'Additional verification required (2FA/challenge not supported in prototype)' });
    }
    const refreshCookie = cookie ?? prev?.refreshCookie;
    if (!refreshCookie) throw new PaException({ code: 'SERVER', message: 'Server did not set refresh cookie' });
    const user = data.user ?? (prev ? { id: prev.userId, username: prev.username } : undefined);
    if (!user) throw new PaException({ code: 'SERVER', message: 'Missing user in login response' });
    return {
      accessToken: data.access_token,
      accessExpiresAt: data.access_expires_at,
      stored: {
        serverUrl: http.baseUrl,
        refreshCookie,
        sid: data.session?.sid ?? prev?.sid,
        userId: user.id,
        username: user.username,
        sessionExpiresAt: data.session?.expires_at ?? prev?.sessionExpiresAt,
      },
    };
  };

  session.setRefresher(async (stored) => {
    const headers: Record<string, string> = { Cookie: cookieHeader(stored.refreshCookie) };
    if (stored.sid) headers['X-Auth-Session'] = stored.sid;
    const res = await http.send('POST', '/api/user/auth/refresh', { auth: 'none', headers });
    const data = unwrap(await res.json() as NewApiEnvelope<LoginData>, res.status);
    return toResult(data, readSetCookie(res.headers), stored);
  });

  return {
    async register({ username, password, email, affCode }) {
      validateCreds(username, password);
      await http.api('POST', '/api/user/register', {
        auth: 'none',
        body: { username, password, ...(email ? { email } : {}), ...(affCode ? { aff_code: affCode } : {}) },
      });
      return {};
    },
    async login({ username, password }) {
      validateCreds(username, password);
      const res = await http.send('POST', '/api/user/login', { auth: 'none', body: { username, password } });
      const data = unwrap(await res.json() as NewApiEnvelope<LoginData>, res.status);
      await session.establish(toResult(data, readSetCookie(res.headers)));
      return session.view();
    },
    async refresh() {
      if (!(await session.refresh())) {
        const t = session.transientError?.();
        throw new PaException(t ?? { code: 'SESSION_EXPIRED', message: 'Session expired, please log in again' });
      }
      return session.view();
    },
    async logout() {
      const stored = session.storedSession();
      if (stored) {
        try {
          let token: string | undefined;
          try { token = await session.getAccessToken(); } catch { /* cookie-only logout */ }
          await http.send('POST', '/api/user/auth/logout', {
            auth: 'none',
            headers: { Cookie: cookieHeader(stored.refreshCookie), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          });
        } catch { /* best effort: always clear locally */ }
      }
      await session.clear();
      return session.view();
    },
  };
}
