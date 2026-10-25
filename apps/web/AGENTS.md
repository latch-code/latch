# @latch/web

Host 在 `/link/` 提供的 React 页面，桌面端共用；构建到根 `dist/web`，会话以 Host 为准。

| 路径 | 职责 |
| --- | --- |
| `src/core/` | 无布局的客户端核心：`api.ts`、`eventStream.ts`（fetch 事件流）、`useHarness.ts` 与 `projection.ts`（同步与版本门禁）、`useReadingPosition.ts`、`credentials.ts`（凭据续期）、`deviceKey.ts`、`enrollment.ts`、`securityCopy.ts`、`permissions.ts`、`ceilings.ts`（权限上限）、`confirmations.ts`（本机确认）、`blocking.ts`、`sessionLinks.ts`（阻塞会话）、`providerSetup.ts`（模型服务）、`auditCheckpoint.ts`（审计回滚检查）、`approvalDecision.ts`、`cancelRequest.ts`、`contentHash.ts`、`hostClock.ts`、`hostState.ts`（停止与睡眠通告）、`shell.ts` 与 `shellLifecycle.ts`（桌面端） |
| `src/` | 界面：`main.tsx` → `App.tsx` → `Workspace.tsx`，`components/`、`settings/`、`hooks/`、`styles/`（入口 `index.css`，令牌与原语的样式来自 `@latch/ui`）；品牌图标 `brands.ts` 与 `assets/brands/` |
| `index.html`、`public/`、`vite.config.ts` | 页面入口；图标与 manifest；Vite 配置与 `pnpm dev:web` 的开发代理 |
| `test/` | `pnpm test --project @latch/web` |

browser 环境：不用 Node 全局变量与模块。Vite 与测试在 Node 中运行，Host、core、testkit 只用于测试。

不变量：

- `src/core/` 只导入本目录的文件、`react` 与 `@latch/protocol`，不依赖布局组件（`.oxlintrc.json`）。
- 只有 `useReadingPosition` 写入滚动位置（`jumpToLatest`、`reveal`）；消息与工具行带 `data-message-id`。改消息布局时检查上翻、重排、回到最新与切换会话（`test/reading-position.test.ts`）。
- 需求包面板由 `SessionPanels` / `ClientPluginPanel` 挂载并随会话清理；可信代码没有隔离，`compose` 只追加草稿（`e2e/plugin-packages.e2e.ts`）。
- 安全文案只来自 `src/core/securityCopy.ts`，按错误码选择，新增安全错误码时在此补充（`test/client-security.test.ts`）。
- `permissions.ts` 只是展示，Host 会再次检查；事件流用 `eventStream.ts`（fetch），不用 `EventSource`。
- 「这台电脑」只看 `@latch/protocol` 的 `isLocalListener`：回环上的浏览器按远程显示；登记页没有邀请时只说明去哪里取，邀请用掉后要求新的（`e2e/enrollment.e2e.ts#asks a browser on loopback for an invitation, shows the fingerprint the Host shows, handles a denial, then connects`）。
- 回复里的文件引用渲染成路径标记，从不生成 `<a href>`；只有 http(s) 与 mailto 是链接（`test/message-content.test.ts`）。
- 需要本机确认的请求走 `withConfirmation`，带 `requestId` 的请求重发相同请求体（`test/client-security.test.ts`）。
- 样式表都进入层叠层，只读 `@latch/ui` 定义的令牌，规则见 `packages/ui/AGENTS.md`（`test/styles.test.ts`）。按钮、菜单、模态外壳、异步确认与输入框、开关、分段控件、胶囊、计数、提示、加载、Toast 等用 `@latch/ui` 的原语，不另画一份；页面只在 app 层按位置调整。
- Harness 与模型服务的图标只用 `src/assets/brands/` 中原样复制的文件（来源与许可证见根 `NOTICE`），以 `?no-inline` 导入，只经 `<img>` 或 CSS 遮罩使用；每个预设都有图标，缺图标的用中性图形，不用字母（`test/brands.test.ts`）。
- 新字段对旧 Host 可选，缺少时降级（`test/client-legacy.test.ts`）；共享编码与 Host、测试向量一致（`test/client-security.test.ts`）。
- 桌面文件夹操作需 `folders.protocolVersion === 1`；旧壳同名接口不证明支持签名请求（`test/shell-folders.test.ts`）。

会话切换只淡入消息内容层；带遮罩的滚动容器做透明度动画会丢失点击命中。

布局验证覆盖手机、平板、桌面及深色模式（`e2e/design.e2e.ts`）。先读 [docs/STREAMING.md](../../docs/STREAMING.md)与 [docs/DESIGN.md](../../docs/DESIGN.md)。
