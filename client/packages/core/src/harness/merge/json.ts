import { applyEdits, modify, parse, printParseErrorCode, type FormattingOptions, type JSONPath, type ParseError } from 'jsonc-parser';
import { PaException } from '../../contract/errors.js';
import { canonicalJson } from '../state.js';

/** One owned setting: value undefined = remove it. */
export interface JsonEdit { path: JSONPath; value: unknown }

const fail = (message: string): never => { throw new PaException({ code: 'VALIDATION', message }); };

export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const v = parse(text.trim() === '' ? '{}' : text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) fail(`Config is not valid JSON (${printParseErrorCode(errors[0]!.error)} at offset ${errors[0]!.offset}); not modifying it`);
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('Config root must be a JSON object; not modifying it');
  return v;
}

export function getPath(root: unknown, path: JSONPath): unknown {
  let cur = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg as string | number];
  }
  return cur;
}

export const readJsonPaths = (text: string, paths: JSONPath[]): unknown[] => { const root = parseJsonc(text); return paths.map((p) => getPath(root, p)); };

function detectFormatting(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = /\n([ \t]+)\S/.exec(text);
  const indent = m?.[1] ?? '  ';
  return indent.startsWith('\t') ? { insertSpaces: false, tabSize: 1, eol } : { insertSpaces: true, tabSize: indent.length, eol };
}

/** Deep copy with all owned paths deleted (for "non-owned parts unchanged" check). */
export function stripPaths(root: unknown, paths: JSONPath[]): unknown {
  const copy = JSON.parse(JSON.stringify(root)) as unknown;
  for (const p of paths) {
    const parent = getPath(copy, p.slice(0, -1));
    if (parent && typeof parent === 'object') delete (parent as Record<string | number, unknown>)[p[p.length - 1] as string | number];
  }
  return copy;
}

/** Drops objects left empty by owned-path deletion along the given paths (both sides, so comparison is fair). */
export function pruneEmptyParents(root: unknown, paths: JSONPath[]): unknown {
  for (const p of paths) {
    for (let i = p.length - 1; i > 0; i--) {
      const parent = getPath(root, p.slice(0, i - 1));
      const node = getPath(root, p.slice(0, i));
      if (node && typeof node === 'object' && !Array.isArray(node) && Object.keys(node).length === 0 && parent && typeof parent === 'object') {
        delete (parent as Record<string | number, unknown>)[p[i - 1] as string | number];
      }
    }
  }
  return root;
}

const unitOf = (f: FormattingOptions) => (f.insertSpaces ? ' '.repeat(f.tabSize ?? 2) : '\t');
const lineStart = (t: string, i: number) => t.lastIndexOf('\n', i - 1) + 1;
const lineEnd = (t: string, i: number) => { const n = t.indexOf('\n', i); return n < 0 ? t.length : t[n - 1] === '\r' ? n - 1 : n; };
/** Strips // and /* *\/ comments and whitespace (for "is the rest of this line empty?" checks). */
const bare = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '').trim();
function stringifyAt(value: unknown, indent: string, f: FormattingOptions): string {
  return JSON.stringify(value, null, unitOf(f)).split('\n').join((f.eol ?? '\n') + indent);
}

/**
 * Applies one edit while touching as little text as possible: jsonc-parser's own formatting reflows whole lines
 * (neighbouring properties, trailing comments), so we place inserts/replacements ourselves and only fall back to
 * jsonc formatting for shapes we do not handle (inline objects, empty objects).
 */
function applyOne(text: string, e: JsonEdit, fmt: FormattingOptions): string {
  const fallback = () => applyEdits(text, modify(text, e.path, e.value, { formattingOptions: fmt }));
  const raw = modify(text, e.path, e.value, {});
  if (raw.length !== 1) return fallback();
  // A missing parent means jsonc inserts a whole nested object; let it format that itself.
  const parent = e.path.length > 1 ? getPath(parseJsonc(text), e.path.slice(0, -1)) : {};
  if (parent === null || typeof parent !== 'object') return fallback();
  const ed = raw[0]!;
  const ls = lineStart(text, ed.offset);
  const indent = /^[ \t]*/.exec(text.slice(ls))![0];
  if (ed.content === '') {
    // Removal: drop the line too if nothing else remains on it.
    const removed = text.slice(ed.offset, ed.offset + ed.length);
    const nl = removed.indexOf('\n');
    // "<prev>, // comment\n  "ours": v" -> keep the comment that belonged to the previous line (first line only;
    // a multi-line removed value must not leak back in).
    const head = removed.startsWith(',') && nl > 0 ? removed.slice(1, nl).replace(/\r$/, '') : '';
    const keep = head && bare(head) === '' ? head : '';
    let out = text.slice(0, ed.offset) + keep + text.slice(ed.offset + ed.length);
    const s = lineStart(out, ed.offset); const en = lineEnd(out, ed.offset);
    if (out.slice(s, en).trim() === '') {
      const nl = out.indexOf('\n', en);
      out = out.slice(0, s) + out.slice(nl < 0 ? en : nl + 1);
    }
    return out;
  }
  if (ed.length > 0) return text.slice(0, ed.offset) + stringifyAt(e.value, indent, fmt) + text.slice(ed.offset + ed.length);
  if (!ed.content.startsWith(',')) return fallback();
  // Insertion after the previous property: must be on its own line with nothing but comments after it.
  if (!/^[ \t]*"/.test(text.slice(ls))) return fallback();
  const le = lineEnd(text, ed.offset);
  const rest = bare(text.slice(ed.offset, le));
  if (rest !== '' && rest !== ',') return fallback();
  const name = e.path[e.path.length - 1];
  if (typeof name !== 'string') return fallback();
  const prop = `${fmt.eol ?? '\n'}${indent}${JSON.stringify(name)}: ${stringifyAt(e.value, indent, fmt)}`;
  // Trailing-comma style (JSONC): the comma already follows the previous property; keep the style for ours.
  if (rest === ',') return `${text.slice(0, le)}${prop},${text.slice(le)}`;
  return `${text.slice(0, ed.offset)},${text.slice(ed.offset, le)}${prop}${text.slice(le)}`;
}

/**
 * Format-preserving merge of owned settings into JSON/JSONC text (comments, indentation, key order kept).
 * Verifies: result parses, owned values equal the requested ones, and everything else is semantically unchanged.
 */
export function mergeOwnedJson(text: string, edits: JsonEdit[]): string {
  const base = text.trim() === '' ? '{}' : text;
  const before = parseJsonc(base);
  const fmt = detectFormatting(base);
  let out = base;
  for (const e of edits) out = applyOne(out, e, fmt);
  if (text.trim() === '' && !out.endsWith(fmt.eol ?? '\n')) out += fmt.eol ?? '\n';
  const after = parseJsonc(out);
  for (const e of edits) {
    if (canonicalJson(getPath(after, e.path)) !== canonicalJson(e.value)) fail('Merge verification failed (owned value mismatch); not writing');
  }
  const paths = edits.map((e) => e.path);
  const a = pruneEmptyParents(stripPaths(before, paths), paths);
  const b = pruneEmptyParents(stripPaths(after, paths), paths);
  if (canonicalJson(a) !== canonicalJson(b)) fail('Merge verification failed (non-owned content changed); not writing');
  return out;
}
