/** Low-level file operations injected into the controlled fs layer (node impl in ./node.ts, fakes in tests). */
export interface FsStat { mtimeMs: number; size: number; mode: number; isFile: boolean; isDirectory: boolean }
export interface FsOps {
  readFile(path: string): Promise<Uint8Array>;
  /** Writes and fsyncs. */
  writeFile(path: string, data: Uint8Array, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Best-effort directory fsync (no-op where unsupported, e.g. Windows). */
  fsyncDir(path: string): Promise<void>;
  stat(path: string): Promise<FsStat | null>;
  chmod(path: string, mode: number): Promise<void>;
  mkdir(path: string, mode: number): Promise<void>;
  rm(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  /** Canonical absolute path of an existing path (symlinks resolved), or null. */
  realpath(path: string): Promise<string | null>;
}
