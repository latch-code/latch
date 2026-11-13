# @latch/web

Host 在 `/link/` 提供的 React 页面，桌面端共用；构建到 `dist/web`。

| 路径 | 职责 |
| --- | --- |
| `src/core/` | 无布局的客户端核心：API、事件流与增量影子、同步、阅读位置、凭据、设备登记、权限、确认与桌面桥接 |
| `src/shell/` | 壳层：`AppShell`、`routes.ts`、`panelLayout.ts`、`slots.ts`、`useSessionController` |
| `src/agents/` | 我的 Agent（docs/CUSTOM-AGENTS.md） |
| `src/handoffs/` | 交接（docs/HANDOFFS.md） |
| `src/markdown/` | 流式 Markdown |
| `src/` | `main.tsx` → `App.tsx` → `shell/AppShell.tsx`；品牌 `brands.ts` |
| `index.html`、`public/`、`vite.config.ts` | 页面入口；图标与 manifest；Vite 配置与 `pnpm dev:web` 的开发代理 |
| `test/` | `pnpm test --project @latch/web` |

browser 环境：不用 Node 全局变量与模块；Host、core、testkit 只用于测试。

不变量：

- `src/core/` 只导入本目录的文件、`react` 与 `@latch/protocol`，不依赖布局组件（`.oxlintrc.json`）。
- 仅 `useReadingPosition` 写入滚动位置（`jumpToLatest`、`reveal`）；消息与工具行带 `data-message-id`。改消息布局时检查上翻、重排、回到最新与切换会话（`test/reading-position.test.ts`）。
- 文件预览只经授权句柄，项目预览不伪造会话；文件树懒加载。不透明文档框与可信插件分开，见 `src/preview/AGENTS.md`。
- 插件面板由 `SessionPanels` / `ClientPluginPanel` 挂载并随会话清理；可信代码没有隔离，`compose` 只追加草稿（`e2e/plugin-packages.e2e.ts`）。
- 安全文案只来自 `src/core/securityCopy.ts`，按错误码选择，新增安全错误码时在此补充（`test/client-security.test.ts`）。
- `permissions.ts` 只是展示，Host 会再次检查；事件流用 `eventStream.ts`（fetch），不用 `EventSource`。
- 「这台电脑」只看 `@latch/protocol` 的 `isLocalListener`：回环上的浏览器按远程显示；连接页没有邀请时只说明去哪里取，邀请用掉后要求新的（`e2e/enrollment.e2e.ts`）。
- 回复里的文件引用渲染成路径标记，从不生成 `<a href>`；只有 http(s) 与 mailto 是链接（message-content.test）。
- 确认走 `withConfirmation`；未知结果保留原请求，设置确认后解锁。草稿只存文字，按设备与会话存于浏览器，14 天过期；像凭据的只在内存，含摘录的要 `all`；删会话、撤权或退出即清。失效项目保留草稿供显式继续（`composer/WorkspaceRecovery.tsx`）。
- 样式只用 `@latch/ui` 令牌并进入层叠层；界面组件用该包原语，不另画，页面只调整位置。见 `packages/ui/AGENTS.md` 与 DESIGN.md（`test/styles.test.ts`）。
- Harness 与模型服务的图标只用 `src/assets/brands/` 中原样复制的文件（来源与许可证见 `public/licenses/brands/`），以 `?no-inline` 导入，只经 `<img>` 或 CSS 遮罩使用；每个预设都有图标，缺图标的用中性图形，不用字母（`test/brands.test.ts`）。
- 只读 `HarnessInfo.capabilities` 与 `level`，不判断 Driver 种类；共享编码与 Host、测试向量一致（`test/client-security.test.ts`）。
- 项目按会话记录的身份分组，普通会话归「无项目」；只有旧会话按主目录回退，不从附加文件夹推断归属（`test/client-sessions.test.ts`）。
- 分支只用 Host 摘要，可见时每 30 秒同步快照，页面不运行 Git。
- 桌面文件夹操作需 `folders.protocolVersion === 1`；旧壳同名接口不证明支持签名请求（`test/shell-folders.test.ts`）。

仅消息内容淡入，滚动容器不透明度动画会丢命中。

布局/缓存见 DESIGN/STREAMING；切换保留会话。Agent 设置复用原控件；ProfileLayer 单实例跨断点保留草稿/焦点/未知写，撤权卸载（CUSTOM-AGENTS）。

- 附件字节只经专用上传，未知提交保留原请求与引用（ATTACHMENTS.md）。

- Harness 草稿保留先选，思考按模型读；`source: launch` 不算读回，见 HARNESSES.md。
