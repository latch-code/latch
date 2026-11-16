---
description: 设备预览：右栏「设备」面板经 xcrun simctl 列出、启动、关机、截图、打开地址与切换外观；在 Device Hub 中打开；Agent 的 device_* 工具与指引；设置 › MCP 的「Xcode」预设（xcrun mcpbridge）的工具开关、分级、审计与「Agent 正在使用」；限制与尚未实现的部分。
sources:
  - apps/host/src/simulators.ts
  - apps/host/src/routes/simulators.ts
  - apps/host/src/audit-actions/simulators.ts
  - apps/host/src/plugins/tools/device/index.ts
  - apps/host/src/mcp-xcode.ts
  - apps/host/src/risk.ts
  - packages/harness-acp/src/browser-server.ts
  - packages/harness-acp/src/mcp-bridge.ts
  - apps/web/src/panel/device
  - apps/host/test/simulators.test.ts
  - apps/host/test/mcp-xcode.test.ts
  - apps/web/test/device-panel.test.ts
  - e2e/desktop-device.e2e.ts
---
# 设备预览

右栏「+」里的「设备」（字母键 V）显示这台 Mac 上一台 iOS 模拟器的画面，并提供启动、关机、截图、打开地址、外观与「在 Device Hub 中打开」。只用 Apple 公开的 `xcrun simctl` 与 `open`，不加载私有框架，不下载，不加依赖。

| 部分 | 位置 |
| --- | --- |
| simctl 模块：固定参数、校验、上限、只关自己启动的 | `apps/host/src/simulators.ts` |
| 路由与功能开关 | `apps/host/src/routes/simulators.ts` |
| Agent 的 `device_*` 工具 | `apps/host/src/plugins/tools/device/` |
| 「Xcode」预设 | `apps/host/src/mcp-xcode.ts` |
| 面板 | `apps/web/src/panel/device/` |

## 谁能用

- **只在这台 Mac。** 与终端相同：只收 `host.sock`（`isLocalListener`），设备要有 `run` 且数据范围是 `all`；模拟器里有这台 Mac 的数据（Apple ID、App 数据）。手机、浏览器与其他电脑没有面板，路由回答 403；它们发起的一轮里 Agent 也用不了设备工具（见 Agent）。不过这台 Mac 上发起的一轮里 Agent 截的图，任何能读这个会话的设备都能看到。
- **只在 Host 能运行 simctl 时。** 启动脚本在 macOS 上传入真实的 `xcrun simctl`；测试不传时整个功能不存在、从不运行 simctl。
- Host 第一次列出设备后知道有没有 Xcode：有 Xcode 而一台模拟器都没有时入口消失；没有 Xcode 时面板里只有一行「未安装 Xcode」。
- 这些动作不是本机确认的动作（`PRESENCE_ACTIONS`），同终端一样，完全访问的会话运行时不额外拒绝。

## Host

`Simulators` 只运行 `/usr/bin/xcrun simctl` 与 `/usr/bin/open`，参数是固定数组（`execFile`，不经 shell），工作目录固定为 `/`（按相对名字写的文件不会落进任何人的文件夹），环境只有 `PATH`、`HOME`、`TMPDIR`、`DEVELOPER_DIR`、`USER`、`LOGNAME`：

| 动作 | simctl | 超时 |
| --- | --- | --- |
| 列表 | `list devices --json available`（输出 ≤ 4 MiB，最多 200 台） | 20 s |
| 启动 | `boot <UDID>`，再 `bootstatus <UDID>` 等它真正起来 | 各 120 s |
| 关机 | `shutdown <UDID>` | 60 s |
| 画面 | `io <UDID> screenshot --type=jpeg|png <私有临时文件>` | 20 s |
| 打开地址 | `openurl <UDID> <地址>` | 20 s |
| 外观 | `ui <UDID> appearance [light|dark]` | 20 s |
| Device Hub | `open -a <xcode-select 的 Xcode>/Contents/Applications/DeviceHub.app devices://device/open?id=<UDID>` | 20 s |

