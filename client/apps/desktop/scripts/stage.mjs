/* global process, console */
// Stages a dependency-free app dir for electron-builder (local packaging only; never publishes).
// Everything is pre-bundled by esbuild/vite into dist/. The only runtime module is @napi-rs/keyring, staged for
// macOS/Windows targets only; @napi-rs/keyring-linux-* is never shipped (bundles libdbus, AFL-2.1 OR GPL-2.0+) —
// Linux uses secret-tool (libsecret-tools) or env mode.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const stage = join(app, 'stage');
const platform = process.env.PA_TARGET_PLATFORM ?? process.platform;
const arch = process.env.PA_TARGET_ARCH ?? process.arch;
const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const d of ['main', 'preload', 'key-helper', 'renderer']) {
  if (!existsSync(join(app, 'dist', d))) throw new Error(`dist/${d} missing; run npm run build first`);
  cpSync(join(app, 'dist', d), join(stage, 'dist', d), { recursive: true });
}
writeFileSync(join(stage, 'package.json'), JSON.stringify({
  name: 'portable-agent', productName: 'Portable Agent', version: pkg.version === '0.0.0' ? '0.0.1' : pkg.version,
  description: 'Portable Agent desktop client', author: 'Portable Agent', license: 'UNLICENSED', main: 'dist/main/index.cjs',
}, null, 2));

const staged = [];
if (platform === 'darwin' || platform === 'win32') {
  const req = createRequire(join(app, 'package.json'));
  const copy = (name) => {
    const src = dirname(req.resolve(`${name}/package.json`));
    const lic = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).license;
    if (lic !== 'MIT') throw new Error(`${name}: unexpected license ${lic}`);
    cpSync(src, join(stage, 'node_modules', ...name.split('/')), { recursive: true });
    staged.push(name);
  };
  copy('@napi-rs/keyring');
  const plat = { darwin: `darwin-${arch}`, win32: `win32-${arch}-msvc` }[platform];
  try { copy(`@napi-rs/keyring-${plat}`); } catch (e) { console.warn(`warning: @napi-rs/keyring-${plat} not installed (${e.message}); keychain will fall back to env mode`); }
}
console.log(`staged ${platform}-${arch}: native modules [${staged.join(', ') || 'none'}]`);
