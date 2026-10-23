# portable-agent client（原型）

Electron + React + TypeScript 客户端，对接 new-api（rc.46）。设计见 `docs/contracts.md`。

```bash
# Node 22
npm install            # 如果 Electron 二进制下载失败：ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
npm run typecheck && npm run lint && npm test
npm run start -w @pa/desktop     # 构建并启动 Electron
npm run dev -w @pa/cli -- status # 开发用 CLI
```
- 默认服务器 `http://38.246.253.190:3000`，可用 `PA_SERVER_URL` 覆盖。原型使用明文 HTTP，只能用测试账号。
- 测试凭证只放在 `.env.local` 或环境变量里（见 `.env.example`），**不要提交**。
- 当前进度：M0（接口、脚手架、模块 stub）。
