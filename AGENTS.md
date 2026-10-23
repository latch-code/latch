# AGENTS.md

Latch 是跨电脑与手机的 AI Agent 工作台。Node Host（`src/host/server.ts`）持有会话、执行权限、密钥、设备登记与审计；Electron 桌面端经 `host.sock`、本机浏览器经回环地址、手机经运营者提供证书的 HTTPS 连接同一个 Host（HTTP + SSE）。每个会话可组合 Harness（内置 `standard`，或通过 ACP 接入的开源 Agent）、模型服务与项目目录；Provider、Tool 与 HarnessDriver 都以 Cordis 插件注册。安全优先：拿不准时拒绝。

## 开始之前

1. 运行 `git status`，保留已有的未提交改动。
2. 按下方「改动前先读」打开对应文档；以源码与测试为准，不凭记忆推断现状。
3. 不要停止、重启或连接用户正在运行的 Host，也不要使用默认数据目录（见「本机运行安全」）。

## 命令

需要 Node.js ≥ 22.19 与 pnpm 11。

```sh
pnpm install
pnpm typecheck
pnpm test                                    # Vitest 单元与集成（tests/**/*.test.ts）
pnpm exec vitest run --config vitest.config.ts tests/<name>.test.ts
pnpm build                                   # build:host + build:web + build:presence；e2e 使用 dist/web
pnpm build:presence                          # 只构建 macOS 本机确认组件 dist/native/latch-presence
pnpm test:e2e                                # Vitest + Playwright，进程内真实 Host
HARNESS_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm test:e2e
HARNESS_ELECTRON_E2E=1 pnpm exec vitest run --config vitest.e2e.config.ts tests/desktop.e2e.ts
                                             # 仅 macOS，先 pnpm build；用例自带 --use-mock-keychain 与临时 --latch-user-data
pnpm latch --help                            # 打印 device / provider / presence / audit 子命令；调用时都加 --data-dir <临时目录>
pnpm start:demo -- --port 0 --data-dir <临时数据目录> --workspace <临时工作区>
pnpm stop -- --data-dir <同一数据目录>
HARNESS_DATA_DIR=<临时目录> pnpm dev:web      # 仅开发；按 Vite 打印的 http://h-<hostId>.localhost:<端口>/link/ 打开
```

## 代码地图

