# @latch/protocol

浏览器与 Host 共用 DTO。会话与审批见 `src/sessions.ts`，看板的组与等待判定见 `src/board.ts`，标签规范见 `src/board-tags.ts`，待办见 `src/work-items.ts`，快照与事件见 `src/snapshot.ts`，正文增量见 `src/task-delta.ts`，设备、登记与本机确认见 `src/devices.ts`。Harness 与 Agent 见 `src/harnesses.ts`（`AgentRecord` 限 Host），模型服务和设置见 `src/settings.ts`，能力、交接、导入会话见 `src/{features,handoffs,history}.ts`，改动与行级反馈见 `src/{changes,review-notes}.ts`。预设及安全文字见 `src/{presets,agent-presets,text,listeners,decision,risk}.ts`，审批卡与本机确认共用 `RISK_REASON_TEXT`。`src/ui.ts` 定义插件面板、技能与有限数据文档，`src/files.ts` 定义预览元数据与目标。不做持久化或 I/O。

运行环境 isomorphic：只用 ECMAScript 标准库，不导入 `node:*`，不用 DOM 或 Node 的全局变量（`tsconfig.isomorphic.json`、`.oxlintrc.json`）。没有依赖，不使用其他 workspace 包；模块没有副作用。入口 `@latch/protocol` 导出类型与值；`@latch/protocol/types`（`src/types.ts`）只有类型。

不变量：
- `CustomAgent.workComputer` 只含 Host 与助手 ID，缺省用本机。

- `@latch/sdk` 的类型文件只用 `@latch/protocol/types`，外部项目才能检查兼容入口（`tests/plugin-sdk.test.ts#type-check in an outside TypeScript project that does not allow .ts import extensions`）。外部项目只接受仅含类型的 .ts 路径导入与导出，所以 `src/types.ts` 只写 `export type`，值由 `src/index.ts` 导出；新模块两处都要加。
- 技能无正文和私有路径，Harness 插件报告限短名与截断标记。React 面板只含模块摘要，源码经认证另取；数据面板禁 HTML、脚本、样式。
- 上线前页面与 Host 同版本，新字段不必为旧 Host 写成可选。
- `agent-presets.ts` 只放浏览器可用的展示与启动数据；权限行为写在 `packages/harness-acp/src/profiles/`。
- `AgentRecord.env` 的值不离开 Host，浏览器只收到 `AgentSettings`（变量名）。
- 改 `src/text.ts` 前读根 `AGENTS.md`「共享安全编码」。
- 配对用 `pairRoute`（`src/model-route.ts`）；互译仅 Responses/Anthropic→Chat、Anthropic↔Responses。Host 重算，不信客户端。
- 「这台电脑」只用 `isLocalListener` 判定，默认拒绝、只有 `unix` 为真；Host 与页面都调用它，不按入口类别另写本机判断。新增入口类别写进 `LISTENER_CLASSES`，逐个入口的用例随之覆盖它（`apps/host/test/auth.test.ts#this computer > counts only host.sock as this computer: every other listener needs its own invitation, refuses offline codes and cannot show a confirmation uninvited`）。

改动后运行 `pnpm typecheck`、`pnpm test` 与 `pnpm test:e2e`。消息与快照见 [docs/STREAMING.md](../../docs/STREAMING.md)，代码地图见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

- Agent 导入导出共用 `AGENT_FILE_BYTES`。中继导入共用 `relay-file.ts`，保留显式 null 的回执哈希。
- `src/files.ts` 的 `imageDimensions` 只读有界文件头，供 Host 的文件元数据与浏览器头像解码前检查共用。
- `src/file-refs.ts` 定义显式相对引用；`src/attachments.ts` 仅定义有限的元数据、上传上下文与能力；`AttachmentRef` 不含内容或私有路径，新增字段须同步两个 Harness 的持久化 schema。
- 文件上下文区分 session 和带 Harness 的 workspace；目录 DTO 不含绝对路径，旧会话 `FileOpenTarget` 继续兼容。
- `plugin-packages.ts` 定义可编辑插件资产与有限模板；摘要区分草稿、已应用版本及真实不可用原因，不含 Host 私有路径。
- 类型：插件页面 `apps.ts` 与 `app-bridge.ts` 不含凭据（[APP-PAGES](../../docs/APP-PAGES.md)）；`terminal.ts` 区分会话和项目，仅 `host.sock`；`git-delivery.ts` 定义交付与历史，`workbench.ts` 定义带时间的摘要。
