import type { ModelInfo } from '../contract/ipc.js';
import type { HttpClient } from '../http/client.js';

export interface ModelsModule {
  /** Session-scoped list (/api/user/models). */
  list(): Promise<ModelInfo[]>;
  /** Relay list with an sk key (/v1/models). */
  listWithKey(sk: string): Promise<ModelInfo[]>;
}

export function createModels(http: HttpClient): ModelsModule {
  return {
    async list() {
      const d = await http.api<string[]>('GET', '/api/user/models');
      return (d ?? []).map((id) => ({ id }));
    },
    async listWithKey(sk) {
      const d = await http.json<{ data?: { id: string }[] }>('GET', '/v1/models', { auth: { sk } });
      return (d.data ?? []).map((m) => ({ id: m.id }));
    },
  };
}
