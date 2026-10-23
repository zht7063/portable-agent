import { PaException, type PaError, type PaErrorCode } from '../contract/errors.js';

export type FetchLike = typeof fetch;

/** Minimal view of the session needed by http (avoids a cycle with SessionManager). */
export interface AuthProvider {
  getAccessToken(): Promise<string>;
  onUnauthorized(): Promise<boolean>;
  transientError?(): PaError | null;
}

export interface HttpClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** new-api wraps most /api/* responses as {success, message, data}. */
export interface NewApiEnvelope<T> { success: boolean; message: string; data?: T }

export type AuthMode = 'none' | 'session' | { sk: string };

export interface RequestOpts {
  body?: unknown;
  auth?: AuthMode;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Do not apply the default timeout (streams). */
  noTimeout?: boolean;
}

export { redact } from '../contract/redact.js';
import { redact } from '../contract/redact.js';

export function codeForStatus(status: number): PaErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'UNAUTHORIZED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400 || status === 422) return 'VALIDATION';
  return 'SERVER';
}

export function unwrap<T>(body: NewApiEnvelope<T>, status: number): T {
  if (!body || body.success !== true) {
    const message = redact(body?.message || 'Request failed');
    const code = /quota|余额|额度/i.test(message) ? 'INSUFFICIENT_QUOTA' : codeForStatus(status >= 400 ? status : 400);
    throw new PaException({ code, message, status });
  }
  return body.data as T;
}

async function errorFromResponse(res: Response): Promise<PaException> {
  let message = `HTTP ${res.status}`;
  try {
    const j = (await res.json()) as { message?: string; error?: { message?: string } };
    message = j?.error?.message || j?.message || message;
  } catch { /* non-JSON */ }
  message = redact(message);
  let code = codeForStatus(res.status);
  if (/quota|余额|额度/i.test(message) && res.status !== 401) code = 'INSUFFICIENT_QUOTA';
  const retry = Number(res.headers.get('retry-after'));
  return new PaException({ code, message, status: res.status, ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}) });
}

export class HttpClient {
  baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private auth: AuthProvider | null = null;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  setAuthProvider(p: AuthProvider) { this.auth = p; }
  get insecure(): boolean { return !this.baseUrl.startsWith('https://'); }
  url(path: string): string { return this.baseUrl + path; }

  /** Low-level request. Handles auth headers, timeout, network errors and one 401 retry for session auth. */
  async send(method: string, path: string, opts: RequestOpts = {}): Promise<Response> {
    const auth = opts.auth ?? 'session';
    const attempt = async (): Promise<Response> => {
      const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      if (auth === 'session') {
        if (!this.auth) throw new PaException({ code: 'UNAUTHORIZED', message: 'No session' });
        headers.Authorization = `Bearer ${await this.auth.getAccessToken()}`;
      } else if (typeof auth === 'object') {
        headers.Authorization = `Bearer ${auth.sk}`;
      }
      const signals = [opts.signal, opts.noTimeout ? undefined : AbortSignal.timeout(this.timeoutMs)].filter(Boolean) as AbortSignal[];
      try {
        return await this.fetchImpl(this.url(path), {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: signals.length ? AbortSignal.any(signals) : undefined,
        });
      } catch (e) {
        // Caller-provided deadline (e.g. chat timeouts) aborts with a PaException reason.
        if (opts.signal?.aborted && opts.signal.reason instanceof PaException) throw opts.signal.reason;
        if (e instanceof PaException) throw e;
        const name = (e as Error)?.name;
        if (name === 'TimeoutError') throw new PaException({ code: 'TIMEOUT', message: 'Request timed out' });
        if (name === 'AbortError') throw new PaException({ code: 'CANCELLED', message: 'Request cancelled' });
        throw new PaException({ code: 'NETWORK', message: 'Network error' });
      }
    };
    let res = await attempt();
    if (res.status === 401 && auth === 'session' && this.auth) {
      if (await this.auth.onUnauthorized()) res = await attempt();
      else {
        // Refresh failed transiently (5xx/network): report that, the session is kept.
        const t = this.auth.transientError?.();
        if (t) throw new PaException(t);
      }
    }
    if (!res.ok) throw await errorFromResponse(res);
    return res;
  }

  /** /api/* call returning the unwrapped `data`. */
  async api<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    const res = await this.send(method, path, opts);
    return unwrap(await res.json() as NewApiEnvelope<T>, res.status);
  }

  /** Raw JSON (relay endpoints, no envelope). */
  async json<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    const res = await this.send(method, path, opts);
    return (await res.json()) as T;
  }
}
