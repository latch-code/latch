<p align="center"><img src="apps/web/public/icon.png" width="96" height="96" alt="Latch"></p>

<h1 align="center">Latch</h1>

<p align="center">跨电脑与手机的 AI Agent 工作台：调用你电脑上已经装好的 Agent，在任何设备上接着干。</p>

Latch 在你的电脑上运行一个 Host。Host 持有会话、执行权限、密钥、设备登记与审计；Latch 桌面端、这台电脑上的浏览器和手机连接同一个 Host，看同一份进度、批准同一个操作、取消同一个任务。关闭页面不会取消任务，断线后从 Host 的状态恢复。

每个会话组合三样东西：

- **Harness**：你本机已安装的 Agent（见下表），或 Latch 内置的执行循环（ID `standard`）。
- **模型**：Harness 自己登录的模型，或你在 Latch 里添加的模型服务（Chat Completions、Responses 或 Anthropic Messages 协议）。
- **项目**：一个或多个文件夹，第一个是主文件夹。

macOS 可在构建后运行 `pnpm package:desktop -- --out /绝对路径/Latch.app` 生成供本机验收的 ad-hoc 签名应用。它包含 Host、页面、本机组件与 `latch`，运行时不需要源码或 pnpm。请自行安装满足下表版本要求的系统 Node，应用启动时会检测。正式签名、公证和发布下载尚未提供。

包内命令位于 `Latch.app/Contents/Resources/bin/latch`。设置 › 通用 › 这台 Mac › 命令行可将它链接到 `~/.local/bin/latch`，并保留已有命令和 shell 配置。应用终端会把包内目录加入初始 PATH，登录 shell 仍可重新排序。链接成功或遇到占用时，可从设置复制包含包内绝对路径的命令。`latch status` 查看节点，`latch stop` 停止节点，`latch --help` 列出其他命令。源码入口是 `pnpm latch`。关闭应用后 Host 继续运行。

## 要求

| 项目 | 要求 |
| --- | --- |
| 系统 | macOS（完整功能）；Linux 可运行但没有本机确认；Windows 不能运行 Host（见「平台限制与尚未实现」） |
| Node.js | 24.22.1（`.node-version`）；也接受 22.x ≥ 22.23.4 与 ≥ 26.12.1，其他版本被 `engines` 拒绝 |
| pnpm | 11.28.6（`packageManager` 固定） |
| 本机确认组件 | macOS 上需要 Xcode 命令行工具（`xcode-select --install`），用 `swiftc` 构建 |
| 原生连接组件 | Go 1.26.10（`.go-version`），只在构建时使用；`LATCH_RELAY_GO` 指定编译器。接受的版本见 [docs/TESTING.md](docs/TESTING.md) |
| 其他设备（手机、另一台电脑）经网页或桌面端接入 | 你自己提供的 HTTPS 证书（例如 Tailscale 的 `tailscale cert`） |

## 先装好一个 Harness

Latch 不下载、不安装 Agent，也不代为登录。在运行 Host 的电脑上装好并按它自己的方式登录其中一个，新会话就能选它：

