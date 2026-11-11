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
  - scripts
  - vitest.config.ts
  - lefthook.yml
  - .github/workflows
  - package.json
---
# Latch 测试指南

预览引用边界由 `apps/web/test/preview-quotes.test.ts` 覆盖，真实的 Office 页/选区、表格选区与更新后的冻结偏好由 `e2e/preview-renderers.e2e.ts` 验证；`file-tree.e2e.ts` 验证三种宽度的真实文件摘录只追加草稿且不发请求，`file-preview.e2e.ts` 检查文件自动更新后保留阅读行。

`e2e/workflows.e2e.ts` 覆盖外观切换时保留草稿、输入聚焦与上一条消息、Host 分支投影、可操作首次引导及通知首次选择；通知 UI 使用有限壳夹具，真实主进程状态和 preload 过滤由 `apps/desktop/test/notifications.test.ts` 验证，Electron 用例核对实际公开接口。`e2e/file-tree.e2e.ts` 同时验证没有标签时的文件快捷键。
`e2e/palette.e2e.ts` 在三种宽度与深浅色用真实 Host 走完命令面板的分组、搜索中与失败的文字、Esc 逐级退回、焦点回到输入框，查找条的位置（不挤压对话）、长回答内的定位、运行中不跳走与不丢步，迟到的结果不换回车打开的行，输入法组合键，Esc 不误停运行或误拒请求，以及只显示当前客户端按键的快捷键浮层与它链到的快捷键页；截图写入 `test-results/palette/`。
`e2e/workbench-keyboard.e2e.ts` 在三种宽度驱动真实 Alt 按键，核对会话循环、数字跳到第 N 个会话（超出不动）、待处理审批卡的循环与焦点高亮、文件搜索及关闭；同时检查草稿、消息与审批身份保留，且导航不增加模型调用或执行提交。另在 Chromium 与 WebKit 的三宽里检查 Alt / 的快捷键浮层盖在运行中的会话上（焦点进搜索、Esc 回到输入框、再按关上、不导航）与 Alt Shift 1–4 在会话和新会话页各打开自己的控件菜单，手机宽度两者都没有，按键不离开页面、不打开新页。
`e2e/session-drafts.e2e.ts` 用另一个真实登记设备删除当前普通或 Agent 会话，验证客户端清除对应草稿，新会话不会继承文字，也不会自动提交；另把真实 Host 的发送与重新发送回执延迟到切换会话之后，检查阅读目标和两段草稿保持各自归属。内存缓存的按会话隔离、私有清理、数量与字符上限由 `apps/web/test/session-drafts.test.ts` 覆盖。
连接插件的定向回归包括 `tests/transport-registry.test.ts`、`packages/link-client/test/transport.test.ts`、`carrier-vector.test.ts` 与 Host 的 `native.test.ts`；`e2e/native-relay.e2e.ts` 另把官方 relay 通过注册 driver 真实消费。MessagePort 示例会实际加载并运行。它们是纯 Node/Go 与本机消息测试，不等同真实飞书、手机 connector、OS 通知或真机验收。

系统性测试统一使用 Vitest；Playwright 只在 Vitest 内作为真实浏览器与 Electron 的驱动。测试只使用临时目录、端口 0（或临时选出的空闲端口）、本地假模型服务、假 ACP Agent 与测试用的本机确认后端：不读取用户密钥，不调用付费模型，不启动真实 Agent CLI，不使用默认数据目录、`.runtime*/` 或端口 4317，也不停止或重启用户正在运行的 Host。

构建与原生链路测试需要已修补的 Go 1.26.10 或 1.27.3 及其后续安全补丁；宿主机已有的旧 Go 不能替代此要求。可用 `LATCH_RELAY_GO=/absolute/path/to/go` 指定经过核对的编译器。CI 的共同 setup 固定 `actions/setup-go` 的完整提交、明确使用 Go 1.26.10，并关闭模块缓存；没有 go.mod，也不在构建时下载 Go 模块。action 的 v7.0.0 发布于 2026-07-16，固定提交已与官方标签核对。

## 命令

手机接入的 `desktop-native.e2e.ts` 经真实 Electron 的 host.sock 代理打开配对表单、签发非 URL 二维码，并核对没有设置表单、权限选择、暂停或倒计时，关闭表单后 Host 上的二维码失效，Touch ID 之后连按 Esc 也不起作用。设置页覆盖 390/820/1280、浅深色；截图只在没有二维码时写到 `test-results/native-phone/`。`phone-page.e2e.ts` 在浏览器里把这台设备当作 Mac 上的桌面端、Host 的回答换成固定值，走完 设置 › 设备 与配对表单的每个状态，三宽浅深色截图写到 `test-results/phone-page/`，并在桌面宽度核对列表读取失败、开关与恢复的请求、无法确认后恢复、被拦下与请求不重叠；那里的二维码由失效的固定内容生成。`native-settings.test.ts` 检查 `native/info` 的内容，且配置与暂停路由已不存在。

Host、host-swift、link-client 与 relay 四个 Node project 的 globalSetup 会从本地产品源码构建原生 TLS 组件，UI project 不触发它。需要修复过 TLS 安全问题的 Go 1.26.x ≥1.26.10 或 1.27.x ≥1.27.3；`LATCH_RELAY_GO` 只选择构建编译器，不传运行时密钥。配置与清单约束直接读文件，不为它们添加字面断言。

```sh
pnpm check:quick                             # fmt:check、lint、typecheck、check:boundaries、check:agents，见下方「仓库检查」
pnpm check                                   # check:quick 加 knip 与 test；每项都运行，最后逐项汇报
pnpm check -- --plan                         # 只列出改动要求的检查与用例，不运行；--base <ref> 比较某个提交以来的改动
pnpm typecheck                               # tsc -b，分同构包、插件 SDK、core、浏览器、Host（含 ACP Driver）、桌面端 CJS 与测试检查
pnpm lint                                    # oxlint 与类型感知规则；导入边界、循环导入与运行环境的全局变量是错误，其余只报告
pnpm fmt:check                               # oxfmt 格式检查（不改文件）；pnpm fmt 写入
pnpm test                                    # 各项目的单元与集成用例（见下方「测试位置」），默认用例超时 15 秒
pnpm test --project @latch/host              # 只运行一个项目：latch（tests/）、@latch/host、@latch/host-swift、@latch/web、@latch/desktop、@latch/harness-acp、@latch/ui
pnpm build                                   # e2e 使用 dist/web；macOS 上同时构建 dist/native/latch-presence
pnpm --filter @latch/e2e exec playwright install chromium   # 或用 LATCH_BROWSER_PATH 指定已安装的 Chrome
pnpm test:e2e                                # e2e/ 中的 *.e2e.ts（e2e/vitest.config.ts），文件依次运行，默认用例与钩子超时 120 秒
pnpm check:boundaries                        # workspace 项目的运行环境与可用的 workspace 包，见 ARCHITECTURE.md「Workspace 项目」
pnpm knip                                    # 未声明或无法解析的导入即失败，其余发现只报告
pnpm check:supply                            # 依赖例外、packageManager 的 sha512 与安装金丝雀，见下方「供应链金丝雀」
pnpm check:workflows                         # actionlint 与 zizmor 检查 .github/，见下方「持续集成」
pnpm check:agents                            # AGENTS.md、CLAUDE.md、技能与 docs/ 的结构性检查，见下方「仓库检查」
pnpm docs:affected                           # 改动可能需要更新的 docs/ 与 AGENTS.md；--base <ref> 同上
pnpm security:scan                           # 新增行中的秘密形状与禁用 API、需要一起修改的文件；--base <ref> 同上
pnpm agents:sync                             # 把 .agents/skills/<名称> 链接到 .claude/skills/<名称>

pnpm exec vitest run --config vitest.config.ts <目录>/<name>.test.ts      # 定向运行单元与集成用例，如 apps/host/test/server.test.ts
pnpm exec vitest run --config e2e/vitest.config.ts e2e/<name>.e2e.ts    # 定向运行 e2e
pnpm exec vitest run --config vitest.config.ts <目录>/<name>.test.ts -t '<分组> > <用例>'   # -t 匹配以 " > " 连接的完整用例名

LATCH_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm test:e2e
LATCH_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts     # 只在 macOS 运行
pnpm build:presence                          # 只重新构建 macOS 确认组件（源码比产物新时才重新编译）
```

