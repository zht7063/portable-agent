import { join } from 'node:path';
import type { HarnessId } from '../contract/harness.js';

export interface HarnessEnv { home: string; env: Record<string, string | undefined>; platform: NodeJS.Platform }

/** Config dirs honoring PI_CODING_AGENT_DIR / CLAUDE_CONFIG_DIR / CODEX_HOME. */
export function configDir(id: HarnessId, e: HarnessEnv): string {
  if (id === 'pi') return e.env.PI_CODING_AGENT_DIR || join(e.home, '.pi', 'agent');
  if (id === 'claude') return e.env.CLAUDE_CONFIG_DIR || join(e.home, '.claude');
  return e.env.CODEX_HOME || join(e.home, '.codex');
}

/** User-level files each harness adapter manages (auth files are listed for existence checks only; never read). */
export function managedFiles(id: HarnessId, e: HarnessEnv): { path: string; role: 'config' | 'auth-presence-only' }[] {
  const d = configDir(id, e);
  if (id === 'pi') return [{ path: join(d, 'models.json'), role: 'config' }, { path: join(d, 'settings.json'), role: 'config' }, { path: join(d, 'auth.json'), role: 'auth-presence-only' }];
  if (id === 'claude') return [{ path: join(d, 'settings.json'), role: 'config' }];
  return [{ path: join(d, 'config.toml'), role: 'config' }, { path: join(d, 'auth.json'), role: 'auth-presence-only' }];
}

export const HARNESS_BINARIES: Record<HarnessId, string> = { pi: 'pi', claude: 'claude', codex: 'codex' };