| Harness | 安装 | Latch 运行的命令 | 许可证 |
| --- | --- | --- | --- |
| [Codex](https://github.com/openai/codex) | `npm i -g @openai/codex` | `codex app-server`（只装了 `codex-acp` 时经它） | Apache-2.0 |
| [Claude Agent](https://github.com/agentclientprotocol/claude-agent-acp) | `npm i -g @agentclientprotocol/claude-agent-acp` | `claude-agent-acp`（运行 Claude Code，用它已有的登录） | Apache-2.0 适配器；Claude Code 专有 |
| [pi](https://github.com/earendil-works/pi) | `npm i -g @earendil-works/pi-coding-agent` | `pi --mode rpc` | MIT |
| [OpenCode](https://github.com/anomalyco/opencode) | `npm i -g @opencode/cli` | `opencode serve`（2.2.6 起，只听本机回环；更早的版本经 `opencode acp`） | MIT |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | `npm i -g @deepseek-ai/dsh` | `dsh --profile acp` | MIT |
| [Qwen Code](https://github.com/QwenLM/qwen-code) | `npm i -g @qwen-code/qwen-code` | `qwen --acp` | Apache-2.0 |
| [goose](https://github.com/block/goose) | `brew install block-goose-cli` | `goose acp` | Apache-2.0 |
| [Cursor](https://cursor.com/docs/cli/acp) | 见链接 | `cursor-agent acp`；定义在这台 Mac 上带 `CURSOR_API_KEY` 时改用官方 SDK `@cursor/sdk`，不逐次询问 | 专有（Cursor 服务条款） |
| [Antigravity](https://antigravity.google/docs/ide/extensions/acp/) | 见链接 | `agy acp …` | 专有（Google Antigravity 条款） |
| [Grok Build](https://docs.x.ai/build) | `npm i -g @xai-official/grok` | `grok … agent stdio` | Grok Build 发布版条款；开源源码 Apache-2.0 |

- 每个预设的最低版本、登录命令、权限模式与已知限制见 [docs/HARNESSES.md](docs/HARNESSES.md)。预设定义在 `packages/protocol/src/agent-presets.ts`。
- 自定义命令在「设置 → Harness」填写。新增 Harness 或改它的命令、参数、环境变量要在这台 Mac 上确认一次，因为它决定运行哪个程序。
- 这些 Agent 是与 Host 同权限运行的本机代码，Latch 不给它们加操作系统沙箱（见「安全边界」）。
- Latch 内置的 Harness 没有自己的登录，要先添加一个模型服务（见「模型服务」）。

## 安装与首次运行

```sh
pnpm install
pnpm build      # host、web、relay，macOS 上另有本机确认组件
pnpm desktop    # 启动 Host 并打开 Latch 桌面端（推荐）
# 或：pnpm start，再运行 pnpm latch device invite --loopback，在浏览器中打开它给出的链接
```

- `pnpm start` 打印 `http://h-<hostId>.localhost:4317/link/` 形式的地址。每台 Host 用自己的 `h-<hostId>.localhost`，不同 Host 的 Cookie 因此互不混用。
- **只有桌面端算这台电脑。** 回环端口可能被隧道或端口转发连到别处，所以这台电脑上的浏览器与手机一样是远程设备，连接前要一次性邀请：`pnpm latch device invite --loopback`（10 分钟内有效、只能用一次）。
- **连接要在电脑上确认。** 这台 Host 还没有任何设备时，桌面端的第一次连接不需要确认；之后每台设备连接，电脑上都弹出 Touch ID 表单（或登录密码），写着设备的名称。只在你正在连接这台设备时确认。
- 设备凭据每 24 小时自动续期，从连接起 30 天后失效，届时重新连接。
- **不配置模型体验流程：** `pnpm start:demo` 或 `pnpm desktop -- --demo` 使用显式启用的演示模型，界面会标注；文件工具真实执行。真实模型服务失败时报错，不会回退到演示模型。

**本机确认组件**（`dist/native/latch-presence`）：

- `pnpm build` 构建它并做 ad-hoc 签名，也可单独运行 `pnpm build:presence`；`pnpm start` 发现它缺失时会尝试构建。缺少 Xcode 命令行工具时没有本机确认。
- Host 记录组件的签名。重新构建使签名变化后本机确认不可用：停止 Host，运行 `pnpm latch presence repin`，再启动。
- 本机 ad-hoc 签名应用沿用上述 CDHash 固定。发布身份构建通过 `--presence-team <公开 Apple Team ID>` 将 Developer ID、团队与 `dev.latch.presence` 要求编入 Host 与启动器；它不会调用钥匙串或代签名，所有者签名完成前确认功能拒绝运行。已有 CDHash 数据目录须在 Host 停止后显式运行 `latch presence repin` 迁移，先写审计；同身份的后续更新不需要重新固定。身份模式不会回退到开发组件。
- `pnpm latch presence status` 查看状态；`pnpm latch presence test` 显示一次示例确认，确认或拒绝都不改变设置。

**本机确认不可用时**（Linux、未构建组件）用离线连接码连接桌面端：停止 Host，运行 `pnpm latch device enroll --offline`，再 `pnpm desktop`，在桌面端的连接页填写这个码。码 15 分钟内有效、只能用一次，只有桌面端接受；它依赖此刻本机没有恶意的同用户进程。浏览器与手机的连接都需要本机确认，这时无法完成。

**连上之后哪些事还要确认。** 信任在连接设备时建立一次：连上的设备凭自己的权限范围工作，开始会话、放宽权限模式、批准操作都不再确认，只留审计记录。仍要在这台 Mac 上确认的只有：连接新设备与为设备增加权限，第一次使用一个自定义或本机模型服务地址与放行出站地址，应用含代码的插件或更宽的页面能力，新增或放宽本机程序（MCP 服务器、Harness 命令）。代价是：拿着已解锁手机的人可以操作这台 Mac 上的 Agent，直到你移除这台设备。

## 桌面端

`pnpm desktop`（先 `pnpm build`）：

- 为解析出的数据目录在后台启动 Host（日志在 `<数据目录>/host.log`），或复用已在运行的 Host。复用时本次的启动参数与模型环境变量不生效：要改启动配置，先 `pnpm stop`。
- 重新 `pnpm build` 后，空闲的 Host 会先重启再打开窗口（「检测到新的构建，已重启 Host。」）；有会话正在运行或等待审批时不重启，结束后在窗口里点「重启 Latch」。
- 只经 `<数据目录>/host.json` 与 `host.sock` 找到并核对 Host，不做网络探测。页面的请求由 Electron 主进程经 `host.sock` 转发，页面接触不到设备密钥与凭据。
- 设备密钥与凭据用系统安全存储加密，保存在桌面端数据目录（macOS 为 `~/Library/Application Support/Latch/Desktop/`）的 `latch-devices/<hostId>.json`。没有可用的安全存储时桌面端拒绝启动。
- 上面列出的本机确认只能从这台电脑的桌面端发起。模型密钥、模型服务地址的确认与添加项目另可在 Host 停止时用 `pnpm latch` 完成。
- 关闭窗口不会停止 Host，用 `pnpm stop` 停止。
- 自动更新只在已打包且已签名的应用里工作，源码运行时不提供（[docs/UPDATES.md](docs/UPDATES.md)）。

机制见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#桌面端与其他电脑)，崩溃后重启与休眠见[同一文档](docs/ARCHITECTURE.md#host-的生命周期)。

## 模型服务

在「设置 → 模型」添加模型服务、取模型列表、设默认模型。

- **密钥只在这台 Mac 上填写**：在桌面端，或 Host 停止时运行 `pnpm latch provider set-key <服务 ID>`（从不回显的终端或标准输入读取）。密钥保存在数据目录的 0600 文件中，不返回任何设备，不写入日志，并且只发往保存时的服务地址。
- **自定义与本机地址要确认一次**：预置服务商以外的地址（自定义网关、Ollama、LM Studio 等）第一次使用前在桌面端确认，或在 Host 停止时运行 `pnpm latch provider confirm <服务 ID>`。确认之前 Latch 不向它发送请求。
- **出站策略**：Host 发出的模型请求默认拒绝本机回环、私网、链路本地与云元数据地址，拒绝跨源重定向；确认本机或局域网地址时把它的 `host:port` 加入出站白名单。它只约束 Host 自己的模型请求，不约束插件与 Agent 自己的网络访问。
- **撤销确认**：在桌面端的模型设置里移除已确认的地址，使用它的服务随即停止。没有桌面端时先停止 Host，再从 `<数据目录>/policy.json` 的 `confirmedAddresses` 移除这个地址，本机或局域网地址另从 `hostEgressAllow` 移除它的 `host:port`；Host 运行时的修改不生效。
- **fake-IP 透明代理**（系统 DNS 返回 `198.18.0.0/15`）下，模型服务会被当作特殊用途地址拒绝：把它的 `host:port` 加入出站白名单，或在代理中为它关闭 fake-IP。
- **临时服务**：`LATCH_BASE_URL`、`LATCH_MODEL`、`LATCH_API_KEY` 为本次运行提供一个服务，不写入数据目录（见 [.env.example](.env.example)）。`LATCH_BASE_URL` 不能包含用户名、密码、查询参数或片段，它的 `host:port` 自动加入本进程的出站白名单。
- **给 Harness 用**：部分 Harness 可以经 Latch 使用这里保存的服务，Harness 拿到的是随进程失效的凭据，不是密钥。哪些 Harness、哪些协议见 [docs/HARNESSES.md](docs/HARNESSES.md#经-latch-使用模型服务) 与 [docs/MODEL-GATEWAY.md](docs/MODEL-GATEWAY.md)。

## 手机接入（HTTPS）

其他设备上的浏览器（例如手机）只通过 HTTPS 接入，证书由你提供，Latch 不生成自签名证书，也没有明文局域网接入。这台电脑上的浏览器走回环地址，见「安装与首次运行」。以 Tailscale 为例（需启用 MagicDNS 与 HTTPS 证书）：

```sh
mkdir -p ~/latch-tls && cd ~/latch-tls
tailscale cert my-mac.example.ts.net          # 生成 my-mac.example.ts.net.crt 与 .key
chmod 600 my-mac.example.ts.net.key
pnpm desktop -- --tailnet \
  --tls-cert ~/latch-tls/my-mac.example.ts.net.crt \
  --tls-key  ~/latch-tls/my-mac.example.ts.net.key \
  --public-origin https://my-mac.example.ts.net:4318
```

- `--tls-cert`、`--tls-key`、`--public-origin` 必须同时提供。给了 `--lan`、`--tailnet`、`--tls-host` 或非回环的 `--host` 却缺其中任何一项时，Host 拒绝启动。
- 监听地址必须是具体的 IP：`--tailnet` 取本机的 Tailscale 地址，`--lan` 取第一个私网 IPv4，`--tls-host <IP>` 指定；公开地址的主机本身是 IP 时可省略。不接受主机名与 `0.0.0.0`、`::`。
- 私钥必须是你拥有的 0600 普通文件，且不在数据目录或项目目录内；证书要与公开地址的主机名匹配。证书剩余不足 14 天时 Host 写日志提醒，Latch 不续签；续签后直接覆盖文件，Host 自动重新加载，不需要重启。
- HTTPS 入口只接受 TLS 1.3，并断开来自本机网卡地址的连接：请用另一台设备测试（手机也要加入同一 tailnet）。
- 该数据目录的 Host 已在运行时，`pnpm desktop` 复用它而忽略这些参数，请先 `pnpm stop`。

**配对手机上的浏览器：**

1. Host 运行时执行 `pnpm latch device invite`，终端显示二维码。邀请 10 分钟内有效、只能用一次，Host 重启后失效。
2. 手机扫码打开页面并提交连接。
3. 电脑上弹出确认表单，写出设备自报的名称；确认是你正在连接的设备后允许。

邀请默认不含管理权限；`--scopes view,run,approve:standard,approve:elevated,admin` 可以加入。撤销一台设备时（`pnpm latch device revoke <设备 ID>`），由它邀请配对的设备降为仅查看，等待复核。

**iPhone 与 iPad 上的 Latch App** 不走这个 HTTPS 入口：在桌面端的「设置 → 设备」选「连接手机」，用 App 扫码，再在 Mac 上确认一次。

- 配对时手机要和这台 Mac 在同一个局域网。之后同一网络直连，其他网络可经[自己的中继](docs/RELAY.md)接入（Linux 服务器，或自己 Cloudflare 账户上的 Workers 中继）。在这台 Mac 的「设置 › 连接转发」导入，经本机确认后生效。Workers 中继在源码目录两条命令部署与验收：`pnpm relay-edge:setup --region ne`、`pnpm relay-edge:accept --name ne`；中继文件都放在 `~/.latch/relays`（0700），添加后可删除中继文件，保留 `.admin-header`。
- 没有账号和云端用户库，不使用 P2P 或 NAT 穿透。设备、权限与会话都由 Mac 上的 Host 决定。
- 中继只转发 Host 与已获准设备之间的连接，读不到端到端正文，也不能签发设备权限或替换 Host 身份；它的运营方仍能看到 IP、时间、填充后的大小与连接关系。
- 局域网入口默认自动选择；`--native-host <具体 IP>` 与 `--native-port <端口>` 把它固定在一个地址。

**添加另一台电脑（桌面端）：** 一台 Mac 的桌面端可以连接另一台 Mac 的 Host。

1. 在被连接的电脑上按上面的方法配置 HTTPS，运行 `pnpm latch device invite --code-file <新文件>`（或在它的桌面端「设置 → 设备」点「复制链接」），把文件或链接带到这台 Mac。
2. 在这台 Mac 的「设置 → 电脑」点「添加电脑」。链接与连接码只由主进程读取，页面看不到。
3. 被连接的电脑上弹出确认表单；核对两边的校验码后允许。

每台电脑一份独立的设备凭据。证书必须受这台 Mac 信任，没有「仍然信任」的选项；那台电脑换了证书后要在「设置 → 电脑」里「信任新证书」。那台电脑的会话在它自己的窗口里，页面来自它自己的 Host，看不到这台 Mac 的文件。

## 启动参数与环境变量

`pnpm start`、`pnpm start:demo` 与 `pnpm desktop` 接受同一组参数（`pnpm desktop -- <参数>`）：

| 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--data-dir <目录>` | `LATCH_DATA_DIR` | 见「数据与工作区」 |
| `--workspace <目录>` | `LATCH_WORKSPACE` | `~/Latch/workspace` |
| — | `LATCH_WORKTREES_DIR` | 启动目录旁边的 `worktrees`（默认 `~/Latch/worktrees`） |
| — | `LATCH_AGENTS_DIR` | 平台数据目录下的 `Agents`（macOS 为 `~/Library/Application Support/Latch/Agents`） |
| `--port <端口>` | `LATCH_PORT` | `4317`，回环 |
| `--tls-cert`、`--tls-key`、`--public-origin` | `LATCH_TLS_CERT`、`LATCH_TLS_KEY`、`LATCH_PUBLIC_ORIGIN` | 不启用 HTTPS |
| `--tls-host <IP>`、`--lan`、`--tailnet` | `LATCH_TLS_HOST` | 见「手机接入（HTTPS）」 |
| `--tls-port <端口>` | `LATCH_TLS_PORT` | `4318` |
| `--native-host <IP>`、`--native-port <端口>` | — | 自动选择；指定地址后端口默认 `4319` |
| `--plugin <目录或模块>`（可重复） | — | 不加载 |
| `--harness <id>`、`--provider <id>` | — | 默认 Harness 与模型服务 |
| `--demo` | — | 关 |
| — | `LATCH_BASE_URL`、`LATCH_MODEL`、`LATCH_API_KEY` | 见「模型服务」 |

- 同时运行多个 Host 时，为每个 Host 使用不同的 `--data-dir` 与 `--port`。
- `--plugin` 加载含 `latch-plugin.json` 的插件包目录或单个模块（如 `./examples/release-review`、`./examples/text-statistics.mjs`）。Host 模块具有 Host 权限，只加载可信代码；Latch 不下载插件。编写方式见 [docs/PLUGIN-DEVELOPMENT.md](docs/PLUGIN-DEVELOPMENT.md)。
- 用环境变量配置的 Host（模型、HTTPS、端口、路径）在意外退出后不会被桌面端自动重启，因为桌面端没有这些变量。

## 命令行 `pnpm latch`

每个命令都接受 `--data-dir <目录>`，未指定时按「数据与工作区」中的顺序解析。`pnpm latch --help` 列出全部命令。

| 命令 | Host 状态 | 作用 |
| --- | --- | --- |
| `device list [--json]` | 运行中 | 列出已连接的设备 |
| `device revoke <设备 ID>` | 运行中 | 撤销设备；由它邀请的设备降为仅查看，等待复核 |
| `device invite [--scopes …] [--code-file <路径>]` | 运行中，已配置 HTTPS | 生成手机配对二维码 |
| `device invite --loopback [--scopes …] [--code-file <路径>]` | 运行中 | 生成这台电脑上浏览器用的一次性链接；不给 `--scopes` 时可以申请「管理此 Host」 |
| `device enroll --offline [--code-file <路径>]` | 已停止 | 生成桌面端用的一次性离线连接码（15 分钟） |
| `provider set-key <服务 ID> [--expect-url <服务地址>]` | 已停止 | 保存模型服务密钥；地址未确认时先列出它并一并确认 |
| `provider confirm <服务 ID> [--expect-url <服务地址>]` | 已停止 | 列出并确认模型服务的地址，本机或局域网地址同时加入出站白名单。在终端输入 `y`；非交互环境用 `--expect-url` 写出要确认的地址，不一致就不修改 |
| `project list [--json]` | 已停止 | 列出项目与其中的文件夹 |
| `project add <路径…> [--name <名称>] [--yes]` | 已停止 | 用这些文件夹新建项目，第一个是主文件夹 |
| `project add-folder <项目 ID> <路径…> [--yes]` | 已停止 | 把文件夹加入项目 |
| `project remove <项目 ID> [--yes]`、`project remove-folder <项目 ID> <文件夹 ID> [--yes]` | 已停止 | 移除项目或其中一个文件夹，文件不删除 |
| `presence status` | 任意 | 本机确认是否可用 |
| `presence repin` | 已停止 | 重新记录本机确认组件的签名 |
| `presence test` | 任意 | 显示一次示例本机确认 |
| `customization reset` | 任意 | 把外观恢复默认，历史保留；页面因自定义无法使用时的出路（[docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md)） |
| `audit verify` | 任意 | 只读校验审计记录的哈希链 |
| `traffic [--json]` | 运行中 | Host 本次启动以来发出的字节数与帧大小分布；只有数字与会话 ID |
| `diagnostics --out <文件>` | 运行中 | 导出诊断文件：版本、Harness 与插件状态、近期事件，不含日志原文、对话、文件内容与密钥。写入新建的 0600 文件，已存在时拒绝 |

- **项目命令**只在 Host 停止时可用（运行时请在桌面端添加）。它们逐个检查文件夹，列出真实路径并询问 `y/N`（非交互环境要 `--yes`），先写审计再保存。它们沿用上次 Host 的启动目录；首次启动之前要加 `--workspace <启动目录>`。
- **邀请与连接码**默认只打印到交互终端。非交互环境必须用 `--code-file <路径>`，内容写入本次新建的 0600 文件：目标已存在（包括符号链接）时拒绝；所在目录必须属于当前用户，或属于 root 且带粘滞位；macOS 上目录不能带访问控制列表，主目录下的常用文件夹通常带有，改用 `mktemp -d` 新建的目录。

## 数据与工作区

**数据目录**（已连接的设备、审计、安全策略、模型服务与密钥、会话）按以下顺序确定：

1. `--data-dir` 或 `LATCH_DATA_DIR`；
2. 当前目录下已存在的 `.runtime`（旧位置，继续使用并打印迁移提示）；
3. 平台默认：macOS `~/.latch/host`，Linux `${XDG_DATA_HOME:-~/.local/share}/latch/host`。macOS 上原先在 `~/Library/Application Support/Latch/Host` 的数据，由 Host 在下一次启动时整体移到新位置（一次改名，不复制），原位置留下一个说明文件。

**启动目录**：`--workspace` → `LATCH_WORKSPACE` → 数据目录内已存在的 `workspace`（旧布局）→ `~/Latch/workspace`（需要时创建）。

- 没有用 `--workspace` 或 `LATCH_WORKSPACE` 指定时，每个不在项目中的新 Agent 会话在启动目录中得到一个自己的新文件夹（权限 0700）；删除会话不删除它的文件夹。指定了启动目录时，会话直接在其中工作。
- **项目**在桌面端「设置 → 项目」或用 `pnpm latch project` 添加，每个项目最多 8 个文件夹。项目与文件夹只能在 Host 所在的电脑上添加。
- 主目录本身、含凭据的目录（`~/.ssh`、`~/.aws`、`~/.gnupg`、各 Agent 的配置目录等）、主目录下的隐藏目录、数据目录与 Latch 程序目录等位置不能作为启动目录或加入项目。完整规则见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
- 会话可以在新的 Git 工作树里开始，工作树放在 `LATCH_WORKTREES_DIR`。工作树只分开文件，端口、进程和这台电脑上的权限仍然共用（[docs/BRANCHES.md](docs/BRANCHES.md)）。
- 数据目录的内容、锁与恢复见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 停止 Host

```sh
pnpm stop                               # 默认数据目录
pnpm stop -- --data-dir <目录>
pnpm stop -- --force                    # 仍有会话在运行或等待审批时
pnpm stop -- --reason restart           # 告诉手机与浏览器原因：restart、update 或 shutdown
```

- `pnpm stop` 只在经 `host.sock` 核对进程、hostId 与实例之后才发停止信号。有会话在运行或等待审批时拒绝，加 `--force` 继续。在启动 Host 的终端里按 Ctrl+C 也可以停止。
- `<数据目录>/host.lock` 保证同一数据目录同一时间只有一个 Host 或离线 `pnpm latch` 命令在写入。
- `pnpm stop` 从不凭 `host.lock` 或无法识别的 `host.json` 发信号；遇到这些情况它说明原因并以状态 1 退出。只有确认没有 Host 或 `latch` 命令在使用该目录时，才手动删除它提到的文件。

## 平台限制与尚未实现

- **Linux**：没有本机确认。桌面端第一次连接不需要确认，之后用离线连接码；浏览器与手机无法连接，需要本机确认的操作都不可用。
- **Windows**：Host 依赖的每用户运行目录（`host.sock`）尚未实现，Host 无法启动。
- **安装包与自动更新**：可生成供本机验收的 ad-hoc 签名应用。正式的 Developer ID 签名及公证下载包、已签名的更新源尚未提供。
- **中继**：没有官方中继，用[自己的中继](docs/RELAY.md)（Linux 服务器或自己的 Cloudflare 账户）。
- **插件**：在线安装尚未实现，只加载本机的目录或模块。
- **iPhone 与 iPad**：还没有在真机上验收，测试夹具不能代替；手机上没有推送通知。

各机制的「尚未实现」写在对应的 `docs/` 文档里，从 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 查起。

## 安全边界

- Latch 约束的是「谁能让 Host 做什么」，不隔离执行的代码。插件、ACP Agent 与第三方 Harness 是可信的本机代码；工具审批、路径检查与出站策略是应用层约束，不是操作系统沙箱。完全访问的会话可以读写 Latch 的数据与 Host 身份私钥。
- 同一系统用户下的其他进程可以连接 `host.sock`、读取数据目录；Latch 的保护来自 0700 的运行目录。
- 每台设备持有自己的密钥，Host 只保存公钥与凭据哈希；授予或执行权限的操作先写入哈希链审计记录（`pnpm latch audit verify` 校验）。
- 不要把端口直接暴露到公网。即使回环端口被隧道转发出去，没有邀请也无法连接，转发进来的连接也不能发起本机确认。

安全模型与不防御的情况见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发与文档

改代码前读 [AGENTS.md](AGENTS.md)：命令、不变量、本机运行安全与完成标准都在那里；测试命令与选择回归见 [docs/TESTING.md](docs/TESTING.md)。手动查看界面时用独立的数据目录、工作区与端口：

```sh
pnpm start:demo -- --port 0 --data-dir <临时数据目录> --workspace <临时工作区>
pnpm stop -- --data-dir <同一数据目录>
```

| 主题 | 文档 |
| --- | --- |
| 整体架构、安全模型、路径、持久化、HTTP API | [ARCHITECTURE](docs/ARCHITECTURE.md) |
| 流式同步、重连、审批与取消的顺序 | [STREAMING](docs/STREAMING.md) |
| 接入本机 Agent、模型网关、模型配置 | [HARNESSES](docs/HARNESSES.md)、[MODEL-GATEWAY](docs/MODEL-GATEWAY.md)、[MODEL-CONFIGURATION](docs/MODEL-CONFIGURATION.md) |
| MCP 服务器 | [MCP](docs/MCP.md) |
| 我的 Agent、定时任务、交接、团队 | [CUSTOM-AGENTS](docs/CUSTOM-AGENTS.md)、[AUTOMATIONS](docs/AUTOMATIONS.md)、[HANDOFFS](docs/HANDOFFS.md)、[TEAMS](docs/TEAMS.md) |
| 改动记录、交付、分支与工作树、项目恢复 | [CHANGES](docs/CHANGES.md)、[GIT-DELIVERY](docs/GIT-DELIVERY.md)、[BRANCHES](docs/BRANCHES.md)、[WORKSPACE-RECOVERY](docs/WORKSPACE-RECOVERY.md) |
| 终端、预览浏览器 | [TERMINAL](docs/TERMINAL.md)、[PREVIEW-BROWSER](docs/PREVIEW-BROWSER.md) |
| 文件预览与编辑、运行期间的文件变化、附件 | [DOCUMENT-PREVIEWS](docs/DOCUMENT-PREVIEWS.md)、[FILE-OUTPUTS](docs/FILE-OUTPUTS.md)、[ATTACHMENTS](docs/ATTACHMENTS.md) |
| 插件、插件页面、连接插件 | [PLUGIN-DEVELOPMENT](docs/PLUGIN-DEVELOPMENT.md)、[APP-PAGES](docs/APP-PAGES.md)、[TRANSPORT-PLUGINS](docs/TRANSPORT-PLUGINS.md) |
| 界面设计、自定义外观、页面的按需加载 | [DESIGN](docs/DESIGN.md)、[CUSTOMIZATION](docs/CUSTOMIZATION.md)、[CLIENT-LOADING](docs/CLIENT-LOADING.md) |
| 桌面通知、桌面端更新 | [NOTIFICATIONS](docs/NOTIFICATIONS.md)、[UPDATES](docs/UPDATES.md) |
| 自建中继 | [RELAY](docs/RELAY.md) |
| 测试、大文档性能基准 | [TESTING](docs/TESTING.md)、[DOCUMENT-PERFORMANCE](docs/DOCUMENT-PERFORMANCE.md) |

## 许可证

源代码以 [MIT License](LICENSE) 授权。"Latch" 名称与图标不在该许可范围内。随产品分发的第三方组件与品牌图标保留各自的许可证，说明见 [apps/web/public/licenses/README.txt](apps/web/public/licenses/README.txt)。
