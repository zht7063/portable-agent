/** Error codes shared by core, CLI and the IPC boundary. */
export const PA_ERROR_CODES = [
  'NETWORK',
  'TIMEOUT',
  'UNAUTHORIZED',
  'SESSION_EXPIRED',
  'RATE_LIMITED',
  'SERVER',
  'VALIDATION',
  'INSUFFICIENT_QUOTA',
  'CANCELLED',
  'NOT_IMPLEMENTED',
] as const;

export type PaErrorCode = (typeof PA_ERROR_CODES)[number];

/** Serializable error. `message` must already be redacted. */
export interface PaError {
  code: PaErrorCode;
  message: string;
  /** HTTP status if the error came from new-api. */
  status?: number;
  /** Seconds, for RATE_LIMITED. */
  retryAfter?: number;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: PaError };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const err = (code: PaErrorCode, message: string, extra: Omit<PaError, 'code' | 'message'> = {}): Result<never> => ({
  ok: false,
  error: { code, message, ...extra },
});

export class PaException extends Error {
  constructor(public readonly error: PaError) {
    super(error.message);
    this.name = 'PaException';
  }
}

export function toPaError(e: unknown): PaError {
  if (e instanceof PaException) return e.error;
  if (e instanceof Error && e.name === 'AbortError') return { code: 'CANCELLED', message: 'Request cancelled' };
  return { code: 'SERVER', message: 'Unexpected error' };
}