- **UDID** 必须是大写 UUID，并且出现在最新的列表里；`booted`、`all` 与选项一律拒绝。
- **地址** ≤ 2048 字符、有协议、没有空白与控制字符；`file:`、`javascript:`、`data:`、`blob:`、`about:`、`vbscript:` 拒绝。深链接（`myapp://…`）可以。
- **只关自己启动的。** Host 记住自己从关机状态启动成功的设备；列表里看到它已关机（人在别处关的）就忘掉。两次列表之间人自己关机又启动的设备看不出来，Host 仍会提供「关机」：这一点只靠列表，没有更可靠的公开接口。已经在运行的设备启动时原样保留，仍是人的。Host 停止时只结束在途的 simctl 进程，设备保持原状。
- 同一台设备同一时间一个启动、关机或修改；同一台设备同一种画面同时只取一次，后来的请求共用结果；全部设备同时最多 4 个 simctl 进程。
- **画面。** Xcode 27.2 的 simctl 不肯写到标准输出（`-` 被当成文件名，`/dev/stdout` 被拒绝），所以每张画面写进 `mkdtemp` 新建的 0700 目录，读出（≤ 5 MiB，超出 413）后立即删除目录。画面不进日志、审计、SSE 或数据目录。
- 失败的原因是 simctl 标准错误的第一行有意义的话，去掉控制与双向字符，≤ 200 字符，显示在面板的悬停里。

### 路由

| 路由 | 作用 |
| --- | --- |
| `GET /simulators` | `{ xcode, devices: [{ udid, name, os, state, ours, shown?, agent? }], agentUnnamed? }` |
| `GET /simulators/:udid/frame` | JPEG，`cache-control: no-store`；标记「面板正在显示这台」15 秒 |
| `GET /simulators/:udid/appearance` | `{ appearance: 'light' | 'dark' | null }` |
| `POST …/boot`、`…/shutdown`、`…/screenshot`（PNG）、`…/open-url`、`…/appearance`、`…/device-hub` | 先写审计，再执行 |

### 审计

- `simulator.action`：人的动作（启动、关机、截图、打开地址、外观、Device Hub），记 UDID、动作、外观；打开地址只记协议与源的 SHA-256。写不进就不执行。
- `simulator.call`：Agent 的 `device_*` 调用，记会话、工具、UDID、分级、运行时的工具调用 ID，经网关时 `via: 'mcp'`。
- 面板的刷新帧是看，不是动作，不记。

## 面板

- 顶部：设备选择（名字 · 系统版本，运行中的带绿点），外观、打开地址、截图、在 Device Hub 中打开、启动或关机。关机只对 Latch 启动的设备可用，其他运行中的设备提示「只关闭 Latch 启动的设备」。没有旋转：simctl 没有这个命令。
- 中间：运行中的设备画面放在凹陷底色上，一圈细边，按面板缩小。画面不能点，没有指针手势。其他时候是设备列表，选中的一行末尾有「启动」，按钮位置始终保留，不跳动。
- 底部一个状态词：未启动、启动中、运行中、关机中、Agent 正在使用、失败（原因在悬停里）。设备在运行但还没有第一帧画面时仍写「启动中」；Host 的启动在 `simctl bootstatus` 报告系统起来之后才返回。
- **刷新。** 只在面板显示、设备运行时取帧：上一帧到了，再等 250 ms 取下一帧；隐藏即停止并中止在途请求。取帧失败时间隔翻倍，最长 8 s；连续两次失败后底部写「失败」，原因在悬停里。实测见下。
- **截图**把 PNG 作为图片附件放进草稿，不发送；发送后按附件规则交给模型服务。

**实测的刷新**（Xcode 27.2、iOS 27.2，这台 Mac 负载 12～36 时，Electron e2e 量的是面板一帧的往返）：每帧 1.3～2.3 s，主要是 simctl 进程启动与截图；首屏 JPEG 约 60 KB。加上 250 ms 的间隔，约每秒 0.4～0.6 帧。这是准实时的缩略画面，不是视频；负载低时单次 simctl 截图约 0.5 s。

**实时画面与点按在 Device Hub 里。** Xcode 27 用 Device Hub（`com.apple.dt.Devices`）取代了 Simulator.app。「在 Device Hub 中打开」把那台设备自己的窗口调出来，人在那里实时看、点、输入。退出 Device Hub 时选「Quit Device Hub」会关掉它运行的模拟器，「Quit and Keep Simulators Running」不会。

## Agent

### Latch 自己的工具（不需要 Xcode 的设置）

内置 Harness 与外部 Harness（经 `latch-browser` MCP 服务与工具网关，与浏览器工具同一个令牌与规则）都有：

| 工具 | 级别 | 作用 |
| --- | --- | --- |
| `device_list` | R0 | UDID、名字、系统、状态，标出面板正在显示的那台 |
| `device_screenshot` | R0 | 运行中设备的 PNG，作为工具结果的图片进会话（附件规则；没有 `vision` 的模型不提供） |
| `device_open_url` | R1 | 只打开这台 Mac 的本机地址（http(s) 的 localhost、`*.localhost`、127/8、::1，同浏览器工具） |
| `device_set_appearance` | R1 | 浅色或深色 |

