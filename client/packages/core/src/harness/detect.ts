import type { Detection, HarnessId } from '../contract/harness.js';
import type { ControlledFs } from './fs/controlled.js';
import type { ExecFn } from './exec.js';
import { configDir, HARNESS_BINARIES, managedFiles, type HarnessEnv } from './paths.js';

/** Basic detection used until an adapter is registered: binary --version (3s), config dir, file presence. Never reads auth files. */
export async function detectBasic(id: HarnessId, d: { fs: ControlledFs; env: HarnessEnv; exec: ExecFn }): Promise<Detection> {
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

