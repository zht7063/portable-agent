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
