---
description: 终端：latch-pty 组件与帧协议，Host 终端服务的输入规则、会话文件夹、环境、上限、回滚缓冲、尺寸归属、输出背压、本地服务与「加入对话」，Harness 的登录命令，工作台的底部终端，以及限制。
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
  - apps/web/src/components/TerminalFillButton.tsx
  - apps/web/test/terminal-fill.test.ts
  - e2e/desktop-terminal-fill.e2e.ts
  - apps/web/test/terminal-model.test.ts
  - apps/web/test/terminal-panes.test.ts
  - e2e/desktop-terminal.e2e.ts
  - apps/web/test/login-terminal.test.ts
  - e2e/desktop-login-terminal.e2e.ts
---
# 终端

终端是这台电脑上以你的账户运行的登录 shell，和「终端」App 里打开的 shell 权限相同。Latch 的审批、路径检查与出站策略都不适用于在其中运行的命令；它不是沙箱，也不隔离任何东西。

- 只有这台电脑（`host.sock`）能用；远程观看与输入尚未实现，输出不离开这台电脑。
- 三层：macOS 组件 `latch-pty`、终端服务（`apps/host/src/terminal/`）、HTTP 路由（`apps/host/src/routes/terminal.ts`）。
- 其他系统上尚未实现：组件只有 macOS 版本，服务返回 501 `terminal-unsupported`。
- Harness 的登录命令也在这里运行（见[登录命令](#登录命令)）。

## latch-pty 组件

`native/macos/LatchTerminal.swift` 由 `pnpm build`（`build:host`）经 `apps/host/scripts/build-terminal.ts` 编译并临时签名为 `dist/native/latch-pty`，不用 npm 原生模块。组件缺失时 Host 不提供终端（503 `terminal-unavailable`），也不以其他方式启动 shell。

**帧。** 1 字节类型、4 字节大端长度和载荷；载荷最多 64 KiB，超出即协议错误。

| 方向 | 通道 | 帧 |
| --- | --- | --- |
| Host → 组件 | stdin | `start`（JSON：`file`、`argv`、`env`、`cwd`、`pinnedCwd`、`cols`、`rows`；必须最先且只有一次）、`input` |
| Host → 组件 | fd 3 | `resize`（列与行各 2 字节，1 到 1000）、`signal`（SIGHUP、SIGINT、SIGTERM 或 SIGKILL，发给前台进程组）。与输入分开，程序不读的输入挡不住它们 |
| Host → 组件 | fd 4 | 不是帧：继承 Host 已打开的只读工作目录描述符 |
| 组件 → Host | stdout | `started`、`output`、`foreground`（是否有 shell 以外的程序在前台，及其进程名）、`exit`（退出码或信号）、`error`（`invalid-input`、`cwd`、`pty`、`exec`） |

任一管道结束或收到 SIGTERM 即关闭终端。运行中收到格式不符的帧时组件报告 `invalid-input` 并结束；Host 收到不该有的帧时按 `protocol` 失败并关闭组件。

**启动。**

- 组件自身以空环境运行，shell 的整个环境只来自 `start` 帧；组件自己的环境（CoreFoundation 会往里加变量）从不传给 shell。
- 组件核对 `cwd` 仍对应继承目录的设备号与 inode；目录被替换时报告 `cwd`，不启动 shell。子进程用刚核验的描述符 `fchdir` 后再 exec，描述符不交给 shell。
- `forkpty` 之前准备好子进程需要的一切，fork 与 exec 之间只做系统调用。
- 组件忽略 SIGHUP、SIGINT、SIGQUIT 与 SIGPIPE，只由 Host 的帧、管道关闭或 SIGTERM 结束；shell 启动前恢复这些信号的默认处理。

**运行。** 单线程 kqueue 循环。

- 背压：等待 Host 读取的输出超过 256 KiB 时停止读取 pty，终端中的程序随之等待；等待写入 pty 的输入超过 256 KiB 时停止读取 stdin，Host 的管道随之写满。
- 输出合并：空闲后的第一段输出立即发出（键入回显不增加延迟），持续输出时最多每 4 ms 或每 32 KiB 发一帧。
- 前台：输出或输入后约 100 ms 检查前台进程组；有程序在前台时每秒复查，否则每两秒（不输出的程序也可能在之后接管终端），变化时报告。

**关闭。**

1. 收集终端上的所有进程组：shell 的、前台的，以及每个以这个终端为控制终端的进程所在的组（有作业控制的 shell 把每个作业放进单独的组）。
2. 先对 shell 的组、再对其余各组发 SIGHUP 与 SIGCONT，并关闭 pty。
3. 一秒后对仍存在的组发 SIGKILL，回收 shell，报告退出，然后结束；各组都已退出时不等满一秒。

shell 自行退出时，组件再读取最多 0.5 秒输出，然后报告退出并结束。组件五秒内没有结束时 Host 杀死它。

## 终端服务

`TerminalService`（`apps/host/src/terminal/service.ts`）的每个方法都接收发起者并自己做检查，路由只做解析与转发。

### 谁能用

- **只在这台电脑上。** 只有 `host.sock`（`isLocalListener`）能列出、打开、观看、输入、调整大小、关闭和「加入对话」；其他入口一律 403 `local-only`，服务与路由各查一次。
- **`run` 与数据范围 `all`。** 数据范围为 `work` 的设备得到 403 `terminal-scope`：shell 能读到这个账户能读的一切，包括 Host 的数据目录。
- **审计先于启动。** 打开请求通过检查后、shell 启动之前，Host 写 `terminal.open`（会话或项目 ID、终端 ID）；写入失败是 503 `audit-unavailable`，不启动 shell。写入之后、启动之前再查一次设备授权，等待期间被撤销或失去权限的设备得不到 shell。输入的内容从不记录。
- **安装更新。** 更新窗口确定后，新开终端与输入是 409 `host-updating`。安装前，正在运行命令的终端算作忙碌，安装等它结束（[UPDATES.md](./UPDATES.md#安装门禁与-host-安装窗口)）。

### 文件夹

调用方从不传路径。

| 目标 | 文件夹 | 拒绝 |
| --- | --- | --- |
| 会话 | 会话记录里的主文件夹 | 没有这个会话 404；文件夹已不可用（判断与继续这个会话时相同）409 `terminal-folder-unavailable`；已归档 409 `terminal-session-archived`；来自已移除 Agent、没有项目文件夹的旧会话 409 `terminal-personal-session` |
| 项目（独立于会话；Host 的默认目录 ID 为 `default`） | 已保存项目的主文件夹，或 Host 启动时的默认目录 | 没有这个项目 404；不可用 409 `terminal-folder-unavailable` |
| `harness-login` | 家目录，只能运行登录命令 | 普通的打开请求 404 |

- Host 用 `O_NOFOLLOW` 打开解析出的目录的真实路径，把描述符交给组件，shell 的 `cwd` 与 `PWD` 也是这个真实路径；项目目录在审计之后、启动之前再核对一次设备号、inode 与路径。
- 打开项目终端和移除项目用同一队列。项目还有终端时移除项目是 409 `workspace-terminal-open`：要人在这台 Mac 上关闭终端，Host 不替人结束 shell。
- **工作树。** 正在启动、运行或等待组件真实结束的终端都占用它的目录，包括这个工作树里其他项目的独立终端；工作树进入移除流程后，其目录中不能再打开终端（[BRANCHES.md](BRANCHES.md#移除工作树)）。

### 环境

登录 shell：账户数据库中的 shell，`argv[0]` 以 `-` 开头；不可用时用 `/bin/zsh`。之后 shell 照常读取你自己的 profile。环境是白名单（`terminalEnvironment`），不是 Host 的整个环境：

- **从 Host 原样带入**：`HOME`、`USER`、`LOGNAME`、`TMPDIR`、`LANG`、`SSH_AUTH_SOCK`、`__CF_USER_TEXT_ENCODING` 与 `LC_*`。
- **固定**：`PATH=/usr/bin:/bin:/usr/sbin:/sbin`（其余由 profile 添加）、`SHELL`、`PWD`、`TERM=xterm-256color`、`COLORTERM=truecolor`。
- **标记**：`TERM_PROGRAM=Latch` 与 `LC_TERMINAL=Latch`（ssh 默认把后者带到远端）。`pnpm latch` 据此不在 Latch 终端里显示配对链接与离线连接码，要用 `--code-file`。标记只防无意显示，不防有意绕过。
- **区域**：没有区域设置时设 `LANG=en_US.UTF-8`，否则中文输入输出会被当作单字节。
- **最后去掉**（不分大小写的前缀）：保留前缀（`RESERVED_ENV_PREFIXES`，含 `LATCH_`，模型密钥在其中）、`NODE_`、`ELECTRON_`。模型密钥、设备凭据与 Host 设置都不进入 shell。

### 上限

| 项 | 上限 | 超出 |
| --- | --- | --- |
| 每个会话、每个项目的终端 | 各 8 个 | 429 `terminal-limit` |
| 全部终端 | 32 个（每个 512 KiB 回滚缓冲，合计 16 MiB） | 429 `terminal-total-limit` |
| 一次输入 | 64 KiB | 413 `terminal-input-too-large` |
| 组件尚未读取的输入 | 1 MiB | 429 `terminal-input-busy` |
| 每个终端的观看流 | 8 条 | 429 `terminal-streams` |
| 行列数 | 各 1 到 1000 | 400 `terminal-size-invalid` |
| 「加入对话」 | 每 10 秒 20 次 | 429 `terminal-extract-busy` |
| 启动 | 组件 10 秒内报告 `started` | 500 `terminal-start-failed` |

名额在等待文件夹检查与审计之前就计入，同时打开也不会超出；组件真实退出后才释放。

### 输出

- **回滚缓冲。** 只在内存中，每个终端 512 KiB，先丢弃最旧的输出；Host 停止后不保留。
- **流。** 先发终端摘要，再按偏移重放回滚缓冲（丢弃过旧输出后从第一个换行之后开始），然后是实时输出，两者不重叠。重连时带上最后的偏移，只收到之后的输出；偏移已不在缓冲中时先收到 `reset`。
- **流的背压。** 写入返回 false 时停止，传输排空后从缓冲继续，所以观看流不额外占用内存；落后超过缓冲的观看流收到 `reset`。摘要的变化（大小、前台程序、本地服务、退出）排在它之前的输出之后送达。
- **输出速率。** 一个终端每 250 ms 输出超过 2 MiB（8 MiB/s）时，Host 停止读取它直到这个窗口结束，终端中的程序随之等待，不占用其他会话的时间。
- **尺寸归属。** 打开终端的设备决定它的大小。其他设备调整大小是 409 `terminal-size-owner`，观看从不改变大小。
- **本地服务。** 从输出的完整行中找回环地址（`localhost`、`127.0.0.1`、`[::1]`；`0.0.0.0` 记为 `localhost`）上带端口的 http 或 https 网址，只保留协议、主机与端口，不保留可能带令牌的路径和查询。每个终端保留最新的 8 个，shell 结束时清空。只表示输出中出现过这个地址，不检查服务是否仍在监听。
- **名字。** 前台程序名与登录的 Harness 名去掉不可见字符、经 `redactSecrets`、截到 64 个字符。

### 加入对话

`attach` 只返回文本，不加入任何对话；页面把它放进草稿，由人发送。

- 取所选文本（最多 256 KiB），或输出的最后几行（只看最新的 256 KiB）；结果最多 200 行、32,000 个字符，保留最新的。
- 去掉转义序列，应用回车、退格、行擦除，以及光标移动留下的空隙或换行；光标位置按每 4096 列折回。读取窗口从一行中间开始时丢掉不完整的第一行。去掉不可见的格式字符。
- 先脱敏再截断：`redactLineSecrets`（私钥正文与跨行折开的密钥，整行替换）与 `redactKnownSecrets`。
- 结果标明是否截断（`truncated`）、是否替换过内容（`redacted`）、是否可能含秘密（`mayContainSecret`）。
- 处理时间与输入长度成正比，任何构造的输入都一样。
- **脱敏按形状猜测，只是尽力而为**：附加前页面必须让人看到文本并提示。

### 关闭与会话结束

- **关闭。** 前台有 shell 以外的程序（或登录命令在运行）时，关闭需要 `force`（客户端在人确认后发送），否则 409 `terminal-busy` 并带上程序名。
- **归档与删除。** 单个与批量的归档、删除路由在动手之前调用 `checkSessionEnd`：

| 入口 | 会话还有终端时 |
| --- | --- |
| 这台电脑 | 有终端忙：409 `terminal-busy`（客户端询问后带 `force` 关闭那个终端再重试） |
| 其他入口 | 有终端在运行：409 `terminal-running`，会话不变，也不结束这台电脑上的 shell |

- 检查通过后才归档或删除；成功后由 `sessionArchived` 与 `sessionDeleted` 结束这个会话的所有终端。所以因其他原因被拒绝的删除（如 409 `task-running`）不结束任何 shell；检查与保存之间打开的终端也随会话结束。
- **Host 停止。** `hostStopping` 结束所有终端并拒绝再打开（503 `terminal-stopping`）。

## 登录命令

`POST /link/api/harnesses/:id/login-terminal` 带 `terminal: { sessionId?, cols, rows }` 时，Host 在 Latch 终端里运行这个 Harness 自己的登录命令（`routes/agent-login.ts`；登录本身见 [HARNESSES.md](HARNESSES.md)）。不带 `terminal`，或 Host 不给这台设备 Latch 终端时，用这台电脑默认的终端 App。

- **命令只由 Host 决定。** 调用方只点名 Harness，最多再点名它声明过的一个登录方式；命令来自预设或 Agent 的声明，与交给默认终端的是同一条（`loginTerminalScript`）。正文是 strict 的，多出的字段一律 400。没有这个 Harness 或它没有登录命令时 404 `harness-no-login`（Claude Agent 就是这样）。
- **谁能用。** 与其他终端相同：`host.sock`、`run`、数据范围 `all`。手机和远程浏览器不因此得到终端，那里只显示可复制的命令。
- **脚本不经你的 shell 解析。** Host 把脚本写成一个 0700 的临时文件（名字随机；临时目录的路径不是普通字符时改用 `/tmp`），终端运行你的登录 shell 加 `-i -c 'exec /bin/sh <文件>'`：交给 shell 的只有一个路径。仍是交互式登录 shell，所以命令能找到 profile 配好的东西（例如版本管理器里的 Node）。
- **退出码。** 登录命令是脚本的最后一行，它的退出码就是终端的退出码，终端随命令结束。脚本先删除自己；shell 没来得及运行它时，文件随终端一起删除。
- **在哪里。** 带 `sessionId` 时是那个会话的一个终端，在会话的文件夹里，计入它的 8 个名额。不带时记在保留的标识 `harness-login`（`HARNESS_LOGIN_SESSION`）之下，在家目录里：没有会话用这个标识，在它之下只能打开登录命令。观看、输入、调整大小与关闭仍走 `/link/api/tasks/harness-login/terminals/…`，规则不变。
- **算作忙碌。** `TerminalSummary.login` 是 `{ harnessId, name }`。登录命令和 shell 在同一个进程组里，系统不会把它报告成前台程序，所以命令运行期间终端一律算忙：关闭要确认，会话归档、删除与安装更新都等它。
- **输出不离开终端。** 登录会打印设备码和带码的链接。它们只在回滚缓冲与这台电脑的观看流里，不进日志、审计、会话或发给其他设备的事件；登录终端不接受「加入对话」（409 `terminal-login-output`）。
- **审计。** 先写 `agent.login.opened`（只含 Harness 的 ID；Agent 声明的方式带 `source: 'harness'`），再由终端服务写 `terminal.open`，都在 shell 启动之前；任何一条写不进就不启动。不需要本机确认。
- **结束之后。** 命令结束或终端被关闭时，Host 丢掉记住的登录状态，下一次 `login-status` 重新运行状态命令。页面在命令以 0 退出后带 `fresh` 再问一次，只按 Harness 自己的回答显示「已登录」；退出码本身不算登录。被拒绝的那一轮消息不自动重发，由人按「重试」。

## 界面

`apps/web/src/shell/TerminalDock.tsx` 把终端显示在对话下方，或作为右侧面板的「终端」页签：同一个组件，同一时间只在一处（页签的右键菜单「移到底部」「移到右侧面板」），⌘J 与填入命令都去它所在的地方。这里只写界面必须守的规则：

- **入口。** 只在 Host 给出 `catalog.features.terminal` 时出现。归档的会话、来自已移除 Agent 的旧会话、手机和远程浏览器没有入口。文件夹由 Host 决定，页面从不传路径。
- **展开即开。** 底部终端在屏幕上而目标还没有终端时，读完列表就开第一个（每次展开至多一次），没有中间按钮；开不了时只写原因和它的一个动作（重试，或设备、文件夹、连接的原因）。关闭最后一个页签同时收起底部终端；「重新打开」换掉的终端不算。
- **页签。** 终端图形、名字、末尾的 ×：× 占着自己的位置，悬停、焦点在页签内或触屏上的选中页签时显示；中键、Delete 与右键菜单也关闭。前台有程序时图形换成运行中的标记。
- **关闭。** 先不带 `force` 关闭；Host 回答 409 `terminal-busy` 时询问，确认后带 `force` 再关。
- **分屏。** 一个页签可以把 2 到 4 个终端排成一个方向的窗格（左右或上下）：页签行「+」旁的两个按钮、页签与窗格的右键菜单、⌘\ 与 ⇧⌘\（只在桌面端）。每个窗格是普通的 Host 终端，和新页签一样开在会话的文件夹、计入同样的上限；哪些终端同页签是这台设备的布局（`panes.ts`，按设备与目标存在浏览器里），Host 与其他设备看到的仍是各自的终端。
  - 新窗格在聚焦窗格之后，分走它一半；满 4 个时新终端另开页签；另一方向的分屏尚未实现（先保持简单，不做嵌套）。
  - 窗格之间一条细线，拖动调大小（每个窗格至少 20 列或 4 行），双击均分，大小按页签记住；每个窗格按自己的框调整行列。
  - 点按或 ⌥⌘] / ⌥⌘[ 换聚焦窗格；输入、「加入对话」、选区动作与「在终端里打开」都去聚焦窗格，脚部写它的 shell 与文件夹。窗格的头写名字、结束状态与「重新打开」和 ×；关掉的窗格把位置让给同页签的其他窗格，最后一个关掉即关页签。页签名在多于一个窗格时带数量（「终端 1 · 3」），关闭页签关掉其中所有终端，忙的一起询问一次。
  - 区域放不下两个 40 列的窗格（或上下排时每个窗格放不下 4 行）时，窗格逐个显示为页签，布局保留，变宽后恢复。
  - 分屏与换窗格的键归工作台，xterm 不把它们编码给 shell。
- **尺寸。** 只有打开它的设备（`sizeOwner`）按面板大小调整（停稳 120 ms 后发 `resize`），其他设备按 Host 的大小显示。
- **流与重连。** 每个终端一条流，页签或底部终端折叠时仍保持；切到其他目标时原 shell 在 Host 继续运行，回来重放。断开后带最后的偏移重连（退避 0.5 到 8 秒），`reset` 时清屏后接着显示，`closed`、404 或 403 时页签移除。
- **底色。** xterm 自带样式把行下的余量画成黑色；视口改用画布色，浅色与深色都与终端主题一致（底部终端、登录与填入对话框）。
- **背压。** 输出交给 xterm 后等它解析；尚未解析的超过 256 KiB 时停止读取响应，Host 的写入随之停下，页面内存不随输出增长。
- **输入不乱序、不重复。** 按 64 KiB 切开，一次一个按顺序发送；429 `terminal-input-busy` 时稍后重发同一段；其他失败丢弃之后排队的输入并在页签里说「输入可能没有送达终端」。
- **按键。** 终端有焦点时按键都交给终端（Ctrl、⌥、Esc、Tab），只有 ⌘ 组合键仍是 Latch 与系统的。
- **结束。** shell 退出后输出保留、不再接受输入，「重新打开」关闭旧终端、用同一编号开一个新的。
- **本地服务。** 桌面端点按在浏览器页签里打开整个源，⌘ 点按与其他客户端在系统浏览器中打开（[PREVIEW-BROWSER.md](PREVIEW-BROWSER.md#界面)）。
- **填入命令（「在终端里打开」）。** 只填入、不执行：页面把一行命令作为一次 bracketed paste（`ESC[200~…ESC[201~`）经同一条输入路由写入，从不带换行，由人按回车。多行、以反斜杠结尾、超过 1000 个字符、含控制、不可见或改变方向的字符（`escapeSecurityText` 检查），或仍在生成的命令不填入。只填进 shell 正在提示符处等待的终端：`TerminalSummary.prompt` 存在（Host 按输出里最后一次 DECSET 2004 开关判断，shell 运行命令前会关掉它；每回到提示符计数加一）、不忙、不是登录终端，且这次提示符还没填过（两条命令不会接在同一行）；当前页签不满足就开新页签并等到满足，等不到（例如不支持 bracketed paste 的 shell）就不填，并关闭为它新开的终端。会话的命令进会话的终端；没有会话（设置、首次设置）时进默认项目的终端，显示在对话框里。不审批、不审计，输入内容照常不记录。
- **加入对话。** 有选区发选区，否则取最后 40 行；结果只进输入框草稿，不发送。截断时注明较早的输出未包含，`mayContainSecret` 时提示发送前检查草稿。
- **登录。** 登录终端没有「加入对话」，结束后也没有「重新打开」。没有会话时在对话框里（`LoginTerminalDialog`）：以 0 退出自己关闭，失败时留着供阅读，运行中关闭先询问。同一个 Harness 的登录还在运行时，再按只把它带到眼前，不开第二个。页面每秒读一次终端列表来跟随运行中的登录（`loginRuns.ts`）。
- **你的账户，不是沙箱。** 底部终端脚部的「shell · 文件夹」在悬停与键盘焦点时说明它以你的账户运行、不是沙箱，不另占一行；登录对话框写在说明行里。

## 路由

会话用 `/link/api/tasks/:id/terminals`，项目用 `/link/api/workspaces/:id/terminals`（默认目录的 ID 为 `default`），没有会话的 Harness 登录用 `/link/api/tasks/harness-login/terminals`。类型在 `packages/protocol/src/terminal.ts`。

每条路由在读取请求正文之前检查 `host.sock`、`run` 与数据范围 `all`，读完正文后再查一次。

| 路由 | 正文与结果 |
| --- | --- |
| `GET …/terminals` | `{terminals}` |
| `POST …/terminals` | `{cols, rows}`；201 `{terminal}` |
| `POST …/terminals/:tid/input` | `{data}`（base64，解码后最多 64 KiB）；`{accepted: true}` |
| `POST …/terminals/:tid/resize` | `{cols, rows}`；`{terminal}` |
| `POST …/terminals/:tid/close` | `{force?}`；`{closed: true}` |
| `POST …/terminals/:tid/attach` | `{lines?, selection?}`；`TerminalText` |
| `GET …/terminals/:tid/stream?from=<偏移>` | SSE |

- **能力标记。** `catalog.features.terminal` 只在真能打开终端时出现：这台电脑上、设备有 `run` 且数据范围为 `all`、组件可用。其他设备的快照里没有它。
- **流的事件。** `terminal`（摘要）、`output`（`{offset, data}`，`data` 是 base64）、`reset`（`{offset}`），每 15 秒一行注释心跳。终端关闭或 Host 停止时最后发 `closed`；没有 `closed` 就结束的流是被切断的，客户端带上最后的偏移重连。
- **流跟着凭据走。** 凭据失效、设备被撤销或失去 `run` 与数据范围 `all` 时，流随之结束。
- **输入的顺序。** Host 按到达顺序写入终端，并发的请求可能交错：客户端要等上一次输入返回后再发下一次。
- **信号。** 服务与组件能向前台进程组发信号，但没有路由；中断程序靠输入里的 Ctrl-C。
- 已结束的终端收到输入是 409 `terminal-ended`；不属于这个目标或不存在的终端是 404 `terminal-not-found`。

## 限制

- 自行脱离会话的守护进程（`setsid`）不在终端的进程组里，关闭终端不会结束它们。shell 自行退出时，用 `nohup` 或 `disown` 留在后台的程序继续运行，与其他终端相同。
- 以其他用户身份运行的程序（如 `sudo`）不能由组件发信号，关闭时只收到 pty 的挂断。
- Host 杀死没有及时结束的组件时，只剩内核对 shell 的挂断，不在 shell 进程组里的程序可能继续运行。
- 重放的是原始字节：保留窗口之前设置的终端模式（备用屏幕、鼠标模式等）不会重放。
- 程序逐字节写入终端时（例如行缓冲的 `yes | head`），吞吐受 macOS pty 本身限制。

## 测试

用例在 `apps/host/test/terminal-*.test.ts`、`agent-login.test.ts`、`apps/web/test/terminal-model.test.ts`、`terminal-panes.test.ts` 与 `login-terminal.test.ts`；运行方式见 [TESTING.md](TESTING.md)。

- `terminal-helper.test.ts` 只在 macOS 上构建并运行真实组件；`terminal-service.test.ts` 与多数路由用例用假组件。
- `e2e/desktop-terminal.e2e.ts` 与 `e2e/desktop-login-terminal.e2e.ts` 需要 `LATCH_ELECTRON_E2E=1`，仅 macOS。前者配假组件；后者用真实组件配 `/bin/sh` 与夹具里的假登录脚本，不运行任何真实 Harness 的登录。
- 没有被证明的：粘贴载荷来自测试事件，系统剪贴板与原生 ⌘V 要实机验证。