| 路径 | 职责 |
| --- | --- |
| `src/host/server.ts` | HTTP API、SSE 合并推送、访问规则、本机确认与审计接入、配置读写、插件与 Harness 挂载 |
| `src/host/listeners.ts`、`access.ts`、`http-util.ts` | 监听入口与 `ListenerContext`；凭据提取、Cookie、认证错误、上限与限速；请求体、JSON 与 CSP |
| `src/host/auth.ts` | `DeviceStore`（设备、凭据哈希、续期与轮换、撤销与级联）、`EnrollmentService`（登记、配对邀请、离线登记码） |
| `src/host/presence.ts` | `PresenceService`：确认预览、票据、macOS 确认组件后端 |
| `src/host/audit.ts`、`policy.ts` | 哈希链审计（`AUDIT_DETAIL` 定义每种动作的 detail）；`policy.json` 安全策略与放宽 / 收紧判断 |
| `src/host/egress.ts`、`risk.ts` | 模型请求的出站策略 `createEgressFetch`；Standard 工具风险分级 `classifyStandardCall` |
| `src/host/paths.ts` | 数据、工作区、Agent 安装与运行目录解析；规范路径、受保护路径、项目目录检查 |
| `src/host/crypto.ts`、`identity.ts`、`redact.ts` | base32、SHA-256、`canonicalJson`、P-256 验签与指纹；Host 身份与 hostId；日志脱敏 `redactSecrets` |
| `src/host/host-state.ts` | `host.json`、数据目录锁 `host.lock`、经 `host.sock` 核对 Host |
| `src/host/hub.ts` | `HarnessHub`：多个 Harness 合并为一个 Bridge，按会话与审批 ID 路由，会话元数据 |
| `src/host/bridge.ts`、`src/shared/types.ts` | Bridge 接口与浏览器 DTO（共享协议） |
| `src/host/config.ts`、`providers.ts` | `providers.json` / `settings.json`、Agent 定义、模型服务插件（密钥绑定 `keyOrigin`）、模型列表与检测 |
| `src/shared/presets.ts`、`agent-presets.ts`、`text.ts` | 模型服务与 Agent 预设（仅展示与启动数据）；`escapeSecurityText` 与设备名称规则。浏览器可用，无 Node 依赖 |
| `src/core/registry.ts` | Cordis 插件生命周期、能力冲突、租约、替换 |
| `src/core/plugins.ts`、`harness.ts`、`errors.ts` | 插件 SDK：Provider、Tool、HarnessDriver；`AppError` |
| `src/core/runtime.ts`、`store.ts` | Standard 执行循环（风险来自 Host 注入的 `classifyToolCall`）与原子快照存储 |
| `src/plugins/acp/` | ACP HarnessDriver：`bridge.ts`（会话、启动指纹、权限模式）、`connection.ts`、`protocol.ts`、`mapping.ts`、`store.ts`、`environment.ts`（`agentEnvironment`）、`permission.ts`（`launchHash`）、`project-config.ts` |
| `src/plugins/acp/profiles/` | 每个预设的权限配置与计入启动指纹的项目配置（仅 Host 侧） |
| `src/plugins/openai.ts`、`anthropic.ts`、`workspace.ts`、`demo.ts`、`standard-harness.ts` | 内置模型协议、工作区文件工具、演示模型、Standard Driver |
| `src/client/` | React 客户端：`App.tsx` → `Workspace.tsx`，`components/`、`settings/`、`hooks/`、`styles/`（`tokens.css`） |
| `src/client/useHarness.ts`、`projection.ts`、`useReadingPosition.ts` | 同步与版本门禁、阅读位置（唯一滚动写入者） |
| `src/client/eventStream.ts`、`credentials.ts`、`deviceKey.ts`、`enrollment.ts` | fetch 事件流；凭据续期；WebCrypto 设备密钥；登记与 `#pair=` 邀请 |
| `src/client/securityCopy.ts`、`permissions.ts`、`confirmations.ts`、`auditCheckpoint.ts`、`approvalDecision.ts`、`contentHash.ts` | 安全文案目录；按权限的界面显示；`withConfirmation`；审计回滚检查；审批 `requestId`；新内容哈希 |
| `scripts/start.ts`、`stop.ts`、`latch.ts` | 启动 Host（取锁、写 `host.json`）、核对后停止、`pnpm latch` 命令行 |
| `scripts/desktop.ts`、`desktop-host.ts`、`build.ts`、`build-presence.ts`、`shutdown.ts` | 桌面启动器（启动或复用 Host）、esbuild 打包、构建确认组件、退出清理 |
| `desktop/main.cjs` | Electron 主进程：窗口、`latch://app/` 协议、渲染进程限制、调试参数检查 |
| `desktop/proxy.cjs`、`credentials.cjs`、`host.cjs`、`preload.cjs` | 经 `host.sock` 转发并附加凭据（纯函数，可单测）；设备密钥与凭据（safeStorage）；`host.json` 核对的 CJS 版；只暴露 `latchShell` |
| `native/macos/LatchPresence.swift` | 本机确认组件（Touch ID / 登录密码），`--self-test` 校验共享向量 |
| `tests/` | `*.test.ts`、`*.e2e.ts`；`helpers/`（`startTestHost`、测试确认后端、TLS、`enrollBrowser`）、`vectors/security-v1.json`、`fixtures/fake-acp-agent.mjs` |

## 不变量（违反即缺陷）

**会话与界面**

- Host 是会话状态的唯一权威；网络连接、任务执行与客户端阅读位置分别建模。
- 取消必须等执行端真实结算后才确认；写请求超时保持「结果未知」并复用原 `requestId`。
- 流式消息在完成、失败、取消时沿用同一 ID；切换会话、重连与迟到的响应不得回滚新状态或重复追加历史。
- 只有 `useReadingPosition` 写入滚动位置（`jumpToLatest`、`reveal`）；消息与工具行带 `data-message-id`。改消息布局时检查上翻阅读、内容重排、回到最新与会话切换。
- 真实 Provider 失败必须报错，不得回退到演示模型；演示模式必须显式启用并在界面标注。
- 会话与审批 ID 全局唯一；新增的持久化字段必须加入对应 zod schema。多数 schema 会丢弃未知字段；`policy.json`、设备与登记文件、审计 detail 是 strict，未知字段会被拒绝。ACP 新字段以可选字段加入 `src/plugins/acp/store.ts`。
- 插件与 ACP Agent 是可信本机代码；应用层审批、路径检查与出站策略不是 OS 沙箱，文档与界面不得暗示隔离。
- 兼容标识改名必须附带迁移：`HARNESS_*` 变量、`/link/` 前缀、数据目录布局（含旧 `.runtime`）、模型服务 ID `openai-compatible`、包名 `harness-link`；旧 Cookie `harness_link` 只用于识别需重新确认的浏览器。

**安全**

