# @latch/protocol

浏览器与 Host 共用的数据：浏览器 DTO（`src/types.ts`，含 `PluginInfo`，及只在 Host 使用的 `AgentRecord` 与本机确认的 `PresencePreview`）、模型服务预设 `src/presets.ts` 与 Agent 预设 `src/agent-presets.ts`、`escapeSecurityText` 与设备名称规则 `src/text.ts`。不做校验、持久化或 I/O。

运行环境 isomorphic：只用 ECMAScript 标准库，不导入 `node:*`，不用 DOM 或 Node 的全局变量（`tsconfig.isomorphic.json`、`.oxlintrc.json`）。没有依赖，不使用其他 workspace 包；模块没有副作用。入口 `@latch/protocol` 与只含类型和常量的 `@latch/protocol/types`。

不变量：

- `@latch/sdk` 的类型文件只用 `@latch/protocol/types`，外部项目才能检查兼容入口（`tests/plugin-sdk.test.ts#type-check in an outside TypeScript project that does not allow .ts import extensions`）。
- 旧 Host 不返回新字段：客户端读取的新字段写成可选，缺少时降级（`apps/web/test/client-legacy.test.ts#offers only settings the Host can serve, with the single-provider form for model setup`）。
- `agent-presets.ts` 只放浏览器可用的展示与启动数据；权限行为写在 `packages/harness-acp/src/profiles/`。
- `AgentRecord.env` 的值不离开 Host，浏览器只收到 `AgentSettings`（变量名）。
- 改 `src/text.ts` 前读根 `AGENTS.md`「共享安全编码」。

改动后运行 `pnpm typecheck`、`pnpm test` 与 `pnpm test:e2e`。消息与快照见 [docs/STREAMING.md](../../docs/STREAMING.md)，代码地图见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。
