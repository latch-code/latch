# @latch/web

`dist/web` → `/link/`。

| 路径 | 职责 |
| --- | --- |
| `src/core/` | API、流同步、阅读位置、身份权限、确认、桌面桥 |
| `src/shell/` | 壳层、路由、会话控制；概要分列团队成员与子 Agent |
| `src/agents/` | 我的 Agent：总览按 Host 记录开原聊天、运行或工作电脑 |
| `src/handoffs/` | 交接 |
| `src/markdown/` | 流式 Markdown |
| `src/` | `main.tsx` → `App.tsx` → `shell/AppShell.tsx` |
| `index.html`、`public/`、`vite.config.ts` | 入口、恢复页、开发代理 |
| `test/` | `pnpm test --project @latch/web` |

browser 禁 Node 全局与模块。Host、core、testkit 仅测试。

- `src/core/` 仅导入本目录、`react` 与 `@latch/protocol`；禁用布局组件（lint）。
- 正文滚动仅 `useReadingPosition` 写，消息和工具行用 `data-message-id`。工具输出到边缘后滚动正文。刻度列独立滚动，定位（含待办回合）走 `reveal`。缓存见 STREAMING。
- 预览凭授权句柄，项目预览不伪造会话。文件树懒加载，产物、改动收起，编辑行看本次差异。不透明框与可信插件分开。 `src/preview/AGENTS.md`
- 面板随会话清理，可信代码无隔离，`compose` 只追加草稿。创建直达创造模式，草稿独立于目录，重试保留模式。
- 市场随插件启停，iOS 隐藏，留侧栏原页，列表独滚。已安装按应用修订。查源暂存限本机完整管理；审阅绑来源与修订，未知写绑 Host、设备。
- 安全错误文案按码取自 `src/core/securityCopy.ts`。
- `permissions.ts` 只是展示，Host 再查；事件流用 `eventStream.ts`（fetch），不用 `EventSource`。
- 本机按 `isLocalListener`；回环浏览器算远程。缺邀请或用掉后重领（ARCHITECTURE）。
- 仅链 http(s)、mailto，行内代码继承链接。路径无 href，正文与 @ 共用文件图标，目录开树。网址输入可改、发出可点；闭合围栏保留原文。
- 确认走 `withConfirmation`；未知留原请求，确认后解锁设置。草稿只存文字，按设备与会话存浏览器，14 天过期；像凭据的只存内存，摘录要 `all`；删会话、撤权或退出即清。项目失效保留草稿供显式继续（`composer/WorkspaceRecovery.tsx`）。
- 用 `@latch/ui` 令牌、层、原语。对话/看板同底，分列滚动。
- 图标在 `src/assets/brands/`，许可在 `public/licenses/brands/`，用 `?no-inline`，缺图用中性图形。草稿与模型面板按账号 Harness ID 预取和补读缺失选项，旧会话固定账号。
- 读 `HarnessInfo.capabilities` 与 `level`，不判 Driver；共享编码与 Host、测试向量一致。
- 会话按项目分组，普通归「无项目」，仅旧会话回退主目录（`test/client-sessions.test.ts`）。
- 项目菜单仅新会话、编辑。摘要列目录和已知分支，悬停看路径；会话冻结目录；可见时每 30 秒按 Host 的 `checkedOut` 分类（GIT-REVIEW）。
- 桌面文件夹签名操作需 `folders.protocolVersion === 1`（`test/shell-folders.test.ts`）。
- 电脑菜单按来源识别当前电脑，经 `computers.switchTo` 切换。
- 聊天页头打开资料。头像最后释放时回收 URL。恢复页见 DESIGN。

Host 计量，窗口同口径。本会话引用整删、不补全。仅消息用 `motionAllowed` 淡入。

设置留草稿、授权读回与准备原号；终端按需挂载保活，可删摘录，暂存留回执。ProfileLayer 跨断点留实例、草稿、焦点、未知写，撤权卸载。

- 队列「引导」按本轮能力追加，附件绑原上传。编辑回填原文、附件，留草稿。菜单列键位，未知写用原号。裸 @ 无预选，滚动续查。私聊选一人发文字，回执定位原轮。粘贴纯文本替换选区。
- Slash 透传，区分未报与空表；技能只补全，pi 限开头。替换 `/btw` 须确认；PR 摘录只追加草稿。
- 配色、主色按设备选，安全界面锁色。设置与安全模式共用同页保留的 Host/设备外观未知写。
