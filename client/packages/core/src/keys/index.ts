import type { Empty, KeyCreateReq, KeyIdReq, KeySummary, KeyUpdateReq, RevealedKey } from '../contract/ipc.js';
import { notImplemented } from '../stub.js';

/** Full keys stay in core (main process). M1d implements with POST /api/token/:id/key + local cache. */
export interface KeyVault {
  get(id: number): Promise<string | null>;
  set(id: number, secret: string): Promise<void>;
  delete(id: number): Promise<void>;
}
export class MemoryKeyVault implements KeyVault {
  private m = new Map<number, string>();
  async get(id: number) { return this.m.get(id) ?? null; }
  async set(id: number, s: string) { this.m.set(id, s); }
  async delete(id: number) { this.m.delete(id); }
}

/** Adds the sk- prefix used by the relay. */
export const toSk = (raw: string): string => (raw.startsWith('sk-') ? raw : `sk-${raw}`);

export interface KeysModule {
  list(): Promise<KeySummary[]>;
  create(req: KeyCreateReq): Promise<KeySummary>;
  update(req: KeyUpdateReq): Promise<KeySummary>;
  delete(req: KeyIdReq): Promise<Empty>;
  /** Main-process only: full sk for clipboard copy / chat. Never returned over IPC except keys:reveal. */
  secret(id: number): Promise<string>;
  /** Explicit user reveal. */
  reveal(id: number): Promise<RevealedKey>;
}
export const createKeysStub = (): KeysModule => ({
  list: () => notImplemented('keys.list'),
  create: () => notImplemented('keys.create'),
  update: () => notImplemented('keys.update'),
  delete: () => notImplemented('keys.delete'),
  secret: () => notImplemented('keys.secret'),
  reveal: () => notImplemented('keys.reveal'),
});
