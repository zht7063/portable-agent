/**
 * Harness module (H0 infrastructure). Node-only (fs/child_process via DI), electron-free.
 * Import via `@pa/core/harness`; renderer-safe types live in `@pa/core/contract`.
 */
import { PaException } from '../contract/errors.js';
import { HARNESS_IDS, type ApplyResult, type ConflictAck, type Detection, type EnvScanResult, type HarnessAdapter, type HarnessId, type KeyringStatus, type Plan, type RollbackTarget } from '../contract/harness.js';
import { ControlledFs } from './fs/controlled.js';
import type { ExecFn } from './exec.js';
import { HARNESS_ENV_VARS, scanEnv, type EnvScanOptions, type WatchedVar } from './env-scan.js';
import { configDir, HARNESS_BINARIES, managedFiles, type HarnessEnv } from './paths.js';
import { StateStore } from './state.js';

export * from './fs/ops.js';
export { nodeFsOps } from './fs/node.js';
export { ControlledFs, DEFAULT_SNAPSHOT_RETAIN, sha256Hex, type BackupEntry, type ControlledFsOptions } from './fs/controlled.js';
export * from './state.js';
export * from './merge/json.js';
export * from './env-scan.js';
export * from './exec.js';
export * from './paths.js';
export { maskValue } from './mask.js';

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

/** Basic detection used until an adapter is registered: binary --version (3s), config dir, file presence. Never reads auth files. */
export async function detectBasic(id: HarnessId, d: Pick<HarnessDeps, 'fs' | 'env' | 'exec'>): Promise<Detection> {
  const r = await d.exec(HARNESS_BINARIES[id], ['--version'], { timeoutMs: 3000 });
  const installed = r.code === 0;
  const version = installed ? (/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(r.stdout)?.[0] ?? undefined) : undefined;
  const files = [];
  for (const f of managedFiles(id, d.env)) {
    let exists = false;
    try { exists = (await d.fs.ops.stat(await d.fs.assertAllowed(f.path))) !== null; } catch { exists = false; }
    files.push({ path: f.path, exists });
  }
  return { id, installed, ...(version ? { version } : {}), configDir: configDir(id, d.env), files, notes: [] };
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
    async keyringStatus(profileId?: string): Promise<KeyringStatus> {
      if (!d.keyringStatus) return { available: false, backend: 'none', fallback: 'env', reason: 'Keychain not configured', entries: [] };
      return d.keyringStatus(profileId);
    },
  };
}
export type Harness = ReturnType<typeof createHarness>;
