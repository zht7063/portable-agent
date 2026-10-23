/**
 * Harness (Pi / Claude Code / Codex) contract types. Pure types + constants, renderer-safe.
 * Rule (same as ipc.ts): nothing here ever carries a key value. Diffs carry masked values only.
 */

export const HARNESS_IDS = ['pi', 'claude', 'codex'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
export const isHarnessId = (v: unknown): v is HarnessId => typeof v === 'string' && (HARNESS_IDS as readonly string[]).includes(v);

/**
 * command  = harness runs `pa-key <profileId> <harness>` (default, no key on disk)
 * env      = config references an env var the user exports themselves
 * plaintext= key written into the harness config (explicit opt-in only; not offered by H0)
 */
export type KeyMode = 'command' | 'env' | 'plaintext';

export interface ModelMapping { main: string; small?: string; opus?: string; sonnet?: string; haiku?: string; codex?: string }

export interface HarnessProfile {
  /** [A-Za-z0-9_-]{1,64}; also the keychain account prefix. */
  id: string;
  serverUrl: string;
  /** new-api key id (resolved to the secret in main only). */
  keyId: number;
  models: ModelMapping;
  keyMode: KeyMode;
  /** Provider id written into harness configs (default "pa"). */
  providerId?: string;
  /** Env var name referenced in keyMode "env" (default PA_API_KEY). */
  envVar?: string;
  pi?: PiOptions;
  claude?: ClaudeOptions;
}

/** 'anthropic-messages' is intentionally not offered until verified against real Pi. */
export type PiApi = 'openai-completions';
export interface PiOptions {
  /** Default openai-completions (/v1/chat/completions). */
  api?: PiApi;
  /** Model ids listed under the provider (default: models.main + models.small). */
  models?: string[];
  /** Model ids flagged `reasoning: true`. */
  reasoning?: string[];
  /** Write settings.json defaultProvider/defaultModel (default true). */
  setDefault?: boolean;
}

export interface ClaudeOptions {
  /** Write env.ANTHROPIC_MODEL = models.main (default true). When false only the opus/sonnet/haiku aliases are mapped. */
  setModel?: boolean;
}

export interface FileFingerprint { sha256: string; mtimeMs: number; size: number }

export interface Detection {
  id: HarnessId;
  installed: boolean;
  version?: string;
  configDir: string;
  /** Relevant files and whether they exist (paths only, never contents). */
  files: { path: string; exists: boolean }[];
  /** Human-readable notes (project-level / managed overrides etc.). */
  notes: string[];
}

export interface LiveSnapshot {
  id: HarnessId;
  files: { path: string; fingerprint: FileFingerprint | null; ownedValuesHash: string | null }[];
  /** Owned keys -> masked current value. */
  owned: Record<string, string | null>;
}

export type ChangeKind = 'create' | 'modify' | 'remove' | 'unchanged';
export interface PlannedKeyChange { file: string; /** Dotted path of the managed setting (never named "key": the leak guard forbids that field). */ setting: string; kind: ChangeKind; before: string | null; after: string | null }

export type ConflictKind = 'external-owned-change' | 'name-collision' | 'env-override' | 'unknown-version';
export interface Conflict { id: string; kind: ConflictKind; file?: string; setting?: string; message: string; lastWritten?: string | null; current?: string | null; proposed?: string | null }
export type ConflictResolution = 'overwrite' | 'keep-external' | 'cancel';
export interface ConflictAck { conflictId: string; resolution: ConflictResolution }

export interface Plan {
  id: HarnessId;
  profileId: string;
  createdAt: string;
  /** Fingerprints read at plan time; apply aborts if any differs (TOCTOU guard). */
  baseFingerprints: Record<string, FileFingerprint | null>;
  changes: PlannedKeyChange[];
  conflicts: Conflict[];
  warnings: string[];
  /** Notice when the file changed outside our managed keys (merge allowed). */
  externalUnownedChange: string[];
}

export interface ApplyResult { id: HarnessId; written: string[]; snapshotId?: string; warnings: string[] }
/** detach = remove only our managed settings (restoring the user's previous defaults); files stay. */
export type RollbackTarget = 'last' | 'first-write' | 'detach' | { snapshotId: string };

export interface HarnessAdapter {
  id: HarnessId;
  detect(): Promise<Detection>;
  read(): Promise<LiveSnapshot>;
  plan(profile: HarnessProfile): Promise<Plan>;
  apply(plan: Plan, opts: { acknowledge: ConflictAck[] }): Promise<ApplyResult>;
  rollback(target: RollbackTarget): Promise<ApplyResult>;
}

// ---------- env scan ----------
export type EnvSource = 'process' | 'login-shell' | 'rc-file' | 'windows-registry';
export interface EnvFinding {
  name: string;
  source: EnvSource;
  /** rc-file only: "path:line". */
  location?: string;
  /** Whether the value matches what our profile expects (undefined = no expectation / unknown). */
  matchesProfile?: boolean;
  severity: 'conflict' | 'info';
  message: string;
}
export interface EnvScanResult { findings: EnvFinding[]; skipped: { layer: EnvSource; reason: string }[] }

// ---------- keychain ----------
export type KeyringBackend = 'macos-keychain' | 'windows-credential-manager' | 'secret-service' | 'memory' | 'none';
export interface KeyringStatus {
  available: boolean;
  backend: KeyringBackend;
  /** Set when unavailable, e.g. Linux without Secret Service -> use keyMode "env". Never "plaintext". */
  fallback?: 'env';
  reason?: string;
  entries: { profileId: string; harness: HarnessId; present: boolean }[];
}

// ---------- IPC DTOs ----------
export interface HarnessDetectRes { harnesses: Detection[]; registered: HarnessId[] }
export interface HarnessPlanReq { id: HarnessId; profileId: string }
export interface HarnessApplyReq { id: HarnessId; plan: Plan; acknowledge?: ConflictAck[]; confirm: true }
export interface HarnessRollbackReq { id: HarnessId; target: RollbackTarget; confirm: true }
export interface HarnessKeyringStatusReq { profileId?: string }
export interface HarnessProfileListRes { profiles: HarnessProfile[] }
