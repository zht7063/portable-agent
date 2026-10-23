import { chmod, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import type { FsOps } from './ops.js';

export const nodeFsOps: FsOps = {
  readFile: async (p) => new Uint8Array(await readFile(p)),
  async writeFile(p, data, mode) {
    const fh = await open(p, 'wx', mode);
    try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
    await chmod(p, mode); // umask may have narrowed/widened mode at creation
  },
  rename: (a, b) => rename(a, b),
  async fsyncDir(p) {
    if (process.platform === 'win32') return;
    try { const fh = await open(p, 'r'); try { await fh.sync(); } finally { await fh.close(); } } catch { /* best effort */ }
  },
  async stat(p) {
    try { const s = await stat(p); return { mtimeMs: s.mtimeMs, size: s.size, mode: s.mode & 0o7777, isFile: s.isFile(), isDirectory: s.isDirectory() }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  },
  chmod: (p, m) => chmod(p, m),
  mkdir: async (p, m) => { await mkdir(p, { recursive: true, mode: m }); },
  rm: (p) => rm(p, { force: true, recursive: true }),
  readdir: async (p) => { try { return await readdir(p); } catch { return []; } },
  realpath: async (p) => { try { return await realpath(p); } catch { return null; } },
};
