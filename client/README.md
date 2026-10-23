# Portable Agent client (prototype)

npm workspaces:

| Package | What it is |
|---|---|
| `packages/core` (`@pa/core`) | Framework-free TS modules: auth/session, billing, models, keys, chat (SSE), config validation. All network I/O lives here. |
| `packages/cli` (`@pa/cli`) | `pa` dev/test CLI on top of core. **Not packaged / not shipped.** |
| `apps/desktop` (`@pa/desktop`) | Electron 33 + React 18. Main process owns core; renderer talks only via `window.pa` IPC. |

Requires Node ≥ 22.

## Develop / build

```bash
cd client
npm install
npm run typecheck        # all workspaces
npm run lint             # eslint .
npm test                 # unit + component tests (vitest, jsdom for UI; no network)

# desktop
npm run build -w @pa/desktop     # esbuild main/preload + vite renderer → apps/desktop/dist
npm run start -w @pa/desktop     # build + launch Electron
npm run smoke -w @pa/desktop     # build + headless-ish Electron smoke test (temp userData, no network writes)
```

Running as root or in a container: Electron needs `--no-sandbox` (`npx electron . --no-sandbox`; the smoke script
adds it automatically for root or when `PA_SMOKE_NO_SANDBOX=1`). Without a display use `xvfb-run npm run smoke -w @pa/desktop`.

## Server URL

Default: `http://38.246.253.190:3000` (rain, new-api rc.46).

**Desktop**
- UI: “服务器设置” → edit URL → 保存. Changing the URL logs you out (session cleared) and rebuilds the core against the new server.
- Persisted in `<userData>/config.json` (`{ "version": 1, "serverUrl": "...", "defaultMaxTokens": 2048 }`, mode 0600).
  `userData` is Electron's per-user dir, e.g. Linux `~/.config/@pa/desktop/`, macOS `~/Library/Application Support/@pa/desktop/`, Windows `%APPDATA%\@pa\desktop\`.
- `PA_SERVER_URL` only seeds the default when no config.json exists. Invalid files/fields fall back to defaults.
- Validation: http/https only; no credentials, query or fragment; trailing slashes stripped.

**CLI**
```bash
npm run dev -w @pa/cli -- config get              # saved + effective URL
npm run dev -w @pa/cli -- config set-url https://example.com   # clears CLI session/keys if URL changed
npm run dev -w @pa/cli -- config reset
```
Precedence: `PA_SERVER_URL` env > saved `config.json` > default. CLI state lives in `~/.config/portable-agent-cli/`
(override with `PA_CLI_DIR`); session/key files are 0600.

## CLI usage and live tests

```bash
npm run dev -w @pa/cli -- help
PA_USER=... PA_PASS=... npm run dev -w @pa/cli -- login
npm run dev -w @pa/cli -- balance | models | keys ls | chat --stream --key <id> --model deepseek-flash "hi"
```
Credentials are read from env only, never from argv, and never printed.

Live suite (`test/live`, **skipped unless enabled**, talks to the real server):

```bash
PA_LIVE=1 PA_USER=<test user> PA_PASS=<password> [PA_SERVER_URL=...] npm run test:live
```

| Env | Meaning |
|---|---|
| `PA_LIVE=1` | enable live tests |
| `PA_USER`, `PA_PASS` | **test account** credentials (keep in a 0600 file, load via env; never commit) |
| `PA_SERVER_URL` | optional override |
| `PA_LIVE_REDEEM=1` + `NEWAPI_REDEEM_CODE_2` | also run the redeem step |

> ⚠️ **Redeem codes are one-time.** `PA_LIVE_REDEEM=1` consumes the code permanently — only enable it with explicit
> approval, run it at most once, and never retry an ambiguous failure (check the balance instead).
> register/login/redeem share an IP rate limit of ~20 per 20 min; the suite uses ~4. The suite creates a key and deletes it at the end.

## Security notes

- **Prototype.** Default transport is plain HTTP; the UI shows a permanent warning banner. Use test accounts only.
- **The renderer never obtains credentials**: access token, refresh cookie and full `sk-` keys stay in the main process.
  The only exception is the explicit **显示 (reveal)** action, which requires a confirm dialog and sends `confirm: true`.
  **复制 (copy)** is the primary path: main writes the key to the clipboard without sending it to the renderer.
  Every IPC response passes a credential-leak guard.
- IPC sender check: main only answers requests from the **top frame of our own window showing the bundled
  `file://…/renderer/index.html`**; anything else (iframes, other windows/webContents, navigated pages) gets `UNAUTHORIZED`.
- Sessions end only when refresh is explicitly rejected (HTTP 401/403); 5xx, network errors, timeouts and rate limits keep you logged in.
- Every error message shown in the UI or printed by the CLI is redacted (URLs/hosts/IPs, Bearer/cookies, `sk-`/`nap_`/JWT and long opaque tokens).
- Chat requests have a first-byte timeout (default 60s) and idle timeout (default 90s, between stream chunks), configurable via
  `createCore({ chatTimeouts })`; expiry aborts the request and reports `TIMEOUT`.
- Electron: `contextIsolation`, `sandbox`, no `nodeIntegration`, navigation/new windows blocked, permissions denied.
- Session storage: OS keychain via `safeStorage` when available, otherwise **memory-only** (log in again after restart).
- See `docs/contracts.md` for the IPC/error contract.
