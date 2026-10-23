import { join } from 'node:path';
import { PaException } from '../contract/errors.js';
import { HARNESS_IDS, isHarnessId, type FileFingerprint, type HarnessId, type HarnessProfile } from '../contract/harness.js';
import { sha256Hex, type ControlledFs } from './fs/controlled.js';

/** Per managed file: what we last wrote (for external-change detection, §1.5). */
export interface ManagedFileState {
  harness: HarnessId;
  lastWritten: FileFingerprint;
  /** sha256 over the canonical JSON of the owned values we wrote. */
  ownedValuesHash: string;
  ownedSettings: string[];
  /** Values the owned settings had before our first write (restored by detach). Never secrets in command/env mode. */
  original?: Record<string, unknown>;
  updatedAt: string;
}

export interface HarnessState {
  version: 1;
  /** Client SSOT: live configs are projections of these profiles. No secrets (keyId only). */
  profiles: Record<string, HarnessProfile>;
  files: Record<string, ManagedFileState>;
  history: HistoryEntry[];
}

export interface HistoryEntry {
  harness: HarnessId; snapshotId: string; at: string; action: 'apply' | 'rollback' | 'detach';
  /** Managed-file entries as they were when the snapshot was taken (restored with it). */
  files?: Record<string, ManagedFileState>;
}

export const emptyState = (): HarnessState => ({ version: 1, profiles: {}, files: {}, history: [] });
export const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Stable JSON (sorted keys) for hashing. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const hashOwnedValues = (values: Record<string, unknown>) => sha256Hex(canonicalJson(values));

export type ChangeClass = 'untracked' | 'clean' | 'external-unowned' | 'conflict';
/**
 * §1.5: compare the current file with what we last wrote.
 * untracked = we never wrote it; clean = byte-identical fingerprint; external-unowned = file changed but our
 * owned values did not (merge allowed, show notice); conflict = owned values changed externally (never overwrite silently).
 */
export function classifyChange(entry: ManagedFileState | undefined, current: FileFingerprint | null, currentOwnedHash: string | null): ChangeClass {
  if (!entry) return 'untracked';
  if (current && current.sha256 === entry.lastWritten.sha256 && current.size === entry.lastWritten.size) return 'clean';
  if (current && currentOwnedHash === entry.ownedValuesHash) return 'external-unowned';
  return 'conflict';
}

function validate(raw: unknown): HarnessState {
  const bad = () => { throw new PaException({ code: 'VALIDATION', message: 'Harness state file is invalid; not overwriting it' }); };
  if (!raw || typeof raw !== 'object') bad();
  const s = raw as Partial<HarnessState>;
  if (s.version !== 1 || typeof s.profiles !== 'object' || typeof s.files !== 'object' || !Array.isArray(s.history)) bad();
  for (const [id, p] of Object.entries(s.profiles ?? {})) if (!PROFILE_ID_RE.test(id) || p?.id !== id) bad();
  for (const f of Object.values(s.files ?? {})) if (!isHarnessId(f?.harness)) bad();
  return s as HarnessState;
}

/** <dataDir>/harness/state.json, written atomically through ControlledFs. */
export class StateStore {
  readonly path: string;
  constructor(private readonly fs: ControlledFs) { this.path = join(fs.dataDir, 'harness', 'state.json'); }

  async load(): Promise<HarnessState> {
    const r = await this.fs.readText(this.path);
    if (!r) return emptyState();
    let raw: unknown;
    try { raw = JSON.parse(r.text); } catch { throw new PaException({ code: 'VALIDATION', message: 'Harness state file is invalid; not overwriting it' }); }
    return validate(raw);
  }

  async save(s: HarnessState): Promise<void> {
    validate(s);
    await this.fs.atomicWrite(this.path, JSON.stringify(s, null, 2));
  }

  async update(fn: (s: HarnessState) => HarnessState | void): Promise<HarnessState> {
    const cur = await this.load();
    const next = fn(cur) ?? cur;
    await this.save(next);
    return next;
  }

  async upsertProfile(p: HarnessProfile): Promise<void> {
    if (!PROFILE_ID_RE.test(p.id)) throw new PaException({ code: 'VALIDATION', message: 'Invalid profile id' });
    await this.update((s) => { s.profiles[p.id] = p; });
  }
}

export { HARNESS_IDS };
