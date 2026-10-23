/**
 * Redact credentials and endpoint details from any text destined for UI, CLI output or logs.
 * Pure (no deps) so contract-level helpers like toPaError can use it.
 */
export function redact(text: string): string {
  return String(text)
    // Header/cookie forms first (they may contain the token shapes below).
    .replace(/\b(authorization|x-auth-session)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1: ***')
    .replace(/\b(set-cookie|cookie)\s*[:=]\s*[^\n]+/gi, '$1: ***')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer ***')
    .replace(/\b(new_api_refresh|session|token|access_token|refresh_token|password|key)=([^;&\s"']+)/gi, '$1=***')
    // Token shapes.
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\bnap_[A-Za-z0-9_-]{8,}/g, 'nap_***')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '<jwt>')
    // Endpoints: URLs, IPs, host:port, DNS lookups.
    .replace(/\b(?:https?|wss?|file):\/\/[^\s"'<>)]+/gi, '<url>')
    .replace(/\[[0-9a-f:]{2,}\](?::\d{1,5})?/gi, '<host>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '<host>')
    .replace(/\b(ENOTFOUND|EAI_AGAIN|lookup)\s+[A-Za-z0-9.-]+/g, '$1 <host>')
    .replace(/\b(?:localhost|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):\d{2,5}\b/g, '<host>')
    // Remaining long opaque secrets (hex/base64-ish, >= 32 chars).
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '***');
}
