---
description: 测试命令、测试位置与按改动选择回归，测试辅助与接缝，e2e，构建产物检查，仓库检查，供应链金丝雀，持续集成与 Git 钩子。
sources:
  - tests
  - e2e
  - apps/host/test
  - apps/web/test
  - apps/desktop/test
  - packages/harness-acp/test
  - packages/testkit
  - packages/ui/test
  - packages/app-sdk/test
  - packages/link-wire/test
  - packages/link-client/test
  - apps/relay/test
  - apps/site/test
  - scripts
  - vitest.config.ts
  - lefthook.yml
  - .github/workflows
  - package.json
---
# Latch 测试指南

测试只用 Vitest；Playwright 只在 Vitest 内作为真实浏览器与 Electron 的驱动。

所有测试都遵守：

- 只用临时目录、端口 0（或临时选出的空闲端口）、本地假模型服务、假 ACP Agent 与测试确认后端。
- 不读取用户密钥，不调用付费模型，不启动真实 Agent CLI（[需要显式开启的用例](#需要显式开启的用例)除外）。
- 不使用默认数据目录、`.runtime*/` 或端口 4317，不停止或重启用户正在运行的 Host。
- 不读写系统剪贴板（[iOS 模拟器用例](#ios-模拟器用例)里显式开启的 GUI 剪贴板验收除外），不投递系统通知，不显示真实的系统确认表单。
- 配置、清单与文档的字面内容直接阅读，不为它们写断言。

用例的具体场景以测试文件为准，本文只写怎样运行、怎样选择、辅助与接缝的规则，以及自动化不能证明什么。

## 命令

命令都在仓库根目录运行，并显式给出 `--config`：Vitest 不会到上级目录查找配置文件。

```sh
pnpm check:quick                             # fmt:check、lint、typecheck、check:boundaries、check:agents
pnpm check                                   # check:quick 加 knip 与 test；每项都运行，最后逐项汇报
pnpm check -- --plan                         # 只列出改动要求的检查，不运行；--full 整批全量；--base <ref> 比较某个提交以来的改动
pnpm typecheck                               # tsc -b
pnpm lint                                    # oxlint；导入边界、循环导入与运行环境的全局变量是错误，其余只报告
pnpm fmt:check                               # oxfmt 检查；pnpm fmt 写入，不处理 Markdown 与 packages/testkit/vectors/
pnpm test                                    # 各项目的单元与集成用例，默认用例超时 15 秒
pnpm test --project @latch/host              # 只运行一个项目，名称见「测试位置」
pnpm build                                   # host、web、relay，macOS 上另有确认组件；e2e 使用 dist/web
pnpm --filter @latch/e2e exec playwright install chromium   # 或用 LATCH_BROWSER_PATH 指定已安装的 Chrome
pnpm test:e2e                                # e2e/ 中的 *.e2e.ts，文件依次运行，用例与钩子超时 120 秒
pnpm check:boundaries                        # workspace 项目的运行环境与可用的 workspace 包
pnpm knip                                    # 未声明或无法解析的导入即失败，其余发现只报告
pnpm check:supply                            # 见「供应链金丝雀」
pnpm check:workflows                         # actionlint 与 zizmor 检查 .github/
pnpm check:agents                            # AGENTS.md、CLAUDE.md、技能与 docs/ 的结构
pnpm docs:affected                           # 改动可能需要更新的 docs/ 与 AGENTS.md；--base <ref> 同上
pnpm security:scan                           # 新增行中的秘密形状与禁用 API；--base <ref> 同上
pnpm agents:sync                             # 把 .agents/skills/<名称> 链接到 .claude/skills/<名称>
pnpm build:presence                          # 只重新构建 macOS 确认组件（源码比产物新时才编译）

pnpm exec vitest run --config vitest.config.ts <目录>/<name>.test.ts
pnpm exec vitest run --config vitest.config.ts <目录>/<name>.test.ts -t '<分组> > <用例>'
pnpm exec vitest run --config e2e/vitest.config.ts e2e/<name>.e2e.ts
LATCH_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts   # 只在 macOS
```

- `-t` 匹配以 ` > ` 连接的完整用例名。
- e2e 的环境变量包括 `LATCH_BROWSER_PATH`（已安装的 Chrome）、`LATCH_E2E_UI_DIR`（页面目录，默认 `dist/web`）、`LATCH_ELECTRON_E2E=1`（Electron 用例）。`desktop-device.e2e.ts` 的真实模拟器用例须明确指定本次新建的唯一 `latch-` 设备。公开命令用 `LATCH_E2E_SIMULATOR=<已关机的设备名>`，实时画面与输入用 `LATCH_E2E_LIVE_DEVICE=<运行中的设备名>` 和 `LATCH_E2E_LIVE_UDID=<本次新建的 UDID>`。测试完成后由创建者清理该设备。
- 构建与原生链路的用例需要 Go 1.26.x ≥ 1.26.10 或 1.27.x ≥ 1.27.3，其他版本编出的 TLS 组件被拒收。`LATCH_RELAY_GO=/absolute/path/to/go` 只选择编译器；构建不下载 Go 模块。

### 测试位置

单元与集成用例放在所测项目的 `test/` 中；`vitest.config.ts` 为每个有用例的项目声明一个 Vitest project，名称即包名。各 project 的工作目录都是仓库根，`dist/web` 这类相对路径含义相同。

| project | 目录 | 说明 |
| --- | --- | --- |
| `latch` | `tests/` | `@latch/core`、`@latch/sdk`、根包的再导出与仓库脚本 |
| `@latch/host` | `apps/host/test/` | Host、内置插件与 Host 脚本 |
| `@latch/host-swift` | `apps/host/test/native-swift.test.ts` | Swift 原生核心与 Host 的互操作；全局 setup 先编译 Swift 夹具，其他 Host 运行不触发 |
| `@latch/web` | `apps/web/test/` | 组件渲染为字符串，不启动浏览器；要 DOM 的（输入框编辑器）在文件头写 `// @vitest-environment happy-dom` |
| `@latch/desktop` | `apps/desktop/test/` | CommonJS 模块经 `createRequire` 加载，不启动 Electron |
| `@latch/harness-acp` | `packages/harness-acp/test/` | ACP Driver |
| `@latch/app-sdk` | `packages/app-sdk/test/` | 插件页面的桥 |
| `@latch/ui` | `packages/ui/test/` | 在真实浏览器中运行，见下 |
| `@latch/ui-touch` | `packages/ui/test/` 中模拟触屏的文件 | 同上，另一个浏览器，见下 |
| `@latch/site` | `apps/site/test/` | 官网：真实 Astro 构建到临时目录，检查 SEO 与链接；`apps/site/` 的改动只运行它 |
| `@latch/link-wire`、`@latch/link-client`、`@latch/relay` | `packages/link-wire/test/`、`packages/link-client/test/`、`apps/relay/test/` | 原生连接；共用 `packages/testkit/vectors/link-v1.json`，只连本地端口 0 |

`@latch/host`、`@latch/host-swift`、`@latch/link-client` 与 `@latch/relay` 的全局 setup 从本地源码构建原生 TLS 组件。

全部 e2e 在 `e2e/`（`@latch/e2e`），由 `e2e/vitest.config.ts` 运行，同样以仓库根为工作目录。

### 组件测试（浏览器模式）

`@latch/ui` 的用例用 Vitest 浏览器模式在无头浏览器中运行：`LATCH_BROWSER_PATH` 指定的 Chrome，否则是 Playwright 安装的 Chromium。它们属于 `pnpm test`，所以 `pnpm test` 与 pre-push 钩子需要其中之一。

模拟触屏的文件（`vitest.config.ts` 的 `TOUCH_FILES`）在单独的浏览器 `@latch/ui-touch` 里运行，`onTouchScreen` 在别处直接报错：关掉触屏模拟后，页面回到这台机器自己的指点设备，没有指点设备的无头 Chrome（Linux CI）从此不再匹配 `(hover: hover)`，同一浏览器里之后的悬停用例都会失败。两个一起跑用 `--project '@latch/ui*'`。

- 组件用 `vitest-browser-react` 的 `render` 渲染，交互用 `vitest/browser` 的 `userEvent`，断言用会等待的 `expect.element(定位器)`。
- Playwright 不点击 `aria-disabled` 的控件；要验证它拦下点击时用 `test/helpers.ts` 的 `press`。
- `test/setup.ts` 按页面的顺序注入 `tokens.css` 与 `ui.css`，并打开 React 严格模式（挂载副作用运行两遍）。
- 触屏用 `test/helpers.ts` 的 `onTouchScreen`，深色与减少动效用 `emulateMedia`。不要直接调用 `Emulation.setEmulatedMedia`：它每次替换全部模拟的媒体特性，`emulateMedia` 负责写全并在结束后恢复。
- 改视口的用例结束前恢复 1280×800。
- `test/gallery/` 是原语总览页，只在测试中构建，不进入 `dist/web`；视觉截图也截它。

### 报告与用例集合

- Vitest 的报告与附件写入被忽略的 `.vitest/`；e2e 截图由用例写入 `test-results/`。
- 升级 Vitest、移动或改名测试文件时，比较前后的用例集合（文件加完整用例名），每个消失或新增的用例都要说明原因。
- 集合用 `pnpm exec vitest list --config <配置> --staticParse=false --json=<文件>` 取得。不加 `--staticParse=false` 的结果不能用来比较：静态解析不展开 `it.each`，还会把辅助函数调用当成用例。

## 按改动选择回归

验证分两档，规则都在 `scripts/verify-plan.ts`：

- **每项改动**：`pnpm check -- --plan` 只列受影响的部分：`check:quick`、运行这段代码的项目单测（包的改动加上依赖它的项目）、界面与错误文案的扫描、覆盖它的 e2e 文件，以及共享编码、确认组件、Electron 与布局的定向检查。覆盖的 e2e 是改动的用例、与改动文件或其目录同名的用例（`settings/` → `settings*.e2e.ts`，单复数都算），以及连接、登记、审批、取消、流式与中继文件所属流程的用例（`FLOW_E2E`）。设计系统、页面外壳与全局样式加上 `design.e2e.ts`、`visual.e2e.ts`。新功能不跑全量单测与 e2e。
- **整批合入后或发布前**：`pnpm check -- --plan --full` 列出全部检查，跑一次。依赖文件、测试辅助与规则不认识的路径在每项改动时也要求全部检查。

计划只按路径判断。下面是它算不出来的部分：

- 名称匹配不到、却有 e2e 驱动这条流程时（例如用例按界面文字找到改动的组件），把那个用例加进去。
- 改动触及连接、登记、审批、取消或流式状态时，即使计划没有列出，也运行下表的定向用例与对应 e2e。
- 改共享协议（`packages/protocol/src/types.ts`、`packages/sdk/src/bridge.ts`、`plugins.ts`、`harness.ts`）时，跑完整的 `pnpm test` 与受影响流程的 e2e；全部 e2e 留到整批结束。
- 计划对桌面端只列 `e2e/desktop.e2e.ts` 与同名的 `desktop-*.e2e.ts`（带 `LATCH_ELECTRON_E2E=1`）；其他 Electron 用例见 [Electron e2e](#electron-e2e)。
- 真实 CLI、iOS 模拟器与性能测量默认跳过，见下面三节。

定向安全用例（没有写目录的文件在 `apps/host/test/`）：

| 改动 | 用例 |
| --- | --- |
| 设备、凭据、登记与监听入口 | `auth.test.ts`、`server.test.ts`、`route-guards.test.ts`；页面 `e2e/enrollment.e2e.ts` |
| 本机确认 | `presence.test.ts`；页面 `e2e/permissions-ui.e2e.ts` |
| 安全策略、出站 | `policy.test.ts`、`egress.test.ts` |
| 审计 | `audit.test.ts`、`audit-actions.test.ts` |
| 日志脱敏与秘密形状 | `tests/redact.test.ts`；新增秘密格式时补用例 |
| Host 进程、数据目录锁、`pnpm latch`、`--disable-sigusr1` | `security.test.ts`、`cli.test.ts` |
| 路径、项目目录与会话文件夹 | `paths.test.ts`、`projects.test.ts`、`session-folders.test.ts` |
| 风险分级与审批 | `risk.test.ts`、`tests/runtime.test.ts`、`hub.test.ts`；Latch 内置的权限档位是 `tests/permission-modes.test.ts`、`builtin-modes.test.ts`、`apps/web/test/builtin-permission.test.ts` 与 `e2e/builtin-modes.e2e.ts` |
| 审批与取消的回执 | `server.test.ts` 的 `receipts and cancels`、`session-meta.test.ts` |
| 事件流与阅读位置 | `streaming.test.ts`、`apps/web/test/reading-position.test.ts`、`e2e/streaming-ui.e2e.ts`、`e2e/takeover.e2e.ts` |
| ACP 进程：环境白名单、启动指纹、权限模式、子 Agent | `packages/harness-acp/test/` 的 `acp.test.ts`、`subagents.test.ts`、`replay.test.ts`；Cursor 的 SDK 路线是 `cursor-sdk.test.ts`（假 SDK 模块 `fixtures/fake-cursor-sdk.mjs`，从不连 Cursor） |
| 模型服务、密钥与网关 | `providers.test.ts`、`config.test.ts`、`model-gateway.test.ts`；定义变量里的密钥是 `agent-env-secrets.test.ts` |
| Git 受限运行器、工作树与交付 | `changes-git.test.ts`、`worktrees.test.ts`、`git-delivery.test.ts`、`git-hunks.test.ts`、`git-pr.test.ts`、`git-routes.test.ts`、`git-sync.test.ts`（获取、拉取、中止）、`git-clone.test.ts`（克隆，经假 `ssh`）、`branch-switch.test.ts` 与 `branch-routes.test.ts`（切换分支；`e2e/branch-switch.e2e.ts`） |
| 待办投递、来源与证据 | `work-threads.test.ts`（原请求、同轮提问与私有范围）、`native.test.ts`（正文窗口、PR 评论响应字节预算）、`apps/web/test/workbench-evidence.test.ts`（SHA）、`e2e/task-flow.e2e.ts`（浏览器、假 ACP 与假 GitHub CLI） |
| 会话文件与预览 | `files.test.ts`、`file-content.test.ts`、`file-outside.test.ts`、`file-tree.test.ts` |
| 输入框（块、原子删除、撤销、输入法、粘贴与拖入） | `apps/web/test/prompt-editor.test.ts`、`prompt-tokens.test.ts`、`e2e/prompt-marks.e2e.ts`（Chromium 与 WebKit）；成员块见 `e2e/teams.e2e.ts` |
| 团队（开始、停止、交回与页面） | `apps/host/test/teams.test.ts`、`apps/web/test/teams.test.ts`、`e2e/teams.e2e.ts`；改 Codex 委派入口时加 `e2e/codex-team.e2e.ts` |
| 插件页面框 | `app-frame.test.ts`、`app-pages.test.ts`（Host 与 `apps/web/test/` 各一份）、`apps/desktop/test/desktop-frames.test.ts`、`e2e/app-pages.e2e.ts` |
| 插件资产与生命周期 | `plugin-assets.test.ts`、`plugin-packages.test.ts`、`tests/registry.test.ts` |
| Harness 扩展报告 | `extensions.test.ts`、`packages/harness-acp/test/pi-plugins.test.ts`、`command-cache.test.ts`（ACP）和 `e2e/harness-extensions.e2e.ts` |
| MCP 与工具网关 | `mcp-remote.test.ts`、`mcp-oauth.test.ts`、`tool-gateway.test.ts`、`browser-broker.test.ts` |
| 终端 | `terminal-service.test.ts`、`terminal-routes.test.ts`、`terminal-environment.test.ts` |
| 模拟器画面、输入与归属 | `simulator-live.test.ts`、`simulator-input.test.ts`、`simulator-helper.test.ts`、`simulators-public.test.ts`、`simulators.test.ts`、`apps/web/test/device-live.test.ts`、`e2e/desktop-device.e2e.ts` 的受影响用例 |
| 客户端安全逻辑与开发代理 | `apps/web/test/` 的 `client-security.test.ts`、`client-devproxy.test.ts` |
| 桌面端壳：转发、凭据、其他电脑、更新 | `apps/desktop/test/` 的 `desktop-proxy.test.ts`、`computers.test.ts`、`updater.test.ts`；Host 侧 `desktop-host.test.ts` |
| 测试辅助（`packages/testkit`、各 `helpers/`） | 完整的 `pnpm test` 与 `pnpm test:e2e` |

### 需要显式开启的用例

这些用例运行真实已安装的 CLI，默认跳过，只在这台电脑的所有者明确授权后设置变量运行。共同规则：

- 使用临时 Host 与项目，不读取用户的 CLI 登录文件。
- 使用本地假模型的用例另隔离 HOME/XDG 与 CLI 配置目录，只验证 CLI 与 Latch 的接线。系统确认由本人实测。

没有写目录的文件在 `apps/host/test/`。

| 变量 | 用例 |
| --- | --- |
| `LATCH_CODEX_GATEWAY_BINARY` | `codex-chat-gateway.live.test.ts`、`codex-catalog.live.test.ts`、`codex-anthropic-gateway.live.test.ts`、`e2e/codex-model-gateway.e2e.ts`（不设时用假 app-server）；`packages/harness-acp/test/codex-no-turn.live.test.ts`：临时 `CODEX_HOME`、不登录、不发一轮，在 Latch 的服务上开一个 thread，经线删除，图片随之删掉、旁边的别的文件留下 |
| `LATCH_CLAUDE_GATEWAY_BINARY` | `claude-gateway.live.test.ts`、`claude-gateway-thinking.live.test.ts`、`e2e/claude-model-gateway.e2e.ts`：指向 `claude` 时走 Agent SDK 线，指向 `claude-agent-acp` 时走适配器 |
| `LATCH_CLAUDE_DIRECT_BINARY`（本机已登录的 `claude`） | `claude-direct.live.test.ts`：一个词的回复、读一个文件、一次被拒的写入（只有一次性选项）、一次取消、一次带差异的编辑、一道提问、一个子 Agent、计划里选「继续规划」、Host 重启后在记下的模式、模型与思考上恢复同一会话；再加 `LATCH_CLAUDE_ADAPTER_BINARY` 时 `packages/harness-acp/test/claude-resume.live.test.ts` 在直连上恢复适配器开的会话。都是真实的小提示 |
| `LATCH_CLAUDE_STORE_LIVE`（本机已登录的 `claude`） | `packages/harness-acp/test/claude-store.live.test.ts`：Claude 自己的存储。临时项目里一条真实的短提示，按第一条消息原生分叉，列出（Latch 与 SDK 的会话不列出）、重放，再真删除两份转录并确认不在。只打印数量与布尔值（加 `--silent=false` 看到这一行），不打印标题与文字 |
| `LATCH_OPENCODE_GATEWAY_BINARY`；或 `LATCH_CLAUDE_ADAPTER_BINARY`（`claude-agent-acp`）加 `LATCH_CLAUDE_DIRECT_BINARY` | `direct-migrate.live.test.ts`：适配器上建的会话，Host 重启后定义改为直连，会话接着回答；经网关到本地假模型 |
| `LATCH_OPENCODE_GATEWAY_BINARY`、`LATCH_DSH_GATEWAY_BINARY`、`LATCH_PI_GATEWAY_BINARY` | `opencode-gateway.live.test.ts`（直连与 `opencode acp` 两条路线）、`opencode-direct.live.test.ts`（直连：回复、拒绝与允许的调用、停止、Host 停止后无残留的 `opencode serve`、恢复；`ps` 里没有口令，工具命令看不到口令与网关令牌）、`packages/harness-acp/test/opencode-direct.live.test.ts`（`opencode acp` 建的会话在直连上恢复，选项相同，载入重放；另一例只用 `serve --stdio`：停止不需信号，被强杀留下的 claim 在恢复时释放、不问模型，项目的「总是允许」随会话报告，要 `/usr/bin/sqlite3` 往临时库里写种子）、`dsh-gateway.live.test.ts`、`dsh-gateway-auxiliary.live.test.ts`、`pi-gateway.live.test.ts`、`gateway-fallback.live.test.ts`、`e2e/harness-model-gateway.e2e.ts`（不设时用假 CLI） |
| 上述 Codex、Claude、OpenCode、pi、dsh 的任一路径 | `gateway-efficiency.live.test.ts`：每个已设路径的 Harness 对本地记录服务跑四轮（含一次工具调用），量前缀稳定、缓存提示、用量逐层是否一致、网关增加的首字节与分块延迟、上下文窗口与压缩（断言用量报到声明窗口的 97% 后下一轮之前先压缩）、失败与取消（429、500、回复中途断开与熔断打开各自的上游请求数、到失败的时长有上限，原因里有服务的原话）；结果写到 `LATCH_GATEWAY_EVIDENCE_DIR` |
| 上述路径中的任意两个以上 | `harness-move.live.test.ts`：每一对 Harness 之间换过去再换回来。默认经本地记录服务核对各自实际发出的请求；`LATCH_RELAY_REAL=1` 时各用本机已登录的模型，下一个要说出上一个记下的暗号（真实调用，提示只有一行）。`LATCH_RELAY_PAIRS=codex-claude,…` 只跑指定的组合 |
| 上述路径中的任意三个以上 | `teams.live.test.ts`：每个 Harness 带队一次，后两个当成员，核对成员同时在跑、结果交回带队会话。默认经本地记录服务；`LATCH_TEAM_REAL=1` 时各用本机已登录的模型，带队会话的汇总要含两个成员的暗号（真实调用，提示只有一行）。`LATCH_TEAM_LEADS=codex,…` 只跑指定的带队 |
| 上述 Codex、Claude、OpenCode、pi 的任一路径 | `attachment-path.live.test.ts`：声明不看图的服务，一个 PDF 与一张图片按路径交出，Agent 用自己的 shell 工具读出两者的摘要 |
| `LATCH_NO_LOGIN_<ID>=<程序路径>` | `gateway-no-login.live.test.ts`：空的临时 HOME、不带登录 |
| `LATCH_NO_LOGIN_GROK=<grok 路径>` | 另跑 `packages/harness-acp/test/grok.live.test.ts`：临时 HOME 与 `GROK_HOME`，只发控制请求、不发提示。网关路线不启动 Claude Code、Cursor 配置里的 MCP 服务器（对照旧的家会启动），Latch 给的服务器看到空凭据；`initialize` 读到的模型与思考与 `session/new` 报告的一致；`session/set_mode` 只认 `plan` 等；`_x.ai/session/delete` 删掉会话文件夹；手写的有消息会话经不带目录的 `session/list` 列出、`session/load` 带 `isReplay` 重放 |
| `LATCH_SLASH_LIVE=1` 加 Codex 或 pi 的上述路径 | `packages/harness-acp/test/` 的 `codex-commands.live.test.ts`、`codex-skills.live.test.ts`；`e2e/codex-compact.e2e.ts`、`e2e/codex-skills.e2e.ts`、`e2e/pi-commands.e2e.ts` |
| `LATCH_HELPER_LIVE=1` 加 pi、Codex 或 OpenCode 的上述路径 | `e2e/helper-live.e2e.ts` |
| `LATCH_HELPER_PROPOSALS_LIVE=1` 加 Codex 或 OpenCode 的上述路径 | `e2e/helper-proposals.e2e.ts`、`packages/harness-acp/test/codex-skills.live.test.ts` |
| `LATCH_CODEX_ACTIONS_LIVE=1` 加 `LATCH_CODEX_GATEWAY_BINARY` | `packages/harness-acp/test/codex-actions.live.test.ts` |
| `LATCH_CODEX_DELETE_REAL=1` 加 `LATCH_CODEX_GATEWAY_BINARY` | `apps/host/test/codex-delete.live.test.ts`：用本人的登录在临时项目里发一句极短的提示（一次付费的回合），经 Latch 删除会话，再用本人的 `codex app-server` 的 `thread/read` 核对它已读不到这个 thread；只打印布尔值 |
| `LATCH_CODEX_IMAGE_REAL=1` 加 `LATCH_CODEX_GATEWAY_BINARY` | `apps/host/test/codex-image.live.test.ts`：用本人的登录生成一张图（一次付费的图片生成），图片工具的行要带图片附件 |
| `LATCH_DSH_BINARY` | `packages/harness-acp/test/dsh-mode.test.ts` 与 `apps/host/test/dsh-config.test.ts` 的真实部分（临时家目录里的 `--dump-config`），无模型调用 |
| `LATCH_AGY_BINARY` | `antigravity.live.test.ts` |
| `LATCH_COMPUTER_GUIDE_LIVE=codex=<路径>,claude-agent=<claude-agent-acp 路径>,opencode=<路径>` | `computer-guide.live.test.ts`：CLI 用自己的登录与模型，假 Driver，不碰桌面；替换与前置的 A/B（[MCP.md](MCP.md#给-agent-的指引)）。`LATCH_COMPUTER_GUIDE_ARMS=replace` 或 `prepend` 只跑一组，`LATCH_COMPUTER_GUIDE_RUNS` 每组次数，`LATCH_COMPUTER_GUIDE_VENDOR_FILE` 是 Driver 原文（不进仓库），`LATCH_COMPUTER_GUIDE_BROWSER=0` 跳过 latch-browser 一项，`LATCH_COMPUTER_GUIDE_EVIDENCE_DIR` 写下每轮的结果。`PATH` 里的 `cua-driver` 与 `cua` 要换成只记录的替身 |
| `LATCH_CODEX_QUOTA_BINARY` | `harness-quota.live.test.ts`，结果写到 `LATCH_CODEX_QUOTA_OUT` |
| `LATCH_CODEX_SPEED_BINARY`（本机已登录的 `codex`） | `packages/harness-acp/test/codex-speed.live.test.ts`：Codex 自己的登录，一个一词的回复；选与 thread 起始相反的速度档，核对它随这一轮发出、新进程恢复 thread 后读回同一档，然后归档这个 thread；模型、档位与结果写到 `test-results/codex-speed-live.json` |
| `LATCH_LIVE_HARNESS` 和 `LATCH_LIVE_HARNESS_BINARY` | `e2e/harness-acceptance.e2e.ts`，在真实浏览器中验收所选 CLI 的一轮回复与重入 |

电脑指引、Codex 额度与速度、Antigravity 实测与单回合浏览器验收使用 CLI 自己已有的登录与模型。它们在临时 Host 与临时项目里发送极短的提示，不读取 CLI 自己的任何文件。

`LATCH_GATEWAY_EVIDENCE_DIR` 与 `LATCH_AGY_EVIDENCE_DIR` 收每一轮去掉正文的结果。

#### 单回合浏览器验收

构建页面后从仓库根目录运行。默认使用本地 ACP 夹具走完报告面板与重启重入。实测时每次只选 `codex`、`claude-agent`、`pi`、`antigravity`、`grok`、`qwen` 或 `goose` 中的一项，程序路径使用已安装的预设命令。此例用 Codex 验收待办提议。

```sh
LATCH_LIVE_HARNESS=codex \
LATCH_LIVE_HARNESS_BINARY=/absolute/path/to/codex \
LATCH_LIVE_HARNESS_MODE=todo \
LATCH_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
NODE_OPTIONS=--disable-sigusr1 \
pnpm exec vitest run --config e2e/vitest.config.ts e2e/harness-acceptance.e2e.ts --maxWorkers=1
```

用例经浏览器发送一次固定短答，核对 Host 的终态、回复与回合，检查该 Harness 报告的模型、额度与扩展情况，再重启临时 Host 并打开同一会话。默认模式要求模型只返回 `LATCH-OK`。Codex 可加 `LATCH_LIVE_HARNESS_MODE=todo`，在「我的 Agent」中发送一条合成提议，请人经界面接受并打开对应待办。只有参数精确匹配的 `latch-skills.propose_todo` 可以得到一次测试批准，待办保持未开始。

临时 Host 只查找选定的程序。Antigravity 与 Claude 的启动环境关闭自动更新，Claude 另关闭官方市场的自动安装。结果只输出状态、固定失败类别、数量与核对结果。报告面板失败后仍检查同一回合能否在 Host 重启后重入。浏览器或 Host 关闭失败时保留本次验收的临时目录，输出关闭状态与目录路径。设置 `LATCH_LIVE_HARNESS_EVIDENCE_DIR` 可保存重入后经过文字核对的回复正文裁图。运行时保持 Playwright 的调试日志与跟踪关闭。登录、拒绝、超时与偏离短答按实际结果记录。真实 CLI 配本地假模型的验收另见 `gateway-no-login.live.test.ts`。

### 原生中继吞吐

`e2e/native-swift-throughput.e2e.ts` 在 Swift 夹具与本地自建中继之间放一个注入 RTT 与带宽的 TCP 代理（只整形手机一腿，中继不设配额），测显式下载（经大块连接的连续 1 MiB 读取）与控制连接读取的吞吐、单元数与哑单元比例，经中继的附件分段上传的吞吐，以及控制连接上小请求的往返时间（连接静默后与连续发），结果写入 `test-results/native-throughput/rows.json`。默认一组短用例；`LATCH_TRANSFER_MATRIX=1` 跑 RTT 50/150/300 ms × 20/50/100 Mbit/s 的 8 MiB 矩阵，`LATCH_TRANSFER_CASE=<rtt>,<mbps>,<bytes>` 只跑一组，`LATCH_TRANSFER_DIRECTION=download|upload|control` 只跑一类，`LATCH_TRANSFER_LEGACY=1` 去掉 `nativeBulkUpload`，按没有大块上传连接时测上传。代理的延迟不经过端点的 TCP 拥塞控制，测的是窗口、填充节奏与请求往返决定的上限。

### iOS 模拟器用例

会话列表和输入栏的截图可用 `LATCH_IOS_SCENES=workspace,work-list,conversation-reading` 筛选。`workspace-offline` 与 `work-list-offline` 展示同一台电脑断线后的两个列表。`conversation-reading` 提供超过一屏的回复，供滚动和软键盘验收。`project-files` 场景可从会话进入项目文件夹、按文件名查找。设置 `LATCH_IOS_LIVE_WORK=1` 会在 Live 夹具的临时 Host 建立一个项目、一条待办和一个关联会话。模拟器配对后可验证创建、发言、状态变更和文件预览。

`session-team` 提供同一带队会话下的四名成员、同名独立会话和另一项目，用于检查成员排序、折叠、搜索和回到对应会话。

`work-list` 提供带优先级、备注与标签的待办，可实走分组折叠、搜索和筛选恢复；`work-list-offline` 对照离线摘要的展示范围。

`agents-loading` 可与 `agents`、`agents-locked` 对照检查首次读取、已有目录和权限不足。`question-reminder` 在 App 内建立基线后产生一个模拟提问。可分别点横幅与灵动岛回到会话，提交回答后检查两处提醒撤下。需在支持灵动岛的 iPhone 模拟器上验收系统展示。

`usage-widgets` 用额度页的数据写出额度小组件的副本（Antigravity 读于 40 分钟前），供在主屏与锁屏手动放置小号、中号、矩形与圆形小组件，核对过时标记、设置里选 Harness 与按下回到额度表。App Group 只在带权限文件的模拟器构建（`CODE_SIGN_IDENTITY=-`）里可用，无签名构建的小组件只显示「打开 Latch 读取」；文件保护只能在设了密码的真机上看。

| 开关 | 用例 | 作用 |
| --- | --- | --- |
| 无 | `e2e/ios-app.e2e.ts` | 用临时 DerivedData 构建真实 App，禁用签名，不启动；核对 `Latch.app` 不含 Live 标记与软件密钥符号 |
| `LATCH_IOS_SCREENS=1` | `e2e/ios-screens.e2e.ts` | 构建 `LatchScreens`，在自己新建的模拟器上按 `-LatchScene` 截固定样本场景的浅深色，不连 Host |
| `LATCH_IOS_LIVE=1` | `e2e/ios-live.e2e.ts` | `LatchScreens` 的 Live 模式连接 `startTestHost` 的临时 Host，供人在模拟器里实走 |
| `LATCH_IOS_CLIPBOARD_TEST_DEVICE=<UDID>` | `e2e/ios-clipboard.e2e.ts` | 默认只用随机命名的独立 pasteboard；设置后在自有模拟器上验证公开标记的往返与清空 |
| `LATCH_IOS_STAGE_PROBE=<前缀>` | `e2e/ios-pairing-stage.e2e.ts` | 只读的公开阶段探针，不操作模拟器、剪贴板或产品状态 |

`ios-screens` 与 `ios-live` 需要已安装的 iOS 模拟器运行时。`ios-screens` 的选项：`LATCH_IOS_SCENES`（逗号分隔的场景前缀）、`LATCH_IOS_SCREENS_DIR`、`LATCH_IOS_SCREENS_DEVICE=<udid>`（只在这台已有模拟器上截）、`LATCH_IOS_SCREENS_KEEP_RUNNING=1`（仅与前者一起，截图后留下夹具 App）。

`ios-live` 的选项：

| 变量 | 作用 |
| --- | --- |
| `LATCH_IOS_LIVE_HOLD=<文件>`、`LATCH_IOS_LIVE_HOLD_MINUTES` | 保持运行直到该文件出现或到期（默认 120 分钟） |
| `LATCH_IOS_LIVE_PAIR_SECONDS` | 等人在该时限内配对并断言成功 |
| `LATCH_IOS_LIVE_HOSTS=2` | 同一私网地址上再起一台测试 Host |
| `LATCH_IOS_LIVE_KEEP=1`、`LATCH_IOS_LIVE_DEVICE=<udid>` | 创建并留下可复用的模拟器 `latch-hands-on`（UDID 写入输出目录的 `device.txt`）；在已有模拟器上运行 |
| `LATCH_IOS_LIVE_DIR` | 输出目录，默认 `test-results/ios-live/` |
| `LATCH_IOS_LIVE_HISTORY`、`_AGENTS`、`_ATTACH`、`_ACTIVITY`、`_COMPUTER`、`_METRICS`（各 `=1`）、`LATCH_IOS_SLASH=1` | 另加对应的夹具数据：可接入的历史、我的 Agent 与定时、收附件的假 Agent、人工任务、错过的定时、正文流的流量采样、命令与模板 |
| `LATCH_IOS_LIVE_GUI_CLIPBOARD=1` | 受控的共享剪贴板验收，见下 |

保持运行时用控制文件驱动：`<文件>.pair`（`.pair2`）换新连接码，`.wait<n>`、`.revoke<n>`、`.stop<n>` 操作第 n 台 Host，`.run`、`.fail` 运行人工任务，`.received`、`.metrics` 写出只含元数据的采样；状态与原因写在 `<文件>.info`。

规则：

- **模拟器。** 只关闭与删除本次创建的设备，不按名称清理历史设备。对 `DEVICE` 指定的已有设备不关闭、抹掉或删除，只安装、启动与停止 App 并清空剪贴板；`ios-screens` 结束时恢复它原来的浅深色。
- **连接码。** 只经 `devicectl device pasteboard copy` 的标准输入进模拟器剪贴板，不进参数、环境、文件与日志；码被用掉后、换码前与结束时清空。
- **剪贴板同步。** Simulator 或 DeviceHub 打开时会把模拟器剪贴板同步到本机与通用剪贴板，所以默认无界面运行模拟器，开始时与每次写码前都检查这两个程序：打开时不写码，并在 `.info` 写明原因。
- **GUI 剪贴板验收。** 只在 `LATCH_IOS_LIVE_GUI_CLIPBOARD=1`、有 `HOLD`、且设备是本轮新建或 `DEVICE` 明确指定时进行。先在内存保存 Mac 剪贴板（读不全即拒绝，不替换原内容），用公开随机文本做双向同步的正控（各 5 秒内）与关闭共享后的负控（各 10 秒），没有成功的正控不接受负控；通过后才发一次码。两个 GUI 都退出且剪贴板仍属本次测试时才恢复原内容；人后来复制的内容保留。中断或等待不算通过，这也不是永久隔离保证。
- **网络。** Host 的原生监听绑定默认路由接口的私网地址，只在这次运行期间存在、局域网可达，连接仍需连接码。测试 Host 不发布 Bonjour，配对码的局域网提示 2 分钟后失效。

原生待办的投影、旧窗口、确切问答或审批和提交版本由 `native-swift.test.ts` 编排。交付与原回合的组合读取经实际原生连接换路用例核对，复用原正文租约时拒绝旧连接的下一次读取和发布。缓存回归暂停旧 Vault，检查快速重开时的新资料库会等待收尾，离线只读到已撤下私有项的快照。用 `ios-screens` 的 `work-`、`review` 场景查看任务列表、来源、同 SHA 证据和文件栏布局。回复排版、消息图片与团队看 `markdown`、`markdown-code`、`pictures`、`team-results`、`team-graph` 场景，Markdown 分块、团队结果的读取与团队分工卡的位置和末端由 `native-swift.test.ts` 核对。实走「待办 → 原回合 → 回到待办」在本次创建的模拟器及临时 Host 上做，覆盖较窄权限、锁屏和断连。审阅还检查 iPad 横竖屏、分屏、辅助使用字号、长路径与过期警告。

Live 模式只在 `LatchScreens`（仅模拟器）中编译，用进程内存里的软件密钥代替 Secure Enclave；TLS、敲门 HMAC、根证明、正文窗口与 requestId 与产品相同。`pnpm check:boundaries` 核对这些代码不进 `Latch` 目标。

### 性能测量

默认跳过。读数只用于同一台机器、安静窗口里的前后对比，不作跨机器阈值；没有开启断言的基线通过不代表预算达标。

| 开关 | 用例 | 选项 |
| --- | --- | --- |
| `VITE_LATCH_UI_PERF=1` | `packages/ui/test/v9-performance.test.tsx` | `VITE_LATCH_UI_PERF_ENFORCE=1` 时超过每帧 8ms 的脚本预算即失败；只量脚本，不量合成 |
| `LATCH_STREAM_BENCH=1` | `e2e/stream-performance.e2e.ts` | `LATCH_STREAM_LABEL`（结果名）、`LATCH_STREAM_TRANSPORT=full`（去掉增量协商作对照）、`LATCH_STREAM_PROFILE=1`、`LATCH_STREAM_QUIET=1`、`LATCH_STREAM_MOTION=1`、`LATCH_STREAM_ENFORCE_BUDGET=1`（每帧脚本不超过 8ms 且没有 50ms 长任务）；`LATCH_E2E_UI_DIR` 可对照旧构建 |
| `LATCH_BACKDROP_BENCH=1` | `e2e/backdrop-performance.e2e.ts` | 起始页背景在 1440×900 与 2560×1440（2 倍像素）下的帧间隔、绘制节拍、每帧脚本、长任务、渲染与 GPU 主线程每秒耗时、每帧画布调用，以及打字时按键到下一帧；`LATCH_BACKDROP_LABEL`、`LATCH_BACKDROP_SECONDS`、`LATCH_BACKDROP_THROTTLE=4`（CPU 降速）、`LATCH_BACKDROP_ONLY`；`LATCH_E2E_UI_DIR` 可对照旧构建。`LATCH_BACKDROP_SHOTS=<仓库外目录>` 改为截两种样式在三宽、深浅下的起始页，桌面另截会话与外观设置 |
| `LATCH_NATIVE_CADENCE=1` | `apps/host/test/native-swift.test.ts -t "large-history publication cadence"` | 不含 SwiftUI 渲染 |

堆内存没有强制 GC，不能用来宣称泄漏。

大文档预览的首屏预算在 `e2e/document-performance.e2e.ts`（先 `pnpm build`）：输入由 `performanceDocumentFixtures`（`packages/testkit/src/documents.ts`）在内存里生成，不提交第三方文档；预算固定，超出即失败，不按机器或当次结果放宽。没有所有者参照（`LATCH_DOCUMENT_REFERENCE_DIR`，原应用导出的逐页 PNG）时报告标为 `unverified-original-application-fidelity`：自己的截图不是保真验收。

## 测试辅助

测试辅助在 `packages/testkit`（`@latch/testkit`，只供测试，见[构建产物检查](#构建产物检查)）。它不导入 Host：Host 夹具经参数拿到启动函数。

`startTestHost` 的绑定 `host.ts` 有三份，除导入方式外相同，改一份时同步另两份：

| 文件 | 使用者 | 导入 `startServer` |
| --- | --- | --- |
| `apps/host/test/helpers/host.ts` | Host 自己的用例 | 相对路径 |
| `e2e/helpers/host.ts` | e2e | `@latch/host` |
| `apps/desktop/test/helpers/host.ts` | 桌面端壳的用例 | `@latch/host` |

浏览器 e2e 的辅助在 `e2e/helpers/`：`browser.ts`（登记与连接）、`layout.ts`（控件可达、弹层在窗口内、横向溢出、按 Host ID 打开会话）、`visual.ts`（截图与比较）、`security.ts`（注入样式后安全界面不变）。

testkit 另导出：`FAKE_ACP_AGENT`、`FAKE_CODEX_APP_SERVER`、`FAKE_PI_AGENT`、`FAKE_MCP_STDIO`（假进程的路径）、`startFakeModels`、`startFakeMcpHttp`、`startFakeOAuth`、`installFakeGh`（不连 GitHub）、`writeFakeHistory`、`documentFixtures`。

### `startTestHost()`

把 testkit 的 `startHostFixture(start, options)`（`packages/testkit/src/host.ts`）绑定到本 Host 的 `startServer`，在进程内启动一个 Host。

- 数据目录、工作区、运行目录的父目录与 TLS 材料都在一个新的临时目录中（前缀短，`host.sock` 路径不超过 macOS 的 104 字节上限）；`close()` 关闭 Host 并删除整个目录。
- 默认 `port: 0`、`demo: true`、`uiDir: dist/web`、`rateLimits: 'relaxed'` 与测试确认后端（`presenceMode: 'approve'`）；其他 `ServerOptions` 原样传给 `startServer`。
- 不传 `commandDirectories` 的测试 Host 按名字找不到任何命令；需要假 CLI 的用例用 `loginPrograms` 与 `commandDirectories` 只指向临时目录。
- 不传 `cliStore` 的测试 Host 不读也不删任何 CLI 自己的存储（pi 的会话文件与项目信任）；`pi-store.test.ts` 与 `e2e/pi-history.e2e.ts` 只把它指向写了假会话文件的临时主目录。
- 三种入口：

  | 入口 | 地址 | 凭据 |
  | --- | --- | --- |
  | `'unix'` | `host.sock` | `Authorization: Latch-Device …` |
  | `'loopback-tcp'` | `h-<hostId>.localhost`（解析到 127.0.0.1） | Cookie `latch_<hostId8>` |
  | `'tls'`（需要 `tls` 选项） | `https://latch-test.localhost:<port>` | Cookie `__Host-latch_<hostId8>` |

- `enroll({ listener, name, scopes, invitation, offlineCode })` 走完整登记并返回 `TestDevice`。只有 `host.sock` 能不经邀请登记；其他入口没有给出邀请或离线码时，自动创建不带 `approve:elevated` 与 `secrets` 的邀请。
- `invite(scopes, listener)` 经 `host.sock` 创建邀请；`raw(listener, path, init)` 发送 `/link/` 下的原始请求，不跟随重定向。
- `TestDevice`：`request()`、`json()`（非 2xx 抛出）、`confirmed()`（收到 403 `stepup-required` 时经测试确认后端批准，再带 `x-latch-confirmation` 重发）、`renew()`、`addFolders()`（像桌面端主进程那样取 nonce 并签名请求体）。
- `tls: true` 用 `makeTestTls` 生成证书并允许本机对端；也可传入完整的 `TlsListenerOptions`。

### `createTestPresence()`

`packages/testkit/src/presence.ts`。测试确认后端，形状与 Host 的 `PresenceBackend` 相同。

- 模式 `approve`、`deny`、`unavailable`、`manual`（请求排队，由 `approveNext()`、`denyNext()`、`timeoutNext()` 依次结算），可在用例中途修改。
- `requests` 记录每次收到的预览与 previewHash；`waitForRequest(timeoutMs)` 按到达顺序返回下一条尚未取走的请求。
- 只能通过 `startServer({ presence })` 或 `new PresenceService({ backend })` 注入；生产代码选不到它。

### `makeTestTls()`

`packages/testkit/src/tls.ts`。用 `/usr/bin/openssl` 为 `latch-test.localhost` 生成自签名 P-256 证书（自身即 CA，私钥 0600）。Node 端用返回的 `ca` 信任它，浏览器上下文设 `ignoreHTTPSErrors: true`。Chrome 不接受显式写出 EC 参数的证书，自行生成时也要加 `-pkeyopt ec_param_enc:named_curve`。

### `enrollBrowser()`

`e2e/helpers/browser.ts`。`enrollBrowser(page, testHost, { name, scopes, url })` 经真实的连接页在回环地址上登记 `page` 所在的浏览器，并等待工作区连接（`connected(page)`）。

- 回环登记需要邀请，所以它先经 `host.sock` 创建回环邀请，再打开带 `#pair=` 的地址。
- 连接页请求邀请允许的权限，`scopes` 只决定邀请是否包含「管理此 Host」。
- `manual` 模式下由它批准本机确认。
- `browserLaunchOptions()` 返回无头启动参数，并遵守 `LATCH_BROWSER_PATH`。

### 共享向量

`packages/testkit/vectors/` 的向量由多个实现共同校验，改编码时同时改向量与每个实现：

| 文件 | 校验者 |
| --- | --- |
| `security-v1.json` | Host、浏览器、桌面端主进程与 macOS 确认组件的 `--self-test`（要求见根 `AGENTS.md`「共享安全编码」） |
| `link-v1.json` | `@latch/link-wire`、`@latch/link-client`、`@latch/relay` |
| `task-delta-v1.json`、`slash-match-v1.json` | TypeScript 与 Swift 核心（`native-swift.test.ts`） |
| `shell-unwrap-v1.json` | 命令外壳还原 |
| `board-v1.json` | 正在等你的判定：Host 的 `waitKindOf`（`board.test.ts`）、网页的 `waitsOnYou`（`wait-vectors.test.ts`）、桌面端的 `attentionOf`（`notifications.test.ts`）；网页的等你处理计数读 Host 的组，向量只核对其中的审批 |

### 文件内的约定

- 每个文件用 `cleanups` 数组配合 `afterEach` 逆序清理；临时目录用 `mkdtemp(join(tmpdir(), …))`；轮询用 `vi.waitFor` 或 `expect.poll`。
- Vitest 在每个用例开始前清空 mock 的调用记录，所以 `vi.fn` 与 `vi.spyOn` 在用例内创建。清空不会撤销替换：`vi.stubGlobal` 与 `vi.spyOn` 仍在 `afterEach` 或 `finally` 中恢复。
- `resolves`、`rejects` 与 `expect.poll` 断言必须在用例结束前 `await`；`expect.poll` 不 await 就不会执行。
- 模型服务用本地 HTTP 服务或脚本化的 `FetchLike` 模拟，除回环地址外不访问网络。
- 时间用注入的时钟（见下节与 `apps/host/test/helpers/manual-clock.ts`），不等真实的退避、时限或定时。

## 测试接缝

| 接缝 | 位置 | 用途 |
| --- | --- | --- |
| `now` | `ServerOptions`；`DeviceStore.open`、`EnrollmentService`、`PresenceService`、`AuditLog.open` 与桌面端的 `createShellProxy` 也各自接受 | 凭据、登记与确认的时钟：续期、过期、宽限期与确认超时 |
| `clock` | `ServerOptions`，传给运行时与 Harness | 消息与运行记录的时间，以及发给客户端的 `hostTime`；与 `now` 分开，凭据与确认不受影响 |
| `rateLimits` | `ServerOptions` | `'relaxed'` 把限流桶放大 100 倍，是 `startTestHost` 的默认值；限流用例显式传 `'default'`。生产从不设置 |
| `allowLocalPeers` | `TlsListenerOptions` | HTTPS 入口默认拒绝本机地址的连接；只有测试打开它 |
| `egressAllow`、`egressLookup` | `ServerOptions` | 进程级附加的出站白名单（不写入 `policy.json`，它的源也算已确认的模型服务地址）与 DNS 解析。要测试地址确认本身就不传 `egressAllow` |
| Provider 的 `fetch` | `providerPlugin(record, { fetch })`、`listProviderModels`、`checkProvider` | 确认内置协议只经注入的 fetch 出站、不跟随重定向 |
| `presence` | `ServerOptions` | 注入测试确认后端 |
| `runtimeParent`、`codeRoot` | `ServerOptions` | 运行目录的父目录与 Latch 程序目录 |
| `hostName` | `ServerOptions` | 固定截图里的电脑名称 |
| `fs` | `DeviceStore.open`、`AuditLog.open` | 注入写入失败与短写 |
| `classifyToolCall` | `createRuntime(options)` | 风险分级器；抛错或返回未知值按 R2。不传时按 `requiresApproval` 分 R1/R0，只出现在直接构造运行时的测试中 |
| ACP 选项 | `createAcpAgentPlugin(definition, options)` | 缩短取消、停止、重启与请求超时（`acp.test.ts` 的 `FAST`） |

### 假 ACP Agent

`packages/testkit/fixtures/` 下的假进程都是确定性的手写替身，按各程序的公开协议与源码写成，不是录制，也不调用模型：

| 文件（testkit 导出的路径） | 扮演 |
| --- | --- |
| `fake-acp-agent.mjs`（`FAKE_ACP_AGENT`） | ACP v1 Agent；以 `app-server` 启动时转为假 Codex |
| `fake-codex-app-server.mjs`（`FAKE_CODEX_APP_SERVER`） | Codex 的 app-server |
| `fake-pi-agent.mjs`（`FAKE_PI_AGENT`） | pi 的 RPC |
| `fake-mcp-stdio.mjs`（`FAKE_MCP_STDIO`） | stdio 的 MCP 服务器，见 [MCP.md](MCP.md#测试替身) |
| `fake-gh.mjs`（`installFakeGh`） | `gh` |

`fake-acp-agent.mjs` 的规则：

- 写 `FAKE_ACP_STATE`（会话状态，多个进程共享、每次保存都合并磁盘内容）与 `FAKE_ACP_LOG`（逐行 JSON 日志）；此外只有 `shell-edit` 一轮在会话目录写两个文件、用例排进 `FAKE_ACP_EDIT_QUEUE` 的文件改动，扮演 Qwen Code 时夹具家目录里的设置，以及设了 `FAKE_ACP_DSH_LOG` 时那个家目录里 DeepSeek Harness 格式的会话日志。
- 唯一的网络访问是 `model` 一轮：访问客户端指给它的模型服务。
- 参数里有 `--dump-config` 时像 `dsh --profile acp --dump-config` 那样打印一份官方组合（`FAKE_DSH_DUMP` 替换它）后退出；`deleteSession`（Qwen Code）与 `_goose/unstable/session/extensions/remove`（goose）照它们的形状回答。goose 的 `sessions.db` 与 Qwen Code 的自更新文件由用例在临时目录里按真实形状写出（`apps/host/test/cli-stores.test.ts`）。
- 进程级行为由 `FAKE_ACP_*` 环境变量决定，每一轮通常按提示的第一个词分派，其他输入回显。发送多块正文时，最后一块开头的 `schedule` 命令仍会执行，前面的 Agent 摘要保留在会话记录中。变量与关键词在该文件中查找（`grep -o 'FAKE_[A-Z_]*'`）。
- `FAKE_SECRET` 出现在 stderr 与错误中，`FAKE_ACP_DUMP_ENV=1` 把完整环境写入日志：分别用来检查脱敏与环境白名单。日志里的 `latchEnv`（收到的 `LATCH_*` 变量名）应为空。
- `acp.test.ts` 的 `setup()` 把预览的 `launchHash` 作为 `expectedLaunchHash` 传入，代替 Host 的本机确认；`preset(presetId)` 套用预设的权限配置，不算已验证的预设。

`startFakeModels()`（`packages/testkit/src/fake-models.ts`）在 127.0.0.1 上按脚本回答 Chat Completions、Responses 与 Anthropic Messages，并记下每个请求：只有带来的密钥与头的名字，不含头的值。

### 回放与录制

`packages/testkit/fixtures/replay/<预设>/<场景>.ndjson` 是每个预设的 ACP 对话；同一 Agent 帧不同的另一个大版本放在 `<预设>/<大版本>.x/`。

- 第一行 `transcript_start` 写明预设、场景、`source`（`hand-written` 或 `recorded`）、所依据的 Agent 版本与源码位置（`basis`）和人要做的步骤（`steps`）。
- 之后每行一帧：`expect_outbound`（Latch 应发的帧）、`emit_inbound`（Agent 发来的帧）或 `runtime_exit`（进程在这里结束）。JSON-RPC 的 ID 由回放补上。
- `<any>` 匹配任何值或字符串中的任何一段，`<workspace>` 是会话目录；pi 的对话头部写 `protocol: "pi-rpc"`。
- 现有的都是 `hand-written`，不是从运行中的 Agent 抓到的。

`fixtures/replay-agent.mjs`（`REPLAY_AGENT`）代替真实 Agent 逐帧比对，把进度与第一处不符写进 `REPLAY_STATUS`。`packages/harness-acp/test/replay.test.ts` 用真实的驱动按 `steps` 走每个文件；新增场景要在它的 `SCENARIOS` 里写明检查。按名字找命令只指向临时目录里的假程序。

`pnpm harness:record -- --harness <预设> --scenario <场景>` 录制已安装的真实 Agent，只由这台电脑的所有者手动运行，只支持 macOS：

- Agent 在 `sandbox-exec` 中启动：网络只放行到假模型服务的端口，挡住钥匙串文件与各 Agent 的登录目录；`HOME` 与 `XDG_*` 是新的临时目录，环境只留白名单与 `--env` 给的变量。
- 每次启动前先确认沙箱挡住了一次对外连接和一次到本机另一个端口的连接，否则不启动 Agent。
- Agent 经 `--env` 或 `--home-file` 配置成使用假模型服务（`{{MODEL_ORIGIN}}`）。
- 结果规范化路径、UUID、时间与邮箱并脱敏，仍含本机家目录或用户名时不写出；写到临时目录，由人读过后移入 fixtures。
- 尚未验证：拒绝钥匙串服务查找这一项没有对真实钥匙串验证过；各家 Agent 指向假模型服务的配置方式没有用真实 Agent 验证过。
- `record.test.ts` 只用假 ACP Agent 运行它；测试从不运行真实 Agent。

## 启动脚本的子进程用例

`security.test.ts`、`cli.test.ts` 与 `desktop-host.test.ts`（都在 `apps/host/test/`）会真实启动 `apps/host/scripts/` 下的 `start.ts`、`stop.ts` 或 `latch.ts`。规则：

- 每次都显式传临时 `--data-dir`，子进程的 `cwd` 也设为临时目录：省略时数据目录可能落到仓库的 `.runtime/` 或用户的默认数据目录。
- 子进程环境去掉开发者终端里的 `LATCH_*` 变量（`childEnv()`、`cleanEnvironment()`）。
- Host 用 `--port 0`；HTTPS 用临时选出的空闲端口，从不使用 4317。
- 预先写入把本机确认关掉的 `policy.json`（`presence.backend` 为 `none`，参照 `cli.test.ts` 的 `stoppedDataDir()`），这样 `start.ts` 不构建或调用真实确认组件，`presence test` 也不弹窗。
- 需要 Host 的进程号等于子进程号（锁记录、`pnpm stop` 的核对）时，用 `process.execPath --import <tsx 的加载器>` 启动，不经 `tsx` 包装进程。
- 只停止自己启动的进程：`stop.ts --data-dir <同一临时目录>`，或向自己 spawn 的子进程发 SIGTERM；用例结束时删除它的运行目录。
- 让启动停在中途时用 `--plugin` 加载临时模块（等待门文件的插件，或导出 `{}` 让启动以「插件模块无效」失败）。
- 用当前测试进程的 PID 冒充存活的锁持有者，用已退出子进程的 PID 表示已结束的持有者。
- `cli.test.ts` 的大多数用例在进程内调用 `runLatch(argv, io)`，由 `CliIO` 提供终端与输入。
- 平台相关：`--code-file` 的 ACL 用例只在 macOS 运行，目录属主用例以 root 运行时跳过。

## 浏览器 e2e

- **先构建。** e2e 在同一个 Vitest 进程内用 `startTestHost` 启动 Host，页面来自 `dist/web`（或 `LATCH_E2E_UI_DIR`）；改客户端后先 `pnpm build`，否则测的是旧页面。
- **浏览器。** 默认用 `playwright install chromium` 装的 Chromium，设置 `LATCH_BROWSER_PATH` 时用该路径的 Chrome，都无头运行。WebKit 用例（`webkit.e2e.ts`、`preview-security-webkit.e2e.ts`，以及 `slash.e2e.ts` 等的 WebKit 分支）需要 `pnpm --filter @latch/e2e exec playwright install webkit`。
- **设备。** 每台设备是独立的 BrowserContext，用 `enrollBrowser` 经真实连接页登记。手机经 HTTPS 与邀请的登记只在 `enrollment.e2e.ts`。需要本机桌面端或另一台设备时，用 `testHost.enroll({ listener: 'unix' })` 等 API 设备直接驱动 Host。
- **走正常入口。** 用例经页面的真实控件到达状态：按 Host ID 打开会话用 `helpers/layout.ts` 的 `openSession`，不用 CSS 隐藏、直接调用内部函数或手填 DTO 代替。
- **输入框。** 消息输入框是 CodeMirror，`getByRole('textbox')` 是它的 `.cm-content`：`fill`、`press` 照用，但块显示名字，元素的文字不是草稿，`inputValue` 也不可用；草稿与光标只经 `e2e/helpers/prompt.ts` 的 `promptValue`、`promptSelection`、`setPromptSelection` 读写。
- **故障注入。** 拦截与替换只放在 Host 已授权的响应之后；拆除拦截前先释放并等待处理结算。
- **剪贴板。** 复制用例只在所测顶层页面记录内存写入并阻断选区复制，不读写系统剪贴板；系统剪贴板的传输要实机验证。
- **宽度与主题。** UI 用例覆盖手机、平板与桌面宽度和浅深色，并断言没有横向溢出、控件可达（`helpers/layout.ts` 的 `reachable`、`layersInWindow`）。
- **安全界面。** 连接页、审批卡与安全横幅在注入的样式下不变（`helpers/security.ts`）。
- **截图。** 写入 `test-results/<用例名>/`，不能包含凭据；二维码与设备指纹在截图前换成固定图案或设为透明。
- **夹具的限度。** 浏览器的可见性、时钟与触控模拟不等于 OS 后台、真机软键盘或真机 Safari；WebKit 不支持的能力不能算作该平台通过。

## 视觉截图

`e2e/visual.e2e.ts` 是 `pnpm test:e2e` 的一部分：把真实产品驱动到浏览器能到达的每个状态，在手机 390×844、平板 768×1024（都模拟触控）与桌面 1440×900 下以 `deviceScaleFactor` 1 截浅色与深色，并截原语总览页（`ui-gallery-<分组>`）。截取哪些状态以该文件为准。

技能 `latch-ui-check` 调用 `pnpm ui:check`：依次运行 `check:quick`、`@latch/ui` 与 `@latch/web` 的用例、构建，以及 `design.e2e.ts` 与 `visual.e2e.ts`。`--plan` 只列命令，`--boards`、`--baseline`、`--strict` 对应下面三个变量。

**输出。** `test-results/visual/<状态>--<视口>--<主题>.png` 与 `index.json`（每张图的状态、视口、主题、说明、尺寸与参考图 `board`）。参考图由 `LATCH_VISUAL_BOARDS=<json 文件>` 给出，格式为 `{ "<状态>": { "<视口>": "<文件名，{theme} 换成主题>" } }`。

**英文截图。** 用 `LATCH_VISUAL_LOCALE=en` 运行同一套 `visual.e2e.ts`，产物写到 `test-results/visual-en/`。录制前触发页面的系统语言更新并复验布局，录制后恢复夹具驱动用的中文。五种验收宽度另由 `i18n.e2e.ts` 直接在英文页面驱动，检查切换、焦点和同一份草稿。

**每次运行结果相同。** 改截取的状态时保持这些措施：

- 页面时钟用 `clock.setFixedTime` 固定，Host 的 `now` 固定在同一时刻；消息与运行的时间用 Host 的 `clock`，由脚本推进。
- 会话内容、设备名、电脑名称（`hostName`）与项目路径固定。项目放在系统临时目录下固定的 `latch-visual/`，其中的 `.owner` 记录进程号：同一台机器上一次只能有一个视觉运行，跨 worktree 也要串行。
- 截图用 `data-capture="still"` 冻结动效（`e2e/helpers/visual.ts` 的 `stillMotion`，根元素一出现就打上，早于页面脚本），它独立于设置写的 `data-motion`；隐藏光标，先等字体、图片与两帧，鼠标停在左上角。
- 触控视口也用点击驱动：模拟的轻点会留下 Chrome 的点按高亮。
- 每个状态都从新开的标签页出发，不依赖上一个状态。
- 设备指纹与核对码来自每次新生成的密钥，截图时只把这些文字设为透明，布局不变。
- 悬停、按下与键盘焦点用 DevTools 协议的 `CSS.forcePseudoState` 保持。
- 总览页逐组把视口加高到该组的高度再截：截取超出视口的元素（`captureBeyondViewport`）会丢掉触屏模拟，整页还会超过 Chromium 的 16384px 纹理限制。
- 同一次运行中重新驱动几个状态再截图，与第一次比较，不允许任何计入的不同像素。

**浏览器到不了的状态不截。** 本机确认卡片、添加项目、手机配对的二维码与桌面端可以回应的「仅提示」询问只出现在桌面端，由 `desktop.e2e.ts` 截图；二维码截图前换成同样大小的固定图案。

**比较。**

```sh
pnpm build
pnpm exec vitest run --config e2e/vitest.config.ts e2e/visual.e2e.ts
cp -R test-results/visual <基线目录>                      # 保存一次运行作为基线
LATCH_VISUAL_BASELINE=<基线目录> pnpm exec vitest run --config e2e/vitest.config.ts e2e/visual.e2e.ts
LATCH_VISUAL_BASELINE=<基线目录> LATCH_VISUAL_STRICT=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/visual.e2e.ts
```

- 设置 `LATCH_VISUAL_BASELINE` 时，最后一个用例把每张截图与基线中同名的图比较，为改变的图写差异图，并写出 `test-results/visual-diff/report.json`（相同、改变、缺少基线、基线中有而本次没有）。没有设置时该用例跳过。
- 只有 `LATCH_VISUAL_STRICT=1` 时，不相同的结果才使用例失败。
- 每次运行先清空 `test-results/visual/` 与 `test-results/visual-diff/`，基线目录必须在它们之外，否则用例开始时报错。
- 按 YIQ 感知色差逐像素比较，阈值 0.1：忽略很淡的色差，仍能发现改变的颜色令牌与移动的文字。
- 亮度介于更暗与更亮的相邻像素之间、且其中一个相邻像素在两张图中都处于平坦区域的像素视为抗锯齿边缘，不计入。代价：夹在两种纯色之间的 1px 线改了颜色时可能漏报。
- 字体与渲染随系统不同，只比较同一台机器上的截图。

## Electron e2e

```sh
pnpm build
LATCH_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts
```

- 只在 macOS 上运行；没有 `LATCH_ELECTRON_E2E=1` 或在其他系统上时整组跳过。
- 同一开关还控制 `desktop-*.e2e.ts`、`multi-host.e2e.ts`、`app-build.e2e.ts`，以及 `release-check.e2e.ts`、`file-tree-actions.e2e.ts` 与 `html-preview.e2e.ts` 的 Electron 部分。`e2e-desktop` 工作流只运行 `desktop.e2e.ts`；`pnpm check -- --plan` 另列与改动的桌面端文件同名的 `desktop-*.e2e.ts`（带这个开关），其他区域按文件名另跑。
- `native-relay-edge.e2e.ts` 的 Electron 用例从设置导入文件，经 Host 的测试确认与本地 Linux/TLS 中继登记。丢失保存成功的回执后用同一请求重试，再核对手机配对读到的签名连接簿及 Host 的签发状态。截图不包含配对信息。另一用例让真实 Host 经本地 TLS 的 Workers 适配器导入 Workers 中继文件（两个地址），测试两次只留一条测试路由，签进手机连接簿，拒绝另一把中继密钥并移除。运营者的验收命令在 `apps/relay-edge/test/accept.test.ts` 对同一适配器运行。
- Host 在测试进程内用 `startTestHost` 启动，测试用 `writeHostState` 写出记录测试进程 PID 的 `host.json`，再启动 `apps/desktop/src/main.cjs --latch-host-state=<host.json> --latch-user-data=<临时目录> --use-mock-keychain`。
- 例外是 `desktop-rebuild.e2e.ts`：它用 `ensureDesktopHost` 从 `dist/start.js` 启动真实 Host（临时数据目录，`policy.json` 停用本机确认，离线连接码连接），在 Host 运行时执行 `pnpm build:web` 重写 `dist/web`，再检查启动器先重启它、窗口连上且没有「转发请求失败」。
- 临时的 `--latch-user-data` 让凭据文件不碰用户的桌面端数据，`--use-mock-keychain` 让 safeStorage 不使用登录钥匙串。Electron 的环境来自 `desktopShellEnvironment`，不带 Host 设置、模型密钥与调试开关。
- Electron 由 Playwright 的 `_electron.launch()` 启动；它从自己的安装位置解析 `electron` 包，只能找到根 `node_modules` 中的那一份，所以根 `package.json` 保留 `electron`（CI 的 `pnpm exec install-electron` 也用它）。
- 原生对话框、`shell.openExternal`、`shell.showItemInFolder`、通知与剪贴板在主进程中替换成记录调用的内存实现：不打开真实面板，不投递系统通知，不读写系统剪贴板。系统剪贴板、原生粘贴快捷键、通知授权与专注模式要实机验证。
- 模型服务用例阻断外部 DNS，只用本地假服务；终端用例用假终端组件，登录用例运行夹具里的假 `codex login`，从不运行真实 CLI 的登录。
- 拒绝导航的检查放在用例最后：Playwright 把被拒绝的导航一直当作进行中，所以由主进程触发并监听 `will-frame-navigate`，之后只读取地址、不再驱动页面。
- 常规用例以开发模式运行（`devMode: true`）。正式打包模式拒绝调试参数与 mock keychain，不能为 Playwright 放宽这条规则。`desktop-cli.e2e.ts` 可通过 `LATCH_PACKAGE_APP` 指向本机应用包，使用复制出的主进程与 preload、临时用户目录和 mock keychain，验证命令行链接与布局；这不等于真实签名应用或钥匙串验收。

### 应用包定向验收

先 `pnpm build`，再运行 `pnpm package:desktop -- --out <新的绝对路径/Latch.app>`。`LATCH_PACKAGE_APP=<该路径> pnpm exec vitest run --config vitest.config.ts apps/host/test/distribution.test.ts` 将包内运行代码与 CLI 复制到临时目录，从不含源码的工作目录启动，使用停用本机确认的临时数据目录、演示模型、端口 0，并经 `latch status`、`device list`、`stop` 核对。它另在项目 PATH 放假 Node、设置假的加载器变量，验证没有执行项目里的程序或 Node 加载器。没有 `LATCH_PACKAGE_APP` 时该部分明确跳过。

同一文件编译原生发布启动器，另外用 ad-hoc 夹具验证挂起子进程的动态检查和失败回收。错误身份会在子进程写出任何内容前被终止并回收，正确的夹具身份才恢复执行。`presence-identity.test.ts` 验证首次固定、显式迁移、审计失败、身份变化、两侧记录分别缺失、禁止降级，以及每次调用前重新检查。Developer ID 正向验证与 Touch ID 由所有者验收。

`desktop-cli.e2e.ts` 的三种链接状态、三种宽度与浅深色截图默认写 `test-results/desktop-cli`，可用 `LATCH_PACKAGE_SHOTS` 指定验收目录。复制用内存剪贴板，登录 shell 使用临时 profile 和同名命令，核对含空格与单引号的包内绝对路径仍执行正确的程序。链接只写测试自己的临时目录。`enrollment.e2e.ts` 在指定 `LATCH_PACKAGE_APP` 时也核对包内页面显示安装命令。

分发用例同时走包内 `relay add`、`list`、`test` 与 `remove`。临时策略只放行假中继刚申请的回环端口，断言测试确实拨到了该端口。`relay setup cloudflare` 应在产生输出文件前拒绝。

## 构建产物检查

测试代码是 `@latch/testkit`（`packages/testkit/`）、`tests/`、`e2e/` 与各项目 `test/` 中的文件，只有测试导入它们：

- `pnpm check:boundaries`：`@latch/testkit` 在 `PROJECTS` 中标为只供测试，任何项目只能把它写在 devDependencies。
- `pnpm lint`：测试目录以外导入 `@latch/testkit`，或经相对路径导入 `tests/`、`test/`、`e2e/` 中的文件即失败。这条规则不检查 `require()`，所以桌面端的 CommonJS 源码另用 `grep -rnE "testkit|tests?/|e2e/|createTestPresence" apps/desktop/src` 检查，必须没有输出。
- Host 构建：`apps/host/scripts/host-bundle.ts` 的 esbuild 插件在入口引到上述任何文件时让构建失败（按解析后的真实路径判断）。

`pnpm build` 之后运行：

```sh
grep -rnE 'createTestPresence|startHostFixture|latch-test\.localhost|(tests?|e2e)/(helpers|fixtures)|packages/testkit|@latch/testkit' dist/
```

必须没有输出（grep 以状态 1 结束）。页面产物经过压缩，名称可能被改写，所以也匹配测试证书的主机名这类会原样保留的字符串。

## 仓库检查

这些命令检查仓库自身的结构，不运行产品代码；文件按 git 的列表读取，被忽略的文件不在其中。

**错误文案。** `pnpm error-copy` 列出 Host、core 与 harness-acp 抛出的每个 `AppError` 错误码，按有文案、显示 Host 原因分开计数；安全类错误码缺文案，或有抛出处认不出错误码（不在 `PASSED_ON` 里）时失败。`-- --list` 输出明细。`tests/error-copy-coverage.test.ts` 在真实代码上运行同一检查。

**界面语言。** `pnpm i18n:coverage` 扫描 Web、UI 与桌面源码的待迁移文案。用 `pnpm i18n:coverage -- --report` 查看每个文件的数量。首次建立名单用 `pnpm i18n:coverage -- --init`。每当文案迁移减少时用 `pnpm i18n:coverage -- --write` 更新，单个文件的待迁移数量增长会失败。Vitest 验证扫描和增长判断的行为。

- **`pnpm check:quick` 与 `pnpm check`**（`scripts/check.ts`）：依次运行各项，一项失败也继续，最后逐项写出结果，有失败时以状态 1 结束。
- **`pnpm check -- --plan`**（`scripts/verify-plan.ts`）：见[按改动选择回归](#按改动选择回归)。技能 `latch-verify` 按它运行并汇报。
- **`pnpm check:agents`**（`scripts/check-agents.ts`，规则在 `scripts/agent-docs.ts` 与 `scripts/doc-hygiene.ts`）：
  - 预算按 UTF-8 字节：根 `AGENTS.md` 不超过 16 KiB，其余每个不超过 4 KiB，从仓库根到任一 `AGENTS.md` 的路径上合计不超过 24 KiB（Codex 把这条路径上的文件拼在一起，超过 32 KiB 的部分不读）。超限时把只对子目录有效的规则移到子目录，或把机制说明移进 `docs/` 并留链接。
  - 每个 `AGENTS.md` 旁有 `CLAUDE.md`：项目中的内容恰为 `@AGENTS.md`，根文件以它开头。
  - 每个 Markdown 文件中的相对链接指向存在的文件，`#锚点` 对应目标文件中的标题（GitHub 的规则）。
  - `AGENTS.md`、`CLAUDE.md` 与 `SKILL.md` 在行内代码与 shell 代码块中提到的路径存在；占位、通配、URL、包名开头的导入路径与 git 忽略的路径不检查。
  - 写成 `<文件>#<用例名>` 的用例引用：文件存在，名称按 ` > ` 分开的每一段都以字符串字面量出现在文件中。
  - 根 `AGENTS.md` 提到每个 workspace 项目的目录；每个技能的 `SKILL.md` 有与目录同名的 `name` 与 `description`，`.claude/skills` 中恰好有指向它们的链接。
  - 每个 `docs/*.md` 以 front matter 开头，含 `description` 与非空的 `sources`，`sources` 中的路径都存在。
  - `docs/` 的文件名都在 `scripts/doc-hygiene.ts` 的列表里；`docs/`、`AGENTS.md` 与根目录各语言的 `README` 不含词表中的词。词表只存哈希，防误写，不是保密手段。
- **`pnpm docs:affected`**（`scripts/docs-affected.ts`）：列出 `sources` 覆盖改动路径的 `docs/*.md` 与相关的 `AGENTS.md`；只是候选，从不失败。
- **`pnpm agents:sync`**（`scripts/agents-sync.ts`）：为每个技能建立相对链接 `.claude/skills/<名称>` → `../../.agents/skills/<名称>`，删除指向已不存在的技能的链接。检出不支持符号链接时 `check:agents` 失败；复制加校验的做法尚未实现。
- **`pnpm security:scan`**（`scripts/security-scan.ts`，规则在 `scripts/security-rules.ts`）：只看新增行，是安全审阅的机械部分；技能 `latch-security-review` 在它之后按不变量审阅。

## 供应链金丝雀

`pnpm check:supply` 依次检查三件事，任何一项失败都以状态 1 结束：

- **例外**：`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 与 `trustPolicyExclude` 只能写 `name@精确版本`（可用 `||` 列出几个精确版本）；每组以 `reason:`、`reviewer:`、`expires:` 注释开头。`expires` 是 UTC 日期，当天仍有效、次日起失败，最多写到 90 天后；条目必须仍在 `pnpm-lock.yaml` 中。
- **`packageManager`**：sha512 必须等于 `https://registry.npmjs.org` 为该 pnpm 版本公布的完整性值。pnpm 自己切换版本时不读这个哈希，只有经 Corepack 安装时才校验，所以由这里核对。需要网络，读不到时失败。
- **安装金丝雀**：在 127.0.0.1 上启动只含夹具包的 registry，每个金丝雀在自己的临时项目、store、cache 与 `HOME` 中，用仓库的 `pnpm-workspace.yaml` 运行一次 `pnpm install`，必须以对应的错误码失败（见下表）。另有一个满 7 天、无脚本的对照包必须能安装，否则失败说明不了策略。

| 金丝雀 | 错误码 |
| --- | --- |
| 带 postinstall 的包（且脚本没有运行） | `ERR_PNPM_IGNORED_BUILDS` |
| 发布 3 天的版本 | `ERR_PNPM_NO_MATURE_MATCHING_VERSION` |
| git 来源的传递依赖 | `ERR_PNPM_EXOTIC_SUBDEP` |
| 没有 `time` 的元数据 | `ERR_PNPM_MISSING_TIME` |
| 信任证据下降的版本 | `ERR_PNPM_TRUST_DOWNGRADE` |
| 锁文件中发布不足 7 天的版本的冻结安装 | `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` |

金丝雀用运行脚本的 pnpm（`npm_execpath`），版本必须等于 `packageManager`，所以要经 pnpm 运行（`pnpm check:supply`、`pnpm test` 或 `pnpm exec vitest`）。

`supply-canaries.test.ts` 用同一套夹具再验证一遍，并把每个金丝雀守护的设置放宽，断言此时安装成功：每个金丝雀只因它对应的设置而失败。升级 pnpm 前先让这些用例在新版本上通过。

## 持续集成

GitHub Actions 的工作流在 `.github/workflows/`：

| 工作流 / 作业 | 触发 | 运行器 | 内容 |
| --- | --- | --- | --- |
| `ci` / `static` | PR、推送到 `main` | `ubuntu-24.04` | `pnpm check:supply`、`fmt:check`、`lint`、`typecheck`、`check:boundaries`、`check:agents`、`knip`、`check:workflows` |
| `ci` / `unit` | PR、推送到 `main` | `ubuntu-24.04` | `pnpm test`（浏览器用运行器自带的 Google Chrome） |
| `ci` / `build` | PR、推送到 `main` | `macos-26` | `pnpm build`；确认组件签名有效；`presence.test.ts`（含组件的 `--self-test`）；构建产物检查 |
| `e2e-web` | 每天 03:23（Asia/Shanghai）与手动 | `ubuntu-24.04` | `pnpm build` 后用运行器自带的 Google Chrome 运行 `pnpm test:e2e` |
| `e2e-desktop` | 改动该工作流 `paths` 所列文件的 PR；推送到 `main`、`v*` 标签与手动 | `macos-26` | `pnpm build`、`pnpm exec install-electron`，再以 `LATCH_ELECTRON_E2E=1` 运行 `desktop.e2e.ts` |

- `e2e-desktop` 的 `paths` 是桌面端壳、桌面启动脚本、Host 发现与凭据、页面 CSP、依赖版本、该用例与它的辅助；`scripts/verify-plan.ts` 按同一组路径列出 Electron 用例，改一处时同步另一处。
- 每个作业先经 `.github/actions/setup/` 安装 `.node-version` 的 Node.js 与 `.go-version` 的 Go；Corepack 安装 `packageManager` 指定的 pnpm，sha512 不符时拒绝；`pnpm install --frozen-lockfile` 对锁文件中的每个版本重新执行隔离期与信任检查。
- e2e 失败时上传 `test-results/`（保留 7 天）。
- `unit` 在 Linux 上运行，macOS 专用的用例在那里跳过，由本机的 `pnpm test`（pre-push 钩子）覆盖。

工作流的规则，`pnpm check:workflows` 检查其中大部分：

- 每个 `uses:` 固定到完整的提交 SHA，行尾注释写版本；仓库内的 action 用 `uses: $/<路径>` 引用，GitHub 从正在运行的提交读取它，而不是读工作区中可能被前面步骤改过的文件。
- 工作流级 `permissions: {}`，作业只列出需要的权限；`actions/checkout` 设 `persist-credentials: false`；不用 `pull_request_target` 与 `workflow_run`，不使用密钥。
- 工作流级 `cache-mode: none`，`setup-node` 设 `package-manager-cache: false`，Go 也关闭缓存：一次运行（包括外部 PR 的运行）留不下被后续运行读取的文件。zizmor 的任何发现都使检查失败，`cache-poisoning` 规则在 `.github/zizmor.yml` 中升为最高级别。
- actionlint 1.7.12 不认识 `cache-mode` 与 `$/`，`.github/actionlint.yaml` 只忽略这两条报错；固定的 actionlint 支持后删除对应条目。
- 更新 action：用 `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` 取提交（附注标签再取 `git/tags/<sha>` 的 `object.sha`），只选发布满 7 天的版本，更新每处引用的 SHA 与版本注释后运行 `pnpm check:workflows`。
- 更新 actionlint 或 zizmor：在 `scripts/workflow-tools.ts` 中修改版本与四个平台归档的 SHA-256；每个归档先用 `gh attestation verify <文件> --repo <项目>` 核对来源。`pnpm check:workflows` 下载后先核对 SHA-256，不符时不解压。

## Git 钩子

每个克隆手动设置一次：

- `pnpm exec lefthook install` 安装 `lefthook.yml` 的钩子：pre-commit 检查暂存文件的格式与 lint 错误，pre-push 运行 `pnpm typecheck` 与 `pnpm test`。`pnpm install` 不会安装钩子（`allowBuilds` 禁止 lefthook 的安装脚本）。
- `git config blame.ignoreRevsFile .git-blame-ignore-revs` 让 `git blame` 跳过只改格式的提交。

Git 已设置 `core.hooksPath` 时 lefthook 拒绝安装：不要加 `--force`（会写入那个目录）或 `--reset-hooks-path`（会删除该设置），改为提交前运行 `pnpm exec lefthook run pre-commit`、推送前运行 `pnpm exec lefthook run pre-push`。

只定义 pre-commit 与 pre-push：钩子执行检出内容里的 `lefthook.yml`，检出或合并类钩子会在切换分支的瞬间运行那个分支的命令。

## 人工检查本机确认（Touch ID）

自动化测试从不显示真实的系统确认表单。唯一运行真实组件的用例是 `presence.test.ts` 的自检：`latch-presence --self-test packages/testkit/vectors/security-v1.json` 只计算并比对向量，不调用 LocalAuthentication；它只在 macOS 上、且 `dist/native/latch-presence` 已构建时运行。

系统表单、Touch ID 与登录密码只由本人检查，Agent 不运行这条命令：

```sh
pnpm build:presence
pnpm latch presence test --data-dir <临时目录>
```

- 它先打印系统提示应显示的理由，再弹出 macOS 的标准 Touch ID 表单。核对表单里的理由与打印的一致，表单显示的应用名应为 Latch；Latch 自己不画任何窗口。
- 依次检查：Touch ID（这台 Mac 不支持时改用登录密码）、「取消」，以及放置不动直到超时（组件 115 秒后自己关闭表单，结果为 `timeout`）。
- 对没有运行 Host 的临时数据目录，命令持有数据目录锁，并在第一次使用时登记组件签名。重新构建组件会改变签名，之后换一个新的临时目录，或运行 `pnpm latch presence repin --data-dir <同一目录>`。

## 不在自动化范围内

- iOS/iPadOS 真机：软键盘、输入法、后台挂起、读屏、Secure Enclave、Face ID、钥匙串、App Attest、Bonjour 重连与跨网络；真机经 Tailscale 证书的 HTTPS 访问；公网代理与中继的公网部署。
- 模拟器里的 App：SDK 编译与固定样本截图不代替安装后的布局、主线程与流量验收；Swift 互操作用例（`native-swift.test.ts`）只测核心与协议，不启动 App。
- 真实模型服务的完整兼容矩阵、真实 BYOK 与未覆盖的真实 CLI 场景。单回合验收须经所有者授权并显式开启。在不发送提示时也可以检查握手（`initialize`、`session/new`）。
- macOS 的系统确认表单（见上一节）、原生文件夹面板、Quick Look、系统通知与系统剪贴板。
- Linux 与 Windows 上的本机确认尚未实现（没有对应的确认组件），相关用例只覆盖「不可用」路径与桌面端的离线连接码。
- 正式签名、公证后的 Electron 应用（`desktop-release.test.ts` 只测参数、缺身份时的拒绝、Info.plist 与签名顺序）、本地网络授权弹窗与它在更新后是否保留、真实系统 Node 安装路径的跨机器矩阵与发布身份的正向验证。
- 真机 Safari：Playwright WebKit 与 Chromium 的手机尺寸、触控模拟都不代表它。

## 已执行与未执行

汇报时逐条写出实际运行的命令及结果（通过、失败、跳过的数量）；没有运行的检查写明「未运行」与原因。以下情况即使命令整体通过，也算未执行：

- Vitest 报告为跳过的用例：没有对应开关的 Electron、真实 CLI、iOS 与性能用例；不在 macOS 上或 `dist/native/latch-presence` 未构建时的组件自检；非 macOS 上的路径别名、`--code-file` ACL 与目录枚举用例；以 root 运行时的目录属主用例。
- 改了客户端却没有重新 `pnpm build` 就运行的 e2e：它测的是旧的 `dist/web`。改了 `native/macos/LatchPresence.swift` 却没有重新构建组件时的自检同理。
- 没有对当前构建运行的「构建产物检查」。
- 没有人实际操作过的人工检查（Touch ID 窗口、真机、真实 Agent）。

浏览器 e2e 通过不代表桌面端已验收；测试夹具、测试确认后端与演示模型不代表真实模型、Touch ID 或真机。
