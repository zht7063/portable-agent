import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const app = join(__dirname, '..');
const built = existsSync(join(app, 'dist', 'main', 'index.cjs')) && existsSync(join(app, 'dist', 'renderer'));

describe('local packaging config (H4)', () => {
  it('never publishes and never ships @napi-rs/keyring-linux-*', () => {
    const yml = readFileSync(join(app, 'electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/^publish: null$/m);
    expect(yml).toContain('"!node_modules/@napi-rs/keyring-linux-*/**"');
    expect(yml).toMatch(/asarUnpack:\n\s+- dist\/key-helper\/\*\*/);
    const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const s of Object.values(pkg.scripts)) if (s.includes('electron-builder')) expect(s).toContain('--publish never');
  });

  it.skipIf(!built)('stage: linux has no native modules; darwin stages only @napi-rs/keyring(+darwin binary)', () => {
    const run = (platform: string) => spawnSync(process.execPath, ['scripts/stage.mjs'], { cwd: app, env: { ...process.env, PA_TARGET_PLATFORM: platform, PA_TARGET_ARCH: 'arm64' }, encoding: 'utf8' });
    const l = run('linux');
    expect(l.status).toBe(0);
    expect(existsSync(join(app, 'stage', 'node_modules'))).toBe(false);
    const d = run('darwin');
    expect(d.status).toBe(0);
    const mods = readdirSync(join(app, 'stage', 'node_modules', '@napi-rs'));
    expect(mods).toContain('keyring');
    expect(mods.some((m) => m.startsWith('keyring-linux'))).toBe(false);
    const sp = JSON.parse(readFileSync(join(app, 'stage', 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(sp).not.toHaveProperty('dependencies');
    expect(sp.main).toBe('dist/main/index.cjs');
    run('linux');
  });
});
