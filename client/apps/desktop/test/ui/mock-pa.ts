import { vi } from 'vitest';
import type { EventChannel, IpcEventMap, PaError } from '@pa/core/contract';

type Handler = (req: any) => unknown | Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
export class PaFail { constructor(readonly error: PaError) {} }
export const fail = (code: PaError['code'], message = 'x', extra: Partial<PaError> = {}) => new PaFail({ code, message, ...extra });

/** Installs a mocked window.pa. Handlers return data, or a PaFail to produce {ok:false}. */
export function mockPa(handlers: Record<string, Handler>) {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const invoke = vi.fn(async (ch: string, req: unknown) => {
    const h = handlers[ch];
    if (!h) return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: ch } };
    const r = await h(req);
    return r instanceof PaFail ? { ok: false, error: r.error } : { ok: true, data: r };
  });
  const on = vi.fn((ch: string, l: (p: unknown) => void) => {
    if (!listeners.has(ch)) listeners.set(ch, new Set());
    listeners.get(ch)!.add(l);
    return () => listeners.get(ch)!.delete(l);
  });
  (window as unknown as { pa: unknown }).pa = { invoke, on };
  const emit = <E extends EventChannel>(ch: E, p: IpcEventMap[E]) => listeners.get(ch)?.forEach((l) => l(p));
  const calls = (ch: string) => invoke.mock.calls.filter((c) => c[0] === ch).map((c) => c[1]);
  return { invoke, emit, calls };
}
