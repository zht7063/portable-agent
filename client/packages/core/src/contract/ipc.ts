/**
 * Module <-> UI contract. Shared by desktop (IPC) and CLI.
 * Rule: no response or event type may contain credentials (tokens, refresh cookie, full sk keys).
 * Single documented exception: `keys:reveal` (explicit user action only), see docs/contracts.md.
 */
import type { Result } from './errors.js';
import type { SessionView } from './session.js';
import type { ApplyResult, HarnessApplyReq, HarnessChannelProbeReq, HarnessChannelStatus, HarnessProfile, HarnessProfileListRes, HarnessDetectRes, HarnessKeyringStatusReq, HarnessPlanReq, HarnessRollbackReq, KeyringStatus, Plan } from './harness.js';

// ---------- DTOs ----------
export interface RegisterReq { username: string; password: string; email?: string; affCode?: string }
export interface LoginReq { username: string; password: string }

export interface Balance { quota: number; usedQuota: number; usd: number; requestCount?: number }
export interface RedeemReq { code: string }
export interface RedeemRes { added: number; quota: number }
export interface TopupInfo { enableRedemption: boolean; paymentComplianceConfirmed: boolean }

export interface ModelInfo { id: string }

export type KeyStatus = 1 | 2 | 3 | 4; // enabled | disabled | expired | exhausted
export interface KeySummary {
  id: number;
  name: string;
  /** Masked form as returned by new-api, e.g. "abcd**********wxyz". */
  maskedKey: string;
  status: KeyStatus;
  remainQuota: number;
  unlimitedQuota: boolean;
  usedQuota: number;
  expiredTime: number; // -1 = never
  createdTime: number;
  group: string;
  /** Whether core holds the full key locally (KeyVault). */
  stored: boolean;
}
export interface KeyCreateReq { name: string; remainQuota?: number; unlimitedQuota?: boolean; expiredTime?: number; group?: string }
export interface KeyUpdateReq { id: number; name?: string; status?: KeyStatus; remainQuota?: number; unlimitedQuota?: boolean; expiredTime?: number }
export interface KeyIdReq { id: number }
/** Only for keys:reveal with explicit user confirmation. */
export interface KeyRevealReq { id: number; confirm: true }
export interface RevealedKey { id: number; secret: string }

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage { role: ChatRole; content: string }
export interface ChatReq {
  model: string;
  messages: ChatMessage[];
  /** Default 2048 (deepseek-flash spends tokens on reasoning first). */
  maxTokens?: number;
  /** Key id from keys module; core resolves the full sk in main. */
  keyId?: number;
  temperature?: number;
}
export interface Usage { promptTokens: number; completionTokens: number; totalTokens: number }
export type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
export interface ChatRes {
  content: string;
  reasoning?: string;
  finishReason: FinishReason;
  usage?: Usage;
  /** Set when finishReason=length and content is empty. */
  warning?: 'TRUNCATED_EMPTY_CONTENT';
}
export interface ChatStreamStartReq extends ChatReq { reqId: string }
export interface ChatStreamCancelReq { reqId: string }

export interface ClientConfig { serverUrl: string; defaultMaxTokens: number; insecureTransport: boolean }
export interface ConfigSetReq { serverUrl?: string; defaultMaxTokens?: number }

export type Empty = Record<string, never>;

