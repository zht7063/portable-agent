/**
 * Harness module (H0 infrastructure). Node-only (fs/child_process via DI), electron-free.
 * Import via `@pa/core/harness`; renderer-safe types live in `@pa/core/contract`.
 */
import { PaException } from '../contract/errors.js';
import { HARNESS_IDS, type ApplyResult, type HarnessProfile, type ConflictAck, type Detection, type EnvScanResult, type HarnessAdapter, type HarnessId, type KeyringStatus, type Plan, type RollbackTarget } from '../contract/harness.js';
import { ControlledFs } from './fs/controlled.js';
import type { ExecFn } from './exec.js';
import { HARNESS_ENV_VARS, scanEnv, type EnvScanOptions, type WatchedVar } from './env-scan.js';
import type { HarnessEnv } from './paths.js';
import { detectBasic } from './detect.js';
import { PROFILE_ID_RE, StateStore } from './state.js';

export * from './fs/ops.js';
export { nodeFsOps } from './fs/node.js';
export { ControlledFs, DEFAULT_SNAPSHOT_RETAIN, sha256Hex, type BackupEntry, type ControlledFsOptions } from './fs/controlled.js';
export * from './state.js';
export * from './merge/json.js';
export * from './env-scan.js';
export * from './exec.js';
export * from './paths.js';
export { maskValue } from './mask.js';
export { detectBasic } from './detect.js';
export * from './adapters/base.js';
export * from './adapters/pi.js';
export * from './adapters/claude.js';

export interface HarnessDeps {
  fs: ControlledFs;
  state: StateStore;
  env: HarnessEnv;
  exec: ExecFn;
  adapters?: Partial<Record<HarnessId, HarnessAdapter>>;
  /** Supplied by the host (desktop/CLI) from @pa/key-helper; core never touches the keychain. */
  keyringStatus?: (profileId?: string) => Promise<KeyringStatus>;
}

const notImpl = (id: HarnessId): never => { throw new PaException({ code: 'NOT_IMPLEMENTED', message: `Harness adapter "${id}" is not available yet` }); };

const str = (v: unknown, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
const strList = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= 50 && v.every((x) => str(x)));

