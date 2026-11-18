---
description: 设备预览：右栏「设备」面板的实时画面（latch-simulator，H.264 或 JPEG 经二进制流）与输入（人自己装的 idb_companion，只经 Unix 套接字）：点按、拖动、滚动、按键、Home 与锁屏；经 xcrun simctl 与 devicectl 列出、新建、启动、关机、截图与标注、录屏、旋转、缩放、App 与权限、日志、打开地址与切换外观，快捷键，闲置自动关机；在 Device Hub 中打开；Agent 的 device_* 工具（含点按与按键）与指引；设置 › MCP 的「Xcode」预设（xcrun mcpbridge）的工具开关、分级、审计与「Agent 正在使用」；限制与尚未实现的部分。
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
  - packages/protocol/src/simulators.ts
  - apps/host/test/simulators.test.ts
  - apps/host/test/simulators-public.test.ts
  - apps/host/test/mcp-xcode.test.ts
  - apps/web/test/device-panel.test.ts
  - e2e/desktop-device.e2e.ts
  - native/macos/LatchSimulator.swift
  - apps/host/src/simulator-helper.ts
  - apps/host/scripts/build-simulator.ts
  - apps/host/test/simulator-helper.test.ts
  - apps/host/src/simulator-live.ts
  - apps/host/src/simulator-control.ts
  - apps/host/src/simulator-idb.ts
  - apps/host/src/simulator-idb-wire.ts
  - apps/host/test/simulator-live.test.ts
  - apps/host/test/simulator-input.test.ts
  - apps/web/test/device-live.test.ts
  - packages/testkit/src/fake-simulator.ts
---
# 设备预览