// ---------- Invoke channels (renderer -> main, request/response) ----------
export interface IpcInvokeMap {
  'auth:register': { req: RegisterReq; res: Empty };
  'auth:login': { req: LoginReq; res: SessionView };
  'auth:logout': { req: Empty; res: SessionView };
  'auth:session': { req: Empty; res: SessionView };
  'billing:balance': { req: Empty; res: Balance };
  'billing:topupInfo': { req: Empty; res: TopupInfo };
  'billing:redeem': { req: RedeemReq; res: RedeemRes };
  'models:list': { req: Empty; res: ModelInfo[] };
  'keys:list': { req: Empty; res: KeySummary[] };
  'keys:create': { req: KeyCreateReq; res: KeySummary };
  'keys:update': { req: KeyUpdateReq; res: KeySummary };
  'keys:delete': { req: KeyIdReq; res: Empty };
  /** Copies the full key to the clipboard inside main; nothing secret returned. Preferred. */
  'keys:copy': { req: KeyIdReq; res: Empty };
  /** EXCEPTION: returns the full key to the UI, only on explicit user reveal action. */
  'keys:reveal': { req: KeyRevealReq; res: RevealedKey };
  'chat:complete': { req: ChatReq; res: ChatRes };
  'chat:stream:start': { req: ChatStreamStartReq; res: { reqId: string } };
  'chat:stream:cancel': { req: ChatStreamCancelReq; res: Empty };
  'config:get': { req: Empty; res: ClientConfig };
  'config:set': { req: ConfigSetReq; res: ClientConfig };
  'harness:detect': { req: Empty; res: HarnessDetectRes };
  /** Masked diff only. */
  'harness:plan': { req: HarnessPlanReq; res: Plan };
  /** Requires confirm: true. */
  'harness:apply': { req: HarnessApplyReq; res: ApplyResult };
  /** Requires confirm: true. */
  'harness:rollback': { req: HarnessRollbackReq; res: ApplyResult };
  /** Entry presence only, never key values. */
  'harness:keyring:status': { req: HarnessKeyringStatusReq; res: KeyringStatus };
  /** Profiles are the client SSOT (no secrets: keyId only). */
  'harness:profile:list': { req: Empty; res: HarnessProfileListRes };
  'harness:profile:upsert': { req: HarnessProfile; res: HarnessProfile };
  /** Read-only server channel probe for Codex (GET /v1/models with the profile key, inside main). */
  'harness:channel:probe': { req: HarnessChannelProbeReq; res: HarnessChannelStatus };
}
export type InvokeChannel = keyof IpcInvokeMap;
export type InvokeReq<C extends InvokeChannel> = IpcInvokeMap[C]['req'];
export type InvokeRes<C extends InvokeChannel> = Result<IpcInvokeMap[C]['res']>;

/** Channels allowed to return credential material (allowlist, reviewed). */
/** Channels that mutate user files and require `confirm: true` in the request. */
export const CONFIRM_REQUIRED_CHANNELS = ['keys:reveal', 'harness:apply', 'harness:rollback'] as const;

export const CREDENTIAL_EXCEPTION_CHANNELS = ['keys:reveal'] as const;

export const INVOKE_CHANNELS = [
  'auth:register', 'auth:login', 'auth:logout', 'auth:session',
  'billing:balance', 'billing:topupInfo', 'billing:redeem',
  'models:list',
  'keys:list', 'keys:create', 'keys:update', 'keys:delete', 'keys:copy', 'keys:reveal',
  'chat:complete', 'chat:stream:start', 'chat:stream:cancel',
  'config:get', 'config:set',
  'harness:detect', 'harness:plan', 'harness:apply', 'harness:rollback', 'harness:keyring:status', 'harness:profile:list', 'harness:profile:upsert', 'harness:channel:probe',
] as const satisfies readonly InvokeChannel[];

// ---------- Events (main -> renderer) ----------
export type ChatStreamEvent =
  | { reqId: string; type: 'reasoning'; delta: string }
  | { reqId: string; type: 'content'; delta: string }
  | { reqId: string; type: 'usage'; usage: Usage }
  | { reqId: string; type: 'done'; finishReason: FinishReason; warning?: 'TRUNCATED_EMPTY_CONTENT' }
  | { reqId: string; type: 'error'; error: import('./errors.js').PaError };

export interface IpcEventMap {
  'session:changed': SessionView;
  'chat:stream:event': ChatStreamEvent;
}
export type EventChannel = keyof IpcEventMap;
export const EVENT_CHANNELS = ['session:changed', 'chat:stream:event'] as const satisfies readonly EventChannel[];

/** Shape exposed on window.pa by the preload script. */
export interface PaBridge {
  invoke<C extends InvokeChannel>(channel: C, req: InvokeReq<C>): Promise<InvokeRes<C>>;
  on<E extends EventChannel>(channel: E, listener: (payload: IpcEventMap[E]) => void): () => void;
}
