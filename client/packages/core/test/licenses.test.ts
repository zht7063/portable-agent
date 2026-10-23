import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain .mjs script without types
import { spdxAllowed } from '../../../scripts/check-licenses.mjs';

describe('license gate (MIT/ISC/BSD/Apache-2.0 only)', () => {
  it('SPDX expressions', () => {
    expect(spdxAllowed('MIT')).toBe(true);
    expect(spdxAllowed('BSD-3-Clause')).toBe(true);
    expect(spdxAllowed('(MIT OR GPL-3.0)')).toBe(true);
    expect(spdxAllowed('MIT AND GPL-3.0')).toBe(false);
    expect(spdxAllowed('GPL-2.0-or-later')).toBe(false);
    expect(spdxAllowed('AFL-2.1')).toBe(false);
    expect(spdxAllowed(undefined)).toBe(false);
  });
  it('all installed production dependencies pass', () => {
    const script = fileURLToPath(new URL('../../../scripts/check-licenses.mjs', import.meta.url));
    expect(() => execFileSync(process.execPath, [script], { stdio: 'pipe' })).not.toThrow();
  });
});
