# M0 接口契约（client）

源码以 `packages/core/src/contract/` 为准，本文档只做说明。如果要修改契约，需要通知所有并行开发的参与方并一起评审。

## 1. 分层
- `packages/core`：纯 TS，不依赖 Electron / DOM，可以注入 `fetch`、`clock`、`TokenStore`。
- `packages/cli`：只用于开发和测试（**不打包进客户端**），使用 `FileTokenStore`。
- `apps/desktop`：Electron + React。所有 new-api 请求都在 main 进程中发出；renderer 只能通过 `window.pa`（preload + contextBridge）调用。

## 2. 会话接口（`contract/session.ts`）
- `SessionStatus = 'anonymous' | 'authenticated' | 'refreshing' | 'expired'`
- `SessionView`（UI 唯一能看到的会话信息）：`{ status, userId?, username?, accessExpiresAt?, storage: 'memory'|'file'|'safeStorage', serverUrl }`，**不含任何凭证**。
- `SessionManager`：`view()`、`getAccessToken()`（M1a：在过期前约 60 秒刷新，并发调用共享同一次刷新）、`onUnauthorized()`（收到 401 后刷新一次再重试）、`restore()`、`establish({accessToken, accessExpiresAt, stored})`、`clear()`、`onChange(listener)`。
- access JWT **只放在内存里**，不持久化。

## 3. TokenStore（可插拔）
```ts
interface StoredSession { serverUrl; refreshCookie; sid?; userId; username; sessionExpiresAt? }
interface TokenStore { kind; load(): Promise<StoredSession|null>; save(s): Promise<void>; clear(): Promise<void> }
```
| 实现 | 位置 | 说明 |
|---|---|---|
| `MemoryTokenStore` | core | 默认实现，也用于测试 |
| `FileTokenStore` | cli | 文件权限 0600，路径 `~/.config/portable-agent-cli/session.json`（可用 `PA_SESSION_FILE` 覆盖）；明文存储，仅供开发使用 |
| `SafeStorageTokenStore` | desktop main | 用 safeStorage 加密后存到 `userData/session.bin`；**safeStorage 不可用时降级为 Memory**（`storage:'memory'`，重启后需要重新登录） |

完整 sk key 由 core 中的 `KeyVault` 持有（M0 只有 `MemoryKeyVault`）。

## 4. Result / 错误
```ts
type Result<T> = { ok: true; data: T } | { ok: false; error: PaError };
interface PaError { code: PaErrorCode; message: string /* 已脱敏 */; status?: number; retryAfter?: number }
PaErrorCode = NETWORK | TIMEOUT | UNAUTHORIZED | SESSION_EXPIRED | RATE_LIMITED | SERVER
            | VALIDATION | INSUFFICIENT_QUOTA | CANCELLED | NOT_IMPLEMENTED
```
所有 invoke 通道都返回 `Result`，不会抛异常到 renderer。

## 5. Invoke 通道（renderer → main，`window.pa.invoke(channel, req)`）
| 通道 | req | res（data） |
|---|---|---|
| `auth:register` | `{username, password, email?, affCode?}` | `{}` |
| `auth:login` | `{username, password}` | `SessionView` |
| `auth:logout` / `auth:session` | `{}` | `SessionView` |
| `billing:balance` | `{}` | `{quota, usedQuota, usd, requestCount?}`（usd = quota/500000） |
| `billing:topupInfo` | `{}` | `{enableRedemption, paymentComplianceConfirmed}` |
| `billing:redeem` | `{code}` | `{added, quota}` |
| `models:list` | `{}` | `{id}[]` |
| `keys:list` | `{}` | `KeySummary[]`（只有 `maskedKey`，另有 `stored` 表示本地是否保存了完整 key） |
| `keys:create` / `keys:update` | `KeyCreateReq` / `KeyUpdateReq` | `KeySummary` |
| `keys:delete` | `{id}` | `{}` |
| `keys:copy` | `{id}` | `{}`：在 main 中把完整 key 复制到剪贴板。**默认推荐用这个** |
| `keys:reveal` | `{id, confirm: true}` | `{id, secret}`：**唯一的凭证例外**，只能由用户的显式“显示”操作触发；main 会检查 `confirm===true` |
| `chat:complete` | `ChatReq {model, messages, maxTokens?(默认 2048), keyId?, temperature?}` | `ChatRes {content, reasoning?, finishReason, usage?, warning?: 'TRUNCATED_EMPTY_CONTENT'}` |
| `chat:stream:start` | `ChatReq & {reqId}` | `{reqId}`，之后通过事件推送内容 |
| `chat:stream:cancel` | `{reqId}` | `{}` |
| `config:get` / `config:set` | `{}` / `{serverUrl?, defaultMaxTokens?}` | `{serverUrl, defaultMaxTokens, insecureTransport}` |

