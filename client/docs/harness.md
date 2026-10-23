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

## Pi adapter (H1)
Owned settings (checked against the pi docs and tested against pi 1.4.0, `@earendil-works/pi-coding-agent`, MIT):
- `<PI_CODING_AGENT_DIR or ~/.pi/agent>/models.json`: `providers.<providerId>` (default `pa`), the whole object:
  `{ baseUrl: "<server>/v1", api: "openai-completions", apiKey, models: [{ id, reasoning? }] }`.
  - With `api: "anthropic-messages"`, baseUrl is the bare server origin (not verified live yet).
- `settings.json`: `defaultProvider` and `defaultModel` (skipped when `pi.setDefault === false`). The user's previous values are stored in state and restored by detach.
- `apiKey`:
  - command mode: `!'<abs pa-key path>' <profileId> pi` (shell-quoted). Pi runs it for each request and does not cache it.
  - env mode: `$PA_API_KEY` (name configurable).
  - plaintext mode is refused.
- `auth.json` is never read. If it exists, we warn: Pi gives credentials stored in auth.json precedence over models.json.
- Project-level `.pi/` is only reported, never written.
- Conflicts:
  - An existing provider with the same id that we did not write is a `name-collision`.
  - Our settings edited outside the app are an `external-owned-change`.
  - Both need an explicit `overwrite` or `keep-external`.
  - Edits to anything else in the file are merged and reported.
- Apply re-plans from the stored profile. The plan passed in is trusted only for its fingerprints, so a stale plan is rejected.
- In command mode, desktop provisions the keychain entry before writing. With no keychain it refuses, and the user switches to env mode.
- Opt-in offline E2E: `PA_HARNESS_E2E=1 PI_BIN=<pi> npx vitest run packages/core/test/harness-pi-e2e.test.ts`. It uses a fake local server, never rain.

## Linux runtime dependency
`secret-tool` (Debian/Ubuntu package `libsecret-tools`) and a running Secret Service (GNOME Keyring or KWallet) are needed for command key mode on Linux. Without them the client falls back to env key mode.

## Rollback
`harness:rollback` / `pa harness rollback [--first-write | --detach | --snapshot <id>] --yes`:
- `last` restores the snapshot taken before the latest apply, along with its state. Repeating it walks back further.
- `first-write` restores the original files.
- `detach` removes only our settings and restores the previous defaults. It is refused if those settings were edited outside the app.
- Every rollback snapshots the current files first. Apply and rollback need explicit confirmation over IPC.

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