- **秘密不外泄。** 设备凭据、邀请码、离线登记码与模型密钥不进入标准输出、日志、环境变量、命令行参数、URL、SSE、错误信息、Git 或截图。URL 里的邀请码只出现在配对链接的 `#pair=` 片段中，页面读取后立即从地址栏移除；`pnpm latch` 只把邀请与离线码显示在交互终端，或写入新建的 0600 `--code-file`。Host 的每行日志都经过 `redactSecrets`，新增秘密格式时同步补充模式。
- **磁盘上只存哈希。** 凭据与离线登记码只保存 SHA-256；邀请只在内存中、也只存哈希。模型密钥只在数据目录的 0600 文件中，不返回浏览器；`HARNESS_API_KEY` 只在内存中使用。
- **本机确认只经 `PresenceService`。** 测试确认后端只通过 `startServer({ presence })` 注入；`src/`、`scripts/` 与 `desktop/` 从不导入 `tests/`，构建后 `grep -rn "createTestPresence\|tests/helpers" dist/` 必须为空。需要本机确认的操作只能由 `host.sock` 上的桌面端发起（设备登记例外）。
- **请求上下文只来自监听入口。** 从不读取代理请求头（`forwarded`、`x-forwarded-*` 等）；入口类别、来源与凭据形式由接受连接的 `ListenerContext` 决定。
- **先审计再执行。** 授予或执行权限的操作先写审计，写入失败就不执行。撤销、拒绝、取消、删除、移除权限与收紧策略等减少权限的操作从不因审计失败受阻，改为响应带 `x-latch-audit: failed`。审计 detail 只含 ID、哈希、枚举、布尔与计数。
- **出站只经注入的 `fetch`。** 内置模型协议（`openai.ts`、`anthropic.ts`）只用 Host 传入的出站策略 `fetch`，不导入 `src/host`；密钥只发往保存时绑定的 `keyOrigin`，地址的源改变后视为没有密钥。
- **Standard 风险由 Host 判定。** `classifyStandardCall` 决定 R0/R1/R2，插件声明的 `requiresApproval` 不能降低风险，未列出的工具（含第三方插件工具）为 R2；分级器抛错或返回未知值按 R2 处理。
- **ACP 进程。** 子进程环境只来自 `agentEnvironment`（白名单继承、代理置空，移除 `NODE_OPTIONS`、`HARNESS_*`、`npm_*`、`DYLD_*`、`LD_*`，不区分大小写）。会话只启动与本机确认时 `launchHash` 一致的进程；指纹覆盖命令、参数、定义的环境变量、预设、profile 版本与 profile 列出的项目配置，改变 profile 行为时提高其 `version`。权限行为只写在 `src/plugins/acp/profiles/`，`src/shared/agent-presets.ts` 只放浏览器可用的展示与启动数据。
- **Electron 渲染进程没有网络与凭据。** 渲染进程只能请求 `latch:`（开发运行另允许 `devtools:`），不能开窗或导航出 `latch://app/`（外链经主进程原生对话框确认后才交给系统浏览器），权限请求一律拒绝；设备密钥与凭据只在主进程（safeStorage 加密）。桌面端只经 `host.json` + `host.sock` 找到并核对 Host，不通过环境变量或参数传 URL 与凭据。
- **客户端。** 安全文案只来自 `src/client/securityCopy.ts`，按错误码选择，新增安全相关错误码时在此补充；`permissions.ts` 的界面限制只是展示，Host 会再次检查；事件流用 `eventStream.ts`（fetch），不用 `EventSource`；需要本机确认的请求走 `withConfirmation`，带 `requestId` 的请求重发相同请求体。
- **共享安全编码。** 修改 base32、指纹、`canonicalJson`、确认预览与 previewHash、`hashDisplay`、`escapeSecurityText` 或签名文本时，同时更新 `tests/vectors/security-v1.json`、`native/macos/LatchPresence.swift` 与各处实现（`src/host/crypto.ts`、`auth.ts`（签名文本）、`presence.ts`（确认预览）、`src/shared/text.ts`、`src/client/deviceKey.ts`、`contentHash.ts`、`desktop/credentials.cjs`），再 `pnpm build:presence` 并运行 `presence.test.ts`（自检用例对旧组件失败）。

## 本机运行安全