- **地址。** Agent 不能在设备上打开别的地址或深链接（`myapp://…`），即使这一会话「始终允许」了它：那会把读到的东西带出设备，深链接交给哪个 App 也没人选。它得到一句话，请人在设备面板里打开；人在面板里可以打开任何网址与深链接。
- **只为能看全部数据的设备发起的一轮。** 截图会进入会话，能读这个会话的设备都看得到，所以设备工具只在最近一次输入来自数据范围为「全部」的设备时执行；手机或范围更小的浏览器发起的一轮、没有人发起的定时运行都被拒绝。
- 只在这台 Mac 的桌面端开着（已登记为浏览器提供者）时执行，否则回答「Latch 窗口没有打开」；外部 Harness 的会话要有项目、完全访问、在运行中的一轮里（同浏览器工具）。网关的工具列表只在 Host 上次列出设备时找到 Xcode 才包含它们。
- 启动与关机留给人：设备没运行时工具回答「设备未启动，请在设备面板里启动」。
- **指引。** `latch-browser` 的 `initialize` 带 `instructions`：用 `device_list` 标出的那台设备的 UDID，不用 `booted`；设备没运行就请人在面板里启动；在检查点截图核对；这些工具不能点按，构建、安装、运行用自己 shell 里的 `xcodebuild` 与 `xcrun simctl`（`-destination id=<UDID>`），或人添加的 Xcode 服务器；不抹掉、不删除设备，不登录真实账号。工具说明里也写了其中要紧的几条。

### 「Xcode」预设（设置 › MCP）

Xcode 自带的 MCP 桥 `xcrun mcpbridge`（Apple 文档：Giving external agents access to Xcode）。它把 Xcode 的工具交给外部 Agent，其中的设备交互工具能启动设备会话、构建安装运行、点按与输入，每步返回截图与 UI 层级。

- **添加。** 只在这台 Mac 的桌面端：Host 用 `xcrun -f mcpbridge` 与 `xcodebuild -version` 检查（不运行桥本身，它可能启动 Xcode），版本至少 27.0；命令固定为 `/usr/bin/xcrun mcpbridge`，没有变量，在会话的项目文件夹里启动。经同一个本机确认 `mcp.server.apply`（完全访问运行或等待时拒绝）与 `mcp.server.added` 审计，不加新的确认规则。
- **人还要做两件事，Latch 不替人做：** 在 Xcode › 设置 › Intelligence 里允许外部 Agent 使用 Xcode 工具；在 Xcode 里打开项目。不用需要 sudo 的无界面模式。
- **工具**以 Xcode 27.2 的桥实际列出的 54 个为准（2026-11-17 从 Xcode 之外读到，形状存在 `apps/host/test/fixtures/xcode-mcpbridge-tools.json`）。**默认开着的：** 设备交互（`DeviceInteractionStartSession`、`…StartWorkspaceSession`、`…InstallAndRun`、`…Synthesize`、`…EndSession`），构建、运行、停止、测试、预览与它们的日志，读项目、列出并切换方案与运行目的地，打开或关闭工程（`XcodeOpenWorkspace` 正是 Xcode 请人批准 Agent 的入口），字符串目录的读取与文档搜索。**默认关着的：** 新建、写、改、建目录、删除、移动项目文件与目标、权限、Info.plist、构建设置（`XcodeWrite`、`XcodeUpdate`、`XcodeMakeDir`、`XcodeRM`、`XcodeMV`、`XcodeNewProject`、`XcodeNewTarget`、`AddEntitlement`、`AddInfoPlist`、`UpdateTargetBuildSetting`、`UpdateFileCompilerFlags`、`StringCatalogEdit`、`LocalizationPlanner`），运行代码与调试命令（`RunCodeSnippet`、`InvokeDebuggerCommand`），App Store 的崩溃与性能报告（账号的数据）。Agent 改文件用自己的文件工具。列表（`knownTools`）之外的新工具关着，直到人打开。
- **不给无人值守的运行**（我的 Agent 的定时运行），同「操控这台 Mac」。
- **分级与审计。** 每次调用照常写 `mcp.tool.called`，这个预设另记 Latch 的分级与调用里出现的设备 UDID（桥只从名字含 device、udid、destination 的参数里取一个 UUID 交给 Host，其他参数不出 Agent 的进程）：看（列出、读、日志、预览、结束会话）R0；开设备会话、输入、构建、安装、运行、停止、测试、切换方案与目的地、打开或关闭工程 R1；默认关着的工具与未知工具 R2。外部 Harness 的会话是完全访问，R0、R1 照常执行；R2 默认关着。
- **「Agent 正在使用」。** 一次 `…StartSession` 到 `…EndSession`（或这一轮结束、会话归档或删除、桥进程退出）之间，面板对那台设备（或调用没写设备时对运行中的设备）显示「Agent 正在使用」。
- **指引。** 桥用 Latch 的一段替换 Xcode 自己的 `instructions`（Xcode 的原话只有一句「Request Xcode perform the action you specify.」，附在末尾）：先用 `XcodeOpenWorkspace` 打开工程，等人在 Xcode 里批准；用面板显示的那台设备的 UDID；先开设备会话、用完结束；每步之前读返回的截图与 UI 层级，按无障碍标识、标签、层级里的 hitPoint 点，估算坐标放最后；用 Xcode 的工具构建安装运行；在检查点核对；遇到登录、付款或系统权限对话框就停下请人处理；不抹掉、删除或关闭设备；Latch 的 `device_*` 负责列表、截图、开地址与外观，Xcode 的工具负责构建、安装、运行与输入；改文件与运行代码的工具在 Latch 里关着。
- 同一段指引也作为 `latch-skills` 的内置技能交给有它的会话（同「操控这台 Mac」的指南）。

