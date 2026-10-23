import { createCore, type ClientConfig, type ConfigSetReq, type Core, type SessionView, type TokenStore } from '@pa/core';
import { ConfigStore, toClientConfig, type PersistedConfig } from './config-store';

export interface CoreHostOptions {
  configStore: ConfigStore;
  tokenStore: TokenStore;
  onSessionChange(v: SessionView): void;
  /** For tests. */
  createCoreImpl?: typeof createCore;
}

/** Owns the current Core and config; recreates Core when the server URL changes. Electron-free (testable). */
export class CoreHost {
  private cfg!: PersistedConfig;
  private current!: Core;
  private unsubscribe: () => void = () => {};

  constructor(private readonly o: CoreHostOptions) {}

  static async start(o: CoreHostOptions): Promise<CoreHost> {
    const h = new CoreHost(o);
    h.cfg = await o.configStore.load();
    h.build();
    await h.current.session.restore();
    return h;
  }

  get core(): Core { return this.current; }
  config(): ClientConfig { return toClientConfig(this.cfg); }

  private build() {
    this.unsubscribe();
    this.current = (this.o.createCoreImpl ?? createCore)({ serverUrl: this.cfg.serverUrl, store: this.o.tokenStore });
    this.unsubscribe = this.current.session.onChange(this.o.onSessionChange);
  }

  /** Validates, persists, and on URL change clears the session and recreates Core. */
  async set(patch: ConfigSetReq): Promise<ClientConfig> {
    const next = this.o.configStore.apply(this.cfg, patch);
    const urlChanged = next.serverUrl !== this.cfg.serverUrl;
    await this.o.configStore.save(next);
    if (urlChanged) {
      // Local clear only: the old server's refresh cookie / cached keys are discarded.
      await this.current.session.clear();
      this.cfg = next;
      this.build();
      this.o.onSessionChange(this.current.session.view());
    } else {
      this.cfg = next;
    }
    return this.config();
  }
}
