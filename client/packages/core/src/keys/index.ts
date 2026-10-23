import { PaException } from '../contract/errors.js';
import type { Empty, KeyCreateReq, KeyIdReq, KeyStatus, KeySummary, KeyUpdateReq, RevealedKey } from '../contract/ipc.js';
import type { HttpClient } from '../http/client.js';

/** Full keys stay in core (main process). */
export interface KeyVault {
  get(id: number): Promise<string | null>;
  set(id: number, secret: string): Promise<void>;
  delete(id: number): Promise<void>;
  has(id: number): Promise<boolean>;
}
export class MemoryKeyVault implements KeyVault {
  private m = new Map<number, string>();
  async get(id: number) { return this.m.get(id) ?? null; }
  async set(id: number, s: string) { this.m.set(id, s); }
  async delete(id: number) { this.m.delete(id); }
  async has(id: number) { return this.m.has(id); }
}

/** Adds the sk- prefix used by the relay. */
export const toSk = (raw: string): string => (raw.startsWith('sk-') ? raw : `sk-${raw}`);

export interface KeysModule {
  list(): Promise<KeySummary[]>;
  create(req: KeyCreateReq): Promise<KeySummary>;
  update(req: KeyUpdateReq): Promise<KeySummary>;
  delete(req: KeyIdReq): Promise<Empty>;
  /** Main-process only: full sk (cached; POST /api/token/:id/key is rate-limited). */
  secret(id: number): Promise<string>;
  /** Explicit user reveal (keys:reveal). */
  reveal(id: number): Promise<RevealedKey>;
}

/** Raw token object from /api/token (key is masked). */
interface RawToken {
  id: number; name: string; key: string; status: number; remain_quota: number; unlimited_quota: boolean;
  used_quota: number; expired_time: number; created_time: number; group: string;
  [k: string]: unknown;
}

export function createKeys(http: HttpClient, vault: KeyVault = new MemoryKeyVault()): KeysModule {
  const summarize = async (t: RawToken): Promise<KeySummary> => ({
    id: t.id,
    name: t.name,
    maskedKey: t.key,
    status: t.status as KeyStatus,
    remainQuota: t.remain_quota,
    unlimitedQuota: t.unlimited_quota,
    usedQuota: t.used_quota,
    expiredTime: t.expired_time,
    createdTime: t.created_time,
    group: t.group ?? '',
    stored: await vault.has(t.id),
  });
  const rawList = async (): Promise<RawToken[]> => {
    const d = await http.api<{ items?: RawToken[] } | RawToken[]>('GET', '/api/token/?p=1&page_size=100');
    return Array.isArray(d) ? d : (d?.items ?? []);
  };
  const find = async (id: number) => {
    const t = (await rawList()).find((x) => x.id === id);
    if (!t) throw new PaException({ code: 'VALIDATION', message: `Key ${id} not found` });
    return t;
  };
  const secret = async (id: number) => {
    const cached = await vault.get(id);
    if (cached) return cached;
    const d = await http.api<{ key: string }>('POST', `/api/token/${id}/key`);
    if (!d?.key) throw new PaException({ code: 'SERVER', message: 'Server returned no key' });
    const sk = toSk(d.key);
    await vault.set(id, sk);
    return sk;
  };

  return {
    async list() { return Promise.all((await rawList()).map(summarize)); },
    async create({ name, remainQuota = 0, unlimitedQuota = true, expiredTime = -1, group = '' }) {
      if (!name.trim()) throw new PaException({ code: 'VALIDATION', message: 'Name required' });
      const before = new Set((await rawList()).map((t) => t.id));
      await http.api('POST', '/api/token/', { body: { name, remain_quota: remainQuota, unlimited_quota: unlimitedQuota, expired_time: expiredTime, group } });
      // Create returns no key/id: locate the new item, then reveal & cache the full key once.
      const created = (await rawList()).filter((t) => !before.has(t.id) && t.name === name).sort((a, b) => b.id - a.id)[0];
      if (!created) throw new PaException({ code: 'SERVER', message: 'Created key not found in list' });
      await secret(created.id);
      return summarize(created);
    },
    async update({ id, name, status, remainQuota, unlimitedQuota, expiredTime }) {
      let cur = await find(id);
      // new-api ignores `status` on a full PUT; status changes need ?status_only=true.
      if (status !== undefined && status !== cur.status) {
        const r = await http.api<RawToken>('PUT', '/api/token/?status_only=true', { body: { id, status } });
        cur = r && typeof r === 'object' && 'id' in r ? r : { ...cur, status };
      }
      const fieldsChanged = [name, remainQuota, unlimitedQuota, expiredTime].some((v) => v !== undefined);
      if (!fieldsChanged) return summarize(cur);
      const body = {
        ...cur,
        ...(name !== undefined ? { name } : {}),
        ...(remainQuota !== undefined ? { remain_quota: remainQuota } : {}),
        ...(unlimitedQuota !== undefined ? { unlimited_quota: unlimitedQuota } : {}),
        ...(expiredTime !== undefined ? { expired_time: expiredTime } : {}),
      };
      delete (body as Record<string, unknown>).key; // never send the masked key back
      const updated = await http.api<RawToken>('PUT', '/api/token/', { body });
      return summarize(updated ?? { ...cur, ...body, key: cur.key });
    },
    async delete({ id }) {
      await http.api('DELETE', `/api/token/${id}`);
      await vault.delete(id);
      return {};
    },
    secret,
    async reveal(id) { return { id, secret: await secret(id) }; },
  };
}
