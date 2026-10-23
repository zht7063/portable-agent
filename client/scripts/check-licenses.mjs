#!/usr/bin/env node
/* global process, console */
/**
 * License gate (plan §2, R11): every production dependency (transitively, incl. installed optional deps)
 * must be MIT / ISC / BSD / Apache-2.0 (or an SPDX expression satisfiable with those).
 * Dev dependencies are not shipped and are not checked.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD']);
/**
 * Packages that are installed but must NOT be shipped/loaded (documented in docs/harness.md):
 * the Linux @napi-rs/keyring binaries statically link libdbus (AFL-2.1 OR GPL-2.0-or-later); on Linux we use the
 * system `secret-tool` instead and packaging must exclude these binaries.
 */
const NOT_SHIPPED = [/^@napi-rs\/keyring-linux-/, /^@napi-rs\/keyring-freebsd-/];

export function spdxAllowed(expr) {
  const e = String(expr ?? '').trim().replace(/^\((.*)\)$/, '$1');
  if (!e) return false;
  if (/\s+OR\s+/i.test(e)) return e.split(/\s+OR\s+/i).some(spdxAllowed);
  if (/\s+AND\s+/i.test(e)) return e.split(/\s+AND\s+/i).every(spdxAllowed);
  return ALLOWED.has(e);
}

const workspaces = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces;
const seen = new Map();
const problems = [];
const warnings = [];

function resolvePkg(name, fromDir) {
  for (let d = fromDir; ; d = dirname(d)) {
    const p = join(d, 'node_modules', name, 'package.json');
    if (existsSync(p)) return p;
    if (dirname(d) === d) return null;
  }
}

function visit(name, fromDir, optional) {
  const pj = resolvePkg(name, fromDir);
  if (!pj) { if (!optional) problems.push(`${name}: not installed`); return; }
  if (seen.has(pj)) return;
  const pkg = JSON.parse(readFileSync(pj, 'utf8'));
  seen.set(pj, pkg);
  if (pkg.private && name.startsWith('@pa/')) { /* our own workspace */ }
  else {
    const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
    if (NOT_SHIPPED.some((r) => r.test(name))) warnings.push(`${name}@${pkg.version} (${lic}): installed but excluded from shipping (bundles libdbus AFL-2.1 OR GPL-2.0+)`);
    else if (!spdxAllowed(lic)) problems.push(`${name}@${pkg.version}: license "${lic ?? 'none'}" not allowed`);
  }
  const dir = dirname(pj);
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir, false);
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) visit(dep, dir, true);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const ws of workspaces) {
    const pkg = JSON.parse(readFileSync(join(root, ws, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, join(root, ws), false);
  }
  const listed = [...seen.values()].filter((p) => !p.name.startsWith('@pa/')).map((p) => `${p.name}@${p.version} ${typeof p.license === 'string' ? p.license : p.license?.type}`).sort();
  console.log(listed.join('\n'));
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (problems.length) { console.error(problems.map((p) => `license: ${p}`).join('\n')); process.exit(1); }
  console.log(`license check ok (${listed.length} production packages)`);
}