## 6. 事件（main → renderer，`window.pa.on(channel, cb)`，返回取消订阅函数）
- `session:changed` → `SessionView`
- `chat:stream:event` → 以下几种之一：
  - `{reqId, type:'reasoning', delta}`（来自 `reasoning_content`）
  - `{reqId, type:'content', delta}`
  - `{reqId, type:'usage', usage:{promptTokens, completionTokens, totalTokens}}`
  - `{reqId, type:'done', finishReason, warning?}`
  - `{reqId, type:'error', error: PaError}`

## 7. 凭证防线
1. **类型层面**：`test/ipc-contract.test.ts` 检查所有 invoke 响应（`keys:reveal` 除外）和事件中，没有 `ForbiddenField`（如 accessToken / refreshCookie / cookie / token / key / secret / password / proof 等）。
2. **运行时**：main 的 `dispatch()` 对每个响应调用 `findCredentialLeaks()`，检查字段名，以及看起来像 `sk-…` / `nap_…` / JWT 的字符串值；发现就拦截，返回 `SERVER` 错误。
3. **窗口**：`contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`，禁止页面跳转和弹出新窗口，拒绝所有权限请求；CSP 设置 `connect-src 'none'`（renderer 不能直接联网）。preload 只放行白名单中的通道。

## 8. M1 实现备注
- 刷新：access token 在 `access_expires_at` 前 60 秒主动刷新，主动刷新间隔不少于 30 秒（rc.46 刷新后不一定延长过期时间）；收到 401 时刷新一次再重试；并发请求共用同一次刷新。刷新时带上 Cookie `new_api_refresh` 和 `X-Auth-Session: sid`，保存服务器轮换后的新 cookie。服务器拒绝刷新时清空会话；如果是网络错误，保留已存储的会话，稍后再试。
- keys:create：服务器的新建接口不返回 key，所以新建前后各取一次列表，对比找出新 id，再取回完整 key 存入 KeyVault。update 时先合并当前对象，并且不回传打码后的 key。
- chat：默认 `max_tokens=2048`；流式请求带 `stream_options.include_usage`；`finish_reason=length` 且正文为空时，返回 `warning:'TRUNCATED_EMPTY_CONTENT'`；`chat.stream` 不抛异常，错误和取消都通过 `type:'error'` 事件返回。
- 错误映射：401/403 → UNAUTHORIZED；429 → RATE_LIMITED（带 retryAfter）；400/422 或 `success:false` → VALIDATION；消息中含 quota/额度/余额 → INSUFFICIENT_QUOTA；超时 → TIMEOUT；fetch 失败 → NETWORK。所有错误 message 都经过 `redact()` 脱敏。
- Live 测试：运行 `npm run test:live`，需要设置 `PA_LIVE=1 PA_USER PA_PASS`；兑换码测试还需要 `PA_LIVE_REDEEM=1` 和 `NEWAPI_REDEEM_CODE_2`（兑换码会被消耗，最多运行一次）。
