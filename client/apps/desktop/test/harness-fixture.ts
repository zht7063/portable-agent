import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKeyring, type Keyring } from '@pa/key-helper';
import type { Core } from '@pa/core';
import { HarnessHost } from '../src/main/harness-host';

/** Harness host on a temporary HOME/userData with an in-memory keychain and a fake exec (nothing installed). */
export function tmpHarnessHost(keyring: Keyring = new MemoryKeyring(), getCore?: () => Core) {
  const root = mkdtempSync(join(tmpdir(), 'pa-desktop-harness-'));
  const home = join(root, 'home');
  const dataDir = join(root, 'userData');
  const host = new HarnessHost({
    home, dataDir, env: { HOME: home }, platform: 'linux', keyring, helperPath: join(dataDir, 'bin', 'pa-key'),
    exec: async () => ({ code: null, stdout: '', stderr: 'not found' }),
    ...(getCore ? { getCore } : {}),
  });
  return { host, home, dataDir, keyring };
}
