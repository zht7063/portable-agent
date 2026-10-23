import { createHash } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';
import type { EnvFinding, EnvScanResult, HarnessId } from '../contract/harness.js';
import type { ExecFn } from './exec.js';

/**
 * §1.6 environment conflict detection (3 layers). Reports variable NAMES, sources and match status only.
 * Values are compared in memory via sha256 and never returned, logged or included in messages.
 */
export type EnvPolicy = 'must-match' | 'must-not-be-set' | 'info';
export interface WatchedVar { name: string; policy: EnvPolicy; /** Value our profile expects (must-match). Compared by hash only. */ expected?: string; harness?: HarnessId; hint?: string }

export const HARNESS_ENV_VARS: Record<HarnessId, WatchedVar[]> = {
  claude: [
    { name: 'ANTHROPIC_BASE_URL', policy: 'must-match' },
    { name: 'ANTHROPIC_AUTH_TOKEN', policy: 'must-not-be-set', hint: 'overrides apiKeyHelper' },
    { name: 'ANTHROPIC_API_KEY', policy: 'must-not-be-set', hint: 'takes precedence over apiKeyHelper and subscription login' },
    { name: 'ANTHROPIC_MODEL', policy: 'must-match' },
    { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', policy: 'must-match' },
    { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', policy: 'must-match' },
    { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', policy: 'must-match' },
    { name: 'ANTHROPIC_SMALL_FAST_MODEL', policy: 'info', hint: 'deprecated' },
    { name: 'CLAUDE_CONFIG_DIR', policy: 'info' },
    { name: 'ANTHROPIC_CUSTOM_HEADERS', policy: 'info' },
  ].map((v) => ({ ...v, harness: 'claude' as const })) as WatchedVar[],
  codex: [
    { name: 'CODEX_HOME', policy: 'info' },
    { name: 'OPENAI_API_KEY', policy: 'info' },
    { name: 'OPENAI_BASE_URL', policy: 'info', hint: 'may redirect the default provider' },
  ].map((v) => ({ ...v, harness: 'codex' as const })) as WatchedVar[],
  pi: [
    { name: 'PI_CODING_AGENT_DIR', policy: 'info' },
    // [unverified] Pi env fallbacks; confirmed in H1.
    { name: 'OPENAI_API_KEY', policy: 'info' },
  ].map((v) => ({ ...v, harness: 'pi' as const })) as WatchedVar[],
};

export const RC_FILES = ['.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile', '.config/fish/config.fish'];

export interface EnvScanDeps {
  processEnv: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
  exec: ExecFn;
  /** Read a text file (null if missing). Must be path-allowlisted by the caller. */
  readText(path: string): Promise<string | null>;
}
export interface EnvScanOptions { loginShell?: boolean; rcFiles?: boolean; timeoutMs?: number }

const h = (v: string) => createHash('sha256').update(v).digest('hex');
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function judge(w: WatchedVar, value: string | undefined): Pick<EnvFinding, 'matchesProfile' | 'severity'> {
  if (w.policy === 'must-not-be-set') return { severity: 'conflict', matchesProfile: false };
  if (w.policy === 'must-match' && w.expected !== undefined && value !== undefined) {
    const m = h(value) === h(w.expected);
    return { severity: m ? 'info' : 'conflict', matchesProfile: m };
  }
  return { severity: 'info' };
}
const msg = (w: WatchedVar, where: string, f: Pick<EnvFinding, 'matchesProfile' | 'severity'>) =>
  `${w.name} is set (${where})` + (f.matchesProfile === false && w.policy === 'must-match' ? ' and differs from the profile' : '') +
  (f.matchesProfile === true ? ' and matches the profile' : '') + (w.hint ? `: ${w.hint}` : '');

/** Parses `env -0` output, keeping only watched names (values stay local to this function's caller). */
export function parseEnv0(out: string, names: Set<string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const rec of out.split('\0')) {
    const i = rec.indexOf('=');
    if (i <= 0) continue;
    const n = rec.slice(0, i).replace(/^\s+/, '');
    if (names.has(n)) m.set(n, rec.slice(i + 1));
  }
  return m;
}

/** `reg query` output: "    NAME    REG_SZ    value". */
export function parseRegQuery(out: string, names: Set<string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const r = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
    if (r && names.has(r[1]!)) m.set(r[1]!, r[2]!);
  }
  return m;
}

function rcAssignRe(name: string): RegExp {
  return new RegExp(`^\\s*(?:(?:export|declare\\s+-x|typeset\\s+-x)\\s+)?${name}=|^\\s*set\\s+(?:-[A-Za-z]+\\s+)*${name}(?:\\s|$)|^\\s*setenv\\s+${name}(?:\\s|$)`);
}

function expandSourcePath(raw: string, home: string, from: string): string | null {
  const p = raw.replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (/[$`*?]/.test(p)) return null; // dynamic: skip
  return isAbsolute(p) ? p : join(from.replace(/[^/\\]+$/, ''), p);
}

export async function scanEnv(watch: WatchedVar[], d: EnvScanDeps, o: EnvScanOptions = {}): Promise<EnvScanResult> {
  const findings: EnvFinding[] = [];
  const skipped: EnvScanResult['skipped'] = [];
  const byName = new Map<string, WatchedVar>();
  for (const w of watch) if (NAME_RE.test(w.name) && !byName.has(w.name)) byName.set(w.name, w);
  const names = new Set(byName.keys());

  // 1) process env (unreliable for GUI apps launched from Dock on macOS).
  for (const [n, w] of byName) {
    const v = d.processEnv[n];
    if (v === undefined) continue;
    const j = judge(w, v);
    findings.push({ name: n, source: 'process', ...j, message: msg(w, 'in this process environment', j) });
  }

  // 2) login shell / Windows registry.
  if (o.loginShell !== false) {
    if (d.platform === 'win32') {
      for (const hive of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
        const r = await d.exec('reg', ['query', hive], { timeoutMs: o.timeoutMs ?? 3000 });
        if (r.code !== 0) { skipped.push({ layer: 'windows-registry', reason: r.timedOut ? 'timeout' : 'reg query failed' }); continue; }
        for (const [n, v] of parseRegQuery(r.stdout, names)) {
          const w = byName.get(n)!; const j = judge(w, v);
          findings.push({ name: n, source: 'windows-registry', location: hive.startsWith('HKCU') ? 'HKCU' : 'HKLM', ...j, message: msg(w, `in the ${hive.startsWith('HKCU') ? 'user' : 'system'} environment`, j) });
        }
      }
    } else {
      const shell = d.processEnv.SHELL;
      if (!shell || !isAbsolute(shell)) skipped.push({ layer: 'login-shell', reason: 'SHELL not set' });
      else {
        const fish = basename(shell) === 'fish';
        const env: Record<string, string> = { HOME: d.home, SHELL: shell, TERM: 'dumb', PATH: d.processEnv.PATH ?? '/usr/bin:/bin' };
        if (d.processEnv.USER) env.USER = d.processEnv.USER;
        const r = await d.exec(shell, [fish ? '-lic' : '-ilc', 'env -0'], { timeoutMs: o.timeoutMs ?? 3000, env });
        if (r.timedOut) skipped.push({ layer: 'login-shell', reason: 'timeout' });
        else if (r.code !== 0 && !r.stdout.includes('\0')) skipped.push({ layer: 'login-shell', reason: 'login shell failed' });
        else for (const [n, v] of parseEnv0(r.stdout, names)) {
          const w = byName.get(n)!; const j = judge(w, v);
          findings.push({ name: n, source: 'login-shell', ...j, message: msg(w, 'by your login shell', j) });
        }
      }
    }
  }

  // 3) rc file static scan (+ one level of `source`), to tell the user where to change it.
  if (o.rcFiles !== false && d.platform !== 'win32') {
    const visited = new Set<string>();
    const scanFile = async (path: string, depth: number) => {
      if (visited.has(path)) return;
      visited.add(path);
      let text: string | null = null;
      try { text = await d.readText(path); } catch { text = null; }
      if (text === null) return;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (/^\s*#/.test(line)) continue;
        for (const [n, w] of byName) {
          if (!rcAssignRe(n).test(line)) continue;
          const severity = w.policy === 'must-not-be-set' ? 'conflict' : 'info';
          findings.push({ name: n, source: 'rc-file', location: `${path}:${i + 1}`, severity, message: `${n} is assigned in ${basename(path)} line ${i + 1}` + (w.hint ? `: ${w.hint}` : '') });
        }
        const src = depth === 0 ? /^\s*(?:source|\.)\s+(\S+)/.exec(line) : null;
        if (src) { const p = expandSourcePath(src[1]!, d.home, path); if (p) await scanFile(p, depth + 1); }
      }
    };
    for (const f of RC_FILES) await scanFile(join(d.home, f), 0);
  }
  return { findings, skipped };
}
