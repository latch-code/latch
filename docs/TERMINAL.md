---
description: 终端：latch-pty 组件与帧协议，Host 终端服务的输入规则、会话文件夹、环境、上限、回滚缓冲、尺寸归属、输出背压、本地服务与「加入对话」，Harness 的登录命令，会话面板的「终端」页签，以及限制。
sources:
  - native/macos/LatchTerminal.swift
  - apps/host/scripts/build-terminal.ts
  - apps/host/src/terminal
  - apps/host/src/routes/terminal.ts
  - apps/host/src/routes/agent-login.ts
  - packages/protocol/src/terminal.ts
  - apps/host/test/terminal-routes.test.ts
  - apps/host/test/terminal-helper.test.ts
  - apps/host/test/terminal-service.test.ts
  - apps/host/test/terminal-environment.test.ts
  - apps/host/test/terminal-output.test.ts
  - apps/host/test/terminal-frames.test.ts
  - apps/host/test/terminal-cli.test.ts
  - apps/host/scripts/latch.ts
  - apps/web/src/panel/terminal
  - apps/web/test/terminal-model.test.ts
  - e2e/desktop-terminal.e2e.ts
  - apps/web/test/login-terminal.test.ts
  - e2e/desktop-login-terminal.e2e.ts
---
# 终端

终端是这台电脑上以你的账户运行的登录 shell，和「终端」App 里打开的 shell 权限相同。Latch 的审批、路径检查与出站策略都不适用于在其中运行的命令；它不是沙箱，也不隔离任何东西。

