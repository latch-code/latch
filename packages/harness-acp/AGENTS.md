# @latch/harness-acp

ACP HarnessDriver：每个启用的 Agent 定义一个 Driver（`createAcpAgentPlugin`）。`src/bridge.ts`（会话、启动指纹、权限模式）、`connection.ts` 与 `protocol.ts`（进程与 ACP v1）、`probe.ts`（仅握手诊断）、`mapping.ts`、`command.ts`、`login-shell.ts`、`login.ts`、`environment.ts`（`agentEnvironment`）、`permission.ts`（`launchHash`）、`project-config.ts`、`store.ts`，以及每个预设的权限配置 `src/profiles/`。不负责浏览器可见的预设（`packages/protocol/src/agent-presets.ts`）与 Agent 定义的保存（Host）。

运行环境 node；依赖 `@latch/protocol`、`@latch/sdk`、`@latch/core`（只用 `./node-kit`、`./file-tracking` 与 `./run-end`）与 `zod`。只有 Host 依赖本包，且只经入口 `src/index.ts`。

不变量：

- 子进程环境只来自 `agentEnvironment`：白名单加这个人的代理、CA 文件和 profile 的 `inheritEnv`，移除 `NODE_OPTIONS`、`LATCH_*`、`npm_*`、`DYLD_*`、`LD_*`（不区分大小写）（`test/acp.test.ts#applies the definition, then the profile, then the forced values, and removes loader and npm variables`）。`inheritEnv` 不点名秘密（`test/login.test.ts`）。
- 登录 shell 只读点名的变量；登录与版本命令只在启动脚本经 `startServer({ loginPrograms })` 打开后运行，测试 Host 碰不到真实程序；状态命令的输出不离开 `read`（`test/login.test.ts`）。
- 会话只启动与开始时记录的 `launchHash` 一致的进程（`test/acp.test.ts#starts a session only with a launch fingerprint on record`）；指纹覆盖命令、参数、定义的环境变量、预设、profile 版本、profile 列出的项目配置、`inheritEnv` 的名字（不含值）与 `programEnv` 的路径（`test/acp.test.ts#fingerprints the command, arguments, variable names and values, preset and profile version`）。
- 只有 profile 声明了 `folders` 的预设收到项目的其他文件夹（Codex 经 ACP `additionalDirectories`，只在 Agent 声明支持时；Gemini CLI、Qwen Code 经 `--include-directories`）；它们计入 `launchHash`，没有其他文件夹时指纹不变（`test/acp.test.ts#gives Codex the full list of other folders over ACP on new, resumed and loaded sessions`、`test/acp.test.ts#never passes other folders to OpenCode, DeepSeek Harness, pi or goose`）。
- 权限行为只写在 `src/profiles/`；改变 profile 行为时提高其 `version`，它计入 `launchHash`。Agent 放宽自己的权限模式时停止该轮（`test/acp.test.ts#cancels the turn, rejects pending asks and stops input when the agent widens its own mode`）。
- 取消须等进程真实结算（`test/acp.test.ts#answers open permissions as cancelled and waits for the prompt to settle`）；带 `runId` 时只取消仍是当前的那一轮（`test/acp.test.ts#names each turn on the session and leaves a turn alone when a cancel names another`）。
- 探测只做 initialize（`loginStatus`、`programVersion` 同时另跑），经过同一命令、环境和配置指纹检查，20 秒内结束并等待进程停止；不发提示词，authMethods 不作为未登录证据（`test/probe.test.ts`）。
- 新的持久化字段以可选字段加入 `src/store.ts` 的 zod schema。
- 审批活动的 `since` 复用 RunClock 的原等待起点（`test/acp.test.ts#uses one approval wait timestamp even when every clock read advances`）。
- 测试只用假 Agent 与回放 Agent（`test/replay.test.ts`），不向真实 Agent 发提示。

测试：`pnpm test --project @latch/harness-acp`，另跑 `pnpm test:e2e`（`e2e/permissions-ui.e2e.ts`）。先读 [docs/HARNESSES.md](../../docs/HARNESSES.md)。

- 附件只按 initialize 协商的能力发送；Agent 图片输出经 Host 私有存储转成引用，原始字节不进消息、快照或 stderr。
- 文件产物只表示运行时间窗口中的观察；范围与预算见 [FILE-OUTPUTS.md](../../docs/FILE-OUTPUTS.md)。
- 配置修改在连接准备前和 RPC 发出前调用 Host `authorize`；超时不表示未执行。
