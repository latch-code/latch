---
description: Host 与客户端的整体架构：哪个文件负责哪个机制、workspace 项目与运行环境、安全模型概览、Host 进程与数据目录、会话级别、路径与项目目录、Harness 路由、审批与取消、持久化、桌面端与其他电脑、HTTP API 的路由与权限、兼容标识与尚未实现。
sources:
  - apps/host/src
  - apps/host/scripts
  - apps/desktop/src
  - apps/web/src/core
  - apps/web/src/settings/DataSettings.tsx
  - apps/web/src/deletionCopy.ts
  - apps/web/vite.config.ts
  - packages/protocol/src
  - packages/sdk/src
  - packages/core/src
  - native/macos
  - scripts/boundaries.ts
  - pnpm-workspace.yaml
  - tsconfig.json
  - .oxlintrc.json
  - knip.json
---
# Latch 架构

Latch 由一个 Host 与任意数量的客户端组成。Host 持有会话状态、执行权限、密钥与设备登记；Electron 窗口、浏览器和手机经 HTTP 与 SSE 连接 Host。工具始终在 Host 所在的电脑上执行。

信任在连接设备时建立一次：之后每台设备只受自己的设备权限（scope）限制，都不弹确认。需要在执行端电脑上经本机确认（Touch ID 或登录密码）的操作见「安全模型概览」。模型服务密钥只在桌面端填写。

```text
Latch 桌面端（Electron 主进程）     这台电脑上的浏览器（按远程处理）  手机 / 其他电脑
        │ host.sock                  │ 127.0.0.1 / ::1                  │ HTTPS（运营者提供的证书）
        ▼                            ▼                                  ▼
Host（apps/host/src/server.ts）
  监听入口 · 设备认证与权限 · 本机确认 · 审计 · HTTP API · 静态页面 · 配置 · 插件管理
        │
        ▼
HarnessHub（apps/host/src/hub.ts）── 每个会话路由到它所属的 Harness
  ├─ standard：内置执行循环（packages/core/src/runtime.ts），逐项询问（L1）
  ├─ ACP Agent：每个启用的 Agent 定义一个 Driver（packages/harness-acp），完全访问（L3）
  └─ 插件 Harness：--plugin 加载的其他 HarnessDriver，完全访问（L3）
        ▲
Cordis Context → 每个插件一个 fiber → 清理 effect
  └─ 插件注册 Provider / Tool / HarnessDriver / Transport，Registry 负责租约与替换
```

Provider 负责模型协议转换；Tool 执行一种操作；HarnessDriver 提供完整的 Bridge，可以拥有自己的执行循环、存储与外部进程。

## 代码地图

目录的职责见根 `AGENTS.md`。下表只列哪个文件负责哪个机制。

