# @latch/sdk

插件作者面：`HarnessPlugin`、`PluginContext`、Provider、Tool（`src/plugins.ts`）、`HarnessDriver`（`src/harness.ts`）、`Bridge`（Host 与 Harness 之间的协议，`src/bridge.ts`）与 `AppError`（`src/errors.ts`）。只有接口与错误类，不含 Host 的实现。

运行环境 node；只依赖 `@latch/protocol`，且只用 `@latch/protocol/types`。`tsconfig.sdk.json` 开启 `isolatedDeclarations`（导出须写明类型）与 `erasableSyntaxOnly`（Node 会只剥离类型就加载本包）。入口 `@latch/sdk`，以及只含类型的 `./plugins`、`./harness`。

不变量：

- `./plugins`、`./harness` 由根包再导出为 `harness-link/plugin-sdk`、`harness-link/harness-sdk`；它们引到的文件之间只用 `import type`，外部项目不开启 `allowImportingTsExtensions` 也能检查（`tests/plugin-sdk.test.ts#type-check in an outside TypeScript project that does not allow .ts import extensions`）。
- 插件拿不到原始 Cordis Context，只经 `PluginContext` 注册能力。
- 改接口时同步 [docs/PLUGIN-DEVELOPMENT.md](../../docs/PLUGIN-DEVELOPMENT.md) 的签名。

测试在根项目 `tests/`（`pnpm test --project harness-link`）；改接口后运行 `pnpm typecheck`、`pnpm test` 与 `pnpm test:e2e`。
