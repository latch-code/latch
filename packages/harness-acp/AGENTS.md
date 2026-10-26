# @latch/harness-acp

ACP HarnessDriver：每个启用的 Agent 定义一个 Driver（`createAcpAgentPlugin`）。`src/bridge.ts`（会话、启动指纹、权限模式）、`connection.ts` 与 `protocol.ts`（进程与 ACP v1）、`probe.ts`（仅握手诊断）、`mapping.ts`、`command.ts`、`environment.ts`（`agentEnvironment`）、`permission.ts`（`launchHash`）、`project-config.ts`、`store.ts`，以及每个预设的权限配置 `src/profiles/`。不负责浏览器可见的预设（`packages/protocol/src/agent-presets.ts`）、Agent 定义的保存与启动的本机确认（Host）。

运行环境 node；依赖 `@latch/protocol`、`@latch/sdk`、`@latch/core`（只用 `./node-kit` 与 `./file-tracking`）与 `zod`，测试另用 `@latch/testkit`。只有 Host 依赖本包，且只经入口 `src/index.ts`。

不变量：

- 子进程环境只来自 `agentEnvironment`：白名单继承、代理置空，移除 `NODE_OPTIONS`、`HARNESS_*`、`npm_*`、`DYLD_*`、`LD_*`（不区分大小写）（`test/acp.test.ts#applies the definition, then the profile, then the forced values, and removes loader and npm variables`）。
- 会话只启动与本机确认时 `launchHash` 一致的进程（`test/acp.test.ts#starts a session only with the launch fingerprint the owner confirmed`）；指纹覆盖命令、参数、定义的环境变量、预设、profile 版本与 profile 列出的项目配置（`test/acp.test.ts#fingerprints the command, arguments, variable names and values, preset and profile version`）。
- 只有 profile 声明了 `folders` 的预设收到项目的其他文件夹（Codex 经 ACP `additionalDirectories`，只在 Agent 声明支持时；Gemini CLI、Qwen Code 经 `--include-directories`）；它们计入 `launchHash`，没有其他文件夹时指纹不变（`test/acp.test.ts#gives Codex the full list of other folders over ACP on new, resumed and loaded sessions`、`test/acp.test.ts#never passes other folders to OpenCode, DeepSeek Harness, pi or goose`）。
- 权限行为只写在 `src/profiles/`；改变 profile 行为时提高其 `version`，它计入 `launchHash`。Agent 放宽自己的权限模式时停止该轮（`test/acp.test.ts#cancels the turn, rejects pending asks and stops input when the agent widens its own mode`）。
- 取消须等进程真实结算（`test/acp.test.ts#answers open permissions as cancelled and waits for the prompt to settle`）；带 `runId` 时只取消仍是当前的那一轮（`test/acp.test.ts#names each turn on the session and leaves a turn alone when a cancel names another`）。
- 探测只做 initialize，经过同一命令、环境和配置指纹检查，15 秒内结束并等待进程停止；不发提示词，authMethods 不作为未登录证据（`test/probe.test.ts`）。
- 新的持久化字段以可选字段加入 `src/store.ts` 的 zod schema，旧文件照常读取。
- 审批活动的 `since` 复用 RunClock 的原等待起点，不用第二次取时钟（`test/acp.test.ts#uses one approval wait timestamp even when every clock read advances`）。
- 测试只用 testkit 的假 Agent（`FAKE_ACP_AGENT`），不向真实 Agent CLI 发送提示。

测试：`pnpm test --project @latch/harness-acp`，另跑 `pnpm test:e2e`（`e2e/permissions-ui.e2e.ts` 用假 Agent）。改动前先读 [docs/HARNESSES.md](../../docs/HARNESSES.md)。

- 附件只按 initialize 实际协商的 image/embeddedContext 能力发送，转换在提示派发前完成；Agent 图片输出在当前轮经 Host 私有存储转成引用，原始字节不进消息、快照或 stderr。

- 文件产物只表示运行时间窗口中的观察；旧运行的晚到结算只更新原消息，不改新运行或会话排序。范围与预算见 [FILE-OUTPUTS.md](../../docs/FILE-OUTPUTS.md)。

- 配置修改在连接准备前和 RPC 发出前调用 Host `authorize`；超时不表示未执行，Host 回执未知时只查询原请求。