右栏「+」里的「设备」（字母键 V）显示这台 Mac 上一台 iOS 模拟器的实时画面，人在画面上点按、拖动、滚动、按键，按 Home 与锁屏；并提供新建、启动、关机、缩放、旋转、截图与标注、录屏、App 与权限、日志、打开地址、外观与「在 Device Hub 中打开」。管理用 Apple 公开的 `xcrun simctl`、`xcrun devicectl` 与 `open`；画面来自 Latch 自己的组件 `latch-simulator`，它是唯一加载私有框架的部分（见[实时画面组件](#实时画面组件)）；输入经人自己安装的 `idb_companion`（见[实时画面与输入](#实时画面与输入)）。不下载，不加依赖，不要新的系统权限。

| 部分 | 位置 |
| --- | --- |
| simctl 与 devicectl 模块：固定参数、校验、上限、只关自己启动的 | `apps/host/src/simulators.ts` |
| 共用的取值与上限（权限服务、录屏与日志上限、名字与 bundle id 的格式） | `packages/protocol/src/simulators.ts` |
| 路由与功能开关 | `apps/host/src/routes/simulators.ts` |
| 实时画面：每台设备一个组件、共享与背压 | `apps/host/src/simulator-live.ts` |
| 输入：`idb_companion` 的监管、HTTP/2 与手写的消息编码、人与 Agent 共用的路径 | `apps/host/src/simulator-control.ts`、`simulator-idb.ts`、`simulator-idb-wire.ts` |
| Agent 的 `device_*` 工具 | `apps/host/src/plugins/tools/device/` |
| 「Xcode」预设 | `apps/host/src/mcp-xcode.ts` |
| 面板 | `apps/web/src/panel/device/` |

## 谁能用

- **只在这台 Mac 打开面板。** 画面与输入路由只收 `host.sock`（`isLocalListener`），设备要有 `run` 且数据范围是 `all`。手机、浏览器与其他电脑没有入口，请求面板路由会收到 403。Agent 的设备工具按发起这一轮的设备及 Harness 检查权限，截图进入会话。见[工具规则](#latch-自己的工具不需要-xcode-的设置)。
- 面板和 Agent 的设备工具都能操作 Mac 上任意已启动的可用模拟器。名字以 `latch-` 开头的设备只是 Latch 自己的测试与验收所建，不是限制。
- **只在 Host 能运行 simctl 时。** 启动脚本在 macOS 上传入真实的 `xcrun simctl`；测试不传时整个功能不存在、从不运行 simctl。
- Host 第一次列出设备后知道有没有 Xcode：有 Xcode 而一台模拟器都没有时入口消失；没有 Xcode 时面板里只有一行「未安装 Xcode」。
- 这些动作不是本机确认的动作（`PRESENCE_ACTIONS`），同终端一样，完全访问的会话运行时不额外拒绝。

## Host

`Simulators` 只运行 `/usr/bin/xcrun simctl`、`/usr/bin/xcrun devicectl` 与 `/usr/bin/open`，参数是固定数组（`execFile` 或 `spawn`，不经 shell，没有输入），工作目录固定为 `/`（按相对名字写的文件不会落进任何人的文件夹），环境只有 `PATH`、`HOME`、`TMPDIR`、`DEVELOPER_DIR`、`USER`、`LOGNAME`（所以没有 `SIMCTL_CHILD_*` 能带进设备）。三个测试接缝：跑完即返回的 `run` 与 `devicectl`、一直运行到被叫停的 `spawn`：

| 动作 | simctl | 超时 |
| --- | --- | --- |
| 列表 | `list devices --json available`（输出 ≤ 4 MiB，最多 200 台） | 20 s |
| 启动 | `boot <UDID>`，再 `bootstatus <UDID>` 等它真正起来 | 各 120 s |
| 关机 | `shutdown <UDID>` | 60 s |
| 画面 | `io <UDID> screenshot --type=jpeg|png <私有临时文件>` | 20 s |
| 打开地址 | `openurl <UDID> <地址>` | 20 s |
| 外观 | `ui <UDID> appearance [light|dark]` | 20 s |
| Device Hub | `open -a <xcode-select 的 Xcode>/Contents/Applications/DeviceHub.app devices://device/open?id=<UDID>` | 20 s |
| 方向 | `devicectl device orientation get --device <UDID> -t 20 -j -` | 25 s |
| 旋转 | 先读方向，再 `devicectl device orientation rotate --device <UDID> left|right -t 20 -j -` | 各 25 s |
| App 列表 | `listapps <UDID>`（≤ 4 MiB，最多 500 个，隐藏的不列） | 20 s |
| 启动、结束 App | `launch <UDID> <bundle id>`、`terminate <UDID> <bundle id>` | 20 s |
| 权限 | `privacy <UDID> grant|revoke|reset <服务> <bundle id>` | 20 s |
| 新建的取值 | `list devicetypes --json`、`list runtimes --json`（各 ≤ 1 MiB、最多 300 条） | 各 20 s |
| 新建 | `create <名字> <设备类型 ID> <系统 ID>` | 60 s |
| 录屏 | `io <UDID> recordVideo --codec=h264 --force <私有临时文件>`，SIGINT 结束 | ≤ 60 s（Host 不在时 90 s） |
| 日志 | `spawn <UDID> log stream --style compact [--predicate 'process == "<进程名>"']`，SIGINT 结束 | 面板开着时 |

两种长期运行的进程都经一个固定的 `/bin/sh -c` 脚本启动（`CHILD_WATCHER`，脚本不含任何输入，参数只作 `$1`…）：它先起一个看守，再 `exec` 成 `xcrun simctl`，所以进程号、信号与退出码都是 simctl 的，看守也不占它的管道。看守每秒检查一次，Host 进程没了（被杀、崩溃）或到了时限（录屏 90 秒，日志不限时）就给 simctl 发 SIGINT 并退出。它从不发 SIGKILL，原因见下面两条。2026-11-17 在 Xcode 27.2 的 `latch-` 设备上实测：父进程被 `kill -9` 后，录屏在 5 秒内正常写完并退出，录屏器随后可以再用；没有输出的日志流在设备里也结束了。

- **SIGINT，不 SIGKILL。** 同一次实测：
  - SIGKILL `simctl io … recordVideo` 后，设备的录屏器一直报「A recording is already in progress」，直到设备重启。
  - SIGKILL `simctl spawn … log stream` 后，设备里的 `log` 进程（`launchd_sim` 的子进程）还在：输出多的会在下一次写坏管道时退出，带过滤、没有输出的会一直留到设备关机。
  - SIGINT 两者都正常结束。所以 Host 总是先发 SIGINT，只有子进程 10 秒不理时才 SIGKILL，作最后手段。

- **UDID** 必须是大写 UUID，并且出现在最新的列表里；`booted`、`all` 与选项一律拒绝。
- **地址** ≤ 2048 字符、有协议、没有空白与控制字符；`file:`、`javascript:`、`data:`、`blob:`、`about:`、`vbscript:` 拒绝。深链接（`myapp://…`）可以。
- **bundle id** 先过格式（字母数字开头、点分、不像选项，≤ 155），再必须出现在这台设备最新的 `listapps` 里；`launch` 只带 bundle id，没有参数、`--console` 或输出文件。**权限服务**是固定的 12 个（`all` 不在其中），每次只对一个列出的 App。
- **新名字** 去掉首尾空白后只能是字母、数字、空格与 `. _ ( ) ' -`，字母或数字开头，≤ 64 字符；**设备类型与系统** 必须是 `com.apple.CoreSimulator.…` 形式、出现在刚读的列表里、系统可用且支持这种设备。新设备不启动。
- **日志过滤** 只按列出的 App 的 `CFBundleExecutable`，进程名只能是字母数字与空格 `. _ + -`（没有引号与反斜杠），否则拒绝；谓词由 Host 按固定模板拼出。
- **App 列表** 是旧式属性列表，Host 自己解析（嵌套 ≤ 8），不另运行 `plutil`。
- **只关自己启动的。** Host 记住自己从关机状态启动成功的设备，并记下启动后列表里它的 `lastUsedAt`。实测在 Xcode 27.2 上，这个字段在第一次启动前没有，运行期间不变，每次启动都换新。列表里看到它已关机（人在别处关的），或 `lastUsedAt` 变了（两次列表之间人自己关机又启动），就不再算 Latch 的。列表里没有这个字段时，Host 分不出来：仍提供人自己点的「关机」，但闲置和 Host 停止时都不自动关它。这个字段只在一台设备、一个 Xcode 版本上核对过。已经在运行的设备启动时原样保留，仍是人的。
- **闲置自动关机。** Latch 启动的设备，10 分钟没有取帧、面板动作或 Agent 调用，也没有录屏、日志或 Agent 的 Xcode 设备会话，Host 先重新列出确认它仍在运行，并且仍是这次启动（`lastUsedAt` 没变），再关掉它（每分钟查一次）。「在 Device Hub 中打开」算一次使用。人在 Device Hub 里用了 10 分钟以上、其间面板关着，Latch 看不到，仍会关掉它。
- **Host 停止时：**
  - 结束在途的 simctl 进程，关闭日志；
  - 给录屏发 SIGINT 并立即删除目录，不等它写完；
  - 重新列出一次，关掉仍是自己那次启动的设备（不经 `simctl()`）。
  
  以上都在同一个 2.5 秒里。已经发出的关机自己关完；列表本身超过 2.5 秒时（机器很忙），这次一台都不关，设备留着运行，下次由人或新的 Host 处理。人启动的设备一律不碰。闲置和停止两种情况都记 `auto-shutdown`（`idle` 或 `host-stop`），写不进审计也照常关：这只结束东西。
- **Host 启动时** 删除临时文件夹里崩溃的 Host 留下的 `latch-rec-xxxxxx`、`latch-sim-xxxxxx` 目录。只删名字完全符合、属于本用户、不是符号链接、里面 10 分钟没有任何变化的；正在录屏的其他 Host（另一个数据目录、测试）的目录不受影响。
- 同一台设备同一时间一个启动、关机、旋转或修改；同一台设备同一种画面同时只取一次，后来的请求共用结果；跑完即返回的进程全部设备同时最多 4 个。长期运行的另算：录屏每台一个、全部两个（在第一次等待之前占位，同时开始的也不会超出）；日志每台两条、全部四条。日志在启动前，录屏在建目录后，都再查一次 Host 是否已开始停止，已停止就不启动。
- **画面。** Xcode 27.2 的 simctl 不肯写到标准输出（`-` 被当成文件名，`/dev/stdout` 被拒绝），所以每张画面写进 `mkdtemp` 新建的 0700 目录，读出（≤ 5 MiB，超出 413）后立即删除目录。画面不进日志、审计、SSE 或数据目录。
- **旋转。** 2026-11-17 在 Xcode 27.2、iOS 27.2 的 `latch-` 设备上验证：`devicectl` 认得 simctl 列出的模拟器（按 UDID），但只在设备运行时；关机时回答「The capability “Device Orientation” is not supported by this device」，刚启动完也可能这样回答一阵。所以面板每次都重新问（`orientation`），不把「不能」记下来，最多再问 5 次；不能时按钮不可用。转之前与之后各读一次 `deviceOrientationNonFlat`（`deviceOrientation` 在新设备上读作 `unknown`），没有变就回答 502「设备没有转动」，从不在没转时报成功。方向是设备的物理方向：前台 App 支持横屏时画面随之转动（在探测时取到过 2622×1206 的横向截图）；iPhone 的主屏幕不转，读回已是 `landscapeRight` 时面板里仍是竖着的主屏幕。
- **录屏。** 写进 `mkdtemp` 新建的 0700 目录里的 `recording.mp4`，等 simctl 在标准错误说「Recording started」才算开始（20 秒没说就失败并删除目录）。最长 60 秒或 25 MB（草稿的文件附件上限；每秒查一次大小，离上限 1 MB 时停止），到了就自己结束并等 60 秒让面板取走。面板停止取帧 20 秒（关掉、隐藏、换设备、页面没了）、Latch 关掉这台设备、设备在别处关掉、Host 停止时都丢弃并删除目录。同一台设备的多个窗口共享这段录屏，任一窗口在取帧都算面板还在。只有开始录屏的那台设备（人的窗口）能看、取、丢弃它。取走时读出（≤ 25 MB）并立即删除目录，作为 `video/mp4` 回答这一个请求，页面把它作为下载交给人。录屏不进日志、审计、SSE 或数据目录。
- **日志。** 每行去掉控制与双向字符，≤ 1000 字符，开头几行（`Filtering the log data`、表头）去掉；每 200 ms 一批经面板自己的 `text/event-stream` 回答发出。页面读得慢（回答里积压超过 1 MB 未读）时这些行直接丢掉并计数（`dropped`），不在 Host 缓存。每批行与每 15 秒复查设备的范围与凭据，不再允许就结束。页面在流建立期间（读设备、写审计、读 App 列表）就关了，`log` 不会启动；已启动的立即结束。日志行可能有个人数据：不进 Host 日志、审计、主事件流或磁盘。
- Host 将 simctl 标准错误中第一行有意义的话转为短错误，去掉控制与双向字符，≤ 200 字符。面板的悬停按稳定错误码显示原因，启动失败有单独说明。

### 路由

| 路由 | 作用 |
| --- | --- |
| `GET /simulators` | `{ xcode, devices: [{ udid, name, os, state, ours, shown?, agent? }], agentUnnamed?, abilities: { rotate, record, logs } }` |
| `POST /simulators` | `{ name, deviceType, runtime }` → `{ udid }`（新建） |
| `GET /simulators/catalog` | `{ deviceTypes: [{ id, name, family }], runtimes: [{ id, name, deviceTypes }] }`，读一次留一分钟 |
| `GET /simulators/:udid/frame` | JPEG，`cache-control: no-store`；标记「面板正在显示这台」15 秒 |
| `GET /simulators/:udid/appearance` | `{ appearance: 'light' | 'dark' | null }` |
| `GET /simulators/:udid/orientation` | `{ supported, orientation }` |
| `GET /simulators/:udid/apps` | `{ apps: [{ bundleId, name, kind: 'user' | 'system' }] }`（进程名不给页面） |
| `GET /simulators/:udid/record` | `{ state: 'none' | 'recording' | 'ready', seconds?, ended?: 'time' | 'size' }`，只对开始它的设备 |
| `GET /simulators/:udid/logs[?app=<bundle id>]` | `text/event-stream`：`lines`、`dropped`、`closed`（`SimulatorLogEvents`）；先写审计 |
| `POST …/boot`、`…/shutdown`、`…/screenshot`（PNG）、`…/open-url`、`…/appearance`、`…/device-hub`、`…/rotate`、`…/launch`、`…/terminate`、`…/privacy` | 先写审计，再执行 |
| `POST …/record` | `{ action: 'start' }` 先写审计；`'stop'` 回答 `video/mp4`；`'discard'` |
| `GET …/stream?codec=h264\|jpeg&fps=1～60&size=160～4096` | `application/octet-stream` 的实时画面（`SIMULATOR_STREAM`）；参数各只一次，多余的拒绝；只给运行中的设备 |
| `POST …/keyframe` | `{}`：页面的解码器要一个关键帧（静止画面上冲刷过、或落后了），让组件为这台设备的所有面板出一个；不写审计（是看） |
| `POST …/control` | `{ action: 'take' }`：第一次先写审计 `control`，再启动并探测 `idb_companion`，回答各类输入能否用（`SimulatorControlView`）；`'release'` |
| `POST …/input` | `{ events: [...] }`，1～64 个，按顺序写入 `touch`、`key`、`button`、`text`。已接管的本机设备可调用。回执含 `written` 与最后写入的触摸在本批中的 `touchIndex` |

请求体都经 zod 的 strict schema；名字、bundle id、服务、方向、类型与系统 ID 在任何进程启动之前校验。

### 审计

- `simulator.action`：人的动作（启动、关机、截图、打开地址、外观、Device Hub、旋转、录屏开始、新建、启动与结束 App、权限、打开日志），记 UDID、动作与枚举（外观、方向、权限的操作与服务、日志是否按 App 过滤）；打开地址只记协议与源的 SHA-256，App 只记 bundle id 的 SHA-256（它可能带着人的项目名），新建只记设备类型与系统的 ID、不记人填的名字。写不进就不执行。Host 自己的关机记 `auto-shutdown` 与 `reason`。
- `simulator.call`：Agent 的 `device_*` 调用，记会话、工具、UDID、分级、方向、bundle id 的 SHA-256、运行时的工具调用 ID，经网关时 `via: 'mcp'`。输入参数只记录点数（点按 1、滑动 2）和字数。
- 人的点按、拖动与按键不逐条记：人第一次接管一台设备时记一次 `control`（UDID）。
- 面板的刷新帧与实时画面是看，不是动作，不记；画面、录屏与日志行从不进审计。

## 实时画面与输入

**画面。** `SimulatorLive` 在 `Simulators` 旁边：每台设备最多一个 `latch-simulator`，看它的面板（每台最多两个，全部最多四台）共用，最后一个面板走了、设备关机或 Host 停止时结束；结束时先让 `frames()` 的生成器 `return()`，再 `close()` 组件。

- **流。** `GET …/stream` 回答 `application/octet-stream`，自己分帧：13 字节的头（类型、自开始的微秒、载荷长度，都是大端）和载荷。类型：流描述（JSON，编码、`avc1.xxxxxx` 与 avcC、编码尺寸、点数、方向）、H.264 关键帧与非关键帧（AVCC）、JPEG、结束（`device`、`host`、`closed`、`failed`）、输入归属（`0x06`，载荷一个字节，按 `SIMULATOR_INPUT_OWNERS` 解码）。第二个面板要同样的设置才共用，不同就 409，不悄悄改别人的。
- **背压到底。** 路由每写完一条、等套接字 `drain` 后才取下一条；每个面板自己的队列最多 4 帧、8 MiB，满了就清掉，H.264 等下一个关键帧（每台设备同时只要一次），JPEG 直接接着画。组件那边的包装另有上限（见下）。停住不读的页面不让 Host 涨内存。
- 开着的流在每条消息前以及每 5 秒复查设备范围与凭据。设备撤销或范围变化后，Host 会立即复查正在播放的流。不再允许时断开响应，丢弃尚未写出的帧并结束等待 `drain` 的写入。权限有效时每 5 秒把模拟器标成「面板正在显示」并算使用。帧只进这个回答，不进日志、审计、主事件流或磁盘。
- **输入归属。** 每个授权面板收到自己的投影。Agent 持有输入流时显示「Agent」，它让出后按实际租约显示「你」「本机」或「空闲」。静止画面也更新。慢读时只保留最新的待发归属。截图模式从同样经本机授权的设备列表读归属。消息只有枚举；会话标识、输入坐标和文字不进入归属消息。
- **页面。** 有 WebCodecs 的 `VideoDecoder` 时要 H.264（30 帧、最长边 1280），用 `isConfigSupported` 核对后解码，画到画布上；没有或解码失败就重连要 JPEG（20 帧、最长边 960），用 `createImageBitmap` 画，正在解的没完就跳过新的一张；流回答不可用（组件不在、这个 Xcode 不支持）时退回原来的截图轮询。桌面端页面经 `latch://` 打开（安全上下文），Electron e2e 里核对过 `VideoDecoder` 存在、能解出录下的 H.264；CSP 不用改（画布不需要 `img-src` 以外的来源）。
- **静止的画面。** 组件在画面不变时只补一帧，而 `VideoDecoder` 会留着最后一帧等后面的数据；所以 150 ms 没有新数据时页面冲刷解码器，把最后一帧画出来。冲刷后解码器要从关键帧开始，页面再收到非关键帧时经 `POST …/keyframe` 要一个（每秒最多一次）。2026-11-17 在真实设备上看到：不冲刷时静止的页面一帧都画不出。
- **方向。** 组件的帧总是屏幕本身的竖向帧缓冲，内容随界面转。2026-11-17 在 iOS 27.2 上看到：方向 3 时内容的顶边在帧缓冲的左边，4 时在右边；回到主屏幕（iPhone 主屏幕不转）就回到 1。页面按它把画布转正。

**输入。** `SimulatorControl` 使用用户通过 Homebrew 安装的 `idb_companion`（MIT）。安装命令为 `brew install meta/fb/idb-companion`。如果 Homebrew 要求信任此 tap，先执行 `brew tap meta/fb` 和 `brew trust meta/fb`。Latch 只从 `/opt/homebrew/bin` 和 `/usr/local/bin` 查找，真实路径必须在同一个 Homebrew 的 `Cellar` 下。旧 `facebook/fb` 安装仍按这个路径识别。找不到时显示「输入不可用」，悬停给出安装指引。[官方 idb-companion 公式](https://github.com/meta/homebrew-fb/blob/main/idb-companion.rb)

- **只有 Unix 套接字，从不 TCP。** `--grpc-port` 会无认证地监听所有网卡（实测 `TCP *:10899`），所以从不使用。每个伴随进程在 `mkdtemp` 新建的 0700 目录（`latch-idb-xxxxxx`）里以它为工作目录启动，套接字名是相对的 `c.sock`；绝对路径超过 103 字节时报「不可用」（Host 自己连接时也受这个限制）。参数固定：`--udid <列出的 UDID> --grpc-domain-sock c.sock --only simulator --terminate-offline true --idle-shutdown-time 120 --log-level info --log-hid-details false`；环境只有 `PATH`、`HOME`、`DEVELOPER_DIR`、`USER`、`LOGNAME`（不带 `FBSIMULATORCONTROL_*`，那会把坐标写进它的日志）；标准输入关闭，标准错误丢掉。Host 读取标准输出开头 4 KiB 中各自占一行的 JSON 就绪报告。收到 `{"grpc_path":"c.sock"}` 才连接。遇到 `grpc_port` 或 `grpc_swift_port` 字段时立即 SIGKILL 并报不可用。**同一用户的任何进程**在伴随进程活着时都能连上这个套接字、直接发 HID，不经 Latch 的工具门与审计：应用层的检查不是 OS 沙箱；这样的进程本来也能自己运行 `idb_companion` 或 `simctl`。
- **结束。** 人放手（`release`）且没有 Agent 在用、设备关机、Host 停止时 SIGTERM（它自己删掉套接字和 `$TMPDIR/IDB/<uuid>`），2 秒不退就 SIGKILL，再删目录；没人持有、Agent 一分钟没用的也结束。Host 崩溃时连接随进程断开，伴随进程 120 秒没有请求就自己退出（实测：开着的 `hid` 流算活动，断开后 5 秒的设置 5 秒后退出），设备关机时也退出。Host 启动时删除崩溃留下的 `latch-idb-xxxxxx`：只删本用户的、名字完全符合、不是链接、里面的套接字已经连不上的；另一个 Host 正在用的不动。
- **线上的格式。** Host 用 `node:http2` 连这个套接字，自己编码需要的几条消息（`idb.CompanionService/hid` 的 `HIDEvent`：触摸按下与抬起到一个点、按钮、键码；`describe` 的空请求），字段号取自 idb 公开的 proto，并逐字节对过 idb 客户端发给真实伴随进程的消息（`apps/host/test/fixtures/idb-companion.json`）。没有 gRPC 或 protobuf 的库。 伴随进程的回答有界：`hid` 流最多一条消息、`describe` 一条，全部不超过 256 KiB；超出就取消这次调用并报错，坏掉或伪装的程序只让这次输入失败，不让 Host 涨内存。`describe` 10 秒不回答就是 `no-answer`。
- **探测与能力。** 人第一次在画面上按下、按 Home 或锁屏、或把按键发到设备时接管。Host 先写审计，启动伴随进程，用 `describe` 核对回答并读取以点计的屏幕尺寸。真正写入输入时开长连的 `hid` 流。回答按类给出触摸、按键、按钮、文字的可用性及原因（`idb-missing`、`companion-failed`、`no-answer`、`socket-path`）；两指不可用（`single-touch`）。不可用时面板写「输入不可用」，原因与安装命令在悬停里。本机的几台设备（`run` 加 `all`）可以同时接管同一台模拟器，各记一次审计；它们共用一条流、一个手指状态与一个限速，后按下的会移动先按着的手指。
- **接管还在等待时。** Host 按发起设备跟踪接管。撤权或放手使该设备此前发出的接管失效，其他已授权的设备或 Agent 可以继续共用启动。最后一个消费者离开时，取消未完成的就绪或 `describe` 等待，等伴随进程退出并清理目录。Host 停止时也等这段清理结束。
- **人的输入。** 页面按动画帧合并指针移动，按顺序一次发一个 `POST …/input`。Host 复查权限后把事件写进 `hid` 流。坐标是屏幕内的设备点，每台设备每秒最多 240 个事件，可攒 480 个，超出返回 429。回执的 `written` 是写入伴随进程流的事件数，设备侧的确认在流结束时才到。收到 `touchIndex` 后，页面用自己刚发的坐标在当前画面短暂显示落点。空写或失败时没有落点反馈。失去权限或释放租约时，立即抬起该窗口最后写入且仍按着的手指。
- **放手与超时。** 关掉窗口时页面来不及放手，所以一台设备两分钟没有输入就当作放手；按下的手指 10 秒没有新事件就抬起，丢掉的抬起不会一直占着设备。一条 `hid` 流 5 秒内没有回答状态就取消并当作没送到。
- **转向。** 设备一转，`idb_companion` 就结束开着的 `hid` 流（日志：「Simulator display changed during the operation」），却不告诉客户端，之后写进去的事件都丢了。所以 Host 在画面的方向或尺寸变了、或经面板与 Agent 旋转之后丢掉人的那条流，下一个输入开新的。2026-11-17 在真实设备上用 Electron 验证：转到横向后点按仍落在页面上对的地方。
- **人与 Agent 共用，人总是优先。** 同一台设备按手势串行。人一按下，Host 会取消 Agent 正在用的流，包括等待伴随进程答复的阶段。等本地 HTTP/2 流关闭后把控制权交给人，那次 Agent 调用回答 `simulator-input-failed`。人的等待排在所有等着的 Agent 前面。Agent 等人的手指抬起，最多等 10 秒（`simulator-busy`）。伴随进程一次只接一条 `hid` 流，所以 Agent 的手势先结束人的流。取消这一轮也会结束 Agent 的流。
- **Agent 的输入**每次开一条短的 `hid` 流，写完结束，伴随进程回答状态 0 才算成功，否则 `simulator-input-failed`。
- **文字：只在 English (US) 键盘上逐键输入可打印的 ASCII。** 不粘贴：2026-11-17 在 iOS 27.2 上，经 idb 送的 ⌘V 触发了粘贴，但从设备外（`simctl pbcopy`）写进的内容到了 App 里是空的。逐键输入在拼音键盘上会被组字吞掉空格（实测 `ab c` 成了 `abc`），在别的布局上同一个键是别的字符；所以每次输入前读设备当前的键盘：`simctl spawn <UDID> defaults read com.apple.keyboard.preferences KeyboardLastUsed`。实测（`latch-text-check`）：它随人切换键盘立即变（`en_US@sw=QWERTY;hw=Automatic` 与 `zh_Hans-Pinyin@sw=Pinyin-Simplified;hw=Automatic` 来回）；设备还没用过键盘时没有这个值。只有它是 `en_US@sw=QWERTY`（硬件布局自动或 US）时才逐键输入，`Hello World 1@#, ok.` 原样到了页面；拼音时整段拒绝并说出当前键盘，有非 ASCII 字符时整段拒绝，读不到键盘时拒绝并请人先点一下输入框——从不输入一半，也不悄悄丢字。Agent 每次重新读；人的打字一秒内复用上一次的读数。经 idb 的 accessibility 描述也能看到键盘，但「下一个键盘」按钮的值是下一个、不是当前的，所以不用它。设备自己的自动更正与首字母大写照常起作用，Agent 应截图核对。
- **按钮**：Home、锁屏、侧键、Siri（Apple Pay 在这条通道上 idb 回答未实现，不提供）。**旋转**仍走公开的 `devicectl`。**两指与捏合不可用**：idb 的触摸只带一个点、没有手指编号。

**实测**（2026-11-17，Xcode 27.2、iOS 27.2，`latch-live-check`（iPhone 17 Pro）上自己建的设备，经测试 Host 与真实路由，设备里 Safari 打开 127.0.0.1 的测试页由页面回报事件，这台 Mac 负载 15～87）：
- 接管：触摸、按键、按钮可用，两指 `single-touch`；`lsof -nP -iTCP -sTCP:LISTEN` 里没有 idb。（文字当时不可用；后来按键盘检测开放，见上。）
- 点按：10 次，从发出 `POST …/input` 到页面的 `touchstart` 中位 15 ms（3～861 ms，最慢的是第一次，含打开 `hid` 流），点在页面 (201, 98)，即屏幕 (201, 160) 减去 62 点的状态栏。
- 拖动：一次 `touchstart`、19 次 `touchmove`（20 个请求、每个两点）、一次 `touchend`，页面跟着滚动。
- 按键：先点输入框，⌫ 与 ⏎ 到达页面（`Backspace`、`Enter`）。Home：页面变为隐藏，画面随之换成主屏幕。
- 画面（测试页上有持续转动的方块）：H.264 最长边 1280，首帧 0.7 s，约 34 帧/秒、约 50 KB/s；JPEG 最长边 960，首帧 1.4 s，约 26 帧/秒、约 685 KB/s。按到达时间算的帧率比所求的上限略高；按流里的时间戳算，H.264 在 30 帧的上限下是 29.8 帧/秒（147 帧、4.9 s，相邻两帧最短 30.6 ms），上限是守住的，多出来的是到达的抖动。
- 人接管着设备、手指按着、画面开着时设备关机（`simctl shutdown`）：伴随进程自己退出（`--terminate-offline`），画面以 `device` 结束，之后的输入回答 409，组件也不在了。
- 人的长连流开着时，Agent 的短流被伴随进程拒绝（回答非 0）；所以 Agent 的手势先结束人的流，人下一次输入再开新的。这样人点、Agent 点（约 200 ms，含等状态）、人再点，三次都到了页面。
- Host 停止后：没有 `idb_companion`、`latch-simulator`，临时文件夹里没有 `latch-idb-`、`latch-sim-`、`latch-rec-` 目录。审计只有打开地址与一次 `control`。

## 面板

排成设备窗格的样子，说明都在悬停里，面板里不写句子：

- **顶栏：** 设备选择（名字 · 系统版本，运行中的带绿点；菜单末尾「新建设备…」），紧跟一个状态词：未启动、启动中、运行中、关机中、录屏 0:07、Agent 正在使用、失败（原因在悬停里）。右边是缩放（缩小、「适应」或百分比、放大）与启动或关机。关机只对 Latch 启动的设备可用，其他运行中的设备悬停写「只关闭 Latch 启动的设备」。设备在运行但还没有第一帧画面时仍写「启动中」；Host 的启动在 `simctl bootstatus` 报告系统起来之后才返回。
- **中间：** 运行中的设备画面（实时画面的画布，没有实时画面时是截图）放在凹陷底色上，一圈细边。在实时画面上：按一下是点按，按住是长按，拖动是实时拖动（离开画面时贴着屏幕边），滚轮是一次短的拖动（滚轮停 150 ms 后抬起）；指针按缩放、转向与留边换算成设备点。其他时候是设备列表，选中的一行末尾有「启动」，按钮位置始终保留，不跳动。
- **状态词**另有「输入不可用」（琥珀色，原因与安装命令在悬停里）与「文字未输入」（琥珀色，悬停里是原因，如设备当前的键盘）；「运行中」的悬停说是实时画面还是截图画面，以及两指不可用。
- **缩放：** 「适应」按面板缩小（不超过 1:1）；点数值在适应与 1:1 之间切换；1:1 是一个设备像素对一个屏幕像素（按 `devicePixelRatio`）；放大缩小按 25%～200% 的档位，比适应还小就回到适应。放大后画面在面板里滚动。每台设备的缩放记在这个浏览器里（`latch.device-zoom.<UDID>`），读写失败就只对这次有效。
- **底栏：** 向左旋转、向右旋转（各 90°，Host 有 devicectl 时才有；这台设备不能转时不可用）、截图、录屏、主屏幕、锁屏、键盘输入到设备、标注截图 | App、日志、打开地址、外观 | 「在 Device Hub 中打开」（悬停：在 Device Hub 里查看和点按）。键盘开关打开时，焦点在设备面板里、不在 Latch 的输入框里，⏎ ⌫ ⇥ ⎋ 与方向键发到设备，可打印的 ASCII 字符作为文字发到设备（只在设备的 English (US) 键盘上输入，否则「文字未输入」并说明）；重音字母、中文与输入法组字不发，并写「文字未输入」。录屏与日志只在 Host 能运行长期的 simctl 子进程时出现（启动脚本给了），和以前一样。面板隐藏、换设备或设备停止时放手（`release`），键盘开关也关掉。窄面板里底栏换行。
- **新建设备：** 对话框里填名字，选系统与设备类型（iPhone、iPad、其他分组）；新设备出现在列表里并被选中，不启动。
- **App：** 画面下面的窗格，列出设备上不隐藏的 App（人的在前，标「你的」，bundle id 在悬停里），每个有启动、结束和一个盾牌：对窗格顶上选的那一项权限「允许、拒绝、重置」。预先授权解决不了已经弹出的系统对话框。
- **日志：** 同一位置的窗格：顶上选「全部进程」或一个 App，状态词（实时、已结束、失败），读得慢时写「少 N 行」；暂停（新行先留着）、清空、关闭。只留最新的 1000 行，只在这里显示，不保存；关闭窗格、换设备或隐藏面板就结束流。
- **标注：** 先取一张 PNG 截图，画面换成画布：箭头、方框、画笔三种，一种强调色（`--accent`），撤销（⌘Z）、取消（Esc）、「放进草稿」。笔迹按截图自己的像素记，所以缩放不影响结果；放进草稿时编码成 PNG，超过 5 MB 改用 JPEG，仍超就报错。草稿不收附件时按钮不可用。
- **快捷键：** 焦点在面板里时 ⌘S 截图、⇧⌘R 录屏或停止、⌘← 和 ⌘→ 旋转；焦点在输入框、选择框或可编辑区域、或带别的修饰键时不响应，按钮悬停里写着快捷键。
  - 录屏不用 ⌘R，因为桌面端菜单的「重新载入」（`role: 'reload'`）占着它。
  - 新键对照过 `apps/desktop/src/menu.cjs`（包括各 `role` 自带的快捷键）和 `workbenchShortcuts.ts`，都没有占用。
  - 只在桌面端绑定：面板本来只在桌面端（`host.sock`）出现，普通浏览器的页面没有面板，不会抢浏览器自己的 ⌘S。
  - Electron e2e 用 Playwright 合成的按键验证过（合成按键不经过系统菜单）。
- **刷新。** 先连实时画面；它不可用时才取截图：只在面板显示、设备运行时，上一帧到了，再等 250 ms 取下一帧；隐藏即停止并中止在途请求。取帧失败时间隔翻倍，最长 8 s；连续两次失败后底部写「失败」，原因在悬停里。实测见下。
- **截图**把 PNG 作为图片附件放进草稿，不发送；发送后按附件规则交给模型服务。草稿不收附件时改为下载到这台电脑。
- **录屏**停止后把 MP4 下载到这台电脑（桌面端弹出保存位置），不放进草稿：多数模型服务不收视频，草稿也按会话的模型限制附件（演示模型只收小文本，1 MB 的录屏会被拒）。关掉面板、换设备或设备停止时丢弃。

**实测的截图刷新**（实时画面不可用时；Xcode 27.2、iOS 27.2，这台 Mac 负载 12～36 时，Electron e2e 量的是面板一帧的往返）：每帧 1.3～2.3 s，主要是 simctl 进程启动与截图；首屏 JPEG 约 60 KB。加上 250 ms 的间隔，约每秒 0.4～0.6 帧。这是准实时的缩略画面，不是视频；负载低时单次 simctl 截图约 0.5 s。

**Device Hub。** Xcode 27 用 Device Hub（`com.apple.dt.Devices`）取代了 Simulator.app。「在 Device Hub 中打开」把那台设备自己的窗口调出来。Latch 显示「输入不可用」或设备的键盘无法接收这段文字时，可在那个窗口操作。退出 Device Hub 时选「Quit Device Hub」会关掉它运行的模拟器，「Quit and Keep Simulators Running」不会。

## Agent

### Latch 自己的工具（不需要 Xcode 的设置）

内置 Harness 与外部 Harness（经 `latch-browser` MCP 服务与工具网关，与浏览器工具同一个令牌与规则）都有：

| 工具 | 级别 | 作用 |
| --- | --- | --- |
| `device_list` | R0 | UDID、名字、系统、状态，标出面板正在显示的那台 |
| `device_screenshot` | R0 | 运行中设备的 PNG，作为工具结果的图片进会话（附件规则；没有 `vision` 的模型不提供） |
| `device_open_url` | R1 | 只打开这台 Mac 的本机地址（http(s) 的 localhost、`*.localhost`、127/8、::1，同浏览器工具） |
| `device_set_appearance` | R1 | 浅色或深色 |
| `device_rotate` | R1 | 向左或向右转 90°，回答读回的方向；没有转就报错 |
| `device_apps` | R0 | 不隐藏的 App：bundle id、名字、人的还是系统的 |
| `device_launch` | R1 | 按 `device_apps` 里的 bundle id 启动，不带参数 |
| `device_tap` | R1 | 在一个点（设备点）点按；`holdMs` 超过 500 是长按 |
| `device_swipe` | R1 | 一指从一点拖到另一点，`durationMs` 默认 300、最长 5000 |
| `device_type_text` | R1 | 逐键输入可打印的 ASCII（≤ 1000 字符），只在设备当前的键盘是 English (US) 时；否则整段拒绝并说明（见[实时画面与输入](#实时画面与输入)） |
| `device_press_key` | R1 | return、delete、tab、escape 或方向键 |
| `device_press_button` | R1 | home、lock、side、siri |

- **输入工具只给完全访问的 Code 会话。** 外部 Harness 在 L3、由人发起的一轮经 `latch-browser` 与工具网关调用。我的 Agent 的会话、无人值守运行和内置 Harness 无法调用输入工具。网关只在 Host 提供 idb 时列出。和人的输入共用一条路径，按手势串行。先写审计再执行，设备要在列表里且在运行。送不到就报错。
- **看的是 Harness 的档位，不是会话里选的权限模式**：外部 ACP Harness 一律是 L3，即使人在会话里选了更严的模式，Agent 仍拿得到输入工具，是否先问由 Agent 自己的 CLI 决定（同浏览器工具）。**「只在这台 Mac」指面板的画面与输入路由**；数据范围是「全部」的手机发起的一轮，在桌面端开着时 L3 的 Agent 仍能点按，截图进入会话（同现有的 `device_screenshot`）。
- **有了输入，`device_open_url` 的本机地址规则对这些会话就不再是界限**：能点按的 Agent 可以在 Safari 里打开任何地址。这条规则只对没有输入工具的会话还有意义；完全访问会话的 shell 本来也能运行 `simctl openurl`。

- **没有 `device_record`。** 工具结果只能带文字与图片，录下的视频进不了会话，也不该落进项目文件夹；有 shell 的 Agent 可以自己运行 `xcrun simctl io <UDID> recordVideo`，指引里也这样说，或请人在面板里录。
- **启动 App 不带参数**：参数能让 App 打开任意地址，会绕过下面 `device_open_url` 的本机地址规则。权限的授予与撤销只给人（面板），不给 Agent。

- **地址。** Agent 不能在设备上打开别的地址或深链接（`myapp://…`），即使这一会话「始终允许」了它：那会把读到的东西带出设备，深链接交给哪个 App 也没人选。它得到一句话，请人在设备面板里打开；人在面板里可以打开任何网址与深链接。
- **按实际运行核权限。** 发给 Harness 前，Host 把授权绑定到本轮运行 ID 和发起设备。只有「全部」数据范围能授权。队列实际发送时，原提交设备和编辑设备都必须有「全部」数据范围，运行中再次核对。受限待办材料与插件页面继续沿用收窄范围，自动化没有一个发起设备可授予。重试收到旧回执、排队、计划审批都不会变宽。较窄设备追加时，Host 在真正发出追加时暂时禁用设备工具，追加生效或结果未知时撤下这一轮的授权。较窄设备回答 Agent 的提问（选项也算）或拒绝时附上说明，Host 在交给 Agent 之前撤下这一轮的授权。一轮的文字里有别的设备写的内容时，授权也要这些设备各自具备：待办讨论引用的每条发言的发言设备（待办本身由较窄设备写下时不授权），行级反馈每条的写下与修改设备（排队后仍随这一项核对）；查不到的设备按不具备算。设备被撤销或权限收窄时会停下这一轮仍在进行的设备调用。截图会进入会话，能读会话的设备都看得到。
- **输入工具的展示。** `latch-browser` 的模拟器输入工具在会话记录、审批和设备事件里展示操作类型与已知计数。ACP 省略工具类型或只给出短名称时，以完整标题辨认输入工具，同时核对已有的类型和名称。无论凭名称、标题还是服务器与工具名辨认，参数都要与该操作的结构完全相符才按计数展示；不符的调用像其他工具一样显示真实参数。执行和同轮调用匹配继续使用完整参数。设备读取旧工具行时也经过同一展示规则，用户自己发出的消息依原样呈现。
- 只在这台 Mac 的桌面端开着（已登记为浏览器提供者）时执行，否则回答「Latch 窗口没有打开」；外部 Harness 的会话要有项目、完全访问、在运行中的一轮里（同浏览器工具）。网关的工具列表只在 Host 上次列出设备时找到 Xcode 才包含它们。
- 启动与关机留给人：设备没运行时工具回答「设备未启动，请在设备面板里启动」。
- **指引。** `latch-browser` 的 `initialize` 带 `instructions`：用 `device_list` 标出的那台设备的 UDID，不用 `booted`；设备没运行就请人在面板里启动；在检查点截图核对；`device_rotate` 说没转时截图核对，不要重试；`device_launch` 只用 `device_apps` 里的 bundle id。输入：动作前后截图；坐标用设备点（截图像素除以倍数，iPhone 约 3）；离边 4 点以内是系统手势；按键前确认焦点在对的输入框。输入失败时先停下并截图。`device_type_text` 只在当前键盘是 English (US) 时逐键输入可打印的 ASCII。工具拒绝时请人输入。登录、付款与系统权限对话框留给人；只有一指，没有捏合。构建、安装、运行用自己 shell 里的 `xcodebuild` 与 `xcrun simctl`（`-destination id=<UDID>`），或人添加的 Xcode 服务器；录屏请人在面板里录或自己运行 `simctl io recordVideo`；不抹掉、不删除设备，不在没被要求时改权限，不登录真实账号。工具说明里也写了其中要紧的几条。

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

## 实时画面组件

`latch-simulator`（`native/macos/LatchSimulator.swift`）读一台运行中模拟器的画面，编成 H.264（不可用时 JPEG），经标准输入输出交给 Host。**它用 Apple 的私有框架取画面**（主人 2026-11-17 同意，只限这个组件）：运行时 `dlopen` CoreSimulator（系统位置，或 `xcode-select` 选中的 Xcode 里的那份），经 Objective-C 运行时找到设备、`SimScreenAdapter` 列出的主屏，再用 `SimScreen` 的帧回调拿到 IOSurface；编码用公开的 VideoToolbox。SimulatorKit 与 CoreDevice 都不加载。Host 的其余部分仍只用公开的 `xcrun`。

- **会随 Xcode 失效。** 调用前逐一核对类、协议与方法的类型编码，缺一个或变了就报告「不支持」并给出简短原因（如 `no-xcode`、`changed-method:…`，≤ 128 字符），不去调用。回调块在编码里只是 `@?`，块自身的参数类型核对不到。那时面板退回 simctl 截图。没有链接期依赖，没有 Xcode 的 Mac 上它也能启动并报告不支持。
- **不要系统权限。** 不用 ScreenCaptureKit、CGEvent 或辅助功能。组件自己的代码不启动子进程、不写文件、不联网；进程内的 CoreSimulator 经 XPC 连 CoreSimulatorService（必要时由 launchd 拉起），并写它自己的日志。经环境变量（`DEVELOPER_DIR`）选的 Xcode 一律不用。构建同其他组件：`swiftc`，`codesign --sign - --options runtime`，没有 entitlements。
- **一台设备一个进程**，参数只有 `--udid <大写 UUID>`；另有 `--version` 与三个不连任何设备的自检：`--self-test`（解析框架、类与编码器，打印能力表）、`--self-test changed-interface`（改动一个方法的预期编码，验证报告「不支持」）、`--self-test protocol`（从标准输入读请求，按请求校验逐个回答）。标准输入关闭、设备关机或 SIGTERM 时退出；从启动起就读标准输入、SIGTERM 保持默认，所以 Host 在组件连设备期间退出也不会留下它。
- **协议**在 Swift 文件开头：类型字节、4 字节长度、载荷。Host 发开始（编码、最高帧率 1～60、最长边 160～4096 像素）、停止、要关键帧、ping；`0x10`～`0x3f` 留给以后的输入，这一版一律回答 `unsupported`。组件发能力（帧是否可用及原因；所有输入能力都是不可用）、流描述（编码、avcC、编码尺寸、设备像素、每点像素数、方向）、帧（关键帧标记、微秒时间戳、AVCC 或 JPEG，≤ 8 MiB）、逐个请求的结果、设备离开。帧内容不进标准错误。超过 64 KiB 的请求回 id 0 并退出（状态 2）；最多 64 个请求待处理（之后不再读标准输入），最多 64 条消息待写出，Host 只写不读时组件退出（状态 3）。
- **节流与背压。** 按最高帧率的节拍，只在画面变了时编码，画面停下半秒后再补一帧，静止的屏幕几乎不发。一帧还没写出时跳过节拍（在编码之前跳，H.264 的参照链不断）；Host 读得慢，组件就少发，从不无限缓存。
- **Host 的包装** `apps/host/src/simulator-helper.ts`：固定路径 `dist/native/latch-simulator` 与固定参数，每类消息都有长度上限，能力里声称有输入的组件被拒绝；`attach`、`frames()`（异步迭代）、`keyframe`、`close`。读得慢时只留最多 8 帧（≤ 16 MiB）加最新的一条流描述，多出的帧丢掉，同一时间至多一个关键帧请求；组件超过 32 个请求未回答或标准输入积压超过 1 MiB 时按损坏处理（SIGKILL）。未知的方向值照传。组件崩溃只让在途调用失败，不影响 Host。`SimulatorLive`（见[实时画面与输入](#实时画面与输入)）是它唯一的使用者；组件不收任何输入消息。

**实测**（2026-11-17，Xcode 27.2、iOS 27.2，iPhone 17 模拟器 `latch-frames-check`，这台 Mac 负载 400～500）：页面动画时 H.264 最长边 1280（588×1280）稳定 30 帧/秒，约 35～87 KB/s，组件 CPU 约 4%（10 秒 0.38 s）；JPEG 同尺寸 30 帧/秒约 0.9 MB/s；JPEG 全尺寸 1206×2622 最高 60 帧/秒时约 3.2 MB/s；静止的主屏 10 秒 4 帧。H.264 用 ffprobe 解出 588×1280 的 Main 档画面，内容与设备一致；读取方暂停 3 秒时组件内存保持约 42 MB。

## 浏览器面板的手机视图

见 [PREVIEW-BROWSER.md](PREVIEW-BROWSER.md#视口外观控制台与网络)：多了小屏手机、大屏手机、Android 手机三个预设与各自的像素比，手机预设外面有 Latch 画的外框与安全区示意。

## 尚未实现

- **中文与其他非 ASCII 文字、拼音等键盘上的文字：不可用。** 原因见[实时画面与输入](#实时画面与输入)：没有键码，粘贴到 App 里是空的，组字会改写逐键输入。请在 Device Hub 的窗口里输入。
- **两指与捏合：不可用。** idb 的触摸只有一个点。
- **没装 idb_companion 时的输入。** Latch 不替人安装；悬停里给出安装命令，点按在 Device Hub 的窗口里。
- **接手与交还 Xcode 的设备会话。** Xcode 的调用由 Agent 进程里的桥直接交给 `mcpbridge`。面板能显示「Agent 正在使用」，画面来自实时组件或 simctl 截图。接手和交还尚未实现，因为 Host 无法中断桥上已经发出的输入。
- **手机与其他电脑上看模拟器。** 要把这台 Mac 的画面传到别的设备，需要单独的安全审阅；那些设备上没有入口。
- **Android 与真机。** 不列出，不操作。
- **Agent 启动或关闭设备。** 留给人。
- **`device_*` 的指引作为内置技能。** 内置技能挂在 Latch 的 MCP 服务器上，`latch-browser` 不是其中之一，所以这段指引只经 `instructions` 与工具说明给出。

## 测试

| 范围 | 文件 |
| --- | --- |
| 固定参数与 UDID、地址校验、只关自己启动的、画面上限与临时文件、停止不碰人启动的设备、工作目录是 `/`；Agent 只开本机地址（「始终允许」之后也一样）、不开深链接，只为数据范围「全部」的设备发起的一轮 | `apps/host/test/simulators.test.ts` |
| 旋转的参数与读回、没转不报成功；App 列表解析、只对列出的 App、启动不带参数、权限的固定服务；新建的名字与类型校验；录屏的私有目录、SIGINT、只给开始它的设备、按时长与大小结束、超过上限 413、同时开始也最多两段、面板没了或关机即丢弃、Host 停止时目录在停止返回前删掉；给 spawner 的时限；日志的谓词、清理、每台与全部的上限、丢弃计数、Host 开始停止后不启动；崩溃遗留目录只删合格的；闲置与 Host 停止时只关自己那次启动的（重启过或没有启动时间的不关）、Device Hub 算使用；页面在流建立期间关掉不留 `log`、范围收窄或设备撤销或凭据失效时结束流；新路由只收 `host.sock` 上 `run` 加 `all`、先审计、审计里没有 bundle id 与名字；`device_rotate`、`device_apps`、`device_launch` | `apps/host/test/simulators-public.test.ts` |
| 路由：只有 `host.sock` 上 `run` 加 `all` 的设备、功能开关、先审计、Device Hub；内置 Harness 的工具 | `apps/host/test/simulators.test.ts` |
| 「Xcode」：检查、添加、工具开关、分级；假 ACP Agent 经桥调用替身 `xcrun`：Latch 的指引、分级与设备 UDID 进审计、关掉的工具被拒 | `apps/host/test/mcp-xcode.test.ts` |
| 桥：Latch 的指引在前、只交出设备 UDID | `packages/harness-acp/test/mcp-bridge.test.ts` |
| 面板模型与「+」、缩放、标注、日志的行数上限、快捷键 | `apps/web/test/device-panel.test.ts` |
| 真实 Electron 与真实 simctl（只用名字以 `latch-` 开头的设备，没有 Xcode 时跳过）；替身下的底栏：缩放、旋转、录屏下载、标注、App、日志、新建对话框、⌘S；`LATCH_E2E_SIMULATOR` 指定的真实 `latch-` 设备上的公开命令 | `e2e/desktop-device.e2e.ts` |
| 画面组件的分帧（畸形、超长、未知类型）、包装的监管、背压与关闭升级（替身组件）、真实组件的三个自检（协议拒绝、超长请求、只写不读、方法改变；不连设备） | `apps/host/test/simulator-helper.test.ts` |
| 实时画面的分帧、停住的读者有上限、只等下一个关键帧且只要一次、共享与不同设置被拒、关闭时生成器 `return()` 与组件 `close()`、设备关机与 Host 停止；新路由只收 `host.sock` 上 `run` 加 `all`、参数校验、`control` 先审计且只一次、只收接管者的输入、坐标与事件校验、没装 idb 时回答不可用；Agent 的输入工具：完全访问的外部 Harness 经网关、审计只有计数、非 ASCII 文字整段拒绝、内置 Harness 没有；无人值守的一轮、低于 L3 的 Harness、数据范围不是「全部」的设备发起的一轮都被拒绝，不启动伴随进程、不写 `simulator.call` | `apps/host/test/simulator-live.test.ts` |
| 手写的消息与 idb 客户端发给真实伴随进程的字节逐字节相同、读真实的 `describe` 回答；伴随进程的固定参数（没有 `--grpc-port`）、0700 目录、环境、套接字路径太长、没装、不就绪、拒绝的投递报错；崩溃遗留目录只删连不上的；人与 Agent 的串行、人总是优先（三个 Agent 长按时人的点按在一个手势之内落下）、这一轮取消时 Agent 停下、限速、放手时抬起手指、关机与 Host 停止时结束；只认 Homebrew 的 Cellar、说要监听端口就立即 SIGKILL、回答超量或 `describe` 不回答即失败、伴随进程不读时积压 64 KiB 后报错；文字只在 English (US) 键盘上逐键输入，别的键盘、读不到键盘或非 ASCII 整段拒绝 | `apps/host/test/simulator-input.test.ts` |
| 页面：流的分帧、描述校验、解码器的选择、转向的画法、指针在缩放与留边与横屏下换算成设备点、输入按帧合并且不丢按下抬起、只发命名的键 | `apps/web/test/device-live.test.ts` |
| Electron：`VideoDecoder` 解出录下的 H.264、点击变成正确设备点的点按、Home 与按键、没装 idb 时的「输入不可用」与悬停（替身组件与替身伴随进程，来自 `@latch/testkit`，不进 `dist/`）；`LATCH_E2E_LIVE_DEVICE` 指定的运行中 `latch-` 设备上用真实组件与 `idb_companion`：设备里的页面回报点击位置，转向后画面转正、点按仍落在对的地方 | `e2e/desktop-device.e2e.ts` |

这些用例不证明 Xcode 的设备交互真的能用：2026-11-17 在 Xcode 设置允许外部 Agent、打开一个临时示例工程后，桥从 Xcode 之外回答了 `initialize` 与 `tools/list`（54 个工具），但第一次 `DeviceInteractionStartSession` 回答「This agent isn't approved to use Xcode's tools yet. Call XcodeOpenWorkspace or XcodeNewProject first」——批准要由人在 Xcode 弹出的提示里做，还没有做，所以点按、输入与截图都没有真实验证。
