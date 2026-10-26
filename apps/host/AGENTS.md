# @latch/host

Host 的监听、授权、配置与插件组合根。

| 路径 | 职责 |
| --- | --- |
| `src/server.ts`、`listeners.ts`、`access.ts`、`http-util.ts`、`preview-frames.ts`、`traffic.ts`、`not-found.ts` | HTTP/SSE 入口、认证、限速、CSP、流量与 404 |
| `src/native*.ts`、`relay/` | 原生连接、发现、墓碑与目录 |
| `src/auth.ts`、`presence*.ts`、`launch-trust.ts`、`agent-probes.ts`、`audit.ts`、`policy.ts`、`egress.ts`、`risk.ts`、`paths.ts` | 设备与登记；本机确认与理由；审计；`policy.json`；出站策略；风险分级；路径与 `latchCodeRoot()` |
| `src/host-state.ts`、`crypto.ts`、`identity.ts`、`hub.ts`、`session-meta.ts`、`prompt-queues.ts`、`questions.ts`、`personal-*.ts`、`config.ts`、`providers.ts` | Host 状态与锁、加密、会话路由及回执、个人助手、配置与插件（`plugin-packages.ts`） |
| `src/plugins/<种类>/<id>/` | 内置插件：`providers/{openai-compatible,anthropic,demo}`（共用 `http.ts`）、`tools/{workspace-files,safe-tools}`、`standard` |
| `scripts/` | 启停、CLI、桌面启动与构建；`build-files.ts` 构建只读目录组件 |
| `test/` | Vitest；Host 夹具在 `test/helpers/host.ts` |

环境 node。

不变量：

- 请求上下文只来自监听入口：从不读取代理请求头（`forwarded`、`x-forwarded-*` 等），入口类别、来源与凭据形式由接受连接的 `ListenerContext` 决定（`test/server.test.ts`）。
- 先审计再执行：授予或执行权限的操作先写审计，写入失败就不执行；撤销、拒绝、取消、删除、移除权限与收紧策略从不因审计失败受阻，响应改带 `x-latch-audit: failed`。审计 detail 只含 ID、哈希、枚举、布尔与计数（`test/server.test.ts`）。
- 出站只经注入的 `fetch`：内置模型协议只用 Host 传入的 `fetch`，只发往预置或已确认的地址并经出站策略；密钥只发往保存时绑定的源与路径（`test/providers.test.ts`）。
- Standard 由 `classifyStandardCall` 分级；`requiresApproval` 不能降级，未列工具（含插件工具）、异常或未知值均按 R2（`test/risk.test.ts`）。
- 插件目录只用 `@latch/sdk`、`@latch/protocol`、本目录与种类目录下的共用文件，不导入 Host 或其他插件目录；只有 `standard` 用 `@latch/core`（`.oxlintrc.json`）。
- 程序目录由 `latchCodeRoot()` 定位仓库根，不随进程的项目目录变化；规则与离线项目校验的启动上下文见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#路径与项目目录)。
- 项目变更与启动串行，撤销和收紧仍可并行；旧会话保留冻结目录（`test/project-regressions.test.ts`）。只读分支规则见 [BRANCHES.md](../../docs/BRANCHES.md)。
- 原生确认只由本机设备签名批准，仍经 PresenceService；首次启动信任绑定完整指纹和项目目录，规则见 ARCHITECTURE「本机确认服务」。
- 根 `dist/` 构建拒绝测试代码（`test/security.test.ts`）。
- `src/paths.ts`、`host-state.ts`、`env.ts` 只用可擦除语法（`tsconfig.strip.json`）：Vite 与 Vitest 配置经 `@latch/host/…` 让 Node 只剥离类型加载它们。

- 附件字节只进私有存储，消息与 SSE 只存引用；上传逐块复查设备，下载句柄绑定设备（`test/attachment-routes.test.ts`）。
- 文件树/搜索只给 `all`；macOS树仅经 `latch-files` 描述符组件，不回退。索引不存权限；预览绑定Harness、根身份/版本，迟到结果重查设备/正文窗口（`test/file-tree.test.ts`、`test/native.test.ts`）。

- 自定义插件草稿与应用分离；批准执行摘要后才导入，旧租约真实释放后回收。边界见 [PLUGIN-DEVELOPMENT.md](../../docs/PLUGIN-DEVELOPMENT.md#应用内的自定义插件资产)（`test/plugin-package-api.test.ts`）。
- Config RID: [Arch](../../docs/ARCHITECTURE.md).

- 插件连接仅随原生入口启用；远程 review/正文窗口与真实关闭见 [TRANSPORT-PLUGINS.md](../../docs/TRANSPORT-PLUGINS.md)。
