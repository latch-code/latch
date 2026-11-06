<p align="center"><img src="apps/web/public/icon.png" width="96" height="96" alt="Latch"></p>

<h1 align="center">Latch</h1>

<p align="center">跨电脑与手机的 AI Agent 工作台：自由组合 Harness 与模型，在任何设备上接着干。</p>

Latch 在你的电脑（执行端）上运行一个 Host。Host 持有会话、执行工具、保管密钥与已连接的设备；Latch 桌面端、这台电脑上的浏览器和手机连接同一个 Host，查看同一份进度、审批同一个操作、取消同一个任务。关闭页面不会取消任务，断线后从 Host 的状态恢复。

每个会话可以组合：

- **Harness**：Latch 内置的执行循环（ID `standard`），或通过 [Agent Client Protocol](https://agentclientprotocol.com)（ACP）接入的本机 Agent：开源的 Codex、pi、OpenCode、DeepSeek Harness、Gemini CLI、Qwen Code、goose，以及经官方命令接入的 Claude Agent（运行 Claude Code，用你在 Claude Code 中已有的登录）与 Cursor（用你自己的 Cursor 账号）。
- **模型**：OpenAI 兼容接口或 Anthropic 原生接口的模型服务，会话中可切换。
- **项目**：一个或多个文件夹，第一个是主文件夹，新会话在其中启动；Host 启动时的工作目录是「启动目录」。

需求包可组合技能、工具、React 会话界面、Provider 与完整 Harness，由 [Cordis](https://github.com/cordiverse/cordis) 统一管理生命周期；既可加载本地目录，也兼容原有模块插件。

界面提供流式回复、思考过程、工具卡片（参数、输出、文件差异）、计划进度与 token 用量；审批紧挨对应的工具；会话支持搜索、按项目分组、置顶、归档、重命名、导出 Markdown 与删除；桌面三栏（侧栏可拖动调宽或收起）、平板的图标栏与滑出的会话列表、手机以会话列表为首页并推入会话页，浅色、深色与跟随系统。

> 当前是开发版：没有签名安装包，从源码运行，所有客户端常驻显示「开发版」标记。

## 先装好一个 Harness

Latch 用 Harness 自己的登录，不需要 API 密钥。在这台 Mac 上装好并登录其中一个，Latch 打开就能用：

| Harness | 安装 | 登录与模型 |
| --- | --- | --- |
| Codex | 先装 Codex，再 `npm i -g @agentclientprotocol/codex-acp`（让 Latch 连接它的适配器） | `codex login` |
| pi | 先装 pi，再 `npm i -g pi-acp`（让 Latch 连接它的适配器） | 在 pi 里配置 |
| OpenCode | `npm i -g opencode-ai` | `opencode auth login` |
| DeepSeek Harness | `npm i -g @deepseek-ai/dsh`（0.2.1-rc.2 或更高版本） | 在 DeepSeek Harness 里配置 |
| Gemini CLI | `npm i -g @google/gemini-cli` | 运行 `gemini` 按提示登录 |
| Qwen Code | `npm i -g @qwen-code/qwen-code` | 运行 `qwen` 按提示登录 |
| goose | `brew install block-goose-cli` | `goose configure` |

还没登录时，Latch 会给出这条命令，在 Mac 的 Latch 里可以直接在终端打开它。登录过期后登录一次，点「重试」，会话接着走。Latch 从登录 shell 读 PATH、各家的 home 目录和代理设置，所以从 Dock 打开也用得上你在终端里配好的环境。

都没有也能看：Latch 内置只能读写文件、不能运行命令，要先添加一个模型服务。

## 要求

| 项目 | 要求 |
| --- | --- |
| 系统 | macOS（完整功能）；Linux 可运行但没有本机确认；Windows 暂不支持运行 Host（见「平台限制」） |
| Node.js / pnpm | Node.js 24.22.1（见 `.node-version`；也支持 22.x ≥ 22.23.4 与 ≥ 26.12.1，其他版本下 pnpm 命令直接报错），pnpm 11.28.6（`packageManager` 固定，已安装的其他版本 pnpm 会自动切换到它） |
| 本机确认组件 | macOS 上需要 Xcode 命令行工具（`xcode-select --install`），用于构建 Touch ID 确认组件 |
| 原生连接 TLS 组件 | Go 1.26.10（见 `.go-version`；也支持 1.26.x ≥1.26.10 与 1.27.x ≥1.27.3），仅标准库，源码构建时使用；可用构建变量 `LATCH_RELAY_GO` 指定编译器，运行时不下载或编译 |
| 手机接入 | 你自己提供的 HTTPS 证书（推荐 Tailscale 的 `tailscale cert`） |

## 安装与首次运行

```sh
pnpm install
pnpm build      # Host、页面与 macOS 本机确认组件（dist/native/latch-presence）
pnpm desktop    # 启动 Host 并打开 Latch 桌面端（推荐）
# 或：pnpm start，再用 pnpm latch device invite --loopback 得到的链接在浏览器中连接
```

`pnpm start` 会打印 `http://h-<hostId>.localhost:4317/link/` 形式的地址。每台 Host 用自己的 `h-<hostId>.localhost` 地址，因此不同 Host 的 Cookie 互不混用；直接访问 `http://localhost:4317/` 会被重定向到这个地址。

**只有桌面端算这台电脑。** 浏览器经回环端口（127.0.0.1）连接，而回环端口也可能被隧道或端口转发连到别的电脑，所以 Latch 把这台电脑上的浏览器与手机一样当作远程设备：连接前需要一次性邀请。在桌面端「手机」页选择「在浏览器中打开」（macOS），桌面端会生成邀请并用默认浏览器打开带邀请的地址；没有桌面端时运行 `pnpm latch device invite --loopback`，在终端里得到同样的链接。邀请 10 分钟内有效、只能使用一次。以前已经连接的浏览器照常使用，不需要重新连接。

**连接这台设备。** 第一次打开时页面是连接页：

1. 浏览器上只有一个按钮「连接这个浏览器」，名称取自浏览器（如「Mac 上的 Chrome」），之后可以在「手机」页改；桌面端第一次打开只有一句话和「继续」，名称取自这台 Mac。桌面端总是获得全部权限；从桌面端打开的浏览器得到查看、发起会话与批准操作，需要时在桌面端「手机」页开启它的「可以管理这台 Mac」（经本机确认）；`pnpm latch device invite --loopback` 的链接还可以管理这台 Mac（为没有桌面端的 Host），按钮上方写明这件事，点「不要」就不申请。「连接详情」折叠着校验码、系统窗口的句子和得到的权限；校验码和桌面端「手机」页等待中的那一行相同，才是这台设备。
2. 这台 Mac 上还没有连接过任何设备时，桌面端的第一次连接不需要确认。之后每台设备，电脑上都会弹出 macOS 的 Touch ID 表单，写着「允许「<名称>」连接这台 Mac」。只在你正在连接这台设备时确认。
3. 用 Touch ID 或登录密码确认。

设备凭据每 24 小时自动续期，从连接起 30 天后失效，届时需要重新连接确认。

连接完成后桌面端打开新会话：找到的 Harness 已经选好，标题里选项目，直接输入。什么都没找到时页面列出安装命令；要用 Latch 内置，在那里或「设置 → 模型」添加服务。密钥、Agent 定义与需要本机确认的设置只能在桌面端完成（见「桌面端」）。

**本机确认组件。** Touch ID 与登录密码确认由 `dist/native/latch-presence` 完成：

- `pnpm build` 的最后一步（也可单独运行 `pnpm build:presence`）用 `swiftc` 构建并做 ad-hoc 签名。缺少 Xcode 命令行工具时跳过，本机确认不可用；`pnpm start` 发现组件缺失时也会尝试构建。
- Host 第一次使用组件时记录它的签名。之后重新构建导致签名变化时，本机确认显示不可用并提示签名不一致：停止 Host，运行 `pnpm latch presence repin`，再启动。
- `pnpm latch presence status` 查看状态；`pnpm latch presence test` 显示一次示例确认，确认或拒绝都不改变设置。

**本机确认不可用时**（Linux、未构建组件），用离线连接码连接桌面端：停止 Host，运行 `pnpm latch device enroll --offline`，再用 `pnpm desktop` 启动，在桌面端的连接页填写这个码。码 15 分钟内有效、只能使用一次，只在桌面端接受，桌面端得到全部权限；浏览器与手机的连接都需要本机确认，这时无法完成。它依赖此刻本机没有恶意的同用户进程。

**不配置模型体验流程**：`pnpm start:demo` 或 `pnpm desktop -- --demo` 使用显式启用的确定性演示模型，界面会标注；文件工具真实执行。

## 桌面端

`pnpm desktop`（需要先 `pnpm build`）：

- 为解析出的数据目录启动 Host（在后台运行，日志写入 `<数据目录>/host.log`），或复用已在运行的 Host。复用时本次的 `--demo`、`--harness`、`--provider`、`--plugin`、`--workspace`、网络参数与模型环境变量不会生效，要改启动配置请先停止该 Host。
- 只通过 `<数据目录>/host.json` 与 `host.sock` 找到并核对 Host，不做网络探测。
- 页面从 `latch://app/link/` 加载，所有请求由 Electron 主进程经 `host.sock` 转发；页面本身不能建立网络连接，也接触不到设备密钥与凭据。
- 设备密钥与凭据由主进程用系统安全存储加密，保存在 `<userData>/latch-devices/<hostId>.json`（macOS 为 `~/Library/Application Support/Latch/Desktop/latch-devices/`）。没有可用的安全存储时桌面端拒绝启动。
- 页面里的外部链接只有在原生对话框中确认完整地址后，才交给系统浏览器打开。
- 「设置 → 项目」用系统的文件夹选择器添加项目（可以一次选几个文件夹），也可以从访达拖入文件夹，再在系统对话框中确认；页面不发送路径，由桌面端用设备密钥签名后提交。「在访达中显示」只在访达中选中已添加的文件夹，不打开它。桌面端项目行的菜单可以向已有项目添加文件夹；调整顺序、重新选择与「存为项目」的页面尚未实现（客户端界面正在改版）。
- 「手机」页的「在浏览器中打开」由主进程生成一次性邀请，并把带邀请的回环地址交给默认浏览器；页面看不到邀请码。只在 macOS 上提供，其他系统请用 `pnpm latch device invite --loopback`。
- 关闭窗口不会停止 Host，用 `pnpm stop` 停止。在 macOS 上关闭窗口后 Latch 仍在后台运行，继续在 Host 崩溃后重启它、有任务时保持唤醒；点 Dock 图标重新打开窗口，退出 Latch（⌘Q）后这两项停止，Host 继续运行。
- 桌面端开着时，由 `pnpm desktop` 启动的 Host 意外退出后会被重新启动（1、2、4……秒后，10 分钟内第 5 次时停止并在窗口顶部说明）。用环境变量（如 `LATCH_MODEL`、`LATCH_TLS_*`）配置的 Host 不会被自动重启。
- 有会话在运行或有审批在等时，桌面端阻止 Mac 自动休眠（显示器照常熄灭；用电池时只在会话运行时，每次最长 1 小时），可在「设置 → 通用」关闭。合上盖子（没有外接显示器）时 Mac 仍会休眠；休眠前与 Host 停止前，手机与浏览器会看到原因（「电脑已休眠」「电脑上的 Latch 正在重启」等），并按 Host 给出的时间重新连接。
- 「登录时打开 Latch」的登录项只能由打包后的 Latch 应用设置；`pnpm desktop` 是开发运行，这个开关不可用。
- 不进入时间机器备份的是：数据目录的 `auth/`（已连接的设备）、`identity/`（Host 身份）、`providers.json`（模型密钥）与 `settings.json`（Agent 定义及其环境变量，以及项目列表与默认值，从备份恢复后需要重新添加），桌面端的 `latch-devices/`。会话、审计记录、安全策略与日志照常备份，建议加密备份盘。

信任在连接设备时建立一次：连上的设备凭自己的权限范围正常工作，开始会话、放宽权限、批准操作、改 Harness 都不再确认，每一步都有记录。只有这些还要在这台 Mac 上用 Touch ID 确认：连接新设备（手机另要扫码），为设备增加权限，第一次使用一个自定义或本机模型服务地址（地址、密钥与出站许可一次确认；预置服务商的地址不需要），把地址加入出站白名单，应用含代码的自定义插件。代价只说一次：拿着解锁手机的人可以操作这台 Mac 上的 Agent，直到你移除这台设备。

## 手机接入（HTTPS）

手机只通过 HTTPS 接入，证书由你提供，Latch 不生成自签名证书。以 Tailscale 为例（需要在 Tailscale 中启用 MagicDNS 与 HTTPS 证书）：

```sh
mkdir -p ~/latch-tls && cd ~/latch-tls
tailscale cert my-mac.example.ts.net          # 生成 my-mac.example.ts.net.crt 与 .key
chmod 600 my-mac.example.ts.net.key
pnpm desktop -- --tailnet \
  --tls-cert ~/latch-tls/my-mac.example.ts.net.crt \
  --tls-key  ~/latch-tls/my-mac.example.ts.net.key \
  --public-origin https://my-mac.example.ts.net:4318
```

- 三项 `--tls-cert`、`--tls-key`、`--public-origin` 必须同时提供（或用 `LATCH_TLS_CERT`、`LATCH_TLS_KEY`、`LATCH_PUBLIC_ORIGIN`）。
- 监听地址：`--tailnet` 取本机第一个 Tailscale 地址（`100.64.0.0/10`），`--lan` 取第一个私网 IPv4，`--tls-host <IP>` 指定网卡地址；公开地址的主机是 IP 时也可省略。必须是具体的 IP，不接受主机名或 `0.0.0.0`、`::` 等通配地址。端口默认 `4318`（`--tls-port`、`LATCH_TLS_PORT`）。
- 启动前检查：私钥是你拥有的 0600 普通文件，且不在数据目录或任何项目目录内；证书未过期并与公开地址的主机名匹配。证书剩余不足 14 天时告警，过期后 HTTPS 入口关闭；Latch 不会续签证书。续签后（例如重新运行 `tailscale cert`）直接覆盖证书与私钥文件即可，Host 会自动重新加载，不需要重启；新文件不通过检查时继续使用原证书，并在 `host.log` 中写明原因。
- HTTPS 入口只接受 TLS 1.3，并断开来自本机网卡地址的连接，请用手机测试（手机也需加入同一 tailnet）。
- 该数据目录的 Host 已在运行时，`pnpm desktop` 会复用它而忽略这些参数，请先 `pnpm stop`。

**配对手机：**

1. 在 Host 运行时执行 `pnpm latch device invite`（终端显示二维码）。邀请 10 分钟内有效、只能使用一次，Host 重启后失效。
2. 手机扫码打开页面并提交连接。
3. 电脑上弹出 Touch ID 表单，写出设备自报的名称，确认是你正在连接的设备后允许。

邀请默认授予查看、发起会话与批准操作；`pnpm latch device invite --scopes view,run,approve:standard,approve:elevated,admin` 可以加入管理权限。撤销某台设备时，由它邀请配对的设备降为仅查看，等待在桌面端复核。

## 模型服务

在「设置 → 模型」添加服务：预置常用服务地址（OpenAI、Anthropic、DeepSeek、OpenRouter、Ollama、LM Studio 等），可获取模型列表、检测连接、设置默认模型。

- **密钥**：只能在桌面端填写。预置服务商的地址（OpenAI、Anthropic、DeepSeek、OpenRouter、Gemini、Moonshot、智谱、百炼、火山方舟、硅基流动）和已确认过的地址直接保存，不弹确认；地址还没确认时，密钥随地址一起确认。也可以在 Host 停止时运行 `pnpm latch provider set-key <服务 ID>`（从不回显的终端或标准输入读取）。密钥保存在数据目录的 0600 文件中，不返回浏览器，不写入日志。
- **自定义与本机地址确认一次**：服务第一次指向预置服务商以外的地址（自定义网关、Ollama、LM Studio 等），无论带不带密钥，都要在桌面端用 Touch ID 或登录密码确认一次；这一次同时确认地址、密钥和出站许可（本机或局域网地址需要的「允许 Host 访问 `127.0.0.1:11434`」）。之后保存同一地址不再确认。确认之前，服务可以保存，但 Latch 不会向它发送任何请求。要撤销确认，在桌面端的「设置 › 模型 › 已确认的地址」移除它，它需要的出站许可一起移除，不需要再次确认；使用它的服务随即停止，这次改动会写入审计。没有桌面端时，在 Host 停止时（`pnpm stop`，⌘Q 不会停止 Host）从 `policy.json` 的 `confirmedAddresses` 移除这个地址，本机或局域网地址另外从 `hostEgressAllow` 移除它的 `host:port`；Host 运行时的修改不生效。从旧版本升级时，已保存密钥的地址和已在出站白名单中的地址视为已确认。
- **密钥绑定地址**：密钥只发往保存时服务地址的源（协议、主机与端口）与路径（如 `/v1`）。改到其他源或路径会清空密钥，需要重新输入，所以按路径区分租户的网关不会把密钥带给另一个租户；从旧版本升级时，已有密钥绑定到当时的地址。
- **出站策略**：Host 发出的模型请求一律经过出站策略，默认拒绝本机回环、私网、链路本地、云元数据与其他特殊用途地址，拒绝跨源重定向。Host 自己解析域名并连接检查过的地址，DNS 重绑定无法绕过。
- **本机模型服务**（Ollama、LM Studio 等）因此默认无法访问：确认地址时一并把它的 `host:port` 加入出站白名单（可以在获取模型前先确认，也可以在保存时确认）。元数据地址始终拒绝。使用 fake-IP 模式透明代理（系统 DNS 返回 `198.18.0.0/15`）时，同样需要把模型服务的 `host:port` 加入白名单，或在代理中为它关闭 fake-IP。
- **临时服务**：`LATCH_BASE_URL`、`LATCH_MODEL`、`LATCH_API_KEY` 为本次运行提供一个服务（替换 `openai-compatible` 的连接，不写入数据目录；见 [.env.example](.env.example)）。`LATCH_BASE_URL` 的 `host:port` 自动加入本进程的出站白名单；地址不能包含用户名、密码、查询参数或片段。
- 真实服务失败时报错，不会回退到演示模型。出站策略只约束 Host 自己的模型请求，不约束插件与 ACP Agent 的网络访问。

## Harness

| | Latch 内置（ID `standard`） | ACP Agent、插件 Harness |
| --- | --- | --- |
| 级别 | L1：逐项询问，由 Latch 把关 | L3：完全访问，Agent 自己的询问只是提示 |
| 连上的设备 | 发起、输入、批准、放宽权限（按设备自己的权限范围） | 同左 |

**Latch 内置** 对每个工具调用分级：读取与列目录不询问（R0）；写入项目内普通文件询问，可选「本会话始终允许」（R1）；写入受保护路径（`.git/`、`package.json`、`node_modules/`、`.env*` 等会被开发工具自动执行或读取的位置）、无法判定的路径，以及第三方插件注册的工具，每次询问，不提供「始终允许」（R2）。

**ACP Agent** 是与 Host 同权限运行的本机代码，Latch 不提供操作系统沙箱：

- 在运行 Host 的电脑上安装并登录 Agent，新会话找到预设的命令后就能选，第一次发送时保存定义；自定义命令在「设置 → Harness」填写并保存，有管理权限的设备都能改，每次改动都有记录。Latch 不下载、不安装 Agent，也不代为登录。
- 发送就开始。这个启动内容第一次运行时，会话最上面说一次它能做什么；每次启动都记入审计（命令、项目配置与第一条输入的哈希）。定义或这些配置变了时，已有会话停止接受输入，换新会话继续。
- 启动前 Latch 把 Agent 设到预设规定的权限模式，每轮输入前读回核对，发现 Agent 自行放宽时停止会话，并隐藏会持久保存授权的「始终允许 / 始终拒绝」类选项。pi 与 DeepSeek Harness 无法读回模式，pi 执行工具前也不请求审批。
- Agent 进程只继承 `PATH`、`HOME`、`LANG`、`TERM`、`USER`、`SHELL`、`LC_*`，每个会话有私有临时目录，代理变量被清空。Agent 需要的 API Key 等变量请写在 Agent 定义里；`PATH`、`HOME`、代理、`NODE_OPTIONS`、`LATCH_*`、`npm_*`、`DYLD_*`、`LD_*`、`GIT_CONFIG_*` 等由 Latch 管理的变量不能在定义中设置。
- 任何 L3 会话运行或等待审批时，所有本机确认都会被拒绝：桌面端写出是哪个会话，可以查看或停止它，结束后再试。这样 Agent 借不到你的确认。

| 预设 | 启动命令 | 许可证 |
| --- | --- | --- |
| [Codex](https://github.com/agentclientprotocol/codex-acp) | `codex-acp` | Apache-2.0 |
| [pi](https://github.com/svkozak/pi-acp) | `pi-acp` | MIT |
| [OpenCode](https://github.com/anomalyco/opencode) | `opencode acp` | MIT |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | `dsh --profile acp` | MIT |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini --acp --approval-mode default` | Apache-2.0 |
| [Qwen Code](https://github.com/QwenLM/qwen-code) | `qwen --acp` | Apache-2.0 |
| [goose](https://github.com/block/goose) | `goose acp` | Apache-2.0 |

安装方式、各预设的权限模式与已知限制见 [docs/HARNESSES.md](docs/HARNESSES.md)。

**需求包与插件。** `--plugin ./examples/release-review` 加载包含 `latch-plugin.json` 的本地需求包，组合发布检查技能、工具与可编辑的 React 清单；`--plugin ./examples/text-statistics.mjs` 继续加载原有模块，两种参数都可重复。用 `pnpm start -- --data-dir <数据目录> --workspace <项目目录> --port 0 --plugin <目录或模块>` 启动；`--harness <id>` 选择默认 Harness。设置中的「插件」统一启停整个包。Host 模块具有 Host 权限，客户端模块具有页面权限，只加载可信代码；第三方工具在 Latch 内置中按 R2 处理，包提供的 Harness 为 L3。当前不下载或构建插件，在线安装与可视化包编辑器尚未实现。编写方式见 [docs/PLUGIN-DEVELOPMENT.md](docs/PLUGIN-DEVELOPMENT.md)。

## 命令行 `pnpm latch`

每个命令都接受 `--data-dir <目录>`，未指定时按「数据与工作区」中的顺序解析。

| 命令 | Host 状态 | 作用 |
| --- | --- | --- |
| `device list [--json]` | 运行中 | 列出已连接的设备 |
| `device revoke <设备 ID>` | 运行中 | 撤销设备；由它邀请的设备降为待复核 |
| `device invite [--scopes …] [--code-file <路径>]` | 运行中，已配置 HTTPS | 生成手机配对二维码 |
| `device invite --loopback [--scopes …] [--code-file <路径>]` | 运行中 | 生成这台电脑上浏览器用的一次性连接链接；不给 `--scopes` 时可以申请「管理此 Host」，桌面端的链接不含它 |
| `device enroll --offline [--code-file <路径>]` | 已停止 | 生成桌面端用的一次性离线连接码（15 分钟） |
| `provider set-key <服务 ID>` | 已停止 | 保存模型服务密钥，绑定到当前服务地址；地址未确认时先列出地址与出站许可，输入密钥即一并确认（标准输入不是终端时需要 `--expect-url <服务地址>`） |
| `provider confirm <服务 ID>` | 已停止 | 先列出要确认的地址（源与路径）、出站许可与明文 HTTP 警告，在终端输入 `y` 后才确认；本机或局域网地址同时加入出站白名单。非交互环境用 `--expect-url <服务地址>` 写出要确认的地址，不一致就不修改 |
| `project list [--json]` | 已停止 | 列出项目与其中的文件夹 |
| `project add <路径…> [--name <名称>] [--yes]` | 已停止 | 用这些文件夹添加项目，第一个通过检查的是主文件夹 |
| `project add-folder <项目 ID> <路径…> [--yes]` | 已停止 | 把文件夹加入项目 |
| `project remove <项目 ID> [--yes]`、`project remove-folder <项目 ID> <文件夹 ID> [--yes]` | 已停止 | 移除项目或其中一个文件夹，文件不删除 |
| `presence status` | 任意 | 本机确认是否可用 |
| `presence repin` | 已停止 | 重新记录本机确认组件的签名（仅 macOS） |
| `presence test` | 任意 | 显示一次示例本机确认 |
| `audit verify` | 任意 | 只读校验审计记录的哈希链 |
| `traffic [--json]` | 运行中 | Host 本次启动以来发出的字节数：按类别（事件流各类帧、快照、会话详情）的次数与大小分布、各会话与各条事件流的计数；只有数字与会话 ID |

项目与文件夹只能在 Host 所在的电脑上添加：在 Latch 桌面端用系统的文件夹选择器（或把文件夹拖进来，再在系统对话框中确认），或在 Host 停止时用 `pnpm latch project`。命令按「数据与工作区」中的规则逐个检查文件夹，列出真实路径并在终端询问 `y/N`（非交互环境需要 `--yes`），先写审计再保存；Host 运行时拒绝（「Host 正在运行。请在 Latch 桌面端添加，或先停止 Host。」）。重命名、调整顺序、移除文件夹与移除项目不扩大权限，Host 接受任何有「管理此 Host」权限的设备发起；页面目前只提供移除项目。

离线项目命令沿用上次 Host 实际使用的启动目录、Agent 安装目录与 TLS 私钥位置。首次启动之前添加文件夹，需给项目命令加 `--workspace <启动目录>`（或设置 `LATCH_WORKSPACE`）；之后改变启动参数，应先用新参数成功启动并停止 Host，再执行项目命令。

配对链接与离线连接码默认只打印到终端。非交互环境必须用 `--code-file <路径>`，内容只写入本次新建的 0600 文件：

- 目标已存在（包括符号链接）时拒绝，不跟随、不覆盖。
- 所在目录必须属于当前用户，或属于 root 且带粘滞位（如 `/tmp`）；没有粘滞位时其他用户不能写入。
- macOS 上目录不能带访问控制列表（ACL）。主目录 `~` 及其下的常用文件夹通常默认带有一条，因此会被拒绝；请改用例如 `mktemp -d` 新建的目录。

## 启动参数与环境变量

| 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--data-dir <目录>` | `LATCH_DATA_DIR` | 见下节 |
| `--workspace <目录>` | `LATCH_WORKSPACE` | `~/Latch/workspace` |
| `--port <端口>` | `LATCH_PORT` | `4317`（同时监听 `127.0.0.1` 与 `::1`） |
| `--tls-cert`、`--tls-key`、`--public-origin` | `LATCH_TLS_CERT`、`LATCH_TLS_KEY`、`LATCH_PUBLIC_ORIGIN` | 不启用 HTTPS |
| `--tls-host <IP>`、`--lan`、`--tailnet`、`--tls-port` | `LATCH_TLS_HOST`、`LATCH_TLS_PORT` | 端口 `4318` |
| `--native-host <具体 IP>`、`--native-port <端口>` | — | 不指定时局域网入口自动选择并跟随手机接入；指定后固定在这个地址，端口默认 `4319` |
| `--plugin <目录或模块>`、`--harness <id>`、`--provider <id>`、`--demo` | — | — |

**连接 iPhone 上的 Latch：** 在桌面端打开「手机 → 连接手机」，用 iPhone 上的 Latch 扫码，再用 Touch ID 确认一次。iPhone 需要和这台 Mac 连接同一个 Wi‑Fi；客户端隔离的网络上配对会失败，可以让 Mac 临时连 iPhone 的个人热点。之后不用再设置：有已配对的手机时局域网入口保持打开。官方中继尚未部署，不在同一网络时目前连不上。新增自建中继与地址目录目前没有界面或接口（尚未实现）；已保存的配置继续生效，可以在「手机 → 关于连接」里移除。不需要的手机在「手机」页移除，手机也可以在设置里「断开这台 Mac」。连上之后打开 Latch 就能查看与继续会话，不再要求 Face ID；想要时在手机的「设置 › 安全」打开「查看会话前用 Face ID」（默认关闭，打开与关闭都要验证一次），之后离开 App 或过十分钟再查看时会再次询问。

手机连接没有账号和云端用户库，也不使用 P2P 或 NAT 穿透：手机直接连到你的这台 Mac，设备、权限与会话都由 Mac 上的 Host 决定，网络失败不会改变它们。这个入口与浏览器的 HTTPS 入口分别配置。

配对只有一种方式：在 Mac 所在的 Wi‑Fi 或有线网络上扫一次二维码，在 Mac 上确认一次。确认之后面板问「手机上显示已连接了吗？」：手机显示已连接就选「是的，完成」；没有显示，说明连上的可能不是你的手机，选「没有，移除」，它立即断开，之后要重新扫码才能连接。

中继只连接 Host 与已获准设备，不能读取端到端正文、签发设备权限或替换 Host 身份。中继的运营方与云服务商仍能看到 IP、时间、填充后的大小与连接关系，同一运营方可以把不同节点、不同日期的连接关联起来。

以下还没有在真机上验收，测试夹具不能代替：Secure Enclave、Face ID、App Attest、Mac 上配对的系统确认表单、Bonjour 本地网络权限、Wi‑Fi 与蜂窝切换，以及手机上的分享与预览。App Attest 与云推送尚未启用，所以手机上没有通知。

同时运行多个 Host 时，为每个 Host 使用不同的 `--data-dir` 与 `--port`。

## 数据与工作区

**数据目录**（已连接的设备、审计、安全策略、模型服务与密钥、会话）按以下顺序确定：

1. `--data-dir` 或 `LATCH_DATA_DIR`；
2. 当前目录下已存在的 `.runtime`（旧版本的位置，继续使用并打印迁移提示；迁移时停止 Host、移动目录，再用 `--data-dir` 指定）；
3. 平台默认：macOS `~/Library/Application Support/Latch/Host`，Linux `${XDG_DATA_HOME:-~/.local/share}/latch/host`。

**启动目录**：`--workspace` → `LATCH_WORKSPACE` → 数据目录内已存在的 `workspace`（旧布局，迁出之前只能使用 Standard；位于 Latch 程序目录内时不再使用）→ `~/Latch/workspace`（需要时创建）。启动目录只包含这一个文件夹；其他项目在 Latch 桌面端「设置 → 项目」新建，或用 `pnpm latch project` 添加，每个项目最多 8 个文件夹。

**会话自己的文件夹**：没有指定 `--workspace` 或 `LATCH_WORKSPACE` 时，每个不在项目中的新 Agent 会话在启动目录中得到一个新文件夹（如 `~/Latch/workspace/20261025-a1b2`，权限 0700），在其中工作，会话之间的文件不再互相覆盖；Latch 内置不选项目时不读写文件，也没有文件夹。指定了启动目录时照旧在其中工作。删除会话不删除它的文件夹。把会话的文件夹「存为项目」由 Latch 桌面端完成，只能在 Host 所在的电脑上进行，之后的新会话就能在这个项目中开始；页面中的入口尚未实现（客户端界面正在改版）。

以下位置既不能作为启动目录（Host 拒绝启动），也不能加入项目：

- 主目录本身；包含或位于敏感目录（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`~/.docker`、`~/Library/Keychains`，以及 `~/.codex`、`~/.gemini` 等 Agent 配置目录）的位置；包含 TLS 私钥的目录。
- 主目录下的隐藏目录、`~/.config`、`~/.local`、`~/bin`，以及 macOS 的整个 `~/Library`（数据目录内的旧布局工作区除外）。
- 与运行目录或 Agent 安装目录重叠的位置。

加入项目的每个文件夹另外拒绝：与数据目录重叠、登录时自动启动的目录（如 `~/Library/LaunchAgents`）、与 Latch 程序目录重叠、位于 `.git`、`node_modules` 等受保护目录内的目录；路径含不可显示的字符（控制字符、换行、双向控制与零宽字符），或含逗号、`*`、`?`（部分 Agent 把它们当作分隔符或通配符）；Host 无法打开的文件夹（macOS 的「隐私与安全性」没有允许时）。同一项目中的文件夹不能相同或相互包含；主文件夹不能是启动目录或另一个项目的主文件夹，其他文件夹可以同时属于几个项目。启动目录与 Latch 程序目录重叠时 Host 仍会启动，但 Standard 的每次写入都按 R2 处理，ACP Agent 不可用。

已保存的项目每次列出时重新检查（结果保留 5 秒），新建会话时立即检查：任何一个文件夹找不到、不再符合规则或无法打开，整个项目就不能新建会话，已有会话也不能继续，直到文件夹回到原处，或在项目中把它换成另一个文件夹。会话创建时记下它的项目与文件夹，之后加入的文件夹只用于新会话；它用到的文件夹被移出项目或替换后，会话不能继续。

路径与数据目录内容见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「路径与项目目录」与「持久化与恢复」。

## 停止 Host

```sh
pnpm stop                               # 默认数据目录
pnpm stop -- --data-dir <目录>
pnpm stop -- --force                    # 仍有会话在运行或等待审批时
pnpm stop -- --reason restart           # 告诉手机与浏览器原因：restart、update 或 shutdown（默认）
```

- `pnpm stop` 只在通过 `host.sock` 核对 PID、hostId 与实例 ID 之后才发送停止信号。有会话在运行或等待审批时拒绝，加 `--force` 继续。在启动 Host 的终端里按 Ctrl+C 也可以停止。
- `<数据目录>/host.lock` 保证同一数据目录同一时间只有一个 Host 或离线 `pnpm latch` 命令在写入。持有进程已退出、或锁写于电脑重启之前时，锁会被自动接管，无需处理。
- `pnpm stop` 从不凭 `host.lock` 或无法识别的 `host.json` 发信号，遇到以下情况说明原因后以状态 1 退出：Host 仍在启动（稍后再运行）；锁或 `host.json` 无法读取；`host.json` 记录的进程仍在运行但无法通过 `host.sock` 核对；`host.json` 来自上一版本且其中的进程仍在运行（在旧 Host 的终端中按 Ctrl+C 停止）。
- 只有在同一次开机内 Host 被强制结束、它的进程号又被其他程序复用，并且确认没有 Host 或 `latch` 命令在使用该目录时，才需要手动删除 `host.lock`。

## 平台限制

- **Linux**：没有本机确认（尚未实现 polkit 等系统确认）。桌面端第一次连接不需要确认，之后用离线连接码；浏览器与手机无法连接；需要本机确认的操作都不可用，包括确认自定义或本机模型服务地址、授予设备权限与加入出站白名单。
- **Windows**：Host 依赖 `host.sock` 所在的每用户运行目录，Windows 上尚未实现，Host 无法启动。

## 与上一版本不兼容的变化

- **启动令牌与旧链接失效。** 不再打印带一次性令牌的「管理入口」；旧的 `#token=` 链接被页面丢弃，旧的登录与配对接口返回 410 `login-removed`。所有设备改为本机确认连接。
- **所有设备需要重新连接确认。** 旧版浏览器的登录状态不再有效，需要在本机重新连接；旧的配对设备（手机）在升级时被撤销，需要通过 HTTPS 重新邀请。旧版 Latch 无法读取新的已连接的设备文件，回退旧版需要手动恢复备份。
- **浏览器连接需要一次性邀请，离线连接码只在桌面端接受。** 回环端口可能被转发，不再算作这台电脑：新浏览器从桌面端「在浏览器中打开」或 `pnpm latch device invite --loopback` 获得邀请后连接。已经连接的浏览器照常使用，它们本来就按远程设备的规则运行。`pnpm latch device enroll --offline` 不再接受 `--port`。
- **明文局域网接入已移除。** `--lan`、`--tailnet`、`--tls-host` 或非回环 `--host` 都必须同时提供证书、私钥与公开地址，否则拒绝启动。
- **`GET /link/api/health` 只返回 `{"ok":true}`。** Host 实例信息只在 `host.sock` 上提供。
- **桌面端的地址变量已移除。** 桌面端只通过 `host.json` 与 `host.sock` 连接 Host，启动器丢弃这个变量（见「启动参数与环境变量」）。
- **环境变量改名为 `LATCH_*`。** 改名前的名称仍然有效（见「启动参数与环境变量」）；Agent 定义不能再设置 `LATCH_*` 变量，已保存的定义设置了它们时显示问题且不加载，删除这些变量后恢复。
- **默认位置变化。** 新安装的数据目录与启动目录使用上文的平台默认位置；当前目录已有的 `.runtime` 仍会被使用，其中的 `workspace` 只在不位于 Latch 程序目录内时仍作为启动目录，否则启动目录改为 `~/Latch/workspace`（原目录中的文件不移动，启动时打印提示）。
- **会话有自己的文件夹。** 使用默认启动目录时，不在项目中的 Agent 会话不再共用启动目录，而是各自使用其中新建的文件夹；已有会话不受影响。
- **只能在 Host 电脑上添加项目。** 本机浏览器、手机与其他电脑不能再添加项目或添加文件夹（403 `local-only`），旧页面的路径输入框随之失效；改用 Latch 桌面端或 Host 停止时的 `pnpm latch project`。「默认工作区」改称「启动目录」。
- **回退到旧版本 Host** 时，它只读取每个项目的主文件夹，并在下一次写入设置时丢弃其他文件夹与图标；在自己文件夹中工作的会话不能继续；它也无法打开记录了新审计动作（如 `workspace.folder-added`）的审计记录。
- **很早以前创建的 ACP 会话只能查看和删除**，因为它们没有启动指纹的记录；请新建会话。
- **自定义与本机模型服务的地址要确认一次。** 不带密钥、地址既不是预置服务商、也不在出站白名单里的服务，升级后显示「未确认」，不再出现在模型选择里，直到在运行 Latch 的电脑上确认它的地址（「设置 › 模型服务」，Linux 与 Windows 用 `pnpm latch provider confirm`）。用它继续会话时提示地址还没有确认；带密钥的服务与已在白名单里的地址在升级时视为已确认。
- **预置服务商的服务没有密钥时不再出现在模型选择里**，选择它时提示要在运行 Latch 的电脑上填写密钥。
- **密钥绑定到地址加路径。** 已保存的密钥在升级时绑定到当前的服务地址（源与路径）；之后把地址改到另一个路径（同一网关的另一个租户）也会移除密钥，与改到另一个源相同。
- 执行 `pnpm build` 后，仍在运行的旧 Host 会直接提供新页面，页面提示「此 Host 仍是旧版本，重启 Host 后启用设备确认。」，重启 Host 即可。

## 安全边界

- Latch 约束的是「谁能让 Host 做什么」，不隔离执行的代码。插件、ACP Agent 与第三方 Harness 是可信的本机代码；工具审批、路径检查与出站策略是应用层约束，不是操作系统沙箱。L3 会话可以读写 Latch 的数据与 Host 身份私钥。
- 同一系统用户下的其他进程可以连接 `host.sock`、读取数据目录；Latch 的保护来自 0700 的运行目录。
- 每台设备持有自己的 P-256 密钥，Host 只保存公钥与凭据哈希；授予或执行权限的操作先写入哈希链审计记录。
- 不要把端口直接暴露到公网；远程设备只通过你提供证书的 HTTPS 入口接入。即使回环端口被隧道转发出去，没有邀请也无法连接，转发进来的连接也不能发起本机确认。

不防御的情况与尚未实现的部分见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发

```sh
pnpm check:quick               # 格式、lint、类型、依赖边界与 Agent 说明的检查，几秒内完成
pnpm check                     # 再加 knip 与单元测试
pnpm typecheck                 # tsc -b，分同构包、插件 SDK、core、浏览器、Host、桌面端与测试检查
pnpm lint                      # oxlint；导入边界、循环导入与运行环境的全局变量是错误，其余只报告
pnpm fmt                       # oxfmt 格式化；pnpm fmt:check 只检查
pnpm test                      # Vitest 单元与集成测试
pnpm build
pnpm test:e2e                  # Vitest + Playwright，使用 dist/web
LATCH_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm test:e2e
LATCH_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts
```

Git 钩子与 `git blame` 的忽略列表需要在每个克隆中手动设置一次，见 [docs/TESTING.md](docs/TESTING.md#git-钩子)。

测试只使用临时目录、本地假模型服务与假 ACP Agent，不调用付费模型。手动查看界面时请用独立的数据目录、工作区与端口：`pnpm start:demo -- --port <空闲端口> --data-dir <临时数据目录> --workspace <临时工作区>`，结束后 `pnpm stop -- --data-dir <同一数据目录>`。

| 文档 | 内容 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 给 AI 编码助手的工作约定与入口 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层、Harness 路由、持久化、HTTP API |
| [docs/HARNESSES.md](docs/HARNESSES.md) | ACP Agent 接入、权限模式、项目配置与限制 |
| [docs/PLUGIN-DEVELOPMENT.md](docs/PLUGIN-DEVELOPMENT.md) | 组合技能、工具、React 界面与 Harness 需求包 |
| [docs/STREAMING.md](docs/STREAMING.md) | 流式同步、消息身份、重连与阅读位置 |
| [docs/DESIGN.md](docs/DESIGN.md) | 界面结构、设计令牌与交互规则 |
| [docs/TESTING.md](docs/TESTING.md) | 测试命令与按改动选择回归 |

## 许可证

源代码以 [Apache License 2.0](LICENSE) 授权。"Latch" 名称与图标不在该许可范围内（见许可证第 6 条）。
