/**
 * Owned-section TOML editing (plan §5.2). smol-toml (BSD-3-Clause) is used only to parse/validate and to render our
 * own sections; the user's text is edited at line level:
 *  - top-level keys (path length 1): the `key = value` line before the first table header is replaced/removed, or a
 *    new line is inserted right before the first table header;
 *  - tables (path length 2, e.g. model_providers.pa): every `[a.b]` / `[a.b.*]` section is cut out and our rendering
 *    is put where the first one was (or appended).
 * The result is re-parsed; owned values must match and everything else must be semantically unchanged, otherwise
 * nothing is written.
 */
import { parse, stringify } from 'smol-toml';
import { PaException } from '../../contract/errors.js';
import { canonicalJson } from '../state.js';
import { getPath, pruneEmptyParents, stripPaths } from './json.js';

export interface TomlEdit { path: string[]; value: unknown }
const fail = (message: string): never => { throw new PaException({ code: 'VALIDATION', message }); };

export function parseToml(text: string): Record<string, unknown> {
  if (text.trim() === '') return {};
  try { return JSON.parse(JSON.stringify(parse(text))) as Record<string, unknown>; } catch { return fail('config.toml is not valid TOML; not modified'); }
}

const HEADER = /^\s*\[\[?(.+?)\]\]?\s*(?:#.*)?$/;
/** Splits a TOML key (`a."b.c".d`) into parts. */
export function tomlKeyParts(k: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/gy;
  let m: RegExpExecArray | null;
  while ((m = re.exec(k)) && m[0] !== '') { out.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) as string : (m[2] ?? m[3])!); if (!m[4]) break; }
  return out;
}
const bareKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

function headerOf(line: string): string[] | null {
  const m = HEADER.exec(line);
  return m ? tomlKeyParts(m[1]!) : null;
}

/** "key = v  # note" -> "  # note" (only if cutting there still parses to the same thing). */
function trailingComment(line: string): string {
  const whole = canonicalJson(parse(line));
  for (let i = line.lastIndexOf('#'); i > 0; i = line.lastIndexOf('#', i - 1)) {
    try { if (canonicalJson(parse(line.slice(0, i))) === whole) return line.slice(line.slice(0, i).trimEnd().length); } catch { /* inside a string */ }
  }
  return '';
}
function renderScalar(key: string, value: unknown): string {
  return stringify({ [key]: value }).trim();
}
function renderTable(path: string[], value: unknown): string[] {
  let obj: unknown = value;
  for (let i = path.length - 1; i >= 0; i--) obj = { [path[i]!]: obj };
  return stringify(obj as Record<string, unknown>).replace(/\n+$/, '').split('\n');
}

function applyOne(lines: string[], e: TomlEdit): string[] {
  const first = lines.findIndex((l) => headerOf(l) !== null);
  const top = first < 0 ? lines.length : first;
  if (e.path.length === 1) {
    const k = e.path[0]!;
    const idx = lines.slice(0, top).findIndex((l) => {
      const m = /^\s*([^=#]+?)\s*=/.exec(l);
      return !!m && canonicalJson(tomlKeyParts(m[1]!)) === canonicalJson([k]);
    });
    if (idx >= 0) {
      try { parse(lines[idx]!); } catch { fail(`Top-level "${k}" spans several lines; edit it by hand`); }
      if (e.value === undefined) return [...lines.slice(0, idx), ...lines.slice(idx + 1)];
      return [...lines.slice(0, idx), renderScalar(bareKey(k), e.value) + trailingComment(lines[idx]!), ...lines.slice(idx + 1)];
    }
    if (e.value === undefined) return lines;
    // Insert after the last non-blank line of the top-level block (before the first header).
    let at = top;
    while (at > 0 && lines[at - 1]!.trim() === '') at--;
    const line = renderScalar(bareKey(k), e.value);
    const needGap = first >= 0 && at === first; // file starts with a table: keep a blank line before it
    return [...lines.slice(0, at), line, ...(needGap ? [''] : []), ...lines.slice(at)];
  }
  // Table replacement.
  const out: string[] = [];
  let insertAt = -1;
  let skipping = false;
  let cut: string[] = [];
  for (const l of lines) {
    const h = headerOf(l);
    if (h) {
      const next = e.path.every((p, i) => h[i] === p);
      if (skipping && !next) {
        // Comments right above the next header belong to it, not to the section we cut.
        let k = cut.length;
        while (k > 0 && /^\s*(#.*)?$/.test(cut[k - 1]!)) k--;
        out.push(...cut.slice(k));
      }
      if (next) cut = [];
      skipping = next;
    }
    if (h && skipping && insertAt < 0) insertAt = out.length;
    if (skipping) cut.push(l); else out.push(l);
  }
  if (e.value === undefined) { while (out.length > 1 && out[out.length - 1] === '' && out[out.length - 2] === '') out.pop(); return out; }
  const block = renderTable(e.path, e.value);
  if (insertAt < 0) {
    while (out.length && out[out.length - 1] === '') out.pop();
    return [...out, ...(out.length ? [''] : []), ...block, ''];
  }
  const tail = out.slice(insertAt);
  return [...out.slice(0, insertAt), ...block, ...(tail.length && tail[0]!.trim() !== '' ? [''] : []), ...tail];
}

export function mergeOwnedToml(text: string, edits: TomlEdit[]): string {
  for (const e of edits) if (e.path.length < 1 || e.path.length > 2) fail('Unsupported TOML edit');
  const before = parseToml(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = text === '' ? [] : text.split(/\r?\n/);
  for (const e of edits) lines = applyOne(lines, e);
  let out = lines.join(eol);
  if (out !== '' && !out.endsWith(eol)) out += eol;
  let after: Record<string, unknown>;
  try { after = parseToml(out); } catch { return fail('Merge verification failed (result is not valid TOML; e.g. the table is also defined inline); not writing'); }
  for (const e of edits) {
    if (canonicalJson(getPath(after, e.path) ?? null) !== canonicalJson(e.value ?? null)) fail('Merge verification failed (owned value mismatch); not writing');
  }
  const paths = edits.map((e) => e.path);
  if (canonicalJson(pruneEmptyParents(stripPaths(before, paths), paths)) !== canonicalJson(pruneEmptyParents(stripPaths(after, paths), paths))) {
    fail('Merge verification failed (non-owned content changed); not writing');
  }
  return out;
}
