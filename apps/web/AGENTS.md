# @latch/web

Host 用 `dist/web` 提供 `/link/`。

| 路径 | 职责 |
| --- | --- |
| `src/core/` | API、流与同步、阅读位置、身份与权限、确认、桌面桥 |
| `src/shell/` | 壳层：`AppShell`、`routes.ts`、`panelLayout.ts`、`slots.ts`、`useSessionController` |
| `src/agents/` | 我的 Agent：总览按 Host 记录开原聊天、运行或工作电脑 |
| `src/handoffs/` | 交接 |
| `src/markdown/` | 流式 Markdown |
| `src/` | `main.tsx` → `App.tsx` → `shell/AppShell.tsx` |
| `index.html`、`public/`、`vite.config.ts` | 页面、资源、开发代理 |
| `test/` | `pnpm test --project @latch/web` |

browser 禁 Node 全局与模块。Host、core、testkit 仅测试。

不变量：

- `src/core/` 仅导入本目录、`react` 与 `@latch/protocol`；禁用布局组件（lint）。
- 正文滚动仅 `useReadingPosition` 写，消息和工具行用 `data-message-id`。刻度列独立滚动，定位（含待办回合）走 `reveal`。用例见 `test/reading-position.test.ts`。缓存见 STREAMING。
- 文件预览只经授权句柄，项目预览不伪造会话；文件树懒加载。不透明文档框与可信插件分开，见 `src/preview/AGENTS.md`。
- 插件面板随会话清理，可信代码无隔离，`compose` 只追加草稿。创建插件直达创造模式，草稿与目录独立，重试保留模式。
- 市场随插件启停，iOS 隐藏，保留侧栏与原页。列表独立滚动。草稿限本机完整管理，更新按来源与修订审阅，未知写按 Host、设备保留。
- 安全错误文案按码取自 `src/core/securityCopy.ts`。
- `permissions.ts` 只是展示，Host 再查；事件流用 `eventStream.ts`（fetch），不用 `EventSource`。
- 本机按 `isLocalListener`；回环浏览器算远程。缺邀请或用掉后重领（ARCHITECTURE）。
- 回复仅链接 http(s)、mailto，链接内代码继承目标，文件用后缀图标且不生成 `<a href>`（message-content.test）。闭合围栏内引用回复保留原文（user-fences.test）。
- 确认走 `withConfirmation`；未知结果保留原请求，设置确认后解锁。草稿只存文字，按设备与会话存浏览器，14 天过期；像凭据的只在内存，含摘录的要 `all`；删会话、撤权或退出即清。项目失效保留草稿供显式继续（`composer/WorkspaceRecovery.tsx`）。
- 复用 `@latch/ui` 令牌、层与原语。对话与看板同底色，列独立滚动（DESIGN）。
- Harness 与模型图标在 `src/assets/brands/`，许可在 `public/licenses/brands/`，用 `?no-inline`，缺图用中性图形，禁用字母。草稿开模型面板时读缺失选项（HARNESSES）。
- 只读 `HarnessInfo.capabilities` 与 `level`，不判 Driver 种类；共享编码与 Host、测试向量一致。
- 项目按会话记录身份分组，普通会话归「无项目」；仅旧会话按主目录回退，不从附加文件夹推断（`test/client-sessions.test.ts`）。
- 分支用 Host 摘要，可见时每 30 秒同步。按 `checkedOut` 分类，页面不运行 Git（GIT-REVIEW）。
- 桌面文件夹签名操作需 `folders.protocolVersion === 1`（`test/shell-folders.test.ts`）。
- 电脑菜单按来源识别当前电脑，经 `computers.switchTo` 切换。
- Agent 资料的「动态」含即将的定时，电脑、唤醒、通知和 MCP 在「运行设置」（DESIGN）。

Host 计量，引用限本会话。仅消息淡入，脚本用 `motionAllowed`。

设置留草稿与授权读回，准备沿用原号；终端折叠保活，报错保留原文，暂存留回执。ProfileLayer 跨断点保留实例、草稿、焦点与未知写，撤权卸载。

- 附件排队绑定原上传，未知写沿用请求；断线读能力见横幅；裸 `@` 无预选。纯文本粘贴替换选区。
- Slash 透传 Harness 命令；技能只补全，pi 限开头（HARNESSES）。替换 `/btw` 先确认；PR 摘录只追加草稿。
- 配色与主色可按设备选；安全界面锁色。外观未知写按 Host、设备在同页保留，设置与安全模式共用（CUSTOMIZATION）。
