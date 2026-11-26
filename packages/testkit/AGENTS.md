# @latch/testkit

只供测试使用的辅助：Host 夹具 `startHostFixture`（`src/host.ts`）、测试确认后端 `createTestPresence`（`src/presence.ts`）、Swift 互操作夹具的编译 `buildSwiftFixture`（`src/swift.ts`）、共享安全向量 `vectors/security-v1.json`、原生连接向量 `vectors/link-v1.json`、等待判定向量 `vectors/board-v1.json` 与测试设备密钥（`src/crypto.ts`）、假 ACP Agent `fixtures/fake-acp-agent.mjs`（`FAKE_ACP_AGENT`；它在 Latch 之前的会话由 `writeFakeHistory` 写入 `FAKE_ACP_HISTORY_FILE`，`src/history.ts`）、假 pi `fixtures/fake-pi-agent.mjs`（`FAKE_PI_AGENT`，说 pi 的 RPC）、假 Codex app-server `fixtures/fake-codex-app-server.mjs`（`FAKE_CODEX_APP_SERVER`；假 ACP Agent 以 `app-server` 或 `cli app-server` 启动时也是它）、假 MCP 服务器 `fixtures/fake-mcp-stdio.mjs`（`FAKE_MCP_STDIO`）与只听回环的 Streamable HTTP 假服务器 `startFakeMcpHttp`（`src/fake-mcp-http.ts`）与假授权服务器 `startFakeOAuth`（`src/fake-oauth.ts`，见 [MCP.md](../../docs/MCP.md#测试替身)）、假 GitHub CLI `fixtures/fake-gh.mjs`（`installFakeGh`：只在它自己的 PATH 与非登录 shell 里，按 JSON 状态回答交付的 `gh` 命令，被要求 token 或在环境里看到 token 时记违规）、回放 Agent 与各预设的对话（`src/replay.ts`、`fixtures/replay-agent.mjs`、`fixtures/replay/`，pi 的是它自己的 RPC）、假模型服务 `startFakeModels`（`src/fake-models.ts`）、录制器（`src/record.ts`、`fixtures/record-tee.mjs`）、测试证书 `makeTestTls`（`src/tls.ts`）；设备面板的替身组件与替身 `idb_companion`（`src/fake-simulator.ts`，录下的画面在 `fixtures/simulator-*`）；Office/PDF 的普通、恶意与性能样例见 `src/documents.ts`，测量边界见 [TESTING](../../docs/TESTING.md#性能测量)。

运行环境 node，与测试一起由 `tsconfig.tests.json` 检查；只依赖 `@latch/protocol` 与 `undici`。

不变量：

- 只有测试（`tests/`、`e2e/` 与各项目的 `test/`）导入本包：只能写在 devDependencies（`tests/boundaries.test.ts#reports a dev-only package listed anywhere but devDependencies, by the root as well`），别处导入即 `pnpm lint` 失败，Host 构建遇到它即失败（`apps/host/test/security.test.ts#fails a Host bundle that reaches test code: @latch/testkit by name, or a file under packages/testkit/ or tests/`）。
- 不导入 Host：夹具经参数拿到启动函数，`apps/host/test/helpers/host.ts`、`e2e/helpers/host.ts` 与 `apps/desktop/test/helpers/host.ts` 把它绑定到 `startServer` 与 Host 的默认选项。
- 只用临时目录、端口 0 与回环地址，不读取用户数据与密钥。
- 录制器只由这台电脑的所有者经 `pnpm harness:record` 对真实 Agent 运行：只放行假模型服务端口的沙箱、临时家目录、白名单环境，沙箱没挡住外连或本机其他端口就不启动 Agent；测试只用假 ACP Agent 运行它（`packages/harness-acp/test/record.test.ts`）。
- `fixtures/replay/` 中的文件在第一行写明 `source`：`hand-written` 不得写成 `recorded`。
- 假 ACP 的 `FAKE_ACP_SETUP_COMMANDS=1` 在会话建立时上报命令；`interleaved` 另模拟同次写入的回复和通知。
- 改向量前读根 `AGENTS.md`「共享安全编码」。

改动后运行 `pnpm test` 与 `pnpm test:e2e`。用法见 [docs/TESTING.md](../../docs/TESTING.md#测试辅助)。
