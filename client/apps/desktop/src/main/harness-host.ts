import { HARNESS_IDS, PaException, type Core, type HarnessId, type HarnessProfile, type KeyringStatus } from '@pa/core';
import { ClaudeAdapter, CodexAdapter, ControlledFs, createHarness, nodeExec, nodeFsOps, PiAdapter, StateStore, type Harness } from '@pa/core/harness';
import { accountFor, keyringStatus, type Keyring } from '@pa/key-helper';

export interface HarnessHostOptions {
  home: string;
  /** Electron userData (client data dir). */
  dataDir: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  keyring: Keyring;
  /** Absolute path of the installed pa-key wrapper (D4: inside the client's own directory). */
  helperPath: string;
  fs?: ControlledFs;
  exec?: typeof nodeExec;
  /** Needed to provision keychain entries (command key mode) before a write. */
  getCore?: () => Core;
  cwd?: string;
}

/**
 * Main-process owner of the harness module and of keychain entries. Electron-free (testable).
 * Only main ever handles key values: they go core.keys.secret() -> keychain, never to the renderer.
 */
export class HarnessHost {
  readonly harness: Harness;
  readonly state: StateStore;
  readonly helperPath: string;
  private readonly keyring: Keyring;

  constructor(o: HarnessHostOptions) {
    const fs = o.fs ?? new ControlledFs({ ops: nodeFsOps, roots: [o.home, o.dataDir], dataDir: o.dataDir });
    this.state = new StateStore(fs);
    this.keyring = o.keyring;
    this.helperPath = o.helperPath;
    const env = { home: o.home, env: o.env, platform: o.platform };
    const exec = o.exec ?? nodeExec;
    const common = (h: HarnessId) => ({
      fs, state: this.state, env, exec, helperPath: o.helperPath, ...(o.cwd ? { cwd: o.cwd } : {}),
      beforeWrite: async (p: HarnessProfile) => {
        if (p.keyMode !== 'command') return;
        if (!o.getCore) throw new PaException({ code: 'VALIDATION', message: 'Cannot provision the key here' });
        await this.provisionKey(o.getCore(), p.id, h, p.keyId);
      },
      afterDetach: async (ids: string[]) => { for (const id of ids) await this.revokeKey(id, h).catch(() => {}); },
    });
    const pi = new PiAdapter(common('pi'));
    const claude = new ClaudeAdapter(common('claude'));
    const codex = new CodexAdapter(common('codex'));
    this.harness = createHarness({
      fs, state: this.state, exec, env, adapters: { pi, claude, codex },
      keyringStatus: (profileId) => this.keyringStatus(profileId),
    });
  }

  async keyringStatus(profileId?: string): Promise<KeyringStatus> {
    const ids = profileId !== undefined ? [profileId] : Object.keys((await this.state.load()).profiles);
    return keyringStatus(this.keyring, ids);
  }

  /** Writes the key for (profile, harness) into the OS keychain. Fails (no plaintext fallback) if unavailable. */
  async provisionKey(core: Core, profileId: string, harness: HarnessId, keyId: number): Promise<void> {
    if (!(await this.keyring.available()).ok) {
      throw new PaException({ code: 'VALIDATION', message: 'System keychain unavailable; use env key mode' });
    }
    await this.keyring.set(accountFor(profileId, harness), await core.keys.secret(keyId));
  }

  /** Removes keychain entries for a profile (one harness or all). */
  async revokeKey(profileId: string, harness?: HarnessId): Promise<void> {
    if (!(await this.keyring.available()).ok) return;
    for (const h of harness ? [harness] : HARNESS_IDS) await this.keyring.delete(accountFor(profileId, h));
  }
}
