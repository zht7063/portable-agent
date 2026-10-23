/**
 * Pi (pi-coding-agent) adapter, H1.
 * Owned settings (verified against pi docs, 2026-10):
 *   models.json   providers.<providerId>            (whole object)
 *   settings.json defaultProvider, defaultModel      (only when profile.pi.setDefault !== false)
 * Never reads auth.json (presence only). Never writes a key: apiKey is "!<pa-key> <profile> pi" (command)
 * or "$<ENV>" (env). plaintext is refused (D2 open).
 */
import { join } from 'node:path';
import { PaException } from '../../contract/errors.js';
import type { ApplyResult, ConflictAck, Conflict, Detection, FileFingerprint, HarnessAdapter, HarnessProfile, LiveSnapshot, Plan, PlannedKeyChange, RollbackTarget } from '../../contract/harness.js';
import type { ControlledFs } from '../fs/controlled.js';
import type { ExecFn } from '../exec.js';
import { getPath, mergeOwnedJson, parseJsonc, type JsonEdit } from '../merge/json.js';
import { maskValue } from '../mask.js';
import { configDir, type HarnessEnv } from '../paths.js';
import { canonicalJson, classifyChange, hashOwnedValues, PROFILE_ID_RE, type HistoryEntry, type ManagedFileState, type StateStore } from '../state.js';
import { detectBasic } from '../detect.js';

export interface PiAdapterOptions {
  fs: ControlledFs;
  state: StateStore;
  env: HarnessEnv;
  exec: ExecFn;
  /** Absolute path of the pa-key wrapper (D4). */
  helperPath: string;
  /** Working directory for the project-level `.pi/` hint (read-only check). */
  cwd?: string;
  /** Host hook run right before writing (e.g. provision the keychain entry in command mode). Abort by throwing. */
  beforeWrite?: (profile: HarnessProfile) => Promise<void>;
  /** Host hook after detach (e.g. revoke the keychain entry). */
  afterDetach?: (profileIds: string[]) => Promise<void>;
  now?: () => Date;
}

const ID = 'pi' as const;
const PROVIDER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const bad = (message: string): never => { throw new PaException({ code: 'VALIDATION', message }); };
const dotted = (p: (string | number)[]) => p.join('.');
const undot = (s: string) => s.split('.');

type Desired = Map<string, unknown>; // dotted setting -> value (undefined = remove)
interface FilePlan {
  path: string; text: string; fp: FileFingerprint | null; root: Record<string, unknown>;
  entry?: ManagedFileState; desired: Desired; owned: string[]; conflict?: Conflict; externalUnowned: boolean;
}
interface Computed { plan: Plan; files: FilePlan[]; profile: HarnessProfile }

const posixQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const winQuote = (s: string) => (/["%]/.test(s) ? bad('Helper path contains unsupported characters') : `"${s}"`);

export function piApiKeyValue(p: HarnessProfile, helperPath: string, platform: NodeJS.Platform): string {
  if (p.keyMode === 'command') {
    if (!helperPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(helperPath)) bad('Helper path must be absolute');
    return `!${platform === 'win32' ? winQuote(helperPath) : posixQuote(helperPath)} ${p.id} pi`;
  }
  if (p.keyMode === 'env') return `$${p.envVar ?? 'PA_API_KEY'}`;
  return bad('Plaintext key mode is not supported for Pi (keys are never written to config files)');
}

export function piBaseUrl(serverUrl: string, api: string): string {
  let u: URL;
  try { u = new URL(serverUrl); } catch { return bad('Invalid server URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') bad('Server URL must be http(s)');
  if (u.username || u.password || u.search || u.hash) bad('Server URL must not contain credentials, query or fragment');
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  // openai-completions appends /chat/completions; anthropic-messages appends /v1/messages (SDK convention).
  return api === 'anthropic-messages' ? base.replace(/\/v1$/, '') : base.endsWith('/v1') ? base : `${base}/v1`;
}

export function piProviderConfig(p: HarnessProfile, helperPath: string, platform: NodeJS.Platform) {
  const api = p.pi?.api ?? 'openai-completions';
  if (api !== 'openai-completions' && api !== 'anthropic-messages') bad('Unsupported Pi api');
  const ids = [...new Set((p.pi?.models?.length ? p.pi.models : [p.models.main, p.models.small]).filter((m): m is string => !!m && m.trim() !== ''))];
  if (!ids.length) bad('Profile has no models');
  const reasoning = new Set(p.pi?.reasoning ?? []);
  return {
    baseUrl: piBaseUrl(p.serverUrl, api),
    api,
    apiKey: piApiKeyValue(p, helperPath, platform),
    models: ids.map((id) => (reasoning.has(id) ? { id, reasoning: true } : { id })),
  };
}

export class PiAdapter implements HarnessAdapter {
  readonly id = ID;
  constructor(private readonly o: PiAdapterOptions) {}

  get dir() { return configDir(ID, this.o.env); }
  get modelsPath() { return join(this.dir, 'models.json'); }
  get settingsPath() { return join(this.dir, 'settings.json'); }
  get authPath() { return join(this.dir, 'auth.json'); }
  private get configPaths() { return [this.modelsPath, this.settingsPath]; }
  private now() { return (this.o.now ?? (() => new Date()))().toISOString(); }

  private async exists(p: string): Promise<boolean> {
    try { return (await this.o.fs.ops.stat(await this.o.fs.assertAllowed(p))) !== null; } catch { return false; }
  }

  async detect(): Promise<Detection> {
    const d = await detectBasic(ID, this.o);
    if (this.o.env.env.PI_CODING_AGENT_DIR) d.notes.push('Using PI_CODING_AGENT_DIR');
    if (await this.exists(this.authPath)) d.notes.push('auth.json exists: credentials stored there for the same provider take precedence over models.json (not read)');
    if (this.o.cwd && (await this.o.fs.ops.stat(join(this.o.cwd, '.pi')).catch(() => null))) d.notes.push('Project-level .pi/ found in the current directory; it may override user settings (not modified)');
    return d;
  }

  private async load(path: string) {
    const r = await this.o.fs.readText(path);
    const text = r?.text ?? '';
    return { text, fp: r?.fingerprint ?? null, root: parseJsonc(text) as Record<string, unknown> };
  }

  private static ownedValues(root: unknown, settings: string[]): Record<string, unknown> {
    return Object.fromEntries(settings.map((s) => [s, getPath(root, undot(s)) ?? null]));
  }

  async read(): Promise<LiveSnapshot> {
    const st = await this.o.state.load();
    const owned: Record<string, string | null> = {};
    const files = [];
    for (const path of this.configPaths) {
      const { fp, root } = await this.load(path);
      const entry = st.files[path];
      const settings = entry?.ownedSettings ?? [];
      const vals = PiAdapter.ownedValues(root, settings);
      for (const [k, v] of Object.entries(vals)) owned[`${path}#${k}`] = maskValue(v);
      files.push({ path, fingerprint: fp, ownedValuesHash: entry ? hashOwnedValues(vals) : null });
    }
    return { id: ID, files, owned };
  }

  private desiredFor(p: HarnessProfile): Map<string, Desired> {
    if (!PROFILE_ID_RE.test(p.id)) bad('Invalid profile id');
    const pid = p.providerId ?? 'pa';
    if (!PROVIDER_RE.test(pid)) bad('Invalid provider id');
    if (p.envVar !== undefined && !ENV_RE.test(p.envVar)) bad('Invalid env var name');
    const models: Desired = new Map([[dotted(['providers', pid]), piProviderConfig(p, this.o.helperPath, this.o.env.platform)]]);
    const settings: Desired = new Map();
    if (p.pi?.setDefault !== false) { settings.set('defaultProvider', pid); settings.set('defaultModel', p.models.main); }
    return new Map([[this.modelsPath, models], [this.settingsPath, settings]]);
  }

  private async compute(profile: HarnessProfile): Promise<Computed> {
    const st = await this.o.state.load();
    const desiredByFile = this.desiredFor(profile);
    const files: FilePlan[] = [];
    const changes: PlannedKeyChange[] = [];
    const conflicts: Conflict[] = [];
    const warnings: string[] = [];
    const externalUnownedChange: string[] = [];
    const baseFingerprints: Record<string, FileFingerprint | null> = {};
    for (const path of this.configPaths) {
      const { text, fp, root } = await this.load(path);
      baseFingerprints[path] = fp;
      const entry = st.files[path];
      const desired = new Map(desiredByFile.get(path)!);
      // Settings we owned before but no longer want (e.g. provider id renamed, setDefault turned off): remove/restore.
      for (const s of entry?.ownedSettings ?? []) if (!desired.has(s)) desired.set(s, entry?.original?.[s] ?? undefined);
      const owned = [...desired.keys()];
      const cls = classifyChange(entry, fp, entry ? hashOwnedValues(PiAdapter.ownedValues(root, entry.ownedSettings)) : null);
      const fpl: FilePlan = { path, text, fp, root, entry, desired, owned, externalUnowned: cls === 'external-unowned' };
      if (cls === 'external-unowned') externalUnownedChange.push(path);
      if (cls === 'conflict') {
        fpl.conflict = {
          id: `external-owned-change:${path}`, kind: 'external-owned-change', file: path,
          message: 'Settings managed by Portable Agent were changed outside the app',
          current: maskValue(PiAdapter.ownedValues(root, entry!.ownedSettings)), proposed: maskValue(Object.fromEntries(desired)),
        };
      } else if (cls === 'untracked' && path === this.modelsPath) {
        const s = [...desired.keys()][0]!;
        const cur = getPath(root, undot(s));
        if (cur !== undefined && canonicalJson(cur) !== canonicalJson(desired.get(s))) {
          fpl.conflict = {
            id: `name-collision:${path}#${s}`, kind: 'name-collision', file: path, setting: s,
            message: `A provider named "${undot(s)[1]}" already exists in models.json; overwrite it or choose another provider id`,
            current: maskValue(cur), proposed: maskValue(desired.get(s)),
          };
        }
      }
      if (fpl.conflict) conflicts.push(fpl.conflict);
      for (const [s, v] of desired) {
        const cur = getPath(root, undot(s));
        const kind = cur === undefined ? (v === undefined ? 'unchanged' : 'create') : v === undefined ? 'remove' : canonicalJson(cur) === canonicalJson(v) ? 'unchanged' : 'modify';
        changes.push({ file: path, setting: s, kind, before: maskValue(cur), after: maskValue(v) });
      }
      files.push(fpl);
    }
    if (await this.exists(this.authPath)) warnings.push(`Pi auth.json exists; if it holds a credential for provider "${profile.providerId ?? 'pa'}" it overrides models.json (auth.json is not read)`);
    if (profile.keyMode === 'env' && !this.o.env.env[profile.envVar ?? 'PA_API_KEY']) warnings.push(`Env key mode: export ${profile.envVar ?? 'PA_API_KEY'} in the shell that starts pi`);
    if (profile.pi?.setDefault === false) warnings.push(`Default model not changed; in Pi run /model and pick ${profile.providerId ?? 'pa'}/${profile.models.main}`);
    const plan: Plan = { id: ID, profileId: profile.id, createdAt: this.now(), baseFingerprints, changes, conflicts, warnings, externalUnownedChange };
    return { plan, files, profile };
  }

  async plan(profile: HarnessProfile): Promise<Plan> { return (await this.compute(profile)).plan; }

  private async snapshotWithState(action: HistoryEntry['action']): Promise<HistoryEntry> {
    const st = await this.o.state.load();
    const snapshotId = await this.o.fs.snapshot(ID, this.configPaths);
    const files = Object.fromEntries(Object.entries(st.files).filter(([p, f]) => f.harness === ID && this.configPaths.includes(p)));
    return { harness: ID, snapshotId, at: this.now(), action, files };
  }

  /**
   * Re-plans from the stored profile (the renderer-supplied plan is only trusted for its fingerprints and profile id),
   * requires the same base fingerprints and an acknowledgement for every conflict, then backs up and writes.
   */
  async apply(given: Plan, opts: { acknowledge: ConflictAck[] }): Promise<ApplyResult> {
    const profile = (await this.o.state.load()).profiles[given.profileId] ?? bad('Unknown harness profile');
    const c = await this.compute(profile);
    for (const path of this.configPaths) {
      const a = given.baseFingerprints?.[path] ?? null; const b = c.plan.baseFingerprints[path] ?? null;
      if (canonicalJson(a) !== canonicalJson(b)) bad('Config changed since the plan was made; re-run plan');
    }
    const acks = new Map((opts.acknowledge ?? []).map((x) => [x.conflictId, x.resolution]));
    const skip = new Set<string>();
    for (const f of c.files) {
      if (!f.conflict) continue;
      const r = acks.get(f.conflict.id);
      if (!r || r === 'cancel') bad('Unresolved conflict; review it and choose overwrite or keep-external');
      if (r === 'keep-external') skip.add(f.path);
    }
    const todo = c.files.filter((f) => !skip.has(f.path) && c.plan.changes.some((ch) => ch.file === f.path && ch.kind !== 'unchanged'));
    const warnings = [...c.plan.warnings];
    if (!todo.length) return { id: ID, written: [], warnings };
    await this.o.beforeWrite?.(profile);
    const hist = await this.snapshotWithState('apply');
    const written: string[] = [];
    const newEntries: Record<string, ManagedFileState> = {};
    for (const f of todo) {
      await this.o.fs.backupFirstWrite(ID, f.path);
      const edits: JsonEdit[] = [...f.desired].map(([s, v]) => ({ path: undot(s), value: v }));
      const out = mergeOwnedJson(f.text, edits);
      const fp = await this.o.fs.atomicWrite(f.path, out, { expect: f.fp });
      written.push(f.path);
      const keep = [...f.desired].filter(([, v]) => v !== undefined).map(([s]) => s);
      // Remember the user's previous values once (settings.json defaults only; models.json provider may hold a key).
      const original = f.entry?.original ?? (f.path === this.settingsPath ? PiAdapter.ownedValues(f.root, keep) : undefined);
      newEntries[f.path] = {
        harness: ID, lastWritten: fp, ownedValuesHash: hashOwnedValues(PiAdapter.ownedValues(parseJsonc(out), keep)),
        ownedSettings: keep, ...(original ? { original } : {}), updatedAt: this.now(),
      };
    }
    await this.o.state.update((s) => {
      for (const [p, e] of Object.entries(newEntries)) { if (e.ownedSettings.length) s.files[p] = e; else delete s.files[p]; }
      s.history.push(hist);
    });
    return { id: ID, written, snapshotId: hist.snapshotId, warnings };
  }

  private async restore(entries: { path: string; data: Uint8Array | null }[]): Promise<string[]> {
    const written: string[] = [];
    for (const e of entries) {
      if (!this.configPaths.includes(e.path)) bad('Backup contains an unexpected path');
      if (e.data === null) { if (await this.exists(e.path)) { await this.o.fs.remove(e.path); written.push(e.path); } }
      else { await this.o.fs.atomicWrite(e.path, e.data); written.push(e.path); }
    }
    return written;
  }

  async rollback(target: RollbackTarget): Promise<ApplyResult> {
    if (target === 'detach') return this.detach();
    const st = await this.o.state.load();
    let source: 'first-write' | { snapshotId: string };
    let prior: HistoryEntry | undefined;
    if (target === 'first-write') source = 'first-write';
    else if (target === 'last') {
      prior = [...st.history].reverse().find((h) => h.harness === ID && h.action === 'apply') ?? bad('Nothing to roll back');
      source = { snapshotId: prior.snapshotId };
    } else {
      source = { snapshotId: target.snapshotId };
      prior = st.history.find((h) => h.harness === ID && h.snapshotId === target.snapshotId);
    }
    const entries = await this.o.fs.loadBackup(ID, source);
    const hist = await this.snapshotWithState('rollback'); // current state stays recoverable
    const written = await this.restore(entries);
    await this.o.state.update((s) => {
      for (const p of this.configPaths) delete s.files[p];
      if (prior?.files) for (const [p, e] of Object.entries(prior.files)) s.files[p] = e;
      if (target === 'last' && prior) s.history = s.history.filter((h) => h !== prior && h.snapshotId !== prior!.snapshotId);
      s.history.push(hist);
    });
    // Restored files may differ in mtime from the remembered fingerprint; owned-value hashes still classify them correctly.
    return { id: ID, written, snapshotId: hist.snapshotId, warnings: [] };
  }

  /** Removes only our managed settings (restoring the user's previous defaults); refuses if they were edited externally. */
  private async detach(): Promise<ApplyResult> {
    const st = await this.o.state.load();
    const mine = this.configPaths.filter((p) => st.files[p]?.harness === ID);
    if (!mine.length) return { id: ID, written: [], warnings: ['Nothing to detach'] };
    const loaded = [];
    for (const path of mine) {
      const l = await this.load(path);
      const e = st.files[path]!;
      if (classifyChange(e, l.fp, hashOwnedValues(PiAdapter.ownedValues(l.root, e.ownedSettings))) === 'conflict') {
        bad('Managed settings were changed outside Portable Agent; use rollback or edit the file manually');
      }
      loaded.push({ path, ...l, e });
    }
    const hist = await this.snapshotWithState('detach');
    const written: string[] = [];
    for (const l of loaded) {
      const edits = l.e.ownedSettings.map((s) => ({ path: undot(s), value: l.e.original?.[s] ?? undefined }));
      const out = mergeOwnedJson(l.text, edits);
      if (out !== l.text) { await this.o.fs.atomicWrite(l.path, out, { expect: l.fp }); written.push(l.path); }
    }
    await this.o.state.update((s) => { for (const p of mine) delete s.files[p]; s.history.push(hist); });
    const profiles = Object.keys(st.profiles);
    await this.o.afterDetach?.(profiles);
    return { id: ID, written, snapshotId: hist.snapshotId, warnings: [] };
  }
}
