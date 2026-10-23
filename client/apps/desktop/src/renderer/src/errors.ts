import type { PaError, PaErrorCode } from '@pa/core/contract';

/** Friendly Chinese text for every PaErrorCode (exhaustive: adding a code breaks typecheck). */
export const ERROR_TEXT: Record<PaErrorCode, string> = {
  NETWORK: '无法连接服务器，请检查网络或服务器地址',
  TIMEOUT: '请求超时，请稍后重试',
  UNAUTHORIZED: '用户名或密码错误，或没有权限',
  SESSION_EXPIRED: '登录已过期，请重新登录',
  RATE_LIMITED: '操作太频繁，请稍后再试',
  SERVER: '服务器出错了',
  VALIDATION: '输入有误',
  INSUFFICIENT_QUOTA: '余额不足，请先充值或兑换',
  CANCELLED: '已取消',
  NOT_IMPLEMENTED: '该功能暂未开放',
};

/** Codes where the server/core message adds useful detail. */
const SHOW_DETAIL: ReadonlySet<PaErrorCode> = new Set(['SERVER', 'VALIDATION', 'INSUFFICIENT_QUOTA']);

export function errText(e: unknown): string {
  const p = e as Partial<PaError> | null;
  if (!p || typeof p !== 'object' || !p.code || !(p.code in ERROR_TEXT)) return '发生未知错误';
  let s = ERROR_TEXT[p.code];
  if (p.code === 'RATE_LIMITED' && p.retryAfter) s += `（约 ${Math.ceil(p.retryAfter)} 秒后可重试）`;
  if (SHOW_DETAIL.has(p.code) && p.message) s += `：${p.message}`;
  return `${s} [${p.code}]`;
}
