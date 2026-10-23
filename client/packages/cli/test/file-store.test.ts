import { describe, expect, it } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTokenStore } from '../src/stores/file.js';

describe('FileTokenStore', () => {
  it('round-trips with 0600 perms and clears', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pa-'));
    const s = new FileTokenStore(join(dir, 'sub', 's.json'));
    expect(await s.load()).toBeNull();
    const v = { serverUrl: 'http://x', refreshCookie: 'c', userId: 1, username: 'u' };
    await s.save(v);
    expect(await s.load()).toEqual(v);
    expect((await stat(s.path)).mode & 0o777).toBe(0o600);
    await s.clear();
    expect(await s.load()).toBeNull();
  });
});

import { FileKeyVault } from '../src/stores/file.js';
describe('FileKeyVault', () => {
  it('set/get/delete with 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pa-'));
    const v = new FileKeyVault(join(dir, 'k.json'));
    expect(await v.get(1)).toBeNull();
    await v.set(1, 'sk-x');
    expect(await v.has(1)).toBe(true);
    expect((await stat(v.path)).mode & 0o777).toBe(0o600);
    await v.delete(1);
    expect(await v.get(1)).toBeNull();
  });
});
