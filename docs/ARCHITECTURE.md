---
description: Host 与客户端的整体架构：代码地图与 workspace 项目、运行环境、Host 进程与数据目录、会话级别、路径与项目目录、Harness 路由、持久化与 HTTP API。
sources:
  - apps/host/src
  - apps/host/scripts
  - apps/desktop/src
  - apps/web/src/core
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

Latch 由一个 Host 与任意数量的客户端组成。Host 持有会话状态、执行权限、密钥与设备登记；Electron 窗口、浏览器和手机浏览器通过 HTTP 与 SSE 连接 Host。工具始终在 Host 所在的电脑上执行。信任在连接设备时建立一次：之后手机与其他设备只受自己的设备权限（scope）限制，和这台 Mac 一样可以查看、在任何 Harness 上发起会话、输入、放宽模式、批准（包括高风险操作与完全访问会话的询问）、拒绝和取消，都不弹确认；完全访问会话的开始、放宽模式与批准写入审计。需要在执行端电脑上用 Latch 桌面端处理并经本机确认（Touch ID 或登录密码）的只有：连接新设备与扩大设备权限、确认新的模型服务地址或出站地址、应用含代码的插件（例外见「安全模型概览」）。模型服务密钥只在桌面端填写；预置服务商的 HTTPS 地址与已确认过的地址不需要确认，密钥直接保存。

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

## 代码地图

| 层 | 职责 | 源码 |
| --- | --- | --- |
| 客户端 | 会话、选择器、消息、审批、设置、设备登记与本机确认对话框；断线后重新同步 | `apps/web/src`（入口 `App.tsx` → `shell/AppShell.tsx`；与 Host 通信、同步与阅读位置等无布局的核心在 `core/`） |
| 桌面端 | Electron 主进程：`latch://app/` 协议、经 `host.sock` 转发并附加凭据、设备密钥与凭据、渲染进程限制、经系统文件管理器添加项目与在访达中显示、文件快速查看与默认应用打开、「在浏览器中打开」与另一台电脑的「复制链接」（主进程申请邀请，写成剪贴板上的隐藏项，10 分钟后仍在就清除；页面看不到链接）、「浏览器」标签的预览页（[PREVIEW-BROWSER.md](./PREVIEW-BROWSER.md)）、Host 的生命周期（崩溃后重启、忙时防睡、登录项、睡眠与停止报告）、其他电脑（见「桌面端与其他电脑」） | `apps/desktop/src`（`main.cjs`、`proxy.cjs`、`remote-proxy.cjs`、`computers.cjs`、`credentials.cjs`、`host.cjs`、`folders.cjs`、`lifecycle.cjs`、`files.cjs`、`browser.cjs`、`preload.cjs`） |
| Host | 监听入口（含 HTTPS 证书热加载）、HTTP/SSE、运行状态通告、流量计数、访问规则、配置读写、插件挂载、密钥文件排除在时间机器之外 | `apps/host/src/server.ts`、`listeners.ts`、`lifecycle.ts`、`traffic.ts`、`access.ts`、`config.ts`、`providers.ts`、`backup.ts` |
| HTTP 路由模块 | 按领域分组的路由，各自带守卫与 `catalog.features` 标记；设备、登记与配对邀请在 `devices.ts`，改动记录与撤销在 `changes.ts`（[CHANGES.md](CHANGES.md)），交付的状态、暂存、历史、提交、推送与 PR 在 `git.ts`（[GIT-DELIVERY.md](GIT-DELIVERY.md)），原生连接（验证窗口、撤销通知、地址簿、配对二维码与手机接入的生命周期）与中继的启动在 `native.ts`（见「HTTP API」） | `apps/host/src/routes/`（`registry.ts`、`index.ts`） |
| 安全核心 | 设备与登记、本机确认、审计、安全策略、出站策略、模型网关、工具网关、路径与项目文件夹规则、风险分级、会话文件裁决 | `apps/host/src/auth.ts`、`presence.ts`、`presence-reason.ts`、`audit.ts`、`policy.ts`、`egress.ts`、`model-gateway.ts`、`model-gateway/`、`model-usage.ts`、`model-budgets.ts`、`tool-gateway.ts`、`paths.ts`、`projects.ts`、`session-folders.ts`、`worktrees.ts`、`risk.ts`、`identity.ts`、`crypto.ts`、`files/` |
| 共享安全文本 | 确认内容转义、设备名称规则、「这台电脑」的判定 `isLocalListener`（浏览器可用） | `packages/protocol/src/text.ts`、`listeners.ts` |
| 本机确认组件 | 核对确认内容，以 macOS 系统表单调用 Touch ID / 登录密码 | `native/macos/LatchPresence.swift`（`pnpm build:presence` 构建到 `dist/native/latch-presence`） |
| 进程发现 | `host.json`、数据目录锁、经 `host.sock` 核对 Host | `apps/host/src/host-state.ts` |
| 路由 | 多 Harness 合并列表、按会话路由、会话元数据与审批、取消的回执、权限级别、会话生命周期事件（见「Harness 与会话路由」） | `apps/host/src/hub.ts`、`session-meta.ts`、`session-lifecycle.ts` |
| 产品协议 | Bridge 接口与浏览器 DTO | `packages/sdk/src/bridge.ts`、`packages/protocol/src/types.ts` |
| 插件宿主 | Cordis 生命周期、能力冲突、租约、分阶段替换 | `packages/core/src/registry.ts` |
| 扩展接口 | Provider、Tool、插件、HarnessDriver、Transport、`AppError` | `packages/sdk/src/plugins.ts`、`harness.ts`、`transports.ts`、`errors.ts` |
| Standard | 模型循环、审批、取消、消息与幂等记录 | `packages/core/src/runtime.ts`、`store.ts` |
| Node 工具 | Host 与 Harness 共用：`canonicalJson` 与 `sha256Hex`、原子写入 `writeFileAtomic`、日志脱敏 `redactSecrets` | `packages/core/src/node-kit/` |
| 内置插件 | 每个插件一个目录 `<种类>/<id>/`：Chat Completions、Responses 与 Anthropic Messages 三种模型协议（共用 `providers/http.ts` 与插件工厂 `providers/service.ts`，协议编码、流解码、用量与模型列表在 `providers/{chat,responses,anthropic}-wire.ts`）、演示模型、项目文件、演示工具、Standard Driver | `apps/host/src/plugins/`：`providers/{openai-compatible,openai-responses,anthropic,demo}`、`tools/{workspace-files,safe-tools}`、`standard` |
| ACP Driver | 外部 Agent 的进程、协议、映射、权限配置、启动指纹与存储 | `packages/harness-acp/src`（会话在 `runtime.ts`，进程与协议在 `wires/`，权限配置在 `profiles/`） |
| 预设 | 浏览器可用的模型服务与 Agent 预设 | `packages/protocol/src/presets.ts`、`agent-presets.ts` |
| 命令行 | 启动、停止、设备管理、离线连接、密钥、本机确认组件、审计校验、流量计数 | `apps/host/scripts/start.ts`、`stop.ts`、`latch.ts` |
| 测试辅助 | 只供测试：Host 夹具、测试确认后端、共享安全向量、假 ACP Agent、测试证书 | `packages/testkit`；Host 的绑定在 `apps/host/test/helpers/host.ts`、`e2e/helpers/host.ts` 与 `apps/desktop/test/helpers/host.ts` |
| 测试 | 单元与集成用例跟随所测项目放在 `test/`；根项目的 `tests/`；端到端用例 | 各项目的 `test/`、`tests/`、`e2e/`（见 [TESTING.md](TESTING.md)「测试位置」） |
| 兼容入口 | `latch/plugin-sdk` 与 `latch/harness-sdk`，再导出 `@latch/sdk` 的类型子路径 | `src/plugin-sdk.ts`、`src/harness-sdk.ts` |
| 仓库工具 | 检查与按改动选择检查、依赖边界、Agent 说明与文档检查、候选文档、技能链接、安全扫描、供应链与工作流 | `scripts/`（见 [TESTING.md](TESTING.md)「仓库检查」） |
| Agent 说明与技能 | 根与各项目的 `AGENTS.md`（同目录的 `CLAUDE.md` 导入它）；技能只写在 `.agents/skills/`，`.claude/skills/` 是链接 | `AGENTS.md`、`apps/*/AGENTS.md`、`packages/*/AGENTS.md`、`e2e/AGENTS.md`、`.agents/skills/` |

Provider 负责模型协议转换；Tool 执行一种操作；HarnessDriver 提供完整的 Bridge，可以拥有自己的执行循环、存储与外部进程。

### Workspace 项目

仓库是 pnpm workspace（`pnpm-workspace.yaml` 的 `packages`）。根项目 `latch` 仍包含仓库脚本（`scripts/`）、插件 SDK 的兼容入口（`src/plugin-sdk.ts`、`src/harness-sdk.ts`）与 `tests/`（尚未带测试目录的包与仓库脚本的用例），另有三个应用、六个包与 e2e 项目：

- `apps/host` 是应用 `@latch/host`，即 Host 的组合根：监听入口与 HTTP/SSE、设备与本机确认、策略、审计、出站、路径、HarnessHub 与模型服务管理（`src/`）；内置插件，每个插件一个目录 `src/plugins/<种类>/<id>/`；启动、停止、`pnpm latch`、桌面启动器与构建脚本（`scripts/`，根 `package.json` 的同名脚本直接运行它们）。它依赖 `@latch/protocol`、`@latch/sdk`、`@latch/core` 与 `@latch/harness-acp`，测试另依赖 `@latch/testkit`。`exports` 列出其他项目可用的模块：`.`（`startServer`）、`./app-frame`（页面框的 CSP 与引导页）、`./paths`、`./host-state`、`./crypto`、`./auth`、`./plugins/standard` 与 `./desktop-host`，目前只有 `apps/web/vite.config.ts` 与测试使用。
- `apps/web` 是应用 `@latch/web`，即浏览器客户端：Host 在 `/link/` 提供的页面，桌面端窗口显示的也是它。`pnpm build:web`（`vite build apps/web`）把它构建到仓库根的 `dist/web`，Host 只从这里读取页面，所以旧 Host 也能提供新构建。`src/core/` 是无布局的客户端核心：与 Host 通信（`api.ts`、事件流、凭据续期、设备密钥、登记）、同步与版本门禁、阅读位置、安全文案与权限显示、本机确认流程、审批回执与审计回滚检查；其余是界面。运行时只依赖 `@latch/protocol`、`@latch/ui` 与界面库；插件页面框的固定引导页（入口 `src/app-frame/runtime.ts`）另带 `@latch/app-sdk`；`vite.config.ts`（经 `@latch/host/paths` 与 `host-state` 找到运行中的 Host）与测试另用 `@latch/host`、`@latch/core` 与 `@latch/testkit`，都是 devDependencies。
- `apps/desktop` 是应用 `@latch/desktop`，即 Electron 桌面壳（`src/*.cjs`，CommonJS，由 Electron 按路径加载：`pnpm desktop` 经 `apps/host/scripts/desktop.ts` 启动它）。它不能导入 TypeScript 源码，`host.cjs` 因此用 CommonJS 重写 `host-state.ts` 的核对；窗口图标取 `apps/web/public/icon.png`。测试另用 `@latch/host` 与 `@latch/testkit`（devDependencies）。
- `packages/harness-acp` 是包 `@latch/harness-acp`：ACP HarnessDriver，含每个预设的权限配置（`src/profiles/`）。它依赖 `@latch/protocol`、`@latch/sdk`、`@latch/core`（只用 node-kit）与 `zod`，只有 Host 依赖它，且只经入口 `src/index.ts`。

- `packages/protocol` 是包 `@latch/protocol`，放浏览器与 Host 共用的数据：浏览器 DTO（含插件列表 `PluginInfo`，以及只在 Host 使用的数据：保存在 `settings.json` 中的 Agent 定义 `AgentRecord`，本机确认的预览 `PresencePreview` 与确认后端的结果 `PresenceAvailability`、`PresenceOutcome`）、模型服务与 Agent 预设、安全文本规则。它没有依赖，模块没有副作用。
- `packages/ui` 是包 `@latch/ui`，即浏览器客户端的设计系统：设计令牌 `src/tokens.css`、样式层叠层的顺序与界面原语（React 组件与它们在 ui 层的样式），经 `@latch/ui/tokens.css`、`@latch/ui/ui.css` 与 `@latch/ui` 导入（见 [DESIGN.md](DESIGN.md)「设计令牌」与「界面原语」）。它在浏览器中运行，依赖 React 与 lucide-react，不使用其他 workspace 包，只有 `@latch/web` 使用它；它的用例在真实浏览器中运行。
- `packages/sdk` 是包 `@latch/sdk`，即插件作者面：插件、Provider、Tool、HarnessDriver 与 Bridge 接口，以及 `AppError`。它只依赖 `@latch/protocol`，除 `AppError` 外只有类型。
- `packages/core` 是包 `@latch/core`：Cordis 插件注册表、Standard 执行循环与它的快照存储。子路径 `@latch/core/node-kit` 放 Host 与 Harness 共用的 Node 工具：`canonicalJson`、`sha256Hex`、原子写入 `writeFileAtomic` 与 `syncDirectory`、日志脱敏 `redactSecrets`。它依赖 `@latch/protocol`、`@latch/sdk`、`cordis` 与 `zod`；node-kit 只用 Node 内置模块。
- `packages/testkit` 是包 `@latch/testkit`，只供测试：Host 夹具 `startHostFixture`、测试确认后端 `createTestPresence`、共享安全向量与测试设备密钥、假 ACP Agent、测试证书。它依赖 `@latch/protocol` 与 `undici`，不导入 Host：夹具经参数拿到启动 Host 的函数，`apps/host/test/helpers/host.ts` 与 `e2e/helpers/host.ts` 把它绑定到 `startServer`（用法见 [TESTING.md](TESTING.md)「测试辅助」）。类型与测试一起由 `tsconfig.tests.json` 检查。
- `e2e` 是项目 `@latch/e2e`，只含端到端用例：Vitest 内用 Playwright 驱动真实浏览器与 Electron，Host 在测试进程内启动（配置 `e2e/vitest.config.ts`，从仓库根运行）。它的依赖都是 devDependencies：`@latch/host`、`@latch/protocol`、`@latch/sdk`、`@latch/testkit` 与 `@playwright/test`；`apps/host/test/helpers/host.ts`、`apps/desktop/test/helpers/host.ts` 与它的 `e2e/helpers/host.ts` 是同一个 Host 绑定。

包只经 `package.json` 的 `exports` 导入，入口都指向源码（TypeScript；`@latch/ui/tokens.css` 与 `@latch/ui/ui.css` 是样式表）。各项目使用 `@latch/protocol`、`@latch/sdk`、`@latch/core` 与 `@latch/harness-acp`（各自的 `src/index.ts`）、`@latch/core/node-kit`，以及上面列出的 `@latch/host` 模块；另有只含类型的入口：`@latch/protocol/types`（`src/types.ts`，类型与常量）、`@latch/sdk/plugins` 与 `@latch/sdk/harness`。根包的 `latch/plugin-sdk` 与 `latch/harness-sdk` 是兼容入口，由 `src/plugin-sdk.ts`、`src/harness-sdk.ts` 再导出这两个 SDK 子路径，运行时入口是 `dist/core/plugins.js` 与 `dist/core/harness.js`。外部项目按自己的编译选项检查这些入口引到的源码，没有开启 `allowImportingTsExtensions` 时，只有仅导入类型的语句可以写 `.ts` 后缀，而 `@latch/protocol` 与 `@latch/sdk` 的 `src/index.ts` 都用 `export *` 再导出 `.ts` 文件，所以兼容入口与 SDK 的类型文件都不经包的 `src/index.ts`（`plugin-sdk.test.ts`）。

每个项目在 `package.json` 中用 `"latch": { "env": … }` 声明运行环境（`isomorphic`、`browser`、`node`、`electron-main`；仓库根不声明）。`scripts/boundaries.ts` 的 `PROJECTS` 列出每个项目的目录、运行环境与可用的 workspace 包，仓库根也有自己的一行（兼容入口、仓库脚本与 `tests/` 用到的 protocol、sdk 与 core，测试另经 `@latch/host` 使用 Standard Driver），没有项目例外；`pnpm check:boundaries` 据此检查：

- 每个 workspace 项目都在表中、位于表中的目录，声明的运行环境与表一致；表中的项目都在 workspace 中。
- 对 workspace 包的依赖都在表允许的范围内，写成 `workspace:*`，且被依赖的包能在该环境运行（浏览器与同构项目不能依赖 Node 项目）。devDependencies 只由项目的测试与工具（如 Vite 配置）加载，它们在 Node 中运行，所以也可以是 Node 项目；生产代码导入 devDependencies 时 `pnpm knip` 的 `--strict` 一遍失败。
- `@latch/` 下的名称只能是 workspace 项目，不会从 registry 安装同名包；仓库根不能被依赖。
- 表中标为只供测试的项目（`@latch/testkit`、`@latch/e2e`）只能写在 devDependencies，仓库根也不例外。
- iOS 的 `LatchScreens` 专用代码（截图场景与 Live 模式的软件密钥：`ScreensStage`、`PhoneLive`、`LiveSoftwareKeys`、`LiveIdentityProvider`、`LatchLive`）只出现在 `native/ios/Screens/` 或 `native/ios/App/` 的 `#if LATCH_SCREENS` 中，不进共享核心；`project.pbxproj` 中只有 LatchScreens（仅模拟器）构建 `Screens/` 并设置 `LATCH_SCREENS`。

`.oxlintrc.json` 的 `no-restricted-imports` 守住六条导入边界，`import/no-cycle` 不允许循环导入，二者违反时 `pnpm lint` 都失败（其他 lint 规则中，只有下一节的运行环境规则是错误，其余目前只报告）：

- workspace 项目只经包名导入，不经相对路径进入 `apps/`、`packages/` 或 `e2e/`。
- 只有 `packages/core/src/registry.ts` 与它的契约测试 `tests/registry.test.ts` 导入 `cordis`；其他代码经 `PluginRegistry` 使用插件，插件只拿到 `PluginContext`。升级 Cordis 因此只改注册表，并以契约测试为闸门。
- `packages/core/src/node-kit/` 只导入 `node:` 内置模块与本目录内的文件，所以导入 `@latch/core/node-kit` 不会加载注册表、Cordis 或其他包。
- `apps/web/src/core/` 只导入本目录的文件、`react` 与 `@latch/protocol`，不依赖组件、图标库或页面的其他部分。
- 只有测试（`tests/`、`e2e/` 与各项目的 `test/`）导入 `@latch/testkit` 与测试目录中的文件。
- 内置插件目录（`apps/host/src/plugins/<种类>/<id>/`）只导入 `@latch/sdk`、`@latch/protocol`、已安装的包、本目录的文件，以及同一种类共用、直接放在种类目录下的文件（如 `providers/http.ts`）；不导入 Host、其他插件目录、`@latch/core` 或 Harness 包，Host 经 `PluginContext` 与插件参数提供其余能力。种类目录下的共用文件也不导入本种类的插件目录。Standard 把 core 的执行循环包装成 Driver，是唯一可用 `@latch/core` 的插件目录。

