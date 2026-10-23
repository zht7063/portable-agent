import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliConfig } from '../src/config.js';
import { FileTokenStore } from '../src/stores/file.js';
import { effectiveUrl, main } from '../src/index.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('CLI config', () => {
  it('precedence: env > saved > default; invalid saved ignored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pa-cli-'));
    const c = new CliConfig(join(dir, 'config.json'));
    vi.stubEnv('PA_SERVER_URL', '');
    delete process.env.PA_SERVER_URL;
    expect(await effectiveUrl(c)).toBe('http://38.246.253.190:3000');
    await c.save({ serverUrl: 'https://saved.example/' });
    expect(await effectiveUrl(c)).toBe('https://saved.example');
    vi.stubEnv('PA_SERVER_URL', 'http://env.example:3000');
    expect(await effectiveUrl(c)).toBe('http://env.example:3000');
    await writeFile(c.path, JSON.stringify({ serverUrl: 'ftp://bad' }));
    expect(await c.load()).toEqual({});
  });

  it('`config set-url` persists, clears session on change; rejects invalid URL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pa-cli-'));
    vi.stubEnv('PA_CLI_DIR', dir);
    delete process.env.PA_SERVER_URL;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new FileTokenStore(join(dir, 'session.json'));
    await store.save({ serverUrl: 'http://38.246.253.190:3000', refreshCookie: 'c', userId: 1, username: 'u' });
    expect(await main(['config', 'set-url', 'https://new.example/'])).toBe(0);
    expect((await new CliConfig(join(dir, 'config.json')).load()).serverUrl).toBe('https://new.example');
    expect(await store.load()).toBeNull();
    await expect(main(['config', 'set-url', 'nope'])).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
    expect(await main(['config', 'reset'])).toBe(0);
    expect(await new CliConfig(join(dir, 'config.json')).load()).toEqual({});
  });
});
