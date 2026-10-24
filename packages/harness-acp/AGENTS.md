# @latch/harness-acp

ACP HarnessDriver：每个启用的 Agent 定义一个 Driver（`createAcpAgentPlugin`）。`src/bridge.ts`（会话、启动指纹、权限模式）、`connection.ts` 与 `protocol.ts`（进程与 ACP v1）、`mapping.ts`、`command.ts`、`environment.ts`（`agentEnvironment`）、`permission.ts`（`launchHash`）、`project-config.ts`、`store.ts`，以及每个预设的权限配置 `src/profiles/`。不负责浏览器可见的预设（`packages/protocol/src/agent-presets.ts`）、Agent 定义的保存与本机确认（Host）。

运行环境 node；依赖 `@latch/protocol`、`@latch/sdk`、`@latch/core`（只用 `./node-kit`）与 `zod`，测试另用 `@latch/testkit`。只有 Host 依赖本包，且只经入口 `src/index.ts`。

不变量：

- 子进程环境只来自 `agentEnvironment`：白名单继承、代理置空，移除 `NODE_OPTIONS`、`HARNESS_*`、`npm_*`、`DYLD_*`、`LD_*`（不区分大小写）（`test/acp.test.ts#applies the definition, then the profile, then the forced values, and removes loader and npm variables`）。
- 会话只启动与本机确认时 `launchHash` 一致的进程（`test/acp.test.ts#starts a session only with the launch fingerprint the owner confirmed`）；指纹覆盖命令、参数、定义的环境变量、预设、profile 版本与 profile 列出的项目配置（`test/acp.test.ts#fingerprints the command, arguments, variable names and values, preset and profile version`）。
- 权限行为只写在 `src/profiles/`；改变 profile 行为时提高其 `version`，它计入 `launchHash`。Agent 放宽自己的权限模式时停止该轮（`test/acp.test.ts#cancels the turn, rejects pending asks and stops input when the agent widens its own mode`）。
- 取消须等进程真实结算（`test/acp.test.ts#answers open permissions as cancelled and waits for the prompt to settle`）。
- 新的持久化字段以可选字段加入 `src/store.ts` 的 zod schema，旧文件照常读取。
- 测试只用 testkit 的假 Agent（`FAKE_ACP_AGENT`），不向真实 Agent CLI 发送提示。

测试：`pnpm test --project @latch/harness-acp`，另跑 `pnpm test:e2e`（`e2e/permissions-ui.e2e.ts` 用假 Agent）。改动前先读 [docs/HARNESSES.md](../../docs/HARNESSES.md)。
