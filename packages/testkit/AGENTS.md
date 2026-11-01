# @latch/testkit

只供测试使用的辅助：Host 夹具 `startHostFixture`（`src/host.ts`）、测试确认后端 `createTestPresence`（`src/presence.ts`）、Swift 互操作夹具的编译 `buildSwiftFixture`（`src/swift.ts`）、共享安全向量 `vectors/security-v1.json`、原生连接向量 `vectors/link-v1.json` 与测试设备密钥（`src/crypto.ts`）、假 ACP Agent `fixtures/fake-acp-agent.mjs`（`FAKE_ACP_AGENT`）、测试证书 `makeTestTls`（`src/tls.ts`）；Office/PDF 的普通、恶意与性能样例见 `src/documents.ts`，测量边界见 [DOCUMENT-PERFORMANCE.md](../../docs/DOCUMENT-PERFORMANCE.md)。

运行环境 node，与测试一起由 `tsconfig.tests.json` 检查；只依赖 `@latch/protocol` 与 `undici`。

不变量：

- 只有测试（`tests/`、`e2e/` 与各项目的 `test/`）导入本包：只能写在 devDependencies（`tests/boundaries.test.ts#reports a dev-only package listed anywhere but devDependencies, by the root as well`），别处导入即 `pnpm lint` 失败，Host 构建遇到它即失败（`apps/host/test/security.test.ts#fails a Host bundle that reaches test code: @latch/testkit by name, or a file under packages/testkit/ or tests/`）。
- 不导入 Host：夹具经参数拿到启动函数，`apps/host/test/helpers/host.ts`、`e2e/helpers/host.ts` 与 `apps/desktop/test/helpers/host.ts` 把它绑定到 `startServer` 与 Host 的默认选项。
- 只用临时目录、端口 0 与回环地址，不读取用户数据与密钥。
- 改向量前读根 `AGENTS.md`「共享安全编码」。

改动后运行 `pnpm test` 与 `pnpm test:e2e`。用法见 [docs/TESTING.md](../../docs/TESTING.md#测试辅助)。
