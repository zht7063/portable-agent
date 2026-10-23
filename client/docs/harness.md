# Harness infrastructure (H0)

## Layers
- `@pa/core/contract/harness` — adapter contract, DTOs (no credential fields; diff entries use `setting`).
- `@pa/core/harness/fs` — ControlledFs: path allowlist (symlink-escape aware), sha256+mtime+size fingerprints,
  atomic write (same-dir temp + fsync + rename, fingerprint re-check before rename, mode preserved; new files 0600, dirs 0700),
  backups: one-time first-write backup + rolling snapshots (N=10), stored 0700/0600 under `<dataDir>/harness/backups`.
- `state.ts` — single source of truth `<dataDir>/harness/state.json`; stores hashes of owned values only.
  Change classification: untracked / clean / external-unowned / conflict. Corrupt state is never overwritten.
- `merge/json.ts` — format-preserving JSONC merge of owned paths only (comments, indentation, trailing commas kept; verified semantically).
- `env-scan.ts` — three layers: process env, login shell (`$SHELL -ilc 'env -0'`, 3s timeout; Windows `reg query`), rc files (one level of `source`). Values compared by hash, never output.

## Rollback
`harness:rollback` / `pa harness rollback [--first-write] --yes` restores the latest snapshot or the first-write backup. Apply and rollback need explicit confirmation over IPC.

## Keys
- One keychain entry per harness: service `portable-agent`, account `<profileId>/<harness>`.
- macOS/Windows: `@napi-rs/keyring`. Linux: system `secret-tool` (libsecret), secret on stdin only.
- If there is no Secret Service, we fall back to **env-var mode**, never to plaintext files.
- `pa-key` is installed at `<userData>/bin/pa-key` (a sh/cmd wrapper that runs Electron as node on `dist/key-helper/pa-key.cjs`), and harness configs reference that absolute path. It prints the key without a newline. Exit codes: 2 usage, 3 not found, 4 keychain unavailable.
- The renderer never receives credentials.

### Why not @napi-rs/keyring on Linux
- Without D-Bus it silently uses kernel keyutils, which does not persist across reboots.
- Its Linux binaries statically link libdbus (AFL-2.1 OR GPL-2.0+).
- **H4 packaging must exclude `@napi-rs/keyring-linux-*`** (`npm run licenses` warns about them).

## Attribution
Design ideas (owned-key merge, backups) were inspired by cc-switch (MIT). We used its design only, no code.
