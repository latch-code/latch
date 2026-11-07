# @latch/protocol

浏览器与 Host 共用的数据。浏览器 DTO 按领域分文件：会话、消息与审批 `src/sessions.ts`，快照（含 `HostCatalog`）与事件 `src/snapshot.ts`，设备、登记、邀请、本机确认与 `ApiFailure` `src/devices.ts`，Harness 与 Agent 定义 `src/harnesses.ts`（`AgentRecord` 只在 Host 使用），模型服务、项目、默认值与插件 `src/settings.ts`，能力开关 `src/features.ts`，改动范围、撤销回执与下一条消息的说明 `src/changes.ts`。另有模型服务预设 `src/presets.ts` 与 Agent 预设 `src/agent-presets.ts`、`escapeSecurityText` 与设备名称规则 `src/text.ts`、「这台电脑」的判定 `isLocalListener`（`src/listeners.ts`）、拒绝说明的规则 `rejectionNote`（`src/decision.ts`），以及高风险原因的文字 `RISK_REASON_TEXT`（`src/risk.ts`，审批卡与本机确认共用）。`src/ui.ts` 定义插件面板与技能的展示数据，以及数据面板的有限文档校验；`src/files.ts` 定义预览句柄元数据与打开目标。不做持久化或 I/O。

运行环境 isomorphic：只用 ECMAScript 标准库，不导入 `node:*`，不用 DOM 或 Node 的全局变量（`tsconfig.isomorphic.json`、`.oxlintrc.json`）。没有依赖，不使用其他 workspace 包；模块没有副作用。入口 `@latch/protocol` 导出类型与值；`@latch/protocol/types`（`src/types.ts`）只有类型。

不变量：

- `@latch/sdk` 的类型文件只用 `@latch/protocol/types`，外部项目才能检查兼容入口（`tests/plugin-sdk.test.ts#type-check in an outside TypeScript project that does not allow .ts import extensions`）。外部项目只接受仅含类型的 .ts 路径导入与导出，所以 `src/types.ts` 只写 `export type`，值由 `src/index.ts` 导出；新模块两处都要加。
- 目录中的技能不含正文，React 面板只有模块摘要，模块源码经认证另取；数据面板不接受 HTML、脚本或样式。
- 上线前页面与 Host 同版本，新字段不必为旧 Host 写成可选。
- `agent-presets.ts` 只放浏览器可用的展示与启动数据；权限行为写在 `packages/harness-acp/src/profiles/`。
- `AgentRecord.env` 的值不离开 Host，浏览器只收到 `AgentSettings`（变量名）。
- 改 `src/text.ts` 前读根 `AGENTS.md`「共享安全编码」。
- 一对 Harness 与模型服务怎么通只看 `pairRoute`（`src/model-route.ts`）；Host 开会话时自己重算，不信客户端。
- 「这台电脑」只用 `isLocalListener` 判定，默认拒绝、只有 `unix` 为真；Host 与页面都调用它，不按入口类别另写本机判断。新增入口类别写进 `LISTENER_CLASSES`，逐个入口的用例随之覆盖它（`apps/host/test/auth.test.ts#this computer > counts only host.sock as this computer: every other listener needs its own invitation, refuses offline codes and cannot show a confirmation uninvited`）。

改动后运行 `pnpm typecheck`、`pnpm test` 与 `pnpm test:e2e`。消息与快照见 [docs/STREAMING.md](../../docs/STREAMING.md)，代码地图见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

- `src/file-refs.ts` 定义显式相对引用；`src/attachments.ts` 仅定义有限的元数据、上传上下文与能力；`AttachmentRef` 不含内容或私有路径，新增字段须同步两个 Harness 的持久化 schema。
- 文件上下文区分 session 和带 Harness 的 workspace；目录 DTO 不含绝对路径，旧会话 `FileOpenTarget` 继续兼容。
- `src/personal.ts` 定义个人助手、用户记忆、定时任务与有界群聊；私有执行 context 不是客户端可授予的权限，概览不代替正文授权。
- `plugin-packages.ts` 定义可编辑插件资产与有限模板；摘要区分草稿、已应用版本及真实不可用原因，不含 Host 私有路径。
- `src/terminal.ts` 定义终端路由的线上类型；路由只接受 `host.sock`，见 [docs/TERMINAL.md](../../docs/TERMINAL.md)。

