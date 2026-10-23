import { PaException } from './contract/errors.js';

/** Validates and normalizes a server base URL (http/https origin + optional path, no query/hash/credentials). */
export function normalizeServerUrl(input: string): string {
  const raw = (input ?? '').trim();
  let u: URL;
  try { u = new URL(raw); } catch { throw new PaException({ code: 'VALIDATION', message: 'Invalid server URL' }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new PaException({ code: 'VALIDATION', message: 'Server URL must use http:// or https://' });
  if (u.username || u.password) throw new PaException({ code: 'VALIDATION', message: 'Server URL must not contain credentials' });
  if (u.search || u.hash) throw new PaException({ code: 'VALIDATION', message: 'Server URL must not contain query or fragment' });
  if (!u.hostname) throw new PaException({ code: 'VALIDATION', message: 'Server URL must include a host' });
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

export const MAX_TOKENS_RANGE = { min: 16, max: 32768 } as const;
export function validateMaxTokens(n: unknown): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < MAX_TOKENS_RANGE.min || n > MAX_TOKENS_RANGE.max) {
    throw new PaException({ code: 'VALIDATION', message: `defaultMaxTokens must be an integer ${MAX_TOKENS_RANGE.min}-${MAX_TOKENS_RANGE.max}` });
  }
  return n;
}
