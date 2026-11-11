---
description: 终端：latch-pty 组件与帧协议，Host 终端服务的输入规则、会话文件夹、环境、上限、回滚缓冲、尺寸归属、输出背压、本地服务与「加入对话」，以及限制。
sources:
  - native/macos/LatchTerminal.swift
  - apps/host/scripts/build-terminal.ts
  - apps/host/src/terminal
  - apps/host/src/routes/terminal.ts
  - packages/protocol/src/terminal.ts
  - apps/host/test/terminal-routes.test.ts
  - apps/host/test/terminal-helper.test.ts
  - apps/host/test/terminal-service.test.ts
  - apps/host/test/terminal-environment.test.ts
  - apps/host/test/terminal-output.test.ts
  - apps/host/test/terminal-frames.test.ts
  - apps/host/test/terminal-cli.test.ts
  - apps/host/scripts/latch.ts
---
# 终端

终端是这台电脑上以你的账户运行的登录 shell，和「终端」App 里打开的 shell 权限相同。Latch 的审批、路径检查与出站策略都不适用于在其中运行的命令；它不是沙箱，也不隔离任何东西。

macOS 组件 `latch-pty`、终端服务（`apps/host/src/terminal/`）与 HTTP 路由（`apps/host/src/routes/terminal.ts`）已实现，只有这台电脑（`host.sock`）能用。界面尚未实现，所以页面上还打不开终端。其他系统上终端尚未实现：组件只有 macOS 版本，服务返回 501 `terminal-unsupported`。

Harness 的登录命令不走这里：页面还没有终端界面，所以「在终端里登录」用这台电脑默认的终端打开（见 [HARNESSES.md](HARNESSES.md)）。

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

## 路由

都在 `/link/api/tasks/:id/terminals` 之下，类型在 `packages/protocol/src/terminal.ts`。每条路由都只接受 `host.sock`，需要 `run` 与数据范围 `all`：其他入口在读取请求正文之前就得到 403 `local-only`，数据范围为 `work` 的设备得到 403 `terminal-scope`，因为 shell 能读到这个账户能读的一切，包括 Host 的数据目录。

| 路由 | 正文与结果 |
| --- | --- |
| `GET …/terminals` | `{terminals}` |
| `POST …/terminals` | `{cols, rows}`；201 `{terminal}` |
| `POST …/terminals/:tid/input` | `{data}`（base64，解码后最多 64 KiB）；`{accepted: true}` |
| `POST …/terminals/:tid/resize` | `{cols, rows}`；`{terminal}` |
| `POST …/terminals/:tid/close` | `{force?}`；`{closed: true}` |
| `POST …/terminals/:tid/attach` | `{lines?, selection?}`；`TerminalText`。只返回文本，不加入任何对话 |
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

桌面端安装更换 Host 的更新前，正在运行命令的终端算作忙碌，安装等它结束；终端里报告的本地服务只在等待界面列出，随终端一起结束（[UPDATES.md](./UPDATES.md#安装门禁与-host-安装窗口)）。
