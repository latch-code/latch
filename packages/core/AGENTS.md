# @latch/core

Cordis 插件注册表（`src/registry.ts`）、Standard 执行循环（`src/runtime.ts`）与原子快照存储（`src/store.ts`）；子路径 `@latch/core/node-kit` 放 Host 与 Harness 共用的 Node 工具：`canonicalJson`、`sha256Hex`、`writeFileAtomic`、`syncDirectory`、`redactSecrets`。不负责 Host 的组合与 Harness 路由。

运行环境 node；只用 `@latch/protocol`、`@latch/sdk`、`cordis` 与 `zod`。`tsconfig.core.json` 开启 `erasableSyntaxOnly`。

不变量：

- 只有 `src/registry.ts` 与其契约测试 `tests/registry.test.ts` 导入 `cordis`（`.oxlintrc.json`）；升级 Cordis 以该测试为闸门：逆序清理、失败汇总、租约与替换（`tests/registry.test.ts#continues cleanup in awaited reverse order after synchronous and asynchronous failures`）。
- `src/node-kit/` 只导入 `node:` 模块与本目录文件（`.oxlintrc.json`）：`apps/web/vite.config.ts` 经 `host-state.ts` 让 Node 只剥离类型加载它，导入它也不会带出注册表或 Cordis。
- 执行循环的风险由 Host 的分级器判定，分级器抛错按 R2 处理（`tests/runtime.test.ts#treats a classifier that %s as R2`）。
- 新增秘密格式时补充 `redactSecrets`（`tests/redact.test.ts#leaves ordinary text alone`）；改 `canonicalJson` 前读根 `AGENTS.md`「共享安全编码」。

测试在根项目 `tests/`（`pnpm test --project harness-link`）；改动后运行 `pnpm lint`、`pnpm test` 与 `pnpm test:e2e`。插件生命周期见 [docs/PLUGIN-DEVELOPMENT.md](../../docs/PLUGIN-DEVELOPMENT.md)，消息与取消见 [docs/STREAMING.md](../../docs/STREAMING.md)。