- 不停止、重启或向已运行的 Host 发信号，不读取、修改或删除 `.runtime*/`。
- 每个命令都显式指定临时目录：`pnpm start` / `start:demo` 带 `--data-dir`、`--workspace` 与 `--port 0`；`pnpm latch`、`pnpm stop` 带同一个 `--data-dir`；`pnpm dev:web` 用 `HARNESS_DATA_DIR`。省略时会落到用户的数据：当前目录的旧 `.runtime/`、平台默认数据目录（macOS 为 `~/Library/Application Support/Latch/Host`）、`~/Latch/workspace` 与端口 4317。
- `pnpm stop -- --data-dir <目录>` 只在经 `host.sock` 核对 PID、hostId 与实例 ID 后发送 SIGTERM；有运行中或等待审批的会话时拒绝（`--force` 仍然停止）；Host 仍在启动（只有 `host.lock`）、锁无法读取或 `host.json` 无法识别时只说明原因、不发信号，以状态 1 退出。只停止自己启动的节点。
- `<数据目录>/host.lock` 由运行中的 Host 或离线 `pnpm latch` 命令持有，记录 PID、实例 ID、角色与开机时间；持有进程已退出或锁写于本次开机之前时自动接管。不要删除其他节点的锁；`.host-lock-*` 是取锁与接管的临时条目，由下一个持锁进程清理。
- 测试与调试只用临时目录、端口 0、本地假模型服务与假 ACP Agent。不调用付费模型，不对真实 Agent CLI 发送提示。不运行 `pnpm desktop`（它使用系统钥匙串与默认桌面端数据目录），桌面端用 Electron e2e 验证。
- `pnpm build` 会更新 `dist/web`，正在运行的旧 Host 会直接提供新页面；客户端必须能在缺少 `snapshot.catalog` 与 `snapshot.host`（旧 Host）时降级运行。修改 `LatchPresence.swift` 后的构建会改变确认组件签名，使用这份代码的已运行 Host 的本机确认随之不可用，需要用户停止 Host 后运行 `pnpm latch presence repin`，完成时告知用户。

## 改动前先读

| 改动 | 文档 |
| --- | --- |
| 模块边界、Harness 路由、持久化、HTTP API；监听入口、设备与凭据、本机确认、安全策略、出站策略、路径与项目目录、审计 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| ACP Agent 接入、进程与环境、项目配置与启动指纹、权限模式读回、取消与恢复 | [docs/HARNESSES.md](docs/HARNESSES.md) |
| SSE、fetch 事件流、凭据续期、重连、消息身份、审批顺序、取消、阅读位置 | [docs/STREAMING.md](docs/STREAMING.md) |
| Provider（出站与密钥）、Tool（风险分级）、插件生命周期、HarnessDriver | [docs/PLUGIN-DEVELOPMENT.md](docs/PLUGIN-DEVELOPMENT.md) |
| 布局、配色、图标、组件与交互，设备与权限界面 | [docs/DESIGN.md](docs/DESIGN.md) |
| 选择测试范围、编写测试、测试 Host 与共享向量 | [docs/TESTING.md](docs/TESTING.md) |
| 用户可见的启动参数、手机接入、`pnpm latch` 命令 | [README.md](README.md) |

## 产品规则

- 界面以蓝白为主，蓝色只用于执行类操作；应用图标为 `public/icon.png`（源图 `build/icon.png`），不改动图形；琥珀色只表示警告与待审批。设计令牌集中在 `src/client/styles/tokens.css`。
- 密钥、Agent 的命令与环境变量、放宽安全策略、批准高风险操作（R2）与开启完全访问会话（L3）只在执行端电脑上处理：桌面端经本机确认，或 Host 停止时的 `pnpm latch` 离线命令；不为远程设备提供绕过路径。
- Harness 预设只收录可在本机安装运行、许可证可核对的开源 Agent，并记录许可证；预设使用已安装的命令，不在运行时下载代码。
- 只展示真实能力：不在界面或文档中声称未实现的功能、集成或隔离；未实现的写明「尚未实现」与原因。

## 完成标准

1. `pnpm typecheck`、`pnpm test`、`pnpm build` 通过；构建后 `dist/` 中没有测试代码（见「安全」）。
2. 修改连接、登记、审批、取消或流式状态时运行 `pnpm test:e2e`；修改 `desktop/` 或桌面启动脚本时再运行 Electron 用例；修改安全模块时运行 [docs/TESTING.md](docs/TESTING.md) 对应的定向用例。
3. UI 改动在手机、平板、桌面宽度检查真实渲染，覆盖正常、进行中、失败或等待状态与深色模式（`tests/design.e2e.ts`、`test-results/` 截图）。测试夹具、测试确认后端与演示模型不等于真实模型、Touch ID 或真机验收；确认窗口只能由用户本人用 `pnpm latch presence test` 人工检查。
4. 行为变化时更新对应的 `docs/` 机制文档。
5. 汇报时区分已执行与未执行的检查。

## 约定

- 测试只用 Vitest（Playwright 仅作驱动）；为新行为添加聚焦用例；不为配置、清单或文档的字面内容写测试。
- 代码风格：严格 TypeScript，边界处用 zod 校验，错误用 `AppError(status, code, 中文消息)`；标识符与注释用英文，注释只写不显而易见的原因。
- 仓库只保存产品代码与机制文档：不在文档中引用其他产品作为设计参考。工作状态写在提交信息、PR 或 issue 中。
- 提交信息使用 Conventional Commits（`feat`、`fix`、`docs`、`design`、`refactor`、`test`、`chore`）。