## 浏览器面板的手机视图

见 [PREVIEW-BROWSER.md](PREVIEW-BROWSER.md#视口外观控制台与网络)：多了小屏手机、大屏手机、Android 手机三个预设与各自的像素比，手机预设外面有 Latch 画的外框与安全区示意。

## 尚未实现

- **在 Latch 面板里点按、实时视频。** `simctl` 没有点按，实时取帧只能经私有框架（CoreSimulator、SimulatorKit），这一期不用；实时画面与点按在 Device Hub 的窗口里。
- **接手与交还 Xcode 的设备会话。** Xcode 的调用由 Agent 进程里的桥直接交给 `mcpbridge`，结果不经 Host，Host 拦不住在途的点按，所以只显示状态，不提供接手；面板的画面也不从 Agent 的工具结果更新，只来自 simctl 截图。
- **手机与其他电脑上看模拟器。** 要把这台 Mac 的画面传到别的设备，需要单独的安全审阅；那些设备上没有入口。
- **Android 与真机。** 不列出，不操作。
- **录屏。** `simctl io recordVideo` 这一期没有接入。
- **Agent 启动或关闭设备。** 留给人。
- **`device_*` 的指引作为内置技能。** 内置技能挂在 Latch 的 MCP 服务器上，`latch-browser` 不是其中之一，所以这段指引只经 `instructions` 与工具说明给出。

## 测试

| 范围 | 文件 |
| --- | --- |
| 固定参数与 UDID、地址校验、只关自己启动的、画面上限与临时文件、停止只结束进程、工作目录是 `/`；Agent 只开本机地址（「始终允许」之后也一样）、不开深链接，只为数据范围「全部」的设备发起的一轮 | `apps/host/test/simulators.test.ts` |
| 路由：只有 `host.sock` 上 `run` 加 `all` 的设备、功能开关、先审计、Device Hub；内置 Harness 的工具 | `apps/host/test/simulators.test.ts` |
| 「Xcode」：检查、添加、工具开关、分级；假 ACP Agent 经桥调用替身 `xcrun`：Latch 的指引、分级与设备 UDID 进审计、关掉的工具被拒 | `apps/host/test/mcp-xcode.test.ts` |
| 桥：Latch 的指引在前、只交出设备 UDID | `packages/harness-acp/test/mcp-bridge.test.ts` |
| 面板模型与「+」 | `apps/web/test/device-panel.test.ts` |
| 真实 Electron 与真实 simctl（只用名字以 `latch-` 开头的设备，没有 Xcode 时跳过） | `e2e/desktop-device.e2e.ts` |

这些用例不证明 Xcode 的设备交互真的能用：2026-11-17 在 Xcode 设置允许外部 Agent、打开一个临时示例工程后，桥从 Xcode 之外回答了 `initialize` 与 `tools/list`（54 个工具），但第一次 `DeviceInteractionStartSession` 回答「This agent isn't approved to use Xcode's tools yet. Call XcodeOpenWorkspace or XcodeNewProject first」——批准要由人在 Xcode 弹出的提示里做，还没有做，所以点按、输入与截图都没有真实验证。