/** Validates and copies only known fields (no secrets can ride along). */
export function validateProfile(p: HarnessProfile): HarnessProfile {
  const v = (ok: boolean, m: string) => { if (!ok) throw new PaException({ code: 'VALIDATION', message: m }); };
  v(!!p && typeof p === 'object', 'Invalid profile');
  v(PROFILE_ID_RE.test(p.id), 'Invalid profile id');
  v(Number.isSafeInteger(p.keyId) && p.keyId > 0, 'Invalid key id');
  v(str(p.serverUrl, 2048) && /^https?:\/\//.test(p.serverUrl), 'Invalid server URL');
  v(['command', 'env', 'plaintext'].includes(p.keyMode), 'Invalid key mode');
  v(!!p.models && str(p.models.main), 'Main model is required');
  for (const k of ['small', 'opus', 'sonnet', 'haiku', 'codex'] as const) v(p.models[k] === undefined || str(p.models[k]), 'Invalid model');
  v(p.providerId === undefined || /^[A-Za-z0-9_-]{1,64}$/.test(p.providerId), 'Invalid provider id');
  v(p.envVar === undefined || /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(p.envVar), 'Invalid env var name');
  const pi = p.pi;
  if (pi !== undefined) {
    v(typeof pi === 'object' && pi !== null, 'Invalid pi options');
    v(pi.api === undefined || pi.api === 'openai-completions', 'Invalid pi api (only openai-completions is available)');
    v(strList(pi.models) && strList(pi.reasoning), 'Invalid pi models');
    v(pi.setDefault === undefined || typeof pi.setDefault === 'boolean', 'Invalid pi setDefault');
  }
  const cl = p.claude;
  if (cl !== undefined) {
    v(typeof cl === 'object' && cl !== null, 'Invalid claude options');
    v(cl.setModel === undefined || typeof cl.setModel === 'boolean', 'Invalid claude setModel');
  }
  const m = p.models;
  const models = Object.fromEntries(Object.entries({ main: m.main, small: m.small, opus: m.opus, sonnet: m.sonnet, haiku: m.haiku, codex: m.codex }).filter(([, x]) => x !== undefined)) as unknown as HarnessProfile['models'];
  return {
    id: p.id, serverUrl: p.serverUrl, keyId: p.keyId, keyMode: p.keyMode, models,
    ...(p.providerId !== undefined ? { providerId: p.providerId } : {}),
    ...(p.envVar !== undefined ? { envVar: p.envVar } : {}),
    ...(pi ? { pi: { ...(pi.api ? { api: pi.api } : {}), ...(pi.models ? { models: [...pi.models] } : {}), ...(pi.reasoning ? { reasoning: [...pi.reasoning] } : {}), ...(pi.setDefault !== undefined ? { setDefault: pi.setDefault } : {}) } } : {}),
    ...(cl ? { claude: { ...(cl.setModel !== undefined ? { setModel: cl.setModel } : {}) } } : {}),
  };
}

export function createHarness(d: HarnessDeps) {
  const adapter = (id: HarnessId) => d.adapters?.[id] ?? notImpl(id);
  const check = (id: unknown): HarnessId => {
    if (!(HARNESS_IDS as readonly unknown[]).includes(id)) throw new PaException({ code: 'VALIDATION', message: 'Unknown harness' });
    return id as HarnessId;
  };
  return {
    registered: (): HarnessId[] => HARNESS_IDS.filter((id) => d.adapters?.[id]),
    async detect(): Promise<Detection[]> {
      return Promise.all(HARNESS_IDS.map((id) => d.adapters?.[id]?.detect() ?? detectBasic(id, d)));
    },
    async plan(id: HarnessId, profileId: string): Promise<Plan> {
      const a = adapter(check(id));
      const p = (await d.state.load()).profiles[profileId];
      if (!p) throw new PaException({ code: 'VALIDATION', message: 'Unknown harness profile' });
      return a.plan(p);
    },
    async apply(id: HarnessId, plan: Plan, acknowledge: ConflictAck[] = []): Promise<ApplyResult> {
      const a = adapter(check(id));
      if (plan?.id !== id) throw new PaException({ code: 'VALIDATION', message: 'Plan does not match harness' });
      return a.apply(plan, { acknowledge });
    },
    async rollback(id: HarnessId, target: RollbackTarget): Promise<ApplyResult> { return adapter(check(id)).rollback(target); },
    async envScan(ids: HarnessId[] = [...HARNESS_IDS], expected: Record<string, string> = {}, o: EnvScanOptions = {}): Promise<EnvScanResult> {
      const watch: WatchedVar[] = ids.flatMap((id) => HARNESS_ENV_VARS[check(id)]).map((w) => (expected[w.name] !== undefined ? { ...w, expected: expected[w.name] } : w));
      return scanEnv(watch, {
        processEnv: d.env.env, platform: d.env.platform, home: d.env.home, exec: d.exec,
        readText: async (p) => (await d.fs.readText(p).catch(() => null))?.text ?? null,
      }, o);
    },
    async listProfiles(): Promise<HarnessProfile[]> { return Object.values((await d.state.load()).profiles); },
    async upsertProfile(p: HarnessProfile): Promise<HarnessProfile> {
      const clean = validateProfile(p);
      await d.state.upsertProfile(clean);
      return clean;
    },
    async keyringStatus(profileId?: string): Promise<KeyringStatus> {
      if (!d.keyringStatus) return { available: false, backend: 'none', fallback: 'env', reason: 'Keychain not configured', entries: [] };
      return d.keyringStatus(profileId);
    },
  };
}
export type Harness = ReturnType<typeof createHarness>;
