import type { InvokeChannel, InvokeReq, IpcInvokeMap, PaError } from '@pa/core/contract';

/** Unwraps Result<T>; throws PaError for UI catch blocks. */
export async function call<C extends InvokeChannel>(channel: C, req: InvokeReq<C>): Promise<IpcInvokeMap[C]['res']> {
  const r = await window.pa.invoke(channel, req);
  if (!r.ok) throw r.error;
  return r.data;
}
export const errText = (e: unknown) => {
  const p = e as PaError;
  return p?.code ? `${p.code}: ${p.message}${p.retryAfter ? `（${p.retryAfter}s 后重试）` : ''}` : String(e);
};
