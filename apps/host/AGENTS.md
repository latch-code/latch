# @latch/host

Host 的组合根：监听入口与 HTTP/SSE、设备与本机确认、策略、审计、出站、路径、HarnessHub、模型服务、内置插件，以及启动、停止、`pnpm latch`、桌面启动器与构建脚本。不负责浏览器界面、Electron 壳与 ACP Driver。

| 路径 | 职责 |
| --- | --- |
| `src/server.ts`、`listeners.ts`、`access.ts`、`http-util.ts` | HTTP API 与 SSE；监听入口与 `ListenerContext`；凭据、Cookie 与限速；请求体与 CSP |
| `src/auth.ts`、`presence.ts`、`audit.ts`、`policy.ts`、`egress.ts`、`risk.ts`、`paths.ts` | 设备与登记；本机确认 `PresenceService`；审计；`policy.json`；出站策略；风险分级；路径与 `latchCodeRoot()` |
| `src/host-state.ts`、`crypto.ts`、`identity.ts`、`hub.ts`、`config.ts`、`providers.ts` | `host.json` 与 `host.lock`；base32 与 P-256；Host 身份；`HarnessHub`；配置与模型服务 |
| `src/plugins/<种类>/<id>/` | 内置插件：`providers/{openai-compatible,anthropic,demo}`（共用 `src/plugins/providers/http.ts`）、`tools/{workspace-files,safe-tools}`、`standard` |
| `scripts/` | `start`、`stop`、`latch`、`shutdown`；桌面启动器 `desktop`、`desktop-host`；构建 `build`、`host-bundle`、`build-presence`、`presence-helper` |
| `test/` | `pnpm test --project @latch/host`；`test/helpers/host.ts`（`startTestHost`）与 `e2e/helpers/host.ts`、`apps/desktop/test/helpers/host.ts` 保持一致 |

运行环境 node；依赖 protocol、sdk、core 与 harness-acp，测试另用 testkit；`exports` 只列出其他项目用到的模块。

不变量：

- 请求上下文只来自监听入口：从不读取代理请求头（`forwarded`、`x-forwarded-*` 等），入口类别、来源与凭据形式由接受连接的 `ListenerContext` 决定（`test/server.test.ts#rejects cross-site origins on TCP, ignores the Host header on the socket, and never reads proxy headers`）。
- 先审计再执行：授予或执行权限的操作先写审计，写入失败就不执行；撤销、拒绝、取消、删除、移除权限与收紧策略从不因审计失败受阻，响应改带 `x-latch-audit: failed`。审计 detail 只含 ID、哈希、枚举、布尔与计数（`test/server.test.ts#refuses privilege-granting actions when the audit log fails and still applies revocations`）。
- 出站只经注入的 `fetch`：内置模型协议只用 Host 传入的出站策略 `fetch`；密钥只发往保存时绑定的 `keyOrigin`，地址的源改变后视为没有密钥（`test/providers.test.ts#uses a saved key only at the origin it was saved for`）。
- Standard 风险由 Host 判定：`classifyStandardCall` 决定 R0/R1/R2，插件声明的 `requiresApproval` 不能降低风险，未列出的工具（含第三方插件工具）为 R2，分级器抛错或返回未知值按 R2 处理（`test/risk.test.ts#makes unlisted and third-party tools R2 regardless of what they declare`）。
- 插件目录只用 `@latch/sdk`、`@latch/protocol`、本目录与种类目录下的共用文件，不导入 Host 或其他插件目录；只有 `standard` 用 `@latch/core`（`.oxlintrc.json`）。
- 程序目录是仓库根：`latchCodeRoot()` 越过各项目的 `package.json` 找到名为 `harness-link` 的根，`dist/`、`native/macos/` 与 `apps/desktop/` 都按它定位（`test/paths.test.ts#returns the repository root from latchCodeRoot() in a process started in each workspace project`）。
- 产物在仓库根的 `dist/`；Host 构建遇到测试代码即失败（`test/security.test.ts#fails a Host bundle that reaches the end-to-end tests under e2e/, helpers included`）。
- `src/paths.ts`、`host-state.ts` 只用可擦除语法（`tsconfig.strip.json`）：`apps/web/vite.config.ts` 经 `@latch/host/paths`、`host-state` 让 Node 只剥离类型加载它们。

改动前先读 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)、[docs/PLUGIN-DEVELOPMENT.md](../../docs/PLUGIN-DEVELOPMENT.md) 与 [docs/TESTING.md](../../docs/TESTING.md)；改动后运行 `pnpm test` 与 `pnpm test:e2e`。