e2e 相关的环境变量：`LATCH_BROWSER_PATH`（使用已安装的 Chrome）、`LATCH_E2E_UI_DIR`（浏览器 e2e 的页面目录，默认 `dist/web`）、`LATCH_ELECTRON_E2E=1`（运行原生窗口用例），都经 `@latch/host/env` 的 `latchEnv` 读取；视觉截图另有 `LATCH_VISUAL_BASELINE`、`LATCH_VISUAL_STRICT` 与 `LATCH_VISUAL_BOARDS`（见[视觉截图](#视觉截图)）。

命令都在仓库根目录运行，并显式给出 `--config`：Vitest 不会到上级目录查找配置文件。

### 测试位置

单元与集成用例跟随它所测的项目，放在该项目的 `test/` 中；`vitest.config.ts` 为每个有用例的项目声明一个 Vitest project（名称即包名），共用同一组选项与 Vite 服务器：

| project | 目录 | 内容 |
| --- | --- | --- |
| `@latch/host` | `apps/host/test/` | Host、内置插件与 Host 脚本（启动、停止、`pnpm latch`、桌面启动器、构建） |
| `@latch/host-swift` | `apps/host/test/native-swift.test.ts` | Swift 原生核心与 Host 的互操作；全局 setup 在任何用例开始前编译 `LatchNativeFixture`，新检出首次约一分多钟，其余运行不触发 |
| `@latch/web` | `apps/web/test/` | 浏览器客户端（组件以 `react-dom/server` 渲染为字符串，不启动浏览器）、样式表与开发代理 |
| `@latch/desktop` | `apps/desktop/test/` | 桌面端壳的 CommonJS 模块（经 `createRequire` 加载，不启动 Electron） |
| `@latch/harness-acp` | `packages/harness-acp/test/` | ACP Driver |
| `@latch/ui` | `packages/ui/test/` | 设计系统：令牌、样式表与原语组件，在真实浏览器中运行（见下方「组件测试」） |
| `latch` | `tests/` | 尚未带测试目录的包（`@latch/core`、`@latch/sdk` 与根包的再导出）与仓库脚本（`scripts/`） |

原生连接底座还有三个 Vitest project：`@latch/link-wire`、`@latch/link-client` 与 `@latch/relay`，共同使用 `packages/testkit/vectors/link-v1.json`；用例只连本地端口 0，不能据此声称 Secure Enclave、Face ID、App Attest 或公网部署已验收。`pnpm build:relay` 生成 `dist/relay/latch-relay.mjs` 并拒绝测试代码进入产物。

各 project 的工作目录都是仓库根，所以用例里的 `dist/web`、`node_modules/.bin/tsx` 等相对路径在每个 project 中含义相同。`@latch/ui` 是浏览器模式的 project，有自己的 Vite 服务器。

全部 e2e 在 workspace 项目 `@latch/e2e`（`e2e/`）中，由它自己的配置 `e2e/vitest.config.ts` 运行（见[浏览器 e2e](#浏览器-e2e)与[Electron e2e](#electron-e2e)）。这个配置不设 `root`，同样从仓库根运行：`include` 与用例里的路径都按工作目录解析。

### 组件测试（浏览器模式）

`@latch/ui` 的用例在真实浏览器中运行：Vitest 浏览器模式（`@vitest/browser-playwright` 只作驱动），浏览器是 `LATCH_BROWSER_PATH` 指定的 Chrome，没有设置时是 `pnpm --filter @latch/e2e exec playwright install chromium` 装好的 Chromium，都无头运行。这些用例检查只有浏览器才算得出的东西：角色与可访问名称、焦点与键盘、提示框、计算后的样式与尺寸、层叠层、顶层（top layer）的弹层与模态对话框。它们属于 `pnpm test`，所以 `pnpm test`（与 pre-push 钩子）需要上面两种浏览器之一。

- 组件用 `vitest-browser-react` 的 `render` 渲染（每个用例后自动卸载，`test/setup.ts` 打开 React 的严格模式，挂载时的副作用都运行两遍）；交互用 `vitest/browser` 的 `userEvent`（Playwright 的真实键盘与指针），断言用 `expect.element(定位器)`，它会等待到条件成立。`aria-disabled` 的控件 Playwright 不肯点击，要验证它拦下点击时用 `test/helpers.ts` 的 `press`（经 DOM 点击）。
- `test/setup.ts` 按页面的顺序把 `tokens.css` 与 `ui.css` 注入页面（Vite 的 `?inline`），所以样式与层叠层和页面一致；读样式表源码的用例用 `?raw` 或 `import.meta.glob`，读其他文件用 `vitest/browser` 的 `commands.readFile`（路径从仓库根算起）。
- 触屏用 DevTools 协议模拟：`test/helpers.ts` 的 `onTouchScreen` 打开 `Emulation.setTouchEmulationEnabled`，`(pointer: coarse)` 随之成立；深色与减少动效用同一文件的 `emulateMedia`：`Emulation.setEmulatedMedia` 每次替换全部模拟的媒体特性，没写的特性回到系统偏好，所以它每次写全 `vitest.config.ts` 里 Playwright 上下文的浅色与其余默认值，结束后恢复，系统为深色时后面的用例仍是浅色；不要直接调用 `setEmulatedMedia`。手机宽度用 `page.viewport(390, 844)`，用例结束前恢复 1280×800。
- 用例导入的依赖在第一个用例之前就预构建（`optimizeDeps.entries` 指向这些用例），运行中途不会因发现新依赖而重新加载页面。
- `test/gallery/` 是原语总览页：`Gallery.tsx` 由用例渲染（检查每个样式表画的原语都在页上、每个控件都有名称、总览页的排版不改原语的标题、手机宽度下就地画出的对话框与弹层不超出卡片、深色与减少动效），`index.html` 与 `main.tsx` 由视觉截图构建（见[视觉截图](#视觉截图)）。它只在测试中构建，不进入 `dist/web`。

### 报告与用例集合

- Vitest 的报告与附件写入 `.vitest/`（已在 `.gitignore` 中）：`--reporter=json` 写 `.vitest/json/output.json`，`--reporter=junit` 写 `.vitest/junit/output.xml`，附件在 `.vitest/attachments/`。e2e 截图仍由用例写入 `test-results/`。
- 升级 Vitest、移动或改名测试文件时，比较前后的用例集合（文件加完整用例名）。集合来自 JSON 报告，或来自只收集不运行的 `pnpm exec vitest list --config <配置> --staticParse=false --json=<文件>`。每个消失或新增的用例都要说明原因。`vitest list` 默认静态解析源码，不展开 `it.each`，还会把 `testHost(…)` 这类辅助函数调用当成用例，所以不加 `--staticParse=false` 的结果不能用来比较。

## 按改动选择回归

原生与中继的回归见 `apps/host/test/native*.test.ts` 与 `e2e/native-*.e2e.ts`。`e2e/ios-app.e2e.ts` 用临时 DerivedData 构建真实 iPhone/iPad App，禁用签名且不启动 App。

| 改动 | 用例 |
| --- | --- |
| 共享安全编码 | `crypto.test.ts`、`identity.test.ts`、`presence.test.ts`、`client-security.test.ts`、`desktop-proxy.test.ts` |
| 设备与凭据 | `auth.test.ts` |
| 监听入口 | `auth.test.ts`、`server.test.ts` |
| 本机确认服务 | `presence.test.ts` |
| Agent 启动诊断 | `agent-probes.test.ts`、`packages/harness-acp/test/probe.test.ts`、`presence.test.ts` |
| 安全策略 | `policy.test.ts` |
| 审计 | `audit.test.ts`、`audit-actions.test.ts`、`cli.test.ts` |
| 出站策略 | `egress.test.ts` |
| 路径与项目目录：数据目录解析顺序、运行目录、项目登记规则、受保护目录、macOS 路径别名、私有文件检查；从每个 workspace 项目内都得到仓库根作为程序目录，在每个项目目录中启动的进程里 `latchCodeRoot()` 也返回仓库根 | `paths.test.ts` |
| 项目生命周期：旧会话与只接收主文件夹的 Driver 换序后继续、无预览插件的全部目录确认、手工不一致状态的保留、移除或替换与新会话的竞争、策略收紧不等待慢启动、自有目录跨重启幂等；默认项目名称长度与离线实际启动上下文 | `project-regressions.test.ts`、`projects.test.ts`、`cli.test.ts`；旧桌面端文件夹协议门禁见 `shell-folders.test.ts` |
| 会话自己的文件夹：名称、0700、从不沿用已存在的条目、同一请求得到同一个文件夹、没建成会话时删除空文件夹、只认启动目录中的真实目录 | `session-folders.test.ts`；在真实 Host 中的新建、只对话与所有者指定的启动目录、重启后继续、链接替换、远程策略、L3 确认中的工作目录与「存为项目」见 `server.test.ts` 的 `sessions in folders of their own` |
| 新建工作树：钩子、fsmonitor、filter（仓库、include 与全局配置，含全局 `includeIf "onbranch:latch/**"` 只在新分支上带进的驱动）与 LFS 从不运行，继承的 `GIT_*` 变量不起作用，每种拒绝都不留下分支或工作树，任一步失败都回滚，`.worktreeinclude` 的复制规则，只认带标记的工作树（换分支或分离 HEAD 后仍认），重启后的重试找回同一个，没开始的会话只在 Git 判断没有改动时移除，不在 Latch 自己的目录周围新建；会话在工作树里开始：启动指纹取工作树里的配置，引用文件在工作树里核对，确定失败不留下工作树与分支，标记不再属于会话时之后的轮次被拒绝 | `worktrees.test.ts`、`worktree-sessions.test.ts`；会话记录见 `hub.test.ts` 的 `keeps the worktree a session was started in`；共用的 Git 运行器见 `changes-git.test.ts`；页面见 `e2e/worktrees.e2e.ts` |
| Standard 工具的风险分级（R0/R1/R2，按所选项目文件夹判断） | `risk.test.ts`；运行时按分级询问见 `runtime.test.ts` 的 `Host risk classification` |
| 日志脱敏，以及文本是否含密钥（`containsSecret`） | `redact.test.ts` |
| 会话文件：引用解析、文件夹边界、文件分类与句柄、本机动作、预览范围与审计；桌面端原生动作与内容代理；回复里的路径标记 | `files.test.ts`、`file-content.test.ts`、`desktop-files.test.ts`、`desktop-proxy.test.ts`、`file-reference.test.ts`、`file-references.test.ts`、`message-content.test.ts`；浏览器 `file-chips.e2e.ts`，Electron `desktop-files.e2e.ts` |
| HTTP API：监听入口、登记与续期、事件流、限流、权限、审批、完全访问（L3）会话、模型服务密钥与地址确认、项目、策略与审计接口、会话与插件 | `server.test.ts`、`harness-host.test.ts`；路由模块保留各自的监听入口与 scope 检查：`route-guards.test.ts` |
| 审批与取消的回执：重启前决定、重启后重试同一请求（Driver 未挂载时也重放）、同一取消的并发副本（含第一个副本失败）、对已结束运行的取消与迟到的取消不停止新的一轮；回执随会话保存、旧文件、读不懂的条目、7 天与每台设备 1 万条的上限、写入失败、合并写入 | `server.test.ts` 的 `receipts and cancels`、`session-meta.test.ts`；Driver 的 `runId` 在 `runtime.test.ts` 与 `acp.test.ts`，Hub 不转出格式不符的 `runId` 在 `hub.test.ts` |
| 流量计数：大小分档、按会话与事件流汇总、上限、只有数字、只给 `admin` 与匿名 `host.sock` | `traffic.test.ts`、`server.test.ts` 的 `traffic counters`；`pnpm latch traffic` 在 `cli.test.ts` |
| Host 进程：`apps/host/scripts/start.ts` 的输出与凭据不落盘、明文局域网与 HTTPS 绑定地址的拒绝、从打包产物启动时只运行 Host（不运行一同打包的确认组件构建；按 `apps/host/scripts/host-bundle.ts` 的选项打包）、Host 构建遇到测试代码（`@latch/testkit`、`packages/testkit/`、`tests/`、`e2e/`、各项目的 `test/`）即失败、数据目录锁、旧版本 `host.json`、`pnpm stop` 的核对与说明、IPv4 映射的 Tailscale 地址 | `security.test.ts` |
| `pnpm latch` 命令、离线命令与数据目录锁（过期锁接管、开机时间、多进程争用、接管残留）、`--code-file`、`--disable-sigusr1`（等待输入时 SIGUSR1 不打开调试端口，需经 pnpm 运行） | `cli.test.ts` |
| 模型协议（OpenAI 兼容、Anthropic）、思考、模型列表与检测、只经注入的 fetch 出站、密钥的源与路径绑定、上游错误中的密钥脱敏、演示模型与演示工具 | `providers.test.ts` |
| 配置文件、迁移（含已有密钥的源与路径绑定）、0600 原子写入 | `config.test.ts` |
| Standard 执行循环、模型与目录选择、用量、审批选项、风险分级、删除与恢复 | `runtime.test.ts` |
| 插件生命周期、租约、替换与卸载 | `registry.test.ts` |
| 自定义插件资产：有限模板/声明、路径与预算、私有原子存储与原请求恢复、确认前不导入、相同摘要重启复用、草稿与应用分离、激活回滚、运行中 Harness 拒绝卸载、旧租约释放、等待后撤权与审计故障收紧 | `plugin-assets.test.ts`、`plugin-package-api.test.ts`、`plugin-packages.test.ts`、`presence.test.ts` |
| `latch/plugin-sdk` 与 `harness-sdk`（再导出 `@latch/sdk` 的类型子路径）在外部 TypeScript 项目中通过检查（不开启 `allowImportingTsExtensions`），以改名前的包名安装时也通过 | `plugin-sdk.test.ts` |
| 多 Harness 路由、审批路由、权限级别、会话元数据 | `hub.test.ts`、`harness-host.test.ts` |
| 会话生命周期事件：运行开始先于第一条提示到达模型或 Agent，带会话的项目与文件夹；运行结束每次一个，只在真实结算之后（请求取消不算）；归档与删除各一次，带项目；停止时先于关闭 Driver 与监听入口，未结束的运行不再有运行结束事件；等待中的运行可被取消，Host 停止时不会再发出提示；没有监听器时不读 Driver，读取有合并，迟到的读取不影响新一轮；监听器抛错、拒绝或超时不影响运行与停止；订阅者拿到的对象只能监听 | `session-lifecycle.test.ts` |
| ACP：环境白名单与私有临时目录、启动指纹、项目配置、权限模式读回与漂移、映射、审批与选项过滤、取消、崩溃与恢复、进程上限；子 Agent 的审批（含一轮结束后才到或仍在等的请求、OpenCode 2.x 发在启动它的会话上的更新与请求、以会话的权限为上限的拒绝与审计、报告更宽模式时停止、单独停止在它报告之前不写已停止） | `acp.test.ts`（`ACP subagents`）、`subagents.test.ts`、`replay.test.ts`（`opencode/2.x/subagent_*`）；单独停止的路由与审计、子 Agent 请求挂起时本机确认全部被拒绝见 `server.test.ts` 的 `lets any device stop one subagent alone`（另见 [HARNESSES.md](HARNESSES.md) 的「测试」） |
| Harness 中途重试（Gemini CLI）：断开前的文字丢掉、回复沿用同一个 ID、重试是一行系统消息而不进思考、这一行在被它打断的文字之后（等待中停止时也是）、刷新后只有一份，其他 Agent 的 `_meta` 不解释 | `acp.test.ts`、`replay.test.ts` 的 `gemini/retry`；页面见 `e2e/streaming-ui.e2e.ts` |
| 经 Latch 使用模型服务：网关只认回环 `Host`、不带 `Origin`、认得的凭据与绑定的模型，入站认证头不转发，错误去掉密钥，不跟随重定向，Agent 断开即中止上游，进程结束或服务设置变化即失效；Host 重算一对能否转发、审计路由；Codex 的 `providers/set` 与 Gemini CLI 的变量、凭据换新进程、路由会话只列服务的模型、Gemini CLI 的辅助调用与子 Agent 指到会话的模型、被拒绝的请求不算绕过、绕过的提示 | `apps/host/test/model-gateway.test.ts`、`acp.test.ts` 的 `sessions on a model service through the gateway`；页面与真实 Host 见 `e2e/model-gateway.e2e.ts`（Codex 草稿、会话与 Gemini CLI 会话的模型菜单） |
| 工作区工具（含 `folder` 参数与 `list_folders`）、受保护路径、写入预览与路径检查 | `workspace.test.ts` |
| 改动：每轮快照（克隆、跨卷只存小文件、像密钥的文件不读）、四种范围与「由命令修改」的归因、撤销与恢复本轮、撤销文件与全部改动、补丁、保留上限、git 只跑只读底层命令、写入前先审计 | `changes-snapshots.test.ts`、`changes-diff.test.ts`、`changes-git.test.ts`、`changes-engine.test.ts`；路由、权限、下一条消息的说明与确认：`changes-routes.test.ts`、`e2e/changes.e2e.ts` |
| 终端：帧格式、环境白名单与 Latch 标记、回放与输出上限、「加入对话」的文本与脱敏、观看名额与数据范围、只有 `host.sock` 上数据范围为 `all` 的设备能打开输入关闭、流随设备与凭据结束、归档时不结束这台电脑的 shell、配对码不显示在 Latch 终端里、真实组件的进程清理 | `terminal-frames.test.ts`、`terminal-environment.test.ts`、`terminal-output.test.ts`、`terminal-service.test.ts`、`terminal-helper.test.ts`、`terminal-cli.test.ts`、`terminal-routes.test.ts`（路由、审计、入口、能力标记、归档与删除的检查） |
| SSE 合并、会话隔离、刷新回退、事件与快照带的 Host 时间 | `streaming.test.ts` |
| Host 记录的时间与用量：审批等待按并集计、不计入用时，思考用时，工具的开始与结束，回合的 `turn`，用量的缓存与推理部分只在每一步都报告时保留，ACP 的 `starting` 阶段与 `usage_update` | `timing.test.ts`、`runtime.test.ts` 的 `times and usage the runtime records`、`acp.test.ts` 的 `ACP times and usage reports`、`providers.test.ts` |
| 对话的推导：回合、结果（按这一轮实际留下的内容）、复制与用量合计、回复的时间与它的提示、工作行的说法与用时、回合的块与折叠、送达的过程、重试前的说明、按 Host 时钟的已运行时间、状态行的说法与沉默的询问、运行的结束方式、运行中回合的模型 | `conversation.test.ts` |
| 输入框的状态行：每段只写报告了的（Latch 内置没有上下文、外部 Harness 的费用总带「不是账单」与报告者、经服务的路与停用后的说法、还没结算的一轮、草稿只写在哪与走哪条路），手机只留上下文，标题行弹层与状态行读同一个 `sessionTotals`；窄栏按用时、输入输出、费用、路的顺序收起，四个控件在 560 宽仍是一行，320 宽不横向溢出；卡与输入框之间的接缝 | `composer-status.test.ts`；真实 Host 与假 Agent 见 `e2e/composer-status.e2e.ts` |
| 回合与每轮记录的匹配、回合卡片的数字来源、撤销前说明恢复不了的文件、卡片与「改动」页签同一个撤销判断与同一句原因 | `turn-changes.test.ts`；在真实 Host 上撤销与恢复见 `e2e/turn-undo.e2e.ts` |
| 每个数都带单位：回合脚部、活的一行与项目弹层的行里没有不带单位的数 | `components-*.test.ts` 的 `units` |
| 消息到达的动效只在页面亲眼看到时播放（重新加载与切换会话后没有），减少动效时直接出现；切换会话时对话区淡入 | `streaming-ui.e2e.ts` |
| 右侧面板：启动面板、标签条、面包屑、文件树的合并行与各渲染器（三种宽度，含深色）；与侧栏和对话画布的宽度分配、平板与手机换成页面 | `panel-files.e2e.ts`、`panel-layout.test.ts`、`visual.e2e.ts` |
| Host 的运行状态通告（只在 `host.sock` 上接受报告、睡眠与唤醒、关闭时带原因的最后一帧）、`host-info` 的运行与等待计数、HTTPS 证书热加载（换用续期的证书，私钥不匹配、主机名不符或私钥权限过宽时继续用原证书并记录一次原因）、密钥与 Agent 定义排除在时间机器之外（`xattr` 属性、幂等、跳过符号链接并以 `-s` 作用于路径本身，`providers.json` 与 `settings.json` 每次写入后仍被排除） | `lifecycle.test.ts`；真实 Host 进程上的 `pnpm stop --reason` 与排除属性在 `security.test.ts` |
| 退出清理 | `shutdown.test.ts` |
| 客户端版本门禁与超时 | `projection.test.ts` |
| 阅读位置、用户意图、布局重排、`reveal` | `reading-position.test.ts`、`streaming-ui.e2e.ts` |
| 高亮调度、流式代码块尾部与逐行着色、已结算轮次不重绘（预算是渲染次数与 span 数，不是耗时）、长行、查找跨 token | `highlight-scheduler.test.ts`、`streaming-render.e2e.ts` |
| 读取输出按文件名着色、行号与外层标记、上限、着色不移动会话 | `tool-output-code.test.ts`、`tool-highlight.e2e.ts` |
| 工具行与命令块：细轨、动词列、等宽路径（从会话文件夹写起，文件名不截断）、命令块只画协议里有的（命令、用时、工具报告的最后几行、调用自己的失败状态，没有退出码）、块状光标只在运行中、输出到达时阅读位置不动、子 Agent 行与「停止」列 | `components-conversation.test.ts` 的 `tool rows and command blocks`；真实 Host、本文件里的最小 ACP Agent 与假 ACP Agent 的三宽两色见 `e2e/transcript-rows.e2e.ts`（截图写入 `test-results/transcript-rows/`） |
| Markdown/URL 安全、不加载图片、代码与表格、隐藏字符标记 | `message-content.test.ts`、`components-*.test.ts`、`streaming-ui.e2e.ts` |
| 客户端安全逻辑：共享编码的浏览器实现、事件流解析与续期后重连、权限展示（`apps/web/src/core/permissions.ts`）、安全文案（`apps/web/src/core/securityCopy.ts`）、`api()` 与本机确认流程、凭据续期（Web Locks、应答丢失、退避、浏览器没有保存新 Cookie）、审批回执、停止请求的重用与回答、审计回滚提示 | `client-security.test.ts` |
| 开发代理只对 `h-<hostId>.localhost` 转交凭据 Cookie | `client-devproxy.test.ts` |
| 客户端纯逻辑：组件、差异、会话分组、导出、选择器修正、格式化、旧版 Host；Host 宣布的停止与睡眠（解析、状态行、按 `retryAfter` 重连）与桌面端生命周期的文案 | `client-*.test.ts`（后两项在 `client-lifecycle.test.ts`）；页面上的状态行、重连时间、手机与平板宽度及深色模式的截图，以及通告之后被撤销的设备进入连接页，在 `host-state.e2e.ts` |
| 桌面端启动 Host、实例核对与复用、启动环境、`--disable-sigusr1`（SIGUSR1 不打开调试端口）、启动记录 `desktop-launch.json`（环境中有 Host 设置时不记录启动方式，写入失败时保留已启动的 Host 并提示） | `desktop-host.test.ts` |
| 桌面端的 Host 生命周期：启动记录的严格解析（没有额外的 Node 参数、Node 可执行文件可信）与 0600 文件、重新启动 Host 的参数与环境、崩溃后按退避重启、10 分钟内第 5 次崩溃后停止、桌面端启动时只启动一次、发送 SIGTERM 前进程已退出时照常记账、不再应答的 Host 不算运行中也不保持唤醒、不是自己启动的 Host 不重启、所有者重启前先报告原因、睡眠与关机的报告（只为通知之后 30 秒内的那一次退出停止 Host，被取消的注销不停止）、忙时防睡（接电源与用电池、每次最长 1 小时）、登录项只给打包后的应用、凭据目录排除在时间机器之外 | `apps/desktop/test/lifecycle.test.ts`；设置页的「后台运行」与防睡状态、关闭最后一个窗口后仍保持唤醒并能重新打开窗口在 `desktop.e2e.ts` |
| 桌面端壳：请求范围与导航、外部链接确认、调试参数、转发与凭据附加、凭据文件（safeStorage、0600、写入失败不留临时文件）、续期（应答丢失、保存失败、失败退避）、CommonJS 的 Host 核对、「在这台电脑的浏览器中打开」与另一台电脑的「复制链接」（只接受本 Host 的回环链接或 host-info 报告的 HTTPS 源、顶层页面的 IPC、只在 macOS、不记录链接；剪贴板项带隐藏类型，10 分钟后仍是该链接才清除；页面经转发不能申请任何邀请） | `desktop-proxy.test.ts`（含对测试 Host 的续期、回环与 HTTPS 邀请用例）、`desktop.e2e.ts` |
| 桌面端的文件夹操作：只回应主窗口的顶层页面、输入校验、原生对话框与确认、签名提交、Host 拒绝的路径逐个报告、「存为项目」与在访达中显示 | `desktop-folders.test.ts`（含经真实代理与测试 Host 的新建、加入、存为项目与显示）；经真实的主进程、preload 与 Host 见 `desktop.e2e.ts`（面板、访达与 `openPath` 在主进程中记录） |
| 桌面端的预览浏览器：分区、权限、导航、preload 的参数与事件、截图与标注的上限、遮挡、快捷键转发、开发者工具与清除数据 | `desktop-browser.test.ts`（假的 Electron 对象与真实的 preload）；经真实 Electron 见 `desktop.e2e.ts` |
| 浏览器登记：回环需要邀请、指纹核对、拒绝后要新邀请、续期、旧版登录、本机确认不可用时不提交、HTTPS 邀请（手机的说明不写终端命令）；一个按钮、折叠的校验码与句子、链接能管理这台 Mac 时的一行与「不要」、桌面端链接与读取失败时不申请、权限较少的链接只申请它允许的、失效的链接当场说明；连接页在注入的样式下不变；离线连接码（只在 `host.sock` 上：本机确认不可用时连接页只提供它，介绍不提 Touch ID） | `enrollment.e2e.ts`；离线连接码在 `desktop.e2e.ts` |
| 启动目录位于 Latch 程序目录内：设置 › 项目、新会话与项目弹层三处的琥珀提示（桌面与手机宽度截图，含深色） | `code-root.e2e.ts` |
| 权限展示：浏览器上允许 R2、开始并继续 Harness 会话、放宽模式都不弹确认且留审计，漂移停止会话；审批卡与安全横幅在注入的样式下不变（`helpers/security.ts`）；审批卡到达与收起的过渡取自动效令牌（停在 0、60、120、180ms 截图），减少动效时近乎瞬时；「手机可以开始新会话」在浏览器里只能关闭（打开的原因写在行上，Host 也拒绝） | `permissions-ui.e2e.ts`；在桌面端经本机确认调高见 `desktop.e2e.ts` |
| 电脑到手机、审批、断线与取消 | `takeover.e2e.ts` |
| 自定义 Provider 与页面插件启停 | `extensions.e2e.ts` |
| 设计令牌与样式表：深色令牌与浅色一一对应、层叠层顺序，样式表只读已定义的令牌，颜色、字级、间距、圆角与透明度，动效令牌与减少动效，浏览器栏颜色（`theme-color`）与侧栏色的令牌一致 | `tokens.test.ts`、`styles.test.ts`，以及 `visual.e2e.ts` 的截图 |
| 界面原语（`@latch/ui`）：角色与名称、键盘与焦点、提示框、禁用与运行中、选值与权限菜单（含等待验证）、对话框与底部面板、触屏命中区、展开块（曲线与时长、`until-found` 与页内查找、关闭中 `inert`、延迟渲染）、替换与离开、进行中的文字、动效令牌与 `MOTION` 一致、深色与减少动效、原语样式都在 ui 层 | `packages/ui/test/` 的浏览器用例（见[组件测试](#组件测试浏览器模式)）；总览页的截图在 `visual.e2e.ts`，改 `packages/ui/test/gallery/` 时 `pnpm check -- --plan` 也要求它 |
| 布局、设置、平板滑出的会话列表、手机的列表根页与新会话面板、控件可达、深色模式 | `design.e2e.ts` |
| 手机的页面栈：列表是根页，会话页推入与滑回（时长与曲线取自令牌，被盖住的列表不可操作，推入后焦点在页头的返回按钮，返回后焦点回到那一行），减少动效时只淡入；会话页的输入框静止时是 52 高的一行；平台的返回（`page.goBack()`）依次关闭菜单面板、右侧面板与会话页，重新载入不多加历史条目，地址不变；新会话面板（停在 92% 且不随原因换行伸缩、焦点在选中的磁贴上、不能选的磁贴说明原因、对话时没有项目、取消保留草稿）；按住一行打开它的菜单（那一行保持按下，触屏打开时不画焦点底），搜索的「取消」把焦点还给搜索按钮 | `phone.e2e.ts`；历史条目的规则在 `back-stack.test.ts` |
| 设置的每一页在三宽两色下的真实渲染：模型服务的已连接、密钥无效、连不上与检测中来自本地假服务的回答，组不画框。服务的协议：OpenAI 从 Responses 开始、只有一种协议的预置服务没有这一项、自定义服务四种都可选并按所选保存；服务页换协议前说明会清除思考深度，换后清除，列表与服务页重新载入后都读回新协议 | `settings-pages.e2e.ts`；可选的协议在 `components-settings.test.ts` |
| 这台电脑上已确认的地址、固定新会话默认、Toast 不盖住输入框的三宽两色渲染，以及进度、失败与移除后的状态 | `e2e/policy-limits.e2e.ts`；经真实 `host.sock`：`e2e/desktop-models.e2e.ts` |
| 设置的层级动效：手机上第一次进入分区与分区里的页面滑入、返回反向滑出，减少动效时只交叉淡化；从页面回到分区时淡入，离开设置时淡出；时长与曲线取自令牌。添加模型服务：获取模型失败时一句原因与手动添加模型 ID（超出限制时行内说明）、获取已经失败的服务保存后不立即检测，检测时是中性的「无法自动检测」而不是「移除此服务」、需要密钥的预置服务商在不能填写密钥的设备上保存前说明、保存后显示「缺密钥」、未确认地址的开关与检测说明原因且不出现命令行、表单里没有同名按钮。保存 Agent 定义不弹确认、显示「还没有开启过会话」，第一次以它开启完全访问会话（经本机确认）之后不再显示 | `settings.e2e.ts` |
| 工作面板：768、1024、1440 两色下面板浮在地面上（上右下各留 8、圆角 12、带阴影、在窗口内、没有横向滚动），侧栏打开、收起、拖宽与平板滑出时左边跟着侧栏，标题行的控件都在面板里且可点；运行中、等你处理、失败与完成的标题行状态，「改动」读到行数后才写 `+a −d`；右侧面板并排或浮层时贴着面板的边；设置页的内容在同一块面板里；减少动效时轨道不滑；手机没有面板。截图在 `test-results/work-panel/` | `work-panel.e2e.ts`；标题行的状态词与改动行数在 `components-shell.test.ts` |
| 可调宽的侧栏：拖拽、双击复原、键盘步进、吸附收起与展开（逐帧检查是滑过去的）、按断点类别记住、对话画布至少 520；收起与展开时顶栏标题只朝一个方向移动 | `sidebar.e2e.ts`、`sidebar-layout.test.ts`（收紧与偏好）、`packages/ui/test/resize.test.tsx`（把手） |
| 会话菜单：标题、标题行的 ⋯、侧栏行的 ⋯ 与手机上按住一行打开的是同一份，打开的会话八项、别的行七项（没有「清空上下文」），没有分叉与「同步最新状态」；运行中「清空上下文」与「删除」灰着并写原因；1440 浅色、768 深色、390 浅色下空闲与运行中各读一遍并截图到 `test-results/session-menu/` | `session-menu.test.ts`；`shell.e2e.ts` 的「the session menu」 |
| Harness 与模型服务的图标：每个预设都有图标，没有图标的有图形，图标文件安全且都被用到 | `brands.test.ts` |
| 界面各状态在三种宽度与两种主题下的截图、与上一次运行的逐像素比较 | `visual.e2e.ts`（见[视觉截图](#视觉截图)） |
| 依赖供应链：`pnpm-workspace.yaml` 例外的格式、到期与锁文件核对，`packageManager` 的 sha512 | `supply-chain.test.ts` |
| 安装金丝雀：在当前设置下逐个使安装失败，放宽对应设置后能安装 | `supply-canaries.test.ts`（需经 pnpm 运行） |
| `pnpm check:workflows` 的工具下载：SHA-256 不符时不安装、只取出二进制、复用已下载的版本、没有固定归档的平台 | `workflow-tools.test.ts` |
| `pnpm check:boundaries`：运行环境声明、按项目表与运行环境允许的 workspace 依赖（仓库根也按它的行检查）、只供测试的包只能写在 devDependencies、`workspace:*` 与 `@latch/` 名称、`pnpm-workspace.yaml` 中项目的列举 | `boundaries.test.ts` |
| `pnpm check:agents` 与 `pnpm docs:affected`：字节预算、`CLAUDE.md`、链接与锚点、提到的路径与用例、根地图中的项目、技能链接、docs 的 front matter、不应提交的路径与词；候选文档 | `agent-docs.test.ts` |
| `pnpm check -- --plan`：按改动路径选择检查与用例，不认识的路径要求全部检查 | `verify-plan.test.ts` |
| `pnpm security:scan`：新增行中的秘密形状与禁用 API、测试代码中的匹配只列出、需要一起修改的文件 | `security-rules.test.ts` |
| 仓库检查读取的文件与改动：git 列出的文件与忽略规则、符号链接、相对某个提交的改动与改名、新增的行 | `repository.test.ts` |
| 测试辅助（`packages/testkit`：Host 夹具、测试确认后端、共享向量、假 ACP Agent、测试证书）、`e2e/helpers/`、`apps/host/test/helpers/` 与 `apps/desktop/test/helpers/` | 使用它们的全部用例：完整的 `pnpm test` 与 `pnpm test:e2e` |

改共享协议（`packages/protocol/src/types.ts`、`packages/sdk/src/bridge.ts`、`plugins.ts`、`harness.ts`）时，先跑定向用例，再跑完整的 `pnpm test` 与 `pnpm test:e2e`。

文件内容回归在 `apps/host/test/file-content.test.ts` 与 `files.test.ts`：真实临时文件与端口 0，覆盖引用持久化、设备/会话绑定、秘密复核、Range/ETag、审计失败、撤销、目录变动、搜索与限额。桌面代理覆盖安全读取白名单与不透明来源拒绝；这些用例不代表 Quick Look 的外部资源验收。

## 测试辅助

测试辅助在 `packages/testkit`（`@latch/testkit`，只供测试，见[构建产物检查](#构建产物检查)）。它不导入 Host：Host 夹具经参数拿到启动函数。Host 的绑定 `host.ts` 有三份，内容相同：`apps/host/test/helpers/host.ts` 供 Host 自己的用例（相对路径导入 `startServer`），`e2e/helpers/host.ts` 供 e2e、`apps/desktop/test/helpers/host.ts` 供桌面端壳的用例（都经 `@latch/host` 导入）；改其中一份时同步其他两份。浏览器 e2e 的辅助也在 `e2e/helpers/`：`browser.ts`（登记与连接）、`layout.ts`（控件可达、弹层在窗口内、横向溢出、打开设置）与 `visual.ts`（视觉截图与比较）。

### `startTestHost()`

`helpers/host.ts`（三份见上）把 testkit 的 `startHostFixture(start, options)`（`packages/testkit/src/host.ts`）绑定到本 Host 的 `startServer`，在进程内启动一个 Host：

- 数据目录、工作区、运行目录的父目录与 TLS 材料都放在一个新的临时目录中（前缀短，`host.sock` 路径不超过 macOS 的 104 字节上限）；`close()` 关闭 Host 并删除整个目录。
- 默认 `port: 0`、`demo: true`、`uiDir: dist/web`、`rateLimits: 'relaxed'`，以及测试确认后端（`presenceMode: 'approve'`）。其他 `ServerOptions` 原样传给 `startServer`。这些 Host 选项与默认值写在绑定中；夹具只准备临时目录、测试确认后端与 TLS 材料（`HostFixtureSetup`），再调用 `start`，并提供下面的客户端。
- 三种入口：`'unix'` 经 `host.sock`，凭据放在 `Authorization: Latch-Device …`；`'loopback-tcp'` 访问 `h-<hostId>.localhost`（测试中解析到 127.0.0.1），凭据是 Cookie `latch_<hostId8>`；`'tls'` 需要 `tls` 选项，Cookie 为 `__Host-latch_<hostId8>`。`raw(listener, path, init)` 发送 `/link/` 下的原始请求，不跟随重定向。
- `enroll({ listener, name, scopes, invitation, offlineCode })` 走完整登记：生成 P-256 设备密钥、创建登记、由测试确认后端批准、签名完成，返回 `TestDevice`。`host.sock` 以外的入口没有给出邀请或离线码时，自动为该入口创建邀请（邀请不带 `approve:elevated` 与 `secrets`），因为只有 `host.sock` 能不经邀请登记。`invite(scopes, listener)` 经 `host.sock` 创建邀请：默认为 TLS 入口，`'loopback-tcp'` 为回环入口。
- `TestDevice` 提供 `request()`、`json()`（非 2xx 抛出带状态码与响应体的 `HttpFailure`）、`confirmed()`（收到 403 `stepup-required` 时经测试确认后端批准，再带 `x-latch-confirmation` 重发）、`renew()`（质询、签名、换用新凭据）与 `addFolders()`（像桌面端主进程那样取得 nonce、用设备密钥签名请求体，添加项目或加入文件夹；`signedBody`、`nonce` 用来构造被拒绝的请求）。
- `tls: true` 用 `makeTestTls` 生成证书，监听 127.0.0.1 上的空闲端口，公开地址为 `https://latch-test.localhost:<port>`，并允许本机对端；也可以传入完整的 `TlsListenerOptions`。

### `createTestPresence()`

`packages/testkit/src/presence.ts`。测试用的本机确认后端，形状与 Host 的 `PresenceBackend` 相同（预览与结果的类型 `PresencePreview`、`PresenceOutcome` 在 `@latch/protocol`）：

- 模式 `approve`（立即批准，回显 nonce 与 previewHash）、`deny`、`unavailable`、`manual`（请求排队，由 `approveNext()`、`denyNext()`、`timeoutNext()` 依次结算）；`method` 为 `biometric` 或 `password`。模式可以在用例中途修改。
- `requests` 记录每次收到的预览、previewHash 与是否要求生物识别；`waitForRequest(timeoutMs)` 按到达顺序返回下一条尚未取走的请求。
- 只能通过 `startServer({ presence })` 或 `new PresenceService({ backend })` 注入，类型检查在注入处核对它与 `PresenceBackend` 一致。只有测试（`tests/`、`e2e/` 与各项目的 `test/`）导入 `@latch/testkit`，生产代码选不到它（见「构建产物检查」）。

### `makeTestTls()`

`packages/testkit/src/tls.ts`。用 `/usr/bin/openssl` 为 `latch-test.localhost` 生成自签名 P-256 证书（自身即 CA，命名曲线编码，私钥 0600），返回 `certPath`、`keyPath` 与 `ca`。Node 端请求用 `ca` 信任它；浏览器上下文设 `ignoreHTTPSErrors: true`。Chrome 不接受显式写出 EC 参数的证书，自行生成证书时也要加 `-pkeyopt ec_param_enc:named_curve`。

### `enrollBrowser()`

`e2e/helpers/browser.ts`。`enrollBrowser(page, testHost, { name, scopes, url })`（页面不问名称，`name` 经 `nameNextEnrollment` 写进登记请求）通过真实的连接页面在回环地址上登记 `page` 所在的浏览器，并等待工作区连接（`connected(page)`，即 `.app-shell[data-connection="connected"]`）。回环登记需要邀请，所以它先经 `host.sock` 创建回环邀请，再打开带 `#pair=` 的地址（或 `url`）。连接页请求邀请允许的权限，所以 `scopes` 只决定邀请是否包含「管理此 Host」，不给时在还没有设备能管理 Host 时包含；`manual` 模式下由它批准本机确认。`browserLaunchOptions()` 返回无头启动参数，设置了 `LATCH_BROWSER_PATH` 时使用该路径的 Chrome。

### 共享向量

`packages/testkit/vectors/security-v1.json` 由 Host、浏览器、桌面端主进程与 macOS 确认组件的 `--self-test` 共同校验；修改共享编码的要求见根 `AGENTS.md`。

### 文件内的约定

- 每个文件用 `cleanups` 数组配合 `afterEach` 逆序清理；临时目录用 `mkdtemp(join(tmpdir(), …))`；轮询用 `vi.waitFor`、`expect.poll` 或文件内的 `waitFor`。
- Vitest 在每个用例开始前清空所有 mock 的调用记录（默认的 `clearMocks`），所以 `vi.fn` 与 `vi.spyOn` 在用例内或由用例调用的辅助函数中创建，调用次数只在本用例内断言。清空不会撤销替换：`vi.stubGlobal` 与 `vi.spyOn` 仍在 `afterEach` 或 `finally` 中恢复。
- `resolves`、`rejects` 与 `expect.poll` 断言必须在用例结束前 `await`，否则用例失败。`resolves` 与 `rejects` 可以先保存返回的 promise，稍后再 await；`expect.poll` 在 await 时才开始轮询，不 await 就不会执行。
- 模型服务用本地 HTTP 服务模拟：`server.test.ts` 的 `localModel()` 返回 `baseURL` 与对应的出站白名单项 `allow`；`providers.test.ts` 有 SSE 构造器与脚本化的 `FetchLike`。除回环地址外不访问网络。
- 配置、清单与文档链接直接阅读或用 `rg` 检查，不为它们的字面内容写测试。

## 测试接缝

| 接缝 | 位置 | 用途 |
| --- | --- | --- |
| `now` | `ServerOptions`；`DeviceStore.open`、`EnrollmentService`、`PresenceService`、`createOfflineTicket`、`AuditLog.open` 与桌面端的 `createShellProxy` 也各自接受 | 替换凭据、登记与确认使用的时钟，测试续期、过期、宽限期与确认超时。e2e 用 `now: () => Date.now() + offset` 把 Host 时钟拨快 25 小时，浏览器与桌面端壳保持真实时钟 |
| `clock` | `ServerOptions`；`createRuntime(options)` 与 `HarnessHostOptions` 由它传入 | 消息与运行记录的时间（`createdAt`、用时、审批等待、思考用时）以及发给客户端的 `hostTime`。与 `now` 分开，凭据与确认不受影响；`visual.e2e.ts` 用一个由脚本推进的时钟，让截图里的时间与用时每次相同 |
| `rateLimits` | `ServerOptions` | `'relaxed'` 把所有限流桶放大 100 倍，是 `startTestHost` 的默认值；限流用例显式传 `'default'`。生产从不设置 |
| `allowLocalPeers` | `TlsListenerOptions`（`apps/host/src/listeners.ts`） | HTTPS 入口默认拒绝来自本机地址的连接；只有测试打开它，才能从 127.0.0.1 访问 TLS 入口 |
| `egressAllow`、`egressLookup` | `ServerOptions` | `egressAllow` 是进程级附加的出站白名单（`host:port`），不写入 `policy.json`，它的源（任何路径）在本次运行中也算已确认的模型服务地址：测试用它放行本地假模型服务 `127.0.0.1:<port>`，`apps/host/scripts/start.ts` 用它放行 `LATCH_BASE_URL` 的地址。要测试地址确认本身，就不传它。`egressLookup` 替换 DNS 解析。单独测试出站时直接用 `createEgressFetch({ allow, lookup, localAddresses })` |
| Provider 的 `fetch` | `providerPlugin(record, { fetch })`、`listProviderModels`、`checkProvider` | 注入脚本化的 `FetchLike`，确认内置协议只经注入的 fetch 发请求、不跟随重定向 |
| `presence` | `ServerOptions` | 注入测试确认后端 |
| `runtimeParent`、`codeRoot` | `ServerOptions` | 运行目录的父目录与 Latch 程序目录；`startTestHost` 把运行目录放在自己的临时目录下 |
| `fs` | `DeviceStore.open`、`AuditLog.open` | 注入写入失败与短写，测试撤销与审计的持久性 |
| `classifyToolCall` | `createRuntime(options)`（`packages/core/src/runtime.ts`） | Host 的风险分级器。测试传入返回固定级别的函数；抛错或返回未知值按 R2。不传时沿用旧规则（`requiresApproval` 为 R1，否则 R0），只出现在直接构造运行时的测试中 |
| ACP 选项 | `createAcpAgentPlugin(definition, options)` | `acp.test.ts` 缩短取消、停止、重启与请求超时（`FAST`），并收集写入 Host 日志的诊断 |

### 假 ACP Agent

`packages/testkit/fixtures/fake-acp-agent.mjs` 是确定性的 ACP v1 Agent，不调用模型，只有 `model` 一轮访问客户端指给它的模型服务；testkit 以 `FAKE_ACP_AGENT` 导出它的路径，用 `process.execPath` 运行。`acp.test.ts` 的 `setup()` 用临时目录启动它，并把预览的 `launchHash` 作为 `expectedLaunchHash` 传给 `createTask`，代替 Host 的本机确认；`preset(presetId)` 把预设的权限配置套用到假 Agent 上（不算已验证的预设）；`open(workspaces, projects)` 给 Bridge 传入 Host 列出的目录与项目；`hostEnv()` 只在一个用例内设置 Host 的环境变量。`fixtures/fake-pi-agent.mjs`（`FAKE_PI_AGENT`）同样确定，说 pi 的 RPC：按输入里的词运行短命令、慢命令、一直运行到停止的命令、模型服务失败或扩展确认，运行中收到的追加各自回复，`FAKE_PI_TOO_OLD=1` 时像 0.84.4 之前的 pi 不认识 `clear_queue`；它像 pi 一样把会话记成带 ID、父条目与时间的条目树，设了 `FAKE_PI_SESSIONS` 时写成会话文件，所以另一个进程能 `switch_session`、`get_entries`、`fork` 与 `clone`，`recall` 回答分支上之前的用户消息，第一条消息含 `no-fork` 的会话由扩展取消分叉；`e2e/pi.e2e.ts` 用它经真实 Host 与页面走完找到、读列表、发送、停止、追加、失败、重新加载，从某一轮用 pi 自己的记录分叉并重试分叉的第一轮（只重发人写的话），以及会话与测试启动拒绝过旧的 pi。

进程级行为由环境变量决定：

| 变量 | 作用 |
| --- | --- |
| `FAKE_ACP_STATE` | 会话状态文件。多个进程（每会话一个）共享它，每次保存都合并磁盘上的内容 |
| `FAKE_ACP_LOGIN_FILE` | 像真实 CLI：`login status` 按这个文件回答并退出，`login` 写它；文件不存在，或启动时不存在时（进程只读一次登录），`session/new` 与提示都返回 `auth_required` |
| `FAKE_ACP_TERMINAL_LOGIN` | 客户端声明 `auth.terminal` 时列出一个 `terminal` 登录（参数 `login`，变量 `FAKE_ACP_LOGIN_VIA`），运行它就写 `FAKE_ACP_LOGIN_FILE`；`bad` 另列一个点名 `NODE_OPTIONS` 的 |
| `FAKE_ACP_AUTH_STATUS`、`FAKE_ACP_AUTH_STATUS_DELAY` | 在 `initialize` 的回答之后（延迟若干毫秒）与退出登录之后推送 `_auth/status_update`：`1` 按登录文件报 `account`（带客户端不该留下的 email 与组织）或 `none`，`api_key` 报这一类，`silent` 只宣告不推送 |
| `FAKE_ACP_LOGOUT` | 宣告并处理 ACP `logout`：删掉登录文件 |
| `FAKE_ACP_LOG` | 逐行 JSON 日志：收到的消息、启动时的 cwd、定义之后的启动参数（`argv`）、收到的 `LATCH_*` 变量名（`latchEnv`，应为空）与 `TMPDIR` |
| `FAKE_ACP_STORE` | Latch 的 `acp.json`，用来检查收到提示时会话是否已持久化 |
| `FAKE_ACP_CAPS`、`FAKE_ACP_CAPS_FILE` | `resume`、`load`、`delete`、`close`、`dirs`（`sessionCapabilities.additionalDirectories`）的逗号列表；设置了 `FAKE_ACP_CAPS_FILE` 时每个进程启动时从这个文件读取，同一定义之后的进程因此可以改变声明 |
| `FAKE_ACP_CONFIG` | `legacy`（旧式 models 与 modes）或 `options`（configOptions） |
| `FAKE_ACP_MODES`、`FAKE_ACP_INITIAL_MODE` | 模式列表与初始模式 |
| `FAKE_ACP_MODELS`、`FAKE_ACP_MODELS_FILE` | `options` 下提供的模型（逗号分隔，默认 `small,large`）；文件每个会话读一次，用来让后来的会话不再提供某个模型 |
| `FAKE_ACP_START_MODEL` | 新会话的模型，列表里有没有都用它，像自己记着所选模型的 Agent；不设时取系统设置里的 `model.name`，再不然取列表第一个 |
| `FAKE_ACP_EFFORT_BY_MODEL` | `1`：`large` 模型多一档 `max` 思考，像思考档位随模型变的 Agent |
| `FAKE_ACP_EFFORT_ID` | 思考选项的 ID，默认 `effort`；codex-acp 叫 `reasoning_effort` |
| `FAKE_ACP_EFFORT_DESCRIPTIONS=1` | 每档思考带一句英文说明，像 DeepSeek Harness 与 Codex 发来的那样 |
| `FAKE_ACP_STRICT_MODELS=1` | 拒绝设置不在列表里的模型，像不接受自己填写的模型 ID 的 Agent |
| `FAKE_CODEX_MODELS`、`FAKE_CODEX_MODEL`、`FAKE_CODEX_LIST_ERROR` | 以 `cli app-server` 启动时，假 Agent 像 codex-acp 那样回答 Codex 的 `initialize`、`config/read` 与 `model/list`（`fixtures/fake-codex-app-server.mjs`，每页两个）：模型列表（Codex 的 JSON 形状）、配置里的模型、让 `model/list` 失败 |
| `FAKE_ACP_STICKY_MODE=1` | 忽略修改模式的请求 |
| `FAKE_ACP_RESUME_MODE`、`FAKE_ACP_RESUME_SILENT=1` | 恢复或加载后回到的模式；恢复时不报告状态 |
| `FAKE_ACP_SELF_MODE` | 处理修改模式的请求时自行切换到的模式 |
| `FAKE_ACP_MODE_REPORT` | 模式报告的形状：`full`、`uncategorized`、`unlisted`、`none` |
| `FAKE_ACP_VERSION` | `agentInfo.version`；`none` 表示省略 |
| `FAKE_ACP_CLI_VERSION` | 以 `--version` 启动时像 CLI 那样输出 `fake-cli <版本>` 后退出；`fail` 什么也不输出、以 1 退出 |
| `FAKE_ACP_MCP=dsh` | 像 DeepSeek Harness 那样接收 `mcpServers`：只收命令为绝对路径的 stdio 服务；会话建立前先让一个临时副本回答 `server/discover`，再启动、`initialize`（2025 版握手）并 `tools/list`，任何一步失败就拒绝建立会话；日志记 `mcp-mounted` 与 `mcp-refused` |
| `FAKE_ACP_DUMP_ENV=1` | 把完整环境写入日志，检查环境白名单 |
| `FAKE_ACP_PROVIDERS`、`FAKE_ACP_PROVIDER_ID`、`FAKE_ACP_PROVIDERS_SET` | `1`：像 codex-acp 那样宣告并处理 ACP `providers/*`：一个可设置的服务（ID 默认 `openai`，类型 `openai`）；`providers/set` 用给它的头读 `<baseUrl>/models`，之后只提供它认识而列表里也有的模型，日志只记头的名字；`fail` 拒绝设置 |
| `FAKE_ACP_PROTOCOL`、`FAKE_ACP_AUTH`、`FAKE_ACP_INIT_ERROR`、`FAKE_SECRET` | 协议版本、需要登录（`new`、`prompt`）、初始化失败；`FAKE_SECRET` 出现在 stderr 与错误中，检查脱敏 |
| `FAKE_ACP_SLOW_SETUP`、`FAKE_ACP_EXIT_DELAY`、`FAKE_ACP_IGNORE_TERM`、`FAKE_ACP_GRANDCHILD`、`FAKE_ACP_STARTUP_NOISE` | 慢的会话建立、延迟退出、忽略 SIGTERM、派生孙进程、启动时输出非 JSON |

每一轮的行为由提示的第一个词决定（其他输入按 `echo` 回显）：

| 关键词 | 场景 |
| --- | --- |
| `count <n>`、`ids`、`think`、`tool`、`diffs`、`plan`、`reuse`、`stray`、`big <n>`、`noise`、`flood` | 流式文本、消息 ID 切换、思考、工具与 diff、计划与用量、复用的工具 ID、轮次外的文本、超长输出、非 JSON 输出与 stderr 洪泛 |
| `permission`、`parallel`、`withdraw`、`plan-ask` | 审批、同一会话的并发审批、Agent 撤回审批；先报告两步计划（一步进行中、一步待开始）再询问 |
| `persistent-only`、`only-always`、`unknown-kind`、`unknown-only`、`amendment` | 只给出这一组选项询问一次，检查选项过滤与自动拒绝 |
| `drift <mode>` | 询问的同时把自己切换到 `<mode>`，然后等待取消 |
| `endturn`、`hang`、`crash` | 取消后以 `end_turn` 结束、永不结束、崩溃退出 |
| `probe` | 调用 `fs/read_text_file`，检查 Latch 不提供客户端文件系统 |
| `skills` | 调用会话第一个 MCP 服务的 `list_skills`，回复它返回的内容 |
| `refuse` | 以 `refusal` 结束 |
| `model [as:<模型>\|helper:<别名>]` | 向客户端指给它的模型服务发一次请求并回复拿到的文字：`providers/set` 设过的走 Responses，有 `GOOGLE_GEMINI_BASE_URL` 时走 Gemini（模型取系统设置里的 `model.name`）；都没有时不访问任何服务就回复，用来检查绕过的提示。流式回复读到最后一个事件（Responses 的 `response.completed`、Gemini 带 `finishReason` 的一段）就不再读，服务还没关闭连接也一样。`helper:<别名>` 像 Gemini CLI 的辅助调用那样取模型：系统设置 `modelConfigs.customOverrides` 里最后一条匹配这个别名的模型，没有时用 `gemini-3-flash-preview` |

### 回放与录制

`packages/testkit/fixtures/replay/<预设>/<场景>.ndjson` 是每个预设的 ACP 对话（同一 Agent 帧不同的另一个大版本放在 `<预设>/<大版本>.x/<场景>.ndjson`，例如 `opencode/2.x/`，头部的版本必须属于这个大版本）：第一行 `transcript_start` 写明预设、场景、`source`（`hand-written` 或 `recorded`）、所依据的 Agent 版本与源码位置（`basis`）和一个人要做的步骤（`steps`）；之后每行一帧：`expect_outbound`（Latch 应发的帧）、`emit_inbound`（Agent 发来的帧）或 `runtime_exit`（进程在这里结束；带 `code` 时是 Agent 自己以这个码退出）。帧写成 `{ kind, method, params | result | error }`，JSON-RPC 的 ID 由回放补上；pi 的对话头部写 `protocol: "pi-rpc"`，命令的 `type` 是 `method`、其余字段是 `params`，响应按它回答的命令补上 ID；`<any>` 匹配任何值或字符串中的任何一段，`<workspace>` 是会话目录。现有的都是 `hand-written`：按各 Agent 的公开协议和源码手写，不是从运行中的 Agent 抓到的。

`fixtures/replay-agent.mjs`（`REPLAY_AGENT`）代替真实 Agent：逐帧比对 Latch 发来的帧，发出其后 Agent 的帧，把进度、第一处不符、每个进程的启动参数和被指向的程序（`CODEX_PATH`、`HOME`）写进 `REPLAY_STATUS`；`runtime_exit` 之后的帧交给下一个进程。`packages/harness-acp/test/replay.test.ts` 对每个文件用真实的 ACP 驱动、映射与会话按 `steps` 走一遍（`playScenario`），检查回放走完、没有不符、没有悬空的审批、进程数与 `runtime_exit` 一致，再按场景名检查人看到的结果；`pi.test.ts` 另用临时写出的 pi 对话检查保存时拒绝的参数、拒绝早于 0.84.4 的 pi、只在请求时读列表、扩展的选择题、模型服务的失败与压缩失败、停止 `/compact` 与拒绝把它追加到运行中的一轮，以及用 pi 自己的记录分叉：在下一轮的第一条用户消息之前 `fork`、扩展取消、会话文件已不在、复制出的文件没有停在那一轮、第一轮在 pi 打开会话之前停止后下一轮不再分叉，和按时间切分支的 `forkPlan`；pi 的 `compact_command`、`compact_failed`、`compact_cancelled` 是 `/compact` 的成功、失败与扩展取消，`e2e/pi.e2e.ts` 在页面里走一遍 `/compact` 与运行中的拒绝；`replay.test.ts` 还把 Codex 的对话改出带密钥形状文字的提示、压缩失败与 `session/prompt` 错误，检查进入会话前已脱敏。按名字找命令只指向临时目录里的假程序（运行就留下标记），用例断言没有标记、适配器被指向的是这些假程序。新增场景要在测试的 `SCENARIOS` 里写明它的检查。

`startFakeModels()`（`src/fake-models.ts`）在 127.0.0.1 上同时回答 Chat Completions（`/v1/chat/completions`）、Responses（`/v1/responses`）、Anthropic Messages（`/v1/messages`）与 Gemini（`/v1beta/models/<模型>:streamGenerateContent`，也接受 `/v1`；模型列表 `/v1beta/models`），流式或不流式，按脚本给出思考、文本、一个工具调用（工具名可以是一个模式，取请求提供的第一个匹配的工具）或一个协议格式的错误（`answeredBy` 让回复说另一个模型回答了它：Responses 的 `model`、Gemini 的 `modelVersion`；不写时是请求点名的模型。`lingerMs` 让流式回复在最后一个事件之后再保持连接这么久，像经过代理或保持连接时那样），并记下每个请求（不含头的值，只有带来的密钥 `key` 与头的名字）。第 n 个请求的工具调用 ID 带上 n，所以一轮可以连续调用工具；Anthropic 的思考签名是 `fake-signature-<n>`，Responses 在请求了 `reasoning.encrypted_content` 时给推理项 `fake-encrypted-<n>`，测试据此看出后来的请求带回了哪一次回复的推理（`server.test.ts` 的 `carries … reasoning back through one tool loop`）。`apps/host/test/providers.test.ts` 与 `provider-protocols.test.ts` 用 Host 自己的客户端读它，`model-gateway.test.ts` 用它检查网关转发的是服务的密钥，以及每轮记下的模型与令牌（回复的读法另见 `model-reply.test.ts`）。

`pnpm harness:record -- --harness <预设> --scenario <场景>` 由这台电脑的所有者手动运行，录制已安装的真实 Agent（`src/record.ts`、`fixtures/record-tee.mjs`、`packages/harness-acp/test/record-harness.ts`）：真实驱动按场景操作，Agent 经 `record-tee.mjs` 在 `sandbox-exec` 中启动，网络只放行到假模型服务端口的连接（本机其他端口可能是通往外网的本地代理，一并挡住；本机套接字不挡），挡住真实家目录中的钥匙串文件和各 Agent 的登录目录，并拒绝钥匙串服务的查找（这一项没有对真实钥匙串验证过）；环境只留白名单和 `--env` 给的变量，`HOME` 与 `XDG_*` 是新的临时目录；每次启动前先确认沙箱挡住了一次对外连接和一次到本机另一个端口的连接，否则不启动 Agent；自己在本机另开端口通信的 Agent 因此无法这样录制。Agent 要经 `--env` 或 `--home-file` 配置成使用假模型服务（`{{MODEL_ORIGIN}}`），各家的配置方式还没有用真实 Agent 验证过。结果把工作区、家目录、数据与临时路径、UUID、时间与邮箱规范化，再经 `redactSecrets`，仍含本机家目录或用户名时不写出；写到临时目录，由人读过后移入 fixtures。只支持 macOS。`record.test.ts` 只用假 ACP Agent 运行它：检查 Agent 的环境、规范化、录下的文件能回放，以及沙箱挡住外连、本机其他端口和钥匙串文件，不挡时拒绝启动。测试从不运行真实 Agent。

## 启动脚本的子进程用例

`security.test.ts`、`cli.test.ts` 与 `desktop-host.test.ts`（都在 `apps/host/test/`）会真实启动 `apps/host/scripts/` 下的 `start.ts`、`stop.ts` 或 `latch.ts`。规则：

- 每次都显式传临时 `--data-dir`，子进程的 `cwd` 也设为临时目录。数据目录按 `--data-dir`、`LATCH_DATA_DIR`、当前目录下旧的 `./.runtime`、平台默认目录的顺序解析，在仓库根目录运行可能落到 `.runtime/` 或用户的默认数据目录。
- 子进程环境去掉开发者终端里的 `LATCH_*` 变量（`security.test.ts` 的 `childEnv()`、`desktop-host.test.ts` 的 `cleanEnvironment()`），模型密钥、数据目录与端口不会传进去。
- Host 用 `--port 0`；HTTPS 用临时选出的空闲端口，从不使用 4317。
- 预先写入 `policy.json`，把本机确认关掉：`{ ...defaultPolicy(platform), presence: { backend: 'none', helperCdhash: null } }`。这样 `start.ts` 在 macOS 上不会构建或调用真实确认组件，`presence test` 也不会弹出窗口。
- 需要 Host 的进程号等于子进程号（锁记录、`pnpm stop` 的核对）时，用 `process.execPath --import <tsx 的 loader.mjs> apps/host/scripts/start.ts` 启动，不经 `tsx` 包装进程；一次性命令用 `node_modules/.bin/tsx`。
- 只停止自己启动的进程：`apps/host/scripts/stop.ts --data-dir <同一临时目录>`，或向自己 spawn 的子进程发 SIGTERM。子进程里的 Host 使用默认的每用户运行目录（按该数据目录的 `hostId8` 命名），用例结束时删除它。
- 让启动停在中途时，用 `--plugin` 加载临时模块：激活时等待一个门文件出现的插件让 Host 停在「已持锁、尚未写出 `host.json`」的窗口；导出 `{}` 的模块让通过检查的启动立即以「插件模块无效」失败，从不运行 `startServer`。
- 用当前测试进程的 PID 冒充存活的锁持有者或旧版本 Host，用已退出子进程的 PID 表示已结束的持有者；开机时间相关的用例改写锁记录中的 `bootTime`。`cli.test.ts` 用 tsx 加载器启动 8 个子进程同时争抢一个过期锁，断言每一轮恰好一个持有者。
- `cli.test.ts` 的大多数用例在进程内调用 `runLatch(argv, io)`，由 `CliIO` 提供 `stdout.isTTY`、`readSecret()` 与 `cwd`；进程内的 Host 写出记录测试进程 PID 的 `host.json` 后，CLI 把它当作运行中的 Host。其中只有用法与退出码的用例运行脚本本身；`security.test.ts` 在子进程 Host 旁运行 `latch.ts`。
- 平台相关：`--code-file` 的 ACL 用例只在 macOS 运行，目录属主用例以 root 运行时跳过；IPv4 映射的 Tailscale 地址用例选一个本机没有的 `100.64.0.0/10` 地址，让 `listen` 失败并在错误中写出实际绑定的地址。

## 浏览器 e2e

`transcript-find.e2e.ts` 经真实 Standard 读取本地报告，在三宽验证从未挂载的工具输出可查找、内外折叠展开、逐项 Highlight、清空查询和焦点／草稿保留，不额外发起模型调用。`preview-renderers.e2e.ts` 生成含一万形状的实际 PPTX，检查固定复杂度拒绝、释放 frame 和随后正常打开 DOCX；普通 30 页首屏性能仍独立测量，不用拒绝样本替代正常预览。

- e2e 在同一个 Vitest 进程内用 `startTestHost` 启动 Host，页面来自 `dist/web`（或 `LATCH_E2E_UI_DIR`），所以改客户端后先 `pnpm build`。
- Playwright（`@latch/e2e` 的 devDependency）默认使用 `pnpm --filter @latch/e2e exec playwright install chromium` 安装的 Chromium；设置 `LATCH_BROWSER_PATH` 时改用该路径的 Chrome。都以无头模式运行。
- 每台设备是独立的 BrowserContext，用 `enrollBrowser` 经真实连接页面、带回环邀请在回环地址上登记。手机经 HTTPS 与邀请登记的流程只在 `enrollment.e2e.ts` 覆盖（Host 带 `tls` 选项与命名曲线证书，手机上下文设 `ignoreHTTPSErrors`）。需要本机桌面端或另一台设备时，用 `testHost.enroll({ listener: 'unix' })` 等 API 设备直接驱动 Host（见 `permissions-ui.e2e.ts`）。
- 截图写入 `test-results/`（`design/`、`enrollment/`、`permissions/`、`streaming/`、`visual/` 子目录与根目录）。截图不能包含凭据。

布局用例另以桌面 DPR 2 与手机 DPR 3 验证草稿增长、紧凑选择器与发送控件可达性，并确认新会话不挂载环境背景。`e2e/plugin-packages.e2e.ts` 使用本地发布检查包，在 390 / 820 / 1440px 浅色与深色下验证真实 React 界面的编辑与草稿、模块渲染失败、数据加载/失败/空状态、迟到响应与停用后的撤下，截图在 `test-results/plugin-packages/`。审批用例在手机与平板重复加载、切换会话并检查真实点击命中，防止滚动区遮罩与切换动画让可见按钮不可点。

## 视觉截图

`latch-ui-check` 技能调用 `pnpm exec tsx scripts/ui-check.ts`，顺序运行快速检查、UI 与 web 组件用例、构建及设计/视觉 e2e。`--plan` 只列命令；`--boards <JSON>` 映射画板，`--baseline <目录>` 生成比较报告，只有预期逐像素一致时才加 `--strict`。跨 worktree 的视觉用例共用截图锁，必须串行运行。检查生成的索引与正常、加载、等待、失败、空内容、只读、减少动效截图；自动化不代替本机确认与真机验收。

`e2e/visual.e2e.ts` 是 `pnpm test:e2e` 的一部分。它把真实产品驱动到浏览器能到达的每个状态，在手机 390×844、平板 768×1024（都模拟触控）与桌面 1440×900 下以 `deviceScaleFactor` 1 截图，每个状态截浅色与深色（`emulateMedia`）。

- 产品：进程内的测试 Host 与 `dist/web` 页面；按提示返回固定内容的本地模型插件，带一个运行到测试结束或被取消的 `run_tests` 工具（第三方工具，所以是高风险），另用内置的 `read_file` 与 `write_file`；假 ACP Agent 提供完全访问会话的思考、diff、计划与询问。会话由本机桌面端的 API 设备经 Host API 建立并批准；三台浏览器设备经真实连接页登记，先截取登记表单、等待本机确认与还没有会话时的新会话。
- 状态：新会话的 Harness 磁贴、填写中的草稿、模型与项目菜单（平板与桌面）、模型菜单原地换成的添加模型服务面板与需要密钥的服务在浏览器上说明在哪里设置、还没有模型服务时的卡片与在卡片里展开的添加面板（快照的目录被拦下去掉服务）、演示模型的示例卡片（快照把脚本模型服务当作演示服务）、「添加 Agent」的预设列表与一个预设的面板（这台电脑上找没找到命令随机器而变，所以页面拦下 `GET agents` 的回答，把每个预设都当作没找到）、手机的新会话面板及项目、模型的嵌套选择面板；桌面另截执行端桌面端的样子（同一设备的另一个标签页，注入桌面端接口并把快照里的入口当作本机套接字，只用于显示）：选中完全访问的 Agent 后还没输入时与输入后的「开始会话」、上下文行的「完全访问」与说明，以及本机确认不可用时（快照里的本机确认改为不可用）不能开始的样子；运行中（工具执行中，最新一轮末尾是活的一行、运行条不出现）、停止结果未知时的运行条「重试」与停止进行中的「正在停止…」（拦下停止请求得到，请求不到达 Host）、正在思考、离线、完成（另截展开的 diff、桌面上悬停时出现的回合脚部、答案前折叠的过程、点开的工具卡，以及平板与桌面上下一条消息的模型切换和菜单脚部的「撤销切换」）、带计划的完成、失败（带「重新发送」）、已取消；普通审批及其 ⋯ 选项（手机为「更多选项」底部面板）、预览从默认状态展开或折起、卡片取得焦点时的快捷键提示（非触屏）、结果未知时的「重试」（拦下这次决定的请求得到），内容含不可见字符的审批、浏览器上不能批准的高风险审批、完全访问会话的提示性询问、没有「批准普通操作」权限的设备上的普通审批、旧版 Host 的审批；运行条里点开的计划；连接页的表单、等待与被拒绝；右侧面板的启动面板（桌面是栏，平板与手机是页面，以及栏边把手的悬停与键盘聚焦）；从标题打开的会话菜单（平板与桌面）；手机的会话列表、推入的会话页与平板的会话导航；设置的每个分区（「电脑」另截两条上限菜单、「其他设备可用的 Agent」与「其他设备可用的项目」列表页，以及一次没写入审计的降低；「模型服务」另截一个已保存服务的页面、选择预设与添加表单；「Agent 成员」另截一个 Agent 的页面），以及没有「管理此 Host」的设备看到的只读「电脑」；桌面侧栏在各状态下（含选中等待批准的会话）的单独截图，以及会话行的悬停与 ⋯ 菜单、项目组头的悬停、置顶组、带筛选的搜索、列表末尾的「已归档」行与已归档筛选、收起的侧栏与侧栏把手的悬停和键盘聚焦（悬停与聚焦用 `CSS.forcePseudoState` 保持）；桌面另截顶栏的 ⋯ 菜单（会话页与新会话页）。每次截图都断言页面没有横向滚动，开着的弹层（菜单、选值、弹层及它原地换成的面板）整层在窗口内、离边缘 8，且层里最后一个控件滚到眼前时可以点到（`layout.ts` 的 `layersInWindow`），主要控件经 `layout.ts` 的 `reachable` 检查可见、可点且在视口内；状态也逐一核对：执行中的工具行有转圈，桌面侧栏每个会话行的状态槽用状态词显示它该显示的一样（运行中、等你处理、没有动静、正在停止、已停止、失败、未读的对勾或时间），手机的会话列表与平板的会话列表同样用状态词，待批准的工具卡头部是琥珀的「待批准」状态词，桌面侧栏的搜索与「等你处理」行静止时没有底色、只有打开的会话那一行有选中卡片，项目分组的「在 … 中新建会话」、收起后顶栏的「展开侧栏」与「新建会话」都可达，收起时焦点移到「展开侧栏」；页面开着时第一项审批到达，桌面标题行的「等你处理」计数与面板的「等你处理」分组淡入；桌面页面看着一次运行被取消时，工具卡的转圈与工具图标交叉淡化、状态文字淡入；桌面打开未读会话时，那一行的对勾与时间交叉淡化。
- 原语总览（`ui-gallery-<分组>`）：用例用 Vite 把 `packages/ui/test/gallery/` 构建到系统临时目录，由 Vite 的预览服务器在 127.0.0.1 的空闲端口上提供，三种视口、两种主题逐组截取；页上标 `data-force="<伪类>"` 的样本（可加 `data-force-at` 指向样本里的元素）经 DevTools 协议的 `CSS.forcePseudoState` 强制成悬停、按下或键盘焦点，用的是真实的样式表。总览页比视口高得多，而 Chrome 截取超出视口的元素时（`captureBeyondViewport`）会在那次截图里丢掉触屏模拟，手机与平板的截图就成了鼠标尺寸；总览整页还会超过 Chromium 的 16384px 纹理限制，所以逐组把视口加高到该组的高度（宽度、移动设备模拟与触屏不变），并断言该组放得进视口、开关轨道在触屏视口是 44px。所有组都截取，沿用总览的参考图映射。它与 `dist/web` 无关，结束时删除临时目录。
- 浏览器到不了的状态不截：页面里的本机确认卡片、添加项目、手机配对的二维码与桌面端可以回应的「仅提示」询问只出现在执行端桌面端（由 `desktop.e2e.ts` 以浅色与深色截图：卡片里的高风险确认在等待与没有通过时、调整权限对话框里的确认在等待与没有执行时、输入框上方开启完全访问会话的确认（截图前断言那句话、两条警告、命令与工作目录都已显示）、配对的未生成、二维码（截图前换成同样大小的固定图案，邀请码不进入截图）与有设备在等待时，以及注入样式时的不变；高风险确认与开启会话的卡片另在 820 宽截图并断言没有横向滚动，桌面端窗口不窄于 768，没有手机宽度；调整权限对话框里的卡片到达时停在 0、60、120、180ms 截图，并核对按高度展开 180ms、内容淡入 120ms；Host 在测试里开了 HTTPS 入口；「电脑」的上限、出站白名单对话框与添加项目另存一张浅色截图）；浏览器截到的配对是说明原因的一行。没有「批准普通操作」权限的设备与旧版 Host 的审批卡由页面拦下 Host 的回答再截：前者从快照的设备权限里去掉这一项，后者去掉快照的 `host` 与审批的风险和选项，其余都是 Host 的真实数据。桌面截图在普通审批上另做一次注入样式的核对（差异与折叠条），手机截图核对差异不超过 240、每行只有一列行号且只占一行。
- 另截拒绝后的状态 `session-rejected`与输入拒绝说明的 `approval-r1-note`，三种宽度与两种主题均覆盖。
- 桌面端另截完全访问会话阻塞持久授权与配对的状态，包括查看、停止与停止后的重试。
- 输出：`test-results/visual/<状态>--<视口>--<主题>.png` 与 `index.json`，后者为每张图列出状态、视口、主题、说明、尺寸与要对照的参考图 `board`。参考图由 `LATCH_VISUAL_BOARDS=<json 文件>` 给出，格式为 `{ "<状态>": { "<视口>": "<文件名，{theme} 换成主题>" } }`；没有给出时为 null。
- 每次运行结果相同：页面时钟用 Playwright 的 `clock.setFixedTime` 固定在一个早于任何运行的时刻（工作面板后的粒子场按 `Date.now()` 取帧，所以截图里是同一帧静止的画面，`e2e/particle-field.e2e.ts` 核对两次载入像素相同），Host 的 `now` 固定在同一时刻，凭据期限、连接倒计时与设备时间因而不变；会话列表按真实时间记录，所以都显示「刚刚」并归入「今天」。消息、运行与每轮改动记录的时间用 Host 的 `clock`：它从页面时钟之后一分钟开始，由脚本推进（每段思考、正文、工具调用、完成与失败各走一段固定的时长，审批前另走一段），所以消息的时刻、思考与工具的用时、回合脚部的时间与它提示里的用时、时间分隔每次都相同。文件观察在运行结束后还持续两秒，而后面的会话写同一个文件夹，所以脚本等上一轮的观察结束才继续；会话列表的滚动位置在截图前设好，不取决于点击时行是否还在移动。新会话页不挂载环境背景；回到其他页面前取消模拟。截图停止动画、隐藏光标，先等待字体、图片与两帧；鼠标停在左上角；触控视口也用点击驱动，因为模拟的轻点会在页面上留下 Chrome 的点按高亮。每个状态都从新开的标签页出发（清空 sessionStorage，页面打开最近更新的会话），不依赖上一个状态。侧栏页脚的电脑名称由测试 Host 的 `hostName` 固定，不随运行的机器变化。设备指纹与核对码来自每次新生成的密钥，截图时只把这些等宽文字设为透明，布局不变。项目目录会出现在会话详情、项目选择器与设置中，所以放在系统临时目录下固定的 `latch-visual/`，其中的 `.owner` 记录进程号，防止两次运行共用；结束时删除。同一次运行中重新驱动几个状态再截图，按下面的比较规则与第一次比较，不允许任何计入的不同像素；不要求每个像素的值都相同，因为即使在同一次运行中，Chrome 也偶尔把个别像素画得相差一两级。
- 比较：设置 `LATCH_VISUAL_BASELINE=<目录>` 时，最后一个用例把每张截图与该目录中同名的图比较，为改变的图写出差异图（红色为计入的不同像素，黄色为不计入的抗锯齿像素，其余为淡化的基线），并写出 `test-results/visual-diff/report.json`（相同、改变、缺少基线、基线中有而本次没有截取）。只有 `LATCH_VISUAL_STRICT=1` 时，不相同的结果才使用例失败；没有设置基线时该用例跳过。每次运行先清空 `test-results/visual/` 与 `test-results/visual-diff/`，所以基线目录必须在它们之外，否则用例在开始时报错。比较在浏览器页面里进行：Chrome 原样解码 PNG（不做色彩转换与预乘），按 YIQ 感知色差（与 pixelmatch 的公式相同）逐像素比较，阈值 0.1，不需要额外依赖。阈值忽略很淡的色差，仍能发现改变的颜色令牌与移动的文字。亮度介于一个更暗与一个更亮的相邻像素之间、且其中一个相邻像素在两张图中都处于平坦区域的像素视为抗锯齿边缘，不计入，因为 Chrome 在两次运行之间可能把小图形的边缘画得略有不同；代价是一条夹在两种不同纯色之间的 1px 线改了颜色时可能被当作抗锯齿而漏报。其余超过阈值的像素一个也不允许。字体与渲染随系统不同，所以只比较同一台机器上的截图。

```sh
pnpm build
pnpm exec vitest run --config e2e/vitest.config.ts e2e/visual.e2e.ts
cp -R test-results/visual <基线目录>                      # 保存一次运行作为基线
LATCH_VISUAL_BASELINE=<基线目录> pnpm exec vitest run --config e2e/vitest.config.ts e2e/visual.e2e.ts
LATCH_VISUAL_BASELINE=<基线目录> LATCH_VISUAL_STRICT=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/visual.e2e.ts
```

## Electron e2e

```sh
pnpm build
LATCH_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts
```

- 只在 macOS 上运行；没有 `LATCH_ELECTRON_E2E=1` 或在其他系统上时整组跳过。
- Host 在测试进程内用 `startTestHost({ presenceMode: 'manual', now })` 启动，测试用 `writeHostState` 写出 `host.json`（记录测试进程的 PID），再以 `apps/desktop/src/main.cjs --latch-host-state=<host.json> --latch-user-data=<临时目录> --use-mock-keychain` 启动 Electron。临时的 `--latch-user-data` 让凭据文件留在临时目录，不碰用户的桌面端数据；`--use-mock-keychain` 让 safeStorage 不使用登录钥匙串。Electron 的环境来自 `desktopShellEnvironment`，不带 Host 设置、模型密钥与调试开关。
- Electron 由 Playwright 的 `_electron.launch()` 启动。没有给出 `executablePath` 时，Playwright 从它自己的安装位置解析 `electron` 包，在 pnpm 的目录布局下只能找到根 `node_modules` 中的那一份，所以根 `package.json` 保留 `electron`（CI 的 `pnpm exec install-electron` 也用它）。
- 覆盖：经 `host.sock` 登记并核对指纹，另一个用例在本机确认不可用时只用离线连接码登记；「设置 › 通用」的「这台 Mac」（开发运行时主进程报告登录项不可用，没有这一行，会话运行时显示保持唤醒并可关闭，关闭写入临时 `--latch-user-data` 中的 `lifecycle.json`，没有重新启动 Host 的按钮），以及页面经转发报告运行状态得到 403；主进程在 `powerMonitor` 的 `suspend` 时经 `host.sock` 报告睡眠，页面显示「电脑已休眠」，`resume` 后按通告的时间重新连接（测试在主进程触发这两个事件）；凭据只在主进程（0600 加密文件，渲染进程没有 Cookie 与存储，自行调用续期接口得到 403）；渲染进程没有自己的网络（fetch、WebSocket、图片与 `window.open` 都被拦截，回环端口上的连接计数始终为 0）；脚本外链先经原生确认，实际文档点击一次打开（在主进程替换 `dialog.showMessageBox` 与 `shell.openExternal` 记录调用，并验证合成点击无效）；R2 审批经本机确认后执行；Host 时钟拨快 25 小时后由主进程续期；被撤销后回到连接页并删除凭据文件；关闭最后一个窗口后桌面端仍在运行并保持唤醒，`activate` 重新打开窗口；退出桌面端后 Host 继续运行。
- 模型服务：预置服务商密钥免确认；本机地址和出站许可只确认一次，保存不再重复确认。测试阻断外部 DNS，只用本地假服务。
- 项目操作：「设置 › 项目」的添加项目经替换的 `dialog.showOpenDialog` 选中两个临时文件夹，审计记为 `via: 'picker'`，在访达中显示只把已登记文件夹的真实路径交给替换的 `shell.showItemInFolder`（未知标识 `not-found`，`shell.openPath` 从未调用），页面直接 POST 添加路由得到 403 `shell-managed`，`drop` 对不是磁盘文件的值什么都不问，经 `<input type=file>` 得到的磁盘文件先进入默认「取消」的原生确认（文件夹对话框只为有焦点的窗口打开，测试把 `BrowserWindow.prototype.isFocused` 替换为总是有焦点）。
- 拒绝导航的检查放在用例最后：Playwright 会把被拒绝的导航一直当作进行中，所以由主进程触发，并在主进程监听 `will-frame-navigate` 观察，之后只读取地址、不再驱动页面。
- 用例以开发模式运行（`devMode: true`）。打包版本才启用的启动参数与调试开关检查只有 `desktop-proxy.test.ts` 的单元用例覆盖：打包构建尚未实现，仓库中还没有可供 e2e 启动的打包产物。

## 构建产物检查

测试代码是 `@latch/testkit`（`packages/testkit/`）、`tests/`、`e2e/` 与各项目 `test/`（`apps/host/test/`、`apps/web/test/`、`apps/desktop/test/`、`packages/harness-acp/test/`）中的文件，只有测试导入它们：

- `pnpm check:boundaries`：`@latch/testkit` 在 `PROJECTS` 中标为只供测试，任何项目（包括仓库根）只能把它写在 devDependencies。
- `pnpm lint`：测试目录以外导入 `@latch/testkit`，或经相对路径导入 `tests/`、`test/` 中的文件即失败；任何项目经相对路径进入 `e2e/` 也失败（它与 `apps/`、`packages/` 一样是 workspace 项目，且没有 exports）。这条规则不检查 `require()`，所以桌面端的 CommonJS 源码另用 `grep -rnE "testkit|tests?/|e2e/|createTestPresence" apps/desktop/src` 检查，必须没有输出。
- Host 构建：`apps/host/scripts/host-bundle.ts` 的 esbuild 插件在入口引到 `@latch/testkit`，或加载 `packages/testkit/`、`tests/`、`e2e/`、`apps/*/test/`、`packages/*/test/` 下的任何文件时让构建失败（按解析后的真实路径判断，经 workspace 链接或相对路径都算）。测试中打包 Host 入口用同一份选项。

`pnpm build` 之后运行：

```sh
grep -rnE 'createTestPresence|startHostFixture|latch-test\.localhost|(tests?|e2e)/(helpers|fixtures)|packages/testkit|@latch/testkit' dist/
```

必须没有输出（grep 以状态 1 结束），说明测试辅助没有进入 Host、页面与确认组件的产物。Host 的 bundle 不压缩，带源文件路径注释与 source map；页面产物经过压缩，名称可能被改写，所以也匹配测试证书的主机名这类会原样保留的字符串。

## 仓库检查

这些命令检查仓库自身的结构，不运行产品代码，都在仓库根运行；改动、新增与未跟踪的文件按 git 的列表读取，`.gitignore` 忽略的文件（构建产物、依赖、用户数据）不在其中。

- **`pnpm check:quick` 与 `pnpm check`**（`scripts/check.ts`）：依次运行各项，一项失败也继续，最后逐项写出通过或失败，有失败时以状态 1 结束。
- **`pnpm check -- --plan`**（规则在 `scripts/verify-plan.ts`）：比较工作区与 `--base`（默认 HEAD）以及未跟踪的文件，按改动路径列出要运行的命令与触发它的文件，以及「不需要运行」的命令。依赖文件（`package.json`、`pnpm-workspace.yaml`、锁文件）与规则不认识的路径要求全部检查；Electron 用例按 `e2e-desktop` 工作流的路径列出；只在对应路径改动时才列出共享编码的定向用例、确认组件的重新构建与布局检查。它只按路径判断：改动是否触及连接、登记、审批、取消或流式状态，仍由改动者按根 `AGENTS.md`「完成标准」决定。技能 `latch-verify` 按它运行并汇报。
- **`pnpm check:agents`**（`scripts/check-agents.ts`，规则在 `scripts/agent-docs.ts` 与 `scripts/doc-hygiene.ts`）检查结构，措辞只比对一份词表：
  - 预算按 UTF-8 字节：根 `AGENTS.md` 不超过 16 KiB，其余每个不超过 4 KiB，从仓库根到任一 `AGENTS.md` 的路径上合计不超过 24 KiB（Codex 把这条路径上的文件拼在一起，超过 32 KiB 的部分不读）。超限时把只对子目录有效的规则移到子目录，或把机制说明移进 `docs/` 并留链接。
  - 每个 `AGENTS.md` 旁有 `CLAUDE.md`：项目中的内容恰为 `@AGENTS.md`，根文件以它开头；没有 `CLAUDE.md` 落单。
  - 每个 Markdown 文件中的相对链接指向存在的文件，`#锚点` 对应目标文件中的标题（GitHub 的规则：小写、去掉标点、空格变为 `-`）。
  - `AGENTS.md`、`CLAUDE.md` 与 `SKILL.md` 在行内代码与 shell 代码块中提到的路径存在：相对该文件的目录、仓库根，或作为某个路径的结尾；带 `<…>` 或 `*` 的占位与通配、URL、包名开头的导入路径与 git 忽略的路径不检查。
  - 写成 `<文件>#<用例名>` 的用例引用：文件存在，名称按 ` > ` 分开的每一段都以字符串字面量出现在文件中（`it.each` 引用带 `%s` 的模板）。
  - 根 `AGENTS.md` 提到每个 workspace 项目的目录；`.agents/skills` 中每个技能的 `SKILL.md` 有与目录同名的 `name` 与 1 到 1024 字符的 `description`，`.claude/skills` 中恰好有指向它们的链接。
  - 每个 `docs/*.md` 以 front matter 开头，含 `description` 与非空的 `sources`，`sources` 中的路径都存在。
  - 本机专用目录没有被跟踪，`.gitignore` 有它那一行；`docs/` 的文件名都在 `scripts/doc-hygiene.ts` 的列表里；`docs/`、`AGENTS.md` 与 `README.md` 不含词表中的词。词表只存哈希，防误写，不是保密手段。
- **`pnpm docs:affected`**（`scripts/docs-affected.ts`）：列出 `sources` 覆盖改动路径的 `docs/*.md`、改动文件所在目录及其上层的项目 `AGENTS.md`，以及有目录新增或消失时的根 `AGENTS.md`；只是候选，从不失败。
- **`pnpm agents:sync`**（`scripts/agents-sync.ts`）：为每个技能建立相对链接 `.claude/skills/<名称>` → `../../.agents/skills/<名称>`（Claude Code 读取项目的 `.claude/skills/`，并跟随其中的符号链接；Codex 自己读取 `.agents/skills`），删除指向已不存在的技能的链接，不动其他文件。检出不支持符号链接时（如没有开启 `core.symlinks` 的 Windows）`check:agents` 失败；复制加校验的做法尚未实现。
- **`pnpm security:scan`**（`scripts/security-scan.ts`）：规则在 `scripts/security-rules.ts`，只看新增行。它是安全审阅的机械部分，技能 `latch-security-review` 在它之后按不变量审阅。

## 供应链金丝雀

`pnpm check:supply` 依次检查三件事，任何一项失败都以状态 1 结束：

- **例外**：`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 与 `trustPolicyExclude` 只能写 `name@精确版本`（可用 `||` 列出几个精确版本）；每组以 `reason:`、`reviewer:`、`expires:` 注释开头，`expires` 是 UTC 日期，当天仍有效、次日起失败，最多写到 90 天后，到期后删除或重新审阅；条目必须仍在 `pnpm-lock.yaml` 中。
- **`packageManager`**：sha512 必须等于 `https://registry.npmjs.org` 为该 pnpm 版本公布的完整性值。pnpm 自己切换版本时不读这个哈希（它从 registry 解析，并按隔离期与信任策略检查），只有经 Corepack 安装时才校验，所以由这里核对。需要网络，读不到时失败。
- **安装金丝雀**：在 127.0.0.1 上启动只含夹具包的 registry，每个金丝雀在自己的临时项目、store、cache 与 `HOME` 中，用仓库的 `pnpm-workspace.yaml` 运行一次 `pnpm install`，必须以对应的错误码失败：带 postinstall 的包（`ERR_PNPM_IGNORED_BUILDS`，且脚本没有运行）、发布 3 天的版本（`ERR_PNPM_NO_MATURE_MATCHING_VERSION`，pnpm 自带的 1 天默认值拦不住它）、git 来源的传递依赖（`ERR_PNPM_EXOTIC_SUBDEP`）、没有 `time` 的元数据（`ERR_PNPM_MISSING_TIME`）、信任证据下降的版本（`ERR_PNPM_TRUST_DOWNGRADE`）、锁文件中发布不足 7 天的版本的冻结安装（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。另有一个满 7 天、无脚本的对照包必须能安装，否则失败说明不了策略。金丝雀用运行脚本的 pnpm（`npm_execpath`），版本必须等于 `packageManager`，所以要经 pnpm 运行（`pnpm check:supply`、`pnpm test` 或 `pnpm exec vitest`）。

`supply-canaries.test.ts` 用同一套夹具再验证一遍，并把每个金丝雀守护的设置放宽（例如 `strictDepBuilds: false`、`minimumReleaseAge: 1440`），断言此时安装成功，证明每个金丝雀只因它对应的设置而失败。升级 pnpm 前先让这些用例在新版本上通过。

## 持续集成

GitHub Actions 的工作流在 `.github/workflows/`：

| 工作流 / 作业 | 触发 | 运行器 | 内容 |
| --- | --- | --- | --- |
| `ci` / `static` | PR、推送到 `main` | `ubuntu-24.04` | `pnpm check:supply`、`fmt:check`、`lint`、`typecheck`、`check:boundaries`、`check:agents`、`knip`、`check:workflows`（带只读的 `github.token`，zizmor 另做在线审计） |
| `ci` / `unit` | PR、推送到 `main` | `ubuntu-24.04` | `pnpm test`（`@latch/ui` 的浏览器用例用运行器自带的 Google Chrome） |
| `ci` / `build` | PR、推送到 `main` | `macos-26` | `pnpm build`；确认组件必须已构建且签名有效；运行 `presence.test.ts`（含组件的 `--self-test`）；构建产物检查 |
| `e2e-web` | 每天 03:23（Asia/Shanghai）与手动 | `ubuntu-24.04` | `pnpm build` 后用运行器自带的 Google Chrome 运行 `pnpm test:e2e` |
| `e2e-desktop` | 改动 `apps/desktop/`、桌面启动脚本、Host 发现与凭据（`host-state.ts`、`listeners.ts`、`access.ts`、`auth.ts`、`apps/web/src/core/credentials.ts`）、CSP（`http-util.ts`）、Node 或依赖版本、本用例、它的配置与辅助（`e2e/package.json`、`e2e/vitest.config.ts`、`e2e/helpers/`、`packages/testkit/`）的 PR；推送到 `main`、`v*` 标签与手动 | `macos-26` | `pnpm build`、`pnpm exec install-electron`，再以 `LATCH_ELECTRON_E2E=1` 运行 `desktop.e2e.ts` |

每个作业先经 `.github/actions/setup/` 安装：`.node-version` 的 Node.js；Node 自带的 Corepack 安装 `packageManager` 指定的 pnpm，sha512 不符时拒绝；`pnpm install --frozen-lockfile` 对锁文件中的每个版本重新执行隔离期与信任检查。e2e 失败时上传 `test-results/`（保留 7 天）。`unit` 在 Linux 上运行，macOS 专用的用例（路径别名、`--code-file` 的 ACL）在那里跳过，由本机的 `pnpm test`（pre-push 钩子）覆盖。

工作流的规则，`pnpm check:workflows` 检查其中大部分：

- 每个 `uses:` 固定到完整的提交 SHA，行尾注释写版本；仓库内的 action 用 `uses: $/<路径>` 引用，GitHub 从正在运行的提交读取它，而不是读工作区中可能被前面步骤改过的文件。
- 工作流级 `permissions: {}`，作业只列出需要的权限（目前都是 `contents: read`）；`actions/checkout` 设 `persist-credentials: false`；不用 `pull_request_target` 与 `workflow_run`，不使用密钥。
- 工作流级 `cache-mode: none`，`setup-node` 设 `package-manager-cache: false`：没有作业读写 Actions 缓存，一次运行（包括外部 PR 的运行）留不下被后续运行读取的文件。zizmor 的 `cache-poisoning` 规则在 `.github/zizmor.yml` 中升为最高级别；zizmor 的任何发现都使检查失败。
- actionlint 1.7.12 还不认识 `cache-mode` 与 `$/`，`.github/actionlint.yaml` 只忽略这两条报错；固定的 actionlint 支持后删除对应条目。
- 更新 action：用 `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` 取提交（附注标签再取 `git/tags/<sha>` 的 `object.sha`），只选发布满 7 天的版本，更新每处引用的 SHA 与版本注释后运行 `pnpm check:workflows`。
- 更新 actionlint 或 zizmor：在 `scripts/workflow-tools.ts` 中修改版本与四个平台归档的 SHA-256；每个归档先用 `gh attestation verify <文件> --repo <项目>` 核对它由该项目在对应标签上的发布工作流构建。`pnpm check:workflows` 下载后先核对 SHA-256，不符时不解压。

## Git 钩子

每个克隆手动设置一次：`pnpm exec lefthook install` 安装 Git 钩子（`lefthook.yml`：pre-commit 检查暂存文件的格式与 lint 错误，pre-push 运行 `pnpm typecheck` 与 `pnpm test`）；`git config blame.ignoreRevsFile .git-blame-ignore-revs` 让 `git blame` 跳过只改格式的提交。`pnpm install` 不会安装钩子（`allowBuilds` 禁止 lefthook 的安装脚本）。

Git 已设置 `core.hooksPath` 时 lefthook 拒绝安装：不要加 `--force`（会写入那个目录）或 `--reset-hooks-path`（会删除该设置），改为提交前运行 `pnpm exec lefthook run pre-commit`、推送前运行 `pnpm exec lefthook run pre-push`。


Agent 诊断的界面回归在 `apps/web/test/agent-probe.test.ts` 与 `e2e/desktop.e2e.ts`：覆盖不弹确认的握手、登录未验证说明、定义变更清除旧结果、失败诊断脱敏、无会话副作用，以及三种宽度的浅色/深色截图。

## 人工检查本机确认（Touch ID）

自动化测试从不显示真实的系统确认表单。唯一运行真实组件的用例是 `presence.test.ts` 的自检：`latch-presence --self-test packages/testkit/vectors/security-v1.json` 在空环境中只计算并比对向量，不调用 LocalAuthentication；它只在 macOS 上、且 `dist/native/latch-presence` 已构建时运行。

系统表单、Touch ID 与登录密码只做人工检查：

```sh
pnpm build:presence
pnpm latch presence test --data-dir <临时目录>
```

- 它先打印「系统提示应显示：允许「示例设备（只是检查）」连接这台 Mac」，再弹出 macOS 的标准 Touch ID 表单。核对表单里的理由与打印的一致，并记下表单显示的应用名与图标：组件内嵌的 Info.plist 把名称设为 Latch，表单若仍写 latch-presence 或其他程序名，记下来再改；Latch 自己不画任何窗口。
- 依次检查：Touch ID（这台 Mac 不支持时改用登录密码）、「取消」，以及放置不动直到超时（组件 115 秒后自己关闭表单，结果为 `timeout`）。命令输出 `结果：approved（biometric）` 等结果。
- 对没有运行 Host 的临时数据目录，命令持有数据目录锁，并在第一次使用时登记组件签名。重新构建组件会改变签名，之后换一个新的临时目录，或运行 `pnpm latch presence repin --data-dir <同一目录>`。

## 不在自动化范围内

- iOS/iPadOS 真机的软键盘、后台挂起与读屏；真机经 Tailscale 证书的 HTTPS 访问；公网代理。
- 真实模型服务的兼容矩阵，以及真实 ACP Agent 的提示执行。对真实 Agent 只做人工验收；可以在不发送提示的前提下检查握手（`initialize`、`session/new`）。
- macOS 的系统确认表单本身（见上一节）。Linux 与 Windows 上的本机确认尚未实现（没有对应的确认组件），相关用例只覆盖「不可用」路径与桌面端的离线连接码。
- 打包后的 Electron 应用（尚未实现，见「Electron e2e」）。

## 已执行与未执行

汇报时逐条写出实际运行的命令及结果（通过、失败、跳过的数量）；没有运行的检查写明「未运行」与原因。以下情况即使命令整体通过，也算未执行：

- Vitest 报告为跳过的用例：没有 `LATCH_ELECTRON_E2E=1` 或不在 macOS 上的 `desktop.e2e.ts`；不在 macOS 上或 `dist/native/latch-presence` 未构建时的组件自检；非 macOS 上的路径别名与 `--code-file` ACL 用例；以 root 运行时的目录属主用例；Windows 上的 FIFO 与符号链接替换用例；非 POSIX 系统上的文件权限用例。
- 改了客户端却没有重新 `pnpm build` 就运行的 e2e：它测的是旧的 `dist/web`。改了 `native/macos/LatchPresence.swift` 却没有重新构建组件时的自检同理。
- 没有对当前构建运行的「构建产物检查」。
- 没有人实际操作过的人工检查（Touch ID 窗口、真机、真实 Agent）。

浏览器 e2e 通过不代表桌面端已验收；测试夹具与演示模型不代表真实模型；Chromium 的手机尺寸与触控模拟不代表真机。

`e2e/projects.e2e.ts` 在临时 Host 上通过签名夹具创建多文件夹项目，再用真实浏览器验证空项目常驻、组内重命名、编辑器主文件夹排序、会话数只读与目录丢失后的保留。覆盖手机、平板、桌面及深色模式，截图在 `test-results/projects/`。签名夹具不等于原生文件夹面板或 Touch ID 的人工验收。

文件内容列回归：`e2e/file-preview.e2e.ts` 用临时 Host、本地假模型与生成的文档验证文本、DOCX、CSV、SVG、音频与秘密文件拒绝，覆盖三种宽度与深浅主题。`e2e/file-chips.e2e.ts` 通过删除响应中的内容能力标记模拟旧 Host 契约，保留旧菜单降级覆盖；后端仍使用真实登记与会话。`preview-frames.test.ts` 和 `desktop-frames.test.ts` 验证文档框入口的拒绝路径。真实 Quick Look 网络行为仍需独立人工验收。

会话分叉由 `apps/host/test/forks.test.ts` 检查边界、截断、清空上下文后的种子起点、权限、幂等、元数据重载与自有目录复用；`apps/host/test/pi-fork.test.ts` 用假 pi 经真实 Host 检查 pi 自己的分叉：从第一轮、最新一轮与分叉的分叉，来源的文件不变、来源照常继续，换 Harness、扩展取消与会话文件不在时以文字带上；清空上下文由 `apps/host/test/fresh-context.test.ts`（路由的拒绝与记录）、`tests/runtime.test.ts`（Latch 内置发给模型的历史）、`packages/harness-acp/test/acp.test.ts` 的「a new context in a session」（新 Agent 会话、选项重设、关闭旧会话、指令重发、被拒绝后的边界）与 `pi.test.ts`（pi 的新会话）覆盖，假 Agent 的 `recall` 说出会话里之前有几条输入，`e2e/context.e2e.ts` 在桌面与手机上走一遍 `/clear`、撤销、会话菜单、选定后重试、分隔线与刷新，`apps/host/test/native-swift.test.ts` 检查 iPhone 的分隔线与 Host 已清空时的提示；两种 Driver 的现有重启用例核对用户消息 requestId。`e2e/forks.e2e.ts` 在桌面、平板与手机验证预填、可编辑输入与折叠的真实上下文，并用两个假 Agent 验证分叉草稿沿用来源的模型、思考与权限档、换 Harness 后的对应与说明（goose 的选项在选它之后才读取，读取期间说明里出现过的每一行都要属实），以及假 Agent 用 `drift <模式>` 自己换到更宽的模式后，「在新会话中继续」仍从人选的档位开始；`apps/web/test/fork-choice.test.ts` 覆盖同一 Harness、换 Harness、来源模型已不可选、经 Latch 转发的服务、来源没有模式、来源的模式被 Harness 自己改过或没能确认、目标 Harness 的选项还没读到与人在草稿里改选。

文档与富文本的定向用例为 `apps/web/test/preview-data.test.ts`、`apps/web/test/rich-rendering.test.ts` 和 `e2e/preview-renderers.e2e.ts`。浏览器用例运行独立临时端口的 Vite 夹具与构建出的 Office/Diagram IIFE，覆盖真实 worker、缓存公式、PDF Range、不可见字符、数学 DOM 与图表。字体/分式和实际 canvas 像素也必须验证，节点存在不等于内容已经渲染。

`e2e/preview-security-webkit.e2e.ts` 使用产品 `DocumentPreview`、`Diagram` 和 `FileSandbox`，在实际 WebKit 的三种宽度与浅深色下读取 Office、PDF 像素、静态 HTML 和需点击开始的 Mermaid，并核对框内的拒绝行为。WebKit 不支持的能力不能算作该平台通过，由对应浏览器和桌面用例验证。

`e2e/file-preview.e2e.ts` 另通过真实 Host 在三种宽度验证 Markdown 预览/源码切换、相对链接、已授权项目图片、秘密图片拒绝、公式、图表和共享代码高亮，以及更新文本后的行位置保留。测试图片必须先在会话中有引用；浏览器默认的 `work` 范围不能借 Markdown 枚举其他文件。

排队：apps/host/test/prompt-queues.test.ts 覆盖 FIFO、容量、回执、编辑、未知结果、重启、审计与权限失败；prompt-queue-api.test.ts 经 HTTP 覆盖手机 L1、Stop（含只答复上一轮之后子 Agent 请求的 Stop 也暂停）、撤回权限、手机禁止给 L3 输入而仍可移除，以及审计失败仍移除。native.test.ts 验证队列不改绑新的手机窗口。两种 Driver 的重启用例核对 queuedAt/requestId/runOutcome。apps/web/test/prompt-queue.test.ts 检查旧 Host 降级、双槽与只读托盘；e2e/prompt-queue.e2e.ts 在三宽度与浅深模式验证编辑、FIFO、暂停、手动继续、移除和失去权限的实际渲染。

问答：`apps/host/test/questions.test.ts` 覆盖题包与答案校验、首答竞争、请求绑定、审计失败、晚到撤权、取消与重启时的精确工具输出恢复；`questions-api.test.ts` 经真实 HTTP 验证远程 L1 回答、只读拒绝与模型继续。`tests/runtime.test.ts` 验证等待暂停计时及持久化结果先于确认和下一次模型调用。`e2e/questions.e2e.ts` 在桌面、平板、手机深色模式验证多题、其他答案、设备草稿重载与回答后的继续执行。

附件定向覆盖 `apps/host/test/attachments.test.ts`、`attachment-routes.test.ts`、`provider-attachments.test.ts`、`packages/harness-acp/test/attachments.test.ts` 和 `apps/desktop/test/desktop-uploads.test.ts`。它们只用临时目录、socket、测试确认和内存 Provider，检查绑定、过期、幂等、损坏/中断恢复、Range、视觉声明和内容块；桌面用例还证明大附件通过专用流，而其他 JSON 路由仍拒绝相同大小的正文。

`e2e/attachments.e2e.ts` 用真实 Host、浏览器与内存模型覆盖三种宽度、深色、仅图片消息、预览、失败重试、未知提交重试、长粘贴编辑、取消等待和显式文件选择；`e2e/desktop-attachments.e2e.ts` 在独立桌面数据目录验证实际 Electron 上传大于 JSON 限额的图片与私有预览。ACP 的真实假进程用例核对协商、输入块、Agent 图片输出和重启后的 metadata；它不是实际 Agent CLI 验收。

发送投影：`apps/web/test/sending-message.test.ts` 检查设备会话归属、旧 Host 降级、队列隐藏、各 Harness 的新会话立即显示，以及请求标识和附件/文件引用的精确匹配。`e2e/sending-message.e2e.ts` 在三种宽度延迟实际写请求、模拟连接中断，核对即时文字、发送中、未知状态、原请求重试和唯一的已确认消息，并核对完全访问 Harness 的新会话同样立即显示。
文件变化的范围、运行结算、可选插件契约与验证见 [运行期间的文件变化](FILE-OUTPUTS.md)。

`apps/host/test/file-tree.test.ts` 经真实 Host 检查会话与带 Harness 的项目懒加载、主根限制、隐藏项、符号链接、`work` 拒绝、跨设备句柄、根换序／同路径替换、迟到撤权和哈希审计；受控子进程检查无排队并发和取消后的真实退出。`files-helper.test.ts` 编译真实 Swift 组件，验证私有路径、Unicode 与上限；`native.test.ts` 的文件树用例经真实原生 TLS 验证正文窗口前后与到期迟到结果。非 macOS 跳过实际枚举，缺组件仍检查诚实拒绝。标准 `build:host` 同时构建目录组件，运行测试只用临时 Host 和测试确认后端。

文档样例统一由 `@latch/testkit` 的 `documentFixtures` 生成，覆盖备注、窗口化大页数与缓存公式；格式浏览器回归还核对保页、键盘缩放、横向手势和链接显式打开，见 [文档预览](DOCUMENT-PREVIEWS.md)。

`changes-panel.e2e.ts` 用真实工具与真实 Git 仓库走完改动页签的范围、撤销与恢复、合并中的拒绝和数据范围不足的说明，再按 Host 的答复在三种宽度、浅深色下画出每个状态（截图在 `test-results/changes-panel/`），并量过两万个文件的列表。

`file-history.e2e.ts` 用真实工具写入生成两文件、三次差异，检查最新优先、旧记录展开、手机行内、宽屏左右对照与展开宽度、删除重载后的历史保留；同时核对差异最后一行没有额外空白。`diff-layout.test.ts` 检查不等长变更块、空行和两侧行序号守恒。

`file-tree.e2e.ts` 使用临时真实项目，在手机、平板、桌面浅深色验证发消息前浏览、草稿保持、多根预览/搜索、键盘、目录分页、缺失重试与结构化引用；先证明 `work` 不显示树，再由测试执行端明确授予范围。`desktop-files.e2e.ts` 还验证实际 Electron preload、有限目录代理与项目句柄的访达动作。

`desktop-plugins.e2e.ts` 在真实 Electron 与临时 Host 中核对「添加插件」只有「新建工具」与「导入文件…」，导入技能文件存成草稿、应用、修改、启停与删除，并验证新的 React 模块只确认一次；应用已送达而响应丢失时，界面保留同一请求再恢复。`plugin-assets.test.ts` 检查导入边界、UTF-8 大小、路径冲突与保留未知贡献，Host 对完整资产和实际执行生命周期另有回归。

`assistant-sessions.test.ts` 用早先构建留下的数据启动 Host：带 `personal.changed` 的审计照常打开，助手与群聊跑过的会话只对数据范围 `all` 的设备可读、发消息、排队、改设置、附件与撤销都回答 409 `session-read-only`（批准与回答问答要先有等待中的请求，只读的会话不再运行、造不出这样的请求，这两处没有用例），只读设备看不到也打不开它们，带 `assistantId` 的新建会话两次都回答 409 `assistant-removed` 且不新建会话（`native-swift.test.ts` 的工作台用例另核对 iPhone 不再列出这样的未确认提交，也不列出写到 `/link/api/personal/` 的群聊消息与定时任务删除）。`e2e/read-only-session.e2e.ts` 在页面上打开这样的会话（桌面浅色与手机深色），本轮改动卡、改动面板与会话菜单都不提供撤销、恢复与清空上下文。`agent-relay.test.ts` 检查一条消息在 Agent 之间接力的上限、未完成即停、设置变化即停与停止等结算。
`agent-journal.test.ts` 检查有限私有存储、严格解析、串行写入、未知结果恢复与异步后撤权。

`automations.test.ts` 用确定性时钟检查排队与错过、运行期间经过的时间、暂停原因、编辑期间的检查和单行失败不影响其他行；`automations-bundle.test.ts` 构建生产 Host bundle，启用 Harness 后重启，核对「通用」上的定时任务仍开启并实际运行。`agent-routes.test.ts` 用真实 Standard 和假模型检查范围较小的设备收不到「通用」、收到过的会话与定时任务运行私有，以及 Host 停止时不再检查。这些都不代替真实模型或真实 Agent 的验收。

原生工作台：native-swift.test.ts 的 Workspace 用例通过实际 Swift Workspace 连接临时 Host，验证正文窗口、同一请求的重试、离线列表只留行上需要的字段、继续等、手机默认的新会话选择、排队的原始请求身份，以及丢失回执后严格恢复的停止。App 的 iPhone/iPad SDK 双架构编译不代替安装后的视觉或真机身份验收。

客户端的 `workspace-recovery.e2e.ts` 真实删除原会话目录，验证三宽的项目选择、草稿、焦点与显式提交；`webkit.e2e.ts` 用实际 WebKit 检查三宽授权文件读取和引用发送。`desktop-models.e2e.ts` 在隔离 Electron 中更改假 ACP 的真实模型与推理选项，模拟执行后丢回复，确认只读恢复、没有重复写入和额外认证。配对回归另检查默认收起公开指纹后，展开仍与系统确认的原身份一致。以上夹具不代替真机 Safari、真实 Agent、Touch ID 或公网验收。

配置回执：`apps/host/test/config-requests.test.ts` 覆盖原子前置标记、终态落盘未知、重启与容量；`config-request-api.test.ts` 使用真实假 ACP 验证并发合并、相同编号冲突、失回执不重发、只读查询、真实模式放宽确认、异步撤权，以及这一轮还在启动时被拒绝的修改记为失败；`e2e/harness-options.e2e.ts` 验证刚选的思考深度在消息与重试之前送达。`native.test.ts` 验证已接受请求不改绑新的 App 验证窗口，窗口到期后查询也被拒绝。

`e2e/archive.e2e.ts` 通过临时 Host 的真实已结束会话验证三种宽度的归档批量恢复、删除确认与 Shift 连选；核对请求 ID 集合、实际回执、快照和删除后 404，并保留工作目录中的文件。标为未读经真实菜单操作，刷新后保留，打开对应会话后清除，不把本设备阅读标记当作 Host 内容变化。

`e2e/harness-login.e2e.ts` 用假 `codex` 走登录：开始前的提示、被拒绝的一轮、太早重试、重新载入、登录后继续、登录过期后恢复同一会话、在设置里取消与确认退出登录、「测试启动」读到不同的登录状态时「登录」一组跟着变（Host 丢掉记住的回答也在 `apps/host/test/agent-login.test.ts`）、握手被拒绝而状态命令仍说已登录时这一组写「登录可能已失效」并列出登录方式（手机深色、新开页面后仍在）；Agent 声明的终端登录、登录推送与退出的规则在 `packages/harness-acp/test/auth.test.ts` 与 `apps/host/test/agent-login.test.ts`，状态命令与推送谁更新、页面显示哪一个在 `apps/host/test/agent-login.test.ts` 与 `apps/web/test/harness-login.test.ts`；Electron 的登录终端（含打不开）在 `e2e/desktop-first-use.e2e.ts`。`e2e/harness-options.e2e.ts` 走开始前的选项：第一次打开模型菜单时读 Codex 自己的模型列表（不开会话，只读一次），之后列出上次会话报告的模型、思考与模式，四个模式时「按规则放行」收在「更多」里（展开、收起、再展开后选，手机表单里同样），选了再开始并读回，自己填写的模型 ID 开始时原样发出、移除后不再列出，下一个草稿记住为这个 Harness 选过的模型、思考与模式，重新载入后也在，模型不再提供时这一轮失败并说清楚、草稿里的思考与模式照常设好、重试用会话显示的，手机的新会话表单（浅色与深色），没有权限 profile 的 Harness 在手机与桌面上先打开权限也会读取并在开始前列出模式，Codex 先打开权限不读取、说发第一条消息后可以换，读取会报告模式的 Gemini CLI 先打开权限时说正在读取、读到后列出模式。这些测试都用 `loginPrograms` 与 `commandDirectories` 只在临时目录里找程序；不传 `commandDirectories` 的测试 Host 按名字找不到任何命令，`server.test.ts` 用 `node` 核对这一点。

`e2e/desktop-first-use.e2e.ts` 使用 `demo:false`、进程内假 Provider、真实假 ACP 和独立 Electron 数据目录检查首次使用与斜杠命令。桌面和平板验证逐步跳过、About 重新显示与首次真实会话后隐藏；手机沿实际新会话面板验证入口。命令来自 Agent 的实际更新，检查模板 ID／名称匹配、键盘只插入草稿、来源分组、排序、空态与三宽可达，并核对 ACP 日志中没有额外 prompt；不启用系统通知。


`file-search-index.test.ts` 检查暖索引不重新枚举、当前秘密内容/符号链接/窗口仍拒绝；真实新增与改名触发失效，构建等待期间的事件不发布旧代。缓存20,000项之外的匹配仍通过原50,000项现场搜索可见；监听上限、短TTL、配置/根inode、取消及延迟close事件均有受控回归。实际Host的暖缓存请求另验证work范围、撤销设备与移除文件夹仍拒绝，Native正文门禁沿用同一每await裁决。
`e2e/preview-access.e2e.ts` 以真实工作区工具产物和权限 PATCH/SSE 验证预览授权变化：工作范围先显式打开合法会话产物，全部范围再打开工作区文本／DOCX；将 document.hidden 设为 true 并阻断 meta 请求后收紧到 work，内容和文档框仍须撤下。合法会话产物只能经新的显式 resolve 恢复，不依赖旧预览 metadata 或旧 handle 缓存。


`desktop-notifications.e2e.ts` 在实际Electron主进程导入main前替换Notification类，保留真实host.sock快照、preload、偏好保存、焦点与点击路径；本地受控Provider产生真实Host完成/失败/审批/取消状态。Node夹具状态回归可单独运行；Electron部分由`LATCH_ELECTRON_E2E=1`开启，使用临时用户目录和mock keychain，不投递系统通知。它不代表系统通知授权或专注模式验收。


专用bulk的原生H2回归使用便利SDK以外的真实HTTP/2请求头：同一已激活句柄、正确If-Match、≤1MiB Range与错误If-Range必须关闭且不交付正文，不能回退成200整文件；普通文件服务另保留If-Range匹配206、失配200的标准行为。
