# @latch/core

Cordis 插件注册表（`src/registry.ts`）、Standard 执行循环（`src/runtime.ts`）、面板文档校验（`src/ui-panels.ts`）与原子快照存储（`src/store.ts`）；子路径 `@latch/core/node-kit` 放 Host 与 Harness 共用的 Node 工具：`canonicalJson`、`sha256Hex`、`writeFileAtomic`、`syncDirectory`、`redactSecrets`，以及运行计时 `RunClock` 与 `ReasoningTimer`。`./file-tracking` 供 Driver 共用运行文件观察生命周期。不负责 Host 的组合与 Harness 路由。

运行环境 node；只用 `@latch/protocol`、`@latch/sdk`、`cordis` 与 `zod`。`tsconfig.core.json` 开启 `erasableSyntaxOnly`。

不变量：

- 只有 `src/registry.ts` 和 `tests/registry.test.ts` 导入 `cordis`。升级前用该契约测试验证逆序清理、失败汇总、租约与替换。
- `src/node-kit/` 只导入 `node:` 模块与本目录文件（`.oxlintrc.json`）：`apps/web/vite.config.ts` 经 `host-state.ts` 让 Node 只剥离类型加载它，导入它也不会带出注册表或 Cordis。
- 技能在激活时复制、在运行租约中固定，并随输入持久化；替换不改变已开始的一轮。技能与两种界面共享包生命周期，客户端模块只发布元数据与摘要，源码经认证单独读取（`tests/skills.test.ts`、`tests/ui-panels.test.ts`）。
- 执行循环的风险由 Host 的分级器判定，分级器抛错按 R2 处理（`tests/runtime.test.ts#treats a classifier that %s as R2`）。
- 会话的文件夹在创建时固定：`createTask` 核对 `cwd` 是 `workspaceId` 所指项目的主文件夹、其他文件夹都属于该项目，输入与审批决定之前再核对，否则 409 `workspace-changed`（`tests/runtime.test.ts#freezes the folders when the session starts, and stops input once one of them leaves the project`）。
- 新增秘密格式时补充 `redactSecrets`：凭据本身的格式也决定文件是否可能含密钥（`containsSecret`），只携带凭据的 Cookie、请求头、URL 参数与 userinfo 写法只用于日志（`tests/redact.test.ts#leaves ordinary text alone`）；改 `canonicalJson` 前读根 `AGENTS.md`「共享安全编码」。

测试在根项目 `tests/`（`pnpm test --project latch`）；改动后运行 `pnpm lint`、`pnpm test` 与 `pnpm test:e2e`。插件生命周期见 [docs/PLUGIN-DEVELOPMENT.md](../../docs/PLUGIN-DEVELOPMENT.md)，消息与取消见 [docs/STREAMING.md](../../docs/STREAMING.md)。

- 附件历史只持久化引用；每轮经注入的 `readAttachment` 读取并核对字节，图片必须由所选模型明确声明 vision，绝不把 base64 写入快照。
- 工具结果按最终请求计量，限量保存字节数、纳入状态和来源引用。引用不发给模型。

- 文件产物只表示运行时间窗口中的观察；旧运行的晚到结算只更新原消息，不改新运行或会话排序。范围与预算见 ARCHITECTURE。

- `propose_memory`、`propose_schedule` 与只读的 `recall_memory` 只给上下文带 `proposals` 且 Host 给了回调的运行，文字委托中全部关闭，普通只对话运行可用，不经分级；提议待人确认，自上次清空上下文以来有过 R2 调用、查到外部记忆或带 `unattended` 时标为外部（`tests/{propose,recall}-memory.test.ts`）。
- Agent 的说明与记忆只在本轮 Run 传递，不进入持久历史；带 `personal` 的旧会话拒绝新一轮（409 `session-read-only`）；显式 pluginIds 同时约束工具展示与实际分发，缺选中的插件就拒绝；带 expectedRevisions 的租约还要同步核对实际 Provider 与完整插件修订。
- `retire()` 先禁止新租约，旧代等真实释放后清理。自定义插件收紧与旧停用接口的区别见 [PLUGIN-DEVELOPMENT.md](../../docs/PLUGIN-DEVELOPMENT.md#插件对象与生命周期)。
- 传输租约先失效并关闭，再等真实 release 才卸载；不能把永久监听变成无法停用的普通运行租约。见 [TRANSPORT-PLUGINS.md](../../docs/TRANSPORT-PLUGINS.md)。
