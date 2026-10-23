import { HARNESS_IDS, type HarnessId } from '@pa/core/contract';
import { accountFor, PROFILE_ID_RE, type Keyring } from './keyring.js';

export interface PaKeyIo { stdout(s: string): void; stderr(s: string): void }

export const PA_KEY_USAGE = 'usage: pa-key <profileId> <pi|claude|codex>';

/**
 * pa-key: prints exactly the key (no newline) to stdout. Exit codes: 0 ok, 2 usage, 3 not found, 4 keychain unavailable.
 * stderr carries only fixed, non-sensitive hints. No logs, no caching.
 */
export async function runPaKey(argv: string[], keyring: Keyring, io: PaKeyIo): Promise<number> {
  const [profileId, harness, ...rest] = argv;
  if (!profileId || !harness || rest.length || !PROFILE_ID_RE.test(profileId) || !(HARNESS_IDS as readonly string[]).includes(harness)) {
    io.stderr(`${PA_KEY_USAGE}\n`);
    return 2;
  }
  const avail = await keyring.available().catch(() => ({ ok: false }));
  if (!avail.ok) {
    io.stderr('pa-key: system keychain unavailable; use env key mode (export the key in your shell) — 系统钥匙串不可用，请改用环境变量模式\n');
    return 4;
  }
  let secret: string | null;
  try { secret = await keyring.get(accountFor(profileId, harness as HarnessId)); }
  catch { io.stderr('pa-key: keychain read failed — 读取钥匙串失败\n'); return 4; }
  if (!secret) {
    io.stderr('pa-key: no key for this profile/harness; re-enable it in Portable Agent — 未找到 key，请在 Portable Agent 中重新启用\n');
    return 3;
  }
  io.stdout(secret);
  return 0;
}
