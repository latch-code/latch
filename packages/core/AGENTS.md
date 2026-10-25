# @latch/core

Cordis 插件注册表（`src/registry.ts`）、Standard 执行循环（`src/runtime.ts`）、面板文档校验（`src/ui-panels.ts`）与原子快照存储（`src/store.ts`）；子路径 `@latch/core/node-kit` 放 Host 与 Harness 共用的 Node 工具：`canonicalJson`、`sha256Hex`、`writeFileAtomic`、`syncDirectory`、`redactSecrets`，以及运行计时 `RunClock` 与 `ReasoningTimer`。`./file-tracking` 供 Driver 共用运行文件观察生命周期。不负责 Host 的组合与 Harness 路由。

运行环境 node；只用 `@latch/protocol`、`@latch/sdk`、`cordis` 与 `zod`。`tsconfig.core.json` 开启 `erasableSyntaxOnly`。

不变量：

- 只有 `src/registry.ts` 与其契约测试 `tests/registry.test.ts` 导入 `cordis`（`.oxlintrc.json`）；升级 Cordis 以该测试为闸门：逆序清理、失败汇总、租约与替换（`tests/registry.test.ts#continues cleanup in awaited reverse order after synchronous and asynchronous failures`）。
- `src/node-kit/` 只导入 `node:` 模块与本目录文件（`.oxlintrc.json`）：`apps/web/vite.config.ts` 经 `host-state.ts` 让 Node 只剥离类型加载它，导入它也不会带出注册表或 Cordis。
- 技能在激活时复制、在运行租约中固定，并随输入持久化；替换不改变已开始的一轮。技能与两种界面共享包生命周期，客户端模块只发布元数据与摘要，源码经认证单独读取（`tests/skills.test.ts`、`tests/ui-panels.test.ts`）。
- 执行循环的风险由 Host 的分级器判定，分级器抛错按 R2 处理（`tests/runtime.test.ts#treats a classifier that %s as R2`）。
- 会话的文件夹在创建时固定：`createTask` 核对 `cwd` 是 `workspaceId` 所指项目的主文件夹、其他文件夹都属于该项目，输入与审批决定之前再核对，否则 409 `workspace-changed`（`tests/runtime.test.ts#freezes the folders when the session starts, and stops input once one of them leaves the project`）。
- 新增秘密格式时补充 `redactSecrets`：凭据本身的格式也决定文件是否可能含密钥（`containsSecret`），只携带凭据的 Cookie、请求头与参数写法只用于日志（`tests/redact.test.ts#leaves ordinary text alone`）；改 `canonicalJson` 前读根 `AGENTS.md`「共享安全编码」。

测试在根项目 `tests/`（`pnpm test --project harness-link`）；改动后运行 `pnpm lint`、`pnpm test` 与 `pnpm test:e2e`。插件生命周期见 [docs/PLUGIN-DEVELOPMENT.md](../../docs/PLUGIN-DEVELOPMENT.md)，消息与取消见 [docs/STREAMING.md](../../docs/STREAMING.md)。

- 附件历史只持久化引用；每轮经注入的 `readAttachment` 读取并核对字节，图片必须由所选模型明确声明 vision，绝不把 base64 写入快照。

- 文件产物只表示运行时间窗口中的观察；旧运行的晚到结算只更新原消息，不改新运行或会话排序。范围与预算见 [FILE-OUTPUTS.md](../../docs/FILE-OUTPUTS.md)。
