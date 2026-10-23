export const REFRESH_COOKIE = 'new_api_refresh';

/** Extract a cookie value from Set-Cookie headers (Node fetch: headers.getSetCookie()). */
export function readSetCookie(headers: Headers, name = REFRESH_COOKIE): string | null {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : (headers.get('set-cookie') ?? '').split(/,(?=\s*[A-Za-z0-9_]+=)/);
  for (const raw of list) {
    const [pair] = raw.split(';');
    const idx = pair?.indexOf('=') ?? -1;
    if (pair && idx > 0 && pair.slice(0, idx).trim() === name) {
      const v = pair.slice(idx + 1).trim();
      return v || null;
    }
  }
  return null;
}

export const cookieHeader = (value: string, name = REFRESH_COOKIE) => `${name}=${value}`;
