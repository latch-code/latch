# @latch/harness-acp

`createAcpAgentPlugin` 注册 Driver。`src/runtime.ts` 管会话、启动指纹与权限；`wires/` 管进程，`protocol.ts` 定义 ACP v1，`profiles/` 定义权限预设。浏览器预设见 protocol 的 `agent-presets.ts`，Host 保存定义。

环境 node；依赖 `@latch/protocol`、`@latch/sdk`、`@latch/core`（只用 `./node-kit`、`./file-tracking` 与 `./run-end`）、`zod`；`@cursor/sdk` 只在运行器进程。仅 Host 经 `src/index.ts` 依赖本包。

不变量：

- 子进程环境只来自 `agentEnvironment`：白名单加代理、CA 文件和 profile 的 `inheritEnv`，移除 `NODE_OPTIONS`、`LATCH_*`、`npm_*`、`DYLD_*`、`LD_*`（不区分大小写，`test/acp.test.ts`）；opencode 线另加口令。`inheritEnv` 不点名秘密（`test/login.test.ts`）。
- 登录 shell 只读点名的变量；登录与版本命令只在启动脚本经 `startServer({ loginPrograms })` 打开后运行，测试 Host 碰不到真实程序；状态命令的输出不离开 `read`（`test/login.test.ts`）。
- 启动须匹配记录的 `launchHash`，覆盖命令、参数、环境定义、预设、profile 版本及其项目配置、`inheritEnv` 名称和 `programEnv` 路径（`test/acp.test.ts`）。
- 只有 profile 声明了 `folders` 的预设收到项目的其他文件夹（Codex 经 ACP `additionalDirectories`，只在 Agent 声明支持时；Qwen Code 经 `--include-directories`）；它们计入 `launchHash`，没有其他文件夹时指纹不变（`test/acp.test.ts`）。
- 权限行为只写在 `src/profiles/`；改变 profile 行为时提高其 `version`，它计入 `launchHash`。Agent 自行放宽权限时停止该轮（`test/acp.test.ts`）。
- 取消等执行结算，`runId` 只取消本轮，恢复时显示本轮 ID。Codex 中断后仍核对命令。强停只清理父进程仍在时查明的后代，归属或结算不明时保留结果未知。子 Agent 请求不宽于会话模式，一轮后仍给人答，只单独停止宣告 `cancel` 的。MCP 审批只关联同轮唯一调用。
- 探测只做 initialize（`loginStatus`、`programVersion` 另跑，`loginRequest` 不开会话），同一命令、环境与指纹，20 秒内结束并等进程停止；不发提示词，authMethods 不算未登录证据（`test/probe.test.ts`）。
- 终端登录只跑会话的程序；登录推送只读 `kind`、`label`（`test/auth.test.ts`）。
- 新持久字段可选并入 `src/store.ts`。技能和扩展路径不存不发。Team 核父轮、父关系。
- 绑定时只采用本次请求中匹配 ACP 会话的最新有效命令报告；空列表撤下旧命令。
- 上下文仅存白名单计数。DSH 文字委托独占一轮进程，核对模式、guard 版本与本次执行，先审计再投递。
- 提议保留首轮材料和本机 MCP 来源（MCP）。
- 审批 `since` 沿用 RunClock 等待起点（`test/acp.test.ts`）。
- 不支持的请求共用事件时间，不回退已知输出（HARNESSES）。
- 测试只用假 Agent、回放与假 SDK，不提示真实 Agent。
- Cursor 密钥只经运行器环境（`test/cursor-sdk.test.ts`）。

测试：`pnpm test --project @latch/harness-acp` 与 `e2e/permissions-ui.e2e.ts`。先读 [docs/HARNESSES.md](../../docs/HARNESSES.md)。

- 附件按协商能力发内容或路径；本轮追加须声明 `_meta.steering.attachments`。Agent 图片存 Host 私有目录，只传引用；字节不进消息、快照或 stderr。
- 文件产物只表示运行时间窗口中的观察；旧运行晚到的结算只更新原消息。范围与预算见 ARCHITECTURE。
- 配置修改准备前和发 RPC 前调用 Host `authorize`；超时结果未知，核对时拒绝写入。

- 不改 CLI 配置、全局 hooks 或 shell。适配随进程加载，私有文件 0600。检查 setter 是否改配置。模式绑定进程/session，核对不用 setter。agy 进出 turbo 换进程；启动参数不算读回。pi 只认私有扩展全路径。逐次查版本，未知拒绝；Claude 只认 `--cli --version`。