macOS 组件 `latch-pty`、终端服务（`apps/host/src/terminal/`）与 HTTP 路由（`apps/host/src/routes/terminal.ts`）已实现，只有这台电脑（`host.sock`）能用，页面在会话面板的「终端」页签里打开它（见[界面](#界面)）。其他系统上终端尚未实现：组件只有 macOS 版本，服务返回 501 `terminal-unsupported`。

Harness 的登录命令也在这里运行：「在终端里登录」在会话里用这个会话的「终端」页签，没有会话时（设置、新会话的草稿）用一个不属于任何会话的终端（见[登录命令](#登录命令)）。它同样是你的登录 shell，不是沙箱。Host 不给这台设备 Latch 终端时（组件缺失，或这个窗口的数据范围是 `work`），仍用这台电脑默认的终端打开（见 [HARNESSES.md](HARNESSES.md)）。

## latch-pty 组件

`native/macos/LatchTerminal.swift` 由 `pnpm build`（`build:host`）经 `apps/host/scripts/build-terminal.ts` 编译并临时签名为 `dist/native/latch-pty`（标识 `dev.latch.pty`），做法与 `latch-files` 相同，不用 npm 原生模块。组件缺失时 Host 不提供终端（503 `terminal-unavailable`），也不以其他方式启动 shell。

帧是 1 字节类型、4 字节大端长度和载荷，载荷最多 64 KiB，超出即协议错误。

- Host 发给组件，stdin 上：`start`（JSON：`file`、`argv`、`env`、`cwd`、`cols`、`rows`，必须最先且只有一次）、`input`。fd 3 上：`resize`（列与行各 2 字节，1 到 1000）、`signal`（SIGHUP、SIGINT、SIGTERM 或 SIGKILL，发给前台进程组）；分开是为了让程序不读的输入挡不住它们。任一管道结束或收到 SIGTERM 即关闭终端。
- 组件发给 Host：`started`、`output`、`foreground`（是否有 shell 以外的程序在前台，及其进程名）、`exit`（退出码或信号）、`error`（`invalid-input`、`cwd`、`pty`、`exec`）。运行中收到格式不符的帧时报告 `invalid-input` 并结束终端。

启动：

- 组件自身以空环境运行，shell 的整个环境只来自 `start` 帧；组件自己的环境（CoreFoundation 会往里加变量）从不传给 shell。
- `forkpty` 之前准备好子进程需要的一切，fork 与 exec 之间只做系统调用。
- 子进程进入 `cwd` 后再 exec；exec 失败报告为 `exec`。
- 组件忽略 SIGHUP、SIGINT、SIGQUIT 与 SIGPIPE，只由 Host 的帧、stdin 关闭或 SIGTERM 结束；shell 启动前恢复这些信号的默认处理。

运行：单线程 kqueue 循环。

- 背压：等待 Host 读取的输出超过 256 KiB 时停止读取 pty，终端中的程序随之等待；等待写入 pty 的输入超过 256 KiB 时停止读取 stdin，Host 的管道随之写满；已写入的部分随即释放，长粘贴不会让组件的内存随总量增长。
- 输出合并：pty 只缓冲约 1 KiB，所以组件始终及时读取 pty；空闲后的第一段输出立即发出（键入回显不增加延迟），持续输出时最多每 4 ms 或每 32 KiB 发一帧。
- 前台：输出或输入后约 100 ms 检查前台进程组，有程序在前台时每秒复查，否则每两秒复查（不输出的程序也可能在之后接管终端），变化时报告。

关闭（任一管道结束或 SIGTERM）：

1. 收集终端上的所有进程组：shell 的、前台的，以及每个以这个终端为控制终端的进程所在的组（有作业控制的 shell 把每个作业放进单独的组）。
2. 先对 shell 的组、再对其余各组发 SIGHUP 与 SIGCONT，并关闭 pty。
3. 一秒后对仍存在的组发 SIGKILL，回收 shell，报告退出，然后结束。shell 与各组都已退出时随即结束，不等满一秒。

shell 自行退出时，组件再读取最多 0.5 秒输出，然后报告退出并结束。

## 终端服务

`TerminalService`（`apps/host/src/terminal/service.ts`）为路由提供 list、create、close、input、resize、stream 与 attach（`extract`）所需的方法，每个方法自己做检查，路由只做解析与转发。

- **只在这台电脑上。** 只有 `host.sock`（`isLocalListener`）能列出、打开、观看、输入、调整大小、发信号、关闭和「加入对话」；这些方法都接收发起者并自己检查，其他入口一律 403 `local-only`，不只依赖路由。
- **远程。** 远程观看与输入尚未实现，输出不离开这台电脑。
- **文件夹。** 服务经 Host 注入的 `sessionFolder` 从会话记录取主文件夹，调用方从不传路径。没有这个会话时 404，文件夹已不可用或不存在时 409 `terminal-folder-unavailable`（判断与继续这个会话时相同），已归档的会话 409 `terminal-session-archived`，早先助手跑过的会话没有项目文件夹，409 `terminal-personal-session`。
- **环境。** 登录 shell：账户数据库中的 shell，`argv[0]` 以 `-` 开头；不可用时用 `/bin/zsh`。`TERM_PROGRAM=Latch` 与 `LC_TERMINAL=Latch` 标记 Latch 终端；没有区域设置时设 `LANG=en_US.UTF-8`，否则中文输入输出会被当作单字节。模型密钥、设备凭据与 Host 设置不进入 shell。之后 shell 照常读取你自己的 profile。
- **上限。** 每个会话最多 8 个终端，全部最多 32 个（每个 512 KiB 回滚缓冲，合计 16 MiB）。名额在等待任何操作之前计入，同时打开也不会超出；组件真实退出后才释放。一次输入最多 64 KiB；组件尚未读取的输入超过 1 MiB 时拒绝新的输入（429）。每个终端最多 8 个观看流（429 `terminal-streams`）。
- **回滚缓冲。** 只在内存中，每个终端 512 KiB，先丢弃最旧的输出；Host 停止后不保留。
- **尺寸归属。** 打开终端的设备决定它的大小。这台电脑上的其他设备调整大小被拒绝（409 `terminal-size-owner`），观看从不改变大小。
- **流。** 先发终端摘要，再按偏移重放回滚缓冲（丢弃过旧输出后从第一个换行之后开始），然后是实时输出，重放与实时输出不重叠。重连时带上最后的偏移，只收到之后的输出；偏移已不在缓冲中时先收到 `reset`。写入返回 false 时停止，传输排空后从缓冲继续，所以观看流不额外占用内存；落后超过缓冲的观看流收到 `reset`。摘要的变化（大小、前台程序、本地服务、退出）排在它之前的输出之后送达。
- **输出速率。** 一个终端每 250 ms 输出超过 2 MiB（8 MiB/s）时，Host 停止读取它，直到这个窗口结束，终端中的程序随之等待，不占用其他会话的时间。
- **关闭。** 前台有 shell 以外的程序时，关闭需要 `force`（客户端在用户确认后发送），否则返回 409 `terminal-busy` 并带上程序名。`shutdown` 结束所有终端并拒绝再打开，由 `hostStopping` 触发。
- **归档与删除。** 单个与批量的归档、删除路由在动手之前调用 `checkSessionEnd`：在这台电脑上按关闭的规则，有终端忙时 409 `terminal-busy`（客户端询问用户，带 `force` 关闭那个终端后重试）；其他入口在会话还有终端运行时得到 409 `terminal-running`，会话不变，也不结束这台电脑上的 shell。检查通过后才归档或删除，成功后由 `sessionArchived` 与 `sessionDeleted` 结束这个会话的所有终端，所以因其他原因被拒绝的删除（如 409 `task-running`）不会结束任何 shell。检查与保存之间打开的终端也随会话结束。
- **本地服务。** 从输出的完整行中找回环地址（`localhost`、`127.0.0.1`、`[::1]`，`0.0.0.0` 记为 `localhost`）上带端口的 http 或 https 网址，只保留协议、主机与端口，不保留可能带令牌的路径和查询。每个终端保留最新的 8 个，新的在前，shell 结束时清空；同一行出现再多地址，每个也只做一次查找。
- **「加入对话」。** 所选文本（最多 256 KiB），或输出的最后几行（只看最新的 256 KiB）；结果最多 200 行、32,000 个字符，保留最新的。去掉转义序列，应用回车、退格与行擦除和光标移动留下的空隙或换行（行不建模：移到别的行就另起一行），光标位置按每 4096 列折回，折回的内容仍算同一行；读取窗口从一行中间开始时，丢掉不完整的第一行（窗口里没有换行就什么也不带）；去掉不可见的格式字符，先脱敏再截断。处理时间与输入长度成正比，任何构造的输入都一样；每 10 秒最多 20 次（429 `terminal-extract-busy`）。结果标明是否截断、是否替换过内容（`redacted`）、是否可能含秘密（`mayContainSecret`）。
- **「加入对话」的脱敏**只是尽力而为；附加前让用户看到文本并提示。
- **配对码。** 配对码不在 Latch 终端里显示，用 `--code-file`。
- **审计。** 打开请求通过检查后、shell 启动之前，服务调用 `beforeOpen`，Host 在其中写 `terminal.open`（会话与终端的 ID），写入失败时返回 503 `audit-unavailable`，不启动 shell。写入之后、启动 shell 之前再次检查设备授权，等待期间被撤销或失去权限的设备得不到 shell。输入的内容从不记录。

## 登录命令

`POST /link/api/harnesses/:id/login-terminal` 带 `terminal: { sessionId?, cols, rows }` 时，Host 在 Latch 终端里运行这个 Harness 自己的登录命令（`routes/agent-login.ts`，登录本身见 [HARNESSES.md](HARNESSES.md)）。

- **命令只由 Host 决定。** 调用方只点名 Harness，最多再点名它声明过的一个登录方式；命令来自预设或 Agent 的声明，与交给默认终端的是同一条（`loginTerminalScript`）。正文是 strict 的，多出的字段一律 400。没有这个 Harness 或它没有登录命令时 404 `harness-no-login`，Claude Agent 就是这样。
- **谁能用。** 与其他终端相同：只有 `host.sock`（其他入口 403 `local-only`）、`run`、数据范围 `all`（否则 403 `terminal-scope`）。手机和远程浏览器不因此得到终端，那里仍只显示可复制的命令。
- **怎么运行。** Host 把脚本写成一个 0700 的临时文件（名字随机；临时目录的路径不是普通字符时改用 `/tmp`），终端运行你的登录 shell，加 `-i -c 'exec /bin/sh <文件>'`：仍是登录 shell 并且是交互式的，所以命令能找到你的 profile 配好的东西（例如版本管理器里的 Node）；交给 shell 的只有一个路径，脚本的内容不经你的 shell 解析。脚本先删除自己，登录命令是它的最后一行，所以命令的退出码就是终端的退出码；终端随命令结束。shell 没来得及运行脚本时，文件随终端一起删除。
- **在哪里。** 带 `sessionId` 时是那个会话的一个终端，在会话的文件夹里，计入它的 8 个名额。不带时记在保留的标识 `harness-login`（`HARNESS_LOGIN_SESSION`）之下，在家目录里；没有会话用这个标识，在它之下只能打开登录命令，普通的打开请求得到 404。观看、输入、调整大小与关闭仍走 `/link/api/tasks/harness-login/terminals/…`，规则不变。
- **摘要。** `TerminalSummary.login` 是 `{ harnessId, name }`，名字去掉不可见字符与像密钥的部分。命令运行期间终端算作忙碌（登录命令和 shell 在同一个进程组里，系统不会把它报告成前台程序）：关闭要确认，会话归档、删除与安装更新都等它。
- **输出不离开终端。** 登录会打印设备码和带码的链接。它们只在回滚缓冲与这台电脑的观看流里，和其他终端输出一样不进日志、审计、会话或发给其他设备的事件；登录终端不接受「加入对话」（409 `terminal-login-output`）。
- **审计。** 先写 `agent.login.opened`（与默认终端的路径相同，只含 Harness 的 ID，Agent 声明的方式带 `source: 'harness'`），再由终端服务写 `terminal.open`，都在 shell 启动之前；任何一条写不进就不启动。
- **结束之后。** 命令结束或终端被关闭时，Host 丢掉记住的登录状态，下一次 `login-status` 重新运行状态命令。页面在命令以 0 退出后带 `fresh` 再问一次，只按 Harness 自己的回答显示「已登录」；退出码本身不算登录。会话里被拒绝的那一轮，这时那一行只剩「已登录」与「重试」，「还没登录」和登录命令不再显示；消息不会自动重发，仍由「重试」发出。不需要本机确认。

## 界面

`apps/web/src/panel/terminal/`：会话面板的「终端」页签，排在「文件」之后、「交付」之前；启动面板里也有一行「终端」（字母键 T），标题行有「终端」开关（桌面端 ⌘J，浏览器 Alt J）。它们只在快照带 `catalog.features.terminal`、会话没有归档、也不是早先助手的会话时出现；手机、远程浏览器与其他设备上没有任何入口，只在 设置 › 关于 里用一行提示说一次「终端只在运行 Latch 的 Mac 上」。

- **页签与名称。** 页签里是这个会话的终端：「终端 1」「终端 2」…，用 `PanelTabs`；运行登录命令的那个以 Harness 的名字命名（「Codex」）。一个终端保持它第一次出现时的编号，新开的取最小的空号，按 Host 打开的先后；重新载入后从 1 重新编号。第一次打开没有终端的会话时自动开一个，之后关掉最后一个时显示「打开终端」。行尾依次是本地服务、「加入对话」与「+」（满 8 个时停用并说明）。文件夹由 Host 按会话决定，页面从不传路径。
- **关闭。** × 或 Delete 先不带 `force` 关闭；Host 回答 409 `terminal-busy` 时弹出确认「关闭终端 N？」（「「sleep」还在运行，关闭会结束它。」，红色「关闭终端」），确认后带 `force` 再关。
- **渲染。** xterm.js（`@xterm/xterm` 与 `@xterm/addon-fit`）在第一次显示终端时才加载。字体、字号取 `--mono` 与 `--fs-term`，底色与文字取 `--canvas` 与 `--ink`，光标是墨色，选区是 `--accent-soft`；十六色取红、绿、琥珀、蓝与语法色，深色主题里黑白对调。主题切换时重新读取令牌。 运行中的终端遵循系统和设备的动效设置。减少动效时停止光标闪烁，终端保持原来的焦点和输入状态。
- **尺寸。** 打开时按面板量出的列与行请求；之后只有打开它的设备（`sizeOwner`）按面板大小调整（停稳 120 ms 后发 `resize`），其他设备按 Host 的大小显示，从不调整。
- **流与重连。** 每个终端一条流，页签隐藏时也保持。第一次连接不带 `from`，收到回滚缓冲的重放；断开后带最后的偏移重连（退避 0.5 到 8 秒），`reset` 时清屏后接着显示；`closed`、404 或 403 时页签移除。页面重新载入后从 Host 的列表与重放恢复。
- **背压。** 输出交给 xterm 后等它解析；尚未解析的超过 256 KiB 时停止读取响应，Host 的写入随之返回 false 并停下，终端中的程序随之等待，页面内存不随输出增长。
- **输入。** xterm 交出的内容（按键或一次完整粘贴，程序开启括号粘贴模式时带括号）按 64 KiB 切开，一次一个按顺序发送；429 `terminal-input-busy` 时稍后重发同一段；其他失败丢弃之后排队的输入并在页签里说「输入可能没有送达终端」，不会乱序或重复。复制粘贴用系统的 ⌘C、⌘V。
- **按键。** 终端有焦点时，按键都交给终端（Ctrl、⌥、Esc、Tab），工作台的快捷键收不到；只有 ⌘ 组合键仍是 Latch 与系统的，例如 ⌘K 搜索、⌘L 回到输入框、⌘J 关上终端。
- **结束。** shell 退出后输出保留、不再接受输入，底部一行写「已退出 · 代码 N」（信号时「已结束 · SIGHUP」，组件失败时「终端意外结束」）和蓝色「重新打开」：关闭旧终端，用同一编号开一个新的。
- **本地服务。** 输出里出现的本地服务显示为行尾的小链接（`localhost:5173`），在桌面端（有「浏览器」页签时）点按会在浏览器页签里新开一个标签打开整个源，⌘ 点按与其他客户端仍在系统浏览器中打开（见 [PREVIEW-BROWSER.md](PREVIEW-BROWSER.md#界面)）。
- **加入对话。** 有选区时发送选区，否则取最后 40 行，经 `attach` 拿到 Host 去掉转义序列并脱敏后的文本，以「终端 N」加 `text` 代码块放进输入框草稿，不发送；截断时标题后写「（较早的输出未包含）」，`mayContainSecret` 时提示「加入的内容可能含密钥，发送前检查草稿」。
- **登录。** 会话里按「在终端里登录」时，页面打开「终端」页签并选中新开的登录终端；它没有「加入对话」，结束后也没有「重新打开」（再登录从那一行的按钮开始，上一次已结束的登录终端随之关闭）。没有会话时是一个 720 宽的对话框（`LoginTerminalDialog`）：标题是 Harness 的名字，里面是同一个终端画面，底部左侧是「你的账户，不是沙箱」，右侧是「登录中」或「已退出 · 代码 N」。命令以 0 退出时对话框自己关闭；失败时留着供阅读；运行中关闭先问「关闭 Codex 的登录？」。按钮旁用图标和一个词说状态：「登录中」「已登录」「失败」，Harness 说不出登录状态时是「已结束」。同一个 Harness 的登录还在运行时，再按按钮只把它带到眼前，不开第二个。页面每秒向 Host 读一次终端列表来跟随运行中的登录命令（`loginRuns.ts`），所以那一行不在屏幕上时也能知道它结束了。
- **底部一行。** 运行时写 shell 与文件夹名、前台程序（带转圈）与「正在重新连接…」（琥珀）；右侧是盾形的「你的账户，不是沙箱」，ⓘ 后说明它以你的账户运行、审批与路径检查不适用。

## 路由

都在 `/link/api/tasks/:id/terminals` 之下（没有会话的登录终端用 `harness-login` 作 `:id`，见[登录命令](#登录命令)），类型在 `packages/protocol/src/terminal.ts`。每条路由都只接受 `host.sock`，需要 `run` 与数据范围 `all`：其他入口在读取请求正文之前就得到 403 `local-only`，数据范围为 `work` 的设备得到 403 `terminal-scope`，因为 shell 能读到这个账户能读的一切，包括 Host 的数据目录。

| 路由 | 正文与结果 |
| --- | --- |
| `GET …/terminals` | `{terminals}` |
| `POST …/terminals` | `{cols, rows}`；201 `{terminal}` |
| `POST …/terminals/:tid/input` | `{data}`（base64，解码后最多 64 KiB）；`{accepted: true}` |
| `POST …/terminals/:tid/resize` | `{cols, rows}`；`{terminal}` |
| `POST …/terminals/:tid/close` | `{force?}`；`{closed: true}` |
| `POST …/terminals/:tid/attach` | `{lines?, selection?}`；`TerminalText`。只返回文本，不加入任何对话；登录终端 409 `terminal-login-output` |
| `GET …/terminals/:tid/stream?from=<偏移>` | SSE |

- **能力标记。** `catalog.features.terminal` 只在真能打开终端时出现：这台电脑上（`host.sock`）、设备有 `run` 且数据范围为 `all`、组件可用。其他设备的快照里没有它，页面不画打不开的入口。
- **流的事件。** `terminal`（摘要）、`output`（`{offset, data}`，`data` 是 base64）、`reset`（`{offset}`），每 15 秒一行注释心跳。终端关闭或 Host 停止时最后发 `closed`；没有 `closed` 就结束的流是被切断的，客户端带上最后的偏移重连。
- **流跟着凭据走。** 凭据失效、设备被撤销或失去 `run` 与数据范围 `all` 时，流随之结束。
- **输入的顺序。** Host 按到达顺序写入终端，并发的请求可能交错，客户端要等上一次输入返回后再发下一次。

## 限制

- 不是沙箱：shell 以你的账户运行，能做你在任何终端里能做的事。
- 终端标记只防无意显示，不防有意绕过。
- 自行脱离会话的守护进程（`setsid`）不在终端的进程组里，关闭终端不会结束它们。shell 自行退出时，用 `nohup` 或 `disown` 留在后台的程序继续运行，与其他终端相同。
- 以其他用户身份运行的程序（如 `sudo`）不能由组件发信号，关闭时只收到 pty 的挂断。
- 重放的是原始字节：保留窗口之前设置的终端模式（备用屏幕、鼠标模式等）不会重放。
- 「加入对话」的脱敏按形状猜测，不可靠。
- 本地服务只表示输出中出现过这个地址，不检查服务是否仍在监听。
- 组件五秒内没有结束时 Host 会杀死它，这时只剩内核对 shell 的挂断，不在 shell 进程组里的程序可能继续运行。
- 程序逐字节写入终端时（例如行缓冲的 `yes | head`），吞吐受 macOS pty 本身限制。

## 测试

- `apps/host/test/terminal-helper.test.ts`（仅 macOS）：构建真实组件，在临时目录用 `/bin/sh -c` 运行无害命令，检查文件夹、只含 `start` 帧中的环境、大小与调整、输入、信号、退出码，关闭时忽略挂断的各进程组也被结束且不留进程，SIGTERM 下的快速关闭，Host 不读取时输出完整且程序等待，输入积压时信号、调整大小与管道结束仍然生效，长粘贴完整送达且不占用随总量增长的内存，不输出的程序之后接管终端也会被发现，格式不符的启动与帧；并经服务运行一次完整流程。
- `apps/host/test/terminal-service.test.ts`：用假组件检查每个入口类别的输入规则、文件夹来自会话记录、环境、审计先于启动、并发下的上限、尺寸归属、重放与背压、`reset`、输出速率、本地服务、关闭前确认、「加入对话」的脱敏、启动失败，以及归档与 Host 停止。
- `terminal-environment.test.ts`、`terminal-output.test.ts`、`terminal-frames.test.ts`：环境、登录 shell、回滚缓冲、本地服务识别、文本提取、脱敏、`mayContainSecret`、光标移动留下的空隙与帧编解码。
- `terminal-routes.test.ts`：真实 Host 配假组件，检查每条路由、审计先于启动、审计失败不启动、每个入口类别都被拒绝、能力标记、流的重连、撤销与 Host 停止时结束、归档与删除的检查（包括被拒绝的删除不结束 shell）；并用真实组件运行一次完整流程。`route-guards.test.ts`：已验证的手机经原生入口也被拒绝。
- `terminal-cli.test.ts`：Latch 终端里不显示配对链接和离线连接码。
- `agent-login.test.ts`（「a harness login in a Latch terminal」）：命令只来自预设、多出的字段被拒绝、家目录与会话文件夹、两条审计先于启动、其他入口与数据范围 `work` 被拒绝、没有登录命令的 Harness 404、输出不能加入对话、运行中关闭要确认、结束后重新运行状态命令、没运行的脚本被删除。`packages/harness-acp/test/login.test.ts`：脚本以登录命令的退出码结束。
- `apps/web/test/login-terminal.test.ts`：按钮在哪里用 Latch 终端、哪里退回默认终端、哪里只有命令；请求里没有命令；运行中不开第二个；按 Host 的列表跟随到结束；「已登录」只来自 Harness 的回答。
- `apps/web/test/terminal-model.test.ts`：页签编号与保持选中、结束文案、长粘贴的切分、按键归属、草稿格式，以及流的重放、按偏移重连、`reset`、不再存在的终端、背压与输入的顺序和重试。
- `e2e/desktop-terminal.e2e.ts`（`LATCH_ELECTRON_E2E=1`，仅 macOS）：桌面端经 `host.sock` 连接配假组件的测试 Host，打开、减弱和恢复动效时的光标及焦点、输入、Ctrl-B 不到工作台、本地服务链接、长粘贴完整且带括号、调整大小与其他设备不能调整、「加入对话」（最后几行与选区）只进草稿、重新载入后重放、第二个终端、忙碌时关闭要确认、退出码与重新打开、768 宽，以及 ⌘J 仍归 Latch；截图在 `test-results/desktop-terminal/`。
- `e2e/desktop-login-terminal.e2e.ts`（同上）：真实组件配 `/bin/sh`，测试夹具里的假登录脚本。草稿里的登录对话框（运行、关闭前确认、失败留着）、会话里的登录页签（以 Harness 命名、没有「加入对话」、以 0 结束后那一行只剩「已登录」与「重试」、消息不重发）、设置里的登录（成功后对话框关闭、显示「已登录」），768 宽与深色；登录打印的码不在审计、会话或快照里；截图在 `test-results/desktop-login-terminal/`。

桌面端安装更换 Host 的更新前，正在运行命令的终端算作忙碌，安装等它结束；终端里报告的本地服务只在等待界面列出，随终端一起结束（[UPDATES.md](./UPDATES.md#安装门禁与-host-安装窗口)）。