`pnpm knip` 检查导入是否与声明一致：未声明（unlisted）与无法解析（unresolved）的导入是错误，其余发现（未用的导出、文件与依赖）目前只报告。Node 会沿目录向上在根 `node_modules` 中找到子项目没有声明的包，knip 默认模式也接受这种情况，所以第二遍以 `--strict` 只用每个项目自己的 `dependencies` 检查其生产代码。knip 只静态读取 `apps/web/vite.config.ts`，不执行它（执行时会读取默认数据目录）。

Host 构建把 workspace 包打进 bundle（它们导出 TypeScript 源码），根 `package.json` 声明的已安装依赖保持为外部导入，运行时从根 `node_modules` 解析，选项在 `apps/host/scripts/host-bundle.ts`，测试中打包 Host 入口时使用同一份选项。这份选项带一个 esbuild 插件：入口引到 `@latch/testkit`，或加载 `packages/testkit/`、`tests/`、`e2e/`、`apps/*/test/`、`packages/*/test/` 下的文件时构建失败。所以 workspace 项目运行时用到的已安装依赖（如 `@latch/core` 的 `cordis`、Host 的 `undici`）也由根项目声明；只由包声明的依赖会被打进 bundle。Vite 打包 `apps/web/vite.config.ts` 时则把 workspace 包留作外部导入，由 Node 只剥离类型后直接加载，所以 `tsconfig.isomorphic.json`、`tsconfig.sdk.json` 与 `tsconfig.core.json` 开启 `erasableSyntaxOnly`：包内不用 enum、namespace 与构造函数参数属性。`vite.config.ts` 经 `@latch/host/paths` 与 `@latch/host/host-state` 读取数据目录，这两个文件也这样加载，由 `tsconfig.strip.json` 对它们开启同一选项；Host 的其他文件不受此限。`latchCodeRoot()` 从模块所在目录向上找名为 `latch`（改名前的检出中为旧包名）的 `package.json`，越过各 workspace 项目自己的 `package.json`，始终得到仓库根。

macOS 目录组件 `latch-files` 构建到独立临时文件，签名并验证后，以自有空临时目录运行真实 JSON 输入/输出自检；只有精确返回空列表且未截断才原子替换旧产物，自检失败保留旧版本并清理本次临时文件。自检沿用构建验证的30秒上限，不改变运行时组件内部2秒与 Host 外层3秒的读取预算，也不保证分发到另一台电脑后的首次启动耗时。

### 插件与能力组合

插件是用户组合并启停功能的单位。Host 的本地加载器 `src/plugin-packages.ts` 把 `latch-plugin.json` 中的多个 Host 模块、技能与客户端入口合成一个插件；原 `.mjs` 插件继续兼容。一个包可以同时注册 Provider、Tool、HarnessDriver、技能、数据面板与 React 会话面板，Cordis fiber 仍是统一的生命周期拥有者。激活失败撤回整个包；运行租约固定旧代，替换提交后新请求使用新代。

