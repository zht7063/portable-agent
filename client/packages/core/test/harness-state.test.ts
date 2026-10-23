import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyChange, ControlledFs, emptyState, hashOwnedValues, nodeFsOps, StateStore, type ManagedFileState } from '@pa/core/harness';

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'pa-hstate-'));
  const fs = new ControlledFs({ ops: nodeFsOps, roots: [root], dataDir: join(root, 'data') });
  return { s: new StateStore(fs), fs, root };
}
const profile = { id: 'default', serverUrl: 'http://127.0.0.1:9', keyId: 3, models: { main: 'deepseek-flash' }, keyMode: 'command' as const };

describe('harness state (SSOT)', () => {
  it('missing -> empty; roundtrip; file has no secrets', async () => {
    const { s } = await store();
    expect(await s.load()).toEqual(emptyState());
    await s.upsertProfile(profile);
    expect((await s.load()).profiles.default).toEqual(profile);
    expect(await readFile(s.path, 'utf8')).not.toMatch(/sk-/);
  });
  it('rejects invalid profile ids', async () => {
    const { s } = await store();
    await expect(s.upsertProfile({ ...profile, id: '../x' })).rejects.toThrow(/profile id/);
  });
  it('corrupt state throws and is not overwritten', async () => {
    const { s } = await store();
    await mkdir(join(s.path, '..'), { recursive: true });
    await writeFile(s.path, '{not json');
    await expect(s.load()).rejects.toThrow(/invalid/);
    await expect(s.update(() => {})).rejects.toThrow(/invalid/);
    expect(await readFile(s.path, 'utf8')).toBe('{not json');
    await writeFile(s.path, JSON.stringify({ version: 2 }));
    await expect(s.load()).rejects.toThrow(/invalid/);
  });
});

describe('external change classification (§1.5)', () => {
  const fp = { sha256: 'a', mtimeMs: 1, size: 2 };
  const entry: ManagedFileState = { harness: 'claude', lastWritten: fp, ownedValuesHash: hashOwnedValues({ x: 1 }), ownedSettings: ['x'], updatedAt: '' };
  it('classifies', () => {
    expect(classifyChange(undefined, fp, null)).toBe('untracked');
    expect(classifyChange(entry, { ...fp, mtimeMs: 99 }, null)).toBe('clean');
    expect(classifyChange(entry, { ...fp, sha256: 'b' }, hashOwnedValues({ x: 1 }))).toBe('external-unowned');
    expect(classifyChange(entry, { ...fp, sha256: 'b' }, hashOwnedValues({ x: 2 }))).toBe('conflict');
    expect(classifyChange(entry, null, null)).toBe('conflict');
  });
  it('owned-values hash is key-order independent', () => {
    expect(hashOwnedValues({ a: 1, b: { c: 2, d: 3 } })).toBe(hashOwnedValues({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashOwnedValues({ a: 1 })).not.toBe(hashOwnedValues({ a: 2 }));
  });
});
