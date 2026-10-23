# Harness infrastructure (H0–H2)

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
  - Only `api: "openai-completions"` is offered. `anthropic-messages` is hidden (rejected by validation) until verified against real Pi.
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

## Claude Code adapter (H2)

Field names verified against code.claude.com/docs (settings reference, env vars, managed settings), 2026-10, and
exercised offline against Claude Code 2.1.309 (`harness-claude-e2e.test.ts`, opt-in).

- File: `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`). Strict JSON for Claude Code; we merge
  format-preservingly and never touch `~/.claude.json`.
- Owned settings:
  - `apiKeyHelper`: command mode `'<pa-key>' <profile> claude`; env mode `printf '%s' "$PA_API_KEY"` (Windows:
    `echo %VAR%`, unverified). Claude Code runs it via `/bin/sh` and sends stdout as **both** `X-Api-Key` and
    `Authorization: Bearer` (confirmed). Cached 5 min / re-run on 401/403.
  - `env.ANTHROPIC_BASE_URL`: server origin without `/v1` (Claude Code calls `POST /v1/messages?beta=true`).
  - `env.ANTHROPIC_MODEL` = `models.main` (skip with `claude.setModel: false`).
  - `env.ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_MODEL` = opus/sonnet or main; `env.ANTHROPIC_DEFAULT_HAIKU_MODEL`
    = haiku, else small, else main. (`ANTHROPIC_SMALL_FAST_MODEL` is deprecated and not written.)
- Never written: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` (no plaintext mode). If either is set in the shell or in
  `settings.json` `env` (presence only, value never shown), the plan warns: they override `apiKeyHelper`.
- Collisions (file not written by us before): an existing different `apiKeyHelper` or `env.ANTHROPIC_BASE_URL`.
  Previous values of the env keys are remembered for detach; a previous `apiKeyHelper` is **not** stored (it may embed
  a credential), so detach removes it.
- Read-only notes/warnings: managed settings (`/etc/claude-code/managed-settings.json` and `managed-settings.d/`,
  macOS `/Library/Application Support/ClaudeCode/`, Windows `C:\Program Files\ClaudeCode\`), project
  `.claude/settings.json` / `.claude/settings.local.json` in the cwd, and shell `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL`
  differing from ours.
- Keychain account: `<profile>/claude`. Desktop provisions it before writing; the CLI requires it to exist.

## Codex adapter (H3)

Field names verified against openai/codex source (commit 7d592f6, `codex-rs/model-provider-info/src/lib.rs`,
`protocol/src/config_types.rs`), and exercised with a real `@openai/codex` 0.164.0 binary offline.

Owned settings in `$CODEX_HOME/config.toml` (default `~/.codex`), edited with smol-toml + a line-preserving
merger (`merge/toml.ts`): comments, ordering and unrelated tables are kept; result is re-parsed and verified.

```toml
model = "<models.codex ?? models.main>"      # only when codex.setDefault = true (opt-in, H4 default false)
model_provider = "pa"                         # only when codex.setDefault = true

[model_providers.pa]
name = "Portable Agent"
base_url = "<serverUrl>/v1"
wire_api = "responses"                        # only value Codex accepts

[model_providers.pa.auth]                     # command mode: no shell, stdout = bearer
command = "/abs/path/pa-key"
args = [ "<profileId>", "codex" ]
# env mode instead: env_key = "PA_API_KEY"
```

- `auth` is mutually exclusive with `env_key` / `experimental_bearer_token` / `requires_openai_auth` (Codex
  validate()); plaintext mode is refused; built-in provider ids (openai, gcp, amazon-bedrock*, ollama, lmstudio,
  oss) cannot be used as the profile provider id.
- `auth.json` is only checked for existence; ChatGPT/API login is untouched. Detach restores only `model` /
  `model_provider`; the previous `[model_providers.<id>]` table is never snapshotted (could contain a token).
- Warnings: top-level `profile = ...` may override; project `.codex/config.toml`; env var not exported;
  the default (`setDefault` unset/false; UI checkbox "设为 Codex 默认" opts in) gives a `codex -c model_provider=pa -m <model>` hint.
- Server channel: the UI shows "服务端渠道未就绪" until probed. The probe (`harness:channel:probe`) is a GET
  `/v1/models` with the profile key in main; `model-listed` does **not** prove `/v1/responses` works. See
  `codex-responses-contract.md`.
- Opt-in E2E: `PA_HARNESS_E2E=1 CODEX_BIN=/path/codex npx vitest run packages/core/test/harness-codex-e2e.test.ts`.

## Local packaging (H4, no release)

`cd apps/desktop && npm run pack:dir` → `release/<platform>-unpacked/` via electron-builder 25 (MIT, devDependency).
`publish: null` plus `--publish never`; no tags, uploads or GitHub releases. Uses the locally installed Electron
(`electronDist`), so nothing is downloaded.

- `scripts/stage.mjs` builds a dependency-free app dir (`stage/`): esbuild/vite output only. `@napi-rs/keyring`
  (+ its platform binary) is staged **only for macOS/Windows targets**; `@napi-rs/keyring-linux-*` is never
  shipped (bundles libdbus, AFL-2.1 OR GPL-2.0+) and is also excluded in `electron-builder.yml`. Linux uses
  `secret-tool` or env mode.
- `dist/key-helper/**` and `node_modules/@napi-rs/**` are `asarUnpack`ed. On start the app (re)writes the
  `pa-key` wrapper (0700) into `<userData>/bin/`, pointing at the app's own executable with
  `ELECTRON_RUN_AS_NODE=1` and the unpacked `pa-key.cjs`.
- `xvfb-run -a npm run smoke:packaged` (temp HOME/userData): boots the packaged app, checks the wrapper exists and
  runs (clean non-zero exit, empty stdout without a keychain entry), and that no keyring-linux file is in the package.
- Re-applying harness configs is needed if the app is moved (wrapper path is absolute); the wrapper itself is
  rewritten on every start.

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
