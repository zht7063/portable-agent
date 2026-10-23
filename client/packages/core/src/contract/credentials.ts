/** Field names that must never appear in UI-bound payloads (case-insensitive match on normalized name). */
export const FORBIDDEN_FIELD_NAMES = [
  'accesstoken', 'refreshtoken', 'refreshcookie', 'cookie', 'setcookie', 'jwt', 'token',
  'authorization', 'bearer', 'key', 'apikey', 'fullkey', 'secret', 'password', 'proof', 'prooftoken',
] as const;

/** Type-level list (camelCase spellings used in this codebase). */
export type ForbiddenField =
  | 'accessToken' | 'access_token' | 'refreshToken' | 'refreshCookie' | 'cookie' | 'setCookie'
  | 'jwt' | 'token' | 'authorization' | 'bearer' | 'key' | 'apiKey' | 'fullKey' | 'secret'
  | 'password' | 'proof' | 'proofToken';

const normalize = (k: string) => k.replace(/[_-]/g, '').toLowerCase();
const forbidden = new Set<string>(FORBIDDEN_FIELD_NAMES);
const SECRET_VALUE = /(^|\s)(sk-[A-Za-z0-9]{16,}|nap_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/;

/** Returns offending paths (empty = clean). Checks field names and secret-looking string values. */
export function findCredentialLeaks(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') return SECRET_VALUE.test(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findCredentialLeaks(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      forbidden.has(normalize(k)) ? [`${path}.${k}`] : findCredentialLeaks(v, `${path}.${k}`),
    );
  }
  return [];
}
