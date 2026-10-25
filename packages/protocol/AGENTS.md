# @latch/protocol

浏览器与 Host 共用的数据：浏览器 DTO（`src/types.ts`，含 `PluginInfo`，及只在 Host 使用的 `AgentRecord` 与本机确认的 `PresencePreview`）、模型服务预设 `src/presets.ts` 与 Agent 预设 `src/agent-presets.ts`、`escapeSecurityText` 与设备名称规则 `src/text.ts`、「这台电脑」的判定 `isLocalListener`（`src/listeners.ts`）、拒绝说明的规则 `rejectionNote`（`src/decision.ts`），以及高风险原因的文字 `RISK_REASON_TEXT`（`src/risk.ts`，审批卡与本机确认共用）。`src/ui.ts` 定义需求包面板与技能的展示数据，以及数据面板的有限文档校验；`src/files.ts` 定义预览句柄元数据与打开目标。不做持久化或 I/O。

运行环境 isomorphic：只用 ECMAScript 标准库，不导入 `node:*`，不用 DOM 或 Node 的全局变量（`tsconfig.isomorphic.json`、`.oxlintrc.json`）。没有依赖，不使用其他 workspace 包；模块没有副作用。入口 `@latch/protocol` 与只含类型和常量的 `@latch/protocol/types`。

不变量：

- `@latch/sdk` 的类型文件只用 `@latch/protocol/types`，外部项目才能检查兼容入口（`tests/plugin-sdk.test.ts#type-check in an outside TypeScript project that does not allow .ts import extensions`）。
- 目录中的技能不含正文，React 面板只有模块摘要，模块源码经认证另取；数据面板不接受 HTML、脚本或样式。
- 旧 Host 不返回新字段：客户端读取的新字段写成可选，缺少时降级（`apps/web/test/client-legacy.test.ts#offers only settings the Host can serve, with the single-provider form for model setup`）。
- `agent-presets.ts` 只放浏览器可用的展示与启动数据；权限行为写在 `packages/harness-acp/src/profiles/`。
- `AgentRecord.env` 的值不离开 Host，浏览器只收到 `AgentSettings`（变量名）。
- 改 `src/text.ts` 前读根 `AGENTS.md`「共享安全编码」。
- 「这台电脑」只用 `isLocalListener` 判定，默认拒绝、只有 `unix` 为真；Host 与页面都调用它，不按入口类别另写本机判断。新增入口类别写进 `LISTENER_CLASSES`，逐个入口的用例随之覆盖它（`apps/host/test/auth.test.ts#this computer > counts only host.sock as this computer: every other listener needs its own invitation, refuses offline codes and cannot show a confirmation uninvited`）。

改动后运行 `pnpm typecheck`、`pnpm test` 与 `pnpm test:e2e`。消息与快照见 [docs/STREAMING.md](../../docs/STREAMING.md)，代码地图见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

- `src/file-refs.ts` 定义显式相对引用；`src/attachments.ts` 仅定义有限的元数据、上传上下文与能力；`AttachmentRef` 不含内容或私有路径，新增字段须同步两个 Harness 的持久化 schema。
