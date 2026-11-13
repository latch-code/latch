# @latch/host

| 路径 | 职责 |
| --- | --- |
| `src/server.ts`、`routes/`、`listeners.ts`、`access.ts`、`http-util.ts`、`preview-frames.ts`、`traffic.ts`、`not-found.ts` | HTTP/SSE 入口与路由模块（`test/route-guards.test.ts`）、认证、限速、CSP、流量与 404 |
| `src/native*.ts`、`relay/` | 原生连接、发现、墓碑与目录 |
| `src/auth.ts`、`presence*.ts`、`agent-probes.ts`、`audit.ts`、`policy.ts`、`egress.ts`、`model-*.ts`、`risk.ts`、`paths.ts` | 设备与登记；本机确认与理由；审计；`policy.json`；出站与模型网关；风险分级；路径 |
| `src/host-state.ts`、`crypto.ts`、`identity.ts`、`hub.ts`、`session-meta.ts`、`prompt-queues.ts`、`questions.ts`、`agent-*.ts`、`config.ts`、`providers.ts` | Host 状态与锁、加密、会话路由及回执、Agent 与接力规则、配置与插件（`plugin-packages.ts`） |
| `src/plugins/<种类>/<id>/` | 内置插件：`providers/` 下各协议与 `demo`（共用 `http.ts`、`service.ts`、`*-wire.ts`）、`tools/{workspace-files,safe-tools}`、`standard` |
| `scripts/` | 启停、CLI、桌面启动与构建（`build-files.ts`、`build-terminal.ts`） |
| `test/` | Host 夹具在 `test/helpers/host.ts` |

不变量：

- 请求只信 `ListenerContext`，不信代理头（server.test）。
- 先审计再执行：授予或执行权限的操作先写审计，写入失败就不执行；撤销、拒绝、取消、删除、移除权限与收紧策略从不因审计失败受阻，响应改带 `x-latch-audit: failed`。审计 detail 只含 ID、哈希、枚举、布尔与计数（`test/server.test.ts`）。
- 出站只经注入的 `fetch` 与出站策略，限预置或已确认地址；密钥限绑定的源与路径（[网关](../../docs/MODEL-GATEWAY.md)、`test/providers.test.ts`）。
- Standard 由 `classifyStandardCall` 分级；`requiresApproval` 不能降级，未列工具（含插件工具）、异常或未知值均按 R2（`test/risk.test.ts`）。
- 插件目录只用 `@latch/sdk`、`@latch/protocol`、本目录与种类目录下的共用文件，不导入 Host 或其他插件目录；只有 `standard` 用 `@latch/core`（`.oxlintrc.json`）。
- 程序目录由 `latchCodeRoot()` 定位仓库根，不随进程的项目目录变化；规则见 [ARCHITECTURE](../../docs/ARCHITECTURE.md#路径与项目目录)。
- 同项目的变更与启动串行、跨项目不等，撤销和收紧仍可并行；旧会话保留冻结目录（`test/project-regressions.test.ts`）。分支与工作树规则见 [BRANCHES.md](../../docs/BRANCHES.md)。
- 本机确认只经 `PresenceService` 的系统表单（`PRESENCE_ACTIONS`），没有设备签名批准的路径。
- 终端限 `host.sock`、数据范围 `all`，环境只经 `terminalEnvironment`（[TERMINAL.md](../../docs/TERMINAL.md)）。
- 构建拒绝测试代码（security.test）。
- `src/paths.ts`、`host-state.ts`、`env.ts` 只用可擦除语法（`tsconfig.strip.json`），供 Vite 与 Vitest 配置直接加载。
- 附件字节只进私有存储，消息与 SSE 只存引用；上传逐块复查设备，下载句柄绑定设备（`test/attachment-routes.test.ts`）。
- 文件树/搜索限 `all`；macOS 仅经 `latch-files` 描述符。索引不存权限，预览绑定 Harness/根身份/版本，晚回复查设备与正文窗口（ARCHITECTURE）。
- 自定义插件草稿与应用分离；批准执行摘要后才导入，旧租约真实释放后回收。边界见 [PLUGIN-DEVELOPMENT.md](../../docs/PLUGIN-DEVELOPMENT.md#应用内的自定义插件资产)（`test/plugin-package-api.test.ts`）。
- 配置回执见 [Arch](../../docs/ARCHITECTURE.md)；交付摘要的限额与授权见 [交付](../../docs/GIT-DELIVERY.md#状态)。
- 插件连接仅随原生入口启用；远程 review/正文窗口与真实关闭见 [TRANSPORT-PLUGINS.md](../../docs/TRANSPORT-PLUGINS.md)。

- 家只由分配器生成并核对原目录身份；默认项走 startConfig。后台按实际等级核上限，手动运行不授后台权（CUSTOM-AGENTS、AUTOMATIONS）。
