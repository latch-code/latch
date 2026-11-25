# @latch/host

| 路径 | 职责 |
| --- | --- |
| `src/{server,task-delta,task-content}.ts`、`routes/` | HTTP/SSE、认证、投影与限速（route-guards.test） |
| `src/native*.ts`、`relay/` | 原生连接与发现（跨网配对见 RELAY.md）、墓碑、目录 |
| `src/auth.ts`、`presence*.ts`、`agent-probes.ts`、`audit.ts`、`policy.ts`、`egress.ts`、`model-*.ts`、`model-gateway/`、`risk.ts`、`paths.ts` | 登记、设备与本机确认；审计；`policy.json`；出站与模型网关；风险分级；路径 |
| `src/{host-state,crypto,identity,hub,session-meta,prompt-queues,questions,config,providers}.ts`、`src/agent-*.ts` | 状态、锁、加密与回执 |
| `src/plugins/<种类>/<id>/` | `providers/`、`tools/`、`standard`、`workspace/marketplace` |
| `scripts/` | 启停、CLI、桌面启动与构建 |
| `test/` | 夹具：`test/helpers/host.ts` |

不变量：
- 请求只信 `ListenerContext`，不信代理头。
- 授权与执行先写审计，失败即拒绝；撤销、拒绝、取消、删除与收紧照常（永久删除 Agent 的家除外），响应带 `x-latch-audit: failed`。审计 detail 只含 ID、哈希、枚举、布尔与计数（`test/server.test.ts`）。
- 审计前后复核附言的 `run` 与私有权限。
- 出站经注入的 `fetch` 和策略，限预置、已确认或固定的地址；密钥限绑定的源和路径，更新前与锁内复核所见目标（`test/providers.test.ts`）。
- Standard 由 `classifyStandardCall` 分级；`requiresApproval` 不能降级，未列工具（含插件工具）、异常或未知值均按 R2（`test/risk.test.ts`）。
- 插件目录只用 `@latch/sdk`、`@latch/protocol`、本目录与种类目录下的共用文件，不导入 Host 或其他插件目录；只有 `standard` 用 `@latch/core`（`.oxlintrc.json`）。
- 数据面板调用与返回前核对会话当前读取权限（`test/ui-panels.test.ts`）。
- `latchCodeRoot()` 固定；自动避开，显式可选，写入仍 R2。
- 项目内变更与启动串行，跨项目及撤销收紧可并行。会话冻结目录；项目摘要复核当前成员与文件权限。
- 确认只经 `PresenceService`，无设备签名批准。开发固定 CDHash，发布固定身份与审计，缺一须离线重新固定，运行前核验子进程（ARCHITECTURE）。
- 终端、工作电脑限 `host.sock`、`run`、`all`；终端复核目录身份，环境用 `terminalEnvironment`。
- 改绑核设备、请求 ID 与体哈希。@ 只投本机唯一聊天。主动委托核收发双方授权。
- 本机 MCP 提示先审计、持久化来源再转发；远程拒绝（MCP.md）。
- 构建禁测试代码；组件自检；私有框架限画面，输入走 idb Unix 套接字。
- `work` 不见文件差异；扩展报告限 `admin`、普通来源。投影不改执行参数、回执、终态（STREAMING）。
- `src/paths.ts`、`host-state.ts`、`env.ts` 只用可擦除语法（`tsconfig.strip.json`），供 Vite 与 Vitest 配置直接加载。
- 附件字节仅入私有存储，消息与 SSE 只存引用。上传逐块核权，下载绑定设备，追加沿用原上传者并复核授权。
- 文件树/搜索限 `files`、`all`；macOS 仅经 `latch-files` 描述符。索引不存权限，预览绑定 Harness/根身份/版本，晚回复查设备与正文窗口（ARCHITECTURE）。
- 创作绑 Host 目录。官方查 Git HTTPS；查源、暂存限本机 `admin`、`all`。市场随插件启停（PLUGIN-DEVELOPMENT）。
- 准备及配置回执见 ARCHITECTURE。外观写入需基版与回执，替换前复核权限，目录同步未确认复用原请求（CUSTOMIZATION）。
- 插件连接仅随原生入口启用；远程 review/正文窗口与真实关闭见 [STREAMING](../../docs/STREAMING.md#原生客户端的流)。
- 家由分配器建并验身份，空时重建，经 `latch-home` 删；通用迁移见 ARCHITECTURE。默认项走 startConfig。后台核实际等级，手动不授后台权。
- 权限：ARCHITECTURE。基线与续办：GIT-REVIEW。推送：IOS-NOTIFICATIONS。