| 机制 | 源码 |
| --- | --- |
| Host 的组合、`handleApi` 与未拆出的路由 | `apps/host/src/server.ts` |
| 按领域分组的路由模块及其次序 | `apps/host/src/routes/`（`registry.ts`、`index.ts`） |
| 监听入口与 HTTPS 证书热加载 | `apps/host/src/listeners.ts` |
| 限流与访问错误 | `apps/host/src/access.ts` |
| 配置文件读写、模型服务管理 | `apps/host/src/config.ts`、`providers.ts` |
| 运行状态通告、流量计数、时间机器排除 | `apps/host/src/lifecycle.ts`、`traffic.ts`、`backup.ts` |
| 设备与登记、Host 身份、编码与签名 | `apps/host/src/auth.ts`、`identity.ts`、`crypto.ts` |
| 本机确认 | `apps/host/src/presence.ts`、`presence-reason.ts`；组件 `native/macos/LatchPresence.swift` |
| 审计与动作表 | `apps/host/src/audit.ts`、`audit-actions/` |
| 安全策略、出站策略 | `apps/host/src/policy.ts`、`egress.ts` |
| 用 Harness CLI 自己的密钥读厂商余额（只有 DeepSeek Harness，见 [HARNESSES](HARNESSES.md#deepseek-harness-的余额)） | `apps/host/src/cli-quota.ts` |
| 从 Harness CLI 自己的会话日志读 Latch 所启会话一轮的 tokens（只有 DeepSeek Harness，见 [HARNESSES](HARNESSES.md#deepseek-harness-的会话日志)） | `apps/host/src/cli-usage.ts` |
| 路径、项目文件夹、会话文件夹与工作树 | `apps/host/src/paths.ts`、`projects.ts`、`session-folders.ts`、`worktrees.ts`、`data-entries.ts` |
| 风险分级、会话文件裁决 | `apps/host/src/risk.ts`、`files/` |
| 模型网关、用量与预算、工具网关 | `apps/host/src/model-gateway.ts`、`model-gateway/`、`model-usage.ts`、`turn-usage.ts`、`usage-stats.ts`、`model-budgets.ts`、`tool-gateway.ts` |
| `host.json`、数据目录锁、经 `host.sock` 核对 Host | `apps/host/src/host-state.ts` |
| 多 Harness 路由、会话元数据与回执、权限级别、生命周期事件 | `apps/host/src/hub.ts`、`session-meta.ts`、`harness-trust.ts`、`session-lifecycle.ts` |
| 内置插件 | `apps/host/src/plugins/`：`providers/{openai-compatible,openai-responses,anthropic,demo}`（共用 `http.ts`、`service.ts` 与三个 `*-wire.ts`）、`tools/{workspace-files,safe-tools,questions,browser}`、`standard` |
| 启动、停止、`pnpm latch`、桌面启动器、Host 构建选项 | `apps/host/scripts/start.ts`、`stop.ts`、`latch.ts`、`desktop.ts`、`host-bundle.ts` |
| Bridge 接口与扩展接口（Provider、Tool、插件、HarnessDriver、Transport、`AppError`） | `packages/sdk/src/bridge.ts`、`plugins.ts`、`harness.ts`、`transports.ts`、`errors.ts` |
| 浏览器 DTO、预设、安全文本、「这台电脑」的判定 `isLocalListener` | `packages/protocol/src/types.ts`、`presets.ts`、`agent-presets.ts`、`text.ts`、`listeners.ts` |
| Cordis 生命周期、能力冲突、租约、分阶段替换 | `packages/core/src/registry.ts` |
| Standard 的模型循环、审批、取消与快照存储 | `packages/core/src/runtime.ts`、`store.ts` |
| `canonicalJson`、`sha256Hex`、原子写入、日志脱敏 | `packages/core/src/node-kit/` |
| ACP Driver：会话、进程与协议、权限配置 | `packages/harness-acp/src/runtime.ts`、`wires/`、`profiles/` |
| 桌面端：窗口与协议、经 `host.sock` 转发并附加凭据 | `apps/desktop/src/main.cjs`、`proxy.cjs`、`preload.cjs` |
| 桌面端：设备密钥与凭据、Host 核对 | `apps/desktop/src/credentials.cjs`、`host.cjs` |
| 桌面端：其他电脑 | `apps/desktop/src/computers.cjs`、`remote-proxy.cjs` |
| 桌面端：Host 的生命周期、通知、更新 | `apps/desktop/src/lifecycle.cjs`、`notifications.cjs`、`updater.cjs` |
| 桌面端：添加文件夹、文件的本机动作与编辑器、预览浏览器 | `apps/desktop/src/folders.cjs`、`files.cjs`、`editors.cjs`、`browser.cjs` |
| 页面中无布局的核心（通信、同步、阅读位置、安全文案、本机确认流程） | `apps/web/src/core/` |
| 兼容入口 `latch/plugin-sdk`、`latch/harness-sdk` | `src/plugin-sdk.ts`、`src/harness-sdk.ts` |

### Workspace 项目

仓库是 pnpm workspace。每个项目的目录、运行环境与可用的 workspace 包只写在 `scripts/boundaries.ts` 的 `PROJECTS`；仓库根 `latch` 也有一行（兼容入口、仓库脚本与 `tests/`）。每个项目在 `package.json` 中用 `"latch": { "env": … }` 声明运行环境（`isomorphic`、`browser`、`node`、`electron-main`；仓库根不声明）。

`pnpm check:boundaries` 按这张表检查：

- 每个 workspace 项目都在表中、位于表中的目录，声明的运行环境与表一致；表中的项目都在 workspace 中。
- 对 workspace 包的依赖都在表允许的范围内，写成 `workspace:*`，且被依赖的包能在该环境运行（浏览器与同构项目不能依赖 Node 项目）。devDependencies 只由测试与工具加载，可以是 Node 项目。
- `@latch/` 下的名称只能是 workspace 项目；仓库根不能被依赖。
- 标为只供测试的项目（`@latch/testkit`、`@latch/e2e`）只能写在 devDependencies。
- iOS 的 `LatchScreens` 专用代码只出现在 `native/ios/Screens/` 或 `native/ios/App/` 的 `#if LATCH_SCREENS` 中，不进共享核心。

`.oxlintrc.json` 的 `no-restricted-imports` 与 `import/no-cycle` 守住导入边界，违反时 `pnpm lint` 失败：

- workspace 项目只经包名与 `exports` 导入，不经相对路径进入 `apps/`、`packages/` 或 `e2e/`。
- 只有 `packages/core/src/registry.ts` 与它的契约测试 `tests/registry.test.ts` 导入 `cordis`；升级 Cordis 只改注册表，以契约测试为闸门。
- `packages/core/src/node-kit/` 只导入 `node:` 内置模块与本目录的文件。
- `apps/web/src/core/` 只导入本目录的文件、`react` 与 `@latch/protocol`。
- 只有测试导入 `@latch/testkit` 与测试目录中的文件。
- 内置插件目录（`apps/host/src/plugins/<种类>/<id>/`）只导入 `@latch/sdk`、`@latch/protocol`、已安装的包、本目录与种类目录下的共用文件；Standard 是唯一可用 `@latch/core` 的插件目录。

其他规则：

- **knip。** 未声明与无法解析的导入是错误；第二遍以 `--strict` 只用每个项目自己的 `dependencies` 检查生产代码，因为 Node 会沿目录向上找到根 `node_modules` 中未声明的包。knip 只静态读取 `apps/web/vite.config.ts`，不执行它（执行时会读取默认数据目录）。
- **包入口。** 包只经 `package.json` 的 `exports` 导入，入口都指向 TypeScript 源码。`@latch/protocol/types`、`@latch/sdk/plugins` 与 `@latch/sdk/harness` 是只含类型的入口；兼容入口与 SDK 的类型文件不经包的入口 `index.ts`，因为外部项目没有开启 `allowImportingTsExtensions` 时不能检查 `export *` 再导出的 `.ts` 文件。
- **Host 构建。** `apps/host/scripts/host-bundle.ts` 把 workspace 包打进 bundle，根 `package.json` 声明的已安装依赖保持为外部导入，所以 workspace 项目运行时用到的已安装依赖也由根项目声明。入口引到测试代码时构建失败（见 [TESTING.md](TESTING.md#构建产物检查)）。
- **只剥离类型加载的模块。** Vite 把 `vite.config.ts` 引到的 workspace 包与 `@latch/host/paths`、`host-state`、`env` 留给 Node 只剥离类型后加载，所以这些代码开启 `erasableSyntaxOnly`：不用 enum、namespace 与构造函数参数属性。
- **程序目录。** `latchCodeRoot()` 从模块所在目录向上找根包的 `package.json`（名称见「兼容标识」），越过各项目自己的 `package.json`。
- **目录组件。** `latch-files` 构建到临时文件，签名并自检通过后才原子替换旧产物；自检失败保留旧版本。

### 插件与能力组合

插件是用户组合并启停功能的单位：一个包可以同时注册 Provider、Tool、HarnessDriver、技能、数据面板与会话面板，Cordis fiber 是统一的生命周期拥有者。包的格式、应用内自定义插件的草稿与批准、技能与面板见 [PLUGIN-DEVELOPMENT.md](./PLUGIN-DEVELOPMENT.md)。

- 激活失败撤回整个包；运行租约固定旧代，替换提交后新请求使用新代。
- Host 模块与 UI 模块都是用户显式加载的可信代码，分别拥有 Host 进程与当前页面的权限；挂载位置、上下文接口和错误边界都不构成安全隔离。
- 客户端模块是发给所有查看设备的内容，不能携带 Host 私密数据。

## 运行环境

每个文件只按它实际运行的环境做类型检查。`pnpm typecheck` 运行 `tsc -b`，根 `tsconfig.json` 只引用以下配置：

| 环境 | 配置 | 代码 | 类型 |
| --- | --- | --- | --- |
| 同构 | `tsconfig.isomorphic.json` | `packages/protocol`、`packages/link-wire/src` | 只有标准库，没有 DOM，不加载 Node 类型 |
| 插件 SDK | `tsconfig.sdk.json` | `packages/sdk` | Node ES 模块，无 DOM；`isolatedDeclarations`：导出须写明类型 |
| Core | `tsconfig.core.json` | `packages/core` | Node ES 模块，无 DOM |
| 浏览器 | `tsconfig.web.json` | `apps/web/src`、`packages/ui/src`、`packages/app-sdk/src` | DOM，不加载 Node 类型 |
| Host | `tsconfig.host.json` | `apps/host/src`、`apps/host/scripts`、`apps/relay/src`、`apps/relay/scripts`、`packages/link-client/src`、`packages/harness-acp/src`、兼容入口、`scripts`、根目录的 `*.config.ts`、`apps/web/vite.config.ts` | Node ES 模块，无 DOM |
| 只剥离类型加载的 Host 模块 | `tsconfig.strip.json` | `apps/host/src/paths.ts`、`host-state.ts`、`env.ts` | 同 Host，另开启 `erasableSyntaxOnly` |
| 桌面端 | `tsconfig.desktop.json` | `apps/desktop/src` | Electron 与 Node 的 CommonJS，用 `checkJs` 检查，无 DOM |
| 测试 | `tsconfig.tests.json` | `tests`、`e2e`、各项目的 `test`、`packages/testkit` | Node 与 DOM |

- 同构包在自己的环境中检查，使用 DOM 或 Node 的全局变量都会报错。
- 部分依赖的类型声明会把 Node 的全局类型带进浏览器程序，类型检查拦不住 `process` 或 `Buffer`。`.oxlintrc.json` 补上这一层：浏览器与同构代码不得使用 Node 全局变量与内置模块，ES 模块不得使用 `require`、`__dirname` 等 CommonJS 全局变量。
- esbuild 不跟随根配置的引用，Host 构建显式使用 `tsconfig.host.json`。

## 安全模型概览

Latch 的安全边界是「谁能让 Host 做什么」，不是对执行代码的隔离：

- **Host 是唯一权威。** 每个请求的身份只来自接受连接的监听入口与设备凭据。
- **设备各自持有密钥。** 每台设备在登记时生成自己的密钥，Host 只保存公钥与凭据哈希。
- **只有 `host.sock` 算这台电脑。** 回环端口也可能被转发到别处，所以回环与其他入口一样按远程处理。
- **能力按设备分级。** 设备权限决定能调用哪些接口，这是唯一的限制；监听入口决定能否扩大权限；会话级别（L1 / L3）说明 Latch 是否逐项把关。
- **本机确认只留给真实边界。** 动作只有 `PRESENCE_ACTIONS`（`apps/host/src/presence.ts`）列出的：
  - 连接新设备（`device.enroll`、`device.enroll-native`）与扩大设备权限（`device.grant`）；
  - 加入出站地址（`policy.change`）与确认新的模型服务地址（`provider.confirm-origin`）；
  - 应用含执行内容的自定义插件（`plugin.package.apply`）；
  - 新增或放宽 MCP 服务器（`mcp.server.apply`，见 [MCP.md](./MCP.md)）；
  - 与预设不同的 Harness 命令、参数与变量，或预设命令解析到另一个程序（`harness.command.apply`，见 [HARNESSES.md](./HARNESSES.md)）。预设的原样命令与预设模型服务的 HTTPS 地址不确认，审计照写（stepup `preset` 或 `none`），L3 运行或等待时同样拒绝。
- **确认只在这台电脑上发起。** 只有经 `host.sock` 认证的已登记设备能发起；设备登记是唯一例外，而 `host.sock` 以外的登记还要先有一次性邀请。从未有过设备时，桌面端在 `host.sock` 上的第一次连接不需要确认。有完全访问会话在运行或等待时确认被拒绝。
- **不弹确认的操作只留审计。** 开始 Agent、放宽模式、批准操作、改 Harness 的名称与开关：Agent 是没有沙箱的可信代码，审批是人选择的看管程度。
- **先审计再执行。** 授予或执行权限的操作先写入审计记录，写入失败则拒绝执行；降低权限的操作从不因审计失败而受阻。

模型网关（独立回环端口、每进程凭据，密钥只在 Host 向已确认服务发请求时注入）见 [MODEL-GATEWAY.md](MODEL-GATEWAY.md)。

### 文件差异的数据范围

数据范围有三档：`work` 只能打开会话提到过的文件；`files` 是会话与项目的文件：浏览、读写已保存项目与会话文件夹里的文件和改动，私有会话留下的工作树除外；`all` 还包括私有会话与 Agent、终端和接入其他 CLI 的会话。新登记的浏览器默认 `files`（可以在登记时要更少），这台 Mac 与手机是 `all`（iPhone App 把 `all` 以外都当作不能读文件）；已登记的设备保留原范围，扩大要在 Mac 上经 `device.grant`，缩小随时生效。

`dataScope: 'work'` 的设备读取详情、历史、审批快照与事件流时，Host 省略文件差异正文及文件编辑参数中的内容，只保留动作、路径与结果元数据。`files` 的设备只在工具指名的路径都在会话文件夹内（解析符号链接后）时收到正文，否则同 `work`；`all` 保留完整内容。投影不改变 Driver 的历史、真正的审批参数与模型输入。快照读取期间数据范围变化时返回 `device-scope-changed`，要求重新读取。协议见 [STREAMING.md](STREAMING.md#文件差异的设备投影)。

这不是对会话文字的信息流隔离：消息正文、命令输出与 MCP 结果不凭文本猜测删除，可信本机 Agent 仍能在这些渠道转述内容。

### 不防御的情况

- 插件、ACP Agent 与第三方 Harness 是可信本机代码，没有操作系统沙箱，它们自己的网络访问不受出站策略约束。
- 同一系统用户的进程可以连接 Host、访问数据目录并改写审计记录；哈希链只能让篡改被发现。
- 邀请链接被他人看到时，对方可以在有效期内抢先使用。
- 回环浏览器的凭据会随请求发往同一主机名上其他端口的服务。

## Host 进程与数据目录

### host.json 与数据目录锁

**`host.json`。** `pnpm start`（包括桌面启动器启动的 Host）在 Host 启动完成后写入 `<数据目录>/host.json`（版本 2，0600，原子写入）：PID、hostId、实例 ID、`host.sock` 路径、回环与 HTTPS 地址、启动时间与数据目录，不含凭据；退出时只在它仍记录本实例时删除。`pnpm stop`、`pnpm latch`、桌面启动器与 Electron 主进程都经 `host.sock` 读取 `host-info` 核对 PID、hostId 与实例 ID，从不通过 HTTP 探测。

**`host.lock`。** `<数据目录>/host.lock`（0600）让取锁的进程之间同一时间只有一个持有者，记录 PID、实例 ID、角色（`host` 或 `cli`）与开机时间。

- **持有者。** `pnpm start` 在读取数据目录之前取得它，持有到退出。Host 未运行时修改数据目录的 `pnpm latch` 子命令在执行期间持有它（`latch.ts` 的 `lockStopped`：离线登记、`provider set-key` 与 `provider confirm`、`presence` 的各项、`project` 的各项、`customization reset`）。进程内直接调用 `startServer` 的测试不取锁。
- **创建。** 记录先写入并 fsync 到 `.host-lock-<随机 ID>.new`，再用硬链接放到 `host.lock`；目标已存在时链接失败，所以锁文件出现时已是完整记录。不支持硬链接的文件系统改用 `O_EXCL|O_NOFOLLOW` 原地写入，读到空文件时先当作正在写入并重读。
- **有效。** 持有进程存活（`EPERM` 也算存活）且锁写于本次开机时有效；没有开机时间的锁只按 PID 判断。开机时间在 macOS 读 `kern.boottime`，Linux 读 `/proc/stat` 的 `btime`，其他系统用当前时间减运行时长，允许 30 秒误差。此时第二个 `pnpm start` 与离线命令返回 409 `data-dir-locked`，即使 Host 尚未写出 `host.json`。
- **过期与损坏。** 进程已退出或锁写于上次开机之前时自动接管。无法读取的锁（内容损坏、不是普通文件或是符号链接）不猜测也不删除，返回 409 `data-dir-lock-invalid`。这两个错误都写出锁文件路径；`project` 子命令遇到运行中的 Host 时改报自己的提示。
- **接管。** 同一时间只有一个接管者：把只含自己标记文件的临时目录整体改名为 `<数据目录>/.host-lock-takeover`（目标非空时改名失败），再确认锁仍已过期、自己的标记仍在且开始不到 10 秒，然后移开旧锁、核对内容并创建新锁，最后删除标记与目录。所属进程已退出或超过 30 秒的标记视为残留；取得锁的进程顺带删除超过 30 秒的 `.host-lock-*` 临时条目。
- **不能按版本 2 解析的 `host.json`。** 只看其中记录的 PID：PID 存活或读不出 PID 时，`pnpm start` 与离线命令都拒绝。
- **`pnpm stop`。** 只在经 `host.sock` 核对身份后发送 SIGTERM，从不凭 `host.lock` 或无法识别的 `host.json` 发送信号；无法核对时说明原因并以状态 1 退出。有运行中或待审批的会话时需要 `--force`。等待 10 秒仍未退出时只报告，不强制终止。`--reason restart|update|shutdown` 在发送信号之前报告原因。
- **局限。** 这是同用户进程之间的协作锁，不能阻止同用户进程直接改写数据目录。

### Host 的生命周期

**第一次打开。** 没有准备步骤。没有保存过 Harness 时，默认是有模型的 Latch 内置，否则按预设顺序第一个就绪、能运行命令、自带模型的 Harness（含这台 Mac 上找到、尚未保存的预设）。新增模型服务（`POST /providers` 的 `requestId`）有设备绑定的回执，上限 512 条；结果未知时查询 `GET /providers/additions/:requestId`，用原请求重试，不重新授予地址权限。

**分工。** Host 自己宣布运行状态并重新加载证书。让它常驻、重启和保持唤醒的是桌面端主进程（`apps/desktop/src/lifecycle.cjs`），因为登录项、电源断言与系统睡眠通知只在 Electron 中可用。

- **运行状态通告。** Host 在事件流上发送 `host-state`（帧与客户端处理见 [STREAMING.md](./STREAMING.md)「Host 的状态流」）。`sleeping` 与 `awake` 在收到报告时立即发出，`awake` 之后另发一次 `refresh`；`stopping` 是 Host 关闭时每条流的最后一帧，原因取此前 60 秒内报告的 `restart`、`update` 或 `shutdown`，没有报告时为 `shutdown`。`retryAfter`（秒）默认 `restart` 2、`update` 10、`sleep` 10、`shutdown` 15，报告可给 1–3600。
- **报告。** `POST /link/api/host/state` 只在 `host.sock` 上接受（不带设备凭据，只用于通告与展示），其他入口 404；桌面端页面经主进程转发的这类请求由主进程返回 403 `shell-managed`。桌面端另报 `{ state: 'desktop', keepAwake, pid }`（[AUTOMATIONS.md](AUTOMATIONS.md#到点前后保持唤醒)；`pid` 是它的主进程，「操控这台 Mac」据此拒绝指向 Latch 的调用，见 [MCP.md](MCP.md#逐次核对)）。
- **谁报告。** 主进程在 `powerMonitor` 的 `suspend` 与 `resume` 时报告睡眠与唤醒。系统宣布注销、重启或关机时只报告 `shutdown`，不停止 Host（注销可能被取消）；随后 30 秒内系统要求桌面端退出时，主进程推迟退出，停止 Host（核对后 SIGTERM，最多等 3 秒）再退出。所有者自己退出桌面端（⌘Q）不停止 Host。睡眠前的最后一帧不保证送达。
- **启动记录。** 桌面启动器启动 Host 后写入 `<数据目录>/desktop-launch.json`（0600，原子写入）：版本、Host 的 PID 与 hostId、启动方式 `launch`。环境中有数据目录以外的 Host 设置（`HOST_ENV_NAMES`）时 `launch` 为 null，因为桌面端无法按原样启动它。写入失败时照常返回已启动的 Host，并提示它不会被自动重启。主进程严格解析它，不符合的内容视为没有记录。
- **崩溃后重启。** 主进程每 5 秒读 `host.json` 并经 `host.sock` 核对。有序停止会删除 `host.json`，所以它仍记录一个已退出的进程就是崩溃。只有 PID 与 hostId 都和启动记录一致、且 `launch` 不为 null 的 Host 会被重启：等待 1、2、4、8……秒（最长 30 秒），60 秒内没有核对通过或启动后立即退出都算一次崩溃，10 分钟内第 5 次崩溃时停止自动重启。其他 Host 崩溃时只报告。
- **没有响应。** 进程还在、但连续 3 次检查都无法核对的 Host 不再算作运行中，也不再让电脑保持唤醒；主进程不停止它，因为它可能只是忙。
- **手动重启。** 仅限启动记录中的 Host，且没有运行中或等待审批的会话：先报告 `restart`，核对后 SIGTERM，等它退出（最多 60 秒，它先结束会话的进程）再启动。桌面端启动时没有运行中的 Host 而启动记录可用，按记录启动一次（最多等 60 秒），失败不重试。
- **重建后启动。** Host 启动时取一次构建号（`readCodeBuild`：启动脚本的字节与旁边 `dist/web/build.json` 的 SHA-256），在 `host-info` 的 `build` 里报告。`pnpm desktop` 复用启动记录中的 Host（启动脚本是这个目录的 `dist/start.js`）前从磁盘再取一次；不同（或 Host 没有报告）就是重建过，其他 Host 照旧复用、不比较。没有运行中或等待审批的会话时，启动器先报告 `restart`，核对后 SIGTERM，等它退出（最多 30 秒，从不 SIGKILL），再按本次参数启动并打印「检测到新的构建，已重启 Host。」，然后才打开窗口。忙、或它的设置来自环境变量而本次没有时，复用它并用一行说明原因。
- **重启期间的转发。** 主进程自己停止或启动 Host（手动重启、更新、崩溃后等待重启）时，转发失败只回 502 `host-unavailable`，页面显示正在重连，日志不记；其他情况下（例如另一次 `pnpm desktop` 重启了 Host）连不上超过 15 秒才记一次「转发请求失败」，恢复后重新计时。
- **忙时保持唤醒。** 主进程每 5 秒从 `host-info` 读取运行中与等待审批的会话数。接电源时，有会话运行或有审批等待就持有 `powerSaveBlocker('prevent-app-suspension')`；用电池时只在有会话运行时持有，每次最长 1 小时。Host 未运行或没有响应时释放。开关保存在桌面端数据目录的 0600 `lifecycle.json`。
- **没有窗口时。** 在 macOS 上关闭最后一个窗口不退出桌面端，重启与保持唤醒照常；退出桌面端后这两项停止，Host 继续运行。
- **登录项。** 只有打包后的 Latch.app 提供「登录时打开 Latch」：开发运行时登记的会是 Electron 自己的 app 包。打包构建见「尚未实现」。

**时间机器。** Host 每次启动时把含秘密的条目排除在时间机器备份之外：`auth/`、`identity/`、`mcp/`、`native/`、`providers.json`、`settings.json` 与 `provider.json`；改动快照的目录在打开时排除。

- `providers.json` 与 `settings.json` 每次写入的新文件在替换旧文件之前就已排除。
- `settings.json` 整个不备份，因为 Agent 定义的环境变量值常是 API Key，而启动指纹覆盖这些值，拆到另一个文件会让一次保存有两个提交点。代价是默认值、项目列表与 Agent 定义不随备份恢复。
- 桌面端主进程排除自己数据目录中的 `latch-devices/`。
- 做法是由 `/usr/bin/xattr` 以固定参数写入扩展属性 `com.apple.metadata:com_apple_backup_excludeItem`，值与 `tmutil addexclusion` 写入的相同；不直接调用 `tmutil`，因为它要等备份守护进程应答。已带该属性的条目不改写，不存在的路径跳过，从不读取文件内容，失败只记日志。
- 会话、审计、`policy.json` 与 `host.log` 照常进入备份。

## 会话级别与审批风险

| Harness | 级别 | 谁把关 | 设备权限 |
| --- | --- | --- | --- |
| `standard` | L1：逐项询问 | Latch：Host 对每个工具调用分级 | `run` 发起与输入，`approve:standard` 批准 R1，`approve:elevated` 批准 R2，`view` 拒绝与取消 |
| ACP Agent、插件 Harness | L3：完全访问 | 无：Agent 自己的询问只是提示 | `run` 发起、输入、放宽模式与允许询问，`view` 拒绝与取消 |

所有设备与这台 Mac 相同，只看设备权限。Standard 工具调用的风险等级（R0、R1、R2）见 [PLUGIN-DEVELOPMENT.md](./PLUGIN-DEVELOPMENT.md#风险分级与审批)。

## 路径与项目目录

| 路径 | 解析顺序 |
| --- | --- |
| 数据目录 | `--data-dir` → `LATCH_DATA_DIR` → 当前目录下已存在的 `.runtime`（打印迁移提示）→ macOS `~/Library/Application Support/Latch/Host`，Linux `${XDG_DATA_HOME:-~/.local/share}/latch/host`，Windows `%APPDATA%\Latch\Host` |
| 启动目录 | `--workspace` → `LATCH_WORKSPACE` → 数据目录内已存在的 `workspace`（打印提示）→ `~/Latch/workspace` |
| 工作树目录 | `LATCH_WORKTREES_DIR` → 启动目录旁边的 `worktrees`（见 [BRANCHES.md](BRANCHES.md#新建工作树)） |
| Agent 安装目录 | `LATCH_AGENTS_DIR` → macOS `~/Library/Application Support/Latch/Agents`，Linux `${XDG_DATA_HOME:-~/.local/share}/latch/agents`，Windows `%APPDATA%\Latch\Agents`（只用于重叠检查） |
| 运行目录 | macOS 的 `DARWIN_USER_TEMP_DIR`（否则 `TMPDIR`）、Linux 的 `XDG_RUNTIME_DIR`，都没有时 `/tmp/latch-<uid>`；其下的 `latch-<hostId 前 8 位>/` 放 `host.sock` 与会话临时目录 |

- 有命令行参数时不读对应的环境变量。相对的 `XDG_DATA_HOME` 被忽略。
- 数据目录必须是当前用户拥有的目录（不是符号链接），否则拒绝启动（500 `data-dir-insecure`）；权限收紧到 0700。启动目录不存在时以 0700 创建。
- 运行目录及其父目录必须是当前用户拥有的真实目录，运行目录与其中的 `tmp/` 不带组与其他人的权限位（500 `runtime-dir-insecure`）；`host.sock` 路径超过 103 字节时 500 `runtime-dir-too-long`；Windows 上 500 `runtime-dir-unsupported`。`host.sock` 只靠这个目录的属主与权限保护。
- Host 从不自己选一个位于 Latch 程序目录内的启动目录：数据目录内的 `workspace` 与程序目录重叠时改用 `~/Latch/workspace`，原目录中的文件不移动。`--workspace` 与 `LATCH_WORKSPACE` 是所有者自己的选择，照样使用。
- 路径比较用真实路径，去掉 macOS 的别名前缀（`/System/Volumes/Data`、`/.nofollow`、`/.resolve/<n>`，只在两种写法是同一个目录时去掉），在 macOS 与 Windows 上按 NFC 与小写比较；重叠同时按写法和文件系统身份（`dev:ino`）判断。

### 项目与文件夹

项目是一个名称加 1–8 个有序的文件夹（`settings.json` 的 `workspaces`，最多 100 个），可带一个中性图标。

- 第一个文件夹是主文件夹：新会话在其中启动，也是 ACP 的 `cwd`。
- 每个文件夹有项目内唯一、只由 Host 分配一次的标识（`^[a-z0-9][a-z0-9-]{0,31}$`，由文件夹名折叠为 ASCII，重名加 `-2`、`-3`），调整顺序与重新选择都不改变它；界面只显示文件夹名。
- 保存的路径是去掉别名前缀后的真实路径。未指定名称时从主文件夹名取前 80 个 UTF-16 码元，不拆开字符。
- 每条记录同时写 `folders` 与 `path`（主文件夹的镜像），`version` 为 1。没有 `folders` 的记录在加载时得到一个文件夹；`folders[0].path` 与 `path` 不一致的项目停用（原因 `invalid`），标记随设置持久化，重新选择主文件夹才清除；未知的图标被丢弃。
- 启动目录不保存在设置中，以 `{ id: 'default', name: '默认文件夹' }` 列出，只有一个文件夹，不能加入更多、改名或移除（409 `workspace-default`）；它可以是其他项目的非主文件夹。

**谁能添加。** 加入文件夹就是授予权限，只能在 Host 所在的电脑上进行：

- 桌面端：主进程经 `POST /folder-grants` 取一次性 nonce，再用渲染进程拿不到的设备密钥签名请求体后提交；这些路由要 `host.sock` 上的 `admin`，桌面代理拒绝页面自己请求它们。
- 克隆：同一条路，地址与原生面板选出的位置一起签名，Host 在那里新建文件夹、克隆完成后加为项目（`via: 'clone'`，见 [GIT-DELIVERY.md](GIT-DELIVERY.md#克隆)）。
- 命令行：`pnpm latch project` 只在 Host 停止时修改，持有数据目录锁。它读取上次成功启动写入的 0600 `project-context.json`（启动目录、Agent 安装目录、程序目录与 TLS 私钥路径），不从当前目录猜测；尚未记录上下文时需显式给 `--workspace`，已有记录时显式目录必须与它相同。

文件夹是授予的范围，不是隔离：只有 Latch 内置的文件工具按所选文件夹检查路径，这也不是操作系统沙箱；ACP Agent 与插件 Harness 仍能访问 Host 用户能访问的任何路径（各 Agent 的做法见 [HARNESSES.md](./HARNESSES.md#项目的多个文件夹)）。

### 文件夹规则

每个文件夹按固定次序检查（`paths.ts` 的 `checkFolderCandidate` 与 `ruleFailure`），不能加入时 Host 说明原因。第 8、9 项在实际执行时排在第 2 项之前；这里的序号不是风险等级。

| 次序 | 拒绝 | 错误 |
| --- | --- | --- |
| 1 | 不是绝对路径、含 NUL、超过 4096 字节、不存在或不是目录 | 400 `workspace-invalid`；因权限读不到时 409 `workspace-permission` |
| 2 | 与数据目录、Agent 安装目录或运行目录重叠 | 409 `workspace-overlap` |
| 3 | 就是主目录 | 409 `workspace-overlap` |
| 4 | 与主目录下的敏感目录（`DENY_READ_HOME_PATHS`，如 `~/.ssh`）或登录时自启动的目录（`Library/LaunchAgents`、`.config/autostart`、`.config/systemd`）重叠；包含 TLS 私钥；在 macOS 上触及别名根（`/System/Volumes/Data`、`/.nofollow`、`/.resolve`、`/.vol`） | 409 `workspace-overlap` |
| 5 | 包含主目录，或与主目录下的隐藏条目、`.config`、`.local`、`bin`、（macOS）`Library` 重叠 | 409 `workspace-overlap` |
| 6 | 与 Latch 程序目录重叠 | 409 `workspace-code-root` |
| 7 | 路径中有受保护的名称（`PROTECTED_COMPONENTS`，如 `.git`；`.github/workflows`） | 409 `workspace-overlap` |
| 8 | 只对新加入的文件夹：路径或其真实路径含不可显示的字符（控制字符、行与段分隔符、双向控制符、零宽字符） | 400 `workspace-folder-unprintable` |
| 9 | 只对新加入的文件夹：真实路径含逗号、`*` 或 `?`（有的 Agent 按它们拆分或展开文件夹列表） | 400 `workspace-folder-chars` |
| 10 | 只在加入与开始会话时：Host 打不开这个文件夹（如 macOS 的隐私设置） | 409 `workspace-permission` |

- 「重叠」指相同、包含或位于其内。
- 已保存的文件夹必须仍在自己的真实路径上：现在要经链接才能到达的文件夹按找不到处理。
- 项目内（`checkProjectFolders`）：没有文件夹 409 `workspace-last-folder`，超过 8 个 409 `workspace-folder-limit`，两个文件夹相同或相互包含 409 `workspace-folder-overlap`，主文件夹已是启动目录或另一个项目的主文件夹 409 `workspace-exists`。
- 受保护名称的比较先做 NFKC、去掉文件系统会忽略的码点、转小写并去掉结尾的点与空格，所以 `.GIT`、带零宽字符的 `.git` 都算。

### 可用性

Host 按需检查每个项目的文件夹（文件夹规则与项目内的重叠），结果在列出时保留 5 秒；新建会话时总是重新检查，并确认 Host 能打开这些文件夹。只要有一个文件夹不可用，整个项目就不可用：部分可用的项目会悄悄改变一个 L3 会话所见的范围。不可用的项目保留在设置中：

- 由可用变为不可用时审计一次 `workspace.disabled`（原因 `overlap`、`code-root`、`protected`、`invalid`、`missing` 或 `permission`，以及文件夹序号）；写入失败只记日志，项目照样不可用。
- 列表仍列出它，项目与出问题的文件夹各带 `unavailable`；与程序目录重叠的项目另带 `codeRoot: true`。
- 把它设为默认值返回 400 `workspace-unavailable`，在其中新建会话返回 409 `workspace-disabled`。
- 文件夹回到原来的真实路径并通过检查后自动恢复。Latch 不跟踪移动的文件夹。

快照的 `catalog.projectFolders`（`{ max: 8 }`）给出每个项目的文件夹上限。

### 会话与项目

- **开始。** `POST /tasks` 只带 `workspaceId`（带 `worktree: true` 时在新建的工作树里开始，见 [BRANCHES.md](BRANCHES.md#在工作树里开始会话)）。Host 检查项目可用、所选 Harness 能接受这些文件夹的数量（`HarnessInfo.projectFolders.max`，超出 409 `harness-folder-limit`），会话在主文件夹中启动，项目标识记在 `sessions-meta.json`。
- **启动指纹。** L3 会话在写启动审计之前算出启动指纹，含交给 Harness 的其他文件夹；有这样的文件夹时审计另记文件夹总数 `folderCount`。ACP Driver 启动 Agent 时，交给它的文件夹已与那时不同则 409 `workspace-changed`。
- **谁收到全部文件夹。** 只有声明 `projectFolders: 'all'` 的 Driver 收到项目标识与全部文件夹，并拿到 `projects()` 自己再核对一次；其他 Driver 只收到主文件夹作为 `cwd`，摘要的 `folderAccess` 由 Host 设为 `primary`。声明 `historyImport` 的 Driver 也拿到 `projects()`，只用来核对接入的会话目录。
- **客户端看到的事实。** `HarnessInfo.projectFolders` 说明每个 Harness 怎样对待其他文件夹（`all`、`primary`、`primary-asks`、`primary-unbounded`，可带 `max`）；取值在各预设的权限配置里，见 [HARNESSES.md](./HARNESSES.md#项目的多个文件夹)。
- **改项目。** 运行或等待批准的会话正在使用的文件夹不能移除，这样的项目也不能移除（409 `workspace-in-use`）；默认文件夹不能移除（409 `workspace-default`）。
- **固定。** 会话的文件夹在创建时固定。之后加入项目的文件夹只用于新会话，改变主文件夹不移动已有会话。会话记下的文件夹被移出项目、被替换或找不到时，继续该会话返回 409 `workspace-changed`；项目因其他原因不可用时返回 409 `workspace-disabled`。
- **没有项目标识的会话。** 调整主文件夹之前，Host 为目录能唯一对应旧主文件夹的会话补记项目标识，不按跨项目共享的非主文件夹猜测。其余的按目录处理：目录是某个不可用项目的文件夹时 409 `workspace-disabled`。

### 会话自己的文件夹

启动目录由 Host 选定时（没有 `--workspace` 与 `LATCH_WORKSPACE`，`pnpm start` 传入 `sessionFolders`），每个不在已保存项目中的新 Agent 会话在启动目录中得到一个新文件夹 `<yyyymmdd>-<4 位十六进制>`（Host 的本地日期）作为工作目录。快照的 `catalog.sessionFolders` 表示这台 Host 这样做。

只对话（`mode: 'chat'`）的会话没有文件夹。不选项目时，能只对话的 Harness（Latch 内置）只对话，其余的进入新文件夹；选了项目或所有者指定了启动目录时都是 Agent 模式，分叉沿用来源的模式。所有者指定的启动目录照旧使用，不建子文件夹。

- **新建。** 以 0700 创建，从不沿用已存在的同名条目（连续 16 次重名 409 `session-folder-unavailable`）；启动目录的真实路径已不是 Host 启动时的那个时拒绝。
- **属于这次请求。** 同一台设备以同一 `requestId` 重试得到同一个文件夹。调用 Driver 之前先把请求键的哈希、文件夹名与启动目录哈希写入 0600 `session-folders.json`，跨重启仍沿用原目录；原目录丢失或启动目录改变时拒绝，不换一个目录继续。
- **清理。** Driver 明确以 4xx（408 除外）拒绝且未建成会话时删除记录与仍为空的目录；结果未知时保留。已分配而没有调用 Driver 的请求 10 分钟后清理。Latch 从不删除建成过会话的文件夹，删除会话也保留它。
- **记录。** 会话的 `workspaceId` 为 `default`，文件夹名记在 `sessions-meta.json` 的 `sessionFolder`，摘要带 `sessionFolder: true`；Driver 自己报告的值被丢弃。这些文件夹列入给 Driver 的目录列表，它们都直接位于启动目录中。
- **继续。** 继续会话、修改选项与允许调用都要求文件夹仍是启动目录中的真实目录（不是链接，名称符合格式），否则 409 `workspace-changed`。
- **存为项目。** 桌面端可以把它存为新项目的主文件夹：通过与添加文件夹相同的规则，保存检查时的真实路径（必须仍直接位于启动目录中），先审计 `workspace.added`（`via: 'session'`），写入失败返回 503。会话本身仍属于启动目录。没有自己文件夹的会话 409 `session-folder-none`，已存为项目的 409 `workspace-folders-refused`。

### 启动目录

我的 Agent 与通用的固定家 `helpers/<Agent ID>` 用同一个分配器，指定了 `--workspace` 时也建立；它不加入公共项目目录，也不能存成公共项目，见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#家与工具)。

`classifyDefaultWorkspace` 对启动目录给出三项判断：

- **位于数据目录内**（`<数据目录>/workspace` 布局）：只能用于内置 Harness，ACP 返回 409 `workspace-inside-data`。
- **在数据目录之外与程序目录重叠**（只可能来自 `--workspace` 或 `LATCH_WORKSPACE`）：所有 Standard 写入按 R2 处理，ACP 返回 409 `workspace-code-root`；列表中它带 `codeRoot: true`。
- **`sensitive`**：等于主目录；与 `DENY_READ_HOME_PATHS`、运行目录或 Agent 安装目录重叠；包含 TLS 私钥；或触及主目录下的隐藏与配置目录（位于数据目录内的启动目录不查这一项，因为 Linux 的默认数据目录在 `~/.local/share`）。此时 Host 拒绝启动（409 `workspace-overlap`）。

### 工作区工具的禁止路径

- 内置文件工具不读、不列出也不写 Host 的受保护路径：数据目录的私有条目（清单在 `apps/host/src/data-entries.ts` 的 `PRIVATE_ENTRIES`，含原子写入的临时文件）、运行目录、Agent 安装目录、TLS 私钥与 `DENY_READ_HOME_PATHS`。
- 写入受保护名称的路径（`isProtectedWorkspacePath`：`PROTECTED_COMPONENTS`、`.github/workflows`、`.env*` 与 `.pth` 文件）或程序目录中的文件按 R2 分级；文件夹之外的路径同样是 R2。

### 会话文件

回复里提到的文件在客户端是路径标记，从不让页面导航。判断都在 Host（`apps/host/src/files/`）：读取内容需要 `view`，`work` 设备只能打开本会话提到过的文件，枚举与搜索文件夹要数据范围 `files` 或 `all`；预览与编辑见 [DOCUMENT-PREVIEWS.md](DOCUMENT-PREVIEWS.md)。在访达中显示、快速查看、用默认应用或编辑器打开这些本机动作只在 `host.sock` 上进行，先审计再给出真实路径。

**搜索内容。** 文件面板的「搜索内容」（面板有焦点时 ⇧⌘F）经 `POST …/files/grep { q, caseSensitive, wholeWord }`（`apps/host/src/files/grep.ts`），守卫与文件名搜索相同：`view`、数据范围 `files` 或 `all`、私有会话的规则、文件夹身份与配置版本在每个文件后复查。

- 不建索引，不在后台扫描：每次请求用文件名搜索的有界遍历（遵守 `.gitignore` 与生成目录规则，不跟随符号链接，不出文件夹，不进受保护路径），每个候选再按读取时的规则解析并经同一描述符检查打开；在两步之间被换成链接的文件不搜索。硬链接与预览相同，按文件夹里的普通文件处理。可能含密钥的文件（文件名、文件头或正文任意处）不搜索。
- 只做字面匹配：查询逐字符转义后与固定的单字符前后断言组成表达式，线性时间；它从不成为正则、选项或程序参数，Host 不运行任何程序。查询限一行、256 字符。作用于文件内容的每一步都与文件大小成线性（行尾空白用 `trimEnd`，不用 `\s+$` 一类在 V8 里可能平方增长的表达式）；每行只搜前 8192 个字符。
- 上限：3 秒、5 万个目录项、5000 个文件、共 64 MiB、单文件 1 MiB（更大的与非 UTF-8 文本跳过并计数）、500 行结果、每文件 100 行、每行 240 字符（取首个匹配附近的窗口）。超限时回答带 `stopped`，页面显示「更多结果未显示」。每个文件前让出事件循环并检查期限与取消。
- 读取的字节计入设备的每分钟读取额度（远程设备，与预览共用），跳过的文件为分类读的开头也计入，用完即停在已读部分；解析的候选最多 1 万个。
- 文件列表优先用文件名搜索为同一上下文缓存的扫描，不在每次请求时重走文件夹；缓存失效时的重扫走同一条有界遍历。
- `.gitignore` 规则来自仓库，所以匹配有界（`apps/host/src/files/gitignore.ts`，文件名搜索、内容搜索与它们的重扫共用）：每个条目最多 20 万次字符比较，每次遍历合计 2000 万次，并随遍历期限停止；通配匹配是只留一个回溯点的双指针，单段最坏为模式长度 × 名字长度。每层最多 1000 行、每行 1024 字符，各层合计 2000 条，超过 32 段或 4 个 `**` 的行不收；有行没收或文件只读了一部分的层不算完整。核对被截断或所在层不完整时，条目按「已忽略」处理（不搜索，计入「未按忽略规则核对完」），从不当作未忽略。遍历每 8 毫秒让出事件循环并检查期限与取消。文件树的目录读取在 `latch-files` 组件里进行，不用这套规则。
- 并发名额与文件树、文件名搜索分开：每台设备同时一个，远程设备合计两个，这台 Mac 的窗口另有两个，所以远程搜索不会让本机的文件树或搜索答 429。请求正文在取名额之前读完并校验。一次搜索最多占名额 10 秒：读取或列目录一直不返回（挂起的挂载点）时中止、释放名额并答 503 `file-grep-timeout`。
- 请求一结束（HTTP/1 断开、中继与原生连接上的 HTTP/2 流被重置、连接关闭）即中止，Host 在下一个文件前结束并释放名额。回答是一次 JSON（上限内不足 200 KiB），不流式。
- 审计：远程设备收到哪个文件的行，就按读取记一条 `file.view`（`pathHash`、`via: 'grep'` 与行数），与预览读取共用 15 分钟内同一设备、上下文与文件只记一次的规则；另有每个文件夹一条 `file.list`（计数与是否截断）。这台 Mac 的窗口与它的读取一样不记。查询与结果不进日志或审计。
- 渲染为页面的文件（Markdown、HTML）带行号打开时显示源码，定位到该行；再点同一行回到这一行。
- 点按一行经文件预览的授权句柄打开该文件并定位到这一行。

**在编辑器中打开。** 只在这台 Mac 的主窗口出现。

- 主进程按固定的 bundle ID 白名单（`apps/desktop/src/editors.cjs`）在 `/Applications`、`~/Applications` 与 JetBrains Toolbox 的文件夹里找应用包，以 `Info.plist` 的 `CFBundleIdentifier` 为准，不找 PATH 上的程序。选择记在桌面端数据目录的 0600 `editor.json`。
- Host 先审计 `file.editor`（需要 `run`）：只放行会话或项目文件夹里的普通文本文件，不放行可能含密钥的文件，也不放行编辑器当作项目打开的定义文件（`.code-workspace`、`.sublime-project`、`.sublime-workspace`、`.ipr`、`.iws`、`.iml`）。主进程复查真实路径、普通文件与文件头是文本。
- 主进程另拒绝打开时会执行或导入项目的文件：Xcode 不收 `Package.swift`，JetBrains IDE 不收 `pom.xml`、`build.gradle(.kts)` 与 `settings.gradle(.kts)`。
- 启动只用 `/usr/bin/open -a <检查过的应用包> <目标>`（execFile，无 shell）。目标是按该编辑器的固定模板拼出的地址，或文件的绝对路径这一个参数；从不交出文件夹。
- 文件名含 `:` 时，VS Code 一系改为把路径作为参数、不带行号（它把地址里的 `:<数字>` 读成位置）；Zed 对含 `:` 或以 `(n)`、`(n,m)` 结尾的文件名拒绝。含控制字符、换行、行或段分隔符、未规范化的路径一律拒绝。
- 主进程只在主窗口页面一秒内的真实点按或按键之后、且已选的编辑器仍在时才启动它。
- 编辑器打开文件后按它自己的工作区信任行事，这不是 Latch 的隔离。

**诊断导出。** `POST /link/api/diagnostics` 只回答 `host.sock`：命令行（`pnpm latch diagnostics --out <文件>`，写入新建的 0600 文件，已存在时拒绝）或桌面端主进程（保存面板；桌面代理拒绝页面自己请求这条路由）。设备调用另需 `admin`；其他入口 403 `local-only`。

- 内容按固定字段生成（`apps/host/src/diagnostics.ts`）：版本、各 Harness 的状态、插件列表、策略的形状（条数，不含主机与密钥）、设备与连接计数，以及内存中最近 400 个事件与其中最近 100 个失败。
- 事件不是日志行：Host 只在固定的一组日志处（`DIAGNOSTIC_CATEGORIES`）记下类别、按形状检查过的 ID 与错误代码。Agent 的 stderr、Agent 写的文字、提示词与出站主机从不进入。
- 人自己定义的 Harness 不写 ID，写序号与预设（如 `harness-2`）。文字再经 `redactKnownSecrets`；设备名、项目名与文件夹、会话标题、数据目录与出站主机替换为「‹已隐去›」，主目录写作 `~`，其他绝对路径写作「‹路径›」。
- 不含对话、文件内容、记忆与 `auth/`、`providers.json` 里的任何东西。先写审计 `diagnostics.exported`（只有计数）再回答。

## Harness 与会话路由

Host 启动时挂载所有已启用的 Harness：`standard` 总是挂载，每个启用的 ACP Agent 与 `--plugin` 提供的 Harness 也会挂载。`--harness <id>` 指定必须成功启动的 Harness，并作为新会话的默认值；否则用保存的默认值（仅在它就绪时），再退回 `standard`。

`HarnessHub` 实现 `Bridge`，对外表现为一个 Bridge：

- **会话 ID 原样透传。** 路由表来自 `createTask` 的返回、Driver 的变化通知和 `listTasks`，只在内存中；未知 ID 会重新列出一次后再返回 404。Driver 必须生成全局唯一的会话与审批 ID：列表中 ID 冲突时先挂载者胜出并记日志，新建会话的 ID 冲突返回 502 `session-id-collision`，审批 ID 同时属于多个 Harness 时拒绝路由。超过 256 字符的会话 ID 写不进 `sessions-meta.json`。
- **审批按来源路由。** `approvals()` 合并所有 Driver；`decide` 找到持有该审批的 Driver。
- **权限级别。** Hub 由 `trustOf`（`apps/host/src/harness-trust.ts`）给会话标注级别：内置且声明 Latch 把关的是 L1，ACP 与插件 Harness 是 L3，未知来源按 L3；Driver 只能往低了说。
- **故障隔离。** 某个 Driver 列表失败不影响快照；非必需 Driver 启动失败只在目录中标为不可用。
- **Host 字段不下传。** `harnessId` 由 Hub 消费；`model`、`cwd` 只有客户端选择时才传给 Driver。自己带模型的 Harness 选了模型服务时，Host 用 `pairRoute` 重算这一对，只把 `modelRoute` 交给声明了 `models.wires` 的 Driver，Driver 经 `modelGateway` 为每个进程换一个网关凭据（[HARNESSES.md](./HARNESSES.md#经-latch-使用模型服务)）。
- **工具网关。** ACP Driver 另得到 `toolGateway`：Host 运行目录里 0700 的 `tools/` 下的 Unix 套接字 `gateway.sock`（0600），转发浏览器工具的 `tools/list` 与 `tools/call`，以及 `latch-mcp` 桥的请求（[MCP.md](./MCP.md)）。
- **浏览器工具的令牌。** Driver 每次打开、恢复、载入或分叉 Agent 的会话时换一个 `lbt1.` 令牌，写进新建的 0600 文件，`mcpServers` 只拿到文件路径，读出后即删；Host 只存哈希，令牌绑定会话与进程的生命期。它不是 API 的入口类别：持有令牌的进程不能当设备用。调用只在会话正在运行的一轮里执行，完全访问的会话里 R2 一律拒绝（[PREVIEW-BROWSER.md](./PREVIEW-BROWSER.md#agent-的工具)）。
- **远程 MCP。** 远程 MCP 服务器只由 Host 连接（`mcp-remote.ts`、`mcp-oauth.ts`）：请求只经出站策略发往本机确认时绑定的源与路径，不跟随重定向，请求头的值与令牌从不离开 Host。见 [MCP.md](./MCP.md#远程地址)。
- **会话元数据。** 重命名、置顶、归档、标签、优先级与看板记号保存在 `sessions-meta.json`，对所有 Harness 生效；Driver 自报的 `tags`、`priority`、`board` 被丢弃。删除调用 Driver 的可选 `remove`，不支持时返回 409 `delete-unsupported`；删除成功后一并删除该会话的元数据与回执。
- **运行。** Driver 在每次运行开始时给会话写入新的 `TaskSummary.runId` 并持久化。`cancel(sessionId, { runId })` 只在它仍是当前运行时取消，并回答是否取消了什么。
- **挂载与卸载。** 启停 Harness 插件或修改 Agent 定义时先卸载旧 Driver；仍有运行中或待审批的会话时返回 409 `harness-busy`。

### 看板的组

每个会话的 `TaskSummary.board`（`BoardPlace`：`group`、`reason`、`settle`、`card`）由 Host 推出，客户端只读。`hub.ts` 的 `present()` 在摘要做完之后调用注入的 `HubOptions.board`，即 `board.ts` 的纯函数 `boardPlace`：凡经 `present()` 的摘要（快照、列表、详情、`PATCH`、`attend`、`task-state`）都带组，组只在这一处判定。它读的是 Host 自己的事实：问题数来自问题存储，审批来自 Host 的审批列表，从不等待。

| # | 条件 | 组 | `reason` |
| --- | --- | --- | --- |
| 1–4 | 运行中且没有在停止：审批（状态 `waiting-approval` 且没有提问，或 Host 列出它的审批）、提问、未识别的请求之后再无动静、沉默 | `attention` | `approval`、`question`、`unrecognized`、`silent` |
| 5 | 不在运行，最近一次运行有无人能担保的结果，且这次结算未被核对 | `attention` | `unknown` |
| 6 | 不在运行，失败（`failed`，或 `idle` 而 `runOutcome` 为 `failed`），且这次结算未被打开 | `attention` | `failed` |
| 7 | 运行中（含正在停止） | `running` | |
| 8 | 绑定的 PR 最近一次被读到已合并或已关闭 | `done` | |
| 9 | Host 读到的本地交付事实为真且归这个会话（见下「交付事实」），或绑定了 PR 而它开着或还没读过 | `deliver` | |
| 10 | 其余 | `done` | |

- 1–4 与网页的 `waitsOnYou`、桌面端的 `attentionOf` 是同一判定（`packages/protocol` 的 `waitKindOf`，共用向量 `packages/testkit/vectors/board-v1.json`）。
- `settle` 是结算的名字：`runId`，否则 `runEnd.at`，否则 `updatedAt`。`POST /tasks/:id/attend { settle, opened?, checked? }` 只记在当前结算上，不同就 409 `attend-stale`；下一次运行有新的 `settle`，又会进入等你处理。`opened` 要 `view`，是阅读记号，不写审计；`checked` 要 `run`，先写 `task.unknown.checked`（只有会话 ID 与数目），写不进就不记。它只决定看板上的位置，不改变各请求「结果未知」的核对与放弃。网页在失败的会话真正显示在主区时发 `opened`，运行结束行的「已核对」发 `checked`（[DESIGN.md](DESIGN.md)）；iOS 尚未发送。
- `card`：不是归档、旧助手会话，我的 Agent 的会话只有定时运行。不是卡的会话也有组。
- **交付事实。** `BoardDelivery` 只在内存中：一次运行结算后、交付的提交、推送或建 PR 之后、任何设备调 `workbench/delivery` 时各读一次，Host 启动约 2 秒后对最近 7 天、空闲、每个目录一个的会话最多读 48 个。只读 Code 会话（不归档、不在运行）的工作目录，经受限运行器只读本地 Git，从不调用 `gh`、不访问网络；PR 状态只来自设备发起的读与人按下的交付。后台同时只读一个，且有两个读取在跑时不开始；设备的读取仍各自最多两批。目录的改动只归一个会话：自己的工作树或会话文件夹、或绑定了 PR 的会话归它自己；几个会话共用一个目录时，归改动记录（`TurnChanges`：已结算、未撤销、`files > 0` 的一轮）里自己改过文件的会话中最近变化的那个。没有会话自己改过文件（例如人手改的），看板上就没有会话认领这个目录的改动。私有会话只与私有会话比，从不让可见的会话进出可交付。结论变了才通知客户端。
- 标签、优先级经 `PATCH /tasks/:id`，只由人设置，不触发任何动作。标签每个 `trim`、NFKC、去掉不可见字符，1–24 个码点，最多 8 个；含控制字符或换行 400 `tag-invalid`，像密钥 400 `tag-secret`，超过 8 个 400 `tag-limit`。改元数据不改 `updatedAt`。


**生命周期事件。** `session-lifecycle.ts` 把会话与 Host 的变化发给 Host 内按会话保存状态的模块；路由模块经 `RouteContext.lifecycle` 拿到的对象只有 `on`，只能订阅。

| 事件 | 何时 |
| --- | --- |
| `runStarted`（`{ sessionId, projectId, runId, folders }`） | Driver 在一次运行的第一条提示发出之前等待 Host 的 `trackFiles`，Host 向 Driver 核对这是当前运行后发出。只对话的运行不发出 |
| `runSettled`（`{ sessionId, runId, outcome }`） | 只跟在 `runStarted` 之后，每次运行一次。运行既不在运行也不在等待审批时才算结束，只是请求了取消不发出。`outcome` 取 Driver 记下的 `runOutcome` |
| `sessionArchived`、`sessionDeleted`（`{ sessionId, projectId }`） | 归档或删除保存之后；监听器不能拒绝它们。没有项目的会话 `projectId` 为 `default` |
| `hostStopping` | Host 不再接收请求之后、关闭 Driver 与监听入口之前。未结束的运行不再有 `runSettled`，订阅者把它当作结束，下次启动时恢复自己的记录 |

- 有监听器时，Hub 在 Driver 报告变化后读取该会话的摘要，每个会话最多 40 毫秒一次；新的输入与删除之前、取消结算之后各读一次。没有监听器时不增加任何读取或等待。
- `runStarted` 的监听器与运行的查询合计最多等 15 秒，`hostStopping` 的监听器最多 3 秒，其余不等待。取消让仍在等待的运行立即继续，提示不会发出；Host 开始停止后才到达 `trackFiles` 的运行直接取消。
- 监听器抛错、拒绝或超时只记脱敏的日志，不影响运行与停止。

客户端从快照的 `catalog` 读取可选项：`harnesses`（状态、级别、支持的模式与 `capabilities`；客户端只读这些事实，不判断 Driver 种类）、`providers`（不含密钥）、`workspaces` 与 `defaults`。快照还带当前设备与 Host 信息。

### 待办

待办是一件事：标题、要求、建议的项目、Harness、模型与工作树、标签、优先级、备注，和 0 到 16 个 Code 会话。没有待办的会话自己成卡，不建记录。只由人新建、修改、开始、标完成与重新打开；Agent 与插件页面不能，Agent 只能提议（见「Agent 的提议」），人接受后才成为待办。

**记录。** 数据目录的 `work/items.json`（目录 0700，文件 0600，原子写，一次一个改动，写成功之后才在内存中生效）。schema 是 strict：读到不认识的字段、同一会话在两条待办里、超过上限都拒绝启动并保留原文件（500 `config-corrupt`）。一台设备最多新建到它能读的 2 000 条（409 `item-limit`，只按它能读的计数，所以数据范围较窄的设备数不出私有待办）；文件本身最多 4 000 条，满了是另一个较粗的拒绝 409 `item-store-full`。每条最多 16 个会话；标题 1–120 个码点且只占一行，要求最多 16 000 个字符（与会话的第一条消息相同），都去掉首尾空白、拒控制字符，像密钥 400 `item-secret`；标签与优先级与会话同一规则；备注（`note`）1–140 个码点只占一行，像密钥 400 `note-secret`，只显示，从不发给会话或 Agent（会话的备注同样存在 `sessions-meta.json`，经 `PATCH /tasks/:id` 的 `note`）。由提议接受而来的待办带 `from`（提议的会话、我的 Agent 之一、提议 ID、`external`），之后不能改。`revision` 随每次改动（含加入、移出会话）增加。`startScope` 记下写过开始要用的值（要求、项目、Harness、模型、工作树）的设备中最窄的数据范围，只会变窄。同一文件保存新建与开始的回执（按设备与 `requestId`，7 天，每设备 10 000 条），重试同一请求得到同一条待办或同一个会话，换了内容 409 `request-conflict`。写入失败时 503 `item-write-unknown`，状态不变，重试同一请求即可。

**会话一侧。** `TaskSummary.itemId` 由 `present()` 从待办文件在内存里的索引填入，不另存在 `sessions-meta.json`，所以没有两处要对齐；Driver 自报的被丢弃。私有待办里不私有的会话不带 `itemId`。删除会话（`sessionDeleted`）把它从待办中移出；归档的会话仍是成员。Host 启动约 2 秒后列出全部会话，只在列表完整（每个 Harness 都已挂载并列出）时移出列表里已经没有的成员。删除待办只删记录，会话不动。

**组。** `TaskSummary.board` 之外，每条待办带 Host 推出的 `board`（`board.ts` 的 `workItemPlace`），自上而下第一条命中：

| # | 条件 | 组 | `reason` |
| --- | --- | --- | --- |
| 1 | 标了完成（`closedAt`） | `done` | |
| 2 | 没有会话 | `todo` | |
| 3 | 任一成员是 `attention` | `attention` | 成员原因中按会话规则顺序最靠前的 |
| 4 | 任一成员是 `running` | `running` | |
| 5 | 任一成员是 `deliver` | `deliver` | |
| 6 | 每个成员都读到了，且绑定的 PR 都最近一次读到已合并 | `done` | |
| 7 | 其余（都结束了，人还没标完成） | `deliver` | `settled` |

成员读的是它此刻的 `TaskSummary.board` 与 `BoardDelivery` 记下的 PR 状态；归档的成员照算，Harness 没有列出的成员不算，但有成员的待办永远不是 `todo`，也不会因第 6 行到 `done`。

**路由**（`routes/work-items.ts`）。

| 路由 | 做什么 | 权限 |
| --- | --- | --- |
| `POST /work/items` | 新建未开始的待办 `{ requestId, title, prompt?, projectId?, harnessId?, model?, worktree?, tags?, priority? }`，201 | `run` |
| `GET /work/items/:id` | 带要求的整条待办 | `view` |
| `PATCH /work/items/:id` | `{ baseRevision, title?, prompt?, projectId?, harnessId?, model?, worktree?, tags?, priority?, closed? }`；`null` 清除建议；有会话后改要求 409 `item-started`；`closed` 是完成与重新打开 | `run` |
| `DELETE /work/items/:id` | `{ baseRevision }`；正在开始会话时 409 `item-starting` | `run` |
| `POST /work/items/:id/start` | `baseRevision`（人按下开始时看到的修订，不符 409 `item-changed`，什么都不开始）加与 `POST /tasks` 相同的选择项，缺的 `prompt`、`workspaceId`、`harnessId`、`model`、`worktree` 取待办的；不能带 `customAgentId`、`forkOf`、`appDraft`、`via`；已完成 409 `item-closed`，满 16 个 409 `item-full`。201 `{ sessionId, item?, outside? }`：会话开始后没能加入（待办满了或已删除）时 `outside` 是 `item-full` 或 `item-gone`，会话自成一卡，回执照样结清 | `run` |
| `POST /work/items/:id/sessions` | `{ sessionId }` 加入已有会话：只收 Code 会话（409 `item-session-kind`），已在别的待办里 409 `item-session-taken`；那条待办这台设备读不到时，回答与私有会话相同（403 `agent-scope-required`） | `run`，且能读这个会话 |
| `DELETE /work/items/:id/sessions/:sessionId` | 移出 | `run` |

`PATCH` 与 `DELETE` 的 `baseRevision` 不符 409 `item-changed`。每个写入都回答整条待办（`{ item }`），并与 Host 其他由人发起的写入一样占用每设备的 `classC` 限速（60 次突发，每秒补 1 次），重写整份文件的代价因此有界。快照的 `items` 是这台设备能读的待办，不带要求（`hasPrompt` 表示有），`catalog.features.workItems` 表示 Host 有这些路由。

**开始走同一条路。** `server.ts` 的 `startPersonSession` 是 `POST /tasks` 不带 `customAgentId` 时的全部：用 `createTaskSchema` 解析、空要求 400 `invalid-prompt`、在这台 Mac 上绑定未确认的 Harness，然后 `startSession`（确认、L3 的启动审计、项目串行、工作树、附件与 Driver 回执）。待办的开始先核对 `baseRevision`，再做三件事：写 `work.item.started`（写不进就 503 `audit-unavailable`，什么都不开始）、记下待开始的回执、把请求标识换成由设备、待办与原 `requestId` 推出的 UUID（与这台设备的 `POST /tasks` 互不相撞，重试时不变，所以 Driver 自己的建立回执在重启后仍答出同一个会话）。会话开始后再写入成员关系，回执在同一次写入里记下会话；写失败时重试同一请求只会读回同一个会话再加入。回执的 `payloadHash` 覆盖开始实际用的全部输入（含取自待办的值与修订），重试只认同一请求。从开始前到会话加入，开始要用的值不能改（409 `item-starting`），待办也不能删除。开始前被拒绝的请求忘掉回执，与 `POST /tasks` 一样。`startScope` 不是 `all` 时，开始带 `withoutPrivateContext`，与这样的设备自己开始的会话一样不带「通用」等私有上下文：较窄的设备写下要求、由完整数据范围的设备按下开始，私有内容不会因此流到它能读回的地方。权限模式只来自请求，待办不保存，也不能放宽。

**私有。** 一条待办只要有一个成员此刻是私有的（`hub.agentPrivate`：例如有完整数据范围的设备带着「通用」的上下文开始或继续了它），就是私有：Host 在读到时（快照、会话摘要、路由）和删除这个成员之前写下 `private`，此后不再取消（移出私有会话也不变：标题与要求里可能已写进私有内容）。加入私有会话要求完整数据范围。数据范围不是 `all` 的设备：快照里没有私有待办，也不计数；每个路由对私有待办的回答与不存在的待办相同（404 `item-not-found`）；它能读的会话不带私有待办的 `itemId`。

**开始时的私有与外部内容。** 私有待办开始的会话以 `privateFrom` 开始，与它一样私有，不论带不带私有上下文：要求里可能有私有会话写下的东西。`from.external` 的待办开始的会话记 `outsideStart`，它之后提议的一律标外部。

**审计**（detail 只有 ID、哈希、计数与枚举）。`work.item.changed`（`itemId`、`revision`、`op`：`created`、`edited`、`deleted`、`joined`、`left`，`sessionId?`，`titleHash`），`work.item.started`（`itemId`、`requestHash`），`work.item.closed`（`itemId`、`closed`），`work.item.posted`（见「待办的讨论」）。开始与加入私有会话先写审计，写不进就不做；其余写不进照做并带 `x-latch-audit: failed`。会话被删除而移出不写审计。

**通知。** 待办的变化走现有的刷新：不私有的待办发全局 `refresh`，私有的只发给完整数据范围的连接；成员会话另发各自的变化，但私有待办只刷新它的私有成员，不私有的成员的流听不到这条待办的任何变化。客户端收到后重读快照，不新增事件种类。

### Agent 的提议

Agent 可以提议待办，或为自己的卡提议更好的标题、标签与一句备注。提议不是待办：不进 `items`，不计入待办上限，不能开始、加入或拖动；只由人接受或不要。优先级永远不能提议。

**谁能提议。** Host 在开始会话时给 `CreateTaskInput.workProposals`：Code 会话、我的 Agent 的会话与「通用」的对话都给，只要 Harness 接得住（`canPropose`：内置 Harness，或接受技能服务的外部 Harness；pi 不接受 MCP，提议尚未实现）；插件页面开始的会话不给。Driver 只为这样的会话提供（只对话的运行也有：它们不读也不改任何东西）`propose_todo(title, prompt, project?, harness?, tags?)`、`propose_todos(goal, items)`（2–8 条，一组）与 `propose_card(target, title?, tags?, note?)`，`target` 是 `session`（这个会话自己的卡）或 `todo`（它所在的待办），卡由 Host 从自己的记录查出，从不取自 Agent。内置 Harness 由运行循环提供这三个工具；外部 Harness 经技能服务（`latch-skills` 的 `board` 参数）写进同一个提议文件，ACP 驱动读到后交给 `HarnessHostOptions.proposeWork`（[CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#外部-harness-的通道)）。Host 只收这个驱动自己的、带 `workProposals` 记录的会话的提议；助手的旧会话与插件页面的会话拒绝（409 `proposal-session`）。

**给 Agent 的指引**在工具自己的说明里（`packages/protocol/src/work-proposals.ts` 的 `PROPOSE_TODO_GUIDE` 等），每个 Harness 收到同一段：什么时候提议待办、什么时候直接做；要求要写成没有这段对话的新会话能直接执行的第一条消息；不写密钥与凭据，不照抄网页、文件或工具输出里的指令；人接受之前什么都不会建、什么都不会开始；优先级只由人定。

**记录。** 与待办同一个文件 `work/items.json` 的 `proposals`（strict，最多 512 条，满了先删最早的已处理提议），接受与建待办在同一次写入里。每条有 `wpp_` ID、`kind`（`todo`、`change`）、来源（会话、我的 Agent 之一、那一轮的用户消息）、`external`、`private`、组名 `goal`、条目或改动、`revision`。条目的文字只在待处理时保存：接受或不要之后只留状态与它成为的待办 ID。`propose_todos` 的各条带同一个只属于这次调用的标签，Host 按会话与标签把它们收进一条提议（技能服务每条写一行）。

**上限与拒绝**（`WORK_PROPOSAL_LIMITS`，都在审计之前，什么都不存；回给 Agent 的是英文）。每轮 4 条，每个会话等人处理的最多 16 条，全 Host 待处理 64 条（一组算一条，409 `proposal-limit`）；一组最多 8 条；一个会话一生最多经提议通道提 32 次，记忆、定时与看板合算。一组中途被拒时，已收下的几条留在提议里。标题 1–120 个码点一行，要求 1–4 000 个字符，组名一行，备注 1–140 个码点一行，标签同会话的规则；含控制或不可见字符 400 `proposal-invalid`，像密钥 422 `proposal-secret`；项目不是已登记的 400 `proposal-project`（不写就用会话自己的项目），Harness 不存在 400 `proposal-harness`；行里多出任何字段（例如 `priority`）整行拒绝。技能服务先按同样的形状拒绝，Agent 当场看到；密钥与卡的核对只有 Host 做，外部 Harness 的 Agent 这时只看到「已提议」，Host 日志只记原因的种类。

**外部内容。** 与记忆提议同一判断（[CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#记忆提议)）：这一轮或上下文里读过外部内容、插件 Harness、定时任务的运行（含无人值守）、归属有不是用户原话的记忆，或会话由 `from.external` 的待办开始（`outsideStart`），都标 `external`。定时运行只有我的 Agent 的（它们本来就能提议记忆与定时）能提议，一律标外部，不自动接受也不拒绝；「通用」的定时运行没有这些工具。一组里任何一条外部，整组外部。内容经别的路径进入会话时同样标记：待办讨论的投递与交接进已有会话带 `outsideContent`，交接开出的新会话、从文字记录重建的会话、导入的会话，以及分叉的记录里有工具输出（或来源是定时运行、本身由外部内容开始）时，分叉出的会话都记 `outsideStart`。接受时 `external` 记进待办的 `from` 且不再改：看板、待办页与开始框写「来自外部内容」，「全部开始」跳过它，它开始的会话按 `outsideStart` 继续标外部。

**驱动交来的提议**先按 strict 的 zod（`workProposalInputSchema`）整份核对：类型、长度（`messageId` 与文件同一上限，所以审计行不会写给存不下的提议）、`todo` 与 `card` 恰好一个、`card.target` 只能是两个值；没有所在一轮的用户消息的提议拒绝（每轮的上限要靠它数）。外部 Harness 的看板工具在 Host 决定之后才回答 Agent：驱动把每行收下与否写进会话目录的 `answers.jsonl`，技能服务等到它（最多 15 秒）；被拒时只说没有收下及可能的几类原因，不复述内容、不说是哪张卡。

**私有。** 提议的会话此刻私有（`hub.agentPrivate`：我的 Agent、「通用」、带私有上下文的 Code 会话、定时任务的运行）时，提议记 `private` 且不再取消，它接受成的待办也私有。数据范围不是 `all` 的设备：快照的 `workProposals` 里没有它，每个路由对它的回答与不存在的提议相同（404 `proposal-not-found`）。私有提议的变化只通知完整数据范围的连接（等着的卡此刻私有也算）。接受来的待办上，提议的会话此刻私有时，数据范围不是 `all` 的设备看到的 `from` 只有提议 ID 与 `external`，不带会话与 Agent。

**接受的待办开始时不带私有上下文。** 它的要求是模型写的：无论哪台设备接受、之后谁改过，`startScope` 都是 `work`（只会变窄）。项目文件夹里的文件是数据范围较窄的设备也能写的，要求可能照着这样的文件写出；带着「通用」的私有内容开始，就可能把它写回较窄设备读得到的地方。开始框显示的就是这个修订的要求（`baseRevision`），私有待办开始的会话照样私有（`privateFrom`）。

**路由**（`routes/work-proposals.ts`）。

| 路由 | 做什么 | 权限 |
| --- | --- | --- |
| `GET /work/proposals/:id` | 带要求的整条提议 | `view` |
| `POST /work/proposals/:id/accept` | `{ requestId, baseRevision, entries? }`。待办提议：`entries` 是 `{ index, title?, prompt?, projectId?, harnessId?, tags? }`（人先改过的值，`null` 清除建议），不写就是全部待处理条目；一次写入里建成未开始的待办（带 `from`，`startScope: 'work'`，私有随提议），答 `{ proposal, itemIds }`。改动提议：写到它的卡（待办在同一次写入里改，会话经 `updateMeta`） | `run` |
| `POST /work/proposals/:id/dismiss` | `{ requestId, baseRevision, entries? }`：所选条目或全部待处理的 | `run` |

`baseRevision` 不符 409 `proposal-changed`，已处理的条目 409 `proposal-decided`。接受与不要按设备与 `requestId` 记回执（与待办同一份，7 天），重试答同样的结果、不再建待办，换内容 409 `request-conflict`。会话删除时，它提的、还没处理的提议与等着它的卡的改动一起删除（一组里已有条目处理过的，剩下的记为不要，记录留给重试的回执）；接受会话卡的改动时先在写入里把提议记为已接受，再改会话，改不成就退回待处理；组里什么都处理完后组名也删去；待办删除时，等着它的改动删除。快照的 `workProposals` 只列还有待处理内容的提议，不带要求，也不带已接受条目成为的待办 ID；`catalog.features.workProposals` 表示 Host 有这些路由。提议的文字从不进任何 Agent 的提示：它只在看板与提出它的会话里显示，人接受后成为待办的要求，由人开始才发出。

**审计。** `work.proposal.made`（`proposalId`、`kind`、`entries`、`external`、`sessionId`、`customAgentId?`）在保存之前写，写不进就不收（503 `audit-unavailable`）；`work.proposal.decided`（`proposalId`、`op`：`accepted`、`dismissed`，`count`、`external`）在决定之前写：接受写不进就不接受，并为每条建成的待办先写 `work.item.changed`（`created`）；不要写不进照做并带 `x-latch-audit: failed`。不含任何文字。

### 待办的讨论

一条待办可以有讨论（`work-threads.ts`、`routes/work-threads.ts`）：只有人发言，一条发言最多交给一个对象，这条待办的一个会话，或我的 Agent 之一（含「通用」）在它的唯一聊天里。回复不复制进讨论，只在读取时从那个会话读出，所以回复里写的 @ 不叫醒任何人；只有人的发言会投递，没有循环。

**记录。** 数据目录的 `work/threads/<itemId>.json`（目录 0700，文件 0600，原子写，一次一个改动），strict：`{ version, itemId, revision, posts }`，每条发言 `{ id, at, deviceId, requestId, payloadHash, text, target?, delivery? }`，`delivery` 是 `{ requestId, sessionId, state: 'sent' | 'unknown' | 'failed', code?, reason? }`。每条待办最多 500 条（409 `thread-full`），发言 1–4 000 个字符、拒控制字符，像密钥 400 `post-secret`。删除待办时一起删除；Host 启动时删去待办已不在的讨论，但只在待办文件存在并完整读出时做：文件缺失（例如按启动时的报错移走了损坏的文件）时一个讨论也不删。快照与 `GET /work/items/:id` 的待办带 `threadRevision`（讨论每次变化加一），客户端据此重读。

| 路由 | 做什么 | 权限 |
| --- | --- | --- |
| `GET /work/items/:id/posts` | 全部发言，旧的在前；投递过的带 `delivery`（进行中是 `sending`；记为 `unknown` 而会话里已有这条消息时答 `sent`）和 `reply`：那一轮最后一条有文字的回复，前 2 000 字（`more`、仍在运行时 `live`），从会话读出；这台设备读不到的会话不给回复。自己发的发言带 `requestId` | `view` |
| `POST /work/items/:id/posts` | `{ requestId, text, target? }`，`target` 是 `{ sessionId }`（必须是这条待办的会话，否则 409 `post-target-gone`）或 `{ customAgentId }`。201 `{ post }`；同一设备同一 `requestId` 同一内容答同一条（200），未送达的再投一次，换内容 409 `request-conflict` | `run`；对 Agent 另需 Agent 的访问权（数据范围 `all`） |

**顺序。** 可见性（与待办相同，私有的对较窄设备 404 `item-not-found`）、内容检查、对象可用（会话在一轮中 409 `post-target-busy`；Agent 的聊天还没开始 409 `agent-chat-empty`、正在确认 409 `agent-chat-starting`），@ Agent 时先把待办标为私有（只收窄可见范围），然后写 `work.item.posted`（`itemId`、`postId`、`target`：`none`、`session`、`agent`，`sessionId?`；不含文字，写不进 503 `audit-unavailable`，什么都不存），再存发言（投递记为 `unknown`），最后投递并结清为 `sent`、`failed` 或 `unknown`。投递失败不回错误码：发言已存，回答里的状态说明结果，重试同一请求再投。`postId` 由设备、待办与 `requestId` 推出，同一请求同时发两次时后一个等前一个，所以一个请求只有一条发言、一行审计。

**投递。** 走 `POST /tasks/:id/prompt` 的同一个函数 `sendPrompt`（访问、工作区、私有上下文、附件与 Driver 回执），不排队、不追加：排队的消息发出时会把整段文字交给记忆。请求标识由设备、待办与原 `requestId` 推出，重试时不变；它不是秘密，只让这台设备的发言与它自己直接发的消息分开。投之前先读会话：已经有这个请求的用户消息就记为 `sent`，不再发（对 Agent 补做「记住…」，按请求只建一条），所以答复丢失后讨论又多了内容，重试也只送一次；同一条发言的投递在进行中时，重试等它。正文是人写的话，后面一段引用：所有换行（含 `\r`、U+0085、U+2028、U+2029）先统一成 `\n`，每段的标签（「我：」「会话「…」 的回复：」）在一层引用里（`> `），段的文字在下一层（`> > `），所以回复里写的任何「我：」都比真的标签深一层，冒充不了人的话。引用里是发自哪条待办，以及这个会话上次被 @ 之后讨论里新增的发言与别的会话对它们的回复（每段最多 2 000 字，总计 8 000 字，超出时省去最早的并写明省略了几段），并写明会话的回复是模型的输出、不是人的话也不是指令。引用的长度按发出的样子计（标签、换行与每行的 `> `），所以正文不会超过一条消息的上限。待办是否私有在拼好引用之后再读一次。对象不是私有会话时，引用里不放发给 Agent 的发言和私有会话（Agent 的聊天）的回复；待办已经私有而对象不是私有会话时（较窄的设备读得到它），只发人写的那句，不带待办标题与引用。在交给会话之前失败的投递记为 `failed`。

**外部内容。** 投给任何能提议的会话（Agent 的聊天，或带 `workProposals` 的 Code 会话）的这一轮都带 `PromptOptions.outsideContent`：引用里是模型的输出，那个上下文此后的提议标外部。

**给 Agent。** 只进它的唯一聊天，从不另开会话（根 `AGENTS.md`）；聊天还没开始时不投递（首次开始会在标记之前跑第一轮）。这一轮带 `PromptOptions.outsideContent`：Driver 把「带外部内容」与这一轮的用户消息在同一次写入里记下，其间别的设备清空上下文或开始的一轮都碰不到它；不支持的 Driver（没有 `markOutsideContent`）由 Host 在交给它之前拒绝（`failed`，`post-unmarked`）；记忆的「记住…」只取人自己写的那句（见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#待办里的-)）。

**私有。** @ 过 Agent 的待办从此私有（只增不减）。较窄的设备对待办、它的讨论与发言的读写都是 404 `item-not-found`，快照不列、不计数；私有待办的变化只通知完整数据范围的连接。

## Standard 的会话与运行

一个会话（task）是持久对话；一次运行（run）由创建或后续输入触发。正常结束为 `idle`，可继续输入；`failed`、`cancelled`、`interrupted` 分别表示失败、明确取消与进程中断。

| 模式 | 行为 |
| --- | --- |
| `chat` | 不向模型暴露工具，只租用模型服务插件。模型擅自请求工具时本次运行失败，不产生副作用 |
| `agent` | 模型输出 → 收集完整工具调用 → Host 风险分级 → 必要审批 → 串行执行 → 结果交回模型。默认最多 50 步，每步最多 32 个调用 |

- **模型。** 创建时使用请求中的 `model`，否则使用 Host 默认模型；所选模型必须在该服务启用的模型列表中。选择后固定在会话上，只有带 `model` 的后续输入才切换。配置缺失或服务失败不会改用演示模型。
- **文件夹。** `cwd` 必须是 Host 登记的工作目录之一（按真实路径比较）。在项目中新建的会话收到项目标识与全部文件夹，运行时用 `projects()` 核对，不符时 400 `workspace-unavailable`；固定与失效规则见「会话与项目」，拒绝不受影响。
- **文件工具。** `workspace-files` 的 `list_files`、`read_file`、`write_file` 带可选参数 `folder`（文件夹标识，缺省为主文件夹），路径相对于该文件夹；`list_folders` 不返回绝对路径。
- **输出。** 模型输出必须以 `finish` 结束，截断的流不派发其中的工具调用。调用 ID 在会话历史中不能重复；未知工具、拒绝和异常都作为错误结果交回模型。
- **展示。** 需要审批的工具在请求审批前调用可选的 `preview()`，生成标题与文件差异，同时显示在审批与工具卡片上。
- **用量、思考与时间。** Provider 报告的用量累计到助手消息与会话，失败或取消的部分步骤也计入。思考内容不进入发给模型的历史；签过名或加密的推理只在同一轮的工具循环里原样带回（[MODEL-CONFIGURATION.md](MODEL-CONFIGURATION.md#latch-内置的思考深度)）。时间用 Host 的时钟，等待审批的时间不计入一轮的用时（[STREAMING.md](./STREAMING.md)「时间与用量」）。

## 审批与取消

审批属于执行端的运行，多设备竞争时只有一个决定生效：同一审批的决定串行处理。

- **选项。** Standard 的 R1 审批提供允许一次、本会话始终允许（工具名写入会话的 `allowedTools`）与拒绝。R2 审批与 L3 询问不提供「始终允许」，即使同一工具此前被 R1 始终允许过也每次询问（403 `approval-always-unavailable`）。决定与选项方向不一致或选项不存在时 400；L3 询问中会持久保存授权的选项被隐藏（400 `approval-option-hidden`）。
- **检查。** 决定前按设备的当前记录检查所需权限；允许时还检查会话的文件夹仍在项目中（否则 409 `workspace-changed`）。
- **审计。** 每次决定先审计 `approval.decided`（含选项类别 `optionKind`，R2 另含 previewHash），再交给执行端。
- **已处理。** 审批已被处理或已失效时返回 409 `approval-settled`，`decidedBy` 为 `{ kind: 'device', self, deviceName, decision, optionKind, at }` 或 `{ kind: 'system' }`（会话结束或取消使其失效）；执行端已不再等待时记录 `approval.stale`。
- **重试。** 同一设备用同一 `requestId` 重发时返回原回执（`replay: true`），不会再次决定或审计。

**决定记录与拒绝说明。** Host 把决定连同 `via`（`host.sock` 上的桌面端为 `this-mac`，其余入口为 `other-device`）交给 Driver；内置 Harness 与 ACP Driver 把结果写在那次工具调用上（`ToolDetail.decision`）。

- `outcome` 为 `allowed`、`rejected`（人的选择，带 `via`），或 `expired`、`cancelled`（没有人回答：会话停止、取消、进程结束、Host 重启时还开着的审批，以及权限漂移时 Latch 自己拒绝的询问）。后两者不带 `via`，从不记作某人的拒绝。Agent 自己撤回的询问不留记录。
- 设备名与设备 ID 不进这条记录，只在审计里。
- 记录写的是人的决定，不是调用有没有执行。内置 Harness 在允许之前不执行调用；ACP Agent 的询问只是提示，它之后报告的状态与差异照常记下。Agent 为同一调用询问多次时，记录保留已经给出的允许。
- 拒绝可以附一句说明 `note`：去掉首尾空白、换行统一为 `\n` 后最多 500 个字符，每一行都不能含 `escapeSecurityText` 会标出的字符（`packages/protocol/src/decision.ts` 的 `rejectionNote`），否则在审计之前返回 400 `invalid-note`；允许时带说明同样 400。
- Host 只把说明交给 `capabilities.permission.rejectionNote` 为真的 Harness（内置 Harness 声明它；ACP 的权限回复不能带文字）。给其他 Harness 的说明检查后丢弃，拒绝照常生效。
- 说明是给模型的输入，所以另需 `run`（403 `scope-required`），也不写进审计；只有查看权限的设备仍可以拒绝，但不能附说明。

**没有问人的调用。** Harness 自己的模型代人决定时，那次调用带 `ToolDetail.judged = { by, outcome }`（`approved`、`denied`、`none`，或没有问人就运行的 `unasked`）。它不是决定记录，也不是人的批准，每一条另写审计 `task.tool.judged`。Harness 在调用运行之前自己拦下它时带 `ToolDetail.blocked = { by, source, reason? }`（`model` 或 `rule`），界面读作「拦下」，不算失败也不算改动。见 [HARNESSES.md](./HARNESSES.md)「权限菜单」。

**取消。** 取消沿同一个 `AbortSignal` 传给 Provider 与工具，等真实结算后才确认；已经发生的副作用不会撤销，不协作的插件无法在同一进程中被安全强杀。请求体为 `{ requestId?, runId? }`：带 `runId` 时只停止那次运行，它已经结束时不停止任何东西，回答 `ended`；同一 `requestId` 换了 `runId` 返回 409 `request-conflict`。ACP 的规则见 [HARNESSES.md](./HARNESSES.md#取消)，回执的完整规则见 [STREAMING.md](./STREAMING.md#取消的请求-id-与回执)。

**回执随会话保存。** 审批决定与带 `requestId` 的取消在回答之前写入 `sessions-meta.json` 中该会话的条目，所以 Host 重启后同一设备重试同一个 `requestId` 仍得到原回执。

- 保留 7 天，每台设备最多 1 万条、合计最多 10 万条，最旧的先删；删除会话时一并删除。
- 写入失败时操作照常生效，回执留在内存中并进入下一次写入。
- 读不懂的单条审批或取消回执只略过这一条并记下条数。配置回执不同，见「会话配置修改回执」。

## 持久化与恢复

数据目录内的文件。

| 路径 | 内容 |
| --- | --- |
| `identity/host-key.pem` | Host 身份私钥（0600，目录 0700） |
| `auth/devices.json`、`auth/revocations.jsonl`、`auth/offline-enrollments.json` | 设备登记（版本 2，只含凭据哈希）、撤销日志、未使用的离线连接码哈希（0600，目录 0700） |
| `audit/audit.jsonl` | 哈希链审计记录 |
| `policy.json` | 本机安全策略 |
| `settings.json` | 默认值、插件停用列表、项目及其文件夹、Agent 定义与环境变量、首次准备状态（0600） |
| `providers.json` | 模型服务、密钥及其绑定的源与路径、「出错时改用」与「同时请求」上限（0600）；`provider.json` 是只在首次启动时迁移、不被修改的单一配置 |
| `gateway/` | 用量账本、汇总与预算（[MODEL-GATEWAY.md](./MODEL-GATEWAY.md#用量账本)） |
| `usage/` | 网关以外的轮次：自己登录与插件服务（[MODEL-GATEWAY.md](./MODEL-GATEWAY.md#网关以外的轮次)） |
| `mcp/servers.json`、`mcp/secrets.json`、`mcp-ended.json` | MCP 服务器定义与秘密值（目录 0700、文件 0600）、登录已结束但令牌未删净的服务器 ID（[MCP.md](./MCP.md)） |
| `customization.json` | 外观的修订与写入回执（[CUSTOMIZATION.md](CUSTOMIZATION.md)） |
| `sessions-meta.json` | Host 为每个会话保存的元数据：标题覆盖、置顶、归档、标签、优先级、看板记号、所属项目、会话文件夹或工作树、分叉来源、接入来源、Agent 归属、绑定的 PR，以及审批、取消、交付与配置修改的回执 |
| `session-folders.json`、`history-imports.json` | 会话启动请求键的哈希、自有文件夹名与启动目录哈希；Agent 固定家的归属与目录身份（0600） |
| `project-context.json` | 上次成功启动时用于离线项目校验的目录与 TLS 私钥路径（0600，不含密钥内容） |
| `sessions/runtime.json`、`runtime.lock` | Standard 的会话、请求回执与删除记录 |
| `harnesses/<id>/` | 外部 Harness 的私有数据；ACP 为 `acp.json`、`acp.lock`、命令目录缓存与每会话的 `skills/`（[CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#外部-harness-的通道)） |
| `queues.json`、`questions.json`、`prompt-templates.json` | 排队输入、Agent 提问、提示模板（见本文同名各节） |
| `history-imports.json` | 接入已有会话的回执（[HARNESSES.md](HARNESSES.md#接入已有会话)） |
| `agents/custom.json`、`agents/computer.json`、`agents/avatars/` | 我的 Agent 与「通用」的定义与记忆、电脑的睡眠与停止时段、图片头像（[CUSTOM-AGENTS.md](CUSTOM-AGENTS.md)） |
| `automations.json` | 保存的任务、运行与回执（[AUTOMATIONS.md](AUTOMATIONS.md)） |
| `handoffs/handoffs.json` | 交接记录与回执（[HANDOFFS.md](HANDOFFS.md)） |
| `work/items.json` | 待办与它们新建、开始的回执（见「待办」） |
| `work/threads/` | 每条待办的讨论，一个文件一条（见「待办的讨论」） |
| `review-notes/`、`snapshots/` | 行级反馈、每轮的文件快照与记录（[CHANGES.md](CHANGES.md)） |
| `attachments/`、`file-references/` | 附件存储（[ATTACHMENTS.md](ATTACHMENTS.md)）、会话提到过的文件路径 |
| `plugin-packages/`、`plugin-data/<pluginId>/` | 自定义插件的资产与构建记录（[PLUGIN-DEVELOPMENT.md](./PLUGIN-DEVELOPMENT.md)）、插件页面的数据与诊断（[APP-PAGES.md](APP-PAGES.md)） |
| `native/` | 中继配置、网络哈希与目录信任（[RELAY.md](RELAY.md)） |
| `host.json`、`host.lock`、`desktop-launch.json` | 见「Host 进程与数据目录」（都是 0600）；临时条目以 `.host-lock-`、`.desktop-launch-` 开头 |
| `host.log` | 桌面启动器或桌面端主进程在后台启动的 Host 的输出（0600，追加写入，不跟随符号链接） |

**启动顺序。** `pnpm start`：取得 `host.lock` → 检查没有不取锁的 Host 在运行 → 清理插件的旧代 → 加载 `--plugin` → （macOS）按需构建确认组件 → `startServer` → 写入 `host.json`。

`startServer`：数据目录（0700，属于当前用户）→ 打开并校验审计 → Host 身份 → 安全策略（含带外修改检测）→ 设备登记（含撤销日志重放）→ 运行目录 → 配置文件与 MCP 定义 → 时间机器排除 → TLS 材料检查 → 启动目录检查 → 设置的带外修改检测与已保存项目的重新检查 → 插件、模型服务与 Agent → Harness 挂载 → 监听入口 → 审计 `host.started` → 写入 `project-context.json`。

**写入。** 配置写入使用临时文件、fsync、原子 rename 与目录 fsync，并按文件串行。损坏的配置文件以 `config-corrupt` 报告文件名并保持原样，不会被覆盖。

**Standard 的存储。** `RuntimeStore` 提供 `load / commit / close`；默认实现是完整快照文件，单写者由锁文件保证。确认旧 PID 已退出才回收锁；无法校验的锁（409 `store-lock-invalid`）或损坏的快照（`store-corrupt`）报错并保留原文件。新增字段都是可选字段，`version` 保持 1。

| 情况 | 语义 |
| --- | --- |
| 重试创建 | 同一 `requestId` 与相同内容返回同一会话，重启后也不重跑；内容或模式不同返回 409 `request-conflict`。只有显式传入的 `model`/`cwd` 参与比较 |
| 重试输入 | 回执按会话与 `requestId` 区分；运行中的新输入返回 409 `task-running` |
| 重试审批或取消 | 回执在 `sessions-meta.json` 中，重启后同一设备的同一 `requestId` 得到原回执 |
| 删除后重试 | 会话删除后保留回执与删除记录，重试创建返回 410 `task-deleted` |
| Host 崩溃后启动 | 运行中、待审批或未完成工具批次的会话转为 `interrupted`；旧审批失效，不自动续跑 |
| 工具已开始但没有结果 | 写入 `TOOL_OUTCOME_UNKNOWN`，要求先核对副作用，不自动重放；被允许的调用即使没有报告运行也算已开始；未开始的调用写入 `TOOL_NOT_STARTED` |
| 存储提交失败 | 停止接受新操作并取消活跃运行 |

已确认的消息持久化；流式中的文字与思考暂存在内存，崩溃可能丢失尚未结算的部分。快照存储没有历史压缩、分页或自动备份。

## 数据、保留与导出

「设置 › 数据」说 Latch 在这台电脑上保存什么、在哪里、多大、留多久，可以读审计记录、导出全部。三者都只给有 `admin` 且数据范围为 `all` 的设备（`routes/data.ts`）：它们跨越每个会话、Agent 与设备，私有的也在内，所以更窄的设备什么也得不到，连有多少都不知道（403 `agent-scope-required`）。界面只在这样的设备上列出这个分区。

**保存什么、留多久**（`data-inventory.ts`）。按种类列出数据目录里的条目、保留期与大小。保留期由各个存储自己用的常量拼出（`USAGE_KEEP_DAYS`、`PRUNE_AFTER`、`DEFAULT_LIMITS`、`MEMORY_UNDO_DAYS`、`ATTACHMENT_TTL` 等），没有任何东西让它过期的写「一直保留」：

| 种类 | 条目 | 保留 |
| --- | --- | --- |
| 会话与对话记录 | `sessions/`、`harnesses/`、`sessions-meta.json`、`queues.json`、`questions.json`、`review-notes/`、`file-references/`、`session-folders.json` | 一直保留，直到删除会话 |
| 改动快照 | `snapshots/` | 每个会话最近 20 轮、每个项目最多 2 GiB，超出先删最早的；删除会话时删除 |
| 我的 Agent 与记忆 | `agents/` | 直到删除；删除的记忆文字可撤销 7 天 |
| 待办与讨论 | `work/` | 直到删除待办 |
| 附件 | `attachments/` | 随会话；没发出的 60 分钟，中断的上传 60 分钟 |
| 定时任务与交接 | `automations.json`、`handoffs/` | 每个定时任务最近 50 次运行（另 50 次错过或跳过的）、结果 256 条；交接 256 个 |
| 用量记录 | `gateway/`、`usage/` | 明细 90 天，按月删去更早的；单价与预算一直保留 |
| 审计记录 | `audit/` | 一直保留 |
| 设备登记 | `auth/` | 撤销或凭据过期 90 天后删去登记；撤销记录一直保留 |
| 插件与应用数据 | `plugin-packages/`、`plugin-data/` | 每个插件 5 个可回退版本、3 代应用数据 |
| 设置 | `settings.json`、`policy.json`、`customization.json`、`shortcuts.json`、`prompt-templates.json`、`project-context.json`、`mcp-ended.json` | 一直保留；外观 20 个修订 |
| 密钥与连接凭据 | `providers.json`、`mcp/`、`identity/`、`native/` | 直到你删除；从不导出 |
| 运行日志 | `host.log` | 一直保留，不轮转 |

数据目录之外的工作树、Agent 的家、系统临时目录里的录屏与截图只写出位置与保留，不统计。各 Harness 自己保存的会话和模型服务那边的历史不归 Latch，页面在一个悬停里说明一次。

- **大小**：`POST /link/api/data/sizes` 只走上表列出的条目名（不含分隔符，不出数据目录），用 `lstat`，链接只算它自己、从不跟随；每次最多 20 万个条目、16 层，到界限时标「至少」。结果留到下次统计：打开页面不走磁盘，本次运行还没统计过时页面才请求一次。计入设置类操作的限速。
- **位置**：`GET /link/api/data` 回数据目录的路径。桌面端「在访达中显示」由主进程自己向 Host 取路径再显示，页面不传路径。

### 审计记录

`GET /link/api/audit/records?before&limit&kind&actor&since&until`（`audit-view.ts`），只读，新的在前。

- **读什么**：`AuditLog.readBefore` 按自己记下的每行起点读已确认的行，逐行再过一遍记录与 detail 的 strict schema，读不通就停。每页最多看 5000 条、回 50 条（最多 100），过滤在分页之前；早于 `since` 即停。`next` 接着往前读。
- **显示什么**：谁（设备的名称、Latch 或命令行）、何时、动作的中文名（`audit-labels.ts`，按类型覆盖每个动作，缺一个不能构建）与类别、对象（会话、设备、Agent、项目、Harness 按 Host 现在知道的名称，不知道的写短 ID）。detail 的每个字段按 `audit-fields.ts` 的标记显示：`show` 照写（枚举、布尔、计数），`short` 只写前 8 位（公开的 ID 与只算公开事实的哈希），`hidden` 不显示（从秘密材料算出的，例如中继的 `profile` 与手机设置的 `before`、`after`，以及 `keyHash`）。表按类型覆盖每个动作的每个字段，新字段不标记就不能构建；表里没有的字段一律不显示。不回原始 detail，不回完整哈希。每页计入设置类操作的限速。
- **谁能读**：同上，`admin` 与数据范围 `all`；更窄的设备读不到任何一条，所以审计不会让它知道私有会话或其他设备的事。

### 导出全部

只在本机桌面端：页面先用对话框说明导出什么、不导出什么及原因，主进程用原生面板选文件夹，签名（与添加文件夹相同的 nonce 与设备签名，`via: 'export'`）后调 `POST /link/api/data/export`；页面自己的请求到这条路由会被代理拦下。进度与取消是 `GET /link/api/data/export/:id` 与 `POST …/:id/cancel`，只给发起它的设备。实现在 `data-export.ts`。

- **按名单导出**：会话（每个一份 JSON 与一份 Markdown：标题、Harness、时间、你和 Agent 的消息文字、附件名称与大小；工具行只有名称与状态，不含输出，思考也不导出，因为里面可以有 Agent 读到的任何内容）、我的 Agent 与「通用」（指令与记忆）、待办与讨论、设置里的数据（外观、提示模板、项目与文件夹路径），再写 `manifest.json` 列出每个文件的路径、大小与 SHA-256、读不到的会话和不导出的种类。每种都从 Host 自己的记录按字段名取，不展开记录；会话经 hub 读 Latch 的记录，从不读 Harness 自己的文件。所有导出的文字再经 `redactKnownSecrets`，遮住 Host 已知的密钥值与可辨形状的凭据；形状不可辨的不会被遮住，对话框照实说。
- **从不导出**：模型密钥、MCP 服务器定义与秘密值、Harness 的启动方式与环境变量、设备登记与凭据、连接码与中继密钥、Host 身份、审计记录（其中有从中继密钥算出的哈希）、附件与快照的内容、Harness 自己的会话。
- **只写在选定的文件夹里**：先审计 `data.exported`（导出 ID 的哈希、文件夹路径的哈希、种类），写不进就不导出；再非递归地新建「Latch 导出 <时间>」，同名已存在（文件夹或链接）就换下一个名字，从不写进已有的；每个文件前核对这个文件夹的身份（设备号与 inode，不是链接），文件用 `O_EXCL | O_NOFOLLOW` 新建、0600，文件名只由 ID 构成。一次只导出一个；每个文件之间复查设备权限，被撤销或收窄就停止。失败或取消时只删除它新建的那个文件夹，结束写 `data.export.result`。

### 删除说了什么

删除会话、项目与 Agent 的确认都取自 `apps/web/src/deletionCopy.ts`，按实际行为写：

- **会话**：删除 Latch 里的对话、附件与改动快照（每条删除路径都经 `removeSessionRecords`）。用 Host 自己的模型服务运行的 Harness（`capabilities.models.owner` 为 `latch`）只有 Latch 这一份；其他 Harness 在 Latch 能启动它（项目仍在、启动方式核对通过）且它声明 `session/delete` 时，Latch 也请它删除自己保存的副本，否则它的副本可能留下（Grok 的私有目录随会话删除，见 [HARNESSES](HARNESSES.md)）；接入的原会话从不删除。审计与用量记录保留；已发给模型服务的内容无法撤回。
- **项目**：只从列表移除，文件、会话与快照都保留。
- **Agent**：记忆、提议与撤销记录删除，聊天记录与家保留；外部 Harness 已收到的上下文留在原会话里。
- 没有「删除全部数据」：停止 Host 后删除数据目录才是。

## 桌面端与其他电脑

桌面端除了经 `host.sock` 连接这台 Mac 的 Host，还可以经 HTTPS 连接其他电脑的 Host（`apps/desktop/src/computers.cjs`、`remote-proxy.cjs`）。每台 Host 仍是自己会话的唯一权威，Host 之间互不登记，也没有跨电脑的会话。

**列表属于桌面端。** `userData/computers.json`（0600，原子写入，严格校验，不含凭据）最多 16 条记录，可添加 15 台其他电脑。

- 无法解析的文件按空列表处理，下次写入前移到 `computers.json.damaged`；写入只写通过校验的记录。
- 启动时某台电脑的凭据无法打开时，列表只读，直到下次启动。
- 这台 Mac 不写入列表，由 `host.json` 决定；只有经 `host.sock` 的 Host 叫「这台 Mac」。

**添加。** 主进程读剪贴板或 `--code-file` 写出的文件，只接受 `https://<地址>/link/#pair=<码>`，页面看不到链接与码。

- 添加与移除只接受这台 Mac 页面上一秒内的真实点按或按键（主进程检查）。
- 主进程先读那台 Host 的 `GET /health` 得到 hostId（这台 Mac 自己与已添加的电脑被拒绝），再为它新生成设备密钥并登记；确认在那台电脑上用它自己的本机确认完成。
- 凭据存入 `latch-devices/<hostId>.json`（safeStorage，0600），一台电脑一份，从不复制给另一台。成功后剪贴板里仍是这条链接时清除。

**来源与分区。** 每台其他电脑的窗口是 `latch://h-<hostId>/`，在自己的会话分区 `persist:latch-host-<hostId>` 里：页面存储、缓存与协议处理互不相通。

- 分区里的 `latch:` 只转发到这台 Host；渲染进程的请求、导航与子框都限制在自己的来源。
- 预览与插件页面运行环境走 `latch-frame://h-<hostId>/…`，只能被同一来源的页面嵌入；`html-script` 预览只在这台 Mac 的页面上提供。
- 页面来自那台 Host 自己的 `dist/web`。

**转发。** 主进程用 Node 的 HTTPS（自带根证书加系统信任库，不复用连接）按请求的来源选凭据，只附加那台 Host 的 Cookie `__Host-latch_<hostId8>`。

- 页面带来的 Cookie、`Authorization`、`Origin`、`Referer` 与 `sec-*` 一律丢弃，响应里的 `Set-Cookie` 不交给页面。
- 主进程在 `renewAfter` 时续期。写请求不重放：只在 Host 以 `renewal-required` 拒绝后重发一次。
- 事件流按流转发，主进程从中读取那台 Host 自己的 `host-state` 帧。

**证书固定。** 把凭据绑定到那台 Host 的是证书：添加时记下它的 SHA-256，与地址一起存在 safeStorage 加密的凭据文件里（`binding`，另有以设备私钥派生的 HMAC）。

- `computers.json` 只用于列表显示，地址与加密记录不一致时按加密记录恢复。没有记录的证书时不按第一次见到的证书信任。
- 每个请求由主进程先完成 TLS 握手，证书不是这一张就断开，请求连同凭据一个字节也不写出。
- 证书系统不信任或与地址不符时为「证书不受信任」，没有「仍然信任」。
- 不带凭据的 `GET /health` 核对 hostId（每 60 秒最多一次，连接出错或证书不符后立即重来）：不一致时不自动替换。

**信任新证书。** 证书换了（例如续期）时不发凭据。人确认后，主进程经只接受这张新证书的连接请求 `POST /host-proof { nonce }`（不带凭据）。

- Host 返回身份密钥的公钥与签名，签的是 `latch-cert-proof-v1\n<hostId>\n<nonce>\n<Host 在这条连接上实际出示的证书的 fingerprint256>`（ECDSA P-256，IEEE P1363；共享向量 `security-v1.json` 的 `signing.hostProof`）。
- hostId 就是这把公钥 SPKI 的 SHA-256（base32）。主进程先核对公钥的哈希是添加时的 hostId，再用看到的证书核对签名，一致才固定新证书。
- 没有身份私钥的服务器签不出；把请求转给真 Host 的中间人得到的是对真证书的签名。证明不依赖设备凭据的哈希，所以泄露的 `auth/` 不足以让别人的证书被固定。
- 没有这个路由（404）一律拒绝，不提供跳过证明的办法。持有被固定证书私钥或 Host 身份私钥的一方不在防御范围内。

**远程页面能做的事。** 凭据、登记、配对链接、睡眠与停止报告、更新、会话文件与添加文件夹的路由在远程来源上一律 403 `shell-managed`。

- 远程页面的 `latchShell` 只有 `{ kind: 'electron', remote: true, devMode, platform, computers: { list, subscribe, open, subscribeSession }, spaces: { onShow }, lights? }`：没有文件夹、文件、预览浏览器、生命周期、通知与更新；那台 Host 判定 `access.local` 为 false。
- 这台 Mac 的页面另有 `add`、`cancelAdd`、`remove`、`trustCertificate`。`open`、`add`、`remove` 与 `trustCertificate` 只接受该页面一秒内的真实点按或按键；同一台电脑同时多次 `open` 只开一个窗口。
- 跨电脑交给页面的只有电脑名、状态、上次在线、版本与 Host 宣布的停止原因。

**状态。** `online`、`connecting`、`offline`、`stopping` / `sleeping`（来自 `host-state`，到 `retryAfter` 前不算离线）、`revoked`（那台 Host 撤销或凭据过期，本地凭据随即删除）、`wrong-host`、`cert-error`、`cert-changed`、`outdated`（`health` 没有 hostId，不发凭据）。有 Latch 窗口在前台时主进程每 15 秒、没有时每 60 秒看一次在线的电脑；离线时从 15 秒退避到 5 分钟，`revoked` 不再看。

**等你处理。** 主进程用每台电脑的已认证快照、按 `notifications.cjs` 的 `attentionOf` 算出条目 `{ hostId, taskId, title, kind: 'approval' | 'question' | 'stuck', since }`。

- 标题去掉控制、格式（含双向覆盖）、行与段分隔符和默认可忽略字符，截到 80 个码点；每台最多最新 50 条，另有运行数（上限 100,000）。读不懂的快照被忽略；同一台电脑的读取一次一个。
- 条目只进这台 Mac 窗口的列表（`ComputerSummary.waiting` 与 `running`）；其他电脑的窗口拿到的列表没有这两项（主进程不发，preload 也删掉）。快照本身不交给任何页面。
- 看起来相同的电脑名（按 NFKC、去掉不可见字符并忽略大小写比较）都加 hostId 前 4 位；拉丁字母与有拉丁形近字的文字混写的名字总是加。
- 代价（接受并记录）：这台 Mac 页面里运行的代码能读到其他电脑等你处理的标题，所以只给标题与种类，不给消息、路径、审批参数或项目。插件页面在隔离框里，拿不到 `latchShell`。
- 系统通知与 Dock 见 [NOTIFICATIONS.md](NOTIFICATIONS.md)。

**移除。** 能以原身份连上时先 `DELETE /devices/current` 撤销这台设备；然后删除凭据文件、列表记录与分区存储，并关闭这个分区里的所有窗口。不在列表中的 `Partitions/latch-host-*` 在下次启动时删除。

**更新与确认。** 桌面端只更新这台 Mac 的 Host；其他电脑的更新、重启、插件与模型密钥都在那台电脑上进行，本机确认留在各自的电脑上。

**iPhone/iPad。** 选中的电脑保持完整工作台；其他电脑由核心的 `NativeListWatcher` 各开一个只读连接。

- 只发 `GET /link/api/native/revocation` 与 `GET /link/api/snapshot`：不开正文窗口、不读详情、不订阅 SSE、不发任何写入。
- 读到绑定那台电脑与本设备、由其 Root 签名的撤销证明时，清除资料、密钥与加密缓存，之后不再拨这个身份。
- 前台每 15 秒读一次，同时最多 3 个连接，更多时每 60 秒换下一批；连不上的按 15 秒起翻倍、最多 5 分钟退避；切到后台与锁定时全部关闭。
- 快照只留行字段并核对设备 ID：设备 ID 不是本设备时是「不是这台电脑」，不显示它的任何条目。每台最多最新 50 条，标题截到 80 个码点。
- 「其他电脑等你处理时通知」默认关，只在 App 在前台时发本地通知，正文不写会话标题。

## 多端同步

Host 约每 40ms 合并一次变化，把选中会话的状态推送给订阅它的连接；浏览器重连通过 HTTP 重新同步，不重放历史；断开 SSE 不取消任务。帧、增量与门禁见 [STREAMING.md](./STREAMING.md)。

**流量计数。** Host 在内存中计数自己发出的字节（事件流的帧、快照与会话详情的响应体），只含数字、时间、入口类别与会话 ID，重启清零。`GET /traffic` 与 `pnpm latch traffic` 读取它（[STREAMING.md](./STREAMING.md#流量计数)）。

## HTTP API

接口根为 `/link/api`，是本项目的内部协议，不承诺版本兼容。

**检查顺序。** Host 与来源检查 → 认证 → 权限 → 入口规则 → 本机确认（只有少数操作）→ 审计 → 执行。排队或等待确认的请求在执行前按设备当前记录重新检查。

**路由模块。** `handleApi` 按 `routes/index.ts` 的次序在四处询问模块：

1. 任何路由之前的连接检查（文件传输连接只取它的文件，被撤销的手机只能读撤销通知，配对连接只能登记）。
2. 健康检查与运行状态路由之后、认证之前：无需凭据的路由（登记、凭据续期）。
3. 认证之后、拒绝匿名 `host.sock` 调用之前：原生连接的验证窗口。
4. 所有检查之后、`server.ts` 自己的路由之前。

每个路由的入口、权限与限速检查在它所在的模块中，`apps/host/test/route-guards.test.ts` 逐个核对。

**匿名的 `host.sock`。** 没有凭据的 `host.sock` 连接以匿名命令行身份审计，只能调用健康检查、`host-info`、运行状态报告、登记，以及 `server.ts` 的 `ANONYMOUS_UNIX` 列出的路由（下表标「或匿名」）。

**错误与上限。** 错误体为 `{ error, message, ...details }`；429 同时带 `retry-after` 响应头，输入校验失败为 400 `invalid-input`。创建与输入的 `requestId` 必须是 UUID，prompt 去除首尾空白后最多 16,000 字符。请求体上限：创建会话与输入 256 KiB（`TASK_BODY_LIMIT`），模型服务、Agent 定义与添加文件夹 128 KiB（`CONFIG_BODY_LIMIT`），`jsonBody` 的默认值 32 KiB。

下表的路径省略 `/link/api`。「本机」指 `host.sock` 上的已登记设备（桌面端）。请求体与字段以所列模块和文档为准。

**连接与设备**（`server.ts`、`routes/devices.ts`、`routes/native.ts`）

| 路径 | 谁可调用 | 说明 |
| --- | --- | --- |
| `GET /health` | 无 | `{ ok, hostId }`；hostId 本来就公开 |
| `GET /host-info`、`POST /host/state` | 无，仅 `host.sock` | Host 实例信息；运行状态报告（见「Host 的生命周期」） |
| `POST /host-proof` | 无，仅 HTTPS 入口，按对端地址限流 | 见「桌面端与其他电脑」 |
| `GET /enrollment-info`、`POST /enrollment-invitation`、`POST /enrollments`、`GET`/`DELETE /enrollments/:id`、`POST /enrollments/:id/prepare`、`POST /enrollments/:id/complete` | 无（同一入口与来源；完成需设备签名） | 设备登记。新设备的名称与一台未移除的设备相同时，Host 加「 (2)」等序号再交给系统确认表单 |
| `POST /login`、`POST /pair` | — | 410 `login-removed` |
| `POST /credentials/challenge`、`POST /credentials/renew` | 设备（含待续期） | 凭据续期 |
| `PATCH`/`DELETE /devices/current` | `view` | 重命名、撤销本设备 |
| `GET /devices`、`DELETE /devices/:id` | `admin` 或匿名 | 设备列表、撤销；撤销当前设备用 `/devices/current` |
| `PATCH /devices/:id` | `admin`；授予权限或扩大数据范围需本机与本机确认 | 调整权限与数据范围 |
| `PATCH /devices/:id/name`、`GET /enrollments` | 本机 `admin` | 重命名任一设备；仍在等待的登记 |
| `POST /pairings` | 本机 `admin` 或匿名 | 配对邀请 `{ scopes?, target? }`；未配置 HTTPS 入口时 409 `tls-not-configured`。桌面端只由主进程调用 |
| `GET /native/info`、`/native/pairings…`、`/native/relays…`、`/native/relay-requests/:id`、`DELETE /native/directory` | 本机 `admin`（`GET /native/info` 或匿名）；添加中继需本机确认 | 手机配对二维码与自建中继（[RELAY.md](RELAY.md)）。签发二维码要先打开局域网入口：没有网络时 409 `native-no-lan`，完全访问的会话运行或等待时 409 `presence-blocked` |
| `/native/pairing`、`/native/verification…`、`/native/revocation…`、`/native/address-book`、`/native/proximity`、`/native/bulk` | 原生连接上的设备 | 手机 App 的验证窗口、撤销通知、地址簿与文件传输 |
| `GET`/`DELETE /confirmations/:id` | 发起确认的设备 | 查询或取消本机确认 |
| `GET /audit/head`、`GET /audit/hash?seq=` | `view` | 审计检查点 |
| `GET /audit/records`、`GET /data`、`POST /data/sizes` | `admin` 与数据范围 `all` | 审计记录、数据目录与保留、统计大小（[数据、保留与导出](#数据保留与导出)） |
| `POST /data/export`、`GET /data/export/:id`、`POST /data/export/:id/cancel` | `admin`、`all`，本机桌面端，主进程签名 | 导出全部 |

**会话**（`server.ts`、`session-routes.ts`）

| 路径 | 谁可调用 | 说明 |
| --- | --- | --- |
| `GET /snapshot`、`GET /events?sessionId=`、`GET /tasks/:id` | `view` | 状态、事件流、详情 |
| `POST /tasks` | `run` | L3 写启动审计，不弹确认；带 `via` 时是插件页面开始会话（[APP-PAGES.md](APP-PAGES.md#会话)） |
| `POST /tasks/:id/prompt` | `run` | L3 会话也可以从任何设备输入；`queue: true` 见「排队输入」 |
| `PATCH`/`DELETE /tasks/:id`、`POST /tasks/batch` | `run` | 重命名、置顶、归档、标签、优先级（`high`、`mid`、`low`）、删除；私有会话另需 `all`；批处理见「会话搜索与批处理」 |
| `POST /tasks/:id/attend` | `opened`：`view`；`checked`：`run`；私有会话另需 `all` | 看板记号，见「看板的组」 |
| `POST /tasks/:id/cancel`、`…/stop-subagent`、`…/keep-waiting`、`…/computer-stop` | `view` | 取消；停止一个子 Agent（[HARNESSES.md](./HARNESSES.md#子-agent)）；推迟沉默提示（[STREAMING.md](./STREAMING.md#运行的真实状态)）；结束这个会话的「操控这台 Mac」（[MCP.md](./MCP.md#操控这台-mac)） |
| `POST /approvals/:id` | 拒绝 `view`；允许 R1 `approve:standard`；允许 R2 `approve:elevated`；允许 L3 询问 `run` | 见「审批与取消」 |
| `POST /tasks/:id/config`、`GET /tasks/:id/config-requests/:requestId`、`POST …/check` | 修改与核对 `run`；查询为原设备的 `view` | 见「会话配置修改回执」 |
| `PATCH`/`DELETE /tasks/:id/queue/:itemId`、`POST …/send` | `run` | 见「排队输入」 |
| `POST /tasks/:id/questions/:questionId/answer` | `run` | 见「Agent 提问」 |
| `POST /search` | `view` | 见「会话搜索与批处理」 |
| `GET /prompts`；`PUT`/`DELETE /prompts/:id` | 读 `view`；写 `admin` | 见「提示模板」 |
| `GET /tasks/:id/worktree`、`POST …/remove`、`GET /workspaces/:id/worktree`、`/workspaces/:id/worktrees…` | `run` | 工作树（[BRANCHES.md](BRANCHES.md)） |

**按领域分出的路由**

| 路径 | 模块 | 谁可调用 | 文档 |
| --- | --- | --- | --- |
| `/tasks/:id/files/…`、`/workspaces/:id/files/…`、`/files/:handle…` | `files/index.ts` | 读 `view`；枚举与搜索另需数据范围 `files`；编辑 `run` + `files`；`POST /files/:handle/local` 只在本机 | 「会话文件」、[DOCUMENT-PREVIEWS.md](DOCUMENT-PREVIEWS.md) |
| `/attachments…` | `attachment-routes.ts` | 读 `view`，上传与绑定 `run` | [ATTACHMENTS.md](ATTACHMENTS.md) |
| `/tasks/:id/changes…`、`/tasks/:id/turns/:turnId/(undo\|redo)`、`/tasks/:id/review-notes…` | `routes/changes.ts`、`routes/review-notes.ts` | 行级反馈：读 `view`，写 `run`，数据范围 `files`；改动与撤销见文档 | [CHANGES.md](CHANGES.md) |
| `/tasks/:id/git…`、`/workbench/delivery` | `routes/git.ts` | 读 `view`，写 `run`；内容与私有会话另需 `all` | [GIT-DELIVERY.md](GIT-DELIVERY.md) |
| `/tasks/:id/terminals…`、`/workspaces/:id/terminals…` | `routes/terminal.ts` | 见文档 | [TERMINAL.md](TERMINAL.md) |
| `/browser-provider/…`、`/tasks/:id/browser-tabs` | `routes/browser.ts` | 见文档 | [PREVIEW-BROWSER.md](PREVIEW-BROWSER.md) |
| `/simulators…` | `routes/simulators.ts` | 见文档 | [DEVICE-PREVIEW.md](DEVICE-PREVIEW.md) |
| `/handoffs…` | `routes/handoffs.ts` | 读 `view`，写 `run`；都要能读相关会话 | [HANDOFFS.md](HANDOFFS.md) |
| `/work/items…` | `routes/work-items.ts` | 读 `view`，写 `run`；私有待办只给数据范围 `all` | 「待办」 |
| `/work/items/:id/posts` | `routes/work-threads.ts` | 读 `view`，写 `run`；对 Agent 另需数据范围 `all` | 「待办的讨论」 |
| `/history/…` | `routes/history.ts` | `run` + 数据范围 `all` | [HARNESSES.md](HARNESSES.md#接入已有会话) |
| `/custom-agents…` | `routes/agents.ts` | 见文档 | [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md) |
| `/automations…` | `routes/automations.ts` | 见文档 | [AUTOMATIONS.md](AUTOMATIONS.md) |
| `/apps/:pluginId/…`、`/app-modules/…` | `routes/apps.ts` | 读 `view`，写 `run`；先核对页面的修订与能力 | [APP-PAGES.md](APP-PAGES.md) |
| `/ui-modules/:panelId/:sha256.mjs`、`/tasks/:id/ui-panels/:panelId` | `server.ts` | `view` | [PLUGIN-DEVELOPMENT.md](./PLUGIN-DEVELOPMENT.md) |
| `/plugin-packages…` | `plugin-package-routes.ts` | 见文档 | [PLUGIN-DEVELOPMENT.md](./PLUGIN-DEVELOPMENT.md#应用内的自定义插件资产) |
| `/mcp/servers…`、`/mcp/import` | `routes/mcp.ts` | 读 `view`；其余本机 `admin`，新增与放宽经本机确认 | [MCP.md](./MCP.md) |
| `/usage`、`/model-usage`、`/model-spend`、`/model-prices`、`/model-budgets` | `model-usage-routes.ts` | 读 `view`，写 `admin`；Agent 预算另需 `all` | [MODEL-GATEWAY.md](./MODEL-GATEWAY.md#汇总) |
| `/customization…` | `routes/customization.ts` | 读 `view` 或匿名；写 `admin`；重置 `admin` 或匿名 | [CUSTOMIZATION.md](CUSTOMIZATION.md) |
| `/harnesses/:id/(login-status\|login-terminal\|logout)` | `routes/agent-login.ts` | `run`；打开终端只在本机 | [HARNESSES.md](./HARNESSES.md#登录) |
| `/host/update-window…` | `server.ts`、`update-window.ts` | 本机 `run` | [UPDATES.md](./UPDATES.md) |

**配置**（`server.ts`）

| 路径 | 谁可调用 | 说明 |
| --- | --- | --- |
| `GET`/`POST /providers`、`PUT`/`DELETE /providers/:id`、`GET`/`PUT /provider` | `admin`；填写密钥另需 `secrets` 且只在本机；确认地址只在本机，经本机确认 | 模型服务，不返回密钥 |
| `POST /provider-origins` | 本机 `admin` | 保存服务之前确认一个地址 |
| `GET`/`POST /providers/additions/:requestId` | 本机 `admin` | 新增服务的回执与核对（见「Host 的生命周期」） |
| `POST /providers/:id/models`、`POST /provider-checks` | `admin` | 经出站策略获取模型列表、检测连接；用已保存的密钥时只发往已确认的地址 |
| `GET`/`POST /agents`、`PUT`/`DELETE /agents/:id` | `admin`；新增与改命令、参数、变量要本机与本机确认 | ACP Agent 定义；环境变量只返回名称 |
| `POST /agents/:id/probe` | `admin` 与 `run` | 检测一个 Agent 定义 |
| `POST /agents/:id/commands` | `view` | 读取 Harness 的命令目录 |
| `GET /extensions` | `admin` | 每个外部 Harness 最新一份普通会话报告的命令与技能（[HARNESSES.md](./HARNESSES.md#扩展)） |
| `POST /agents/:id/catalogue`、`POST /agents/:id/mcp`、`PUT /agents/:id/models` | `run` | 不开始会话读取模型与选项、Harness 自己的 MCP；保存自己填写的模型 ID（[HARNESSES.md](./HARNESSES.md#开始前的选项)） |
| `POST /quota/refresh` | `run` | 有人看「额度」时在后台读已绑定 Harness 缺失或过时的额度，不起模型轮次，立即回答 `asked`（[HARNESSES.md](./HARNESSES.md#额度)） |
| `GET /workspaces` | `view` | 项目列表，含文件夹与不可用原因 |
| `POST /folder-grants`、`POST /workspaces`、`POST /workspaces/:id/folders` | 本机 `admin`；后两者另需签名 | 见「谁能添加」 |
| `POST /workspaces/clone`、`GET /workspaces/clone/:id`、`POST …/clone/:id/cancel` | 本机 `admin`；开始另需签名 | 克隆成新项目（[GIT-DELIVERY.md](GIT-DELIVERY.md#克隆)） |
| `PATCH /workspaces/:id`、`DELETE /workspaces/:id`、`DELETE /workspaces/:id/folders/:folderId` | `admin` | 重命名、图标、文件夹顺序；移除项目或文件夹（文件不删除） |
| `GET /plugins`、`POST /plugins/:id`、`PUT /preferences` | `admin` | 插件列表与启停、新会话默认值；`pinned` 及其之后的 Harness 与模型只能经 `host.sock` 修改 |
| `GET`/`PATCH /policy` | 设备；修改 `admin`，加入出站地址需本机与本机确认 | 安全策略及其哈希；放宽只有 `hostEgressAllow` 一项 |
| `GET /traffic` | `admin` 或匿名 | 流量计数 |
| `POST /diagnostics` | 本机 `admin` 或匿名 | 见「会话文件」的诊断导出 |

`/link/` 下的静态页面在所有入口上无需认证（Host 与来源检查照常）。不是页面的地址返回 404 的普通 HTML 页面，不回显请求的路径，不运行脚本（`apps/host/src/not-found.ts`）；`/link/api/` 下的路径仍返回 JSON 错误。

## 兼容标识

为兼容已有数据，改名必须附带迁移。根包与它的 Vitest 项目名为 `latch`，浏览器存储键的前缀为 `latch.`；它们的旧名 `harness-link` 与 `harness-link.` 仍被识别：

- **程序目录。** `findCodeRoot` 认根包名 `latch`，也认旧名 `harness-link`，程序目录保护照常生效。
- **插件 SDK。** 入口写作 `latch/plugin-sdk` 与 `latch/harness-sdk`；以旧目录名 `harness-link` 安装本包的插件写 `harness-link/…`，同样可以编译（`tests/plugin-sdk.test.ts`）。
- **浏览器存储。** `apps/web/src/core/storageKeys.ts` 的 `readStorage` 在新键没有值、旧键有值时，把值复制到新键并删除旧键；新键已有值时以新键为准，旧键不动。Host 尚未确认的提交保留原 `requestId`。

以下名称保持不变：`/link/` 路径前缀（已配对的手机与书签使用它）、数据目录布局（含 `.runtime`）、模型服务 ID `openai-compatible`。Cookie `harness_link` 只用于识别需要重新确认的浏览器。Cordis 固定在 `4.0.0-rc.12`，升级前需回归插件生命周期。

Latch 不再提供个人助手、助手群聊与它们的定时任务，数据不删除也不迁移：

- **会话。** 这些会话在 `TaskSummary.personal` 上带着归属，算作私有，只对数据范围为 `all` 的设备开放，列表里照常出现，打开只能查看：写操作都回答 409 `session-read-only`；分叉出的新会话同样私有。新建会话带 `assistantId` 回答 409 `assistant-removed`；iPhone 把这类未确认的提交与写到 `/link/api/personal/` 的提交直接从待确认的写入里删除。
- **审计。** 审计动作表保留 `personal.changed`（`apps/host/src/audit-actions/personal.ts`），否则带这一行的审计链在启动时校验失败，Host 不能启动。
- **数据目录。** `personal` 仍在 `PRIVATE_ENTRIES` 中；`policy.json` 的 strict schema 不变。

数据目录里还可能有三个 Latch 不再使用的标识，照样能读，启动时不改写任何文件：

- **模型服务的协议 `gemini`**（`RETIRED_PROVIDER_KINDS`）。`providers.json` 里这样的服务原样读回、原样写回；它不注册 Provider，`unusableProviders` 以 `unsupported` 列出。给它开会话、改它或读它的模型列表返回 409 `provider-unsupported`，没有请求发往它的地址；只能移除，密钥随之删除。指向它的「出错时改用」与默认模型按已不在的服务处理。设备提交这个协议一律 400。
- **Harness 预设 `gemini`**（`RETIRED_AGENT_PRESETS`）。`settings.json` 里带这个 `presetId` 的定义保留，Driver 照常挂载以便读取它的会话：会话可以看、可以删，新开或继续返回 409（`harness-retired`），命令不被查找也不被启动，也不按命令名套用别的预设。绑定它的 Agent 与定时任务同样不运行，不换用其他 Harness 或模型。
- **会话路由的协议 `gemini`**。`acp.json` 里保存过的路由照样读回；继续这样的会话时在打开路由处被拒绝（409 `model-route-unsupported`），网关不为它签发凭据。

回归用例在 `apps/host/test/retired-data.test.ts` 与 `apps/host/test/model-gateway.test.ts`。

## 尚未实现

| 项目 | 原因 |
| --- | --- |
| `host.sock` 对端进程身份检查、按会话标记识别进程 | 需要签名的原生扩展 |
| 浏览器里的多台电脑、桌面端经原生链路或中继连接其他电脑、跨电脑会话、iPhone/iPad 后台时的其他电脑通知 | 不提供或尚未实现：浏览器保持严格同源；桌面端只走运营者证书的 HTTPS |
| 回环请求的额外绑定值或设备签名 | 未实现（见「不防御的情况」） |
| Linux（polkit）与 Windows（Windows Hello）本机确认 | 未实现；这些系统上本机确认不可用，可用离线连接码登记桌面端，回环与 HTTPS 上的登记无法完成 |
| 在 macOS 以外从桌面端打开浏览器 | 未实现；改用 `pnpm latch device invite --loopback` |
| 无界面服务器的确认通道（独立系统用户、命令行确认） | 未实现，`policy.json` 的 `operators` 被忽略；Linux 服务器建议用独立系统用户运行 Host |
| 打包的桌面端与登录项 | 尚无打包构建；登录项只能登记打包后的 Latch.app |
| Electron fuses、签名安装包、asar 完整性、Secure Enclave 设备密钥 | 尚无打包构建；当前为开发版 |
| 系统 Keychain 保存 Host 身份与密钥 | 需要签名的 Host 程序；目前为数据目录内的 0600 文件 |
| 远程客户端的公钥固定、仅 mTLS 入口、证书自动申请与续期、可信反向代理配置 | 未实现；证书由运营者提供并续期（文件更新后 Host 自动重新加载）；从不读取代理请求头 |
| 操作系统沙箱、Agent 出站代理、项目配置中和、托管安装 | 未实现；因此每个 ACP 与插件 Harness 会话都是 L3 |
| Standard 的 L0 / L2 级别与级别选择 | 未实现；Standard 固定为 L1，L0–L2 只是 `policy.json` 中 `unattended.maxLevel` 的取值：低于 L1 时定时任务不能开启或运行 |
| `write_file` 基于原内容哈希的并发检查 | 未实现 |
| 自动批准规则 | 未实现；`unattended.allowAutoApproveRules` 与 `unattended.approvalTtlHours.acp` 只保存。无人值守运行检查 `unattended.maxLevel` 与 `pauseAfterIdleDays`，在每个审批处停下，超过 `approvalTtlHours.standard` 后取消 |
| 在其他设备上对会话文件做本机动作（访达、快速查看、默认应用、编辑器） | 不提供：这些动作只在 `host.sock` 上进行 |
| Windows 上用默认应用打开 | 未实现；还没有核对 Windows 的文件关联 |
| 阻止 `policy.json` / `settings.json` 的带外修改 | 只检测并审计，不阻止 |
| 审计与操作在同一事务中提交 | 目前为「先审计再执行」的 JSONL；执行失败时尽力补记 `action.failed` |
| 降级导出 | 未实现；回退需要自行恢复升级前的备份 |
| 在手机、其他电脑或本机浏览器上添加文件夹（包括 Host 端的目录浏览） | 不提供：加入文件夹就是授予权限，只在 Host 所在电脑上进行 |
| 跟随移动或改名的文件夹，运行中会话的文件夹变化 | 未实现；Latch 不是 App Sandbox 构建，Electron 只为 Mac App Store 构建创建安全范围书签 |
| 按设备或文件夹的项目授权、只读文件夹、按文件夹的 Standard 风险级别 | 未实现；设备权限对所有项目生效 |
| 地址目录的入口、官方中继、可安装的手机 App 与推送通知 | 尚未提供；Host 直连与[自建中继](RELAY.md)已接入 |
| 一条消息在多个 Agent 之间依次回答 | 规则在 `apps/host/src/agent-relay.ts`，尚未接入任何路由 |

尚未在真机上验证：Host 进程遇到 macOS「隐私与安全性」（TCC）时的行为与提示、外接与网络卷上的「在访达中显示」、iCloud「桌面与文稿」文件夹的真实路径。

其他限制：外部 Harness 与 Standard 分别保存历史，会话不能在 Harness 之间迁移；运行中的任务不能迁移到其他电脑；会话详情没有分页或虚拟列表。

## 会话搜索与批处理

Host 通过 `catalog.features.search` 与 `sessionBatch` 声明支持。

**搜索。** `POST /link/api/search` 接收正文 `{ q, limit? }`，需要 `view`；查询不写入 URL、日志或磁盘索引。

- 只检索用户和助手正文，包含已归档会话，不检索工具参数、工具输出或 reasoning。
- 结果最多 30 条：原会话和消息 ID、160 字符片段与匹配范围。预算一秒，超时或结果未穷尽时返回 `truncated`。
- 空闲会话以更新时间缓存，运行与等待中的会话每次重新读取；缓存最多 500 个会话、1000 万字符。删除或当前不可见的会话不从缓存返回。

**批处理。** `POST /link/api/tasks/batch` 接收 `{ action: 'archive' | 'unarchive' | 'delete', ids }`，需要 `run`，最多 100 个 ID。Host 去重并逐项返回成功或错误；删除与归档沿用单个会话的检查（含终端，见 [TERMINAL.md](./TERMINAL.md)）。每次异步等待之后重新检查设备授权，部分失败不回滚已完成项。删除记录不删除项目文件。

## 桌面通知

通知由桌面端主进程自己读取已认证的快照后发出，页面不提交标题或正文；偏好、首次选择与其他电脑的通知见 [NOTIFICATIONS.md](./NOTIFICATIONS.md)。

桌面端自身的更新由主进程完成，安装前经 `host.sock` 进入 Host 的安装窗口：窗口期间新会话与新的一轮返回 409 `host-updating`，已有工作照常结算。见 [UPDATES.md](./UPDATES.md)。

## 提示模板

提示模板保存在数据目录的 `prompt-templates.json`（`PromptTemplateStore`）：写盘成功后才更新内存。最多 200 条，名称 80 字符、内容 2 万字符，适用范围是所有会话、某个项目或某个 Agent。Host 声明 `features.promptTemplates`，并以 `promptTemplatesVersion` 通知客户端重新读取。

- `GET /link/api/prompts` 需要 `view`；`PUT`、`DELETE /prompts/:id` 需要 `admin`，写入前再次检查设备授权。
- 稳定 ID 的 PUT 是完整替换，同一内容重试不新增记录；重复 DELETE 也成功，所以写超时可复用原 ID 与请求体。
- 模板不修改权限、不执行工具、不自动发送；选择后只替换输入框里的词项，发送仍走正常的权限流程。

## 会话分叉

`catalog.features.fork` 表示 `POST /tasks` 接受 `forkOf: { taskId, upToMessageId }`。同一个 Host 也接受 `editOf: { taskId }`（「从这里编辑」一个会话的第一条）：没有种子，Host 读来源，来源私有时新会话私有，来源从外部内容开始时新会话带 `outsideStart`；需要 `view` 与 `run`，与 `forkOf` 不能同时用。

- 请求需 `run`，且要有 `view` 才能读取来源；Host 在启动前再次核对权限并生成种子，客户端不提交历史。
- 只允许从已结束的轮次分叉，后续轮次和隐藏推理不进入种子；分叉点之前清空过上下文时，种子从最后一次清空开始。
- 文本保留最后 20 万 UTF-16 字符，截断时说明，不拆开代理对。来源名称取不可变的首条输入。
- 项目和 Harness 可重新选择，L3 照常写新会话的启动审计。启动目录内 Host 已知的会话文件夹在分叉时复用；文件不复制或回滚。
- 来源、位置、轮次与种子长度写入 `sessions-meta.json`，由 Hub 投影到 `TaskSummary.forkOf`；第三方 Driver 的来源声明不作为 Host 元数据。

**旁支提问（`/btw`）。** 客户端用同一个 `POST /tasks` 开一个只对话的分叉：同一个 Harness 与模型服务，分叉点是最后一轮已结束的回复，不排进也不打断正在运行的一轮，来源会话的历史不变。插入或关闭面板后分叉被归档，回答还在运行时先取消再归档。Harness 没有只对话方式或 Host 没有 `features.fork` 时不提供。

**原生分叉。** Driver 声明 `capabilities.fork: 'native'`（pi 与 Codex）时，分叉到同一个 Harness 的会话另外收到 `CreateTaskInput.fork: { taskId, upToMessageId, prefixLength }`。Driver 让 Harness 分叉它自己的记录，成功时第一轮不发种子，首条用户消息带 `nativeFork`；做不到时照常发送种子并在会话里写明原因。来源必须是同一 Driver 的会话与同一个工作目录，由 Driver 核对。见 [HARNESSES.md](HARNESSES.md#pi-的-rpc-模式) 与 [Codex 的 app-server](HARNESSES.md#codex-的-app-server)。

**从这里编辑**是从被编辑那一条之前分叉（第一条没有之前，开同一项目、同一 Harness 的新会话），可选先把文件退回到那一条之前（[CHANGES.md](CHANGES.md#退回到某一条之前)）。机制见 [STREAMING.md](STREAMING.md#从这里编辑)。

## 排队输入

`catalog.features.queue` 表示 `POST /tasks/:id/prompt` 接受 `queue: true`：运行中返回 202 `{ queued: { id } }`，空闲且没有队列时立即发送。

- **上限。** 每会话 5 项，每项 16,000 字符，Host 共 1000 项可见内容；设备绑定的回执每设备 10000 项、Host 共 100000 项，满时拒绝新增。附件与文件引用不能排队。
- **修改。** `PATCH /tasks/:id/queue/:itemId { text }` 修改内容并更换实际派发的 requestId，原提交回执不变；`DELETE` 移除；`POST …/send` 显式继续首项。任何仍有 `run` 的设备都可移除，审计失败也放行。
- **继续的条件。** 只有 Driver 明确报告 `runOutcome` 为 `completed`、runId 匹配且没有审批才继续；只报告 idle 不算完成。失败、停止、未知结束或 Host 重启都暂停。停止在交给 Driver 之前就暂停队列。
- **派发前复查。** 原设备仍有效、有 `run`、数据范围未变，以及会话、项目、Harness 指纹与模型；手动继续还复查当前设备。权限变化使该项 `dropped` 并暂停后续项。
- **审计与未知。** 排队和派发先审计，只写会话与队列 ID。派发前落盘 `sending`；结果未知时保留派发标识，公开为 `parked`，不能编辑；重启时 `sending` 同样按未知处理，人工重试由 Driver 的回执去重。
- **存储。** `queues.json` 是 0600 的 strict 文件，保留原设备、入口、数据范围、模型与两种请求标识；已发送或移除的回执不保留正文。删除会话清除其队列与回执。
- 原生连接排队的项在正文窗口失效后保留为暂停项，不自动绑定新窗口。

## Agent 提问

内置 `user-questions:ask_user` 是 Host 明确列出的 R0 工具；第三方同名工具仍为 R2。

- **存储。** `questions.json` 是 0600 的 strict 文件，最多 128 个活跃问题、100000 条记录。题目与选项只在受保护的 `TaskDetail.questions` 返回；快照列表只带 Host 派生的 `pendingQuestions` 数量，不信任插件声明。
- **回答。** `POST /tasks/:id/questions/:questionId/answer` 接受 `{ requestId, answers: [{ questionId, optionIds, other? }] }`，需要 `run`，并复查设备、数据范围、会话权限与项目。每题必答。首份回答绑定设备、请求标识和内容哈希：同一提交可重试，其他提交冲突。审计只写会话与问题 ID。
- **结算。** 先持久化 `answering` 再交给工具；Standard 持久化对应的工具结果后 Host 才返回 `answered`。取消或关闭结束待答题，重启不重新提问；只有会话里确有相同的已完成工具输出时，才把中途的回答恢复为已确认回执。
- **保留。** 终态只保留标识与哈希，正文留在会话历史中；删除会话清除相关记录。等待输入沿用 `waiting-approval` 状态，工作计时排除等待。
- **客户端。** 同一问题的各张卡片共用一份回答草稿与原请求编号；提交前先把编号与答案存到本设备，写不进存储时不发送，失败后重试不生成新回答。

## 附件内容

附件的私有存储、上传路由、设备草稿租约与内容句柄见 [ATTACHMENTS.md](ATTACHMENTS.md)；会话只保存 metadata 引用，附件目录从不加入项目根。运行期间文件变化的观察见 [FILE-OUTPUTS.md](FILE-OUTPUTS.md)。

## Agent 领域

我的 Agent 与「通用」见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md)，定时任务见 [AUTOMATIONS.md](AUTOMATIONS.md)，交接见 [HANDOFFS.md](HANDOFFS.md)。

`apps/host/src/agent-relay.ts` 的规则（尚未接入路由）：第一个回答之后最多转交 3 次，Agent 写的内容不能增加次数；一轮没有完成就不再交给下一个；任何一个 Agent 的说明、Harness、模式、模型或插件代码与收下消息时不同，下一个不开始；停止要等正在运行的那一轮真实结算后才确认。

## 会话配置修改回执

`catalog.features.configReceipts` 表示 Host 支持配置修改的设备绑定回执。客户端为一次不可变的 `{ configId, value }` 保留原 `requestId`，超时后只查询 `GET /tasks/:id/config-requests/:requestId`；不带 `requestId` 的修改没有回执。

**状态。** `pending`、`applied`、`failed` 或 `unknown`；其他设备和没有回执的编号只看到 `unknown`。查询仍检查原设备、会话可见范围与手机的正文窗口，不返回配置的值。

- 调用 Agent 前先原子保存 `pending`，保存失败绝不调用。
- 修改返回后读回的实际选项与目标值一致、且终态回执已落盘才是 `applied`。
- Agent 请求超时、断线或终态写入无法确认时保留 `unknown`。重启把未完成的 `pending` 视为 `unknown`，不因配置看起来相同就假定原调用成功。
- 明确的本地无效选项，以及 Driver 用 `details.configOutcome` 标明确定没改的拒绝，记 `failed`。
- 重复相同请求只读回执或合并当前执行；相同编号的不同内容返回冲突。

**核对。** `unknown` 只由核对结算：`POST /tasks/:id/config-requests/:requestId/check { configId, value }`（`features.configCheck`，要 `run`，只认原设备与相同内容）让 Driver 在会话空闲时从 Agent 读取这一项（`Bridge.readConfig`）。核对从不发送修改。

- Driver 说是所选值记 `applied`；会话空闲且读到修改之前的值（回执另存它的哈希 `priorHash`）记 `failed`。
- 读到第三个值、忙或读不到保持 `unknown`，并回答原因（`running`、`subagents`、`neither`、`unread`）。
- 结算时写审计 `task.config.checked`（字段与目标值的哈希、结果，`refSeq` 指向这次修改自己的审计条目）。

**存储与上限。** Host 在 `sessions-meta.json` 保存设备、编号、请求体 SHA-256、时间与状态，不保存配置的值或字段名。

- 配置回执随会话存续，不参与审批与取消回执的七天淘汰。每设备最多 10000 条、Host 共 100000 条，满时拒绝新增（409 `config-receipt-limit`），不通过淘汰未决身份来重执行。
- 读不懂的配置回执让 Host 以 `config-corrupt` 拒绝启动，不略过。
- 准备中的请求全局最多 256 条、每设备 32 条；同一执行最多 32 个合并等待者、全局 256 个。

**规则。**

- `SessionConfigOption.source: launch` 表示 Host 已按选择启动进程，不是 Agent 有效值的独立报告；没有读回接口的选项核对保持 `unread`，不由本地保存值结清未知结果。
- 进程级换档与核对共用互斥范围：启动或恢复前再查设备授权，运行中或仍有子 Agent 时拒绝重启。
- 回执只能确认已经发生的结果，不能授予一次新修改。审计只保存会话 ID 和字段、目标值的哈希。