应用内的自定义插件由 `plugin-assets.ts` 保存私有草稿、已应用快照、执行摘要批准与设备绑定的修改回执。有限 API 位于 `plugin-package-routes.ts`，只接受 `host.sock` 上拥有 `admin/all` 的已登记设备。纯技能与静态数据面板可直接应用；新执行内容经 `plugin.package.apply` 系统确认，L3 运行时拒绝确认，同一批准摘要重启后复用。等待后复查权限，应用使用注册表候选事务，停用/删除禁止新租约、保留旧租约到真实释放，审计故障不阻止收紧。资产导入不执行下载或依赖安装；预算、结果未知恢复与 Harness 启动失败的语义见 [PLUGIN-DEVELOPMENT.md](./PLUGIN-DEVELOPMENT.md#应用内的自定义插件资产)。

Standard 的运行租约包含技能的独立副本，正文在开始该轮的原子提交中写入 `StoredTask.skillContext`，技能 ID 写入摘要；每个步骤使用同一份正文。对话模式固定 Provider 与技能，不固定工具。自定义 Driver 可消费租约中的技能；ACP Agent 不自动接入 Host 技能。

`catalog.uiPanels` 与 `catalog.skills` 是可选发现字段，客户端缺少时不显示对应标签。数据面板只返回受限 JSON 文本块，访问前与回调结算后都核对设备查看权限。React 模块从经过查看权限认证的同源 `ui-modules/:panelId/:sha256.mjs` 加载，只提供当前启用内容，禁止缓存；摘要不是凭据。Host 不编译或求值浏览器源码，也不放宽 CSP。页面把模块挂在会话面板的错误边界中，切换、关闭与停用时卸载 React 树；模块必须在 effect 中登记并清理自己的资源。

Host 模块与 UI 模块都是用户显式加载的可信代码：分别拥有 Host 进程与当前页面的权限。挂载位置、上下文接口和错误边界都不构成安全隔离。客户端模块属于发给所有查看设备的内容，不能携带 Host 私密数据。当前客户端桥接只提供会话摘要、包内数据面板读取与生成草稿；真实会话写操作仍用原请求 ID、审批、取消与本机确认路径。字段、大小限制与作者接口见 [PLUGIN-DEVELOPMENT.md](./PLUGIN-DEVELOPMENT.md)。

## 运行环境

每个文件只按它实际运行的环境做类型检查。`pnpm typecheck` 运行 `tsc -b`，根 `tsconfig.json` 只引用以下配置：

| 环境 | 配置 | 代码 | 类型 |
| --- | --- | --- | --- |
| 同构 | `tsconfig.isomorphic.json` | `packages/protocol` | 只有 ES2023 标准库，没有 DOM，不加载 Node 类型 |
| 插件 SDK | `tsconfig.sdk.json` | `packages/sdk` | Node ES 模块，无 DOM；开启 `isolatedDeclarations`：导出须写明类型，声明文件可以逐个文件生成 |
| Core | `tsconfig.core.json` | `packages/core` | Node ES 模块，无 DOM |
| 浏览器 | `tsconfig.web.json` | `apps/web/src`、`packages/ui/src` | DOM，不加载 Node 类型 |
| Host | `tsconfig.host.json` | `apps/host/src`、`apps/host/scripts`、`packages/harness-acp/src`、`src/plugin-sdk.ts`、`src/harness-sdk.ts`、`scripts`、根目录的 `*.config.ts`、`apps/web/vite.config.ts` | Node ES 模块，无 DOM |
| 只剥离类型加载的 Host 模块 | `tsconfig.strip.json` | `apps/host/src/paths.ts`、`host-state.ts` | 同 Host，另开启 `erasableSyntaxOnly` |
| 桌面端 | `tsconfig.desktop.json` | `apps/desktop/src/*.cjs` | Electron 与 Node 的 CommonJS，用 `checkJs` 检查，无 DOM |
| 测试 | `tsconfig.tests.json` | `tests`、`e2e`（含它的 Vitest 配置）、`apps/host/test`、`apps/web/test`、`apps/desktop/test`、`packages/harness-acp/test`、`packages/ui/test`、`packages/testkit` | Node 与 DOM（testkit 返回的 fetch `Response` 按测试看到的类型检查） |

同构包在自己的环境中检查，使用 DOM 或 Node 的全局变量都会报错；浏览器与 Host 程序导入它时再各检查一次。部分依赖的类型声明（`@types/qrcode`、`undici-types`）会把 Node 的全局类型带进浏览器程序，类型检查因此拦不住浏览器代码使用 `process` 或 `Buffer`。`.oxlintrc.json` 补上这一层：`apps/web/src`、`packages/ui/src`、`packages/protocol` 不得使用 Node 全局变量与内置模块；ES 模块不得使用 `require`、`__dirname` 等 CommonJS 全局变量。这些规则与导入边界、循环导入一样是错误；其余 lint 规则目前只报告警告。esbuild 不跟随根配置的引用，所以 Host 构建显式使用 `tsconfig.host.json`。

## 安全模型概览

模型网关使用独立回环临时端口、每进程凭据与固定协议路径，密钥只在 Host 向已确认服务发出请求时注入；四协议透传、Responses/Anthropic→Chat 与 Responses↔Anthropic 转换、进程交付与用量见 [MODEL-GATEWAY.md](MODEL-GATEWAY.md)。服务模型与能力声明改变时旧租约失效，不能继续沿用已经不成立的能力。

Latch 的安全边界是「谁能让 Host 做什么」，不是对执行代码的隔离：

- **Host 是唯一权威。** 每个请求的身份只来自接受连接的监听入口与设备凭据。
- **设备各自持有密钥。** 每台设备在登记时生成自己的密钥，Host 只保存公钥与凭据哈希。登记需要在执行端电脑上确认（离线连接码除外）。
- **只有 `host.sock` 算这台电脑。** 回环端口也可能被转发到别处，所以回环与其他入口一样按远程处理。
- **能力按设备分级。** 设备权限（scope）决定能调用哪些接口，这是唯一的限制；监听入口决定能否扩大权限；会话级别（L1 / L3）说明 Latch 是否逐项把关。信任在连接设备时建立一次，之后手机和这台 Mac 一样工作。
- **本机确认只留给真实边界，只在这台 Mac 上发起。** 连接新设备、扩大设备权限、确认新的模型服务地址或出站地址、应用含代码的插件、新增或放宽本机程序与远程 MCP 服务器（MCP 服务器的命令、参数、变量名与工作目录，或远程地址的源、路径与请求头名字，以及它登录用的授权服务器与范围，`mcp.server.apply`，远程地址与授权服务器需要的出站许可在同一次确认里；Harness 定义的命令、参数与变量，`harness.command.apply`，见 [MCP.md](./MCP.md) 与 [HARNESSES.md](./HARNESSES.md)）。只有经 `host.sock` 认证的已登记设备（桌面端）能发起；设备登记是唯一例外，而 `host.sock` 以外的登记还要先有一次性邀请，从未有过设备时桌面端在 `host.sock` 上的第一次连接不需要确认。开始 Agent、放宽模式、批准操作、改 Harness 的名称与开关不弹确认：Agent 是没有沙箱的可信代码，审批是人选择的看管程度。
- **先审计再执行。** 授予或执行权限的操作先写入审计记录，写入失败则拒绝执行；降低权限的操作从不因审计失败而受阻。

### 文件差异的数据范围

普通会话仍按原有 `view`、`run` 和审批权限工作。`dataScope: 'work'` 的设备读取 HTTP 详情、历史、审批快照与 SSE（包括原生重放）时，Host 省略文件差异正文及文件编辑参数中的内容，只保留动作、路径、明确的结果元数据和结算事实；`all` 保留完整内容。投影在最后一次当前设备核对之后、增量编码之前执行，不改变 Driver 的历史、真正的审批参数、模型输入与请求回执。快照异步读取期间数据范围发生变化，返回 `device-scope-changed` 要求重新读取，不能把旧权限下组装的数据与新权限混在一份快照里。协议与旧历史规则见 [STREAMING](STREAMING.md#文件差异的设备投影)。

这不是对会话文字的信息流隔离：用户/助手正文、普通命令输出与 MCP 结果不凭文本猜测删除；可信本机 Agent 仍能在这些渠道转述内容，原有会话文件引用规则也不改变。

### 不防御的情况

Latch 不隔离执行的代码：插件、ACP Agent 与第三方 Harness 是可信本机代码，没有操作系统沙箱，它们自己的网络访问不受出站策略约束。同一系统用户的进程可以连接 Host、访问数据目录并改写审计记录，哈希链只能让篡改被发现。邀请链接被他人看到时，对方可以在有效期内抢先使用。回环浏览器的凭据会随请求发往同一主机名上其他端口的服务。

## Host 进程与数据目录

### host.json 与数据目录锁

`pnpm start`（包括桌面启动器启动的 Host）在 Host 启动完成后写入 `<数据目录>/host.json`（版本 2，0600，原子写入），记录 PID、hostId、实例 ID、`host.sock` 路径、回环与 HTTPS 地址、启动时间与数据目录，不含任何凭据；退出时只在它仍记录本实例时删除。`pnpm stop`、`pnpm latch`、桌面启动器与 Electron 主进程都先通过 `host.sock` 读取 `host-info` 核对 PID、hostId 与实例 ID，从不通过 HTTP 探测。

`<数据目录>/host.lock`（0600）让取锁的进程之间同一时间只有一个持有者。记录持有者的 PID、实例 ID、角色（`host` 或 `cli`）与开机时间。

- **持有者。** `pnpm start` 在读取数据目录之前取得它，持有到退出；`device enroll --offline`、`provider set-key`、`presence repin`，以及 Host 未运行时的 `presence status` 与 `presence test` 在执行期间持有它（`provider set-key` 在输入密钥期间也不释放）。进程内直接调用 `startServer` 的测试与上一版本的 Host 不取锁。
- **创建。** 记录先写入并 fsync 到 `.host-lock-<随机 ID>.new`，再用硬链接放到 `host.lock`；目标已存在时链接失败，所以锁文件出现时已是完整记录。不支持硬链接的文件系统改用 `O_EXCL|O_NOFOLLOW` 原地写入，读到空文件时先当作正在写入并重读。
- **有效与过期。** 持有进程存活（`EPERM` 也算存活）且锁写于本次开机（macOS 读 `kern.boottime`，Linux 读 `/proc/stat` 的 `btime`，其他系统用当前时间减运行时长，允许 30 秒误差）时锁有效，第二个 `pnpm start` 与离线命令返回 409 `data-dir-locked`，即使 Host 还在启动、尚未写出 `host.json`。进程已退出或锁写于上次开机之前时，锁会被自动接管。无法读取的锁（内容损坏、不是普通文件或是符号链接）不会被猜测或删除（409 `data-dir-lock-invalid`）。拒绝信息都写出锁文件路径与恢复方法。
- **接管。** 同一时间只有一个接管者：接管者把只含自己标记文件的临时目录整体改名为 `<数据目录>/.host-lock-takeover`（目标非空时改名失败），再重新判断锁仍已过期、自己的标记仍在且开始不到 10 秒，然后把旧锁移开、核对内容并创建新锁，最后删除标记与目录。所属进程已退出或超过 30 秒的标记视为残留，按文件名删除；取得锁的进程顺带删除超过 30 秒的 `.host-lock-*` 临时条目。
- **没有锁的 Host。** 仍通过 `host.json` 识别：本版本的格式以 `host.sock` 核对；上一版本的格式只看其中记录的 PID，PID 存活或文件读不出 PID 时，`pnpm start` 与离线命令都拒绝。
- **`pnpm stop`。** 只在通过 `host.sock` 核对身份后发送 SIGTERM，从不凭 `host.lock` 或无法识别的 `host.json` 发送信号。锁由启动中的 Host 持有、锁无法读取、`host.json` 读不出 PID、上一版本的 Host 仍在运行，或无法通过 `host.sock` 核对时，它说明原因并以状态 1 退出；有运行中或待审批的会话时需要 `--force`。等待 10 秒仍未退出时只报告，不强制终止。
- **局限。** 这是同用户进程之间的协作锁，不能阻止同用户进程直接改写数据目录。

### Host 的生命周期

首次准备状态作为无密钥字段保存在 Host 的 0600 `settings.json`。新建且没有既有配置的真实 Host 在第一次启动时写为 `pending`，持久写入失败时启动明确报未确认。已启动过或已有配置的安装沿用工作台。`firstSetup` 只出现在当前经 `host.sock` 的本机登记设备快照中，且设备须有 `admin` 与 `run`。准备页成功配置的项目、默认选择、模型服务各走平常的保存流程。`PUT /first-setup` 经真实就绪核对把状态记为 `completed`，或把暂缓记为 `deferred`。重试保留原请求号，完成状态不会被另一页的暂缓覆盖。

准备页用 `PUT /preferences` 的 `setupRequestId` 持久化原请求摘要，同一请求不能覆盖更新的设置。设置目录同步前，`GET /first-setup/choices/:requestId` 返回未知，快照继续投影上次确定的准备状态。用原请求重试会同步同一设置文件的最新内容，也可由该文件后续成功的写入确认。不会重放旧选择。本机 `POST /providers` 带 `requestId` 时在同一 `providers.json` 提交配置及回执。回执与设备、配置摘要和实际保存的服务摘要绑定，已变更或移除的服务得到冲突。若已替换文件而目录同步或注册未结算，`GET /providers/additions/:requestId` 仍返回未知。用户核对时以空请求体 `POST` 同一路径，或重试原新增请求。Host 在原授权范围内同步目录并恢复注册，复核当下设备与出站许可，不重新授予地址权限。达到模型目录可用状态才给完成回执。选择与新增服务的回执上限分别是 128 和 512 项。达到上限时拒绝带新请求号的操作，保留已接受的请求供核对，其他常规设置入口仍可继续使用。客户端可以保存用于核对的非秘密请求号，模型密钥留在表单的短期内存中。首次准备的写入只落到 Latch 的 Host 配置，不改写命令行工具本身的设置或登录文件。

Host 自己负责宣布运行状态与重新加载证书；在 macOS 上让它常驻、重启和保持唤醒的是桌面端主进程（`apps/desktop/src/lifecycle.cjs`），因为登录项、电源断言与系统睡眠通知都只在 Electron 中可用。

- **运行状态通告。** Host 在事件流上发送 `host-state`（帧的形状见 [STREAMING.md](./STREAMING.md)「Host 的状态流」，客户端的处理见同文「Host 宣布的停止与睡眠」）：`sleeping`（原因 `sleep`）与 `awake` 在收到报告时立即发出；`stopping` 在 Host 关闭时作为每条流的最后一帧发出，原因是此前 60 秒内报告的 `restart`、`update` 或 `shutdown`，没有报告时为 `shutdown`。`retryAfter`（秒）默认 `restart` 2、`update` 10、`sleep` 10、`shutdown` 15，报告可以给出 1–3600 之间的值。报告用 `POST /link/api/host/state`（`{ state: 'stopping', reason, retryAfter? }`、`{ state: 'sleeping' }` 或 `{ state: 'awake' }`；桌面端另报 `{ state: 'desktop', keepAwake }`，见 [AUTOMATIONS.md](AUTOMATIONS.md#到点前后保持唤醒)；这些报告不带设备凭据，与睡眠和停止的报告同一信任级别，只用于通告与展示），只在 `host.sock` 上接受（匿名或已登记设备均可），其他入口返回 404；桌面端页面经主进程转发的这类请求由主进程返回 403 `shell-managed`。`awake` 之后 Host 另发一次 `refresh`。
- **谁报告。** 桌面端主进程在 `powerMonitor` 的 `suspend` 时报告 `sleeping`，在 `resume` 时报告 `awake`。macOS 宣布注销、重启或关机（`powerMonitor` 的 `shutdown`，即 `NSWorkspaceWillPowerOffNotification`）时，主进程只报告原因 `shutdown`（60 秒后失效），不停止 Host，因为注销还可能被其他应用取消；随后 macOS 要求桌面端退出时（30 秒内的 `before-quit`），主进程推迟退出，在网络仍可用时停止 Host（核对后发送 SIGTERM，最多等 3 秒），再退出。被取消的注销如果在轮到 Latch 之前取消，Host 与桌面端都照常运行；如果 Latch 已经退出，它与其他已退出的应用一样不会回来，Host 停止，手机显示「电脑上的 Latch 已停止」，直到再次打开 Latch。`pnpm stop -- --reason restart|update|shutdown` 在发送 SIGTERM 之前报告原因。所有者退出桌面端本身（⌘Q）不停止 Host，所以不宣布。合上盖子（没有外接显示器）时 Mac 一定会睡眠，通告是尽力而为：睡眠前的最后一帧不一定能送达。
- **启动记录。** 桌面启动器（`pnpm desktop`）启动 Host 后写入 `<数据目录>/desktop-launch.json`（0600，原子写入）：版本、Host 的 PID 与 hostId，以及启动方式 `launch`（Node 可执行文件、额外的 Node 参数、启动脚本、参数与工作目录）。环境中有数据目录以外的 Host 设置（`HOST_ENV_NAMES` 列出的模型、密钥、HTTPS、端口、路径，即 `LATCH_*` 变量）时 `launch` 为 null，因为桌面端在没有这些变量的环境中运行，无法按原样启动。写入失败（磁盘已满、权限）时启动器照常返回已启动的 Host，并提示它意外退出后不会被自动重启。主进程严格解析它，不符合的内容一律视为没有记录。工作区工具把它与临时文件 `.desktop-launch-*` 当作数据目录的私有条目。
- **崩溃后重启。** 主进程每 5 秒读一次 `host.json` 并经 `host.sock` 核对 Host。有序停止会删除 `host.json`，所以 `host.json` 仍记录一个已退出的进程就是崩溃。只有 PID 与 hostId 都和启动记录一致、且 `launch` 不为 null 的 Host 会被重新启动：等待 1、2、4、8……秒（最长 30 秒），脱离主进程启动，输出追加到 `host.log`；60 秒内没有经 `host.sock` 核对通过、或启动后立即退出，都算一次崩溃。10 分钟内第 5 次崩溃时停止自动重启，日志与设置页说明原因，由所有者用「启动 Host」再试。重新启动后主进程把新 PID 写回启动记录。不是由桌面端启动的 Host（PID 不符）、或设置来自环境变量的 Host 崩溃时只报告，不重启。进程还在、但连续 3 次检查都无法经 `host.sock` 核对的 Host（卡住，或 PID 已被其他进程占用）显示为「没有响应」，不再算作运行中，也不再让电脑保持唤醒；主进程不停止它，因为它可能只是忙。所有者也可以在设置中「重新启动 Host」：仅限启动记录中的 Host，且没有运行中或等待审批的会话；主进程先报告 `restart`，核对后发送 SIGTERM（进程恰在此前退出时视为已停止），等它退出（最多 10 秒）再启动。桌面端启动时没有运行中的 Host 而启动记录可用，主进程按记录启动一次（最多等 60 秒，期间没有窗口）；这次失败时显示错误页并且不再重试，成功时由同一个监督者继续照看它。
- **忙时保持唤醒。** 主进程每 5 秒从 `host-info` 读取运行中与等待审批的会话数。接电源时，有会话运行或有审批等待就持有 Electron 的 `powerSaveBlocker('prevent-app-suspension')`（阻止系统空闲睡眠，显示器照常熄灭，不修改系统电源设置）；用电池时只在有会话运行时持有，每次最长 1 小时，到时释放，直到没有会话运行或重新接上电源才重新计时。Host 未运行或没有响应时释放。所有者可以在「设置 › 通用」关闭它（保存在桌面端数据目录的 0600 `lifecycle.json`），当前状态显示在设置页与侧栏的连接状态旁。Agent 的「到点前后保持唤醒」与这个开关无关，按 `host-info` 的 `scheduleWake` 在定时任务前后持有同一个阻止（[AUTOMATIONS.md](AUTOMATIONS.md#到点前后保持唤醒)）。
- **没有窗口时。** 在 macOS 上关闭最后一个窗口不退出桌面端（Mac 应用的惯例），崩溃后重启与忙时保持唤醒照常进行；点 Dock 图标重新打开窗口，退出（⌘Q 或 Dock 菜单）才结束桌面端，这两项随之停止，Host 继续运行。错误页（桌面端未就绪时）与其他系统上，关闭最后一个窗口即退出。
- **登录项。** 「登录时打开 Latch」经 `app.setLoginItemSettings` 登记 macOS 登录项（`SMAppService` 登记正在运行的 app 包）。开发运行时运行的是 Electron 自己的 app 包，登记它会在登录时打开 Electron 而不是 Latch，所以只有打包后的 Latch.app 提供这个开关；开发运行时主进程报告它不可用，设置页不显示这一行（打包构建尚未实现，见「尚未实现」）。macOS 要求用户批准时，设置页提示去「系统设置 › 通用 › 登录项」。由登录项打开时主进程不弹出窗口，点 Dock 图标再打开。
- **时间机器。** Host 每次启动时把 `auth/`（设备登记、撤销日志、离线连接码哈希）、`identity/`（Host 身份私钥）、`providers.json`（模型密钥）、`settings.json` 与旧版 `provider.json` 排除在时间机器备份之外；`providers.json` 与 `settings.json` 每次写入的新文件在替换旧文件之前就已排除。`settings.json` 整个不备份，因为 Agent 定义的环境变量值常是 API Key：把这些值拆到另一个文件，会让一次 Agent 定义的保存有两个提交点，而启动指纹覆盖这些值；代价是默认值、插件停用列表、项目列表与 Agent 定义也不随备份恢复。桌面端主进程启动时排除自己数据目录中的 `latch-devices/`（凭据用这台 Mac 钥匙串中的密钥加密，备份副本没有用处）。做法是 `tmutil addexclusion`（不带 `-p`，不需要管理员权限）写入的同一个扩展属性 `com.apple.metadata:com_apple_backup_excludeItem`（值为包含字符串 `com.apple.backupd` 的二进制属性列表，与 tmutil 写入的逐字节相同），由 `/usr/bin/xattr` 以固定参数写入，因为 `tmutil addexclusion` 要等备份守护进程应答，可能阻塞十秒以上。已带该属性的条目只读取不改写；不存在的路径跳过；从不读取文件内容；失败只记入日志，不影响启动。照常进入备份的是会话（`sessions/`、`sessions-meta.json`、`harnesses/`）、审计 `audit/`、`policy.json`、`host.log` 等其余条目；「设置 › 通用」在桌面端提示这一点，建议加密备份盘。

## 会话级别与审批风险

| Harness | 级别 | 谁把关 | 其他设备 |
| --- | --- | --- | --- |
| `standard` | L1：逐项询问 | Latch：Host 对每个工具调用分级 | 与这台 Mac 相同，只看设备权限：`run` 发起与输入，`approve:standard` 批准 R1，`approve:elevated` 批准 R2，`view` 拒绝与取消 |
| ACP Agent、插件 Harness | L3：完全访问 | 无：Agent 自己的询问只是提示 | 与这台 Mac 相同，只看设备权限：`run` 发起、输入、放宽模式与允许询问，`view` 拒绝与取消 |

Standard 工具调用的风险等级（R0、R1、R2）见 [PLUGIN-DEVELOPMENT.md](./PLUGIN-DEVELOPMENT.md#风险分级与审批)。

## 路径与项目目录

| 路径 | 解析顺序 |
| --- | --- |
| 数据目录 | `--data-dir` → `LATCH_DATA_DIR` → 当前目录下已存在的 `.runtime`（打印迁移提示）→ macOS `~/Library/Application Support/Latch/Host`，Linux `${XDG_DATA_HOME:-~/.local/share}/latch/host`，Windows `%APPDATA%\Latch\Host` |
| 启动目录 | `--workspace` → `LATCH_WORKSPACE` → 数据目录内已存在的 `workspace`（打印提示；与 Latch 程序目录重叠时跳过并提示）→ `~/Latch/workspace` |
| 工作树目录 | `LATCH_WORKTREES_DIR` → 启动目录旁边的 `worktrees`（默认 `~/Latch/worktrees`；用到时以 0700 创建，见 [BRANCHES.md](BRANCHES.md#新建工作树)） |
| Agent 安装目录 | `LATCH_AGENTS_DIR` → macOS `~/Library/Application Support/Latch/Agents`，Linux `${XDG_DATA_HOME:-~/.local/share}/latch/agents`，Windows `%APPDATA%\Latch\Agents`（目前只用于重叠检查，不会创建） |

数据目录必须是当前用户拥有的目录（不是符号链接），否则拒绝启动（500 `data-dir-insecure`）；权限会收紧到 0700。启动目录不存在时以 0700 创建。Host 从不自己选一个位于 Latch 程序目录内的启动目录：旧布局的 `<数据目录>/workspace` 与程序目录重叠时（例如数据目录是仓库里的 `.runtime/`），改用 `~/Latch/workspace`，原目录中的文件不移动；`--workspace` 与 `LATCH_WORKSPACE` 是所有者自己的选择，照样使用（见下文「启动目录」）。启动目录由 Host 选定时（后两种来源），不在项目中的 Agent 会话各自使用其中新建的文件夹（见「会话自己的文件夹」）。

### 项目与文件夹

项目是一个名称加 1–8 个有序的文件夹（`settings.json` 的 `workspaces`，最多 100 个），可带一个中性图标（`folder`、`code`、`globe`、`server`、`smartphone`、`book-open`、`database`、`flask-conical`、`pen-tool`、`wrench`，没有颜色）。第一个文件夹是主文件夹：新会话在其中启动，也是 ACP 的 `cwd`。每个文件夹有项目内唯一、只由 Host 分配一次的标识（`^[a-z0-9][a-z0-9-]{0,31}$`，由文件夹名折叠为 ASCII，重名加 `-2`、`-3`），调整顺序与重新选择都不改变它；界面显示文件夹名，从不显示标识。保存的路径是去掉别名前缀后的真实路径。

每条记录同时写 `folders` 与 `path`（主文件夹的镜像），`version` 仍为 1：旧版本 Host 只读 `path`，丢弃 `folders` 与 `glyph`，把项目当作只有主文件夹（文件夹只会更少），并在它下一次写入时丢失其他文件夹，这是回退时只丢配置的已知代价。没有 `folders` 的旧记录在加载时得到一个文件夹；`folders[0].path` 与 `path` 不一致（只可能是手动编辑）的项目停用（原因 `invalid`），该标记随设置持久化，重命名或其他设置写入不会修复，需在桌面端重新选择主文件夹；未知的图标被丢弃。未指定名称时从主文件夹名取前 80 个 UTF-16 码元，保留完整的 Unicode 字符。启动目录不保存在设置中，以 `{ id: 'default', name: '启动目录' }` 列出，只有一个文件夹，不能加入更多（409 `workspace-default`），也不能改名或移除；它可以是其他项目的非主文件夹。

**谁能添加。** 加入文件夹就是授予权限，只能在 Host 所在的电脑上进行。

离线项目校验读取上次成功启动时写入的 0600 `project-context.json`：实际启动目录、Agent 安装目录、程序目录与 TLS 私钥路径；数据目录和运行目录仍从本次锁定的数据目录计算。CLI 不从当前目录猜测这些参数。尚未记录上下文时，添加文件夹或移除主文件夹需显式提供 `--workspace <启动目录>`（或 `LATCH_WORKSPACE`）；已有记录时，显式目录必须与它相同，变更启动参数后应先成功启动并停止 Host。

文件夹是授予的范围，不是隔离。Latch 自己执行的只有 Latch 内置的文件工具按所选文件夹检查路径，这也不是操作系统沙箱；ACP Agent 与插件 Harness 怎样对待其他文件夹由它们自己决定（见 [HARNESSES.md](./HARNESSES.md#项目的多个文件夹)），它们仍能访问 Host 用户能访问的任何路径。

### 文件夹规则

主目录、敏感目录、Latch 程序目录、数据目录等不能作为项目的文件夹；不能加入时 Host 说明原因。

### 可用性

Host 按需检查每个项目的文件夹（文件夹规则与项目内的重叠），结果在列出时（`GET /workspaces`、快照的 `catalog.workspaces`）保留 5 秒；新建会话时总是重新检查，并确认 Host 能打开这些文件夹。只要有一个文件夹不可用，整个项目就不可用：部分可用的项目会悄悄改变一个 L3 启动或正在运行的会话所见的范围。不可用的项目保留在设置中：

- 由可用变为不可用时审计一次 `workspace.disabled`（原因 `overlap`、`code-root`、`protected`、`invalid`、`missing` 或 `permission`，以及出问题的文件夹序号；写入失败只记日志，项目照样不可用）；
- 列表仍列出它，项目带 `unavailable`（`文件夹「api」：找不到这个文件夹`），出问题的文件夹也带自己的 `unavailable`；与 Latch 程序目录重叠的项目另带 `codeRoot: true`；
- 新建会话的可选项与默认值不包含它，把它设为默认值返回 400 `workspace-unavailable`，在其中新建会话返回 409 `workspace-disabled`；
- 文件夹回到原来的真实路径并通过检查后，项目自动恢复。Latch 不跟踪移动的文件夹（没有书签，也不按身份追踪）。

快照的 `catalog.projectFolders`（`{ max: 8 }`）表示 Host 支持多个文件夹的项目；没有它的是旧版本 Host。

### 会话与项目

`POST /tasks` 仍只带 `workspaceId`；带 `worktree: true` 时会话在 Host 为它新建的工作树里开始，见 [BRANCHES.md](BRANCHES.md#在工作树里开始会话)。Host 检查项目可用、所选 Harness 能接受这些文件夹的数量（`HarnessInfo.projectFolders.max`，超出返回 409 `harness-folder-limit`），会话在主文件夹中启动；Host 把项目标识记在会话元数据（`sessions-meta.json` 的 `workspaceId`，摘要中的 `workspaceId`），写入失败只影响分组。L3 会话在写启动审计之前算出启动指纹（含交给 Harness 的其他文件夹）；ACP Driver 启动 Agent 时，如果交给它的文件夹已与那时不同，返回 409 `workspace-changed`。

Host 只把项目标识与全部文件夹交给声明 `projectFolders: 'all'` 的 Driver（内置 Standard，以及预设为 Codex、Qwen Code 的 ACP Driver），同时给它 `projects()` 供它自己再核对一次（声明 `historyImport` 的 Driver 也拿到 `projects()`，只用来核对接入的会话目录，不因此收到其他文件夹）；其他 Driver 只收到主文件夹作为 `cwd`，摘要的 `folderAccess` 由 Host 设为 `primary`。`HarnessInfo.projectFolders` 告诉客户端每个 Harness 怎样对待其他文件夹：Standard 与 Codex 为 `{ access: 'all' }`，Qwen Code 为 `{ access: 'all', max: 5 }`，OpenCode 为 `primary-asks`，DeepSeek Harness 为 `primary`，pi 与 goose 为 `primary-unbounded`；没有这一项的 Harness 只使用主文件夹，只有声明 `projectFolders: 'all'` 的 Driver 才显示为 `all`。L3 的启动审计记下包含 Host 交给 Driver 的其他文件夹与 `launchPreview` 声明的其他文件夹的启动指纹；有这样的文件夹时还记下文件夹总数 `folderCount`（含工作目录）。没有预览方法的插件，这些文件夹计入通用启动指纹。各 ACP Agent 的做法见 [HARNESSES.md](./HARNESSES.md#项目的多个文件夹)。会话的文件夹在创建时固定（由 Driver 记在摘要的 `folders` 中；没有时就是 `cwd`）。之后加入项目的文件夹只用于新会话；会话记下的文件夹被移出项目、被替换或找不到时，继续该会话返回 409 `workspace-changed`，项目因其他原因不可用时返回 409 `workspace-disabled`。

改变主文件夹不改变已有会话的工作目录。Driver 的 `workspaces()` 列出可用项目的全部文件夹，供已有会话继续使用原目录；新会话仍只在主文件夹启动。调整主文件夹之前，Host 为目录能唯一对应旧主文件夹、尚无 `workspaceId` 的旧会话补记项目标识；不按跨项目共享的非主文件夹猜测会话属于哪个项目。其他升级前的旧会话按目录处理：目录是某个不可用项目的文件夹时返回 409 `workspace-disabled`。

### 会话自己的文件夹

启动目录由 Host 选定时（没有 `--workspace` 与 `LATCH_WORKSPACE`，`pnpm start` 传入 `sessionFolders`），每个不在已保存项目中的新 Agent 会话（ACP Agent 与只有 Agent 模式的第三方 Harness 插件）在启动目录中得到一个新文件夹 `<yyyymmdd>-<4 位十六进制>`（Host 的本地日期），作为它的工作目录：会话之间不再共用一个文件夹，各自写的文件互不覆盖。只对话（`mode: 'chat'`）的会话不读写文件，没有文件夹。页面不提供模式开关：不选项目时，能只对话的 Harness（Latch 内置）只对话，其余的进入新文件夹；选了项目或所有者指定了启动目录时都是 Agent 模式。分叉沿用来源的模式，旧的只对话会话照常打开。所有者指定的启动目录照旧使用，不建子文件夹。快照的 `catalog.sessionFolders` 表示这台 Host 这样做；这时桌面端在 Harness 没有项目时先问，选「不选项目」才走这里。

- **新建。** 会话开始时以 0700 创建（不受 umask 影响），从不沿用已存在的同名条目（文件、目录或链接都换一个后缀，连续 16 次重名返回 409 `session-folder-unavailable`）；启动目录不存在时先创建，它的真实路径已不是 Host 启动时的那个时拒绝。文件夹属于这次请求：同一台设备以同一 `requestId` 重试得到同一个文件夹（其他设备用同一个 `requestId` 得不到它）。调用 Driver 之前先把请求键的哈希、文件夹名与启动目录哈希写入 0600 `session-folders.json`，跨重启与内存缓存过期仍沿用原目录；原目录丢失或启动目录改变时拒绝，不能换一个目录继续重试。Driver 明确以 4xx（408 除外）拒绝且未建成会话时删除记录与仍为空的目录；结果未知时保留。已分配文件夹而没有调用 Driver 的请求 10 分钟后清理。Latch 从不删除建成过会话的文件夹，删除会话也保留它和其中的文件。
- **记录。** 会话的 `workspaceId` 为 `default`，文件夹名记在 `sessions-meta.json` 的 `sessionFolder`，摘要带 `sessionFolder: true`；Driver 不会收到这一项，Driver 自己报告的值被丢弃。Host 把这些文件夹列入给 Driver 的目录列表（`workspaces()`，排在项目之后）：它们都直接位于启动目录中，列出它们不授予启动目录之外的任何东西。
- **继续。** 继续会话、修改选项与允许调用都要求文件夹仍是启动目录中的真实目录（不是链接，名称符合格式），否则返回 409 `workspace-changed`；之后以所有者指定的同一个启动目录重启，已有会话仍可继续。
- **存为项目。** 桌面端可以把会话自己的文件夹存为新项目的主文件夹（见「谁能添加」）：文件夹通过与选择面板相同的规则，项目以会话标题命名（标题含不可显示的字符时用文件夹名），标识取文件夹名；保存的是检查时的真实路径，它必须仍直接位于启动目录中；先审计 `workspace.added`（`via: 'session'`），写入失败返回 503 且什么都不保存。会话本身仍属于启动目录（会话的项目在创建时固定），之后在这个项目中新建的会话在这个文件夹中启动。没有自己文件夹的会话返回 409 `session-folder-none`，已存为项目的文件夹返回 409 `workspace-folders-refused`（`workspace-exists`）。

### 启动目录

我的 Agent 与通用的首次聊天另用同一分配器管理固定家：`helpers/<Agent ID>`，显式 `--workspace` 也建立。内部仍是 `workspaceId: 'default'`，Host 持有私有 `sessionFolder` 名称与真实 cwd，不加入公共项目目录。家按 owner 共用、绑定原根及目录身份，删除不删文件，也不能存成公共项目；普通 Code 的日期文件夹规则不变。见 [家与工具](CUSTOM-AGENTS.md#家与工具)。

`classifyDefaultWorkspace` 对启动目录给出三项判断：

- 位于数据目录内（旧的 `<数据目录>/workspace` 布局）：只能用于内置 Harness，ACP 返回 409 `workspace-inside-data`。
- 在数据目录之外与程序目录重叠（只可能来自 `--workspace` 或 `LATCH_WORKSPACE`）：所有 Standard 写入按 R2 处理，ACP 返回 409 `workspace-code-root`；列表中它带 `codeRoot: true`，客户端据此提示。
- `sensitive`：等于主目录，或与敏感目录、运行目录或 Agent 安装目录重叠。此时 Host 拒绝启动（409 `workspace-overlap`）。

### 工作区工具的禁止路径

内置文件工具不访问 Latch 的数据目录与主目录下的敏感目录。私有条目的清单在 `apps/host/src/data-entries.ts`。

### 会话文件

回复里提到的文件在客户端是路径标记，从不让页面导航（见 [DESIGN.md](DESIGN.md)「路径标记」）。桌面端可以把这样的文件在访达中显示、用快速查看预览、用默认应用打开或在编辑器中打开；判断都在 Host（`apps/host/src/files/`），读取内容需要 `view`，本机外部动作只在 `host.sock` 上进行。

**在编辑器中打开。** 只在这台 Mac 的主窗口（`latch://app/` 顶层页）出现；其他电脑的窗口、浏览器与 iOS 没有这一项，也不提它。主进程按固定的 bundle ID 白名单（VS Code、VS Code Insiders、Cursor、Windsurf、Zed、Sublime Text、IntelliJ IDEA、WebStorm、GoLand、PyCharm、Xcode、Nova）在 `/Applications`、`~/Applications` 与 JetBrains Toolbox 的文件夹里找应用包，以 `Info.plist` 的 `CFBundleIdentifier` 为准，不找 PATH 上的程序。人在「设置 › 通用」或第一次打开文件时选一个，主进程记在桌面端数据目录的 0600 `editor.json`。打开时 Host 按其他文件动作的规则裁决并先审计（`file.editor`，需要 `run`）：会话或项目文件夹里的普通文本文件，不是可能含密钥的文件，也不是编辑器当作项目打开的定义文件（`.code-workspace`、`.sublime-project`、`.sublime-workspace`、`.ipr`、`.iws`、`.iml`）；主进程复查真实路径、普通文件与文件头是文本。主进程还拒绝打开时会执行或导入项目的文件：Xcode 不收 `Package.swift`，JetBrains IDE 不收 `pom.xml`、`build.gradle(.kts)` 与 `settings.gradle(.kts)`。启动只用 `/usr/bin/open -a <检查过的应用包> <目标>`（execFile，无 shell），目标是主进程按该编辑器文档里的固定模板拼出的地址（`vscode://file/<逐段编码的绝对路径>:<行>`，Cursor、Windsurf、VS Code Insiders、Zed 同理），没有这种地址的编辑器就是文件的绝对路径这一个参数，不带行号。VS Code 一系把地址里每个 `:<数字>` 段（空段算 0）都读成位置，所以文件名含 `:` 时改为把路径作为参数交给它（它的 macOS 打开文件处理以 `gotoLineMode: false` 打开，不解析位置），也不带行号；Zed 在路径与地址里都解析位置，文件名含 `:` 或以 `(n)`、`(n,m)` 结尾时拒绝。含控制字符、换行、行或段分隔符、未规范化的路径一律拒绝；从不交出文件夹，Latch 自己不运行项目里的文件。编辑器打开文件后按它自己的工作区信任行事，可能加载项目的设置与语言服务器，这不是 Latch 的隔离。主进程只在主窗口页面一秒内的真实点按或按键之后、且已选的编辑器仍在时才启动它，否则不请 Host 审计。

**诊断导出。** `POST /link/api/diagnostics` 只回答 `host.sock`：命令行（`pnpm latch diagnostics --out <文件>`，写入新建的 0600 文件，已存在时拒绝）或桌面端主进程（「设置 › 关于 › 导出诊断…」，主进程弹出保存面板并写文件；桌面代理拒绝页面自己请求这条路由）。设备调用还需 `admin` 并在 `host.sock` 上登记；其他设备 403 `local-only`。内容按固定字段生成（`apps/host/src/diagnostics.ts`）：Host、Node 与系统版本，各 Harness 的状态、级别、版本与状态说明的第一行（最多 200 字；人自己定义的 Harness 不写它的 ID，写列表中的序号与它来自的预设，如 `harness-2`、预设 `dsh`，它的插件与事件用同一个标签，它的 ID 与非预设名称在文字里替换为「‹已隐去›」），插件列表（ID、版本、启用、运行数），策略的形状（本机确认后端、出站与已确认地址的条数、无人值守上限，不含主机与密钥），设备与连接计数，以及最近 400 个事件与其中最近 100 个失败（只在内存里，Host 重启后从空开始：刚启动、还没有出过这些事的 Host 导出的 `events` 为空，Agent 的启动失败与模型服务的 401 是会话里的结果，不是这些事件）。事件不是日志行：Host 只在自己写的一组固定日志处（`DIAGNOSTIC_CATEGORIES`：审计写入失败、Harness 或模型服务加载失败、项目不可用等）记下类别、按形状检查过的 ID 与错误代码，Agent 的 stderr、Agent 写的文字、提示词与出站白名单的主机从不进入。剩下的文字再经一次 `redactSecrets`，设备名、项目名与文件夹、会话标题、数据目录与出站主机替换为「‹已隐去›」，主目录写作 `~`，其他用户的主目录写作 `~other`，其他绝对路径写作「‹路径›」。不含对话、文件内容、记忆与 `auth/`、`providers.json` 里的任何东西。先写审计 `diagnostics.exported`（只有事件数、失败数、Harness 数与插件数）再回答。

## Harness 与会话路由

Host 启动时挂载所有已启用的 Harness：`standard` 总是挂载；每个启用的 ACP Agent 与 `--plugin` 提供的 Harness 也会挂载。`--harness <id>` 指定必须成功启动的 Harness，并作为新会话的默认值；否则使用「设置 → 通用」保存的默认值，再退回 `standard`。

`HarnessHub` 实现 `Bridge`，对外表现为一个 Bridge：

- **会话 ID 原样透传。** 路由表来自 `createTask` 的返回、Driver 的变化通知和 `listTasks`，只在内存中保存；未知 ID 会重新列出一次后再返回 404。Driver 必须生成全局唯一、不超过 256 字符的会话与审批 ID；会话 ID 冲突时先挂载者胜出并记录日志，审批 ID 同时属于多个 Harness 时拒绝路由。
- **审批按来源路由。** `approvals()` 合并所有 Driver；`decide` 找到持有该审批的 Driver。
- **权限级别。** Hub 由 `trustOf` 给会话标注级别：Driver 的来源由注册它的插件得出，内置且声明 Latch 把关的是 L1，ACP 与插件 Harness 是 L3（未知来源按 L3），Driver 只能往低了说（`apps/host/src/harness-trust.ts`）；会话详情带 `permission` 说明由谁把关、能否读回模式与漂移状态。
- **故障隔离。** 某个 Driver 列表失败不影响快照；非必需 Driver 启动失败只会在目录中标为不可用。
- **Host 字段不下传。** `harnessId` 由 Hub 消费；`model`、`cwd` 只有客户端选择时才传给 Driver。自己带模型的 Harness 选了模型服务时，Host 用 `pairRoute` 重算这一对，只把 `modelRoute`（服务、模型、协议与源）交给声明了 `models.wires` 的 Driver，Driver 经 `modelGateway` 为每个进程换一个网关凭据（见 [HARNESSES.md](./HARNESSES.md#经-latch-使用模型服务)）。
- **工具网关。** ACP Driver 另得到 `toolGateway`：Host 运行目录里 0700 的 `tools/` 下的 Unix 套接字 `gateway.sock`（0600），只转发 `tools/list` 与 `tools/call`（及其取消）给浏览器工具，以及 Latch 的 MCP 服务器的 `latch-mcp` 桥的启动清单、状态报告与每次调用前后的审计（[MCP.md](./MCP.md)）；本机命令的桥经 `mcp/prompt` 请求准许转发提示，写审计和当前会话的来源标记后才放行。MCP 的令牌每个服务器一个，失效时网关断开桥的连接，桥随之结束服务器的进程组。远程地址的桥另经 `mcp/remote` 与 `mcp/cancel` 把 `initialize`、`tools/list`、`tools/call` 交给 Host（见下一条）。
- **Host 作为远程 MCP 的客户端。** 远程 MCP 服务器（Streamable HTTP）只由 Host 连接（`mcp-remote.ts`），外部 Harness 经 `latch-mcp` 桥、内置 Harness 经 `mcpTools` 得到它的工具。请求只经注入的出站 `fetch` 与出站策略，只发往本机确认时绑定的源与路径，不跟随重定向；请求头与它的值从不离开 Host，回答有大小与时间上限，经 `redactKnownSecrets` 后才交给 Agent。每次调用先写审计，写不进就不发。见 [MCP.md](./MCP.md#远程地址)。要登录的远程服务器由 Host 作 OAuth 客户端（`mcp-oauth.ts`）：只在 `host.sock` 上发起，授权服务器的源与范围先经本机确认，它的每个端点都必须在那个源上；浏览器回到 Host 在 `127.0.0.1` 随机端口上只为这次登录开的监听（不是 API 的入口类别）；令牌只在 `mcp/secrets.json`，只作为 `Authorization: Bearer` 发往绑定的地址，由 Host 续期与撤销，从不返回任何设备。见 [MCP.md](./MCP.md#登录)。Driver 每次为会话打开、恢复、载入或分叉 Agent 的会话时换一个 `lbt1.` 令牌（只在桌面端已登记为浏览器提供者、会话有项目时），写进网关目录里新建的 0600 文件，`mcpServers` 里的 `latch-browser` 只拿到文件路径（参数与环境都可能被同一台电脑上的其他进程看到），读出后即删；Host 只存哈希，令牌绑定会话与进程的生命期，进程退出、会话归档或删除、Host 停止时失效，每个请求都核对。它不是 API 的入口类别：持有令牌的进程不能当设备用，也碰不到会话与设备的接口；网页连不到 Unix 套接字。调用只在会话正在运行的一轮里执行，停止这一轮要等在途的调用结算后才确认；走浏览器的 broker、分级与审计（`browser.call` 带 `via: 'mcp'`），完全访问的会话里 R2 一律拒绝（见 [PREVIEW-BROWSER.md](./PREVIEW-BROWSER.md#agent-的工具)）。
- **会话元数据。** 重命名、置顶、归档保存在 `sessions-meta.json`，对所有 Harness 生效；在我的 Agent 里和「通用」的对话也记在这里（`generalChat`，见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#会话)）；审批决定与取消的回执也随会话保存在这里（见「审批与取消」）。删除调用 Driver 的可选 `remove`，不支持时返回 409 `delete-unsupported`，删除成功后一并删除该会话的元数据与回执。
- **运行。** Driver 在每次运行开始时给会话写入新的 `TaskSummary.runId` 并持久化（Standard 与 ACP 都如此；不记录运行的外部 Driver 不提供）。`cancel(sessionId, { runId })` 只在它仍是当前运行时取消，并回答是否取消了什么。
- **生命周期事件。** `session-lifecycle.ts` 把会话与 Host 的变化发给 Host 内按会话保存状态的模块，路由模块经 `RouteContext.lifecycle` 拿到的对象只有 `on`，只能订阅、不能发出。没有监听器时这些事件不增加任何读取或等待。
  - `runStarted`（`{ sessionId, projectId, runId, folders }`）：Driver 在一次运行的第一条提示发给模型或 Agent 之前等待 Host 提供的 `trackFiles`，Host 在其中向该 Driver 核对这是会话当前的运行后发出；`folders` 是 Host 按会话记下的文件夹解析的结果（没有记下时为工作目录），主文件夹在前。只对话的运行不跟踪文件，不发出。
  - `runSettled`（`{ sessionId, runId, outcome }`）：只跟在 `runStarted` 之后，每次运行一次。有监听器时，Hub 在 Driver 报告变化后读取该会话的摘要，每个会话最多 40 毫秒一次，新的输入、取消与删除之前立即读一次；运行既不在运行也不在等待审批时才算结束，所以只是请求了取消不会发出它。`outcome` 取 Driver 记下的 `runOutcome`（`completed`、`failed`、`cancelled` 或 `interrupted`），没有记下时按结束时的状态判断。
  - `sessionArchived`、`sessionDeleted`（`{ sessionId, projectId }`）：归档或删除保存之后发出，已归档的会话再次归档不重复。监听器不能拒绝它们；可能拒绝归档的规则（如另一台设备归档时有终端还在运行）是路由在修改之前的检查。没有记下项目的会话，`projectId` 为 `default`。
  - `hostStopping`：Host 开始停止、不再接收请求之后，关闭 Driver 与监听入口之前发出。它结束所有未结束的运行：这些运行不再有 `runSettled`，下次启动也没有，订阅者把这个事件当作它们的结束，并在下次启动时恢复自己的记录。
  - 运行的查询与 `runStarted` 的监听器合计最多等待 15 秒，`hostStopping` 的监听器最多 3 秒，其余事件不等待。取消会让仍在等待的运行立即继续（提示不会发出）；Host 开始停止时，仍在等待的运行先被取消再放行，之后才到达 `trackFiles` 的运行直接取消，都不会发给模型或 Agent。监听器抛错、拒绝或超时只经脱敏的日志记录，不影响运行与停止。
- **挂载与卸载。** 启停 Harness 插件或修改 Agent 定义时先卸载旧 Driver；仍有运行中或待审批的会话时返回 409 `harness-busy`。

客户端从快照的 `catalog` 读取可选项：`harnesses`（状态、级别、支持的模式、`capabilities`：模型归谁、谁把关、能否运行命令、显示的名字与图标；客户端只读这些事实，不判断 Driver 种类；`offer` 表示这台电脑上找到了预设的命令、定义还没保存，只发给能保存它的设备，见 [HARNESSES.md](./HARNESSES.md#使用)）、`providers`（不含密钥）、`workspaces`（含本次运行停用、带 `unavailable` 的项目）与 `defaults`。`snapshot.harness` 与 `snapshot.execution` 保留旧含义，描述默认 Harness。快照还带当前设备（`device`，含续期时间）与 Host 信息（`host`：hostId、开发版标记、本机确认状态、HTTPS 入口与原生连接 `native`）。

## Standard 的会话与运行

一个会话（task）是持久对话；一次运行（run）由创建或后续输入触发。正常结束为 `idle`，可继续输入；`failed`、`cancelled`、`interrupted` 分别表示失败、明确取消与进程中断。

| 模式 | 行为 |
| --- | --- |
| `chat` | 不向模型暴露工具，只租用模型服务插件。模型擅自请求工具时本次运行失败，不产生副作用。 |
| `agent` | 模型输出 → 收集完整工具调用 → Host 风险分级 → 必要审批 → 串行执行 → 结果交回模型。默认最多 50 步，每步最多 32 个调用。 |

**模型选择。** 创建时使用请求中的 `model`，否则使用 Host 默认模型；所选模型必须在该服务启用的模型列表中。选择后固定在会话上，只有带 `model` 的后续输入才切换。早期没有记录服务的会话继续跟随当前默认值。

**项目与文件夹。** `cwd` 必须是 Host 登记的工作目录之一（按真实路径比较）。在项目中新建的会话同时收到项目标识与它的全部文件夹（`workspaceId`、`folders`，主文件夹在前，就是 `cwd`），运行时用 Host 的 `projects()` 核对：项目在列表中、`folders[0]` 是它的主文件夹，每个文件夹的标识与真实路径都属于这个项目，否则 400 `workspace-unavailable`。会话把它们记在摘要中，之后不再改变：项目新加的文件夹只用于新会话，改变主文件夹也不移动已有会话；会话记下的文件夹被移出项目、被替换、找不到，或项目被移除时，继续输入与允许等待中的调用都返回 409 `workspace-changed`（拒绝不受影响）。没有记下文件夹的旧会话只有它的目录，目录被移除后同样返回 409 `workspace-changed`。

内置文件工具（`workspace-files` 1.2.0）用文件夹标识选择文件夹：`list_files`、`read_file`、`write_file` 带可选参数 `folder`（缺省为主文件夹），路径相对于该文件夹；`list_folders` 只返回每个文件夹的标识、文件夹名与是否为主文件夹，不返回绝对路径。会话有多个文件夹时，写入的预览与结果写明文件夹名。创建请求的回执只在有多个文件夹时包含它们，所以单个文件夹的会话与之前的回执一致。

**用量与思考。** Provider 报告的用量累计到对应助手消息与会话总数，失败或取消的部分步骤也计入；缓存读取、缓存写入与推理的 tokens 只在服务报告时记录，合计时某一部分只有每一步都报告了才保留。思考内容以 `liveReasoning` 流式显示，结束后保存在消息的 `reasoning` 中，这段文字不进入发给模型的历史；Anthropic 与 Responses 签过名或加密的推理另存在历史里的工具调用上，只在同一轮的工具循环里原样带回，下一条用户输入开始新的一轮时从历史里删除（见 [MODEL-CONFIGURATION.md](MODEL-CONFIGURATION.md#latch-内置的思考深度)）。

**时间。** 运行时用 Host 的时钟（`clock`）记录消息、工具与一轮的时间、思考用时与回答的模型，等待审批的时间不计入一轮的用时；快照与 SSE 带 `hostTime`，客户端据此按 Host 时钟显示活的计时。字段与含义见 [STREAMING.md](./STREAMING.md)「时间与用量」。

**工具展示。** 工具消息带 `tool`（kind、标题、参数、输出）。需要审批的工具在请求审批前调用可选的 `preview()`，生成标题与文件差异，同时显示在审批与工具卡片上。

模型输出必须以 `finish` 结束；截断的流不会派发其中的工具调用。调用 ID 在会话历史中不能重复；未知工具、拒绝和异常都作为错误结果交回模型。配置缺失或服务失败不会静默改用演示模型。

## 审批与取消

审批属于执行端的运行，多设备竞争时只有一个决定生效：同一审批的决定串行处理。Standard 的 R1 审批提供允许一次、本会话始终允许（该工具名写入会话的 `allowedTools`）与拒绝；R2 审批与 L3 询问不提供「始终允许」，即使同一工具此前被 R1 始终允许过也每次询问（选择「始终允许」返回 403 `approval-always-unavailable`）。决定与选项方向不一致、或选项不存在时返回 400（L3 询问中会持久保存授权的选项被隐藏，返回 400 `approval-option-hidden`）。决定前按设备的当前记录检查所需权限；允许时还检查会话的文件夹仍在项目中（否则 409 `workspace-changed`）。每次决定先审计 `approval.decided`（含所选选项的类别 `optionKind`，R2 另含 previewHash），再交给执行端。

**决定记录与拒绝说明。** Host 把决定连同 `via`（`host.sock` 上的桌面端为 `this-mac`，其余入口为 `other-device`）交给 Driver；内置 Harness 与 ACP Driver 把结果写在那次工具调用上，`ToolDetail.decision = { outcome, at, via? }`，并写进各自存储的 zod schema。`outcome` 为 `allowed`、`rejected`（人的选择，带 `via`），或 `expired`、`cancelled`（没有人回答：会话停止、取消、进程结束、Host 重启时还开着的审批，以及权限漂移时 Latch 自己拒绝的询问），后两者不带 `via`，从不记作某人的拒绝。Agent 自己撤回的询问不留记录。设备名与设备 ID 不进这条记录，只在审计里。记录写的是人的决定，不是调用有没有执行：内置 Harness 在允许之前不执行调用，被拒绝时给模型的工具结果是「用户拒绝了本次工具调用，未执行该操作。」，没有内部代码；ACP Agent 是可信本机代码，它的询问只是提示，Agent 之后报告的状态与差异照常记下，界面只把没有开始就结束的调用读作被拒绝（见 [DESIGN.md](./DESIGN.md)「审批」）。Agent 为同一调用询问多次时，记录保留已经给出的允许，之后的拒绝或取消不覆盖它。拒绝可以附一句说明 `note`（「告诉 Harness 改做什么」）：去掉首尾空白、换行统一为 `\n` 后最多 500 个字符，每一行都不能含 `escapeSecurityText` 会标出的字符（`rejectionNote`，[decision.ts](../packages/protocol/src/decision.ts)），否则在审计之前返回 400 `invalid-note`；允许时带说明同样返回 400。Host 只把说明交给 `capabilities.permission.rejectionNote` 为真的 Harness（内置 Harness 声明它，ACP Driver 不声明：ACP 的权限回复不能带文字）；给其他 Harness 的说明经过同样的检查后被丢弃，拒绝照常生效。说明是给模型的输入，所以交给 Harness 时像在会话里输入一样另需 `run` 权限（403 `scope-required`）；只有查看权限的设备仍可以拒绝，但不能附说明。内置 Harness 把它接在拒绝后面交给模型（「…未执行该操作。用户的说明：…」）。页面读取会话所用 Harness 的这项事实，只在为真时才让拒绝等说明。说明是交给模型的输入，不写进审计。

在 Harness 自己的模型代人决定的模式里，没有问人的调用带 `ToolDetail.judged = { by, outcome }`：`approved`、`denied`、`none` 是那个模型对一次请求的审阅与结论，`unasked` 是没有问人就运行了；它不是决定记录，也不是人的批准，每一条另写 `task.tool.judged` 审计（见 [HARNESSES.md](./HARNESSES.md)「权限菜单」）。Harness 在调用运行之前自己拦下它、没有问人时，那次调用带 `ToolDetail.blocked = { by, source, reason? }`：`model` 是它的模型审阅后拦下（在这类模式里同时带 `judged` 的 `denied`），`rule` 是它自己的规则或模式；`reason` 是 Harness 自己的文字，Host 限长；界面读作「拦下」，不算失败，也不算改动。

审批已被处理或已失效时返回 409 `approval-settled`，`decidedBy` 说明由谁处理：`{ kind: 'device', self, deviceName, decision, optionKind, at }`（`optionKind` 如 `allow_once`、`allow_always`、`reject_once`；`deviceName` 为该设备当前的名称，Host 已不认识该设备时为空），或 `{ kind: 'system' }`（会话结束或取消使其失效）；执行端已不再等待时记录 `approval.stale`。同一设备用同一 `requestId` 重发时返回原回执（`replay: true`），不会再次决定或审计。

取消沿同一个 `AbortSignal` 传给 Provider 与工具，并等待真实结算后才确认；已经发生的副作用不会撤销，不协作的插件无法在同一进程中被安全强杀。取消的请求体为 `{ requestId?, runId? }`：带 `runId` 时只停止那次运行，它已经结束（或之后又开始了新的一轮）时不停止任何东西，回答 `ended`；回答是回执 `{ sessionId, requestId?, runId?, outcome: 'stopped' | 'ended', status?, at }`。ACP Agent 的取消规则见 [HARNESSES.md](./HARNESSES.md#取消)。界面上的取消中、部分输出与超时语义，以及回执的完整规则，见 [STREAMING.md](./STREAMING.md#取消的请求-id-与回执)。

**回执随会话保存。** 审批决定（审批 ID、`requestId`、作出决定的设备 ID、决定、选项与类别、时间）与带 `requestId` 的取消（`requestId`、设备 ID、`runId`、结果、状态、时间）在回答之前写入 `sessions-meta.json` 中该会话的条目（等待写入期间到达的回执合并为一次写入），所以 Host 重启后，同一设备重试同一个 `requestId` 仍得到原回执，不会得到错误或第二次决定。保留 7 天，每台设备最多 1 万条、合计最多 10 万条，最旧的先删；删除会话时一并删除。写入失败时操作照常生效，回执留在内存中并进入下一次写入。文件仍是版本 1：回执是新增的可选字段，旧文件照常读取，旧版本读取新文件时忽略它；单条回执读不懂（以后的新类型或损坏）时只略过这一条，并在日志中记下条数。

## 持久化与恢复

| 路径（数据目录内） | 内容 |
| --- | --- |
| `identity/host-key.pem` | Host 身份私钥（0600，目录 0700） |
| `auth/devices.json`、`auth/revocations.jsonl` | 设备登记（版本 2，只含凭据哈希）与撤销日志（0600，目录 0700） |
| `auth/offline-enrollments.json` | 未使用的离线连接码哈希 |
| `audit/audit.jsonl` | 哈希链审计记录 |
| `policy.json` | 本机安全策略 |
| `customization.json` | 外观的最近 20 个修订与写入回执，0600。现用文档无效时保留原文件，按默认外观启动，见 [CUSTOMIZATION.md](CUSTOMIZATION.md) |
| `providers.json` | 模型服务、密钥及其绑定的源与路径，每个模型的「出错时改用」（`fallbacks`）与服务的「同时请求」上限（`maxConcurrent`）（0600，不进入时间机器备份）；项目的「默认模型」在 `settings.json` 的 `workspaces[].defaultModel`；改动「出错时改用」写审计 `provider.fallbacks.changed`，两者都不计入服务的执行修订；服务的健康状态只在内存（[调度](MODEL-GATEWAY.md#调度)） |
| `gateway/usage-YYYY-MM.jsonl` | 用量账本：每个模型请求一行元数据（会话、Agent、Harness、服务、模型、结果分类、次数、时长、服务报告的 tokens、已知的花费），按 Host 电脑的时间分月，保留 90 天（目录 0700、文件 0600、只追加、strict）。不含正文、请求头与任何密钥，不是审计，照常进入备份；见 [MODEL-GATEWAY.md](./MODEL-GATEWAY.md#用量账本) |
| `gateway/totals-YYYY-MM.json` | 按服务与按 Agent 汇总账本已写入的前缀，供预算使用（0600、strict、追加成功后原子替换）。与账本大小对不上时重建 |
| `gateway/budgets.json` | 模型单价、服务和 Agent 的每月预算、修订号与有界修改收据（0600、strict、整份原子替换）。见 [MODEL-GATEWAY.md](./MODEL-GATEWAY.md#预算) |
| `mcp/servers.json`、`mcp/secrets.json` | Latch 的 MCP 服务器定义与它们变量、远程地址请求头的值、登录的令牌与客户端密钥（目录 0700、文件 0600、strict，不进入时间机器备份），见 [MCP.md](./MCP.md) |
| `mcp-ended.json` | 登录已结束、但令牌没能从 `mcp/` 删除的服务器 ID（没有别的内容）；Host 启动时先删除再去掉记号，见 [MCP.md](./MCP.md#登录) |
| `settings.json` | 默认值、插件停用列表、项目及其文件夹、Agent 定义、环境变量与 startedHash（0600，不进入时间机器备份） |
| `sessions-meta.json` | 会话标题覆盖、置顶、归档，会话所属的项目，以及 Host 为会话新建的文件夹名或工作树（位置与分支，见 [BRANCHES.md](BRANCHES.md#新建工作树)），以及交付绑定的 PR，接入的来源（`imported`，见 [HARNESSES.md](HARNESSES.md#接入已有会话)），以及审批决定、取消与交付（按行暂存和取消暂存、提交、推送、创建 PR，见 [GIT-DELIVERY.md](GIT-DELIVERY.md#回执与结果未知)）的回执 |
| `agents/computer.json` | 桌面端报告的睡眠与醒来、Host 有序停止到下次启动的时段（版本 1，各最多 32 段，只有时间，strict schema，0600），用于「电脑」的上次唤醒与错过的原因；读不了时移到一边从空开始（[CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#界面)） |
| `agents/custom.json` | 我的 Agent 与「通用」的定义、记忆、记忆提议（`proposals`）、每条记忆可撤销的最近一次修改（`changes`）、委托与修改的回执（版本 2，0600，目录 0700，见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md)）。没有 `proposals` 与 `changes` 的旧文件按空读入，下次写入时补上。同一个文件里还有：每个归属最近 64 轮的记忆查询计数（只有内置 Harness 的 `recall_memory` 会记；`recalls`：会话、那一轮的消息、次数，不含查询的词；旧文件按空读入）；导入的记忆带 `imported`（文件里的来源、是否来自外部内容、原保存时间），人「设为我说的」之后的记忆带 `owned`；头像除括号脸外可以是 `kind: 'image'` 加 `image`（Host 重新编码后那份图片的 SHA-256，括号脸字段保留）。版本 1 的 `glyph` 在读取时按旧图标的序号固定映射为 `avatar`（括号取序号模 4、眼睛取序号整除 4 再模 4、颜色取序号模 9），立即写回版本 2，不再写版本 1；未知的图标或头像取值拒绝读取并保留原文件 |
| `handoffs/handoffs.json` | 交接记录与回执（0600，目录 0700，见 [HANDOFFS.md](HANDOFFS.md)） |
| `history-imports.json` | 接入已有会话的回执：请求 ID、来源 Harness 与它的会话 ID、方式与 Latch 会话 ID；目录与标题只在完成之前保存（见 [HARNESSES.md](HARNESSES.md#接入已有会话)） |
| `review-notes/<会话 ID 的 SHA-256>.json` | 会话的行级反馈、未定的发送与回执（0600，目录 0700，见 [CHANGES.md](CHANGES.md#行级反馈)） |
| `plugin-data/<pluginId>/gen-<n>/data.json`、`plugin-data/<pluginId>/diagnostics.json` | 插件页面的文档与回执（每个数据版本一代，保留最近 3 代）、页面诊断（0600，目录 0700，见 [APP-PAGES.md](APP-PAGES.md)） |
| `session-folders.json` | 会话启动请求键的哈希与自有文件夹名、启动目录哈希；Agent 固定家的 owner、根/父/叶目录身份（0600） |
| `project-context.json` | 上次成功启动时用于离线项目校验的目录与 TLS 私钥路径（0600，不含密钥内容） |
| `sessions/runtime.json`、`runtime.lock` | Standard 的会话、请求回执与删除记录 |
| `agents/avatars/<哈希>.png` | Agent 的图片头像：Host 的解码进程重新编码出的 256×256 PNG（只有 `IHDR`、`IDAT`、`IEND`），按内容的 SHA-256 命名，0600，目录 0700；没有任何 Agent 再用的会被删掉，Host 启动时再清一遍。只经 `GET /custom-agents/avatar-images/<哈希>` 读取，见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#图片头像) |
| `harnesses/<id>/` | 外部 Harness 的私有数据；ACP 为 `acp.json`、`acp.lock`，以及 `skills/<会话 ID 的 SHA-256 前 32 位>/`（0700）：技能服务读取的 `skills.json`，和 `propose_memory`、`propose_schedule` 追加的 `proposals.jsonl`（0600，一行一条，有行数与大小上限，ACP 驱动读后交给 Host 建提议，见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#外部-harness-的通道)） |
| `host.json` | 运行中 Host 的 PID、hostId、实例 ID、`host.sock` 路径与地址（版本 2，0600） |
| `host.lock` | 数据目录锁：持有者的 PID、实例 ID、角色与开机时间（0600，正常退出时删除）；取锁与接管时的临时条目以 `.host-lock-` 开头 |
| `host.log` | 桌面启动器或桌面端主进程在后台启动的 Host 的输出（0600，追加写入，不跟随符号链接） |
| `desktop-launch.json` | 桌面启动器启动 Host 的方式与该 Host 的 PID（见「Host 的生命周期」；0600，原子写入，临时文件以 `.desktop-launch-` 开头） |
| `provider.json` | 旧版单一模型配置，只在首次启动时迁移到 `providers.json`，不会被修改 |

启动顺序：`pnpm start` 取得 `host.lock` → 检查没有不取锁的 Host 在运行 → 加载 `--plugin` → （macOS）按需构建确认组件 → `startServer`：数据目录（0700，属于当前用户）→ 打开并校验审计 → Host 身份 → 安全策略（含带外修改检测）→ 设备登记（含迁移与撤销日志重放）→ 运行目录 → 配置文件 → 把 `auth/`、`identity/`、`providers.json` 与 `settings.json` 排除在时间机器备份之外 → TLS 材料检查 → 启动目录检查 → 设置带外修改检测与已保存项目的重新检查 → 插件、模型服务与 Agent → Harness 挂载 → 监听入口 → 审计 `host.started` → 写入 `project-context.json` 与 `host.json`。

配置写入使用临时文件、fsync、原子 rename 与目录 fsync，并按文件串行。损坏的配置文件会以 `config-corrupt` 报告文件名并保持原样，不会被覆盖。

Standard 的 `RuntimeStore` 提供 `load / commit / close`；默认实现是完整快照文件，单写者由锁文件保证。确认旧 PID 已退出才回收锁；无法校验的锁或损坏快照会报错并保留原文件。新增字段都是可选字段，`version` 保持 1。

| 情况 | 语义 |
| --- | --- |
| 重试创建 | 同一 `requestId` 与相同内容返回同一会话，重启后也不重跑；内容或模式不同返回 409 `request-conflict`。只有显式传入的 `model`/`cwd` 参与比较。 |
| 重试输入 | 回执按会话与 `requestId` 区分；运行中的新输入返回 409 `task-running`。 |
| 重试审批或取消 | 回执在 `sessions-meta.json` 中，重启后同一设备的同一 `requestId` 得到原回执（见「审批与取消」）。 |
| 删除后重试 | 会话删除后保留回执与删除记录，重试创建返回 410 `task-deleted`。较旧版本无法读取含删除记录的快照。 |
| Host 崩溃后启动 | 运行中、待审批或未完成工具批次的会话转为 `interrupted`；旧审批失效，不自动续跑。 |
| 工具已开始但没有结果 | 写入 `TOOL_OUTCOME_UNKNOWN`，要求先核对副作用，不自动重放；被允许（人或 Harness 的审阅模型）的调用即使没有报告运行也算已开始；未开始的调用写入 `TOOL_NOT_STARTED`。 |
| 存储提交失败 | 停止接受新操作并取消活跃运行。 |

已确认的消息持久化；流式中的文字与思考暂存在内存，崩溃可能丢失尚未结算的部分。快照存储没有历史压缩、分页或自动备份。

## 桌面端与其他电脑

桌面端除了经 `host.sock` 连接这台 Mac 的 Host，还可以经 HTTPS 连接其他电脑的 Host（`apps/desktop/src/computers.cjs`、`remote-proxy.cjs`）。每台 Host 仍是自己会话的唯一权威，Host 之间互不登记，也没有跨电脑的会话。

- **列表属于桌面端。** `userData/computers.json`（0600，原子写入，严格校验，最多 16 条，不含凭据）记录每台电脑的 hostId、HTTPS 地址、名称、添加时间、上次在线与版本；无法解析的文件不猜，按空列表处理，下次写入前移到 `computers.json.damaged`；写入只写通过校验的记录，名称按码点截到 80 个字符。启动时某台电脑的凭据无法打开时，列表只读（不写文件、不删分区、不能添加或移除），页面说明原因，直到下次启动。这台 Mac 不写入列表，由 `host.json` 决定；只有经 `host.sock` 的 Host 叫「这台 Mac」。
- **添加。** 在另一台电脑的 设置 › 设备 点「复制链接」（该 Host 需已配置 HTTPS），回到这台 Mac 的 设置 › 电脑 点「添加电脑」；或选择 `pnpm latch device invite --code-file` 写出的文件。主进程读剪贴板或文件，只接受 `https://<地址>/link/#pair=<码>`，页面看不到链接与码；添加与移除只接受这台 Mac 页面上一秒内的真实点按或按键（主进程检查）。主进程先读那台 Host 的 `GET /health` 得到 hostId（这台 Mac 自己与已添加的电脑被拒绝），再为它**新生成**设备密钥，按现有流程登记（名称「<这台 Mac 名称> 上的 Latch」，权限由邀请决定），确认在那台电脑上用它自己的本机确认完成，校验码在这台 Mac 的页面上同时显示。凭据存入 `latch-devices/<hostId>.json`（safeStorage，0600），一台电脑一份，从不复制给另一台。成功后剪贴板里仍是这条链接时清除。
- **来源与分区。** 每台其他电脑的窗口是 `latch://h-<hostId>/`，在自己的会话分区 `persist:latch-host-<hostId>` 里：页面存储、缓存与协议处理互不相通。分区里的 `latch:` 只转发到这台 Host（`latch://app/` 与其他电脑的来源都得不到应答），渲染进程的请求、导航与子框都限制在自己的来源；预览与插件页面运行环境走 `latch-frame://h-<hostId>/preview/…` 与 `…/app/runtime.html`，只能被同一来源的页面嵌入，`html-script` 预览只在这台 Mac 的页面上提供。页面来自那台 Host 自己的 `dist/web`。
- **转发与证书固定。** 主进程用 Node 的 HTTPS（Node 自带根证书加系统信任库，不复用连接）按请求的来源选凭据，只附加那台 Host 的 Cookie `__Host-latch_<hostId8>`；页面带来的 Cookie、`Authorization`、`Origin`、`Referer` 与 `sec-*` 一律丢弃，响应里的 `Set-Cookie` 不交给页面。把凭据绑定到那台 Host 的是证书：添加时记下它的 SHA-256，与地址一起存在 safeStorage 加密的凭据文件里（`latch-devices/<hostId>.json` 的 `binding`，另有以设备私钥派生的 HMAC），`computers.json` 只用于列表显示，地址与加密记录不一致时按加密记录恢复；没有记录的证书时不按第一次见到的证书信任，状态为「证书变了」。之后每个请求由主进程先完成 TLS 握手，证书不是这一张就断开，请求（连同凭据）一个字节也不写出，所以地址在两次核对之间被换到另一台服务器也拿不到凭据。证书系统不信任或与地址不符时为「证书不受信任」，没有「仍然信任」。不带凭据的 `GET /health` 核对 hostId（每 60 秒最多一次，连接出错或证书不符后立即重来）：不一致时状态为「不是这台电脑」，不自动替换。证书换了（例如续期）时状态为「证书变了」，不发凭据。点「信任新证书」时，主进程经只接受这张新证书的连接请求 `POST /host-proof { nonce }`（不带凭据）：Host 返回自己身份密钥的公钥与签名，签的是 `latch-cert-proof-v1\n<hostId>\n<nonce>\n<Host 在这条连接上实际出示的证书的 fingerprint256>`（ECDSA P-256，IEEE P1363；共享向量 `packages/testkit/vectors/security-v1.json` 的 `signing.hostProof`）。hostId 本来就是这把公钥 SPKI 的 SHA-256（base32），所以主进程先核对公钥的哈希就是添加时的 hostId，再用看到的证书核对签名，一致才固定新证书并写回加密记录。没有身份私钥的服务器签不出；把请求转给真 Host 的中间人得到的是对真证书的签名。证明只依赖 Host 的身份私钥（`identity/host-key.pem`，0600，不进备份），不依赖设备凭据的哈希，所以泄露的 `auth/` 不足以让别人的证书被固定。没有这个路由（404）一律拒绝：报告 hostId 的 Host 都有它，所以界面写「请先更新那台电脑上的 Latch」，不提供跳过证明的办法。持有被固定证书私钥或 Host 身份私钥的一方不在防御范围内。事件流按流转发，主进程从中读取那台 Host 自己的 `host-state` 帧。主进程在 `renewAfter` 时续期（新凭据经 `Set-Cookie` 回到主进程）。写请求不重放：只在 Host 以 `renewal-required` 拒绝后重发一次。
- **远程页面能做的事。** 凭据、登记、配对链接、睡眠与停止报告、更新、会话文件与添加文件夹的路由在远程来源上一律 403 `shell-managed`。远程页面的 `latchShell` 只有 `{ kind: 'electron', remote: true, devMode, platform, computers: { list, subscribe, open, subscribeSession }, spaces: { onShow }, lights?: { end, fullScreen, onFullScreen } }`（`subscribeSession` 只收主进程要它打开的、它自己 Host 的会话 ID；`spaces.onShow` 只收菜单栏选的 `code` 或 `agents`，只回报一个布尔的 `latch:space:ready`，每个页面都有。macOS 的 `lights` 提供当前窗口的原生按钮留白宽度和全屏状态。仅窗口顶层页可查询所属窗口，变化也只发到该窗口，状态只有布尔值）：没有文件夹、文件、预览浏览器、生命周期、通知与更新，页面按没有本机外壳处理（与浏览器一致）；那台 Host 判定 `access.local` 为 false。这台 Mac 的页面另有 `add`、`cancelAdd`、`remove`、`trustCertificate`，列表里带地址、进行中的添加与其他电脑的等你处理（见下）；它的 `open(hostId, taskId)` 只打开主进程上次在那台电脑看到在等的会话，远程页面的 `open` 不带会话。`open`、`add`、`remove` 与 `trustCertificate` 只接受该页面一秒内的真实点按或按键；同一台电脑同时多次 `open` 只开一个窗口。其他电脑的页面得不到生命周期与更新的推送，打开外部链接总要先确认；Dock 图标总会找回这台 Mac 的窗口。跨电脑交给页面的只有电脑名、状态、上次在线、版本与 Host 宣布的停止原因；这台 Mac 的页面另得等你处理的会话 ID、标题、种类、开始等待的时间与运行数。
- **状态。** `online`、`connecting`、`offline`（带上次在线）、`stopping` / `sleeping`（来自 `host-state`，到 `retryAfter` 前不算离线）、`revoked`（那台 Host 撤销或凭据过期，本地凭据随即删除，只剩「移除」）、`wrong-host`、`cert-error`、`cert-changed`、`outdated`（`health` 没有 hostId 的旧版 Host，不发凭据）。有 Latch 窗口在前台时主进程每 15 秒、没有时每 60 秒看一次在线的电脑（`health` 后读快照，更新名称、版本与等你处理；窗口回到前台时，更远的下一次提前到 15 秒内），离线时从 15 秒退避到 5 分钟，`revoked` 不再看。这台 Mac 的 Host 照旧经 `host.sock` 读取。
- **等你处理与通知。** 主进程用每台电脑的已认证快照、按 `waitingCount` 的同一判定（`notifications.cjs` 的 `attentionOf`：审批、提问、未识别的请求与沉默的运行，已请求停止的不算）算出条目 `{ hostId, taskId, title, kind: 'approval' | 'question' | 'stuck', since }`：标题去掉控制、格式（含双向覆盖）、行与段分隔符和默认可忽略字符，截到 80 个码点，每台最多最新 50 条，另有运行数（上限 100,000）；会话 ID 不合格式的条目与不是对象的条目不列出，读不懂的快照被忽略，同一台电脑的读取一次一个、按顺序生效，读取出错也照常排下一次。页面收到的条目有一项不合格时只丢掉那台电脑的条目，列表照常。等你处理的变化只推给这台 Mac 的窗口；其他电脑的窗口只在它能看到的部分（名称、状态、版本，上次在线只在那台电脑不在线时给出、取整到分钟）与它上次读到或收到的不同时才收到推送。电脑名比较时按 NFKC、去掉不可见字符并忽略大小写，看起来相同的两个名字都加 hostId 前 4 位；拉丁字母与西里尔、希腊等有拉丁形近字的文字混写的名字总是加（汉字、假名与拉丁混写不算）。快照本身不交给任何页面，页面也从不提供文字。条目只进这台 Mac 窗口的列表（`@latch/protocol` 的 `ComputerSummary.waiting` 与 `running`）；其他电脑的窗口拿到的列表没有这两项（主进程不发，preload 也删掉），所以一台 Host 的页面得不到另一台 Host 的任何会话，Host 之间也互不知道。桌面和平板会话工作台的底部电脑行在电脑多于一台时变成菜单：每台的状态点、状态与等你处理数，选中即切到那台电脑的窗口，「管理电脑…」进入 设置 › 电脑。侧栏的项目与会话来自当前电脑，各行不重复写电脑名。「等你处理」在本机的会话之后列「其他电脑」：在线电脑每条一行，第二行写电脑名与等的种类，点开那台电脑的窗口并打开该会话；不在线的电脑只有一行灰色的「离线前 N 项」与上次在线，不是实时，点开切到那台电脑。电脑离线时保留离线前的条目，`revoked` 时清空。系统通知与 Dock 见 [NOTIFICATIONS.md](NOTIFICATIONS.md)。代价（接受并记录）：这台 Mac 页面里运行的代码（含与页面同权的旧面板）能读到其他电脑等你处理的标题，所以只给标题与种类，不给消息、路径、审批参数或项目；插件页面在隔离框里，拿不到 `latchShell`。
- **关于。** 这台 Mac 的「关于」在版本组里每台其他电脑一行，名称与它的 Host 版本；比 App 旧时加琥珀「版本较旧」，ⓘ 写在那台电脑上更新；不在线时写状态（为更新而停止时「正在更新」）。客户端从不触发远程更新或重启。
- **移除。** 能以原身份连上时先 `DELETE /devices/current` 撤销这台设备；然后删除凭据文件、列表记录与分区存储，并关闭这个分区里的所有窗口。没能撤销时页面写「在 <名称> 的 设置 › 设备 里移除这台设备」。不在列表中的 `Partitions/latch-host-*` 在下次启动时删除。
- **更新与确认。** 桌面端只更新这台 Mac 的 Host；其他电脑的更新、重启、插件与模型密钥都在那台电脑上进行。本机确认留在各自的电脑上。
- **iPhone/iPad。** 选中的电脑保持完整工作台（`NativeWorkspace`：正文窗口、SSE、Face ID 规则不变）；其他电脑由核心的 `NativeListWatcher` 各开一个只读连接，用那台电脑自己的登记、连接密钥与签名连接簿（Bonjour、新配对的局域网提示、它自己的中继），只发 `GET /link/api/native/revocation` 与正文窗口外豁免的 `GET /link/api/snapshot`：不开正文窗口、不读详情、不订阅 SSE、不发任何写入（连撤销回执也不发）。读到绑定那台电脑与本设备、由其 Root 签名的撤销证明时，交给与选中电脑相同的清除（资料、密钥与加密缓存），之后不再拨这个身份。前台每 15 秒读一次，同时最多 3 个连接，更多时每 60 秒换下一批并关闭离开这一批的连接；连不上的电脑按 15 秒起翻倍、最多 5 分钟退避，单次拨号与读取都有时限；切到后台与锁定时全部关闭，网络变化时关闭全部连接后重读。拨号失败（传输层对所有失败给同一种错误）只算不在线；只有快照里的设备 ID 不是本设备时才是「不是这台电脑」，并且不显示它的任何条目。快照只留行字段（`id`、`title`、`status`、`updatedAt`、`archived`、`pendingQuestions` 与 `live` 的 `activity`、`silent`、`lastEventAt`、`unrecognized.at`），并核对设备 ID；每次读取在每个等待之后核对它所属的 `watch` 令牌，切换中迟到的快照丢弃。等你处理按 `PhoneSessions.waitsOnYou` 同一判定（`PhoneComputers`），每台最多最新 50 条，标题去掉不可见字符后截到 80 个码点；电脑名按桌面端规则加 hostId 前 4 位。会话列表顶部的电脑菜单每行写状态（在线、正在连接、不在线 · 上次在线 10:42、已被移除、不是这台电脑）与等你处理数；「等你处理」下的「其他电脑」在线时每条一行（第二行电脑名与种类），不在线时一行灰色「离线前 N 项」；点开先切换电脑，就绪后再打开会话，切换中被新的点按或切换取代的不再打开。设置 › 通知 的「其他电脑等你处理时通知」默认关，打开时请求系统权限，只在 App 在前台时对非选中电脑新出现的条目发本地通知，正文固定「<电脑名> · 有新的等你处理」，不写会话标题，通知只带随机 ID、去向只在进程内存，点按切换并打开（App 刚回到前台、资料尚未打开时先记下，打开后再处理）；锁定与移除电脑时撤下已送达的通知；后台推送尚未开通。

## 多端同步

Host 约每 40ms 合并一次变化，把选中会话的 `task-state` 推送给订阅它的连接；浏览器与本机 Electron 明确协商后，同一运行与消息的正文前缀延长可改发 `task-delta`，其他事实及终态仍发完整状态。流影子基线独立于 HTTP，按订阅序号和 UTF-8 偏移校验，再经过原实例、版本与选择门禁；权限改变或连接关闭清掉有界基线，异常帧最多触发一次中断后的完整状态修复。原生链路保持完整帧与既有有界 replay，其他会话仍只在摘要或审批变化时通知列表失效。浏览器重连通过 HTTP 重新同步，不重放历史；断开 SSE 不取消任务。完整机制见 [STREAMING.md](./STREAMING.md)。

**流量计数。** Host 在内存中计数自己发出的字节：事件流每一帧的文本，以及快照与会话详情的响应体（不含 HTTP 头、分块编码与 TLS），按类别给出次数、字节与 9 档大小分布，并按会话、按事件流汇总，重启清零。计数只含数字、时间、入口类别与会话 ID。`GET /traffic` 与 `pnpm latch traffic` 读取它（[STREAMING.md](./STREAMING.md#流量计数)）。

## HTTP API

接口根为 `/link/api`，这是本项目的内部协议，暂不承诺版本兼容。访问检查顺序：Host 与来源检查 → 认证 → 权限 → 入口规则 → 本机确认（只有少数操作）→ 审计 → 执行；排队或等待确认的请求在执行前按设备当前记录重新检查。

路由分在 `server.ts` 与 `apps/host/src/routes/` 的模块中。`handleApi` 按 `routes/index.ts` 的次序在四处询问模块：任何路由之前的连接检查（文件传输连接只取它的文件，被撤销的手机只能读撤销通知，配对连接只能登记）；健康检查与运行状态路由之后、认证之前的无需凭据的路由（登记、凭据续期）；认证之后、拒绝匿名 `host.sock` 调用之前（原生连接的验证窗口）；以及所有检查（含匿名调用与个人会话的数据范围）之后、`server.ts` 自己的路由之前。每个路由的入口、权限与限速检查在它所在的模块中，`apps/host/test/route-guards.test.ts` 逐个核对。错误体为 `{ error, message, ...details }`（`required`、`allowed`、`confirmation`、`stepup`、`retryAfter`、`target`、`legacyName`、`decidedBy`）；429 同时带 `retry-after` 响应头，输入校验失败为 400 `invalid-input`。

| 方法与路径 | 权限 | 说明 |
| --- | --- | --- |
| `POST /host-proof` | 无（只在 HTTPS 入口；按对端地址限流） | `{ nonce }` → `{ publicKey, signature }`：Host 身份密钥对本连接证书的签名，见「桌面端与其他电脑」的证书固定 |
| `GET /health` | 无 | `{"ok":true,"hostId":"…"}`；hostId 本来就公开（回环主机名与 `enrollment-info` 都带它），桌面端向另一台电脑发送凭据前用它核对身份 |
| `GET /host-info` | 无（仅 `host.sock`） | Host 实例信息 |
| `POST /host/state` | 无（仅 `host.sock`；桌面端页面经转发时主进程返回 403） | 报告睡眠、唤醒、即将停止的原因与桌面端正在保持唤醒的原因（见「Host 的生命周期」） |
| `GET /enrollment-info`、`POST /enrollment-invitation`（这条链接允许申请的权限，其中是否有 `admin`，不用掉它；限流；手机连接拒绝）、`POST /enrollments`、`GET/DELETE /enrollments/:id`、`POST /enrollments/:id/complete` | 无（同一入口与来源；完成需签名） | 设备登记。新设备报的名称与一台未移除的设备相同时，Host 在创建请求时给它加「 (2)」等序号，再交给系统确认表单；名称加上序号超过表单设备名称的 20 个字符时，先截短序号前面的部分，序号总在表单里可见。迁移旧设备的名称不加序号 |
| `POST /login`、`POST /pair` | — | 410 `login-removed` |
| `POST /credentials/challenge`、`POST /credentials/renew` | 设备（含待续期） | 凭据续期 |
| `GET /snapshot`、`GET /events?sessionId=`、`GET /tasks/:id` | `view` | 状态、事件流、详情 |
| `GET /customization` | `view` 或匿名 `host.sock` | 外观文档、修订与历史。快照带 `customization: { revision, doc }` |
| `POST /customization`、`POST /customization/restore` | `admin` | 按 `requestId` 与 `baseRevision` 应用或回退，先审计，无本机确认 |
| `POST /customization/reset` | `admin` 或匿名 `host.sock` | 按原请求编号和基版恢复默认，审计失败仍可重置。见 [CUSTOMIZATION.md](CUSTOMIZATION.md) |
| `GET /workspaces` | `view` | 项目列表：启动目录与已保存的项目，含文件夹与各自的不可用原因 |
| `GET /workspaces/:id/worktree` | `run` | 新工作树会从哪里开始：`{ branch?, commit }`，或 Host 不能在这个项目里新建工作树的 409 与原因；不写任何东西 |
| `GET/POST /workspaces/:id/terminals` | `host.sock`、`run`、数据范围 `all` | 列出项目终端，或在项目主目录打开一个终端。项目 ID 为 `default` 时使用 Host 的启动工作目录。终端详情、输入和关闭沿用 [终端 API](TERMINAL.md) |
| `POST /tasks/:id/files/resolve` | 桌面端（`host.sock`）+ `view` + 数据范围 `all` | 解析消息里提到的文件，最多 64 条；给句柄与裁决，不给真实路径（见「会话文件」） |
| `POST /files/:handle/local` | 句柄所属的桌面端；打开另需 `run` | 先审计 `file.reveal`、`file.quicklook` 或 `file.open`，再给真实路径；页面经桌面端代理请求时 403 `shell-managed` |
| `PUT /tasks/:id/files/:handle` | 句柄所属的设备 + `run` + 数据范围 `all`；能向会话输入（私有会话、只读会话照常拒绝）；受保护的工作区路径另需 `approve:elevated`，程序目录里的文件一律拒绝 | 人在预览里编辑并保存一个 UTF-8 文本文件：`{ requestId, baseHash, content }`，文件不再是 `baseHash` 时 409 `file-changed`（带 `currentHash`），会话或同一文件夹里有一轮在运行时 409 `file-turn-running`；先审计 `file.edit` 再写，见 [DOCUMENT-PREVIEWS.md](DOCUMENT-PREVIEWS.md#编辑) |
| `POST /tasks` | `run` | L3 写两条启动审计，不弹确认；带 `via` 时是插件页面开始会话，先按已应用清单核对页面与能力，见 [APP-PAGES.md](APP-PAGES.md#会话) |
| `GET /app-modules/:pluginId/:appId/:bundleHash.js` | `view`；页面的修订、启用与批准照常核对 | 页面的模块字节（`no-store`，旧哈希 404 `app-module-not-found`），只由父页面取来交给页面框，见 [APP-PAGES.md](APP-PAGES.md#页面框) |
| `GET /apps/:pluginId/data…`、`PUT/DELETE /apps/:pluginId/data/:scope/:key`、`POST /apps/:pluginId/data/migrate[/lease]`、`GET/POST /apps/:pluginId/diagnostics`、`GET /apps/:pluginId/pages/:appId/lookup/:requestId`、`GET /apps/:pluginId/pages/:appId/sessions/:id/last-reply` | 读与诊断：`view`；写与迁移：`run`；都先核对页面的修订与能力，会话与私有会话的数据照常要求能读 | 插件页面的数据、迁移、诊断与它开始的会话，见 [APP-PAGES.md](APP-PAGES.md) |
| `GET /handoffs?sessionId=`、`GET /handoffs/:id`；`POST /handoffs`、`POST /handoffs/:id/return`、`POST /handoffs/:id/withdraw` | 读：`view`；新建、交回、撤回：`run`；都要能读相关的会话 | 交接，先写审计再新建或交回，见 [HANDOFFS.md](HANDOFFS.md) |
| `GET /history/sources?projectId=`、`POST /history/list`、`POST /history/previews`、`DELETE /history/previews/:id`、`POST /history/imports`、`GET /history/imports/:requestId` | `run` + 数据范围 `all`；不弹确认 | 接入已有会话：列出 Harness 自己的会话（只有元数据）、一次显式加载的只读预览、幂等接入 `{ requestId, previewId | handle | fromTaskId, harnessId? }`（没有 `prompt`）；按文字重建的会话不开始一轮，等这个人的第一条消息才把带上的文字发出（`CreateTaskInput.seed`，只限 ACP Harness）；每一步先写审计，见 [HARNESSES.md](HARNESSES.md#接入已有会话) |
| `GET /tasks/:id/review-notes`；`POST /tasks/:id/review-notes`、`…/:noteId/edit`、`status`、`delete`、`…/send` | 读：`view`；写与发送：`run`；都要数据范围 `all`，写与发送另过会话输入的检查 | 行级反馈；发送走 `POST /tasks/:id/prompt` 的同一条路径，见 [CHANGES.md](CHANGES.md#行级反馈) |
| `POST /tasks/:id/prompt` | `run`；带 `via` 时只限这个页面开始的会话 | 只看设备权限，L3 会话也可以从任何设备输入；会话的文件夹已不在项目中时 409 `workspace-changed`，项目不可用时 409 `workspace-disabled`；我的 Agent 的会话里以「记住」开头的消息另建一条记忆提议，被拒绝时回答带 `memoryRefused`（`POST /tasks` 开始这样的会话时同样） |
| `GET /custom-agents/:id/results`、`…/activity`、`…/library` | `view`，数据范围 `all` | 等着话题的定时结果卡、动态与资料库，只读 Host 已有的记录，`before` 翻页，见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#界面) |
| `GET /custom-agents/:id/proposals`；`POST /custom-agents/:id/proposals/:pid/save`、`…/dismiss`；`POST`、`DELETE /custom-agents/:id/memories/:mid/undo` | 读：`view`；保存、不要、撤销与清除：`run`；都要数据范围 `all` | 记忆提议、撤销与清除已删除的文字，带 `requestId`（撤销与清除另带 `baseRevision`），先审计再写，重试只按回执回答，见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#记忆提议) |
| `POST /tasks/:id/config` | `run` | 放宽权限模式写 `task.mode.widened`；`{configId,value,requestId?}`，新客户端按 `configReceipts` 保留原请求 |
| `GET /tasks/:id/config-requests/:requestId` | 原设备的 `view`；个人数据与手机正文门禁仍适用 | 只返回 `state`，不返回配置原值、不重新调用 Agent |
| `DELETE /tasks/:id` | `run` | |
| `PATCH /tasks/:id` | `run` | 重命名、置顶、归档；会话还有终端时归档可能被拒绝（见 [TERMINAL.md](./TERMINAL.md)） |
| `GET /tasks/:id/git`、`POST /tasks/:id/git/{stage,unstage,commit,push}` | 读：`view` + 数据范围 `all`；暂存与取消暂存：`run` + `all`；提交与推送：`run`，私有会话另需 `all` | 交付：仓库状态、按文件暂存、提交（默认运行钩子）、推送到上游或 `origin`；提交、推送与有 filter 时的暂存以你的账户运行你的 Git，先写审计，见 [GIT-DELIVERY.md](GIT-DELIVERY.md) |
| `GET /tasks/:id/git/{diff,history,compare}`、`GET /tasks/:id/git/history/:sha`、`POST /tasks/:id/git/{stage-lines,unstage-lines}` | 读：`view` + 数据范围 `all`。写：`run` + `all` | 历史只读 HEAD 的祖先。暂存由 Host 核对工作区、HEAD 与索引后按选择的行更新索引，见 [GIT-DELIVERY.md](GIT-DELIVERY.md#按块与按行暂存) |
| `GET /tasks/:id/git/pr`、`POST /tasks/:id/git/pr`、`GET /tasks/:id/git/pr/checks/:job/log` | 读 PR：`view`（评论与默认标题另需 `all`）；创建或绑定：`run`，私有会话另需 `all`；检查日志：`view` + `all` | 交付的 PR：以你的账户运行你的 `gh`，建前先按分支查找已开的 PR 并绑定，先写审计；检查与评论只读，见 [GIT-DELIVERY.md](GIT-DELIVERY.md#pr-与检查) |
| `POST /tasks/:id/cancel` | `view` | `{ requestId?, runId? }`，回答取消的回执 |
| `POST /tasks/:id/stop-subagent` | `view` | `{ subagentId }`，单独停止一个宣告能单独停止的子 Agent，先写 `task.subagent.stopped`，见 [HARNESSES.md](./HARNESSES.md#子-agent) |
| `POST /tasks/:id/keep-waiting` | `view` | `{ runId, thresholdMs }`，让这次运行晚一些再说沉默，见 [STREAMING.md](./STREAMING.md#运行的真实状态) |
| `GET /traffic` | `admin` 或匿名 `host.sock` | 流量计数（只读） |
| `POST /approvals/:id` | 拒绝：`view`；允许 R1：`approve:standard`；允许 R2：`approve:elevated`；允许 L3 询问：`run` | `{ decision, optionId?, requestId?, note? }`（`note` 只随拒绝，只交给 `capabilities.permission.rejectionNote` 为真的 Harness；交给它时另需 `run`，因为它是给模型的输入）；允许时会话目录已离开项目返回 workspace-changed |
| `GET/DELETE /confirmations/:id` | 发起确认的设备 | 查询或取消本机确认 |
| `GET /audit/head`、`GET /audit/hash?seq=` | `view` | 审计检查点 |
| `PATCH /devices/current`、`DELETE /devices/current` | `view` | 重命名、撤销本设备 |
| `GET /devices`、`DELETE /devices/:id` | `admin` 或匿名 `host.sock` | 设备列表、撤销（级联复核）；撤销当前设备需用 `/devices/current` |
| `PATCH /devices/:id` | `admin`；授予需桌面端 + 本机确认 | 调整权限与数据范围 |
| `POST /native/pairings`、`GET`/`DELETE /native/pairings/:id` | 本机 `host.sock` 的 `admin` 设备 | 手机配对二维码：打开局域网入口后签发（无网络时 409 `native-no-lan`，完全访问时 409 `presence-blocked`）、跟随状态、撤销；`DELETE /native/pairings/:id/device` 移除确认后被否认的设备 |
| `PATCH /devices/:id/name` | 桌面端 `admin` | 重命名任一设备 |
| `POST /pairings` | 桌面端 `admin` 或匿名 `host.sock` | 生成配对邀请 `{ scopes?, target? }`：`target` 为 `tls`（默认，另一台电脑或手机；未配置 HTTPS 入口时 409 `tls-not-configured`）或 `loopback`（这台电脑上的浏览器）。桌面端只由主进程调用，页面经转发一律 403 `shell-managed` |
| `GET/POST /providers`、`PUT/DELETE /providers/:id`、`GET/PUT /provider` | `admin`；填写密钥另需 `secrets`（只在桌面端）；确认地址（`confirmOrigin`）只在桌面端，经本机确认 | 模型服务；`GET /providers` 另返回 `confirmedAddresses` 与本次运行放行的源 `runOrigins`，每个服务带 `destination` |
| `POST /provider-origins` | `admin`，只在桌面端；尚未确认的地址经本机确认 | 保存服务之前确认一个模型服务地址 |
| `POST /providers/:id/models`、`POST /provider-checks` | `admin` | 经出站策略获取模型列表、检测连接；用已保存的密钥时只发往已确认的地址 |
| `GET/POST /agents`、`PUT/DELETE /agents/:id` | `admin`；新增与改命令、参数、变量要 `host.sock` 与本机确认 `harness.command.apply` | ACP Agent 定义；环境变量只返回名称，预设带命令检测结果，`started` 说明是否已以当前定义开启过 L3 会话 |
| `GET /mcp/servers`；`POST /mcp/servers`、`PATCH`/`DELETE /mcp/servers/:id`、`POST /mcp/servers/:id/test` | 读：`view`；写：`host.sock` 的 `admin`（停用任何 `admin` 设备） | Latch 的 MCP 服务器，值从不返回；新增与放宽要本机确认 `mcp.server.apply`，见 [MCP.md](./MCP.md) |
| `POST /mcp/servers/:id/oauth/login`、`POST /mcp/servers/:id/oauth/logout` | `host.sock` 的 `admin` | 远程 MCP 服务器的登录与退出登录；新的授权服务器或更宽的范围要本机确认 `mcp.server.apply`；其他设备只在 `GET /mcp/servers` 里看到状态，见 [MCP.md](./MCP.md#登录) |
| `GET /mcp/import?project=<ID>` | `host.sock` 的 `admin` | 从项目导入：读项目的 `.mcp.json` 作数据，什么都不运行，见 [MCP.md](./MCP.md#从项目导入) |
| `POST /agents/:id/mcp` | `run` | 读取 Harness 自己的 MCP（现在只有 Codex 直连），结果在 `HarnessInfo.ownMcp`，见 [MCP.md](./MCP.md#harness-自己的-mcp) |
| `POST /agents/:id/catalogue`、`PUT /agents/:id/models` | `run` | 不开始会话读一次 Harness 的模型与选项 `{ auto?, model? }`，返回 `{ ran, catalogueRead }`；保存自己填写的模型 ID `{ models }`。见 [HARNESSES.md](./HARNESSES.md#开始前的选项) |
| `POST /harnesses/:id/login-status`、`POST /harnesses/:id/logout`、`POST /harnesses/:id/login-terminal` | `run`；打开终端只在桌面端 | 登录状态 `{ status, label?, expiresAt? }`、请 Harness 退出登录、在这台电脑的终端里运行它的登录 `{ method?, terminal? }`：带 `terminal` 时在 Latch 自己的终端里（另需数据范围 `all`，见 [TERMINAL.md](./TERMINAL.md#登录命令)），不带时用默认终端。见 [HARNESSES.md](./HARNESSES.md#登录) |
| `GET /enrollments` | 桌面端 `admin` | 仍在等待的登记及其指纹与系统表单的理由；以及会挡住新配对的完全访问会话。页面已不读取它，配对表单跟随 `GET /native/pairings/:id` |
| `GET /native/info`、`POST /native/relays`、`DELETE /native/relay-requests/:id`、`DELETE /native/relays/:id` | 本机；写入需要 `admin`，添加需要本机确认 | 自建中继的状态、验证与移除。添加用 `{requestId, profile?}`；同号可以继续验证，存下注册回执前不签发新地址。配置不返回注册令牌或种子，见 [RELAY.md](RELAY.md) |
| `POST /folder-grants` | 桌面端 `admin` | `{ nonce, expiresAt }`：一次添加文件夹的 nonce |
| `POST /workspaces`、`POST /workspaces/:id/folders` | 桌面端 `admin` + 签名 | `{ nonce, via, paths, name? \| replace?, signature }`：添加项目（201）、加入或重新选择文件夹（200），返回 `{ workspace, refused }`；`POST /workspaces` 也接受 `{ nonce, via: 'session', sessionId, signature }`，把会话自己的文件夹存为项目（201） |
| `PATCH /workspaces/:id` | `admin` | `{ name?, glyph?, order? }`：重命名、图标、文件夹顺序（第一个是主文件夹） |
| `DELETE /workspaces/:id/folders/:folderId`、`DELETE /workspaces/:id` | `admin` | 从项目中移除文件夹、移除项目（文件不删除） |
| `GET /plugins`、`POST /plugins/:id`、`PUT /preferences` | `admin` | 插件列表与启停、新会话默认值；`pinned`（这台电脑上的新会话都从这个 Harness 与模型开始；它们用不了时快照里不带 `pinned`）与它固定之后的 Harness、模型只能经 `host.sock` 修改，因为固定的 Harness 可以是完全访问的 |
| `GET /policy`、`PATCH /policy` | `admin`；加入出站地址需桌面端与本机确认 | 安全策略及其哈希；放宽只有 `hostEgressAllow` 一项 |

`/link/` 下的静态页面在所有入口上无需认证（Host 与来源检查照常）。不是页面的地址（例如把回复里的文件名当链接打开的 `/link/report.md`，或 `/link/` 之外的路径）返回 404 的普通 HTML 页面「找不到这个页面」，带回到 `/link/` 的链接：它不回显请求的路径，不运行脚本（[not-found.ts](../apps/host/src/not-found.ts)）。`/link/api/` 下的路径仍返回 JSON 错误。没有凭据的 `host.sock` 连接只能调用健康检查、`host-info`、运行状态报告、登记、设备列表、撤销设备、生成邀请与读取流量计数，以匿名命令行身份审计。

创建与输入的 `requestId` 必须是 UUID，prompt 去除首尾空白后最多 16,000 字符。请求体上限：创建会话与输入 256 KiB，模型服务、Agent 定义与添加文件夹 128 KiB，其他 32 KiB。

## 兼容标识

为兼容已有数据，改名必须附带迁移。根包与它的 Vitest 项目已从 `harness-link` 改名为 `latch`，浏览器存储键的前缀从 `harness-link.` 改为 `latch.`，迁移如下：

- **程序目录。** `findCodeRoot` 认根包名 `latch`，也认改名前的检出中的 `harness-link`，程序目录保护照常生效。
- **插件 SDK。** 入口写作 `latch/plugin-sdk` 与 `latch/harness-sdk`；以旧目录名 `harness-link` 安装本包的插件写 `harness-link/…`，同样可以编译（`tests/plugin-sdk.test.ts`）。
- **浏览器存储。** `apps/web/src/core/storageKeys.ts` 的 `readStorage` 在新键没有值、旧键有值时，把值复制到新键并删除旧键，只发生一次；新键已有值时以新键为准，旧键不动。偏好、模型选择、已读标记、输入框的选择、选中的会话与 Host 尚未确认的提交（保留原 `requestId`）都不会丢失。

以下名称保持不变：`/link/` 路径前缀（已配对的手机与书签使用它）、数据目录布局（含旧的 `.runtime`）、模型服务 ID `openai-compatible`。旧 Cookie `harness_link` 只用于识别需要重新确认的旧浏览器。Cordis 固定在 `4.0.0-rc.12`，升级前需回归插件生命周期。

早先的构建有个人助手、助手群聊与它们的定时任务，Latch 已不再提供它们，数据不删除也不迁移：

- **会话。** 它们跑过的会话在 `TaskSummary.personal` 上带着归属（`sessions-meta.json` 与内置 Harness 的记录都留着这个字段）。这些会话算作私有，只对数据范围为 `all` 的设备开放，列表里照常出现，打开只能查看：发消息、排队、改设置、回答问答、批准工具调用、添加附件与撤销改动都回答 409 `session-read-only`；分叉出的新会话同样是私有的。早先构建发给助手的消息（新建会话带 `assistantId`）回答 409 `assistant-removed`，不会当作普通会话开始；iPhone 不再提供重试这类未确认的提交，也不再提供重试早先构建写到 `/link/api/personal/` 的提交（群聊消息、定时任务与助手的改动，Host 已没有这些接口），直接从待确认的写入里删除。
- **审计。** 审计动作表保留 `personal.changed`（`apps/host/src/audit-actions/personal.ts`），否则带这一行的审计链在启动时校验失败，Host 不能启动。
- **数据目录。** `personal/` 仍在私有目录列表 `PRIVATE_ENTRIES` 中；`policy.json` 的 strict schema 不变。

数据目录里还可能有三个 Latch 不再使用的标识，照样能读，数据不删除也不迁移，启动时不改写任何文件：

- **模型服务的协议 `gemini`**（`RETIRED_PROVIDER_KINDS`）。`providers.json` 里这样的服务原样读回、原样写回；它不注册 Provider，不在目录里，`unusableProviders` 以 `unsupported` 列出，界面写「不再支持」。给它开会话、改它或读它的模型列表返回 409 `provider-unsupported`，没有请求发往它的地址；只能移除，密钥随之删除。指向它的「出错时改用」与默认模型按已不在的服务处理。设备提交这个协议一律 400。
- **Harness 预设 `gemini`**（`RETIRED_AGENT_PRESETS`）。`settings.json` 里带这个 `presetId` 的定义保留，Driver 照常挂载以便读取它的会话：状态是不可用，写「<名称> 不再支持，已有会话只能查看」；会话可以看、可以删，新开或继续返回 409，命令不被查找也不被启动（`harness-retired`），也不按命令名套用别的预设。绑定它的 Agent 与定时任务同样不运行，不换用其他 Harness 或模型。
- **会话路由的协议 `gemini`**。`acp.json` 里保存过的路由照样读回；继续这样的会话时在打开路由处被拒绝（409 `model-route-unsupported`），网关不为它签发凭据，它的路径与密钥头也到不了任何服务。

回归用例在 `apps/host/test/retired-data.test.ts` 与 `apps/host/test/model-gateway.test.ts`。

## 尚未实现

| 项目 | 原因 |
| --- | --- |
| `host.sock` 对端进程身份检查、按会话标记识别进程 | 需要签名的原生扩展 |
| 桌面端的侧栏电脑菜单、所有电脑合并的等你处理、其他电脑的通知与 Dock 角标、关于页的远程版本行 | 尚未实现：分步构建中；目前在 设置 › 电脑 里打开每台电脑自己的窗口 |
| 浏览器里的多台电脑、桌面端经原生链路或中继连接其他电脑、跨电脑会话、iPhone/iPad 后台时的其他电脑通知 | 不提供或尚未实现：浏览器保持严格同源；桌面端只走运营者证书的 HTTPS |
| 回环请求的额外绑定值或设备签名 | 未实现（见「不防御的情况」） |
| Linux（polkit）与 Windows（Windows Hello）本机确认 | 未实现；这些系统上本机确认不可用，可用离线连接码登记桌面端，回环与 HTTPS 上的登记无法完成 |
| 在 macOS 以外从桌面端打开浏览器 | 未实现；改用 `pnpm latch device invite --loopback` |
| 无界面服务器的确认通道（独立系统用户、命令行确认） | 未实现，`policy.json` 的 `operators` 被忽略；Linux 服务器建议用独立系统用户运行 Host |
| 打包的桌面端与登录项 | 尚无打包构建：「登录时打开 Latch」的登录项只能登记打包后的 Latch.app，开发运行时不可用；打包版以无参数启动时使用默认数据目录也未实现 |
| Electron fuses、签名安装包、asar 完整性、Secure Enclave 设备密钥 | 尚无打包构建；当前为开发版 |
| 系统 Keychain 保存 Host 身份与密钥 | 需要签名的 Host 程序；目前为数据目录内的 0600 文件 |
| 远程客户端的公钥固定、仅 mTLS 入口、证书自动申请与续期、可信反向代理配置 | 未实现；证书由运营者提供并续期（文件更新后 Host 自动重新加载），只检查有效期与主机名；从不读取代理请求头 |
| 操作系统沙箱、Agent 出站代理、项目配置中和、托管安装 | 未实现；因此每个 ACP 与插件 Harness 会话都是 L3 |
| Standard 的 L0 / L2 级别与级别选择 | 未实现；Standard 固定为 L1，L0–L2 只是 `policy.json` 中 `unattended.maxLevel` 的取值：低于 L1 时定时任务不能开启或运行 |
| `write_file` 基于原内容哈希的并发检查 | 未实现 |
| 自动批准规则 | 未实现；`unattended.allowAutoApproveRules` 与 `unattended.approvalTtlHours.acp` 只保存。无人值守运行（定时任务）检查 `unattended.maxLevel` 与 `pauseAfterIdleDays`，在每个审批处停下，超过 `approvalTtlHours.standard` 后取消，不自动批准 |
| 在其他设备上查看会话文件（预览列、句柄内容、`work` 设备的引用集合、远程读取的上限与审计） | 未实现；目前只有桌面端经 `host.sock` 在访达中显示、快速查看与用默认应用打开，其他设备上路径标记的菜单只有「复制路径」，并写明在运行 Latch 的 Mac 上用桌面端打开 |
| Windows 上用默认应用打开 | 未实现；还没有核对 Windows 的文件关联，只提供在资源管理器中显示 |
| 阻止 `policy.json` / `settings.json` 的带外修改 | 只检测并审计，不阻止 |
| 审计与操作在同一事务中提交 | 目前为「先审计再执行」的 JSONL；执行失败时尽力补记 `action.failed` |
| 降级导出 | 未实现；回退旧版需要自行恢复升级前的备份 |
| 页面中的项目界面：编辑项目（添加与移除文件夹、调整顺序与设为主文件夹、重新选择、重命名与图标）、新会话选择器里的文件夹信息、侧栏按 `workspaceId` 分组、项目弹层里的文件夹，以及会话菜单的「存为项目…」 | 尚未实现；Host 的接口与桌面端的 `latchShell.folders` 已可用，页面目前每个项目只显示主文件夹 |
| 在手机、其他电脑或本机浏览器上添加文件夹（包括 Host 端的目录浏览） | 不提供：加入文件夹就是授予权限，只在 Host 所在电脑上进行 |
| 跟随移动或改名的文件夹（书签、按身份追踪），运行中会话的文件夹变化 | 未实现；Latch 不是 App Sandbox 构建，Electron 只为 Mac App Store 构建创建安全范围书签 |
| 按设备或文件夹的项目授权、只读文件夹、按文件夹的 Standard 风险级别 | 未实现；设备权限对所有项目生效 |
| 原生中继、端到端连接与推送通知 | Host 直连与中继已接入授权与会话；Mac 可生成二维码、管理正文窗口与[自建中继](RELAY.md)。新增地址目录的入口、官方中继、可安装手机 App 与推送尚未提供 |

尚未在真机上验证：Host 进程遇到 macOS「隐私与安全性」（TCC）时的行为与提示、外接与网络卷上的「在访达中显示」、iCloud「桌面与文稿」文件夹的真实路径。

其他限制：外部 Harness 与 Standard 分别保存历史，会话不能在 Harness 之间迁移；运行中的任务不能迁移到其他电脑。每次状态推送包含选中会话的完整消息列表，长会话的带宽随历史增长；没有分页或虚拟列表。没有附件上传。

## 会话搜索与批处理

Host 通过 `catalog.features.search` 与 `sessionBatch` 声明支持。`POST /link/api/search` 接收正文 `{q, limit?}`，需要 `view`；查询不写入 URL、日志或磁盘索引。它只检索用户和助手正文，包含已归档会话，不检索工具参数、工具输出或 reasoning。结果最多 30 条，每条是原会话和消息 ID、160 字符片段与片段内匹配范围。搜索预算为一秒；超时或结果未穷尽时返回 `truncated`。空闲会话以更新时间缓存，运行与等待中的会话每次重新读取；缓存最多 500 个会话、1000 万字符，超过单会话缓存限额时只检索而不缓存。删除或当前不可见的会话不从缓存返回。

`POST /link/api/tasks/batch` 接收 `{action: 'archive' | 'unarchive' | 'delete', ids}`，需要 `run`，最多 100 个 ID。Host 去重并逐项返回成功或错误；删除沿用单个会话的权限和运行状态检查，归档与删除沿用终端的检查（[TERMINAL.md](./TERMINAL.md)）。每次异步等待之后重新检查设备授权，部分失败不回滚已完成项。归档只改变记录可见性；删除记录不删除项目文件。

## 桌面通知

桌面主进程自行经已认证的 `host.sock` 代理读取快照，检测运行结束和新增待处理请求；首次快照只建立基线。页面不提交通知正文或标题，只能读取或设置三个布尔偏好：完成、待处理、包含标题。偏好以 0600 文件保存在桌面用户数据目录；默认全部关闭。首次后台完成或失败持久记录 pending，客户端在前台提供开启／不用；选择与偏好串行原子保存，跨重启不重复询问。开启后也只在应用没有前台窗口时发出。系统不支持通知时设置会说明；系统是否实际展示或被专注模式抑制，Electron 无法可靠判定。

通知正文使用主进程固定文字，标题默认只写 Latch；用户开启标题时才使用已认证快照的会话标题，去控制字符并限制长度。每个会话十秒内最多一次；点击只把该快照里的会话 ID 交回应用。Dock 徽标独立于通知偏好，只显示待处理请求数。断连或鉴权失败不发通知。取消、中断不会误报完成，失败使用固定失败模板。持久化、旧壳兼容和有限事件合同见 [NOTIFICATIONS.md](./NOTIFICATIONS.md)。

桌面端自身的更新由主进程完成：固定的签名更新源、下载校验，以及安装前经 `host.sock` 进入 Host 的安装窗口（新会话开始 409 `host-updating`，已有工作照常结算）。页面只得状态视图。见 [UPDATES.md](./UPDATES.md)。

## 提示模板

提示模板独立保存在数据目录的 `prompt-templates.json`，由 `PromptTemplateStore` 校验并原子替换；每次写盘成功后才更新内存，串行写入失败不会污染后续请求。最多 200 条，名称 80 字符、内容 2 万字符，适用范围是所有会话、某个项目或某个 Agent。Host 声明 `features.promptTemplates`，并以可选 `promptTemplatesVersion` 通知客户端重新读取；流式消息更新不重复请求模板列表。

`GET /link/api/prompts` 需要 `view`；`PUT /prompts/:id` 和 `DELETE /prompts/:id` 需要 `admin`，执行写入前再次检查设备授权。稳定 ID 的 PUT 是完整替换，同一内容重试不新增记录；重复 DELETE 也成功，所以写超时可复用原 ID 与请求体。模板不会修改权限、执行工具或自动发送请求；客户端按当前项目与 Agent 过滤，选择后替换开头的 slash 词项并保留剩余草稿，发送仍走正常确认与权限流程。

## 用量汇总

`catalog.features.modelUsage` 声明用量账本的汇总 `POST /link/api/model-usage`、单价与预算 `GET /link/api/model-spend`（都要 `view`）及 `PUT /link/api/model-prices`、`PUT /link/api/model-budgets`。写入需要 `admin`，Agent 预算同时需要 `all` 数据范围。写入携带请求 ID 和读到的基版，回执可用于核对未知结果。见 [MODEL-GATEWAY.md](./MODEL-GATEWAY.md#用量花费与预算)。`catalog.features.usage` 声明 `POST /link/api/usage {days: 7 | 30}`，需要 `view`，异步读取前后重新检查授权。Host 只统计期间内带有效时间的助手消息实际记录的 `usage`；按 Harness、该消息记录的模型服务与模型分组，不用会话当前模型替代历史上缺失的身份。输入包含缓存、输出包含推理，细分字段只有同组每条参与记录都完整报告且总和可安全表示时才返回；缺失、无效或溢出的拆分省略并以 `partial` 标记，不把部分合计当作完整数字。真实零值保留，页面对省略值写「未报告」。外部 Agent 报告明确标识来源，不推算价格或把报告当账单。没有有效时间或有效计数的消息单独计数；读取预算为五秒，Driver 不应答或某些会话不可用时返回部分结果与 `truncated`，而不是估计未读取部分。

文件预览见 [DOCUMENT-PREVIEWS.md](DOCUMENT-PREVIEWS.md)。只读目录树同样经文件服务授权，session 和绑定 Harness 的 workspace 是两个显式上下文；文档内容由会话文件服务授权，字节请求的 `If-Match` 约束同一版本。浏览器文档框不承诺数据不会经浏览器侧通道外泄。

### 会话分叉

`catalog.features.fork` 表示 `POST /tasks` 接受 `forkOf: { taskId, upToMessageId }`。请求仍需 `run`，且必须有 `view` 才能读取来源；Host 在启动前再次核对权限并生成种子，客户端不提交历史。只允许从已结束的轮次分叉，后续轮次和隐藏推理不进入种子；分叉点之前清空过上下文时，种子从最后一次清空开始，那是 Agent 当时知道的。文本保留最后 20 万 UTF-16 字符，截断时说明，边界不拆开代理对。来源名称取不可变的首条输入，重命名不改变重试内容。项目和 Harness 可重新选择，L3 照常写新会话的启动审计。默认启动目录内 Host 已知的自有目录在分叉时复用，换项目则使用新项目；文件不复制或回滚。来源、位置、轮次与种子长度写入 `sessions-meta.json` 的 zod schema，由 Hub 投影到 `TaskSummary.forkOf` 与首条消息的 `forkContext`，第三方 Driver 的来源声明不作为 Host 元数据。

**旁支提问（`/btw`）。** 在会话的输入框里写 `/btw <问题>`，客户端用同一个 `POST /tasks` 开一个只对话（`mode: 'chat'`）的分叉：同一个 Harness 与模型服务，分叉点是最后一轮已结束的回复，正在运行的一轮不进入种子，也不排进或打断它；来源会话的历史不变。回答显示在会话旁的面板里（手机上是单独一页），面板开着时分叉不出现在会话列表里；可「插入到输入框」（以引用加进主输入框的草稿）或「打开为会话」（从此是普通会话，列表里出现）；插入或关闭面板后分叉被归档，在 Code 的「已归档」里能找到；回答还在运行时先取消再归档，关闭之后才到的启动结果或读取结果不再打开面板（迟到的分叉同样取消并归档）。Harness 没有只对话方式或 Host 没有 `features.fork` 时，斜杠菜单里的 `/btw` 写「这个 Harness 尚不支持」，输入框里的 `/btw …` 不发送、不排队也不追加进运行中的一轮，原因写在输入框下。

Driver 声明 `capabilities.fork: 'native'`（现在只有 pi）时，分叉到与来源同一个 Harness 的会话另外收到 `CreateTaskInput.fork: { taskId, upToMessageId, prefixLength }`；Host 照常生成种子并放在 prompt 开头，`prefixLength` 是它的长度。Driver 在第一轮打开新会话时让 Harness 分叉它自己的记录（第一轮在会话打开前就结束时，之后不再分叉），成功时第一轮不发这段种子，首条用户消息带 `nativeFork`（ACP 消息存储的 zod schema 保留它），页面不再展开种子，写「pi 自己带着会话「…」到第 N 轮为止的记录」；做不到时照常发送种子并在会话里写明原因。来源必须是同一 Driver 的会话、同一个工作目录；Host 不比较目录，由 Driver 核对。没有声明的 Harness 收不到 `fork`，`capabilities.fork` 缺省即只用种子。pi 的做法见 [HARNESSES.md](HARNESSES.md#pi-的-rpc-模式)。

### 排队输入

`catalog.features.queue` 表示 `POST /tasks/:id/prompt` 接受 `queue: true`。运行中返回 202 `{ queued: { id } }`，空闲且没有队列时立即发送。每会话最多 5 项，Host 最多 1000 项可见内容；会话存续期间保留设备绑定回执，最多每设备 10000 项、Host 共 100000 项，已发送或移除的回执不保留正文，达到上限拒绝新增。`PATCH /tasks/:id/queue/:itemId {text}` 修改内容并更换实际派发 requestId，原提交回执不变；DELETE 移除，`POST .../:itemId/send` 显式继续首项。附件与文件引用暂不支持排队，非空 attachmentIds/fileRefs 明确拒绝。

`queues.json` 是 0600 的 strict zod 文件，保留原设备、入口、数据范围、模型与两种请求标识。只有 Driver 明确报告 runOutcome=completed、runId 匹配且没有审批才继续；旧 Driver 只有 idle 不算完成。失败、停止、未知结束或 Host 重启/关闭都暂停；停止在交给 Driver 之前就暂停队列（原因「已停止」），所以只回答了上一轮遗留请求（如之后才提问的子 Agent）、没有结束任何一轮的停止，也不会让排队的消息接着发出。发送复查原设备仍有效、有 run、数据范围未变化，以及会话、项目、Harness 指纹与模型；手动继续还复查当前设备。权限变化使该项 dropped 并暂停后续项。任何仍有 run 的设备都可移除，审计失败也放行。

排队和派发先审计，派发前再次检查门禁，审计只写会话与队列 ID。自动检查在状态刷新批次进行，避免 Driver 尚未释放上一运行时抢先输入。派发前落盘 sending；结果未知保留派发标识，公开为 parked，暂不能编辑。重启时 sending 同样按未知处理，人工重试由 Driver 持久回执去重。已发送或移除的原请求重试不会重新入队；删除会话清除其队列与回执，原 session ID 已不可调用。

原生连接排队的项在窗口失效后保留为暂停项，不自动绑定新窗口；队列正文只在详情和会话事件中返回。

### Agent 提问

内置 `user-questions:ask_user` 是 Host 明确列出的 R0 工具；第三方同名工具仍为 R2。`questions.json` 使用 strict zod 与 0600 原子写入，最多保留 128 个活跃问题、100000 个会话存续期间的记录。题目与选项只在受保护的 `TaskDetail.questions` 返回，快照列表只带 Host 派生的 pendingQuestions 数量，不包含正文；数量不写入 Driver 存储，也不信任插件声明。

`POST /tasks/:id/questions/:questionId/answer` 接受 `{requestId,answers:[{questionId,optionIds,other?}]}`，需要 run，并复查设备、数据范围、会话权限与项目。每题必答；单选不得同时选其他与普通选项，其他答案必须非空。首份回答绑定设备、请求标识和内容哈希，同一提交可重试，其他提交冲突；审计只写会话与问题 ID。

接收回答先持久化 answering，再交给当前工具；Standard 持久化对应工具结果后，Host 才返回 answered。取消或关闭结束待答题，重启不重新提问或自动运行；重启时只有会话里确有相同 completed 工具输出，才把中途的回答恢复为已确认回执。终态只保留标识与哈希，正文留在正常会话历史中。删除会话清除相关记录。等待输入沿用 waiting-approval 状态，页面根据详情显示「等你回答」，工作计时排除等待。

网页里的总览卡与保留中的会话卡按来源、设备、会话和问题 ID 共用同一份回答草稿、在途状态和未确认提交；它们不是两次独立回答。题目逐步作答，提交前先把原请求编号与完整答案存于本设备；写不进存储时不发送。收到失败或不匹配回执时保留该编号，返回会话、切换总览/分拣台和重试都不生成新回答。在途时所有同问题卡共用忙碌门禁，原回执与 Host 的问题状态才结束等待。页面不再显示这道问题且没有在途请求后释放共享内存，未确认提交仍可从同一个持久草稿恢复。

### 附件内容

[ATTACHMENTS.md](ATTACHMENTS.md) 定义独立的私有 blob 存储、设备草稿租约和内容句柄。原始上传仅在 `/attachments` 路由（单请求）与 `/attachments/uploads`（分段：开始、`PUT …/parts/:n`、`complete`、`DELETE` 中止，每段至多 1 MiB）接收；会话持久化只保存 metadata refs。图片/文字在执行前按已验证引用物化，保持既有模型出站策略。附件私有目录从不加入项目根或普通文件 resolve。
文件变化的范围、运行结算、可选插件契约与验证见 [运行期间的文件变化](FILE-OUTPUTS.md)。

## Agent 领域

我的 Agent 与「通用」见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md)，定时任务见 [AUTOMATIONS.md](AUTOMATIONS.md)，交接见 [HANDOFFS.md](HANDOFFS.md)。内置 Harness 每轮以一段简短的基础提示开始，默认最多 50 步。

一条消息在多个 Agent 之间依次回答的规则在 `apps/host/src/agent-relay.ts`（`test/agent-relay.test.ts`），尚未接入任何路由：第一个回答之后最多转交 3 次，Agent 写的内容不能增加次数；一轮没有完成就不再交给下一个；任何一个 Agent 的说明、Harness、模式、模型或插件代码与收下消息时不同，下一个不开始；停止要等正在运行的那一轮真实结算后才确认。

## 会话配置修改回执

`SessionConfigOption.source: launch` 表示 Host 已按选择启动进程，不是 Agent 有效值的独立报告；这类修改完成回执只证明启动设置已应用。Cursor force 没有独立读回接口，核对保持 `unread`，不得由本地保存值结清未知结果。进程级换档与核对共用互斥范围：异步准备后及启动/恢复前再查设备授权，运行中或仍有子 Agent 时拒绝重启。

`catalog.features.configReceipts` 表示 Host 支持配置修改的设备绑定回执。旧客户端可不传 `requestId`；新客户端为一次不可变的 `{configId,value}` 保留原编号，超时后只查询 `GET /tasks/:id/config-requests/:requestId`。结果为 `pending`、`applied`、`failed` 或 `unknown`；Agent 收到之前就被拒绝的修改记为 `failed`，例如这一轮还在启动时 ACP 会话回答的 409 `task-running`，页面可以直接说没有改；其他设备和没有回执的编号只看到 `unknown`。读取仍检查原设备、会话可见范围与当前手机正文窗口，不能读取另一台设备的结果。接口不返回原始配置内容。

Host 在 `sessions-meta.json` 保存设备、编号、请求体 SHA-256、时间与有限状态；不持久化任意自定义 Agent 配置的值或字段名。调用 Agent 前先原子保存 `pending`，保存失败绝不调用。修改返回后读回的实际选项与目标值一致、且终态回执已确认落盘才返回 `applied`；Agent 请求超时、断线或终态写入无法确认时保留 `unknown`。明确的本地无效选项，以及 Driver 用 `details.configOutcome` 标明确定没改的拒绝（发出之前拒绝，或 Agent 用错误回答且会话不显示所选值），记录 `failed`。重启将未完成的 `pending` 视为 `unknown`，不能根据配置看起来相同就假定原调用成功。`unknown` 只由核对结算：`POST /tasks/:id/config-requests/:requestId/check { configId, value }`（`catalog.features.configCheck`，要 `run`，只认原设备与相同内容）让 Driver 从 Agent 本身读取这一项（`Bridge.readConfig`，会话空闲时才读）：Driver 说是所选值（`asked`）记 `applied`；会话空闲且读到修改之前的值（回执另存它的哈希 `priorHash`）记 `failed`；读到第三个值（比如另一台设备改过）、忙或读不到保持 `unknown`，并回答原因（`running`、`subagents`、`neither`、`unread`）。核对从不发送修改。结算时写审计 `task.config.checked`（字段与目标值的哈希、结果，`refSeq` 指向这次修改自己的审计条目，回执另存它的 `auditSeq`），所以先前写了 `action.failed` 的放宽之后跟着它实际的结果。重复相同请求只读回执或合并当前执行，未知请求不再调用 Agent；相同编号的不同内容返回冲突。

配置回执随会话存续，不参与审批／取消回执的七天淘汰；每设备最多 10000 条、Host 共 100000 条，计入共享回执容量，满时拒绝新增，不能通过淘汰未决身份重执行。准备中的请求全局最多 256 条、每设备 32 条，同一执行最多 32 个合并等待者、全局 256 个。删除会话可清理其持久回执，旧会话 ID 不能复用。

配置修改仍执行设备权限与项目规则。旧回执只能确认已经发生的结果，不能授予一次新修改。审计只保存会话 ID 和字段／目标值哈希；插件和 Agent 仍是可信本机代码，这些检查不构成 OS 沙箱。
