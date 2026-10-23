import { PaException } from '../contract/errors.js';

export type FetchLike = typeof fetch;

export interface HttpClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** new-api wraps most /api/* responses as {success, message, data}. */
export interface NewApiEnvelope<T> { success: boolean; message: string; data?: T }

export function unwrap<T>(body: NewApiEnvelope<T>, status: number): T {
  if (!body.success) throw new PaException({ code: status === 401 ? 'UNAUTHORIZED' : 'SERVER', message: redact(body.message || 'Request failed'), status });
  return body.data as T;
}

/** Redact credential-looking substrings from text destined for logs/UI. */
export function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-***')
    .replace(/nap_[A-Za-z0-9]{8,}/g, 'nap_***')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>')
    .replace(/(new_api_refresh=)[^;\s]+/g, '$1***');
}

/** M0: thin wrapper; auth header injection + 401 retry hook land in M1a. */
export class HttpClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
  }
  get insecure(): boolean { return !this.baseUrl.startsWith('https://'); }
  url(path: string): string { return this.baseUrl + path; }
  raw(path: string, init?: RequestInit): Promise<Response> { return this.fetchImpl(this.url(path), init); }
}
