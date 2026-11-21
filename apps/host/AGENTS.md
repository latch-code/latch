# @latch/host

| 路径 | 职责 |
| --- | --- |
| `src/server.ts`、`routes/`、`src/task-delta.ts`、`src/task-content.ts` | HTTP/SSE、认证、投影与限速（route-guards.test） |
| `src/native*.ts`、`relay/` | 原生连接、发现、墓碑与目录 |
| `src/auth.ts`、`presence*.ts`、`agent-probes.ts`、`audit.ts`、`policy.ts`、`egress.ts`、`model-*.ts`、`model-gateway/`、`risk.ts`、`paths.ts` | 登记、设备与本机确认；审计；`policy.json`；出站与模型网关；风险分级；路径 |
| `src/{host-state,crypto,identity,hub,session-meta,prompt-queues,questions,config,providers}.ts`、`src/agent-*.ts` | 状态、锁、加密、回执与配置 |
| `src/plugins/<种类>/<id>/` | 内置插件：`providers/` 下各协议与 `demo`（共用 `http.ts`、`service.ts`、`*-wire.ts`）、`tools/{workspace-files,safe-tools}`、`standard` |
| `scripts/` | 启停、CLI、桌面启动与构建（`build-*.ts`） |
| `test/` | 夹具：`test/helpers/host.ts` |

不变量：
- 请求只信 `ListenerContext`，不信代理头（server.test）。
- 先审计再执行：授予或执行权限的操作先写审计，写入失败就不执行；撤销、拒绝、取消、删除、移除权限与收紧策略从不因审计失败受阻（永久删除 Agent 的家除外），响应改带 `x-latch-audit: failed`。审计 detail 只含 ID、哈希、枚举、布尔与计数（`test/server.test.ts`）。
- 审计前后复核附言的 `run` 与私有权限。
- 出站经注入的 `fetch` 和策略，限预置或已确认地址；密钥限绑定的源和路径，更新前与锁内复核所见目标（`test/providers.test.ts`）。
- Standard 由 `classifyStandardCall` 分级；`requiresApproval` 不能降级，未列工具（含插件工具）、异常或未知值均按 R2（`test/risk.test.ts`）。
- 插件目录只用 `@latch/sdk`、`@latch/protocol`、本目录与种类目录下的共用文件，不导入 Host 或其他插件目录；只有 `standard` 用 `@latch/core`（`.oxlintrc.json`）。
- `latchCodeRoot()` 固定代码根，不随项目。
- 同项目的变更与启动串行、跨项目不等，撤销和收紧仍可并行；旧会话保留冻结目录（`test/project-regressions.test.ts`）。
- 确认只经 `PresenceService`，无设备签名批准。开发固定 CDHash，发布固定身份与审计，缺一须离线重新固定，运行前核验子进程（ARCHITECTURE）。
- 终端限 `host.sock`、`run` 与 `all`，复核目录身份，环境用 `terminalEnvironment`。
- 本机 MCP 提示先审计、持久化来源再转发；远程拒绝（MCP.md）。
- 构建禁测试代码；组件自检。私有框架限画面，输入限 idb Unix 套接字。
- `work` 不见文件差异；扩展报告限 `admin`、普通来源。投影不改执行参数、回执、终态（STREAMING）。
- `src/paths.ts`、`host-state.ts`、`env.ts` 只用可擦除语法（`tsconfig.strip.json`），供 Vite 与 Vitest 配置直接加载。
- 附件字节只进私有存储，消息与 SSE 只存引用；上传逐块复查设备，下载句柄绑定设备（`test/attachment-routes.test.ts`）。
- 文件树/搜索限 `files`、`all`；macOS 仅经 `latch-files` 描述符。索引不存权限，预览绑定 Harness/根身份/版本，晚回复查设备与正文窗口（ARCHITECTURE）。
- 插件草稿与应用分离，批准执行摘要后才导入，旧租约真实释放后回收（PLUGIN-DEVELOPMENT、`test/plugin-package-api.test.ts`）。
- 准备及配置回执见 ARCHITECTURE。外观写入需基版与回执，替换前复核权限，目录同步未确认复用原请求（CUSTOMIZATION）。
- 插件连接仅随原生入口启用；远程 review/正文窗口与真实关闭见 [STREAMING](../../docs/STREAMING.md#原生客户端的流)。
- 家只由分配器建、核身份，空时重建，经 `latch-home` 删；默认项走 startConfig。后台按实际等级核上限，手动运行不授后台权。
- 网关、Agent、设备、Git、终端等功能的规则见 ARCHITECTURE「各功能的安全规则」。
