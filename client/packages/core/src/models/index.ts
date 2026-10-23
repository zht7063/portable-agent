import type { ModelInfo } from '../contract/ipc.js';
import { notImplemented } from '../stub.js';

/** M1c: /api/user/models (session) or /v1/models (sk). */
export interface ModelsModule { list(): Promise<ModelInfo[]> }
export const createModelsStub = (): ModelsModule => ({ list: () => notImplemented('models.list') });
