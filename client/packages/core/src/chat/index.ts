import type { ChatReq, ChatRes, ChatStreamEvent } from '../contract/ipc.js';
import { notImplemented } from '../stub.js';

/** deepseek-flash reasons first; small max_tokens yields empty content + finish_reason=length. */
export const DEFAULT_MAX_TOKENS = 2048;

/** M1e: POST /v1/chat/completions (non-stream + SSE). Handles reasoning_content. */
export interface ChatModule {
  complete(req: ChatReq, signal?: AbortSignal): Promise<ChatRes>;
  stream(req: ChatReq & { reqId: string }, emit: (e: ChatStreamEvent) => void, signal?: AbortSignal): Promise<void>;
}
export const createChatStub = (): ChatModule => ({
  complete: () => notImplemented('chat.complete'),
  stream: () => notImplemented('chat.stream'),
});
