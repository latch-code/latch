# @latch/sdk

插件作者面：`LatchPlugin`（兼容名 `HarnessPlugin`）、`PluginContext`、Provider、Tool、技能、数据与 React 面板（`src/plugins.ts`）、`HarnessDriver`（`src/harness.ts`）、`Bridge`（Host 与 Harness 之间的协议，`src/bridge.ts`）与 `AppError`（`src/errors.ts`）。只有接口与错误类，不含 Host 的实现。

运行环境 node；只依赖 `@latch/protocol`，且只用 `@latch/protocol/types`。`tsconfig.sdk.json` 开启 `isolatedDeclarations`（导出须写明类型）与 `erasableSyntaxOnly`（Node 会只剥离类型就加载本包）。入口 `@latch/sdk`，以及只含类型的 `./plugins`、`./harness`。

不变量：

- `./plugins`、`./harness` 由根包再导出为 `harness-link/plugin-sdk`、`harness-link/harness-sdk`；它们引到的文件之间只用 `import type`，外部项目不开启 `allowImportingTsExtensions` 也能检查（`tests/plugin-sdk.test.ts#type-check in an outside TypeScript project that does not allow .ts import extensions`）。
- 插件可组合 Host 模块、技能、工具、界面、Harness 和连接载体，统一归属和清理；只经 `PluginContext` 注册能力。连接通道用平台无关 AsyncIterable/write/close，不向 driver 交设备身份。客户端 props 类型由 `@latch/ui` 提供。
- `TaskSummary.runId` 在每次运行开始时换新并持久化；`Bridge.cancel` 带 `runId` 时只在它仍是当前运行时取消，并在开始取消的同一步核对，迟到的取消不会停止之后开始的运行（`tests/runtime.test.ts#names each run on the session, keeps the name across a restart, and leaves a run alone when a cancel names another`）。
- 改接口时同步 [docs/PLUGIN-DEVELOPMENT.md](../../docs/PLUGIN-DEVELOPMENT.md) 的签名。

测试在根项目 `tests/`（`pnpm test --project harness-link`）；改接口后运行 `pnpm typecheck`、`pnpm test` 与 `pnpm test:e2e`。

- 附件在 Bridge/Message 里用元数据引用，在 Provider 输入里用经 Host 校验的 `AttachmentContent`；Harness 必须显式声明能力并在实际协商后复查，缺少 Host 读写接口时拒绝。

- personalContext 只有履行私有历史与显式插件租约契约的 Driver 才声明；personal 输入只接受 Host 构造。

- `setConfig` 在异步准备后、外部修改前调用 `options.authorize`；拒绝立即结束，回调和配置原值不进入持久回执。
