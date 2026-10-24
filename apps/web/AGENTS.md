# @latch/web

浏览器客户端：Host 在 `/link/` 提供的 React 页面，桌面端窗口显示的也是它。`pnpm build:web` 构建到仓库根的 `dist/web`（Host 只从这里读取）。不负责会话状态（以 Host 为准）与 Electron 壳。

| 路径 | 职责 |
| --- | --- |
| `src/core/` | 无布局的客户端核心：`api.ts`、fetch 事件流 `eventStream.ts`、同步与版本门禁 `useHarness.ts` 与 `projection.ts`、阅读位置 `useReadingPosition.ts`、凭据续期 `credentials.ts`、设备密钥 `deviceKey.ts`、登记 `enrollment.ts`、安全文案 `securityCopy.ts`、权限显示 `permissions.ts`、本机确认 `confirmations.ts`、审计回滚检查 `auditCheckpoint.ts`、审批 `approvalDecision.ts`、内容哈希 `contentHash.ts`、桌面端接口 `shell.ts` |
| `src/` | 界面：`main.tsx` → `App.tsx` → `Workspace.tsx`，`components/`、`settings/`、`hooks/`、`styles/`（`tokens.css`） |
| `index.html`、`public/`、`vite.config.ts` | 页面入口；图标与 manifest；Vite 配置与 `pnpm dev:web` 的开发代理 |
| `test/` | `pnpm test --project @latch/web` |

运行环境 browser：不用 Node 全局变量与内置模块（`.oxlintrc.json`）。运行时只依赖 `@latch/protocol` 与界面库；`vite.config.ts` 与测试在 Node 中运行，另用 Host、core 与 testkit，只写在 devDependencies。

不变量：

- `src/core/` 只导入本目录的文件、`react` 与 `@latch/protocol`，不依赖布局组件（`.oxlintrc.json`）。
- 只有 `useReadingPosition` 写入滚动位置（`jumpToLatest`、`reveal`）；消息与工具行带 `data-message-id`。改消息布局时检查上翻阅读、内容重排、回到最新与会话切换（`test/reading-position.test.ts#preserves the visible message offset when rows above it grow`）。
- 安全文案只来自 `src/core/securityCopy.ts`，按错误码选择，新增安全相关错误码时在此补充（`test/client-security.test.ts#uses the catalog for security codes and never the Host text`）。
- `permissions.ts` 的限制只是展示，Host 会再次检查；事件流用 `eventStream.ts`（fetch），不用 `EventSource`。
- 需要本机确认的请求走 `withConfirmation`，带 `requestId` 的请求重发相同请求体（`test/client-security.test.ts#reuses one requestId while the same choice is retried after an unknown outcome`）。
- 新字段对旧 Host 可选，缺少时降级（`test/client-legacy.test.ts#offers only settings the Host can serve, with the single-provider form for model setup`）；共享编码与 Host、测试向量一致（`test/client-security.test.ts#builds the exact enroll and renew texts`）。

改布局后在手机、平板、桌面宽度与深色模式下检查（`e2e/design.e2e.ts`）。改动前先读 [docs/STREAMING.md](../../docs/STREAMING.md)（事件流、消息身份、阅读位置）与 [docs/DESIGN.md](../../docs/DESIGN.md)。
