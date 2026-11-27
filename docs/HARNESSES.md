---
description: Latch 怎样启动并驱动用户本机的 Agent（ACP、Codex 的 app-server、pi 的 RPC、Cursor 的 SDK）：预设与命令、不改原 CLI 配置、完全访问（L3）、权限模式与读回、项目配置与文件夹、启动指纹、进程与环境、经 Latch 使用模型服务、登录、额度、审批、取消、子 Agent、提问、持久化与恢复、接入已有会话、会话命令、扩展、错误与尚未实现。
sources:
  - packages/harness-acp/src
  - packages/protocol/src/agent-presets.ts
  - packages/protocol/src/extensions.ts
  - packages/protocol/src/harness-plugin-report.ts
  - apps/host/src/hub.ts
---
# 接入外部 Harness（ACP）

支持 `pluginCreation` 的 Driver 在专用创造会话把作者引导交给执行端。内置 Harness 用模型系统段落，ACP 在普通提示中另加文本块；厂商原生命令仍按原格式传递。使用者的消息保留原文，创建与审批权限由 Host 负责。见[创造模式](PLUGIN-DEVELOPMENT.md#创造模式与插件市场)。

Latch 只调用用户本机已经装好的 Agent：启动它的命令，可以交给它一个模型服务，并把它的协议对齐成 Latch 的会话。多数 Agent 经 [Agent Client Protocol](https://agentclientprotocol.com)（ACP v1）驱动；Agent 有自己的官方机器协议时直连（见「直连优先」）。每个启用的 Agent 定义是一个 HarnessDriver，与内置 `standard` 并列。

| 位置 | 内容 |
| --- | --- |
| `packages/harness-acp/`（`@latch/harness-acp`，只有 Host 依赖） | 驱动：`src/runtime.ts` 是会话、指纹、模式、审批与取消的唯一实现，`src/wires/` 是与进程交谈的线 |
| `packages/protocol/src/agent-presets.ts` | 浏览器可见的预设：命令、参数、许可证、安装与登录命令 |
| `packages/harness-acp/src/profiles/` | 只在 Host 上使用的每个预设的 `HarnessProfile`（字段说明在 `profiles/types.ts`） |

整体架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)；模型网关与我的 Agent 的规则见其中的[各功能的安全规则](ARCHITECTURE.md#各功能的安全规则)。

## 不修改原 CLI 配置

- 直连与 ACP 接入都不为同步会话、切换模型、权限或工具接线改写用户原有的 CLI 全局或项目配置，不注册 hooks，不改 shell 启动文件、不替换命令、不建全局自动启动入口。
- Latch 的选项存在 Host 自己的配置里；要传给 Agent 的值优先用官方会话请求或进程参数。确需文件时只写 Latch 管理的独立目录（私有文件 0600），不把用户原配置复制成可写镜像，不复制凭据。
- 经进程参数加载的适配扩展只在 Latch 启动的那个进程里生效。退出、启动失败与恢复都不把适配逻辑注册回原 CLI；卸载后留下的 Latch 数据不会让独立 CLI 继续加载它们。私有配置目录不是 OS 沙箱。
- 模型、思考与权限的 setter 也要核对上游是否会持久改写全局默认。有这种副作用时改用非持久接口或独立配置入口；不能干净接入的能力不提供，不用「先写全局配置再恢复」的办法。
  - Qwen Code：模型选择走会话接口并带 `_meta["qwen.session.modelPersistDefault"]: false`（`modelSetMeta`）。只报告 legacy 模型接口的会话拒绝模型切换与带该切换的首条消息，原生与网关会话一样。
  - Codex 直连：以只读权限打开或恢复线程，再把所选权限、模型与思考放进每一轮请求，避免可写的新线程触发 Codex 的隐式项目授信保存。
- 不在此列：用户在 CLI 里自己发起的登录、会话记录与工作产物；CLI 启动时自己做的配置迁移或依赖缓存（由上游决定，Latch 不为已启动的 CLI 模拟只读文件系统）。

## 权限级别：完全访问（L3）

ACP Agent 是本机可信代码，Latch 不给它加操作系统沙箱，也不代理它的网络。所以每个 ACP 会话都是完全访问（L3）：

- Agent 以 Host 用户身份读写文件、执行命令，包括 Latch 的数据目录与 Host 身份私钥，也能冒用本机 Electron 在其他电脑上的设备身份。
- Agent 发起的审批只是提示（`advisory: true`，按 `R2` 展示），不是边界：拒绝会转达，但挡不住它做别的事。
- Latch 做的是：审计每次启动的命令、项目配置与第一条输入的哈希；启动前把 Agent 设到预期模式并在每轮输入前读回；Agent 自己放宽模式时停止会话；去掉会持久保存授权的选项。

谁能做什么：

| 动作 | 要求 |
| --- | --- |
| 新建会话、发送输入、改会话设置（含放宽模式）、允许询问、删除会话 | `run`，任何设备，不弹确认 |
| 查看、拒绝询问、取消 | `view` |
| 改标题、置顶、归档 | 只改 Latch 的会话记录，不触达 Agent |

- 每次启动写 `task.l3.start-requested` 与 `task.l3.started`（`stepup: 'none'`，带启动指纹与第一条输入的哈希）；放宽模式写 `task.mode.widened`。
- 启动目录在数据目录内，或启动目录与程序目录重叠且包含 Host 数据目录时，不能用于 ACP 会话（409）。显式选择的 Latch 程序目录可以用于 ACP 会话，按 Agent 所选权限工作；目录提示不表示隔离，构建或重启可能影响当前使用。
- 任何 L3 会话运行中或等待审批时，本机确认的动作（`PRESENCE_ACTIONS`）返回 409 `presence-blocked`，带挡住它的会话（`blockingTasks`）。

## 使用

1. 在运行 Host 的电脑上安装 Agent，并按它自己的方式登录。
2. 新会话在本机管理设备上列出已安装的预设（`catalog.harnesses` 中带 `offer` 的项）。第一次打开模型面板或发送消息时，页面先保存预设定义。按预设原样绑定的命令可直接保存，命令绑定有变化时沿用本机确认。也可在「设置 → Harness」选预设或填自定义命令（可执行文件名或绝对路径、参数、环境变量）。
3. 新建会话默认用这台设备上次的 Harness，否则按预设顺序取第一个能开始的，Latch 内置排最后。没有选项目时，如果启动目录由 Host 自动选择（`catalog.sessionFolders`），pi 等 Agent 会在新的空文件夹里开始。显式指定的启动目录或项目与 Latch 程序目录重叠时，界面提示构建与重启的影响，仍可直接发送。
4. 会话头部显示 Agent 提供的模型、模式等选项，修改从下一轮生效；任何档位都能直接选（见「权限菜单」）。

**预设命令不确认，其他命令要在这台 Mac 上确认。**

- 定义只能经 `host.sock` 由有 `admin` 的设备新增或改命令；L3 会话运行或等待时被挡（409 `presence-blocked`）。
- 预设的原样命令（Host 自己的预设表里该预设或它的适配器的命令与参数，没有环境变量，在登录 shell 或进程的 PATH 上找到，且不是这个预设上次绑定的路径以外的程序）不确认，记 stepup `preset`；`presetId` 只选比较的条目，不决定结果。只在额外安装目录里找到的照常确认。
- **不再使用的适配器。** pi 曾经经 `pi-acp` 适配器运行，现在直接说它自己程序的 RPC。那时预设存下的定义（`presetId: pi`，命令是 `pi-acp`，没有参数与变量）在 Host 启动时移除并写审计（`agent.deleted`，`via: startup`），不替它绑定别的程序；pi 随后作为这台电脑上已安装的预设重新出现，第一次使用时照常绑定。带参数或变量的同名定义是人自己的，保留（`isRetiredAdapterDefinition`）。
- 每个预设上次绑定的路径记在 `settings.json` 的 `presetBindings`，保存与删除定义时都写入；预设与它、与同一预设其他定义的路径都一致才不确认。客户端只收到这个路径以 Host 自己的密钥（`boundKey`）算出的摘要。绑定比较的是路径，不是文件内容：同一路径上的程序被替换时它不会发现。
- 其他都要本机确认 `harness.command.apply`：自定义命令、绝对路径、多出或改过的参数、任何环境变量（新增、修改、移除都算），确认绑定名称与命令解析出的路径。
- 保存时记下解析出的路径 `confirmedCommand`。之后同一命令解析到别的程序时会话不启动（409 `harness-command-moved`），在这台 Mac 上再保存一次即确认新路径，预设也一样。这时 Harness 带 `statusReason: 'moved'`。这台 Mac 的桌面端可以在「设置 › Harness」的列表或详情按「确认新程序」，原样保存定义并经本机确认。详情的按钮会转圈，确认失败或被挡住时在「检测」里显示原因，可以在原处重试。保存成功后重新读取检测结果。其他设备显示「需要确认」。
- 没有 `confirmedCommand` 的定义：在这台 Mac 上第一次用它开始会话时绑定（预设不确认）；此前其他设备开始它被拒（409 `harness-unconfirmed`），版本也不读。
- 改名、开关、删除、模型与权限预设，有 `admin` 的设备都能改。每次改动写 `agent.defined`（确认过的带 `lpc-local`，预设带 `preset`），变量的值不返回。
- Host 只为确认过、且仍解析到同一路径的定义运行 `--version`。
- `startServer` 只有收到 `detectPreset`（启动脚本传入）才找预设的命令；测试不传，所以运行测试的电脑上装的 Agent 不会被选中。

**首启提示。** 一个启动指纹在这台 Host 上第一次启动时，`sessions-meta.json` 记 `firstStart`；网页不再为它写一行：Latch 不隔离它、权限是它自己的设置，是每一轮回复开头 Harness 图标与名字的提示框。Driver 收不到这一项。

### 直连优先

Agent 自己提供官方机器协议时 Latch 直接说它，ACP 适配器只作后备：少一层转换，版本只跟 Agent 自己走。

| Harness | 路线 |
| --- | --- |
| Codex | `codex app-server`（见「Codex 的 app-server」） |
| pi | `pi --mode rpc`（见「pi 的 RPC 模式」） |
| Cursor | 定义带 `CURSOR_API_KEY` 时用官方 SDK `@cursor/sdk`（见「Cursor 的 SDK 路线」），否则 `cursor-agent acp` |
| OpenCode | `opencode serve`，2.2.6 起（见「OpenCode 的服务接口」）；更早的版本与保存为 `opencode acp` 的定义走 ACP |
| DeepSeek Harness | `dsh --profile acp`：随包的 `acp` 配置是它给自动化客户端的官方协议 |
| 其他预设 | ACP：它们的官方集成方式 |

Codex 与 Claude Agent 的后备规则（Claude 把下文的 `codex` 换成 `claude`、`codex-acp` 换成 `claude-agent-acp`、0.156.0 换成 2.1.322；`claude-agent-acp` 运行它自带的 Claude Code，不运行人装的旧 `claude`，太旧时仍不改用它，以免悄悄换掉人自己的版本与设置）：

- `codex` 低于 0.156.0（此版起被中断或失败的一轮保留已流出的回答与计划）时以 409 `harness-version-unsupported` 拒绝并给出升级命令，不改用 codex-acp：适配器会经 `CODEX_PATH` 运行同一个旧 Codex。
- 只有这台电脑没有 `codex`、却装了 `codex-acp` 时，从草稿选 Codex 才保存为 `codex-acp`（预设的 `fallback`），它运行自己随包带的 Codex。
- 定义的命令是 `codex-acp` 或任何别的命令时走 ACP，用 `profiles/codex-acp.ts`；设置里它的行写「经 codex-acp」。
- Claude Agent 的适配器定义用 `profiles/claude-agent.ts` 的 `claudeAgentProfile`，直连用同一文件的 `claudeProfile`；两者的模式、选项与会话 ID 相同，所以适配器上开的会话在直连上按同一 ID 恢复（`claude-resume.live.test.ts`）。版本与登录状态命令按定义所走的路线读（`routeCommand`）：直连读 `claude`，适配器读 `claude-agent-acp --cli`。

OpenCode 的后备规则（适配器与预设是同一个程序，按参数区分，`runsPresetFallback`）：

- 定义的参数里有 `acp`、或命令不是 `opencode` 时走 ACP，用 `profiles/opencode.ts` 的 `opencodeAcpProfile`（与改为直连之前的 profile 相同，版本 7，原有会话的启动指纹不变）；设置里它的行写「经 opencode acp」。改为直连之前保存的预设定义都是 `opencode acp`：Host 启动时把它们改成直连，见「旧定义改为直连」。
- 从草稿或「添加 Harness」选 OpenCode 时，确认程序后先读版本：低于 2.2.6（含 1.x）时保存为 `opencode acp`，2.2.6 起保存为 `opencode`（直连）；读不出版本时按直连保存。`presetRoute` 在已知版本太旧时同样给出 `opencode acp`。
- 已保存的直连定义遇到低于 2.2.6 的程序时以 409 `harness-version-unsupported` 拒绝并给出升级命令，不静默改走 ACP；握手时服务报告的版本不是 2.x 中的 2.2.6 或更高也同样拒绝，错误里写明可改用 `opencode acp`。

预设只用本机已安装、未经修改的命令，不用 `npx` 等运行时下载，不捆绑。Latch 不提供一键安装，只显示可复制的安装命令与项目主页。

| 预设 | 命令 | 许可证 | 安装与版本 | 登录命令（`AgentPreset.login`） |
| --- | --- | --- | --- | --- |
| Codex | `codex`，线追加 `app-server` | Apache-2.0 | `npm i -g @openai/codex`，0.156.0 起 | `codex login`；只有适配器时 `codex-acp cli login` |
| pi | `pi`，线追加 `--mode rpc` | MIT | `npm i -g @earendil-works/pi-coding-agent`，0.84.4 起 | 进入 pi 后 `/login` |
| OpenCode | `opencode`，线追加 `serve --stdio --hostname 127.0.0.1 --port 0 --print-logs --log-level warn`；后备 `opencode acp` | MIT | `npm i -g @opencode/cli`；直连 2.2.6 起，`opencode acp` 1.x 与 2.x | `opencode auth login` |
| DeepSeek Harness | `dsh --profile acp` | MIT | `npm i -g @deepseek-ai/dsh`，0.2.2-rc.1 起；它自己要求 Node.js 24.9 起；按完整消息回复 | 无 |
| Qwen Code | `qwen --acp` | Apache-2.0 | `npm i -g @qwen-code/qwen-code` | 进入后 `/auth` |
| goose | `goose acp` | Apache-2.0 | `brew install block-goose-cli` | `goose configure` |
| Claude Agent | `claude`，参数全由线与 SDK 给出；只有适配器时 `claude-agent-acp` | Claude Code 专有，SDK 按 Anthropic 商业条款；适配器 Apache-2.0 | `curl -fsSL https://claude.ai/install.sh \| bash`（或 `brew install --cask claude-code`），2.1.322 起；适配器 `npm i -g @agentclientprotocol/claude-agent-acp`，0.99 起的 0.x | 不提供（`signIn`，见「登录」） |
| Cursor | `cursor-agent acp` | 专有（Cursor 服务条款） | 官方安装脚本 | `cursor-agent login` |
| Antigravity | `agy acp --disable-telemetry --process-per-session` | 专有（Google Antigravity 条款） | `curl -fsSL https://antigravity.google/cli/install.sh \| bash`，1.5.8 起 | `agy acp --login` |
| Grok Build | `grok --no-auto-update --permission-mode default agent stdio` | 发布版条款；源码 Apache-2.0 | `npm i -g @xai-official/grok`，1.0.77 起 | `grok login` |

- Cursor 的安装脚本同时建 `agent` 与 `cursor-agent` 两个链接，预设用后者：`agent` 这个名字可能属于别的程序。
- Claude Agent 与 Cursor 不是开源软件。Latch 不读取、保存或转交任何一家的凭据，不调用私有接口。对外宣传「可用 Claude 订阅」之前要先取得 Anthropic 的书面确认；个人在自己电脑上使用不受影响。
- 已退役的预设 ID（`RETIRED_AGENT_PRESETS`）：带它的定义留在设置里、会话只读，Latch 不再启动它的命令。

**查找命令。**

- Host 启动时、开始监听前用账户的 shell 跑一次 `-ilc`，读出 `PATH` 与「进程与环境」点名的变量；8 秒没结束就杀掉整个进程组。登录 shell 的 PATH 排在 Host 自己的之前。
- 不经 shell，在 PATH 以及 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.npm-global/bin`、`~/.local/bin`、`~/.bun/bin`、`~/.grok/bin` 中查找；含 `/` 的相对路径按找不到处理。
- 另查用户目录里版本与包管理器的全局目录：fnm（`$FNM_DIR` 或 `~/.local/share/fnm` 下的 `aliases/default/bin`）、nvm 的默认别名指向的 `bin`、`~/.volta/bin`、`~/.asdf/shims`、`~/.local/share/mise/shims`、`$PNPM_HOME` 与 `~/Library/pnpm`、`~/.yarn/bin`。来自环境变量的目录只在是绝对路径时使用。
- 只接受可执行的普通文件；查到的绝对路径计入启动指纹，这些目录也追加到 Agent 进程的 PATH。找不到时 Harness 显示为不可用并给出安装提示。
- 保存在适配器上的定义由 `fallback.drives` 说出它驱动的程序：只装了程序时写「已安装 codex，还差让 Latch 连接它的适配器 codex-acp」。
- 查找结果缓存 5 秒；`GET /link/api/agents`（「重新检测」与窗口重新获得焦点）清掉缓存。列表里每个预设带查找结果 `detected`。
- 预设的 `helperCard` 是它作为新建 Agent 候选的样子，只写做得到的。

### 版本门槛

profile 的 `minimumVersion` 是它的命令支持的最低版本，用 `<命令> --version` 读出。

| 预设 | 最低版本 | 经 Latch 使用模型服务时另要 |
| --- | --- | --- |
| Codex | 0.156.0 | 0.167.0 |
| pi | 0.84.4 | 1.5.0 |
| DeepSeek Harness | 0.2.2-rc.1（0.2.1-rc.1 之前的 ACP 一轮不等子 Agent 结算，取消也不等真实停止） | 同左 |
| Antigravity | 1.5.8 | 不支持 |
| Grok Build | 1.0.77 | 同左 |
| OpenCode | 直连 2.2.6（`opencode --version` 打印 `opencode v2.2.6`）；`opencode acp` 无（版本规则 1.x、2.x） | 2.2.6 |
| Qwen Code | 默认账号无；独立账号 0.27.4，版本无法确认时拒绝 | 0.26.8 |
| goose | 无 | 1.57.0 |
| Claude Agent | 直连 2.1.322（`claude --version`）；适配器无（版本规则见下） | 直连同左；适配器上是它自带的 Claude Code 2.1.318（`--cli --version`） |

怎样读：

- 只读标准输出第一行，整行是版本号（可带 `v`）才算。不经 shell，不发提示，10 秒上限，退出后还占着输出的子进程被结束。
- 与登录检查同一规则：只在启动脚本经 `startServer({ loginPrograms })` 打开后运行，测试 Host 碰不到真实程序。只读定义的命令就是预设命令名、或指向同一文件的路径时的那个文件；经 `node` 等启动的或项目里的同名文件不读也不挡。
- 只读已保存且启用的定义：Host 启动时读一次（最多 5 秒）；「重新检测」清缓存后等新结果（最多 5 秒）。没添加过的预设与停用的定义不读（`CommandDetection.versionUnread`）。
- 从新会话或「添加 Harness」选中预设时，保存定义之前读一次：太旧就拒绝，不保存、不开会话，草稿留在输入框。
- 结果按文件缓存。缓存说太旧时，新会话、已有会话的下一轮与进程启动前都再读一次：Volta、asdf、mise 的 shim 在升级后还是同一个文件。读完有变化时 Host 发一次 `refresh`。

低于门槛：

- 定义与预设在目录里是 `unavailable`、`statusReason: 'outdated'`，检测结果 `CommandDetection.outdated` 带 `need` 与 `upgrade`。草稿已选它时选择不变，不会自己换成别的 Harness。
- 新会话、已有会话的下一轮（已在运行的进程也不再接收）与「测试启动」都在启动进程前以 409 `harness-version-unsupported` 拒绝；这不记为「上次运行异常」。读版本发生在启动前的项目配置复查之前，复查仍是最后一步。
- 通常读不出版本（命令失败、超时、没打印）时由握手时限兜底。Qwen Code 独立账号每次启动都要确认版本。pi 的线另用 `clear_queue` 核对读不出版本的 pi（见「pi 的 RPC 模式」）。

### 新版本提示

设置里 Harness 的「检测」与管理设备的工作台「检查更新」在版本够新、但有更新的发布时提示「有新版本」：最新版本、当前版本，能看出安装方式时附更新命令（复制或填入终端），也可跳到该 Harness 的设置页。Latch 从不运行升级命令。

- 范围：profile 的 `minimumVersion.source` 写了来源的预设，只看它自己的程序。npm 包：Claude 直连 `@anthropic-ai/claude-code`、Codex `@openai/codex`、OpenCode 直连 `@opencode/cli`、pi `@earendil-works/pi-coding-agent`、DeepSeek Harness `@deepseek-ai/dsh`；Homebrew：Claude cask `claude-code` 与 `claude-code@latest`、Codex cask `codex`、OpenCode formula `opencode`、goose formula `block-goose-cli`。goose 没有版本门槛，profile 的 `releases` 只为此读 `goose --version`（门槛 `0.0.0`，从不拒绝，启动不等它）。Grok Build、Antigravity、Qwen Code 与适配器没有。当前版本只用版本门槛（或 `releases`）已读出的那次结果。
- 来源随安装方式：Homebrew 的 `Cellar/<formula>/` 或 `Caskroom/<cask>/` 下、且是 profile 列出的名称，问 `https://formulae.brew.sh/api/<formula|cask>/<名称>.json`（formula 取 `versions.stable`，cask 取 `version` 逗号前的部分）；Homebrew 的构建比 npm 晚几小时，不拿 npm 比。未列出的 Homebrew 安装不问。其他布局在 profile 写了 npm 包时问 `https://registry.npmjs.org/-/package/<包>/dist-tags`，否则不问（goose 自己的安装器没有来源）。见 [ARCHITECTURE](ARCHITECTURE.md#各功能的安全规则)。结果只在内存，每个包、formula 或 cask 6 小时；失败或形状不对不提示，10 分钟内不再问。只在管理设备读取 Agent 设置（`GET /link/api/agents`；工作台首次加载有已启用外部 Harness 时用 `?recheck=0` 复用已读版本，点开「检查更新」或「重新检测」时重读命令版本）时问，不定时；已启用定义的 `update` 与 `outdated` 只投影给有 `admin` 的设备的 `catalog.harnesses`。只有启动脚本传入 `startServer({ harnessUpdates })` 时开启，测试 Host 不发请求。
- Claude 的通道（只用于 npm 来源）：读 Claude 配置目录（`CLAUDE_CONFIG_DIR`，否则 `~/.claude`）里 `settings.json` 的 `autoUpdatesChannel` 这一个键（不跟随链接，最多 1 MiB）；`stable` 取 `stable` 标签，缺失或其他值取 `latest`；那个标签不存在就不提示。不读登录与凭据。
- 比较：当前版本严格低于该标签才提示；比较不了、相同或本机预发布版更高都不提示。已有 `outdated` 时不另提示，那一行已带命令。
- 命令按找到的路径、`realpath` 与安装布局选择，不运行 `npm prefix`、`brew --prefix` 或版本管理器：
  - 在 Homebrew 的 `Cellar/<formula>/` 或 `Caskroom/<cask>/` 下：`brew upgrade <名称>`（先于 npm 判断，Homebrew 从 npm 包构建的 formula 也带 `lib/node_modules`）；
  - 含 `/lib/node_modules/<包>/`：`npm i -g <包>@latest`；
  - Claude 自己的安装器布局（含 `/.local/share/claude/` 或 `/claude/versions/`）：`claude update`；
  - pi 官方安装器的 `bin/pi` 旁有 `install/managed-install.json`，用 `pi update --self` 更新。之后按「重新检测」读取同一入口现在运行的版本。版本提示沿用 pi 的 npm 发布版本。[Pi 命令行文档](https://docs.pi.dev/latest/cli#update-pi-or-packages)
  - 其他：只显示版本，不给命令。
- 低于门槛时 `outdated.upgrade` 与拒绝文字用同一规则，看不出安装方式时才回落到 profile 的 `upgrade`。
- 没有开关；v1 只覆盖上面这些预设。

## 预设的权限配置

每个预设的 `HarnessProfile` 只在 Host 上使用；浏览器只看到复制进 `TaskDetail.permission` 与 `HarnessInfo.permission` 的展示字段。

- **`version` 计入启动指纹。** 改变 profile 的行为时递增它；已有会话因此停止接受输入，换新会话继续。DSH 的前台文字委托在普通会话指纹之上另绑定本轮运行 ID 和文字限制版本。更改仅用于委托的适配时递增该版本，已有人工聊天继续沿用原指纹。
- **选择。** 按定义的 `presetId`，否则按命令的文件名匹配预设。选中预设后它的环境变量与模式规则就生效。
- **已验证的预设。** 只有 `presetId` 与参数都与预设一致、命令就是预设的命令、且定义没有设置 profile 的 `configEnv` 变量时才算，否则显示「未验证的定义」。「就是预设的命令」指只写命令名，或写 Host 按该名字找到的那个文件（按真实路径比，指向它的链接也算）；其他目录里的同名文件不算。每次启动重新判断。
- **`configEnv`。** 会改变 Agent 读取配置位置的变量，比较不区分大小写：OpenCode 是 `XDG_*`、`OPENCODE_*`、`USERPROFILE`，Grok Build 是 `GROK_*`。设置了其中之一的定义仍可保存和运行，会话权限说明里注明它可能覆盖 Latch 设置的询问规则。
- **没有匹配预设的定义**不设置模式，但 Agent 自行改变模式一律按漂移处理。
- **所有预设**一律隐藏 `allow_always` 与 `reject_always` 类型的选项，不可配置。

| 预设 | Latch 设置的 | 预期模式 | 模式顺序（严 → 宽） | 另外隐藏的选项 | 读回 |
| --- | --- | --- | --- | --- | --- |
| Codex 直连 | 每轮随 `turn/start` 发模式 | `read-only` | `read-only`、`workspace-write`、`agent`、`agent-full-access` | 只给一次性的允许与拒绝 | 线保存并报告 |
| Codex 经 codex-acp | `INITIAL_AGENT_MODE=read-only`、`CODEX_PATH` | `read-only` | 同上 | `accept_execpolicy_amendment`、`apply_network_policy_amendment*` | 可读回 |
| Qwen Code | — | `default` | `plan`、`default`、`auto-edit`、`auto`、`yolo` | — | 可读回；恢复会话会恢复旧模式，每轮前重设 |
| goose | `GOOSE_MODE=approve` | `approve` | `chat`、`approve`、`smart_approve`、`auto` | — | 可读回 |
| DeepSeek Harness | 私有 `--patch` 插件、`DSH_PERMISSION_MODE`、`DSH_TELEMETRY_DISABLED=1` | `read-only` | `read-only`、`workspace-write`、`danger-full-access` | — | 它的权限服务报告 |
| OpenCode | `OPENCODE_CONFIG_CONTENT` | `build` | `plan`、`build`、`auto-edit`、`yolo` | — | 可读回 |
| pi | 私有 `-e` 扩展 | `ask` | `plan`、`ask`、`rule`、`never` | — | 扩展报告 |
| Claude Agent | — | `default` | `plan`、`default`、`acceptEdits`、`auto`、`bypassPermissions` | ExitPlanMode 只留 `exit-plan-default` | 可读回；适配器新会话默认进 `auto`，每轮前设回；直连新会话以 `default` 开始，模式由线经 SDK 设置并报告 |
| Cursor | `--mode` 或 `--force` 启动参数 | `agent` | `ask`、`plan`、`agent`、`agent-force` | `allow-always` | ACP 报告前三档；force 只标为启动设置 |
| Cursor 经 SDK | 创建或恢复 agent 时的工具名单与沙箱 | `read-only` | `read-only`、`sandbox`、`full` | 不询问，没有选项 | 运行器报告它交给 SDK 的档位 |
| Antigravity | 「不再询问」用启动参数 `--dangerously-skip-permissions` | `default` | `default`、`accept-edits`、`auto`、`turbo` | — | 原生模式可读回；`turbo` 只标为启动设置 |
| Grok Build | 预设参数 `--permission-mode default` | 无 | 无 | — | 不报告模式（`readback: 'none'`），不生成档位；`/always-approve` 不列出、不转发（`modeCommands`） |

**DeepSeek Harness。**

- 每次启动在会话私有临时目录写 0600 的 `--patch` 文件与插件，经它公开的 `permissionPresets.set/current` 设置并报告档位；不读写 dsh 自己的会话文件。
- 报告同时绑定当前进程与 ACP session ID，未知组合拒绝发送。
- 换档只在会话空闲、没有后台子 Agent 时：结束旧进程，带选择启动新进程并恢复同一会话，真实读到目标值才算完成。核对不用 setter，只报告服务的当前值。
- `workspace-write` 直接允许写工作目录与许可的临时目录，扩大范围才询问。

**OpenCode。** `OPENCODE_CONFIG_CONTENT` 写下的规则：

- 除读取、glob、grep、list 以外的工具先询问；访问工作目录以外的路径（`external_directory`）先询问（2.x 默认放行）；拒绝读取 `.env` 与 `.env.*`。
- 同样的规则也写进 `build` 与 `plan` 两个 Agent，避免它们各自的设置覆盖全局。`plan` 另拒绝 `edit`（含写入与补丁工具）与 `bash`，所以计划模式不改文件、不运行命令，也不写自己的计划文件。
- `auto-edit` 与 `yolo` 是 Latch 用同一份配置声明的两个主 Agent：前者沿用 `build` 只放行文件编辑，后者直接允许工具。
- 子 Agent：先写 `task: 'deny'`，再写 `subagent: 'ask'`。1.x 只认 `task`，子 Agent 保持禁用（1.x 的 ACP 不回答子会话的权限请求，子 Agent 会一直等）；2.x 把 `task` 读作 `subagent`，后写的生效，启动子 Agent 先问。`plan` 另写 `subagent: 'deny'`：子 Agent 按它自己的 Agent 工作，不受 `plan` 的拒绝约束。
- 加载顺序（2.2.6 `config.ts`，直连）：托管策略、全局配置目录、`OPENCODE_CONFIG` 文件、向上查找的 `opencode.json`/`opencode.jsonc`、项目 `.opencode`，然后才是 `OPENCODE_CONFIG_CONTENT`，最后是系统托管设置。OpenCode 按「最后匹配」求值，所以人的全局与项目配置里的放行排在 Latch 的 `* ask` 之前，被它盖住（用 `GET /api/agent` 读回展开规则核对过）。仍能越过 Latch 询问的是：系统托管设置、`.opencode` 里新定义的 Agent（不在模式顺序里）、插件的 `permission.evaluate` 钩子，以及数据库里这个项目的「总是允许」（见下）。`opencode acp`（1.x 与旧定义）的合并顺序没有核对，仍按「可能被覆盖」说明。项目里的配置计入启动指纹，用户配置不计入。
- **「总是允许」。** 人在 OpenCode 自己的界面里点过 Always 的动作与资源存在它的数据库里，按项目保存，求值时作为 `allow` 加在所有规则之后（`deny` 除外），所以在 Latch 的 `build` 等模式里同样不再询问。直连在开会话和恢复时读 `GET /api/permission/saved`（带 `location[directory]`），在权限面板的模式下面逐条列出「总是允许 · 动作 资源」（`SessionPermission.inEffect`，最多 20 条）；只读，不删除也不改。Latch 自己从不回答 `always`：审批只给一次性的选项。
- **配置必须完整。** 2.2.6 收到不是 JSON 的 `OPENCODE_CONFIG_CONTENT` 时只记一条警告，照常启动，什么都不问（内置的 `* allow`）；某个值不合法时跳过那一项。所以直连只在最终的 `OPENCODE_CONFIG_CONTENT` 是 JSON 对象、且 `permission` 与 `build`、`plan`、`auto-edit`、`yolo` 的 `permission` 与 profile 写的完全相同时才启动服务（`latchConfig`，`opencode.test.ts` 覆盖定义的变量、网关三种协议的内容与各种残缺）。
- 托管设置、`.opencode` 中的插件与项目新定义的 Agent 不受这些规则约束；这样的 Agent 不在模式顺序里，按更宽的模式对待。OpenCode 启动时会在 `.opencode` 安装依赖并加载插件，所以在不信任的项目里使用会运行项目里的代码。会话权限说明注明这两点。

**Cursor。** 前两档以 `--mode` 启动，`agent` 不传，`agent-force` 加 `--force`；空闲换档时重启、恢复并核对 ACP 模式。`--force` 不覆盖显式拒绝；ACP 不独立报告它，所以 force 档带 `source: launch`，一次重启不算对旧标志的核对。尚未做真实 Cursor 验收。

**Claude Agent。**

- 自动模式由 Claude 的分类器决定是否执行；计划模式在自动模式可用时，命令也可能由分类器决定。
- **模型请求失败。** Claude 把错误写成一条回复（「API Error: 400 …」），再以 JSON-RPC 内部错误结束这一轮。失败行去掉每个内部错误都带的「Internal error: 」；一轮的全部回复正好是失败行里的那段错误（没有思考或工具）时，页面只显示失败行，这条回复仍在会话里、沿用原 ID。
- Claude 不需要批准的调用（工作目录内读取、只读命令）不出现在审批里；Claude Code 设置里的允许规则与 hooks 先于 Latch 生效；项目 `.mcp.json` 的服务器直接连接。
- **人选的换档（`modeAnswers`）。** Agent 用一次询问来换模式时，人的「仅此一次」回答就是选了那一档：ExitPlanMode 的 `exit-plan-default` 回到 `default`，EnterPlanMode 是 `switch_mode` 调用上的 `allow-once`，进入 `plan`。Latch 在把回答交给 Agent 之前把这一档记为预期模式，随后的换档不算漂移；没有人回答的换档仍是漂移。

**Antigravity。**

- `plan` 只追加规划指令，不保证只读：保留原生名称，不归入权限档位，只由人显式选择，不参与跨 Harness 的只读档位继承。
- `default` 下 CLI 自己的 `toolPermission`、允许与拒绝规则仍优先，可能直接改文件。Latch 设定并读回 mode，但不据此断言每次工具调用都询问；CLI 请求审批时只给单次选择。
- `auto` 会评估命令，遇到高风险操作仍可能询问。选「不再询问」（`turbo`）时，Latch 给这个会话的 `agy acp` 加上 `--dangerously-skip-permissions`。切回普通档时，Latch 停掉带参数的进程，用普通参数恢复同一会话，再按所选档位和 CLI 自己的规则处理工具请求。进入或离开「不再询问」都要等会话空闲。
- `agy` 1.5.17 带或不带这个参数开会话，ACP 都报告 `default`。因此「不再询问」标为「启动设置 · 未独立读回」，只表示 Latch 已经按选择启动该进程。[Google 的 ACP 权限说明](https://antigravity.google/docs/ide/extensions/acp/#permissions)
- 如果自定义 Harness 的启动参数已经固定开启 `--dangerously-skip-permissions`，原生模式仍可选，所有模式都沿用免询问。要恢复询问，先从该定义移除这个参数，再开新会话。
- 用 `session/resume` 恢复。恢复后 CLI 报告的模型与思考回到它的默认值（`resumeResetsOptions`）：下一条消息发出前 Latch 按会话原先显示的值重设并逐项读回（先模型、后思考），CLI 不再提供或没有采用时这条消息不发出。所以这两项的「核对」不重新打开会话，结果保持未知；权限模式照常核对。
- 服务端拒绝一轮时 CLI 只发一段固定正文并以 `end_turn` 结束，不报告原因。profile 的 `terminatedReplies` 记下这段正文：一轮的全部回复正好是它（首尾空白除外）时记为失败，那条回复沿用原消息 ID 并标为失败；只是包含这段文字的仍是普通回复。只对 Antigravity 生效。
- 创建空会话可能加载扩展，所以模型列表只在人请求时读取。

**Grok Build。** stdio 模式是独立的 Agent 进程，不连接终端用的共享 leader；Latch 不运行 `grok leader kill`，只停自己启动的进程。继承 `GROK_HOME` 的名字与路径，不读其中的登录文件；会话经它自己的 ACP 列出与载入（见「接入已有会话」）。

- **模式。** 1.0.89 的 initialize 与 `session/new` 都不报告模式。`session/set_mode` 只接受 `default`、`ask`、`plan`，只有进入 `plan` 时推送 `current_mode_update`；`auto`、`bypassPermissions`、`always-approve` 都是 -32602。`_meta.yoloMode`、`_meta.autoMode`（`session/new`、`session/load`、`session/resume`）是文档化的入口，但设了之后没有任何通知或回答提到它（`_x.ai/yolo_mode_changed` 没有出现）。所以 Latch 仍不生成档位。
- **`/always-approve`。** 它在 `available_commands_update` 里列出，`on` 让会话不再询问，不经 ACP 报告。Latch 不把它列进会话命令，以它开头的输入（新会话、输入与运行中追加）返回 409 `mode-command-refused`，不发给 Grok（profile 的 `modeCommands`）。
- **它自己记住的回答。** 人在 Grok 自己的界面里选「Always allow」或「never allow」时，回答存在 `$GROK_HOME/sessions/<URL 编码的项目根>/permission.toml` 与 `permission_<client>.toml`，在 Latch 的会话里同样生效。会话（不经网关时）接上进程后，Latch 只看这些文件在不在、是否非空（项目根是 Git 仓库根，不在仓库里时是会话目录；给的路径与真实路径各查一次），有就在会话权限说明里加一句，从不读内容：格式没有文档。编码超过 255 字节时 Grok 改用哈希名，工作树还用主检出的回答，这两种不查。

### 版本规则

`versionRule` 要求 `initialize` 返回的 `agentInfo.version` 匹配一个正则。不匹配或没报告版本时 Latch 结束进程，会话以 409 `harness-version-unsupported` 失败。

| 预设 | 规则 | 原因 |
| --- | --- | --- |
| OpenCode | `^[12]\.` | 配置键是 1.x 的格式；2.x 仍读 `OPENCODE_CONFIG_CONTENT` 并把它换成同样的有序规则（后写的优先，`task` 换名 `subagent`，`bash` 换名 `shell`）；3.x 的读取方式未核对 |
| Claude Agent | 0.99 起的 0.x 适配器 | 新的大版本可能以别的方式开会话或报告模式 |

OpenCode 2.x 的核对依据是它的源码与按源码手写的回放（`replay/opencode/2.x/`），不是运行中的 OpenCode。

## 项目配置

多数 Agent 启动时读取项目里的配置，它能改变询问规则、加载插件或扩展。预设的 `projectConfigPaths` 的内容计入启动指纹，会话启动后任何变化都让会话不能继续。这是启动前的一致性检查，不是隔离。

| 预设 | 计入 | 不计入（Agent 自己写的） |
| --- | --- | --- |
| OpenCode | `opencode.json`、`opencode.jsonc`、`.opencode/` | `.opencode/` 下的 `node_modules`、`bun.lock`、`bun.lockb`、`.gitignore`、`plans`；`.opencode/package.json` 里它自己加的 `@opencode-ai/plugin` 依赖（只剩这一项时整个文件不计） |
| Codex | `.codex/`；收到其他文件夹的会话另计每个文件夹的 `.agents/skills/` | — |
| Qwen Code | `.qwen/`、`.agents/skills/`（技能可带钩子）、`.mcp.json` | — |
| pi | `.pi/`、`.agents/skills/` | `.pi/npm`、`.pi/git` |
| Claude Agent | `.claude/`、`.mcp.json` | `.claude/worktrees` |
| Cursor | `.cursor/`、`.cursorrules` | — |
| Antigravity | `.agents`、`.agent`、`_agents`、`_agent`、`.gemini/config.json`（清单引用的这些目录之外的代码不在覆盖范围内） | — |
| Grok Build | `.grok/`，以及它兼容读取的 `.claude/`、`.mcp.json`、`.cursor/`、`.agents/` | `.claude/worktrees` |
| goose | `.goose/`、`.agents/recipes/`、`.agents/agents/`（`summon` 读的配方与 agent 源，能把子 Agent 换到别的 provider）；同样会读的 `.claude/agents/` 是 Claude 的设置，不读 | — |
| DeepSeek Harness | 无 | — |

- **查找范围。** 从会话目录逐级向上到根目录，分别沿 Agent 收到的路径（可能经过符号链接）与它的真实路径；同一目录只查一次。主目录本身跳过，因为那里是 Agent 的用户级数据。范围比各 Agent 自己的（通常到 Git 仓库根）更宽。
- **其他文件夹。** Agent 收到的其他文件夹（见下节）同样从它们开始向上查找，与会话目录共用上限。
- **何时重算。** 新建会话时、每次输入与修改设置之前、每次启动 Agent 进程之前（首次启动、恢复、空闲停止后的重启；启动前的等待之后再查一次），以及为删除会话临时启动进程之前。
- **结果。** 只有项目配置变化时返回 409 `project-config-changed`，定义也变化时是 409 `agent-definition-changed`。为删除会话启动进程的检查不通过时只删除 Latch 的记录。Agent 按用户要求改了这些配置，之后的输入同样被拒绝。

## 项目的多个文件夹

一个项目可以由几个文件夹组成（见 [ARCHITECTURE.md](./ARCHITECTURE.md#会话与项目)）。ACP 会话的工作目录（ACP 的 `cwd`，也是进程的工作目录）始终是主文件夹。在新工作树里开始的会话例外：工作目录是工作树，指纹按工作树里的项目配置算，不交其他文件夹（工作树的规则见 [ARCHITECTURE.md](ARCHITECTURE.md#git-与工作树)）。

| 预设 | 其他文件夹怎样交给它 | `HarnessInfo.projectFolders` |
| --- | --- | --- |
| Codex | 直连：`workspace-write` 一轮的可写根（`sandboxPolicy.writableRoots`）；经 codex-acp：ACP 的 `additionalDirectories` | `{ access: 'all' }` |
| Antigravity | ACP 的 `additionalDirectories` | `{ access: 'all' }` |
| Qwen Code | 定义的参数之后，每个文件夹追加一次 `--include-directories <真实路径>` | `{ access: 'all', max: 5 }` |
| OpenCode、Claude Agent | 不传；它们访问会话目录以外的路径时询问 | `primary-asks` |
| pi、goose | 不传；它们不限制工具能访问的路径 | `primary-unbounded` |
| DeepSeek Harness | 不传（它拒绝这个字段） | `primary` |
| Cursor、Grok Build、未匹配预设的定义 | 不传 | 无（客户端按 `primary` 显示） |

- **ACP 的 `additionalDirectories`。** 只在 `initialize` 声明 `sessionCapabilities.additionalDirectories` 时发送，`session/new`、`session/resume`、`session/load` 每次都发完整列表。没有声明时 Latch 结束进程并返回 409 `agent-folders-unsupported`，会话不创建。codex-acp 把每个文件夹当受信项目并加载其中的 `.agents/skills`。
- **Qwen Code。** 最多 4 个其他文件夹，超出返回 409 `harness-folder-limit`，不启动进程。它按逗号拆分参数，含逗号的路径返回 400 `workspace-folder-chars`。
- **谁收到。** Host 只把项目标识与全部文件夹交给 profile 有 `folders` 的 Driver（`projectFolders: 'all'`）。声明 `historyImport` 的 Driver 也拿到 `projects()`，只用来核对接入的会话目录仍在主文件夹之内。
- **核对。** Driver 用 `projects()` 再核对：项目在列表中、`folders[0]` 是主文件夹、每个文件夹的标识与真实路径都属于该项目，否则 400 `workspace-unavailable`。交给 Agent 的是真实路径，按项目中的顺序，不含主文件夹、不重复。
- **固定在会话上。** 摘要记 `workspaceId`、`folders`、`folderAccess: 'all'`，`acp.folders` 与 `acp.folderVia` 记交出的真实路径与方式，之后不变：项目新加的文件夹只用于新会话。只收到主文件夹的会话由 Host 标 `folderAccess: 'primary'`。`workspaces()` 也列出项目内仍可用的旧主文件夹，调整顺序后的已有会话继续用原工作目录。
- **每次复查。** 输入、修改设置、启动进程、恢复或加载会话、为删除临时启动进程之前，确认这些文件夹仍属于该项目且在原真实路径；否则 409 `workspace-changed`（删除时只删 Latch 的记录）。之后启动的进程不再声明支持时本轮不发送，409 `agent-folders-unsupported`。
- 其他文件夹计入启动指纹与项目配置，审计记数量 `folderCount`。范围由 Agent 自己执行，不是隔离。

## 启动指纹

开始会话不弹确认。`launchHash` 由以下各项算出：

- 解析出的命令路径、参数、定义的变量；
- 预设（profile 版本、`inheritEnv` 的名字、`programEnv` 找到的路径）；Qwen Code 自己更新后实际运行的版本（`selfUpdates`，见「CLI 自己的存储」），它在运行安装的那个版本时不计入；
- 计入的项目配置、交给 Agent 的其他文件夹；
- 经 Latch 使用的模型服务：服务 ID、源、协议、交法与变量名，不含凭据。

不含项目配置、文件夹与模型服务的部分另记为 `definitionHash`。两者保存在 `acp.launchHash` 与 `acp.definitionHash`。

- 审计：`task.l3.start-requested` 记 `launchHash`，`task.l3.started` 再记 `definitionHash`；接收 Latch MCP 服务器的 Harness 另记 `mcpSetHash`（见 [MCP.md](MCP.md)）。
- 指纹不含任何变量的值：`launchHash` 会发给客户端，代理地址可能带密码。代理与 CA 的名字固定，不进指纹，换代理不影响已有会话。
- 按「项目配置」所列时机重算：定义或解析出的命令变了返回 409 `agent-definition-changed`，只有项目配置变了返回 409 `project-config-changed`。已有会话停止接受输入，换新会话继续。

## 启动诊断

Agent 详情页的「测试启动」：`POST /link/api/agents/:id/probe { requestId }`，要同时有 `admin` 与 `run`，不弹确认。

- 只发 ACP `initialize`，不发 `authenticate`、`session/new` 或提示词。低于版本门槛的命令不运行。
- 握手最多 15 秒，随后停止进程组并等真实退出。宣告登录状态推送的 Agent 握手后最多等 5 秒。登录检查与版本读取在剩下的时间里并行，每项最多 10 秒；整次最多 20 秒（`AGENT_PROBE_MAX_MS`），页面等 25 秒。Host 关闭会取消并等待探测。
- `authMethods` 只说明程序提供哪些登录方法，不证明没登录：握手成功只是 `ready`，模型访问未验证。只有明确的 `auth_required` RPC 错误是 `authentication-required`，其他失败是 `failed`。
- 会话启动与读取可选项的握手也记下 `initialize` 报告的图片与 embeddedContext 能力（`promptCapabilities`，按定义哈希）。
- 结果带 `checkedAt`、`launchHash` 与最多 4 KiB 的诊断：先按定义变量与秘密格式脱敏，再截取结尾。保存为 `AgentRecord.lastProbe` 与 `probedDefinitionHash`；改启动内容会清除它。
- 探测通过不等于会话已启动，不改 `startedHash`，不授予以后启动的信任。
- 审计：运行前 `agent.probe.requested`，结束后 `agent.probed`，只含 ID、哈希与状态。
- 同设备同 `requestId` 在当前 Host 生命周期内共享整次探测，重试不再执行程序；记录只在内存，Host 重启后会再执行一次。

**适配器驱动的程序（`programVersion`）。** 保存在 codex-acp 上的定义，探测后再读它驱动的 Codex 的版本：定义设了 `CODEX_PATH` 用它的值，否则是 Host 找到的 `codex`；相对路径不解析，写「版本未知」。两个版本都知道、又不在 profile 的 `checked` 里时 `program.unchecked` 为真，页面提示这个组合没核对过，不阻止启动。`checked` 是每个适配器版本 `package.json` 的依赖范围（codex-acp 2.3.0 配 Codex 0.164.x，2.4.0 与 2.5.0 配 0.165.x）。

## 进程与环境

- **每会话一个进程。** 首次需要时启动，工作目录是会话的主文件夹，在独立进程组中运行。同一定义最多同时 8 个进程（`AcpAgentOptions.maxProcesses`）：到上限时停掉最久未用、可恢复的空闲进程，没有可停的返回 503 `agent-busy`。
- **空闲。** 空闲 10 分钟且 Agent 支持恢复会话时优雅停止，下次需要时再启动。我的 Agent 的会话放宽到 30 分钟（`agentIdleMs`，不短于 `idleMs`）；后台定时运行（`acp.unattended`，无论能否提议都记下）仍是 10 分钟。
- **预热（`Bridge.warm`）。** 打开某个 Agent 的唯一聊天时，Host 可以让驱动先启动这个会话的进程并恢复会话，与下一轮的绑定相同，但不发提示、不调模型。只在同一定义的进程数低于 `maxProcesses` 时做：到上限时放弃，从不为它停掉别的会话的进程；会话在运行、等你处理或另有操作时不做；先做一轮会做的检查（`assertUsable`、`assertWorkspace`、`assertLaunch`），不通过就不启动。失败只是没有预热，下一轮照常启动并说明原因；预热的进程在第一轮用到它之前崩溃不计入连续崩溃暂停。只有 `run` 加数据范围 `all` 的设备能触发，先审计 `agent.warm.requested`，写不进就不预热；Host 只用自己记录的聊天槽，不接受客户端给的会话 ID。
- **崩溃。** 会话转为 `failed`，`runEnd` 为 `process-exited` 并列出结果未知的调用，`runOutcome` 仍是 `interrupted`（见 [STREAMING.md](./STREAMING.md#运行的真实状态)）。重启从 250 ms 起按最近崩溃次数加倍（最多 5 秒）；同一定义一分钟内崩溃 3 次，暂停自动重启一分钟（503 `agent-paused`）。
- **stderr。** 持续读入 64 KiB 环形缓冲，只在启动失败或崩溃时以脱敏的短摘要写进 Host 日志，不进会话记录。
- **脱敏。** Agent 自己写的回复、思考与工具输出原样进入会话。它报告的错误、提示、压缩失败与停止原因先遮蔽定义的变量值、Host 的秘密变量与网关凭据，再经 `redactSecrets`：模型服务的报错常带着密钥的一部分。
- **握手时限。** `initialize` 最多 30 秒（`handshakeTimeoutMs`），`session/new`、`session/resume`、`session/load` 与分叉最多 60 秒（`sessionSetupTimeoutMs`），一般请求 120 秒。到时结束整个进程组，这一轮以 504 `agent-handshake-timeout` 失败。提示词一轮本身不设时限。
- **协议版本**必须是 1，否则启动失败。

**环境（`agentEnvironment`），后者覆盖前者：**

1. Host 的白名单：`HOME`、`LANG`、`LC_*`、`TERM`、`USER`、`SHELL`。
2. 代理（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及小写）、CA 文件（`SSL_CERT_FILE`、`SSL_CERT_DIR`、`NODE_EXTRA_CA_CERTS`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE`）与 `__MISE_DIFF`。
3. profile 的 `inheritEnv`（各家的 home，见下表）。从终端启动的 Host 已有的值优先于登录 shell 读到的。
4. profile 的 `programEnv`：`CODEX_PATH` 指向 Host 找到的程序，没装就不设，适配器用自带的。
5. Agent 定义的变量（保留名不能设，400 `agent-env-reserved`）。
6. profile 的 `defaultEnv`，以及 Latch 强制的 `TMPDIR`、`NODE_TLS_REJECT_UNAUTHORIZED=1` 与 Git 设置（关闭 fsmonitor 与钩子）。
7. 经 Latch 使用模型服务时的网关变量。

最后删除 `NODE_OPTIONS`、`LATCH_*`、`npm_*`、`DYLD_*`、`LD_*`。

| 预设 | 继承的 home（`inheritEnv`） |
| --- | --- |
| Codex | `CODEX_HOME`、`CODEX_SQLITE_HOME` |
| pi | `PI_CODING_AGENT_DIR` |
| OpenCode | `XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME`、`XDG_CACHE_HOME` |
| DeepSeek Harness | `DSH_HOME` |
| Qwen Code | `QWEN_HOME`、`QWEN_RUNTIME_DIR` |
| goose | `GOOSE_PATH_ROOT`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME` |
| Claude Agent | `CLAUDE_CONFIG_DIR`（定义不能设置） |
| Grok Build | `GROK_HOME` |

- 没有预设的自定义定义只继承第 1、2 项。
- `inheritEnv` 不能点名 `*_KEY`、`*_TOKEN` 这类秘密。读登录 shell 时只取点名的变量，其余输出丢弃、不记日志；shell 拿不到 `LATCH_*` 与 `NODE_OPTIONS`。
- 诊断与预览不显示变量的值，带账号密码的代理地址被遮盖。
- 会话用 Harness 自己的登录与模型时，密钥与地址在 Agent 自己的配置里，或写进定义的环境变量。用设置里保存的模型服务时 Agent 拿到的是网关凭据，不是密钥。

**Latch 在 `initialize` 声明的能力（`clientCapabilities`）：**

- `fs.readTextFile`、`fs.writeTextFile` 与 `terminal` 都是 false：Agent 用自己的文件与命令执行能力。
- `session.notices` 与 `session.compaction`（见「通知与压缩」）、`subagents`（见「子 Agent」）。
- Host 提供 `askUser` 时声明 `elicitation: { form: {} }`（见「Agent 的提问」）。
- 除写了 `signIn` 的预设外声明 `auth.terminal`（见「登录」）。

Agent 发来的请求只处理 `session/request_permission` 与提问，其他见「不支持的请求」。Latch 不调用 `authenticate`：Agent 要求登录时返回 409 `agent-auth-required` 并停掉进程（它可能只在启动时读登录状态），这一轮的 `runEnd` 是 `login-required`；重试启动新进程，已有 ACP 会话时走 `session/resume`。

**`mcpServers`**（`session/new`、`session/resume`、`session/load` 与分叉）依次是：

1. `latch-skills`（`skills-server.ts`）：会话带技能、或属于某个 Agent 或「和通用的对话」时有；Latch 内置的指引（如[操控这台 Mac](MCP.md#给-agent-的指引)）排在 Agent 的技能之后。后一种另有 `propose_memory` 与 `propose_schedule` 两个写工具；Host 给了 `workProposals` 的会话（Code 会话也是）另有看板的 `propose_todo`、`propose_todos`、`propose_card`（[ARCHITECTURE.md](ARCHITECTURE.md#agent-的提议)），为此没有技能的会话也接上它。写工具只往会话私有目录的 `proposals.jsonl` 追加提议（文件的规则见 [ARCHITECTURE.md](ARCHITECTURE.md#我的-agent-与定时)）；不联网。这些会话还带 `team` 模式：只在 Host 写下的 `team.json` 在时列出 `list_members` 与 `send_to_members`，派活写进单独的 `rounds.jsonl`（规则见 [ARCHITECTURE.md](ARCHITECTURE.md#团队与交接)）。
2. `latch-browser`（`browser-server.ts`）：打开、恢复、载入或分叉有项目的会话时，已登记的桌面浏览器提供方可提供浏览器工具。个人 Agent 即使没有桌面提供方，也可获得仅限协作工具的连接；主动联系对方须开关开启且处于人直接发起的当前轮次。`initialize` 带几条 `instructions`：要看布局先 `browser_viewport` 再 `browser_read`；只用最新一次读到的引用；只开本机地址；登录与密码交给人；最后用截图与控制台错误验证。Codex 直连把它列为延迟加载的工具时，模型看不到这段文字（真实 CLI 核对，Claude Agent 与 OpenCode 能看到）。令牌 `lbt1.` 在网关目录的 0600 文件里，服务只拿到文件路径，读出即删，参数与 `env` 里没有它，每次换新。会话启动时没有桌面提供方，这个进程就不会获得浏览器工具。DSH 0.2.2-rc.5 的个人聊天已用 `deepseek-flash` 验证可以通过协作工具联系 Latch 内置 Agent，并在同一轮读到对方的答复（工具与令牌的规则见 [ARCHITECTURE.md](ARCHITECTURE.md#设备与浏览器)）。
3. 会话「用在」的每个 Latch MCP 服务器各一个 `latch-mcp` 桥：命令是 Host 的 Node，参数只有网关套接字与令牌文件的路径，`env` 为空；坏掉的服务器不挡会话（见 [MCP.md](MCP.md)）。

- 都没有时传空列表。pi 的预设写了 `skillServer: false`，三者都不给。
- Codex 直连时这些服务器随线程的 `config.mcp_servers` 交给 app-server（桥带 `startup_timeout_sec: 60`）。Codex 可能把线程配置写进它自己的会话文件：留下的是套接字与令牌文件的路径，没有令牌。
- 会话归档后，同一进程上的浏览器工具回答要等会话恢复；取消归档后要等进程重新启动才回来。

外部 Harness 的指令与记忆随话题的首轮块发送；记忆与定时提议的来源按当前上下文已送达的资料标记：导入的与读过外部内容之后存的记忆是资料，不是用户的话（见 [ARCHITECTURE.md](ARCHITECTURE.md#我的-agent-与定时)）。

个人 Agent 接单沿用自己聊天的模型。人给该目标开启「允许按自身权限接单」后，外部 Harness 使用正常的聊天回合与权限。默认的文字委托要求驱动能核验这一轮已禁用工具。目前接入此能力的外部适配是已确认的官方 DSH 0.2.2-rc.5 或更高版本。DSH 驱动为这个回合启动专用进程，复用目标聊天，通过 DSH 的工具服务禁止本轮的工具执行。驱动在 `session/prompt` 前核对进程、会话、权限模式、工具限制和发起方的授权。该进程不接收 Latch 工具桥，也不接受 ACP 工具审批，结算后退出。人的下一轮使用该聊天原先的权限设置。DSH 仍是以本机账户执行的 L3 程序。授权范围见[个人 Agent 主动协作](ARCHITECTURE.md#个人-agent-主动协作)。

## 经 Latch 使用模型服务

模型菜单同时列 Harness 自己的模型与设置里保存的服务。两组前提不同：自己的模型要它自己的登录；服务的模型由 Latch 转发、用设置里的密钥，**不需要这个 Harness 登录**。

- 选了服务的模型时不显示「还没登录」，Codex 直连在这样的会话里也不查自己的账户。
- Host 按实际协议能力与自己的服务记录重新核对每次开始；客户端不能决定转发地址或密钥。
- 会话里可以换到别的服务的模型，或在服务与 Harness 自己的登录之间换：Latch 在空闲时结束进程，按新路线启动并恢复同一会话。Codex 直连在自己的登录与服务之间换时用 `thread/fork` 把线程带过去（新线程、同样的历史）；Grok Build 与 goose 只能在服务之间换（`routeSwitch: 'services'`）。服务停用、删除、密钥或地址不可用时明确失败，不回退到 Harness 自己的登录或演示模型。
- 订阅仍由各 Harness 自己使用，不借给网关。
- 整轮没有经过网关时如实提示并审计；这不证明每个辅助请求都经过它。

网关是 Host 上的回环入口：按服务转发、在协议之间转换、重试与切换备选，并记下用量（规则见 [ARCHITECTURE.md](ARCHITECTURE.md#模型网关)）。这里只列每个 Harness 的事实（来自 profile 的 `gateway`）：

| Harness | 它说的协议 | 最低版本 | 交法 | 限制 |
| --- | --- | --- | --- | --- |
| Codex 直连 | Responses（Chat、Anthropic 服务经网关的实验性转换） | 0.167.0 | 启动参数里的自定义 provider `latch`，凭据在 `LMG_TOKEN` | 模型取服务的列表，可选 Codex 原生目录之外的 |
| codex-acp | Responses，实验性 | — | ACP `providers/set`，只在适配器声明并列出该 provider 与 API 类型时 | 只能用适配器认识的服务模型（`knownOnly`） |
| OpenCode | Chat、Responses、Anthropic | 2.2.6 | `OPENCODE_CONFIG_CONTENT` 里的私有 provider 与私有插件 | 插件把工具子进程里的令牌值清空 |
| DeepSeek Harness | Chat、Responses、Anthropic | 0.2.2-rc.1 | 私有 `--patch` 的 provider `latch-gateway` | 这条路线关掉它的会话日志与包清单遥测插件 |
| Claude Agent | Anthropic（Chat、Responses 服务经实验性转换） | 直连 Claude Code 2.1.322，适配器上 2.1.318 | 官方环境变量与会话的 `modelPicker` | 只按精确的模型 ID |
| pi | Chat、Responses、Anthropic | 1.5.0 | 私有扩展注册 provider，只在当前进程 | 模型要有上下文与输出上限：取运行预算、服务声明的上下文长度或 pi 自己目录里精确匹配的数值，都没有时不注册（所选模型缺少时拒绝开始）；高级环境可写 `PI_GATEWAY_CONTEXT_TOKENS` 与 `PI_GATEWAY_OUTPUT_TOKENS` |
| Qwen Code | Chat、Responses、Anthropic，实验性 | 0.26.8 | `QWEN_CODE_SYSTEM_SETTINGS_PATH` 指向 0600 的会话私有系统设置 | 没有子 Agent；凭据被工具子进程继承 |
| goose | Chat、Responses、Anthropic，实验性 | 1.57.0 | 只有环境变量；凭据在 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY` | `provider` 选项不提供；`delegate` 子 Agent 固定不了服务；凭据被继承 |
| Grok Build | Chat、Responses、Anthropic，实验性 | 1.0.77 | `GROK_HOME` 指向会话私有的家目录，其中 0600 的 `config.toml` 给每个服务模型写一个自定义模型，并关掉 Claude Code、Cursor 配置里的 MCP 服务器、插件与钩子 | 这个家里没有用户的 Grok 登录、钩子、插件与 MCP，也不启动 Claude Code、Cursor 配置里的 MCP 服务器与钩子；凭据被继承（见下） |
| Antigravity、Cursor | 不支持（`ownModelsOnly`） | — | — | Cursor 的推理走它自己的后端。Antigravity 1.5.x 的更新说明与设置文档写了 Gemini API key 路线（`modelProvider: "gemini"`、`GEMINI_API_KEY`，另一地址经 `GOOGLE_GEMINI_BASE_URL`，后者只见于更新说明，请求是否真发到那里未核对），网关没有 Gemini 协议，尚未接；模型菜单不给它们列服务 |

**凭据被工具子进程继承（`credentialInherited`）。** Qwen Code、goose 与 Grok Build 没有清理工具子进程环境的官方开关：它们运行的命令、钩子与 stdio MCP 服务器读得到网关凭据。经网关的会话里，Latch 经 ACP 交给 Harness 的自己的 MCP 服务器（技能、浏览器、`latch-mcp` 桥）都把凭据变量设为空。Grok Build 另按它的文档用 `[shell_environment_policy] exclude` 不让 bash 工具与终端拿到凭据，但没有真实的工具调用核对过，所以仍标继承。

- 这个凭据不是模型服务的密钥：它只能在这台电脑的回环端口上使用这个会话选定的服务与候选，进程退出或服务设置变化后失效。会话本来就是 L3。
- goose 的凭据放在它规定的变量里，会读这些变量的工具可能把它发给真实厂商：在那里没有用，但离开了这台电脑。
- 模型面板「Latch 网关」下服务组名的悬停说明为这三者多写一句（`HarnessCapabilities.models.credentialInherited`）。其余 Harness 各有清理办法（Codex 直连的线程环境过滤规则、OpenCode 的插件、DeepSeek Harness 自己清除敏感变量、Claude 的 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`、pi 从继承的环境里删除）。

**交付的规则**（`profiles/types.ts`、`runtime.ts`）：

- 凭据只由 runtime 注入 profile 允许的环境变量；profile 写出的私有文件 0600、原子替换、不含凭据；写出没列在 `envNames` 里的变量时拒绝启动。
- 受管的临时根、会话目录与网关子目录有链接、属主或权限不对时拒绝写入与启动；清理不沿已有的链接删到外面。
- 启动指纹不含临时端口与凭据；全部异步准备之后再复查命令、项目与授权，准备失败撤销已建的凭据。版本无法确认或低于最低版本时在发凭据之前拒绝，自定义包装命令不能靠跳过版本查询绕过。
- **Codex 直连。** `config/read` 的 `origins` 里 `model_providers.latch.*` 有一个键、或 `model_provider` 不来自启动参数（`sessionFlags`），或管理策略指定了别的 provider 时拒绝开线程：否则人的请求头、查询参数或凭据会跟着发往网关。命令环境的过滤规则畸形或读取失败也拒绝；不写 Codex 的文件。
- **Claude Agent。** 其他 provider 开关、API key、OAuth token 与自定义头清空；子进程的 scrub 可被设置文件覆盖，不能据此说用户自己配置的秘密都被清除。
- **goose。** 关掉工具垫片（`GOOSE_TOOLSHIM=false`：它会把回复发给本机的解释模型），`provider` 选项隐藏并拒绝设置。
- **pi。** 凭据只留在进程内存，并从子进程继承的环境里删除。

**各自去不掉的限制**：

- **Qwen Code。** 私有系统设置替代了系统设置路径，这个进程不再读真正的系统设置里的管理策略。子 Agent 以 `permissions.deny: ["Agent"]` 关掉：它的定义文件可以点名任何模型，而用户自己起名的服务与内置 OAuth 模型删不掉。用户自己的钩子、网页搜索的模型、`batch.model` 与实验性语音仍不经网关。
- **goose。** `delegate` 启动子 Agent 时，配方的 `settings.goose_provider` 或模型自己传的 `provider` 先于 `GOOSE_SUBAGENT_PROVIDER`：这样的子 Agent 用用户在 goose 里另配的服务，按轮的核对发现不了。Latch 不给会话传 `_meta.provider`（goose 会改用该服务的默认模型而不是 `GOOSE_MODEL`）。
- **Grok Build。** 自定义模型只能写在用户配置里，所以用私有 `GROK_HOME`；Grok 自己的会话记录也写在这里，随 Latch 会话删除。它起标题时用内置模型向同一地址发请求，网关拒绝，Grok 改用截断的用户文字，不影响这一轮。私有家里不读 Grok 自己的 MCP 与钩子，但 Grok 默认还从真实 HOME 读 Claude Code 与 Cursor 的配置；这条路线关掉其中会启动进程的部分，所以人在 Claude Code、Cursor 里配的 MCP 服务器、插件与钩子在这里都不运行（技能、规则与说明文件照旧读取），`~/.claude/settings.json` 的放行规则也不生效（拒绝规则仍生效）。私有家里没有文件夹信任，项目里的 Grok MCP、钩子与权限规则同样不加载。

三者标「实验性」：都只在没有登录的临时 HOME 下对本地假服务跑通过一轮（`apps/host/test/gateway-no-login.live.test.ts`），没有对真实服务、带工具与多轮跑过。假 Agent 与回放夹具是照源码与文档写的，不是录制。

## Codex 的 app-server

`wires/codex.ts` 运行 `codex app-server`（定义的参数之后加 `app-server`），一个进程一个会话（Codex 的 thread）。它把运行时说的 ACP 换成 Codex 的请求，把 Codex 的通知换成 ACP 的会话更新，所以启动指纹、模式读回、审批、取消与项目配置的检查照旧适用。协议形状按 Codex 0.167 的 `codex app-server generate-ts` 核对。

- **保留参数。** 会让 `codex` 变成别的东西的参数（`app-server`、`exec`、`login`、`resume`、`--help` 等，线里的 `RESERVED`）保存时就拒绝，400 `agent-args-reserved`。
- **握手与登录。** `initialize` 之后发 `initialized`；版本取自回答的 `userAgent`。开会话前先 `account/read`：没有账号且需要 OpenAI 登录时按未登录处理（409 `agent-auth-required`），不开 thread。
- **会话。** 新会话 `thread/start`，恢复 `thread/resume`（`excludeTurns`）。只有 Codex 自己说没有这个 thread 时才是「该 Harness 已找不到这个会话」；其他拒绝脱敏后照原样显示，接入已有会话据此认出「正在别处使用」。
- **一轮。** `turn/start` 带输入（文字；图片作 data URL；显式技能用官方目录里的 name 与 path）、模型、思考与当前模式的设置，等到 `turn/completed` 才结束：`completed` 正常，`interrupted` 算取消，`failed` 带 Codex 的原因失败。运行中追加用 `turn/steer`（带当前一轮的 ID）。
- **事件。** 回答与推理增量流式显示；`commandExecution`、`fileChange`、`mcpToolCall`、`webSearch` 是工具调用；`turn/plan/updated` 是计划，`thread/tokenUsage/updated` 是用量；`willRetry` 的 `error` 是一条重试提示。推理摘要分段到达而段间没有分隔，Latch 在换段时补一个空行。
- **窗口归属。** `thread/tokenUsage/updated` 的原生 `turnId` 与这轮 Codex 输入匹配时，窗口样本才归入这轮。上一轮迟到的累计用量可补上新一轮的计量起点。旧版省略 `turnId` 时按会话报告处理。
- **系统错误。** Codex 遇到错误就把 thread 标为 `systemError`（`thread/status/changed`）；会结束一轮的错误另发一条不带 `willRetry` 的 `error`，之后 Codex 可能不再报告这一轮结束。两者都到了、3 秒内这一轮既没有结束也没有新的条目时，Latch 发 `turn/interrupt`（最多等 2 秒），然后以 Codex 最后一条 `error` 的原话（没有时写「Codex 报告这个会话出了内部错误，这一轮没有结束」）结束为失败，不是取消；thread 照常可以继续。只有状态、没有 `error` 的（回滚失败、拒绝追加之类，Codex 不为它结束一轮）不动这一轮。
- **生成的图片（`imageGeneration`）。** 开始时是一行「生成图片」，`_meta` 带 `latch/imageGeneration`（`IMAGE_GENERATION_META`，运行时只认 Latch 自己的 Codex 线路），行上记 `ToolDetail.imageGeneration`：这一行就是图片的位置。结束时 `failure` 或 `failed` 写「图片生成失败」（用量上限另写），不交图片。字节先取条目的 `result`（base64）；为空时（迁移期只带 `fileId`）按 `savedPath` 发 Codex 自己的 `fs/readFile {path}`，回答 `{dataBase64}`（Codex 0.170 `generate-json-schema`）。由 Codex 自己读，所以 `CODEX_HOME` 改过也读得到；只接受绝对路径、扩展名 png/jpg/jpeg/gif/webp。字节须是规范 base64、开头是 PNG、JPEG、GIF（Codex 0.170 会生成 GIF）或 WebP，解码后不超过 5 MiB（Host 的图片附件上限），每轮最多 8 张；不合格的不交，在行上写原因。合格的放进这一行结算的 `tool_call_update`（内容里的 `image` 块）。运行时把图片块从行的内容里取出（字节不留在行上），经 `saveAttachment` 存为会话附件，作为这一行自己的 `attachments`，和 Agent 的其他图片共用每轮 8 张；存好之前行保持运行，存好后才带着图片结算，所以客户端不会看到结束了却没有图片的行，同一轮多张图各在各的行上，重读、换进程续接后图片仍在原处。存不下时行上写「图片未保存」。这一轮在图片到之前停下：行以「图片未生成」安静结束（`cancelled`，不是结果未知）；Host 重启时的恢复同样处理。读取期间这一轮不结算，30 秒超时；子 Agent 的与读回历史（`thread/read`）里的不交。回复里指向 `savedPath` 的链接按会话文件夹外的已提到文件打开（见 [ARCHITECTURE](ARCHITECTURE.md#会话文件)）；这一轮已经画出生成的图片时，指向图片的链接只留路径标记，不画第二遍。
- **命令的解析（`commandActions`）。** 全部动作都是读取、列出或搜索时，作为工具条目的可选字段 `actions` 带给客户端；有一项 `unknown` 或不认得的形状就不带，命令原文照旧保存。这个字段只从 Codex 线接受（[STREAMING.md](STREAMING.md#工作过程的行)）。
- **模型。** `model/list`（最多 5 页）给出模型与各自的思考深度；开始前的读取用同一个程序的 `codex app-server`，不开 thread。同一次读取的 `config/read` 给出默认的模型、思考与速度，以及配置里 MCP 服务器的名字（是否停用、远程的源，不取命令、变量与请求头），再加 `hooks/list`；没有会话或读取的报告时，「设置 › 扩展」先显示这些名字（`namesOnly`）。不用不带 thread 的 `mcpServerStatus/list`：0.170 为回答它会启动配置的服务器（实测）。
- **预热不做。** 实测（0.170，临时 `CODEX_HOME`，各 6 次）：起进程到 `initialize`、`account/read`、`model/list`、`configRequirements/read` 都答完，常用的家目录中位 150 ms（72–920 ms，只有第一次慢），全新的家 468 ms；已在运行的进程上同样几个请求中位 6 ms。会话还要在项目目录开 thread（0.5–1.3 s），预热省不了那部分，而进程按项目目录与启动指纹启动，提前起的进程不能直接给会话用，所以收益约 0.1 s，不值得多一个常驻进程。
- **速度。** `model/list` 的每个模型带 `serviceTiers`（Codex 0.169：`id`、`name`、`description`；旧字段 `additionalSpeedTiers` 不读）。只有列出 Fast 档（`id` 为 `priority`）的模型、在 Codex 自己的登录上（不经网关，不经 codex-acp）才有「速度」一项（`service_tier`，`model_config`）：「标准」（`default`）与「快速」（`priority`，Codex 对这一档的说明是它的悬停，其中写着更费额度）。当前值读自 thread 的 `serviceTier`（`thread/start` 与 `thread/resume` 的回答；开始前读 `config/read` 的 `service_tier`，旧值 `fast` 读作 `priority`）。thread 已在别的档（如 Ultrafast）时列出这一档，Latch 不另外提供它。人选过之后每轮 `turn/start` 带 `serviceTier`；没选过不带，thread 沿用人自己的配置。换到没有 Fast 档的模型时这一项消失，轮次不带档。草稿读到的列表按模型带这一项（`perModel`）。实测见 `codex-speed.live.test.ts`：选的档随一轮发出，新进程恢复 thread 后读回同一档。
- **删除。** 线声明 `sessionCapabilities.delete`，把 `session/delete` 换成 Codex 自己的硬删除 `thread/delete`（0.156 起即是硬删除，这条线最低就要 0.156）：删 Codex 的会话记录、分页历史、标题与索引，连同它派出的子 Agent thread。删之前先 `thread/list { parentThreadId }` 记下子 thread；删成功后再删 Codex 为这些 thread 存的图片：按 `initialize` 报告的 `codexHome` 读 `generated_images/<thread>/`（`fs/readDirectory`），只删名字是 Codex 自己形状（`<调用 ID>.png|gif|jpg|webp`）的文件，每次一个文件、`recursive: false`，再删空文件夹；别的文件与非空文件夹留下。最后 `thread/read` 不再读到这个 thread 才算删掉。Codex 说没有这个 thread 时视为已删。另一个进程正写着它、或别的分叉的历史仍引用它时 Codex 拒绝，Latch 不重试、不抢锁，拒绝的原话进 Host 日志。实测：`packages/harness-acp/test/codex-no-turn.live.test.ts`（不发一轮）与 `apps/host/test/codex-delete.live.test.ts`（一轮）。
- **模型服务与分叉。** 见上节。分叉（包括「从这里编辑」）用 Codex 自己的记录：Codex 0.169 起（`initialize` 报告的版本）每轮 `turn/start` 带 `clientUserMessageId`（这一轮用户消息的 Latch ID），Codex 记在这一轮的用户消息上，更早的版本不带；分叉到同一个 Codex 定义、同一个文件夹时，新进程用 `thread/read` 找到这条消息所在的一轮，`thread/fork` 带 `lastTurnId` 分叉到这一轮为止，再读新线程核对它停在这一轮。找不到（这个标记之前的旧轮次、不保留标记的 Codex）、Codex 拒绝或分叉出的线程没有停在这一轮时，用 `thread/delete` 删掉那条线程（删不掉就归档，归档也失败时写明它留在 Codex 的会话列表里）并退回背景文本，会话里写明原因（`HarnessCapabilities.fork: 'native'`，见 [ARCHITECTURE.md](ARCHITECTURE.md#会话分叉)）。`thread/fork` 另用于会话在自己的登录与服务之间换路线（`CARRY_METHOD`）。

**权限模式。** 四档与 ACP 路线同名同说明，对照在 `profiles/codex.ts`；模式由线保存，thread 开始、恢复与每一轮 `turn/start` 都带上。

| 模式 | `approvalPolicy` | 沙箱 | 谁审 |
| --- | --- | --- | --- |
| `read-only` | `untrusted` | `readOnly`（不联网） | 人 |
| `workspace-write` | `on-request` | `workspaceWrite`（项目的其他文件夹是可写根，不联网） | 人 |
| `agent` | `on-request` | `workspaceWrite` | Codex 的审阅模型（`auto_review`） |
| `agent-full-access` | `never` | `dangerFullAccess` | — |

**管理策略。** 开 thread 前读 `configRequirements/read`（`profiles/codex-policy.ts`）：`allowedApprovalPolicies`、`allowedSandboxModes`、`allowedApprovalsReviewers` 与 `autoReview.requiredOnModels`。Codex 对不在允许集合里的审批策略、沙箱或审阅者报错拒绝这一轮（`invalid thread settings override`），不会悄悄收窄；要求模型审阅的模型上只有 `agent` 一档可用（`step_settings.rs` 的 `validate`）。所以：

- 不允许的档仍列在权限菜单里，置灰，一句原因（「这台电脑的 Codex 管理策略不允许…」）作悬停与它的说明行，手机上点它看到同一句。它经选项值的 `_meta["latch/unavailable"]` 到运行时（只认 Codex 直连线的；ACP Agent 发来的这个标记被丢掉，Agent 不能把一档置灰），存为 `SessionConfigOption.options[].unavailable`，草稿的目录随第一个会话带上。
- 选它被拒绝，带同一句原因；当前档在当前模型上不允许时，这一轮不发给 Codex，会话写明原因，请人换一档。Latch 不替人换到别的档，宽松的也不。
- 开 thread 时不带被禁止的那一项，由 Codex 按自己的策略开；之后每一轮都带所选档的全部设置。
- 读不到（旧版没有这个请求、回答读不懂）时当作没有要求；Codex 仍按自己的策略拒绝，`turn/start` 的 `invalid thread settings override` 写成「这台电脑的 Codex 管理策略不允许当前的权限档」，这一轮没有开始。

**审批。**

- `item/commandExecution/requestApproval` 与 `item/fileChange/requestApproval` 交给人，只有「允许」「拒绝」两个一次性选项（不给 `acceptForSession` 与策略修改）：允许回 `accept`，拒绝回 `decline`，没有回答（停止、停止后才到的请求）回 `cancel`。
- 卡片写出允许给的是什么：联网的主机与协议（`networkApprovalContext`）、命令是否在沙箱外运行、改文件时允许写入的文件夹（`grantRoot`）。来自 Codex 的文字都经 `escapeSecurityText`。
- **MCP 工具。** 标了 `codex_approval_kind: mcp_tool_call` 的 elicitation 是一张普通审批卡片，回答同上。0.167 的这个请求没有原生调用 ID：只有当前轮同 threadId 与 turnId 下，已开始未结束、未被另一审批认领、服务器、工具与完整原始参数全部相同的调用恰好一项时，才共用它的记录；并行同参、缺字段或旧轮请求保持独立记录与未知结果。允许不等于执行完成，完成或失败仍由原生 item 事件报告。
- **不交给人的请求**由 profile 当场回答：要求更多权限（`item/permissions/requestApproval`，回空权限）、MCP 服务器自己的 elicitation（回 `decline`）、旧式的 `execCommandApproval` 与 `applyPatchApproval`（回 `abort`）。会话里写一行「已自动拒绝：…」，审计 `task.approval-auto-rejected`（`harness-declined`）；会话还没记下时审计照记，这一行之后补进去。
- **模型审阅。** `agent` 模式下 `item/autoApprovalReview/started` 与 `completed` 成为一行「Codex 的模型审阅」（ID 以 `guardian_assessment:` 开头），带结论与理由，按「模型的判断」记录。
- **运行的证据。** 命令、改文件、MCP 调用与网页搜索先显示为等待，看到输出、完成或人允许了它才算运行。Codex 报告 `declined` 而没有人回答过的调用显示为「拦下」，从不记成「没有问你就运行」。
- **子 Agent。** 同一进程里能证实属于当前 thread 的子 thread，其调用与审阅显示为该子 Agent 的行；审批标为它的，由运行时按会话的模式决定交给人还是拒绝。没有可核对的父关系时不转发审批。

**停止。**

1. 发 `turn/interrupt`（一轮只发一次；`turn/start` 还没回答时，拿到这一轮的 ID 后立刻发）。
2. 等 Codex 报告这一轮 `turn/completed`，并且这一轮开始的每条命令都报告了 `item/completed`，才算停下。审批被拒或因停止没有回答的命令不会运行，不等它。
3. Codex 中断一轮后不结束它开始的命令，所以线对会话的 thread 与这一轮报告过调用的子 thread 各发 `thread/backgroundTerminals/list`，逐条 `thread/backgroundTerminals/terminate`。
4. 2 秒内还没报告结束时读一次进程列表（`/bin/ps`，不带环境变量），按 Codex 列出的 `osPid` 结束那条命令。只有每条剩下的命令都是这个 app-server 的子孙进程、自成进程组、结束后整个进程组都已消失，才确认停止；没有结果的记为结果未知。
5. 到取消时限（30 秒）仍无法确认时，先清理能确认归属的子孙进程，再强制结束 app-server。第一次读取进程表失败时，如果 app-server 仍在运行，且两秒的读取预算还有剩余，就再读一次。读取期间 app-server 已退出，或始终读不到进程表，就不按其中的 PID 发信号。

Codex 自己中断、Latch 没有要求停止的一轮同样先等它的命令；30 秒后仍没有结束证据时强制结束 app-server，轮次标为已中断、命令结果未知。

**Codex 自己的 MCP 服务器与钩子**只读、只经 app-server 报告：Latch 经 `config/read`、`configRequirements/read` 读 Codex 的配置（只取下文写到的字段与来源，不取值里的令牌与请求头），从不写 `~/.codex/config.toml`，不调用 `mcpServer/oauth/login`，不碰 Codex 的令牌。

- thread 开始或恢复后发一次 `mcpServerStatus/list`（带 `threadId`、`detail: toolsAndAuthOnly`，最多 4 页、200 个），再跟随 `mcpServer/startupStatus/updated`。变化作为 `_latch_mcp_status` 交给运行时，记为 `HarnessInfo.ownMcp`（只在内存，换定义即作废）。Latch 自己的服务器按名字排除。
- 「读取」（`POST /link/api/agents/:id/mcp`，`run`；审计 `agent.mcp.requested` 与 `agent.mcp.read`）在 Host 临时目录的空文件夹里启动 `codex app-server`，不开 thread，最多 60 秒。Codex 0.170 为回答不带 thread 的 `mcpServerStatus/list` 会启动配置的服务器（实测），所以只在人按下时读；开始前的读取只从 `config/read` 取名字。
- 不带 thread 时 Codex 只列配置里的名字：报告标 `namesOnly`，不覆盖已有的会话报告。
- 每个服务器只留名字、状态、工具数与 `httpOrigin` 的源。见 [MCP.md](MCP.md#harness-自己的-mcp)。
- **钩子。** 同一次读取（有 thread 时 `hooks/list { threadId }`，读取时不带）一并列出 Codex 会运行的钩子，随 `ownMcp` 报告（`hooks`，最多 100 个）：每个只留事件、来源、是否受管理策略强制、是否启用与信任状态，从不取命令、文件路径与键。管理策略加的钩子在 Latch 开的每个 Codex 会话里也运行（例如 `userPromptSubmit` 看得到每条经 Latch 发出的消息），所以「设置 › 扩展」的 Codex 页在 MCP 下列出它们。

## pi 的 RPC 模式

`wires/pi.ts` 启动 `pi --mode rpc`（两个参数接在定义的参数后面），把运行时的 ACP 方法换成 pi 的命令，把 pi 的事件换成 ACP 的会话更新；指纹、项目配置、取消、审批与持久化是同一份代码。依据 pi 自己的 `rpc-types.ts`、`rpc-mode.ts` 与 RPC 文档。

- **版本。** 需要 0.84.4：一轮以 `agent_settled` 结束，`message_update` 只带增量，停止前能清空队列。pi 的 RPC 不报告版本，所以进程启动时 `get_state` 之后先发一次 `clear_queue`：pi 答「Unknown command」时它早于 0.84.4，会话与测试启动都拒绝（409 `harness-version-unsupported`）。
- **回答顺序。** pi 1.5 在回答第一条命令前先发一条 `queue_update`，`new_session` 的回答可能晚于其后发出的命令；线按 `id` 对应，忽略不认识的事件。
- **保留参数。** 决定协议与会话的参数（`--mode`、`--print`、`--session`、`--continue`、`--resume`、`--fork`、`--help` 等，线里的 `RESERVED`）保存时拒绝，400 `agent-args-reserved`。
- **会话。** pi 启动时就有一个新会话；`get_state` 报告的会话文件就是 Latch 记下的会话标识。恢复用 `switch_session` 切到这个文件再用 `get_state` 核对，不是同一个文件就是「该 Harness 已找不到这个会话」。`switch_session` 会把 pi 的工作目录换成文件头里的 `cwd` 并加载那里的 `.pi`，所以切换前线先读文件头（本人的普通文件、不跟随链接、1 MiB 内），`cwd` 的真实路径与进程目录不同就不切换，同样答「找不到这个会话」；还没写出的文件没有目录，照旧打开。
- **删除。** pi 没有删除命令；它的文档说删除会话就是删掉那个 `.jsonl`，一个会话的全部记录就是这一个文件。Host 由启动脚本给了 `cliStore` 时，线声明 `delete`：先 `new_session` 离开这个文件（pi 按路径追加，否则会重新写出它），再只删这一个文件，条件是文件名是 pi 的 `<时间>_<ID>.jsonl`、文件头的 `id` 与名字相同、`cwd` 是进程目录、所在目录是会话存储本身（平铺）或其下一层且都是本人的真目录、文件是本人的普通文件并且删除前一刻仍是核对过的那个（`dev` 与 `inode`）。不符就留着。接入的会话不删（`remove` 把它排除；「同时删除原会话」由另一处选择决定）。这之前开的会话记的是 `deletable: false`，下一次恢复后才会删，在那之前删除仍留下 pi 的文件。测试 Host 没有 `cliStore`，不声明删除。
- **MCP。** pi 0.99 起内置 MCP（`~/.pi/agent/mcp.json` 与受信项目的 `.pi/mcp.json`，扩展可用 `pi.registerMcpServer` 只为当前会话登记）。Latch 还不把会话的 MCP 服务器交给 pi：收到 `mcpServers` 就拒绝，技能服务器不提供（见「尚未实现」）。
- **项目信任。** RPC 模式没有人可问，pi 只按 `trust.json` 里离会话目录最近的决定（`true`/`false`），没有时按全局 `defaultProjectTrust`（`always` 才算信任）决定是否加载项目 `.pi` 的设置、扩展、MCP 与技能。会话目录有 `.pi` 且 Host 有 `cliStore` 时，Latch 读这两个文件（只取这两项）并在权限面板写「.pi 已信任：会加载」或「.pi 未信任：不加载」（`pi-store.ts` 的 `piProjectTrust`）。Latch 自己的扩展经 `-e` 加载，不受信任影响。
- **权限扩展。** 启动追加 Latch 私有的 0600 扩展 `latch-permission.ts`（`-e`，`wires/pi-gate.ts`）。`ask`：read、grep、find、ls 不问，其余先问；`plan` 拦下所有非读取；`rule` 直接允许 edit 与 write，其他先问；`never` 直接允许。线经私有命令换档，只接受 `get_commands` 报告的完整扩展路径与本次进程的状态回报；用户提示不能调用这个控制命令。扩展拒绝或询问失败时不执行调用。pi 的其他扩展仍可在工具回调之外运行代码，这不是隔离。
- **模型与思考。** `get_available_models` 列出模型（值写作 `provider/model`），一个都没有按未登录处理；`get_available_thinking_levels` 列出当前模型的思考深度，换模型后重读，读回 `get_state` 才算换好。
- **一轮。** `prompt` 发出，等到 `agent_settled` 才结束，再读 `get_session_stats`（令牌、上下文占用与花费）。回复以 `error` 结束时这一轮失败；以 `length` 结束按达到长度上限处理；扩展把输入当自己的命令处理（`handled`）时立即结束。
- **停止。** 先 `clear_queue` 再 `abort`：不清空队列，`abort` 会接着处理排队的追加。清掉的追加内容在会话里写一行。
- **运行中追加。** pi 在跑这一轮（`agent_start` 到 `agent_end`）时用 `steer`；其他时候交回 Host 排队。
- **工具与其他事件。** `tool_execution_*` 成为工具行（`bash` 命令，`read` 读取，`edit`、`write` 改文件，`grep`、`find`、`ls` 搜索）。每次压缩分配独立标识，开始和结束共用，只有结束事件时也记一条。恢复原会话后再次压缩会另记一条。自动重试、扩展的通知与扩展出错成为通知。pi 转来的失败回复、重试原因、压缩失败原因与扩展出错都先遮住像密钥的部分。
- **经 Latch 的会话不让 pi 自己重试。** pi 报告 `auto_retry_start` 时线发 `abort_retry`（RPC 文档的命令，不写设置），通知只写错误，不写「第几次重试」；原因里带 `gateway-busy`（Host 的队列满）的除外。网关已经重试过几秒内会好的失败，pi 的重试按错误文字判断、不读 `x-should-retry`，而 `retry.maxRetries` 只在 pi 的设置文件里，`set_auto_retry` 会写用户的全局设置；重试只由网关一层负责。
- **扩展的提问。** `confirm` 像审批一样交给人；`select`、`input`、`editor` 是一道题，进同一张提问卡（下文「Agent 的提问」）：`select` 的回答只能是它列出的选项之一（自己写的话答「已取消」，会话里写一行），`input` 与 `editor` 收自己写的话。没人回答时答「已取消」。

**`/compact`。** pi 的 RPC 不列出它界面里的 `/compact`，当文字发出去会交给模型，所以 Latch 在会话第一轮开始时把它列为 pi 的命令。

- 一条消息只有 `/compact`（可跟说明）、不带图片时，发 pi 的 `compact` 命令（说明放 `customInstructions`），不发 `prompt`。这条消息留在记录里作为一轮运行，pi 回答 `compact` 时结束。
- pi 报告了压缩时，压缩失败或被扩展取消都不让这一轮失败；还没报告压缩就拒绝时这一轮失败并写 pi 的原因。
- 之后的上下文占用未知，直到下一条回复。
- pi 压缩前先中止手上的事，所以命令带 `idleOnly`：排队、把排队的消息改成它或追加时 Host 拒绝（409 `command-queued`）。

**分叉。** 从一个 pi 会话分叉到同一个 pi 定义、同一个文件夹时，用 pi 自己的会话文件分叉（`HarnessCapabilities.fork: 'native'`，见 [ARCHITECTURE.md](ARCHITECTURE.md#会话分叉)）：新会话带着 pi 到那一轮为止的原样记录，第一条只发人写的话。

1. 新会话的进程 `switch_session` 到来源的会话文件，`get_entries` 读出记录。
2. 沿 pi 所在的分支找来源下一轮开始（那条用户消息记下的时间）之后的第一条用户消息，`fork` 在它之前；分叉点就是最新一轮时 `clone` 整条分支。
3. 分叉后再用 `get_entries` 核对 pi 复制出的新文件正好停在预期的最后一条（之后只能有模型看不到的条目）。

- 分叉在发送时才做，而且只在第一轮做：第一轮在 pi 打开会话之前就结束时，下一轮像其他新会话一样开始。
- pi 的 `fork` 返回的消息文字不用：其中有 Latch 附加的指令块与文件引用。
- **退回背景文本**并在新会话里写一行原因：不在来源的文件夹里、分叉点之后清空过上下文、来源会话文件已不在、下一轮开始之后的压缩会被带进来、扩展取消了 `switch_session` 或 `fork`、pi 拒绝命令、复制出的文件没停在那一轮。退回前进程先 `new_session` 离开来源（这一步也被取消时停止进程）；分叉不往来源的文件里写。
- 已知限制：系统时钟在两轮之间往回拨时，按时间找到的位置可能错一轮，核对只能确认 pi 停在了所要求的条目上。

## Cursor 的 SDK 路线

Cursor 预设的定义在这台 Mac 上带了 `CURSOR_API_KEY`，且 Host 找得到 Latch 的运行器与 `@cursor/sdk` 时，会话改用 Cursor 的官方 TypeScript SDK（`profiles/cursor-sdk.ts`、`wires/cursor.ts`）；没有密钥（空白也算没有）或找不到 SDK 时照旧是 `cursor-agent acp`。密钥是定义的一部分，加上或去掉它会改变启动指纹，所以一个会话只在开始时的那条路线上继续，换路线要开新会话。版本按官方文档（2026-11-19 读）与 `@cursor/sdk` 1.3.1 的类型声明核对；文档描述的是 1.4.x，接口以 1.3.1 的 `.d.ts` 为准。

**文档里的三件事（决定这条路线的形状）：**

1. **只认 API key。** 运行器每次调用都显式传 `apiKey`，缺少密钥时拒绝。SDK 实例的设置页引导人在 Cursor 网页创建密钥，再到 Host 电脑的该实例定义里填写或更换 `CURSOR_API_KEY`。默认 `cursor-agent acp` 实例继续用 CLI 自己的登录流程。[Cursor SDK 认证文档](https://cursor.com/docs/sdk/typescript#authentication)
2. **agent 循环在调用它的 Node 进程里。**「Local means local agent loop, not local model」：循环与文件在本机，推理在 Cursor 的服务上。所以 SDK 只在运行器里加载，从不进 Host 进程。
3. **本机工具调用不逐次审批。**「Quickstart approves tool calls automatically」写明默认直接运行；「Hooks」写明只有文件钩子、没有程序回调；能管住它的只有「Restricting the toolset」（`tools`、`disallowedTools`）、「Sandbox options」与「Auto-review」。

**运行器。** `packages/harness-acp/src/cursor-runner.ts`，构建为 `dist/harness/cursor-runner.js`；源码运行时 Node 直接剥掉类型执行它。线用 Host 自己的 Node 以 `--disable-sigusr1 <运行器>` 启动它，独立进程组、同一份经白名单的环境、同样的停止与 stderr 摘要；每行一个 JSON。`--help` 与握手不加载 SDK，SDK 只在开会话时 `import`。测试经 `setCursorSdkModule` 让它加载假 SDK 模块（`--sdk`），定义、会话与设备都设不了它。

**密钥走过的路。** 与其他定义变量相同：只能在这台 Mac 上经 `host.sock` 保存（任何变量都要本机确认 `harness.command.apply`，确认表只列变量名）→ `settings.json`（0600，不进 Time Machine 备份）→ 设备只收到 `envKeys` → 启动指纹只含它的摘要 → 运行器进程的环境。运行器读到后立刻从自己的环境删掉，再交给 SDK 的 `apiKey`，所以 agent 运行的命令与 MCP 服务器看不到它；它不在参数、URL、SSE 与预览里。运行器写出的每一行先遮掉它，驱动再按定义的变量值遮一遍；Host 把定义里 `CURSOR_API_KEY` 的值登记进 `redactKnownSecrets`，Host 的日志、错误与事件都遮掉它（Cursor 没有公开密钥的形状，不能按形状认）。

**存储。** `local.store` 是会话私有临时目录里的 `JsonlLocalAgentStore`；`CURSOR_DATA_DIR` 也指向那里，让 SDK 把本会话的记录写在那里而不是 `~/.cursor/projects`（这个变量只见于 SDK 包里的代码，文档没写，没有对真实 SDK 核对）。私有临时目录在 Host 的运行目录里：空闲停止后能恢复，删除会话时随它删掉，Host 停止时也删掉，所以 Host 重启后 SDK 找不到这个 agent（见「尚未实现」）。`settingSources` 只给 `project`：项目 `.cursor` 下的规则、钩子与沙箱设置生效并计入启动指纹，人自己的 `~/.cursor` 设置不读。

**档位。** 每档都由运行器在创建或恢复 agent 时交给 SDK；换档在空闲时用同一个 agent ID 重新 `Agent.resume`（`tools`、模型等不随 agent 保存，每次恢复都重给）。

| 档位 | 交给 SDK 的 | 说明 |
| --- | --- | --- |
| `read-only`（默认，只看不改） | `tools: ['read','grep','glob','ls']` | 没有命令、写入、子 Agent（`task`）与 MCP |
| `sandbox`（按规则放行） | `local.sandboxOptions.enabled: true` | 命令在 Cursor 的平台沙箱里，写入限工作目录与临时目录，默认不联网；被拦的直接拒绝，不问人；平台不支持沙箱时 SDK 报错，换档或开会话失败，不降级 |
| `full`（不再询问） | 默认工具、无沙箱 | 不问你 |

- 没有「先问你」：profile 写 `approvals: 'none'`，客户端显示「不先问你」。默认是最严的一档，不是 ACP 路线的 `agent`。
- 会话开始时要的档位不在这三档里（例如从 ACP 路线的草稿或分叉带来的 `agent`），Host 以 409 `permission-ask-unavailable` 拒绝，不拿别的档位顶替；会话中也只能在这三档之间换。要逐次询问就去掉密钥、用 `cursor-agent acp`。
- 档位的读回是运行器报告它交给 SDK 的值，不是 SDK 自己报告的。

**翻译。** `session/new` 是 `Agent.create`，`session/resume` 是 `Agent.resume`（SDK 找不到时是「该 Harness 已找不到这个会话」）。模型菜单来自 `Cursor.models.list`，每个变体一个选项（值写作 `id?参数=值`，思考在模型里选）；没有指定时用标了默认的那个。一轮用 `agent.send`：`onDelta` 的 `text-delta`、`thinking-delta` 是回复与思考，`run.stream()` 的 `tool_call` 是工具行（`running` 开始，`completed`、`error` 结束），SDK 没发增量时才用整条 `assistant` 消息。运行中追加用 `run.steer`。停止发 `run.cancel()`，等 `run.wait()` 报告 `cancelled` 才算停下。运行器退出时这一轮按进程退出处理。

**使用统计。** SDK 依赖 `@statsig/js-client`，但只用后端下发的开关，并设了 `preventAllNetworkTraffic`；它自己的使用事件（运行开始与结束、失败、延迟等，带 SDK 版本与系统平台）用这把密钥发到 Cursor 的后端（`api2.cursor.sh`）。没有文档化的开关能关掉，Latch 也不改它。

**包。** `@cursor/sdk` 1.3.1（2026-11-03 发布，专有许可，见包里的 `LICENSE.md`）约 20 MB，依赖 `@bufbuild/protobuf`、`@connectrpc/connect`、`@connectrpc/connect-web`、`@statsig/js-client`，另按平台装一个约 10 MB 的可选包（沙箱助手 `cursorsandbox`、`rg` 与 tree-sitter 的原生模块）；都没有安装脚本。
## OpenCode 的服务接口

`wires/opencode.ts` 启动 `opencode serve --hostname 127.0.0.1 --port 0`（接在定义的参数之后），一个进程一个会话槽位，进程的启动、空闲回收与停止与其他线相同。它把运行时说的 ACP 换成服务的 HTTP 接口，把服务的事件流换成 ACP 的会话更新，换法照 OpenCode 2.2.6 自带的 ACP 适配器（它本身就是这套接口的客户端，`packages/cli/src/acp/`），接口形状按运行中 2.2.6 的 `/openapi.json` 与录下的事件核对。所以模式（`plan`、`build`、`auto-edit`、`yolo`）、选项 ID（`model`、`effort`、`mode`）与取值、会话 ID（`ses_…`）、子 Agent 的标记、思考的消息 ID 都与 `opencode acp` 相同，`opencode acp` 建的会话在直连上恢复（`opencode-direct.live.test.ts` 用真实程序核对）。

- **`--stdio`。** 这是 OpenCode 自己的私有服务用的模式（2.2.6 `server-process.ts`、`standalone.ts`）：读入口令后从自己的环境里删掉，它启动的工具、MCP 服务器、LSP 与格式化程序都继承不到；标准输入关闭就退出，Host 崩溃不留下服务；`--print-logs --log-level warn` 让警告（例如配置被拒的原因）进标准错误，启动失败时与其他线一样从标准错误的末尾读原因。定义自己写了 `--print-logs` 或 `--log-level` 时用它的。`serve` 本身就是服务，不接 `--standalone`（2.2.6 报「Unrecognized flag」）；其他会连人的后台服务的子命令 Latch 不运行。
- **端口与口令。** 端口由服务自己选，地址只从它标准输出的一行 `{"url":"http://127.0.0.1:<端口>"}` 读，再用 `GET /api/info` 核对回答的 `pid` 就是这个子进程、版本是 2.x 中的 2.2.6 或更高。口令每个进程随机生成，只放进子进程的 `OPENCODE_PASSWORD` 与文档化的旧名 `OPENCODE_SERVER_PASSWORD`（定义里的同名变量与 `OPENCODE_SERVER_USERNAME` 被去掉）；每个请求带 HTTP Basic（用户名 `opencode`）。它不进参数、文件、URL、日志与错误：线的脱敏先替换口令，再经 `redactKnownSecrets`。
- **口令与工具命令。** 2.2.6 的 shell 工具把服务的整个环境（含口令）交给它运行的命令。线在进程的临时目录写一个 Latch 私有插件（`latch-opencode-server/index.ts`，0600），经 `OPENCODE_CONFIG_CONTENT` 的 `plugins` 加载，在 `shell` 的 `create.before` 把这两个变量清空，与网关清空 `LMG_TOKEN` 的插件同一做法。没有临时目录或 `OPENCODE_CONFIG_CONTENT` 不是 JSON 对象时不启动。Latch 给会话的 MCP 服务器登记时把这两个变量设为空（真实 2.2.6 核对：不设时它们能看到口令）。插件与 MCP 的清空在 `--stdio` 之后仍保留，因为「服务从自己环境里删掉口令后工具拿不到」只读了源码，没有用跑工具的一轮核对。这不是隔离：同一用户的进程能读到服务进程的环境（macOS 的 `ps -E`）。
- **停止。** 先对服务还在运行的会话 `POST …/interrupt`（最多等 2 秒它们结束），再关闭标准输入，宽限期后 SIGTERM、SIGKILL。原因见下一条。
- **重启续跑与残留的 claim。** 2.x 开始一轮时在会话上写一个 claim，成功、失败与人的中断都释放它，因关闭而中断时故意保留；人的后台服务（`opencode serve --service`）每次启动时把所有带 claim 的顶层会话接着跑（注入「The server restarted while you were working…」），Latch 不知道。所以停止前先中断。被强杀、取消超时或 Host 崩溃的那一轮仍会留下 claim：恢复 Latch 开的会话（运行时在 `session/resume` 里标明；接入的会话可能正在人自己的 OpenCode 里运行，预览的 `session/load` 读的是别人的，都不唤醒）时，`time.busy` 晚于 `time.idle`（关闭中断不写 idle）、收件箱为空、没有暂存的撤销，线就调 `DELETE …/revert`：这条路由在没有撤销时只唤醒会话，唤醒发现没有要做的事就以成功结束，释放 claim，不问模型；最多等 3 秒读回 idle。会话记录里因此多一条 OpenCode 自己的 `idle` 标记。收件箱里有东西时不唤醒（唤醒会把它跑起来），留着 claim。临时 XDG 加真实 2.2.6 核对过（`opencode-direct.live.test.ts`，模型指向关着的回环端口）。Host 崩溃后从未再恢复的会话，claim 留到下次恢复。事件流在服务还在时断开（被关闭、出错、单条超过 `maxLineBytes`），线结束服务：没有事件就读不到结果，运行时看到进程退出。
- **握手。** `initialize` 等到地址、核对 `/api/info`，打开 `GET /api/event` 并等到 `server.connected`。回答的能力与适配器相同（`loadSession`，`list`、`resume`、`close`、`delete`、`additionalDirectories`，图片与嵌入上下文），版本来自 `/api/info`。
- **目录。** 每个文件夹读一次：`GET /api/plugin`（位置刚启动时等到插件列出，最多 5 秒）后并行读 `/api/model`（只取 `enabled`）、`/api/model/default`、`/api/agent`（去掉 `subagent` 与隐藏的）、`/api/command`，都带 `location[directory]`。`model.updated`、`agent.updated`、`command.updated` 后重读，变化时推送 `config_option_update` 与 `available_commands_update`。
- **用 Latch 的模型服务时。** 人的配置可以给任一 Agent（含隐藏的 `compaction`、`summary`、`title`）钉自己的模型，那些请求不经 Latch。直连在开会话和恢复时读 `/api/agent`，把钉了别家模型的列在权限面板下面（「不经 Latch 的模型服务 · compaction 用 anthropic/…」），不改配置。
- **会话。** 新会话 `POST /api/session`（`location.directory`）；恢复 `GET /api/session/:id`，目录不同则拒绝，服务没有这个会话时是「该 Harness 已找不到这个会话」；载入另按 `GET /api/session/:id/message`（每页 200）重放。其他文件夹的授权与适配器写法相同（会话的 `permissions` 与 `metadata["opencode.acp.additionalDirectories"]`），两条路线互相读得懂。会话给的 MCP 服务器经 `PUT /api/experimental/mcp/:name` 登记，与适配器相同。没发过消息就关闭的会话删除。
- **一轮。** 线自己按 OpenCode 的格式生成输入的消息 ID，`POST /api/session/:id/prompt`（`delivery: steer`），看到 `session.inbox.delivered` 是这条消息才算开始，`session.execution.succeeded`、`interrupted`、`failed` 才结束。只给模型看的上下文先 `POST …/synthetic`；`/compact` 走 `POST …/compact`；目录里的命令走 `POST …/command`，它回答后服务排进的那条输入就是这一轮（5 秒内没有排进任何输入则这一轮结束）。图片作 data URI，`file://` 链接与文字资源与适配器的换法相同。
- **事件。** 文字与推理增量（推理的消息 ID 是 `<消息>:reasoning:<序号>`）、工具调用（`tool.input.started`、`called`、`progress`、`success`、`failed`，标题、种类、位置与原始输入同适配器）、压缩、重试；每步的 `tokens` 加起来是这一轮的用量（输入不含缓存），最后一步的总数与模型的上下文窗口、会话的 `cost` 作为 `usage_update`。改动文件的调用带它报告的补丁里的改动片段（适配器读整份文件，这条线不读项目文件）。
- **审批。** `permission.asked` 交给人，选项与适配器相同（`once`、`always`、`reject`），答复 `POST …/permission/:id/reply`。OpenCode 报告已在别处答复（`permission.replied`）的请求，Latch 撤下卡片（`$/cancel_request`）。OpenCode 的问题表单（`form.created`）在客户端声明能显示时作为提问卡，否则取消并告诉模型没能显示。
- **停止一轮。** 先拒绝这一轮还开着的审批，消息还没被取走时 `DELETE …/inbox/:id` 撤回，再 `POST …/interrupt`；只有服务报告这次运行结束（或撤回后 `/api/session/active` 里没有这个会话）才算停下。
- **模式、模型与思考。** `POST …/agent` 与 `POST …/model`（`variant` 是思考档位），先记下再切换，服务回声的 `session.*.selected` 不再改变什么。

**与 `opencode acp` 不同的地方。**

- 目录里的命令（如 `/review`）的回复在这一轮里显示；适配器在命令请求得到回答时就结束这一轮。
- 子 Agent：线记住这个进程里见过的子会话，后来的一轮里继续的子 Agent 的更新与权限请求也转发；一轮结束后后台子 Agent 的权限请求照常给人，更新不再转发（与适配器相同）。子 Agent 的路径只有单测，未用真实运行核对。
- 停止不设 5 秒的放弃时限：适配器 5 秒后把未结束的调用记为取消，这条线一直等服务的结束事件，由运行时的取消时限兜底。
- 改动文件的预览只含补丁片段，见上。
- `/api/info` 之外不报告 OpenCode 的登录状态；与适配器一样不提供登录。

## 通知与压缩

- **通知（`notice`）。** Agent 不属于对话历史的提示。每条在时间线上一行系统消息，按 `severity` 写「报告错误」或「提示」。它不改变本轮状态。
- **压缩（`compaction_update`、`compaction_summary_chunk`）。** 一次压缩一行，按 `compactionId` 就地更新（正在、已压缩、失败、已取消），Agent 给的摘要接在后面。行的位置是第一次报告到达时，之前的回复先结束。压缩失败不让本轮失败。Codex 压缩后留下的上下文仍超过它的自动压缩上限时会在每一轮开始再压缩一次，每次一个新 ID；相邻几轮里同样的「已压缩上下文」只留最后一行并写上次数，带摘要、失败或由 /compact 发起的行照旧（`collapseCompactions`）。
- **上下文记录。** 一次明确报告的压缩保留一条记录，开始、完成、失败和取消沿用同一个标识，未知状态或重启时未结算的状态显示为未知。可归属时关联发起当前轮的用户消息。会话详情保留最近 32 条；历史摘要和 Agent 给的任意文本不进入这份记录。明确完成的压缩和清空上下文会更新窗口分段标记。已经保存的窗口和压缩记录仍留在历史里，旧会话缺少的记录保持未知。
- **重试（`readRetry`）。** 把 Agent 标明的重试读成一行系统消息，不进思考；回复中途断开重新生成时，已收到的文字丢掉，新文字接在同一条消息里（消息 ID 不变），已收到的思考保留。原因先脱敏，最多 300 字。目前没有预设声明它。
- **各家说法不同的地方（`normalizeUpdate`）。** 只换不添：Qwen Code 只在 `_meta.toolName` 给工具名，填进 `name`；OpenCode 把回复的思考放在推理片段的 ID 下，去掉这个 ID 后思考归入它所属的回复。调用的 `kind` 只是 `other` 时用标题命名。
- **用量。** `session/prompt` 的 `usage`（含 `cachedReadTokens`、`cachedWriteTokens`、`thoughtTokens`）按 profile 的 `usageScope` 读：`turn` 是这一轮的，会话总数是轮前总数加它；默认 `session` 是整个会话的，这一轮是差。输入不含缓存的（`inputExcludesCache`）把缓存加回输入。这一轮的写在用户消息的 `TurnStats.usage` 上，不走模型路由时同一值也进自己登录轮次的记录。各家实测（2026-11-16）：

| Harness | 来源 | 范围 | 缓存 |
| --- | --- | --- | --- |
| Codex 直连 | `thread/tokenUsage/updated` 的 `total`，每次模型调用后经 `_latch_tokens` 推送，带只写了文字与推理（没有调用工具）的那些模型调用的输出 tokens 与这些条目自己的 `startedAtMs`–`completedAtMs` 之和（`stream`） | 会话 | `cachedInputTokens` 已含在输入里 |
| pi | 每轮后 `get_session_stats` 的 `tokens` | 会话 | 输入不含 `cacheRead`/`cacheWrite`，加回 |
| Claude Agent、OpenCode、Antigravity | `PromptResponse.usage`（OpenCode 直连含子 Agent 步） | 一轮 | 输入不含缓存，加回 |
| Grok Build | `PromptResponse._meta.usage`（`turnUsage`） | 一轮 | 已含 |
| Qwen Code | 每次模型调用（含子 Agent 的）后一条空文字的 `agent_message_chunk` 的 `_meta.usage`（`callUsage`，0.26.8），只在已发出的一轮里收，相加；载入历史时重放的不收 | 一轮 | 已含；有一次没报缓存，这一轮就不记缓存 |
| Cursor 经 SDK | 运行结束时 `RunResult.usage`（没有时 `run.usage`）；花费是 `agent.getUsage()` 的 `cost.chargedCents`，经 `usage_update` | 一轮 | 未核实，按原样（`cacheReadTokens`、`cacheWriteTokens` 另列） |
| DeepSeek Harness | 适配器不报告 tokens（`usage_update` 只有上下文）；自己登录的轮次由 Host 读它这一个会话的日志（见下） | 一轮，只进轮次记录 | 日志里输入不含缓存，加回 |
| goose | `PromptResponse.usage` 是这个会话最后一次模型调用的上下文（1.57.0 `session.usage`），既不是这一轮也不是累计，不记（`usageScope: 'none'`）；Host 读它的 `usage_ledger`（见「CLI 自己的存储」） | 一轮，只进轮次记录 | 已含（goose 的 `Usage` 输入含缓存） |

### DeepSeek Harness 的会话日志

Latch 读 CLI 自己的存储时只读要用的那部分（另见下面的「DeepSeek Harness 的余额」与「Claude 的 Agent SDK 线」）。Host 只读它启动的那一个会话的日志里的 tokens 数（`apps/host/src/cli-usage.ts`），依据 `@deepseek-ai/dsh-session-persistence-jsonl` 与 `dsh-session` 0.2.2-rc.1 的源码与说明：

- **何时。** 只对预设自己的命令（与额度同一判断 `readsCliQuota`），只在启动脚本给了 `cliUsage` 时；测试 Host 没有它就不读。一轮不经模型路由、Agent 没报这一轮的 tokens、会话不是接入的（`imported`）时，轮次结束 1 秒后读一次（dsh 每 200 ms 批量写一次事件），10 秒内读不完就按没有 tokens 记；驱动另有自己的计时，读的一方再过 1 秒还没答复，这一行照写、关闭也不等它。
- **读哪个文件。** 默认路径 `~/.dsh/sessions/<projectKey(cwd)>/<会话 ID>/session.v4.jsonl.zstd`：`cwd` 是 Latch 在 `session/new` 发的目录，ID 是 dsh-acp 回的 UUID（形状不对不读）。不列目录、不找别的格式代号。额外账号从绑定目录读取。其他自设的 `DSH_HOME`，或它自己的配置（见「DeepSeek Harness 的余额」的「它自己的配置」）说 `session-persistence-jsonl` 不是官方 bundle 原样的，就不读。
- **怎么读。** 每层目录都必须是这个用户的真目录（不是链接）；文件以不跟随链接的方式打开，必须是这个用户的普通文件，不超过 64 MiB；Zstandard 流式解压、逐行处理，文字超过 256 MiB、一行超过 16 MiB 或这几类事件超过 10 万条就放弃；中止或读失败时整条解压链一起结束。最后一帧写了一半时，它之前的完整行照用。首行必须是这个 ID、这个目录、格式 4。只看 `turn/start`、`turn/end`、`assistant/message`、`subagent/catalog`，每行必须以 `{"type":` 开头；回复会随整行解析进内存，只取出轮号、时间与 `usage` 的数字，其余随行丢掉。
- **怎么归到这一轮。** 开始与结束都在 Latch 这一轮之内的 dsh 轮次，把它们的 `assistant/message.usage` 相加（输入加回缓存读写）。有 dsh 轮次跨过这一轮的边、没有完整的轮、有回复没带 `usage`、会话到这一轮为止建过子 Agent（它的用量在 Latch 没有 ID 的子会话日志里），都一个数也不写。
- **去向。** 只有数字，只进轮次记录（`usage/turns-*.jsonl`），不进会话的 `TurnStats`，不进日志、错误、SSE。失败不说话。不写审计：不碰秘密，没有东西离开这台电脑，读到的数就是记录里那一行。

## 旧定义改为直连

Claude Agent 与 OpenCode 的预设原先保存的是适配器路线（`claude-agent-acp`，以及 `opencode acp`）。Host 启动时（启动脚本允许它运行这个人的程序之后、加载 Harness 之前）逐个看保存的定义，把仍与当时预设写下的内容完全一致的改成预设现在的命令（`claude`、`opencode`），与今天添加这个预设保存的一样：

- **只改没动过的。** 命令、参数与当时的默认逐项相同，没有环境变量，已启用，才算；换过命令或路径、加过参数或变量的不动。预设自己的程序要装着、版本读得出且够新（`claude` 2.1.322、`opencode` 2.2.6），否则不动，下次启动再看。读版本运行的就是适配器本来驱动的那个程序。
- **只改一次，先审计。** 改之前写一条 `agent.defined`（启动者是 Host），再写设置；定义记下它原来的样子（`migratedFrom`）。之后在设置里保存或改动运行内容的定义带 `routeKept`，Host 不再动它：有人特意改回适配器就留在适配器。
- **原有会话接着用。** 会话的启动指纹记的是旧定义。运行时核对指纹不符时，再按 `migratedFrom` 算一遍旧定义的指纹（同样的项目配置、文件夹、模型服务路线与模式，按今天的值）：与会话记下的相同，就把会话的指纹换成现在的并继续；不同照旧拒绝。所以它只接受 Host 自己这一次、审计过的改动，项目配置或别的东西变了仍然拒绝；人改过的定义没有 `migratedFrom`。会话在列表里的位置不变。适配器建的会话在直连线上按同一个会话 ID 恢复（`direct-migrate.live.test.ts` 用真实的两个程序各走一遍）。

## Claude 的 Agent SDK 线

`wires/claude.ts` 经官方的 `@anthropic-ai/claude-agent-sdk`（精确版本在 catalog）驱动人自己装的 `claude`，一个会话一个流式输入的 `query()`、一个 `claude` 进程。运行时照旧说 ACP，线把它换成 SDK 的调用与消息。依据 SDK 的 `sdk.d.ts` 与 `claude-agent-acp` 0.101 的 `acp-agent.js`。

- **程序与进程。** `pathToClaudeCodeExecutable` 是查到的 `claude`；SDK 的平台包（自带的 Claude Code）在 `pnpm-workspace.yaml` 的 `ignoredOptionalDependencies` 里不安装，两个只供类型用的 peer 经 `packageExtensions` 标为可选、也不安装。SDK 经线的 `spawnClaudeCodeProcess` 起进程：`process.ts` 的 `AgentProcess`（自己的进程组、stderr 尾巴、停止时先关 stdin 再 SIGTERM、SIGKILL），环境是运行时算好的那份，SDK 只能再加 `CLAUDE_CODE_*`、`CLAUDE_AGENT_SDK_*` 标记，其余（包括 Host 的变量）丢掉。网关令牌只在这份环境里；网关的模型清单经 `settings` 进 `--settings` 参数，里面没有令牌。SDK 启动时写进 Host 环境的 `CLAUDE_AGENT_SDK_VERSION` 随即还原。`claude` 是原生程序，`--disable-sigusr1` 不适用（SDK 会把 `executableArgs` 也放在原生程序前面，所以不传）。
- **与适配器相同的设置。** `settingSources: ['user','project','local']`、`systemPrompt` 与 `tools` 用 `claude_code` 预设、会话的 MCP 服务器、`includePartialMessages`、`allowDangerouslySkipPermissions`（root 时不给）；Claude 自己的 CLAUDE.md、技能、斜杠命令、hooks、插件与 MCP 服务器都由它自己加载。适配器自己注册的 hooks（计划、任务清单、子 Agent 配置、模型切换同步）不注册。
- **会话。** 新会话由线生成 UUID 作为 SDK 的 `sessionId`，恢复用 `resume`，与适配器相同；不是 UUID 的 ID 不找。`claude` 说找不到会话时是 `-32002`。一个线同时只开一个会话，另开会话或 `session/close` 先结束上一个 `query()` 与它的进程，那不算线退出；会话打开后进程自己退出才算。
- **Claude 自己的存储（`cliStore`）。** 只有启动脚本给 Host 的 `cliStore` 打开时（经 `AcpAgentOptions.claudeStore` 到线），线才读写 Claude 的存储；读取进程或 SDK 不在（打包的 Host 没有 `node_modules`）时同样关闭；测试 Host 不给，线不宣告列出、加载、删除与分叉，也不读设置。读写都在一个短命的 Node 进程里（`claude-store.ts` 起 `claude-store-runner.ts`，`--disable-sigusr1`、自己的进程组、15 秒超时杀整组、输出至多 16 MiB），环境只有会话那份里的 `HOME`、`USER`、`PATH`、`TMPDIR`、`LANG`、`CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_PROJECT_DIR_NAME`：SDK 的会话函数读的是所在进程的 `CLAUDE_CONFIG_DIR`，这样读到的就是这个会话的 `claude` 写的那份，Host 自己的环境不参与，大转录的内存也不进 Host。会话 ID 先按 UUID 校验才交给 SDK。设置只以事实返回（布尔、规则文字、数字、模型名），从不返回 `env` 的值、密钥脚本或 hooks 的命令；登录凭据与注册表的 `.key` 文件不读。
- **设置。** 开会话前读 `resolveSettings({ cwd, settingSources })` 与 `filterEscalatingDefaultMode`（同一目录 30 秒内复用，5 秒读不到当作没读）。`disableBypassPermissionsMode`、`disableAutoMode` 为 `disable` 时菜单不列「不再询问」或自动模式，`allowDangerouslySkipPermissions` 不给，`set_config_option` 也拒绝；`maxEffortLevel` 截掉更高的思考档位。设置里的 `defaultMode` 只作说明，会话照旧从 `default` 开始（Latch 不替人预选宽松档位）。自动放行的规则与它所在的层（用户、项目、项目本地、组织托管）、有无 hooks、有无托管设置作会话权限的 `notes` 返回（`_meta.latch.permissionNotes`，只在内存）。`resolveSettings` 不是安全判定，最终仍以 `setPermissionMode` 的读回为准。
- **一轮。** 输入是带 `uuid` 的 `SDKUserMessage`，`uuid` 是这一轮 Latch 用户消息的 ID（`PromptContext.messageId`，同一会话上同一 ID 只用一次，再发同一条时换线自己的 UUID）；图片按 base64 块，嵌入的资源成文字。只有带同一 `user_message_uuid` 的结果结束这一轮，别的结果（Claude 自己开始的一轮）只报告用量。流式的 `text_delta`、`thinking_delta` 成为文字与思考，消息 ID 是 Claude 的 `msg_…`；同一 ID 的整条消息（`claude` 可能每个内容块发一条）只补流式没发出的部分。
- **工具行。** 标题、种类、差异与位置照适配器给既非 AIR 也非 ACP v2 的客户端的样子（`wires/claude-tools.ts`，依据它的 `tool-calls/reporters/`）：`Read a.txt`（位置带行号）、`Edit`（`old_string` 到 `new_string` 的差异）、`Write`（新文本的差异，运行后换成结果里 `structuredPatch` 的真实差异）、`NotebookEdit` 只有标题，命令的输出放进 console 代码块。
- **任务清单。** TodoWrite 的列表与 `TaskCreate`、`TaskUpdate`、`TaskList` 的结果作 `plan` 更新，它们不成工具行，与适配器相同。真实核对时 2.1.327 的 SDK 会话没有提供这些工具（`init` 只列 `Task`、`TaskStop`），所以只用假 SDK 测过。
- **子 Agent。** 照适配器的 RFD 形式：Agent 调用在发起它的会话上宣告 `subagent_update`（`state: running`），子会话 ID 是 `<会话>/subagent/<调用 ID>`；带这次调用 `parent_tool_use_id` 的文字与工具调用发在子会话上，它的审批（`canUseTool` 的 `agentID`）也在子会话上。`task_started` 之后带 `capabilities.cancel`，单独停止经 `stopTask`。Agent 调用的结果到达时报告 `idle`（失败时带错误，停止这一轮时 `cancelled`）。
- **审批。** `canUseTool` 成为运行时的权限请求，选项与适配器的 `permissions/options*` 相同（ID、类型、名字与顺序，`wires/claude-permissions.ts`）：一般调用 `allow-once`、`reject`，Claude 给出建议时另有 `allow-with-updates`（`allow_always`，选中时把建议原样作 `updatedPermissions` 交回），Skill 的 `allow-skill-*`、WebFetch 的按域名规则；人的 ask 规则触发或 `suppressAlwaysAllowRule` 时不给。Latch 对所有预设都只展示一次性的允许与拒绝（见「预设的权限配置」），所以「始终允许」在两条路线上都不出现。ExitPlanMode 给 `exit-plan-clear-*`、`exit-plan-auto`/`exit-plan-bypass` 或 `exit-plan-accept-edits`、`exit-plan-default`、`reject`；接受时把 Claude 换到所选模式并报告；`reject`（继续规划）以 `interrupt` 拒绝，这一轮按取消结束，与适配器相同。EnterPlanMode 的类型是 `switch_mode`。Claude 自己拦下的调用（`permission_denied`）照适配器的样子写 `_meta.claudeCode.toolResponse`。
- **提问。** 客户端声明表单提问时（Latch 有 `askUser` 时），AskUserQuestion 经 `canUseTool` 成为 `elicitation/create` 的表单：每题 `question_<n>`（单选 `oneOf`、多选 `anyOf`）加 `question_<n>_custom`；回答写进工具输入的 `answers`（多选逗号连接，选了又写的话进 `annotations[问题].notes`），拒答给空的 `answers`，取消中止调用。没有表单时与适配器一样关掉这个工具。MCP 服务器的表单提问经 `onElicitation` 同样交给人，URL 形式答「取消」。
- **模式、模型与思考。** 选项 ID 与适配器相同：`mode`（`default`、`acceptEdits`、`plan`、模型支持时 `auto`、`bypassPermissions`）经 `setPermissionMode`；`model` 的值是 `supportedModels()` 的 `value`，`default` 经 `setModel()` 交回 Claude；`effort`（`default` 加模型声明的档位）经 `applyFlagSettings({ effortLevel })`，与适配器相同。新会话与恢复的会话都以 `default` 开始；运行时在下一条消息前把会话记下的模式设回去（模式读回），模型与思考经 `resumeResetsOptions` 设回去。当前模型按 `getContextUsage()` 报告的模型认出所在一行。Claude 自己换模式（`init`、`status` 消息里的 `permissionMode`）时报告 `config_option_update`。
- **取消与轮次结束。** `session/cancel` 发 `interrupt()`，等它答复、且这一轮的结果到了才按取消结束。线给 `claude` 设 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`（与适配器相同），`session_state_changed` 的 `idle` 是 Claude 说这一轮已结束：已经到了这一轮自己的结果、只差中断答复的取消由它结算。单独一个 `idle` 不结束任何一轮，它可能属于更早的结果（适配器为此计数）。
- **恢复前查记录。** `resume` 前在存储进程里 `getSessionInfo`（先按目录，再跨项目；没有摘要的会话再看有没有消息）；记录已不在时直接回 `-32002` 并带 `lostReason`（Claude 会删除超过 `cleanupPeriodDays`，默认 30 天未用的会话），运行时把原因写进提示，不再起 `claude` 等它说找不到。读不到存储时照常恢复。
- **删除。** `session/delete` 在存储进程里 `deleteSession`（先按目录，再跨项目；找不到算成功），不起 `claude`、不运行项目里的任何东西；删的是转录与同名目录（子 Agent、大工具输出），`file-history/<id>`、`session-env/<id>` 等由 Claude 自己按 `cleanupPeriodDays` 清理。线自己开着这个会话时先关掉，另一个 `claude` 开着时（注册表）拒绝。进程已退出时，运行时直接在读取进程里删除（先查注册表，开着的不删），不核对启动指纹、项目列表与命令，也不看会话开始时记下的 `deletable`，所以改动前开始的会话、项目已移除的会话同样真删除。
- **分叉。** 宣告 `forks`，回答 `FORK_METHOD`：在存储进程里读来源的全部条目（`importSessionToStore`，压缩前的也在），沿 `parentUuid`（压缩处 `logicalParentUuid`）找到 `uuid` 等于 `through` 的那条人的提示，取下一条人的提示之前最后一条用户或助手记录作 `forkSession` 的 `upToMessageId`；复制出的最后一条的 `forkedFrom.messageUuid` 不是它时删掉副本。之后 `resume` 新会话。找不到这一轮（改动前或在适配器上开始的会话）、复制没停在这一轮或副本打不开时 `ForkRefused`，运行时改用背景文本。副本的 `entrypoint` 沿用来源（Latch 的会话是 `sdk-ts`），终端 `/resume` 不列出。
- **自己的 MCP 服务器。** 第一轮开始时报告 `mcpServerStatus()`（不含 Latch 给会话的服务器）作 `_latch_mcp_status`；没有会话时为「读取」开一个不留记录的会话（`persistSession: false`）读完即关。
- **不经一轮的额度。** 问 Claude 的实验接口 `get_usage`（SDK 类型里没有的 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`，带 `skipBehaviors`，否则它会扫近 7 天的转录），只读认得的形状（`rate_limits` 各窗口的 `utilization` 0–100 与 `resets_at`、套餐）。会话打开时在会话自己的进程上问；有人看「额度」时照「有人看时」的规则在私有空目录起一个 `claude`，开一个只为这次读取的会话：`persistSession: false` 不留转录，`strictMcpConfig` 不启动人配置的 MCP 服务器，flag 设置 `disableAllHooks` 不运行人的 hooks（管理员的托管 hooks 仍运行），问完关掉。Claude 答 `rate_limits_available: false`（API 密钥、Bedrock、Vertex）或没有这个接口时不是失败：「额度」写「只在对话中报告」，30 分钟内有人看也不再问（「重试」除外）。经网关或形状不对时什么也不说，之前显示的照旧。
- **经 Latch 使用模型服务的预检。** 第一轮开始时以 `notice` 警告：组织托管设置里的 `apiKeyHelper`、托管的 `availableModels` 不含这个模型；不经网关时设置 `env` 里自己的 `ANTHROPIC_BASE_URL`；设置 `env` 里写了 `CLAUDE_CONFIG_DIR`（这时 Latch 读到的存储可能不是 Claude 在用的那份）。
- **用量与额度。** 结果的 `usage`：`input_tokens` 是不含缓存的输入，缓存读写另记。之后在 2 秒内读一次现有的 `getContextUsage()` 完整报告。`totalTokens` 是 Claude 对当前占用的估计，`maxTokens` 是它报告的窗口。详情同时保留这一次报告的分类计数，区分已用、剩余、压缩预留和延迟加载的定义；未知分类按这四种口径汇总。消息明细是消息类内部的分项，服务商上一次回复的 `apiUsage` 单独保存，两者都不加进窗口总量。文件名、MCP 服务器名和工具明细名称留在 Claude 线。`total_cost_usd` 作花费（经网关时不报）。`rate_limit_event` 照适配器放进 `usage_update._meta["_claude/rateLimit"]`；一轮因回复错误失败时错误 `data` 带 `errorKind`（适配器同样），`rate_limit` 时另带最近一次的 `rateLimit`，额度照常读。
- **窗口历史。** 最近 32 轮保留各自那次窗口报告自带的分类与时间；后续报告缺少分类时，该次分类显示为未知。更早的轮次保留已用量和已报告的容量。
- **压缩。** `compact_boundary` 是 Claude 确认压缩完成的事件。会话只记录手动或自动、压缩前后 token 数和耗时中 Claude 确实报告的值，省略压缩摘要和被保留的消息清单。上下文占用下降时不推断压缩。
- **登录。** 开会话时把 `initializationResult().account` 照适配器的 `fromAccountInfo` 推送为 `_auth/status_update`（`account` 套餐、`api_key`、`external`、经网关时 `gateway`），不带邮箱与组织；变了才推送。
- **斜杠命令。** 创建或恢复会话时读取 `initializationResult().commands`。Claude 的 `system/commands_changed` 会替换本会话的目录，例如 MCP 连接后增加的提示。每轮 `system/init` 同步可用名称，保留已知说明与参数提示，从收到 `terminal_slash_commands` 时起隐藏只适用于终端的命令。

**与适配器不同、尚未实现的。**

| 项目 | 原因 |
| --- | --- |
| ExitPlanMode 的「清空上下文后执行」 | 选中时直连只按「继续规划」结束这一轮，不像适配器那样换新上下文接着执行；Latch 对两条路线都不展示这个选项（`allow_always`，也不在 `planAnswers`），所以没有接上 |
| 子 Agent 的流式文字、模型与文件夹 | 子 Agent 的文字按整条消息发到子会话；适配器另报告的子 Agent 模型与 `cwd` 没有 |
| 提示建议 | 适配器经 `session_info_update._meta.promptSuggestions` 发，Latch 的运行时不读，两条路线都不显示 |
| `agents` 目录项 | `initializationResult().agents` 没有读：Latch 的输入框没有列子 Agent 的地方 |
| 结果未知时查转录 | 每轮的 `uuid` 是 Latch 的消息 ID，转录里能查到 Claude 是否收到这一轮；运行时还没有向线要这种证据的接口 |
| 预热备用进程（`prewarm`） | 环境、MCP 与 `canUseTool` 在停车时就固定，每个约 250 MB，收益没有测过 |
| 适配器其他私有功能 | 文件改动报告、按某一条分叉、空闲压缩、目标（goal）与 AIR 扩展只在适配器里 |

## 同一个 Harness 的多个账号

在运行 Host 的 Mac 桌面端打开「设置 › Harness › 账号」，选择预设并给账号起名。配置目录应当是本人已用原生程序设置好的绝对路径，与项目、默认账号和其他账号目录分开。添加时经本机确认；手机和浏览器按设备已有权限使用保存的实例。Host 用独立的 Harness ID 保存每个实例，名称可以改。移除定义保留原生账号和磁盘文件，重启后仍禁止文件工具打开该目录的文件，也不能把该目录加入项目。绑定确认在本机显示配置目录，设备目录与设置接口只收到账号标记和名称。

提交超时或连接中断时，在原对话里按「重试添加」。Host 核对同一配置目录和预设，已保存的账号会直接打开。

| Harness | 额外账号用什么 | 使用条件 |
| --- | --- | --- |
| Codex | 该账号的 `CODEX_HOME` | SQLite 索引也放在绑定目录。各自的 app-server 报告模型、思考与额度，在原目录恢复 thread。 |
| Claude Agent | 该账号的 `CLAUDE_CONFIG_DIR` | 凭据由官方 CLI 管理。SDK 会话、模型和历史读取使用同一目录。Latch 沿用原生登录说明；[Anthropic 的认证要求](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)与上文的发布约定同样适用。 |
| pi | `PI_CODING_AGENT_DIR` | 选择含该账号配置的 agent 目录。 |
| OpenCode | 独立的 XDG 根 | 原生程序分别使用根下的 `config`、`data`、`state`、`cache`。 |
| DeepSeek Harness | `DSH_HOME` | 余额仅适用于可核实的官方 DeepSeek API key 路线。配置检查、读余额和读取用量均使用该账号目录。 |
| Qwen Code | `QWEN_HOME`、`QWEN_RUNTIME_DIR` 和 `HOME` 均使用绑定目录 | 需要确认 CLI 为 0.27.4 或更高版本。打开登录终端时从绑定目录进入，再用 `/auth`。 |
| goose | `GOOSE_PATH_ROOT` | 这个目录需要用 `GOOSE_DISABLE_KEYRING=1` 配置文件型凭据。绑定后的 goose 进程使用同一设置。 |
| Grok Build | `GROK_HOME` | 选择该账号已经配置好的 Grok 目录。 |
| Cursor | 每个实例各自的 `CURSOR_API_KEY` | 在运行 Host 的电脑填写，使用 [Cursor SDK 路线](#cursor-的-sdk-路线)，编辑定义时需保留专用密钥和预设命令。 |
| Antigravity | Gemini Enterprise ADC 目录 | 在原生工具配置好 `application_default_credentials.json` 后绑定它所在的目录。CLI 使用 `AGY_ADC_AUTH` 和这份文件，Host 只检查文件元数据。个人 Google 登录继续使用系统钥匙串。ADC 实例不提供个人订阅的额度或退出登录，原生历史目录仍由 CLI 管理。[Google 的 ADC 说明](https://antigravity.google/docs/enterprise) |
| Latch 内置 | 各自的模型服务 | 在「设置 › 模型服务」给每个服务命名并分别配置密钥，在模型选择器中按服务选择。 |

在新对话选账号后，模型、思考档位、额度和登录状态均按该实例读取。界面和 API 启动时都默认使用所选账号自己的模型，明确指定的模型服务优先。已开的对话按原 Harness ID 恢复。并行使用两个账号时开两条对话；其中一个失效、停用或用尽额度，需要由人处理。CLI 没有提供稳定账号标识时，Host 只能核对绑定目录。因此，请为新身份另建目录；在同一目录直接改登，Latch 无法可靠发现身份已经变化。额度页只列 Harness 实际报告的额度。

**Qwen Code 的项目配置。** 独立账号保留原生的项目信任和取值顺序。可信项目自己的 `.qwen/.env` 或 `.env` 可以给这次会话提供模型凭据，并优先于绑定目录的 `.env`。Latch 只用这些项目文件的身份、大小和时间计算启动指纹，变更后须新建会话。Qwen Code 还会向上查找同名文件。Latch 在启动与复用进程前发现项目祖先目录里的候选文件，或项目文件通过链接指向范围外时，就拒绝使用该项目。Qwen Code 运行期间可以重新读取文件，因此检查只覆盖启动与复用时的文件状态。默认账号沿用原生路径与版本规则。[Qwen Code 0.27.4 的环境加载](https://github.com/QwenLM/qwen-code/blob/v0.27.4/packages/cli/src/config/environment.ts#L390-L501)

## 登录

Latch 从不替人登录：不调用 `authenticate`，不读凭据文件或钥匙串。它只运行程序自己的命令，并听 Agent 怎么说。

**登录方式。**

- **Agent 声明的终端登录。** Agent 可以在 `authMethods` 里列 `type: "terminal"` 的方法。握手记下这些方法与宣告它们的程序路径（`src/auth.ts`，只在内存）。方法不能指定程序：运行的就是会话运行的那个程序，加定义的参数，再加方法的 `args`。方法的 `env` 只接受普通变量名，点名 Latch 设置或清除的变量时整个方法丢弃；参数与变量有数量和长度上限。打开终端前重新查找程序，路径变了就拒绝（409 `login-program-changed`）。定义自己的环境变量不写进登录脚本，因为里面可能有密钥。
- **预设的命令。** Agent 没列方法时用 `AgentPreset.login`（见「直连优先」的表），经 `HarnessInfo.login` 发给客户端。
- **Claude Agent。** 预设写了 `signIn`：Latch 不对它声明 terminal auth，不运行它列出的任何登录，页面只给 `signIn` 那句话，没有登录命令与按钮。页面显示它报告的登录状态、标签与到期日。

**状态。**

- **Agent 推送。** codex-acp、Claude Agent 的适配器与 Claude 直连推送 `_auth/status_update`（以 `agentCapabilities._meta.authStatus` 宣告）。Latch 只读 `kind` 与 `label`：`none` 是未登录，`account`、`api_key`、`gateway`、`external` 是已登录，其他是 `unknown`。`label` 显出不可见字符、遮住像密钥的部分、最多 80 字，含 `@` 的整个不用。`account`（email、组织、套餐）在解析时就丢掉。推送只在发出它的进程还在时算数。Claude Agent 的适配器只在 `initialize`、建会话与每轮开始时重读登录，直连只在建会话时读，所以空闲进程的推送可能是旧的。
- **状态命令（`loginStatus`）。** 只有 Codex 与 Claude Agent 有；其他 Harness 始终 `unknown`，要到 `session/new` 被拒才知道，Antigravity 除外（见下）。
- **不开会话的请求（`loginRequest`）。** Antigravity 的「测试启动」在 `initialize` 之后再发 `session/list`（不带参数，最多 10 秒）：回答了就是已登录，`-32000 Authentication required` 是未登录，其他都是 `unknown`。它不开会话、不跑一轮（1.5.11 核对，已登录一侧用 Gemini API key 夹具）。
  - Codex：`codex login status`。退出 0 算已登录；退出 1 且文字是 `Not logged in` 才算未登录，其他都是 `unknown`。
  - Claude Agent：直连是 `claude auth status --json`，适配器上是它自带 CLI 的 `claude-agent-acp --cli auth status --json`，只读 `loggedIn`、`apiKeySource`、`apiProvider` 与 `loginExpiresAt`。有推送时它仍运行，因为推送里没有到期日。
  - 超时 10 秒。输出只在判断时读一次，可能含账号或部分密钥，不返回、不记录。
- **三态接口。** `POST /link/api/harnesses/:id/login-status`（`run`，可带 `fresh`）返回 `{ status, label?, expiresAt? }`。有运行中的进程推送过、而状态命令说不出更多时直接用推送，不运行程序。两者都有时较新的说了算；标签只取推送的，日期只取命令的，各自只在结果与它的来源都说已登录时给出。结果缓存 30 秒；「测试启动」读到不同的明确状态时缓存作废。`fresh`（「重新检查」）总会再运行程序，只有 2 秒内的上一次 `fresh` 结果能代替它。
- **审计。** 每次实际运行前写 `agent.login.requested`（写不进就不运行），结束后 `agent.login.checked`，只含 ID 与状态。
- **不挡发送。** 页面选中 Harness 与窗口回到前台时检查；只在 `unauthenticated` 时显示登录说明，登录 10 天内到期时提示，都不挡发送，因为程序才说了算。没有状态命令的 Harness 在读模型列表被以没登录拒绝时（`catalogueRead.last.loginRequired`）显示同一行说明。
- **被拒的一轮。** 在这一轮结尾显示命令与「重试」。登录后消息仍由人按「重试」发出，这一轮在记录里仍是失败；下一轮启动新进程，读到新的登录。

**退出登录。** Agent 宣告 `agentCapabilities.auth.logout` 时才显示。`POST /link/api/harnesses/:id/logout`（`run`）先写审计 `agent.logout`（写不进就不做），再在私有空文件夹里起一个进程调用 ACP `logout` 后停掉。这个 Harness 有会话在运行时拒绝（409 `harness-busy`），没宣告时 409 `logout-unsupported`。之后停掉能恢复会话的空闲进程；不能恢复的进程留着它启动时读到的登录。

**在终端里登录。** `POST /link/api/harnesses/:id/login-terminal`（可带 `method`）只接受 `host.sock` 与 `run`。命令由 Host 从定义得出，调用方不能指定。写审计 `agent.login.opened`（Agent 声明的方法带 `source: 'harness'`）。

| 请求 | 在哪里运行 |
| --- | --- |
| 带 `terminal` | Latch 自己的终端（`features.terminal`）：会话里是底部终端中以 Harness 命名的一个，没有会话时是不属于任何会话的终端。命令以 0 退出后页面重新检查；规则见 [ARCHITECTURE.md](ARCHITECTURE.md#终端) |
| 不带 | 这台电脑默认的终端（`features.loginTerminal`，仅 macOS）：Host 写一个 0700 的 `.command` 临时文件交给 `open`，脚本先删除自己。页面只在 Host 不给这台设备 Latch 终端时走这条路 |

绑定账号的登录终端使用该账号的配置目录。终端、浏览器、代理和 CA 文件所需的变量只通过进程环境传递，Shell 里的其他账号及 API 密钥不会传给它。其他设备只看到命令。macOS 以外的 Host 上这两条路径尚未实现。Claude Agent 没有登录命令，也就没有按钮。

**测试 Host。** `startServer` 没有 `loginPrograms` 时不运行任何登录命令，没有 `cliQuota` 时不读任何 CLI 的凭据、不问厂商余额，没有 `cliUsage` 时不读任何 CLI 的会话日志，没有 `cliStores` 时不碰任何 CLI 自己的存储（goose 会话因此不重新打开）；没有 `commandDirectories` 时只认绝对路径，按名字找命令一律找不到。只有启动脚本传 `resolveCommand` 与 `personCommandDirectories`，所以带预设定义的测试 Host 碰不到这台电脑上真实安装的程序。

## 额度

Harness 用自己的订阅登录时，Latch 显示它自己的程序报告的额度（界面见 [DESIGN.md](DESIGN.md)「额度与用量」）。额度在有人看时读：打开「额度」视图或在输入框选中这个 Harness 时，Host 在后台问每个已绑定（这台 Mac 确认过命令）且能报告的 Harness，只问上次数字缺失或超过 5 分钟的；会话打开与一轮结束时照旧顺带问。读法都不起模型轮次、不开会话，不定时轮询。唯一读凭据的是 DeepSeek Harness 的余额：Host 用它自己保存的 DeepSeek API 密钥问 DeepSeek 文档里的余额接口（见下面「DeepSeek Harness 的余额」）；其他 CLI 的令牌不读，存储只读上面「DeepSeek Harness 的会话日志」那一处，其他厂商接口不调。

| Harness | 来源 | 显示 |
| --- | --- | --- |
| Codex 直连 | 有人看时：`account/read` 与 `account/rateLimits/read`（驱动自己的请求 `_latch/quota/read`），不需要线程；在一个已在跑的、用自己登录的进程上问，没有就在私有空目录起一个不开会话的 `codex app-server`，问完停掉。线程打开后同样在会话进程上问一次，之后并入每轮的 `account/rateLimits/updated`（稀疏更新不清除已知值） | 套餐自己的桶（`rateLimitsByLimitId.codex`，没有时用 `rateLimits`）的窗口：300 分钟是「5 小时」，10080 是「每周」；`planType`；遮住的邮箱。按模型的桶不显示 |
| Codex 经 codex-acp | 适配器不转发 | 不显示 |
| Claude Agent | 直连：有人看时与会话打开时问 Claude 自己的 `get_usage`（见上面「Claude 的 Agent SDK 线」的「不经一轮的额度」），不起模型轮次、不留转录。适配器与直连在一轮里：`usage_update._meta["_claude/rateLimit"]` 的限额事件（Claude Code 在限额信息变化时发出，适配器只在本轮有模型回答之后转发；2026-11-16 用 0.101.0 核对，一次只答一句的轮次也带 `unifiedWindows`），与一轮因限额失败时错误 `data` 里的 `rateLimit`。适配器上有人看时不问，从没有数字时「额度」写「只在对话中报告」：适配器的 `/usage` 只经 `session/prompt`，要在人的 Claude 历史里开一个会话并发一条提示，答的是 Markdown | `unifiedWindows` 里每个窗口的 `utilization`（0 到 1，已与 Claude Code 自己的 `/usage` 对过）乘 100 是已用比例，带重置时间与 `allowed_warning`/`rejected` 状态；没有 `unifiedWindows` 时只取所报窗口的状态，这个窗口上次的数字（与读到的时间）留着，直到下一个数字或重置。只认 `five_hour`、`seven_day`、`seven_day_opus`、`seven_day_sonnet`。不发 `/usage` |
| Grok Build | ACP 扩展请求 `_x.ai/billing`，不需要会话（1.0.x 核对过）：有人看时在已在跑的、用自己登录的进程上发，没有就在私有空目录起一个只 `initialize` 的进程，问完停掉；会话接上进程时与每轮结束时也发，这两处至少隔 5 分钟 | 本计费周期一行（`creditUsagePercent`、`currentPeriod.end`）；已知的 `subscriptionTier`；`prepaidBalance` 大于零时显示为余额 |
| Antigravity | 它自己的命令 `agy -p /usage --output-format json`（`profiles/antigravity-quota.ts`，不起模型轮次），有人看时运行；会话接上进程时与每轮结束时也在旁边运行，这两处至少隔 5 分钟，不等它；按登录状态命令的规则运行，加 `AGY_CLI_DISABLE_AUTO_UPDATE=true`，20 秒后连进程组结束，失败不说话 | `remaining_fraction` 是剩余比例；`window` 只认 `5h` 与 `weekly`。只显示 `Gemini Models` 与 `Claude and GPT models` 两个组，其余整个丢掉；`num_turns` 不为 0 或形状不同的输出不用 |
| DeepSeek Harness | Host 自己读（`apps/host/src/cli-quota.ts`），不起进程：有人看时与一轮结束时，两者合起来至少隔 5 分钟（重试也一样），15 秒超时 | DeepSeek 账户余额与币种（`balanceCents`、`currency`，没有窗口）；`is_available` 为假时是 `limited`。只有余额时输入框不显示，账户不能用时显示「额度已用尽」。没有可用的密钥时「额度」写「无 API 密钥」 |
| Cursor、OpenCode、Qwen Code、goose、pi | 程序不报告订阅额度 | 输入框不显示；「额度与用量」末尾一行「不报告额度」 |

- **有人看时。** `POST /link/api/quota/refresh`（`{ ids?, retry? }`）立即回答，结果随 Harness 目录推送。它与开始会话同一道门：要 `run`，等待后再核对设备；只能看的设备不触发，只看到上次的数字。只问已绑定、状态可用、声明能报告的定义，不问预设报价。每个 Harness 同时只有一次读取，第二次共用；数字不到 5 分钟不问；两次开始至少隔 1 分钟（「重试」10 秒）；一次读取连起进程在内 30 秒为限（不超过请求超时）。起的进程在私有空目录、没有会话，读完连临时目录一起停掉删掉。真正开始前先写审计 `agent.quota.requested`（只有 Harness），写不进就不读。它起的是开会话本来就会起的同一个程序，少了会话与提示，所以不比开会话宽：有 `run` 的设备本来就能开这个 Harness 的会话。程序启动时做的事照旧发生，Grok Build 1.0.89 只 `initialize` 时不启动它自己配置的 MCP 服务器（等 5 秒核对过，开会话时才启动）。
- **读取状态。** `HarnessInfo.quotaRead`：`running` 正在读；`failed` 是上次读取没有数字的原因（`login` 程序说未登录，`no-key` Host 没有可用的密钥，`failed` 其他；固定集合，不带程序的文字），有数字到来就清掉，只在内存；`afterTurn` 只在一轮里报告（Claude Agent 的适配器），或问过而它说这个登录没有套餐额度、没有这个请求（30 分钟内不再问）。「额度」视图据此显示：Host 在读、或这个视图刚请求的读取还没有结果时（以 Host 回答的 `asked` 为准，最多 35 秒）显示上次的数字（悬停是读到的时间）或一个安静的读取标记；失败时上次的数字留着，没有数字时写「未登录」「无 API 密钥」或「读取失败 · 重试」；还没添加的预设写「未添加」，不转圈。
- **形状。** `HarnessInfo.quota`（`packages/protocol/src/quota.ts`）全部是数字与固定集合里的值，没有厂商写的文字：不认识的窗口种类整个丢掉，不在集合里的套餐名不显示（`packages/harness-acp/src/quota.ts` 的 `harnessQuota`）。Codex 的 `rateLimitUpsell`、`limitName`、`accountId` 与完整邮箱不离开读它的进程；邮箱读到时就遮住。
- **随会话保存。** 按 Agent 定义保存在驱动的 `acp.json`（`AcpState.quota`，只有数字、固定集合的值与遮住的邮箱），不进日志与审计；Host 重启后照旧显示上次的数字与时间。窗口过了重置时间不再显示；报告它的进程退出后，有重置时间的窗口留到重置为止（额度属于账号），没有的随进程消失。退出登录或定义变化后全部清除。
- **谁能看到。** 随 Harness 目录（`catalog.harnesses`）发给能看到这个 Harness 的设备，没有单独的接口与权限；内容变了才推送。
- **经 Latch 使用模型服务的会话**不读、不问、不显示：订阅的额度不是它的。
- **到上限**（百分比到 100、Claude 报 `rejected`、Codex 的 `rateLimitReachedType` 不为空）是 `limited`。Latch 不因此拦截发送，被拒的一轮照常显示 Harness 的错误。

### DeepSeek Harness 的余额

DeepSeek Harness 用 API 密钥时，密钥是 DeepSeek 发给这个人的，DeepSeek 文档化了用它查余额：`GET https://api.deepseek.com/user/balance`，`Authorization: Bearer <key>`（[api-docs.deepseek.com](https://api-docs.deepseek.com/api/get-user-balance)）。它用 DeepSeek 账号登录（Platform 授权）时没有文档化的余额接口，不报告。

**只在这些条件下读**：定义是预设自己的命令（`dsh --profile acp`，无变量，这台 Mac 确认过的程序）；Host 由启动脚本带 `cliQuota` 启动（测试 Host 不带，碰不到真实文件与厂商）；会话不经 Latch 的模型服务；一轮结束或有人看「额度」，距上次（两种合起来）至少 5 分钟。

**密钥经过的每一处**（`cli-quota.ts`）：

1. `readDshKey` 先排除可能把密钥发去别处的设置：DeepSeek Harness 会继承的环境（Host 的环境与登录 shell 读出的值）里有未绑定的 `DSH_HOME` 或 `DEEPSEEK_BASE_URL`；`~/.dsh/.env` 或 `~/.dsh/profiles/acp/.env` 写了 `baseURL`、`DEEPSEEK_BASE_URL` 或 `apiKeyEnv`，或读不了、是链接。有一项就不读密钥，已显示的余额也清掉。会话文件夹的 `.env` 这样时只跳过这一次，已显示的余额不动；有人看时没有会话文件夹，只核对属于家目录的设置。这些都通过后，问 DeepSeek Harness 自己组合出的配置（见下面「它自己的配置」）：`llm-deepseek`、`credentials`、`llm-pi-ai`、`deepseek-account` 不是官方 bundle 原样的，或官方 bundle 以外加入的插件能碰到它们，也不读。
2. 再读默认或已绑定目录下的 `.credentials.yaml`：目录必须属于本人并且不是链接；文件以 `O_NOFOLLOW` 打开，打开后核对是普通文件、属于本人、其他人不可读、不超过 64 KiB。只认 DeepSeek Harness 写的版本 1 布局里 `refs.DEEPSEEK_API_KEY`，值必须像 DeepSeek 密钥（`sk-…`）；引用里有 `DEEPSEEK_BASE_URL` 也不读。
3. 审计先写 `agent.quota.read`（只有 Harness 与预设 ID），写不进就不发。
4. `fetchDeepSeekBalance` 把密钥放进这一次请求的头，地址写死，经 Host 出站策略（不加任何放行）、TLS、不跟随重定向。失败不记日志、不抛出、不重试；401、403 或形状不对就清掉已显示的余额。
5. 离开这个模块的只有余额（百分之一单位）、币种与能不能用；随会话存进 `acp.json` 的也只有这些。

**它自己的配置（`dsh-config.ts`）。** 不再在 patch 文件里找关键词，而是运行确认过的程序 `dsh --profile acp --dump-config`：它打印组合好的整棵插件树后退出，不挂载插件、不开会话；每个条目前有 `# == <层>`，被后面的层改过时写 `, patched by <层>…`，bundle 写包名、文件写绝对路径（0.2.2-rc.1 实测，用户层与 `--patch` 都如此）。判定：所问的插件都在、都来自 `@deepseek-ai/dsh-base` 或 `@deepseek-ai/dsh-acp-app`、且只被这两个 bundle 改过，其他层加入的插件既不用所问插件的 ID，它的各行也不提所问的插件、`baseURL`、`apiKey`、`DEEPSEEK`、`credential`、`persist`、`session` 或 `!!js`，才是官方（人为别的用途加的插件，如状态显示的 hooks，不挡余额、轮次 tokens 与真删除）；运行失败、超过 10 秒或 1 MiB 也不算。这样 bundle 自带的 patch、多个或其他扩展名的 patch 文件与 profile 的 bundle 清单都在里面。在私有空文件夹里运行（它会读启动目录的 `.env`），环境只有 `HOME`、`PATH`；它每次也会重写 profile 根的 `cordis.yml`（固定模板，正常启动同样写）。同一个家与程序的结论保留 5 分钟，人的 patch 层或 bundle 清单的修改时间一变就重问。它不求值 `!!js`、不读 `.env`，所以 `.env` 照上面另查。

密钥只在这次请求的内存里，不进日志、磁盘、参数、其他进程的环境、SSE、错误与审计，Latch 不刷新、不改写它。`redactKnownSecrets` 的 `sk-` 规则从 16 个字符起，覆盖这里接受的最短密钥。响应体按块读，超过 16 KiB 就停。

**真实核对。** 打开「额度」视图就会读，不必跑一轮；核对一轮结束时的读取要跑一轮，每轮都是一次付费的 DeepSeek 模型调用，提示要极短。

**出站与确认。** `https://api.deepseek.com` 是模型服务预设 `deepseek` 的 HTTPS 地址（`PRESET_KEY_ORIGINS`），Host 启动时核对它仍是预设地址，否则不提供这项读取（DeepSeek Harness 不再声明能报告额度）；它是公网地址，出站策略不需要放行，也不加放行。这不新增、不放宽 `PRESENCE_ACTIONS` 的任何一项：没有新地址可以确认，预设地址本来就不需要确认。

**没有做的。** pi 与 OpenCode 不读：pi 的订阅登录（Claude、ChatGPT、Copilot、Gemini 等）没有给第三方的用量接口；它保存的 API 密钥可以被扩展或 `models.json` 指去别处，Latch 无法排除。OpenCode 2.x 把凭据存在它自己的 SQLite 数据库里（`auth.json` 只是旧版导入来源），它的 Zen/Go 也没有文档化的用量接口。经 Latch 的模型服务用同一个密钥时，不需要读 CLI 的凭据，但网关现在不查服务余额，尚未实现。

## 权限菜单

有 profile 的预设给每个模式一个档位与一句话（`modeTiers`），随 `HarnessInfo.permission` 与 `TaskDetail.permission` 发给页面与 iPhone。档位从严到宽：「只看不改」（`plan`）、「先问你」（`ask`）、「按规则放行」（`rule`）、「由模型判断」（`model`）、「不再询问」（`never`）。另有只管图形的 `modeGlyphs`：文档写明某个模式做什么（写计划 `plan`、只问答 `question`）而档位画不出区别时用它，不改档位与排序（Antigravity 的 Plan 没有档位，Cursor 的 Ask 与 Plan 同为只读）。

| 预设 | 只看不改 | 先问你 | 按规则放行 | 由模型判断 | 不再询问 |
| --- | --- | --- | --- | --- | --- |
| Codex | — | `read-only` | `workspace-write` | `agent` | `agent-full-access` |
| Qwen Code | `plan` | `default` | `auto-edit` | `auto` | `yolo` |
| goose | `chat` | `approve` | — | `smart_approve` | `auto` |
| OpenCode | `plan` | `build` | `auto-edit` | — | `yolo` |
| pi | `plan` | `ask` | `rule` | — | `never` |
| DeepSeek Harness | `read-only` | — | `workspace-write` | — | `danger-full-access` |
| Cursor | `ask`、`plan`（官方名称） | `agent` | — | — | `agent-force` |
| Cursor 经 SDK | `read-only` | — | `sandbox` | — | `full` |
| Claude Agent | `plan` | `default` | `acceptEdits` | `auto` | `bypassPermissions` |
| Antigravity | — | `default` | `accept-edits` | `auto` | `turbo` |
| Latch 内置 | `plan` | `ask` | `rule` | `model` | `never` |

Latch 内置的档位由 Latch 自己执行：它不改调用的风险等级，只决定谁来回答，规则见 [PLUGIN-DEVELOPMENT.md](PLUGIN-DEVELOPMENT.md#权限档位)。

「由模型判断」各家的意思：

- Codex `agent`：沙箱同 `workspace-write`，本来要问的由 Codex 的审阅模型放行或拦下，不转给人。
- Qwen Code `auto`：用户的允许规则、只读工具与项目内的文件编辑先放行（`.git`、`package.json` 等除外），其余由它的分类器判断，判断不了时问。
- goose `smart_approve`：工具声明或模型判断为只读的不问，其余问。
- Claude Agent `auto`：Claude 的分类器。
- Latch 内置 `model`：会话自己的模型按固定的审阅提示判断每个 R2 调用，只有它答「放行」才运行，其余都问你。

规则：

- **没有匹配预设的定义**按 Agent 自己报告的模式与说明列出，没有报告时写「权限无法确认」。Agent 报告了表里没有的模式时菜单不列它，除非会话正处在这个模式。Grok Build 不报告模式，不生成档位。
- **三行。** 模式超过三个时只列「先问你」、一个中间档（有「由模型判断」用它，否则「按规则放行」）与「不再询问」，其余收在「更多」；当前模式总是列出。「不再询问」是琥珀色，「由模型判断」不是。
- **谁能选。** 有 `run` 的设备都能选任何一档，不弹确认；放宽写 `task.mode.widened`。Latch 内置的档位替人回答审批，所以还要那一档代答的批准权限（「按规则放行」要 `approve:standard`，「由模型判断」与「不再询问」另要 `approve:elevated`）；设备选不了的档位不列出，当前所在的一档除外。
- **默认。** 会话总从预设的预期模式开始，Latch 从不替人选更宽的一档。设备按 Harness 记住人在草稿里选的模式与其他选项。

**分叉草稿的模式**用来源会话当时的模型、思考与模式，不用设备记住的，也不写入设备记住的选项：

- 模式取 Latch 让来源会话保持的那一档（`permission.expectedMode`，人选的），不是 Harness 自己换到的那一档；Latch 不知道人选的档位时从目标 Harness 的默认模式开始并写明。
- 同一个 Harness：照原样带上（含经 Latch 的服务与模型）。
- 换了 Harness：模型与思考按同样的值带上；模式按档位找同一档，没有时用比它严的最宽一档，再没有用最严的一档。
- 来源没有模式、档位对应不上，或来源只对话而目标没有这种方式时，从目标的默认模式开始。
- 草稿写明哪些没有沿用；目标 Harness 的选项还没读到时不说没有沿用，只说要等读到。

**模型的判断。**

- **Codex** 报告自己的模型审阅一次请求：ID 以 `guardian_assessment:` 开头的调用，带 `review.status`（`approved`、`denied`、`timedOut`、`aborted`）。这一行写「放行」「拦下」或「没有判断」（`ToolDetail.judged`）。它的文字是 Agent 不可信的输出；它不是人的批准，没有决定记录，被拦下的在 Latch 里不能改为允许。
- **Claude Agent** 只报告它拦下的调用：`failed` 的 `tool_call_update`，`_meta.claudeCode.toolResponse` 带 `decisionReasonType` 与理由。来源是 `classifier` 时写「拦下」与模型审阅的理由；会话在「由模型判断」档时带 `ToolDetail.judged`（`denied`）并记录。来源是 `rule` 或 `mode` 时写被它自己的规则或当前模式拦下，在任何档都这样，不算模型的判断、不记录。
- 两种都放在 `ToolDetail.blocked`（`by`、`source`、`reason`），不显示成失败。理由经 Host 脱敏、限 1000 字。其他来源（钩子、安全检查等）照旧是一行失败；问过人的或已开始运行的调用不算 Claude 自己拦下的。
- `classifier` 这个取值来自适配器注释，还没有在真实的自动模式下见过；取值不同时这些调用照旧是失败，不会被说成模型的判断。
- **不报告判断的**（Qwen Code `auto`、goose `smart_approve`）与不报告放行的 Claude Agent `auto`：在这一档里没有问人就运行的调用写「没有问你」，不说是模型放行的，因为也可能是它自己的规则。
- **记录。** 每个审阅结论、每个被模型拦下的调用与每个这样没问就运行的调用写一条 `task.tool.judged`：`callHash`、`modeHash`、类别、结果（`approved`、`denied`、`timed-out`、`aborted`、`unknown`、`ran-unasked`）与来源（`agent-report` 或 `no-ask-seen`），只有哈希与枚举。这是事后的记录，不是关口；写不进去时取消这一轮并写明。

## 权限模式

- 停止一轮后可以在原会话换档。换档期间，ACP 驱动拒绝并发的新输入。换档完成后，下一轮按新档位核对权限。
- 每轮输入前设到预期模式并读回。读不回时（409 `permission-unverified`）这一轮什么都没发，输入框保持可用，页面给「在新会话中继续」（带上没发出的文字）与「重试」。切换模式时读不回同样如此。
- Agent 自己把模式放宽（漂移）时 Latch 取消这一轮、拒绝挂起的询问，会话不再接受输入（409 `permission-drift`）。
- `TaskDetail.permission` 描述会话：`level: 'L3'`、`enforcer: 'NONE'`、能否读回、是否已验证的预设、是否请求审批、预期模式、漂移记录与说明；不列出项目配置与其他文件夹。

## 映射

| ACP | Latch |
| --- | --- |
| `agent_message_chunk` | 流式正文与 `liveMessageId`；消息 ID 为 `msg:<messageId>` 或首个片段时生成的 UUID，结算后不变 |
| `agent_thought_chunk` | `liveReasoning`，结算到消息的 `reasoning` |
| `tool_call` / `tool_call_update` | 工具消息 `tool:<轮次>:<toolCallId>`，状态 pending/in_progress/completed/failed → queued/running/completed/failed。diff 的 `oldText` 为 `null` 记 `previous: 'none'`（新文件），为字符串记 `'text'`，缺少时不设（原内容未知） |
| `session/request_permission` | 审批（`advisory: true`、`risk: 'R2'`），只含过滤后的选项；`toolCallId` 为 `<轮次>:<toolCallId>` |
| `plan` | `TaskDetail.plan`（整体替换） |
| `configOptions`，或旧式 `models` / `modes` | `TaskDetail.config`（只保留下拉选项）；`setConfig` 调用 `session/set_config_option`、`set_model` 或 `set_mode` |
| `current_mode_update` / `config_option_update` | 更新记录的模式；被放宽时见「权限模式」 |
| `session_info_update.title` | 会话标题（用户重命名优先） |
| `PromptResponse.usage` | 会话与这一轮的用量，按 profile 的 `usageScope`（见「通知与压缩」的用量） |
| `usage_update` | `TaskDetail.usageReport`：上下文已用、窗口大小与费用，整体替换；不算可见输出，不计入 tokens。经网关的会话没报窗口大小时，用服务为当前模型声明的上下文长度。能归属某轮的已用量、来源与窗口分段标记另记入该轮的 `turn.contextWindow`，供逐轮窗口趋势使用 |

- 未知的更新类型被忽略。
- 上限：单条工具文本 64 KiB；每个工具最多 32 个 diff，原内容与新内容各截到 128 KiB；单行协议消息超过 64 MiB 终止进程。
- 时间都由 Host 的时钟（`HarnessHostOptions.clock`）记录，含义见 [STREAMING.md](./STREAMING.md)「时间与用量」。一轮从 Latch 接受提示开始：提示发出前 `activity` 是 `starting`，发出后是 `model`。一轮结束时由 Latch 替它结算的工具，只有运行过的才写 `completedAt`。
- 每一步助手消息记下当时的模型 `Message.model` 与思考深度 `Message.thinking`（`thought_level` 选项的当前值）。

### 开始前的选项

ACP 没有会话之外的模型接口，模型、思考与模式随 `session/new` 返回。所以选项来自 Harness 自己的会话，或一次不发提示的读取。

**记录。** 每个新会话的 `session/new` 回答记为这个 Harness 的选项列表（`HarnessInfo.catalogue`：`options`、各模型下跟着模型变的 `perModel`、`reportedAt`、`source` 为 `session` 或 `check`）。

- 存在该 Harness 的 `acp.json`，按 `definitionHash` 保存；定义一变就不再下发，读坏时丢弃，不影响会话。
- 模式的当前值写成预设每次开始前设好的模式，不是 Agent 碰巧报告的那个。
- 有上限（总大小 64 KiB，超出时先丢最早见过的模型，再整份不下发）：每份目录都带着它。

**服务模型。** 经网关的会话不记进 `catalogue`；草稿选服务模型时看 `HarnessInfo.serviceOptions`（`providerId`、`model`、跟着模型变的 `options`、`source`），由 Host 每次下发目录时用当前保存的服务设置算出（`Bridge.serviceOptions`，只传协议、模型与声明，不带密钥）：

- `declared`：Codex 直连在 Responses 入口上的思考，按服务为这个模型声明的档位给出「默认」（`~default`）加各档，与 wire 提供、`set_config_option` 接受的完全相同（`gatewayEffortOption`）。没有声明就没有这一项。
- `session`：其他 Harness 经网关的新会话在 `session/new` 回答里报告的、跟着模型变的选项，按定义 × 服务 × 模型 × 声明摘要（两侧协议与该模型的声明，`serviceDeclarationHash`）存进 `acp.json` 的 `serviceOptions`（最多 32 对，读坏时丢弃）。定义或声明变了就不再下发。
- Claude Agent（Anthropic 入口，profile 的 `gateway.defaultThinking` 是 `default`）的思考：在转换路线上，或这个模型声明了档位时，只给 Claude 自己的「Default」加服务声明的档位（`gatewayThinkingLevels`、`declaredThinking`，会话与草稿相同）；之前为别的模型选的档位这个模型没有声明时读作 Default，消息记下的思考随之变化。没有可选的档位时没有这一项。同协议转发且没有声明时仍是 Claude 自己的列表。
- OpenCode、DeepSeek Harness 与 pi 经网关时由 Latch 写入私有配置，但现有录制没有它们经网关时报告的选项 ID 与取值，所以不在 profile 里推导，只用 `session`。
- 只下发至少有两个取值的项，整份受同样的 64 KiB 上限。开始时所选的值按「不再提供时」处理：拒绝时说出是哪一项（如「思考档位「xhigh」」）。

**读取。** 还没有列表时可以不开始会话读一次：`POST /link/api/agents/:id/catalogue { auto?, model? }`（`HarnessInfo.catalogueRead`）。

- 在 Host 临时目录的新空文件夹里启动 Agent，`session/new` 带空的 `mcpServers`，不发提示；Agent 若在 `session/new` 返回后的下一事件循环才推送 `available_commands_update`，最多等 250 ms 收齐，再按声明用 `session/delete`、profile 的删除请求（Qwen Code 的 `deleteSession`）或 `session/close` 结束空会话，停止进程并删除文件夹，最多 20 秒。同一次读取一并把该定义自身的命令（及空目录里报告的技能）记入 `acp.json`（`AcpState.ownCommands`，`HarnessInfo.commandCatalogue` 的 `checked` 与 `reportedAt`），供草稿 `/` 菜单使用。DeepSeek Harness 不能删会话，连这个空会话也写进它的历史，所以进程停下后由 Host 删掉（见「CLI 自己的存储」）。
- Codex 不开会话：只发 `initialize`、`config/read` 与 `model/list`（最多 5 页）；直连同时记下自身的 `/compact` 命令。经 codex-acp 时用定义的命令加 `cli app-server`。它不报告模式，`catalogueRead.modes` 是 `false`。
- Grok Build 不开会话：它对 `initialize` 的回答 `_meta.modelState` 已有默认模型、模型列表与每个模型的思考档位（`reasoningEfforts`），Latch 照 `session/new` 报告的样子写成 `model` 与 `reasoning_effort` 两项（`profiles/grok.ts` 的 `grokStartCatalogue`，ID 与取值对真实 1.0.89 核对过），并一并收下 `_meta.availableCommands` 里的命令列表。这个进程不开会话，不启动人配置的 MCP 服务器与钩子（1.0.89 核对）。每个模型的思考都已知，选模型时不再读。`catalogueRead.modes` 是 `false`。
- **草稿自动预取与按需补读。** 桌面端、浏览器与原生 iOS 在草稿中先显示已有的目录。展示草稿输入框、切换已添加的 Harness 或打开它能报告模式的权限菜单时，会为 `catalogueRead.when === 'select'` 的已确认定义自动预取一次（`auto: true`，Host 复查），在同一次读取里把模型、思考档位、权限模式与自身斜杠命令全部写入 `acp.json`；Codex、Grok Build 与 Claude Code 直连在首次预取时即记下全部模型的思考档位。支持命令但旧存储尚未核对过自身命令且没有命中项目缓存时，打开草稿 `/` 菜单也会补读一次；如果是本机待添加的预设，不随草稿自动保存，只在桌面或本机管理员浏览器打开模型面板、草稿 `/` 菜单或开始会话时先保存定义再读取。草稿选中的自管模型还缺思考档位时，自动为该模型预读一次档位；若插件显式声明 `when === 'request'`，则等打开模型面板或手动读取。均不按时间轮询，读取失败可在模型面板重试。页面按 Host 对该 Harness 的观测（`commandCatalogue`、上次读取与目录时间）只自动请求一次，Host 回 `ran: false`（如命令未在这台 Mac 确认）后不再重试，直到观测改变。
- **预取照常启动 CLI。** 空文件夹与空的 `mcpServers` 只挡住项目配置和 Latch 的 MCP 服务器，挡不住人自己的全局配置：Claude Agent、Claude Code 直连与 pi 会运行人的会话开始钩子并加载插件或扩展，Antigravity 可能加载人的钩子与插件，Qwen Code 的 `session/new` 连接人配置的 MCP 服务器并触发 `SessionStart` 钩子（0.27.4 源码，没有开关能关），goose 的 `session/new` 启动人在 goose 里启用的全部扩展（含 stdio MCP 程序）并等它们（1.57.0 实测一个不握手的扩展让它等了 20 秒）。这些在每个定义第一次展示草稿时发生一次。

- **命令核对。** 预读发现命令未经确认或已经指向别的程序时，Host 返回 `ran: false`。显式请求遇到相同情况返回原因（如 409 `harness-unconfirmed`）。仅选中待添加的预设不会保存定义或启动进程。
- **谁能读。** 与开始会话同一道门：`run`，Harness 可以开始。同一定义同时只读一次；同一模型的请求共用结果。启动进程前写 `agent.catalogue.requested`（写不进就不启动），结束后 `agent.catalogue.read`。
- **结果。** 成功时列表来源为 `check`；失败保存脱敏后的 `last: { ok: false, message }`。Harness 以 ACP 的 `auth_required`（-32000）拒绝时另带 `loginRequired: true`：按错误码判断，不看消息文字。

**自己填的模型 ID。** `PUT /link/api/agents/:id/models { models }`（`run`，最多 32 个，每个最多 256 字符、不能换行，审计 `agent.models.changed` 只记个数）把 Harness 没列出的模型 ID 存进 `acp.json`（`HarnessInfo.customModels`），换定义也保留。只有列表里有模型选项时才能填。Agent 拒绝或没换过去时这一轮失败并说出下一次会用什么。

**草稿。**

- 已知权限预设在草稿就给出全部档位（`permission.modes` 与 `startMode`，暂用 `~mode` ID），开始时再匹配 Agent 实际的模式 ID。之后到达的列表不能抹掉人的选择。
- 草稿换自管模型后，缺少它的档位时自动在私有空会话里切到该模型预读选项，不发提示（插件显式声明 `request` 时在打开的模型面板中读取）。读不到或失败时保持未知，不把别的模型的档位搬过来。OpenCode 与 DeepSeek Harness 按模型报告思考（`thinkingPerModel`），没有就是这个模型没有思考档位；Cursor 的思考在模型列表里选（`thinkingInModel`）。
- 首轮设置未完成时，会话里的新选择取代对应的草稿项（相同值也算重新选择），并在恢复会话或应用其他草稿项之前持久化。

**应用。**

- 开始请求带 `config: [{ configId, value }]`（最多 16 项，同一项只能一次），计入请求摘要。Latch 内置 Harness 用 `model`，`config` 只收一项权限档位（`mode` 或 `~mode`，见 [PLUGIN-DEVELOPMENT.md](PLUGIN-DEVELOPMENT.md#权限档位)），别的返回 400 `config-unsupported`。
- `session/new` 之后、第一条提示之前，依次设置模型、Agent 为这个模型提供的其他选项、模式；模式交给「权限模式」的设置与读回。Cursor 的 force 和 Antigravity 的「不再询问」只报告启动配置完成。
- **不再提供时。** 选的模型、模式或其他选项 Agent 不再提供、被拒绝或没采用：这一轮失败、不发提示，文字说出它的名字与下一次会用什么。失败之前照常设好草稿里的其他选择并读回模式，所以会话显示的就是之后运行的。Agent 要先登录时，还没设好的选择留到登录后的那次发送（尚未实现：会话详情不带还没设好的选择）。
- **审计。** `task.l3.start-requested` 与 `task.l3.started` 带 `configHash`（所选内容的摘要，不原样记录）。
- **我的 Agent 默认项。** Host 从定义的 `engineOptions` 生成同一份开始配置并冻结在原 `requestId` 的选择回执里；开始请求不接受另传的 `config`。

**会话里修改选项。** 未知结果通过 Host 的配置回执查询，不自动再发 `set_config_option`：Agent 超时或连接关闭无法证明没有执行（见 [ARCHITECTURE.md](ARCHITECTURE.md#会话配置修改回执)）。

- **确定没改的拒绝。** 请求发出前的拒绝，以及 Agent 在动手之前就拒绝的回答（没有这个方法时 501 `not-supported`、会话不存在、要先登录）带 `details.configOutcome`（`not-sent` 或 `refused`）。其他错误一律是结果未知。
- **等待上限。** 一次修改等 Agent 最多 30 秒（`AcpAgentOptions.configTimeoutMs`），超过是结果未知。页面最多等 150 秒（含进程启动与恢复会话）。
- **核对（`Bridge.readConfig`）。** 只在会话空闲时：结束这个会话的进程（未回答的那次修改从此不会落地），由新进程用 `session/resume` 或 `session/load` 打开会话，取它报告的这一项。运行中、等你处理、另一次修改未结束或子 Agent 可能还在后台时不读（`busy`）；读取期间这个会话的发送、追加与修改都答 409 `config-check-running`。
- 修改在异步的启动指纹与项目目录检查之后同步复查核对锁，再保留写入占用；改成当前值的请求也不能绕过。`SetConfigOptions.authorize` 在准备连接前与实际发送 RPC 前复查 Host 授权。
- 核对只读：不设开始前的选择，也不把模式设回去；读到的模式就是所选的那一档时，它成为预期模式。Agent 不能恢复会话、没有报告或打开失败时不算读到。
- **OpenCode。** 2.x 与 1.15 起的 1.x 实现 `session/set_config_option`（`model`、`effort`、`mode` 三项）；1.4 之前没有。1.4 到 1.14 读回的模型带档位后缀，profile 的 `configValueMatches` 把它算作所选的值；Latch 不支持这些版本的思考档位。2.x 先记下选择再切换，切换失败时它已经用上所选值，所以错误回答是结果未知。

## 审批

- **选项。** Latch 去掉 `allow_always`、`reject_always`、预设隐藏的选项 ID 与未知类型，只展示「仅此一次允许」与「仅此一次拒绝」。
- **自动拒绝。** 去掉之后没有「仅此一次允许」时不展示审批，直接以「仅此一次拒绝」答复（没有该选项时答复取消），追加一条系统消息并记录安全事件。
- 选被去掉的选项返回 400 `approval-option-hidden`；所选选项必须属于该审批，且与允许或拒绝的方向一致。
- 一个会话可以同时有多个审批；多设备竞争时只有一个决定生效。不在进行中一轮里的询问答复取消。
- 允许要 `run`，任何设备都可以，不弹确认，不提供「始终允许」；拒绝要 `view`。
- **决定记录（`ToolDetail.decision`）。** 人的允许或拒绝记 `allowed`、`rejected` 与在哪里决定。取消、一轮结束、进程退出、Host 重启时还开着的询问，以及漂移时 Latch 自己拒绝的询问记 `cancelled`，不算某人的拒绝。Agent 撤回的询问不留记录。同一调用询问多次时，已给出的允许不被之后的拒绝或取消覆盖。见 [ARCHITECTURE.md](./ARCHITECTURE.md)「决定记录与拒绝说明」。
- 拒绝不保证 Agent 不执行：它之后报告的开始、完成与差异照常显示。ACP 的权限回复不能带文字，所以拒绝附带的说明不会转给 Agent。
- 不请求审批的 Agent 没有审批卡片。Latch 的审批不是操作系统沙箱。
- 文件编辑的展示按设备数据范围投影，见 [STREAMING.md](STREAMING.md#文件差异的设备投影)：Codex 的 fileChange 与 pi 明确的 diff 提供不含正文的输出摘要，普通 ACP 的编辑输出对 `work` 设备省略内容段。

### 计划审批

Harness 先给出计划、等人同意再动手时，profile 的 `readPlan` 认出这次询问，Latch 把它作为计划显示（`Approval.plan`、工具行的 `ToolDetail.plan`，两种存储都保留）。Latch 没有自己的计划模式；答复仍是 Harness 自己的选项，审批的规则、审计与决定记录不变。

| Harness | 认出的询问 | 「按计划执行」 | 「继续规划」 |
| --- | --- | --- | --- |
| Claude Agent | ExitPlanMode：选项是 `exit-plan-*`，计划在调用输入的 `plan` | `exit-plan-default`（回到 `default`，之后每次改文件先问） | `reject`：中断这一轮，这一轮按取消结束（直连与适配器相同），人在下一条消息里说怎么改 |
| Cursor | `cursor/create_plan` | `accepted` | `rejected` |

- **「按计划执行」只来自允许名单。** profile 的 `planAnswers` 列出能回答计划的选项 ID（Claude 是 `exit-plan-default`，Cursor 是 `accept`）；它若同时换模式（`modeAnswers`），换到的模式不能比 profile 的默认模式宽。名单之外的允许选项，或换到更宽模式的，一律不提供，从不改名显示；没有可用的就只能「继续规划」。
- 计划按 Markdown 显示全文，不渲染链接、图片与 HTML；回答按钮写「按计划执行」「继续规划」，Harness 自己的选项文字在悬停提示里。
- Claude 的其他选项（清空上下文后执行、自动接受编辑、自动模式、绕过权限）照「预设的权限配置」隐藏：前者让适配器在 Latch 不知道时换掉上下文，后几个会放宽模式。
- 「编辑计划」两边的 ACP 都没有提供（Claude 的允许原样回传输入），所以不提供；要改计划就选「继续规划」再写。
- Codex 的 app-server 没有计划审批的请求，`turn/start` 也没有协作模式字段：Codex 没有新的计划界面。Qwen Code、OpenCode、pi 的计划模式只限制工具，没有经 ACP 发来的计划审批；未经真实核对的 Harness 不认作计划。

## 取消

任何有 `view` 的设备都可以取消。每一轮有持久化的 `runId`；取消带着它时，Driver 只在它仍是当前这一轮时取消，否则什么也不做（Host 回答 `ended`，见 [STREAMING.md](./STREAMING.md#取消的请求-id-与回执)）。

1. 发 `session/cancel`，同时把该会话所有未决的审批答复为 `cancelled`。
2. 继续接收 Agent 的更新，等本轮 `session/prompt` 结算后才确认取消；状态记为 `cancelled`，不论 Agent 返回什么 stopReason。
3. 30 秒内仍未结算时终止该会话的进程组，会话转为 `interrupted`。执行中的工具标为结果未知；`TaskSummary.runEnd`（`forced-stop`）与取消回执列出它们（见 [STREAMING.md](./STREAMING.md#运行的真实状态)）。

## 运行中追加

内置 `standard` 可以在当前轮次接收文字。已发给模型的请求继续执行，已提出的工具调用照常审批、结算。下一次模型请求会带上补充。即使上一步只有文字回答，这一轮也会继续，并沿用原步数上限。附件可以排队留到下一轮。

ACP Agent 在 `initialize` 的 `_meta.steering = { supported: true }` 声明后，运行中的输入经 `_session/steering` 加入当前一轮，始终带 `_meta.steering.idleBehavior: "promptRequired"`：Agent 在没有轮次时不自己开新一轮，完成、用量与失败都留在原来的 `session/prompt` 上。

| 回答 | 处理 |
| --- | --- |
| `injected` | 记为这一轮里的用户消息；Host 读到回答的那一刻把之前的回复结算成一条 |
| `promptRequired` | 交回 Host 排队 |
| `failed` 或 Agent 明确返回错误 | 报告追加失败 |
| 无法识别的回答 | 从队列追加时保留为结果未知。输入框的普通追加仍沿用原错误行为 |
| 30 秒没有回答 | 结果未知，不重发 |

停止开始后不再追加。Codex 和 pi 的直连适配器同时声明 `_meta.steering.attachments: true`，其他 ACP Agent 可按同一约定声明。此时草稿或队列里的附件按普通输入的能力交付，图片可单独发送。只声明 `supported` 的轮次可追加文字，附件排队。语义见 [STREAMING.md](./STREAMING.md#追加到运行中的一轮)。

模拟器工具按当前运行 ID 检查发起设备。Driver 在真正发出较窄范围的追加前暂停这一轮的设备工具授权，追加送达或结果未知时撤掉授权。从队列追加时，写过文字的设备与点击追加的设备都计入本轮输入权限。旧回执的重放不会触发这一步。设备工具的规则见 [ARCHITECTURE.md](ARCHITECTURE.md#设备与浏览器)。

## 清空上下文

带 `freshContext` 的输入在新的 ACP 会话里开始（语义见 [STREAMING.md](./STREAMING.md#清空上下文)）。

- Latch 放下当前的 Agent 会话（Agent 声明 `session/close` 时关闭它），在同一进程上用 `session/new` 开新的（pi 是 `new_session`）。
- 人在这个会话里选的模型、思考与其他选项作为开始前的选项重新设置，权限模式照常设置并读回；Agent 不再提供所选模型时这一轮被拒绝。
- Agent 的指令（`agentBrief`）随新上下文的第一轮再发一次。旧会话的上下文用量、费用与计划不再显示。
- 从请求到新会话上记下第一条用户消息之前，任务记着上下文已清空（`acp.json` 的 `contextCleared`，`TaskDetail.contextCleared`）：这一轮被拒或进程退出时，下一条消息不论是否要求都在新会话里并带分隔线。重试同一请求不会再开一个会话。

## Codex 的 Agent 团队

Web 和桌面在「用团队分工」里提供「各开会话」。直连 Codex 报告已开启原生 `multi_agent` 后，还可选「Codex 子 Agent」。按下「开始」时，任务作为一条带 `teamRequest: true` 的消息发送，原草稿保留。Codex 自己派出成员、通信与汇总。原生 iOS 的「加入输入框」仍按普通消息发送。

- **概要中的归属。** 「团队成员」显示 Latch 为当前会话建立的团队成员，以及 Codex 在带有分工标记的轮次中实际派出的直接成员。Codex 的父轮委派由 `collabAgentToolCall` 或 `subAgentActivity` 与直接父关系确认。其余已报告的子 Agent 进入「子 Agent」，包括缺少入口标记的旧记录。成员身份取自 Harness 报告，同名和相同提示词均可出现在不同分组。
- **自主派出的成员。** 直连 Codex 报告子轮或最终文字时，已确认属于当前会话的子线程就会出现在记录里。后到的父轮委派信息补到原行。孙成员在已报告的父成员下显示，最终回复进入它自己的步骤。重开时仍可读上次保存的记录。
- **结算。** 根线程完成可以先显示答复，这一轮仍等已证实活跃的成员及其命令真正结算。
- **停止。** 输入框的停止操作针对当前运行的一轮。Host 向仍活跃的根、已证身份的成员及其已证实的后代发 `turn/interrupt`，等实际终态与命令结束。成员没有单独的停止按钮。
- **未知。** 进程退出后没有结算证据的记为「未回报结果」。Host 重启后先显示已保存的事实；下次恢复同一会话时核对直接父关系与 Host 观察到过的子轮，只有匹配该子轮的结果才补入。读回的 `interrupted` 不作为停止回执。
- **模型服务。** 主会话用 Latch 的模型服务时，成员继承同一 provider 与进程内的网关凭据，请求计入主会话与同一用量预算；角色或工具选了服务名单外的模型时网关拒绝，成员显示失败。

## 子 Agent

Latch 在 `initialize` 声明 `clientCapabilities.subagents: {}`（ACP 子 Agent 草案）。Agent 用 `subagent_update` 宣告它启动的子 Agent 后，Latch 在宣告到达的位置放一行 `Message.subagent`：名字、说明、它自己最后报告的状态，以及它的回复与工具调用（不含思考）。子 Agent 不是 Latch 会话，不能发消息、不进侧栏。

- **上限。** 每个子 Agent 最多 200 步、每段文字 64 KiB；最多 4 层；同一进程同时最多 64 行。超出的部分不显示并写一条说明，但它们请求的审批照常出现，不会被替人取消。
- **审批。** 子 Agent 在自己的会话上请求权限时，审批出现在启动它的会话里，`Approval.subagent` 写明是谁；规则与会话自己的审批相同。它只是提示性审批，从不经本机确认；挂起时会话处于等你处理，`PRESENCE_ACTIONS` 全部被拒。
- **模型的判断**与会话自己的一样标出并记录（见「权限菜单」）。Latch 不知道子 Agent 自己的模式，按启动它的会话的模式判断。不显示的调用记录照写。
- 没有宣告的会话 ID 的更新丢弃，不猜归属；不支持的 Agent 仍把子 Agent 的工作当普通工具调用报告。

**以会话的权限为上限。**

- 会话在「只看不改」时，子 Agent 只有只看的请求（`read`、`search`、`think`、`fetch`）交给人，其他种类（含 `other`、没有种类或不认识的）直接拒绝：Latch 分不出子 Agent 的命令是否只读。
- 回答会换模式的选项（`modeAnswers`）只在换到的模式不比会话宽时给人；认不出换到哪一档的不给。
- 拿掉之后没有「仅此一次允许」时不展示审批，直接拒绝，会话里写明，并写审计 `task.approval-auto-rejected`（原因 `subagent-wider`）。
- 其他档位的子 Agent 请求照旧交给人：「按规则放行」「由模型判断」的规则由 Harness 自己执行，Latch 不知道它放行的范围，不替它放行任何请求。
- 子 Agent 报告自己的模式比会话的预期模式宽或认不出时，按会话自己放宽处理：取消这一轮、拒绝挂起的请求、会话不再接受输入。ACP 不允许客户端改子会话的模式。

**单独停止。**

- 子 Agent 宣告 `capabilities.cancel` 且正在运行或等批准时，它那一行带 `Subagent.stoppable`。`POST /tasks/:id/stop-subagent { subagentId }`（`view`；`subagentId` 是那一行的消息 ID）先写审计 `task.subagent.stopped`（写不进不阻止停止），再对子会话发 `session/cancel`。
- 它自己挂起的请求答复为 `cancelled`（决定记录带 `subagentStopped`），之后再发来的请求也直接答复 `cancelled`。会话的这一轮照常继续。它启动的子 Agent 的请求不替它答复。
- 那一行带 `Subagent.stopping`，直到它报告 `idle` 或 `unknown`、这一轮结束，或进程被结束；发出停止不等于停下，在它报告之前不写「已停止」。`stoppable` 与 `stopping` 只来自运行中的进程，不保存。
- 不能单独停止的、已结束的或别的会话的行返回 409 `subagent-not-stoppable`。

**一轮结束时。**

- 停止会话时，子 Agent 挂起的请求与会话自己的一起答复为 `cancelled`。
- 仍说自己在运行或等批准的子 Agent 记为「未回报结果」；它未完成的调用与会话自己的一样结算，之后再报告完成或失败时以报告为准。
- 一轮自己结束（不是停止或失败）时仍在等批准的子 Agent 请求不取消，之后才到的也照常给人：会话显示「等你处理」直到答复，期间空闲进程不结束。答复后会话回到这一轮结束时的状态。

**OpenCode 2.x** 不发 `subagent_update`。

- Latch 不声明它的私有能力 `opencode/child-session-updates`，于是子会话的更新与权限请求都发在启动它的会话上，带 `_meta["opencode/child-session"]`。profile 的 `readProjectedChild` 把它当作那个子 Agent 在自己会话上的报告；`parentID` 是另一个子 Agent 时放进它的步骤。
- 子会话结束时没有报告，按会话自己的 `subagent` 调用读（`readChildEnd`）：调用完成且 `rawOutput.metadata.status` 为 `completed` 记完成，为 `running` 表示它在后台继续；调用失败记失败，在停止这一轮时失败的记已取消。
- 一轮结束后 OpenCode 不再发子 Agent 的更新，所以后台子 Agent 之后是「未回报结果」。
- 后来的一轮里用 `sessionID` 继续一个已有的子 Agent 时，经 `opencode acp` 不转发它的更新与权限请求：它要批准时这一轮一直显示运行中，只能停止。按 2.x 的源码确认，尚未在真实运行中核对。直连记住见过的子会话，照常转发（见「OpenCode 的服务接口」）。

## Agent 自己的请求

profile 可以读某个 Agent 在 ACP 之外发来的请求（`extensions`）。这些请求不带会话 ID，一个进程只跑一个会话，所以归到这个进程的会话。除 Codex 当场回答的那些（见「Codex 的 app-server」）外只有 Cursor：

- `cursor/create_plan`：成为一条审批「计划：<名称>」，选项是「接受计划」与「不接受」；回答按 Cursor 的形状回传（`accepted`、`rejected`、`cancelled`），停止会话时是 `cancelled`。
- `cursor/update_todos`：成为会话的计划进度；`merge` 按条目 `id` 合并到上一份，被取消的条目不再列出。
- Cursor 的其他通知不处理。

其他 Harness 发来这两个请求时照「不支持的请求」处理。

## Agent 的提问

源码：[questions.ts](../packages/harness-acp/src/questions.ts)。Host 给 Driver `askUser` 与 `questionSettled`（`HarnessHostOptions`）。提问与内置 Harness 的「向你提问」是同一张卡、同一个回答接口（`POST /tasks/:id/questions/:qid/answer`，`run`，`requestId` 重试同一回答）。

- **ACP 标准提问 `elicitation/create`。** 只声明表单模式，不声明 URL 模式（它会把人带到 Latch 无法担保的页面）。每个字段是一道题：`enum`、`oneOf`/`anyOf` 的取值是选项，`boolean` 是「是 / 否」，元素是枚举的数组可多选，没有取值的字符串与数字用「其他」填写；没有字段的表单问「同意 / 不同意」。
- **超限。** 超过 10 个字段、超出提问卡的长度（说明 2000、题目 1000、选项 500 字符）、URL 模式或读不懂的字段答复 `-32602`，会话里写一行；URL 模式的请求内容不写进会话。
- **答复。** 回答后 `{ action: 'accept', content }`；停止或这一轮结束时 `{ action: 'cancel' }`。
- **`cursor/ask_question`，任何 Harness 发来都读。** 最多 10 题、每题 20 个选项，每段文字不超过 4,000 字符。问题与选项都有 `id` 时放进提问卡，按 Cursor 的形状回答；人只写了「其他」时 Cursor 收不了选项外的文字，答复 `skipped` 并把文字放在 `reason` 里。缺 `id` 或 Host 不提供 `askUser` 时答复 `skipped`，在会话里写下它问了什么。
- **行与状态。** 每个提问有自己的一行 `ask_user`（`tool:<轮次>:ask-<UUID>`），从不借用 Agent 同 ID 的调用行。等待时会话为 `waiting-approval`。回答按选项位置（`optionIds`）而不是文字映射回 Agent 的取值。
- **回执。** 回答写进这一行的结果并落盘后，才由 `questionSettled` 给回答的设备回执；落盘失败时回执是结果尚未确认。没人回答的提问记为已结束，Host 停止时这一行带 `interrupted`。
- **选项说明。** `oneOf`/`anyOf` 取值的 `description` 成为选项的说明。
- **自己写的话的栏位。** 选项字段 `<键>` 旁边有一个非必填文字字段 `<键>_custom` 或 `<键>_other` 时（Claude 适配器的 `question_0_custom`、Antigravity 的 `q0_other`：每题后面一个「Other」框），它不另成一题：提问卡的「其他…」写进这个字段，选项留在原字段。
- **Codex 的 `item/tool/requestUserInput`。** 线把它换成同样的表单提问：每题一个字段，标题是 `header：question`，选项与说明照原样；回答按题目 ID 回 `{ answers: { <id>: { answers: [选中的选项或写的话] } } }`，没人回答回空的 `answers`。标为 `isSecret` 的题不经 Latch 收：回答会留在会话记录里，所以直接回空的 `answers`，会话里写一行原因。这一点在核对请求形状之前判断，读不懂的请求里有密码类的题时，它的文字也不写进会话。
- **pi 扩展的 `select`、`input`、`editor`** 见「pi 的 RPC 模式」。

| Harness | 能回答的提问 | 不支持 |
| --- | --- | --- |
| Latch 内置 | `ask_user`：选项、多选、其他 | — |
| Claude Agent | AskUserQuestion（经 `elicitation/create`）：单选、多选、选项说明、Other；MCP 服务器的表单提问 | URL 模式 |
| Codex | `requestUserInput`：选项、选项说明、自己写的话 | 标为密码或密钥的题 |
| Cursor | `cursor/ask_question`：单选、多选 | 只写「其他」：Cursor 只收选项 ID，写的话作为跳过的原因带回 |
| pi | 扩展的 `select`、`input`、`editor`、`confirm` | — |
| 其他 ACP Agent | 表单模式的 `elicitation/create` | URL 模式、超过 10 题或卡片长度 |

所有 Harness 的提问协议都没有附件的位置，所以回答不能带文件；要给文件就在下一条消息里附上。

## 不支持的请求

Latch 只处理 Agent 发来的 `session/request_permission` 与上一节的提问。其他请求（包括未声明的文件系统与终端）与读不懂的询问立刻答复错误（`-32601`、`-32602`），Agent 不会一直等。

- 会话里写一条系统消息与脱敏后的内容（带附件的一轮不写内容，内容最多 2000 字符）；同一轮同一方法只写一次，最多 8 种。
- 运行中的 `TaskSummary.live.unrecognized` 给出次数与时间。它的 `at` 与 `lastEventAt` 用同一时间且不早于已知输出；`lastEventAt` 尚未晚于该请求时会话进「等你处理」。
- 会话尚未建立时只写 Host 日志。

## 持久化与恢复

- 数据在 `<数据目录>/harnesses/<agent-id>/acp.json`，与 Standard 相同的原子写入与锁文件，字段由 `packages/harness-acp/src/store.ts` 的 zod schema 校验。请求回执与用户消息在发送 `session/prompt` 之前写入；用户消息保留 `requestId`。
- Host 重启后，运行中或待审批的会话转为 `interrupted`，不自动重发输入。
- **继续进程已退出的会话。** 先核对启动指纹（含项目配置），再依次尝试 `session/resume`、`session/load`（丢弃重放的历史，Latch 已保存），然后读回权限模式；都不支持时 409 `harness-session-lost`。没有启动指纹记录的会话是 409 `l3-confirmation-missing`。
- **删除会话**删除 Latch 的记录、结束进程并清理临时目录。只有 Agent 声明支持时才调用 `session/delete`，从新到旧：清空过上下文或换过路线的会话，之前的 Agent 会话也一并删除（`earlierSessionIds`），分叉的历史可能引用它分叉自的那一条，先删新的才删得掉。Agent 拒绝删除时只删 Latch 的记录，Host 日志写明它留下了什么与它的原话（脱敏）。
  - Grok Build 不声明 `session/delete`（-32601），但它自己的 `_x.ai/session/delete` 回答 `{ success: true }` 并删掉会话文件夹，没发过消息的也一样（1.0.89 核对）：profile 的 `deleteMethod` 让 Latch 在用 `session/delete` 的地方改用它，包括读模型列表时开的空会话。记下这个能力之前绑定的会话同样删除。经网关的 Grok 会话记录在它私有的家里，随会话删除，不为它启动进程。只剩空的 `<编码的目录>/` 分组文件夹；`session_search.sqlite` 的索引行是否随之清掉没有核对。
  - Cursor 的 ACP 没有删除与关闭：它把每个会话存在 `acp-sessions/<会话 ID>/`（`meta.json` 与 `store.db`，在 `CURSOR_CONFIG_DIR`，否则 `$XDG_CONFIG_HOME/cursor`，否则 `~/.cursor` 下，按定义的变量与 `HOME` 找）。删除 Latch 开的 Cursor 会话时，进程停止后删掉这个文件夹：只限这个会话记下的 ID（单段名字），只在这个根目录正下方、不是链接，且 `meta.json`（schema 1）的 `cwd` 就是会话的目录。接入的会话与别的客户端的会话不碰。依据是 cursor-agent 2026.11.19 包里的代码，没有运行 Cursor 核对。
  - Agent 声明支持时调用 `session/delete`；Qwen Code 不声明，用它自己的 `deleteSession { sessionId, cwd }`（profile 的 `deleteMethod`，它的 VS Code 伴侣也这样删，会一并清掉它挂在会话上的文件）。goose 的子 Agent 会话不随主会话删除，Host 从它的记录里找出来先删（`childSessionsInRecord`）。DeepSeek Harness 没有删除接口，由 Host 删除它的记录（`removesOwnSessions`，不为此启动进程）。清空过上下文的会话，每次清空前的 Agent 会话也一并删除（`earlierSessionIds`）。接入的会话的原会话从不删除。后两项见「CLI 自己的存储」。
- **接入的会话的原会话**默认保留。profile 的 `HistoryImportRule.deletes` 说它的 `session/delete` 删的是 Agent 自己的记录时（Claude 的两条路线），Driver 声明 `historyDelete`、Harness 带 `history.deleteOriginal`，删除对话框给一个默认不勾的「同时删除 … 里的原会话」，只对这一次删除有效。勾选后 `DELETE /tasks/:id?original=1`：Host 先确认会话是原样接入的、Harness 能删，再写审计 `history.original.deleted`（会话与 Harness 的 ID），写不进就不删；然后运行时把原会话 ID 一并交给 `session/delete`。批量删除不提供。
- 进程已退出时，只有项目目录仍在 Host 的项目列表中才会为删除启动进程（Agent 启动时可能运行工作目录里的代码）；否则只删 Latch 的记录，并在 Host 日志里注明。Claude 的直连线删除不起 `claude`，不受这道门限制。Codex 直连例外：删除不开 thread、不读项目，所以在 Host 临时目录的空文件夹里用当前定义起一个进程删除（与「读取」「接入」同样起进程），项目已移除、启动配置或 profile 变了也删得掉；当前定义的 Codex 不认识这个 thread（例如换了 `CODEX_HOME`）时什么也不删。

**分叉。** 由 Host 以一条背景文本加新输入开启新会话，仍是新的启动；ACP 不需要私有分叉方法。pi、Codex 与 Claude 的直连线（`cliStore` 打开时）用它们自己的记录分叉，见各自的小节。

**排队。** Host 队列只在明确的 `runOutcome=completed` 后自动派发。ACP 只有 `session/prompt` 的 `end_turn` 算 completed；取消、输出上限、拒绝、未知 stopReason 与断连都暂停。`PromptOptions.queuedAt` 只作为用户消息的排队时间，不改变输入的幂等哈希与权限。用户从队列追加时，ACP 在写入回执、复核设备授权后核对目标 `runId`。只要轮次换了、停止了或已无法追加，内容就留在队列里。

**附件与文件引用。**

- ACP 附件走 `session/prompt` 的内容块，按本轮运行中的 Agent 在 `initialize` 报告的能力逐个决定（`attachmentDelivery`）：`promptCapabilities.image` 为 true 时图片是 base64 image；`embeddedContext` 为 true 时 256 KiB 以内的文本是带 `latch-attachment:<id>` URI 的 embedded resource。探测缺少字段不代表支持。
- 其余的（PDF、音视频、压缩包、Office、HEIC、二进制，以及 Agent 不原生收的图片和文本）保存为会话附件目录里的文件，提示末尾一个 text 块列出名称、类型、大小与绝对路径，Agent 用自己的工具打开（规则见 [ARCHITECTURE.md](ARCHITECTURE.md#附件)）。所有 ACP 线路都收 text 块，所以没有附件因类型被拒。Agent 输出的图片经 Host 回调存为会话附件。
- 带附件会话的 stderr 不进 Host 日志，RPC 失败也不回显附件。
- 显式 `fileRefs` 由 Host 对固定目录再次验证，ACP 只在本轮模型输入里追加真实目录映射，公开消息保留原文。
- 文件变化只是运行期间的观察，范围与结算见 [ARCHITECTURE.md](ARCHITECTURE.md#改动与文件编辑)。

## CLI 自己的存储

AGENTS.md「CLI 目录与配置」允许读 CLI 自己的目录，只是尽量不做侵入式改动。下面这些读与删都在 `apps/host/src/cli-stores.ts`，只在启动脚本带 `cliStores: { home }` 时有（`AcpAgentOptions.cliStore`）；测试 Host 不带，碰不到真实存储。profile 决定什么时候问哪一项，Host 只认它知道存储的那个预设；回来的只有判断、会话 ID 与摘要。路径按 Agent 实际继承的 `inheritEnv` 值算。

**goose 重新打开会话之前（`loadResumesTurn`）。** goose 没有 `session/resume`，Latch 只能用 `session/load`；会话停在一次工具确认上时，`session/load` 会自己接着那一轮：没答的确认再问一次，已答的照答案处理，然后接着调模型（1.57.0 `load_session.rs`、`resume_state_machine_turn_inner`），这一轮不是在 Latch 里发的。所以每次 `session/load` 之前（恢复与接入共用一处），Host 只读打开 goose 的 `sessions.db`（`GOOSE_PATH_ROOT/data/sessions/`，否则 `XDG_DATA_HOME/goose/sessions/`，否则 `~/.local/share/goose/sessions/`）：

- 从最后一条人看得见、不是工具结果的用户消息起（goose 的 `active_turn_messages`），有确认请求或确认答复而那次调用没有结果，就不打开：409 `harness-resume-pending-tool`。出路在 Latch 里：清空上下文后接着发，开的是新的 goose 会话、不加载旧的（`earlierSessionIds`），或在 goose 里结束那一轮。进程在一次已批准的工具运行中被停掉或崩溃时，记录里那次调用没有结果，也会这样。比 goose 自己的两个条件宽（不看答案是允许还是拒绝）。
- 找不到库或这个会话、库是链接或不属于本人、行读不懂、超过 2 万行或 64 MiB，都按不能打开处理。没有 `cliStores` 时一律不打开：409 `harness-resume-unchecked`。
- 只读：有 `-wal` 时照常经它读（goose 正开着），没有时以 `immutable` 打开，不在人的目录里生出 `-wal`、`-shm`。
- 1.57.0 实测（临时根，不发提示，模型地址不通）：已答允许、没执行的调用，在新进程里 goose 不执行，答「Tool approval expired」并接着这一轮；没答的确认，goose 在加载时重新发 `session/request_permission`，会话还没绑定时 Latch 答取消，goose 记成拒绝并接着这一轮。两种都是 Latch 没发的一轮，所以照样拦。

**goose 会话记录里的 Latch MCP 服务器（`mcpRemoval`）。** goose 把 `session/new`、`session/load` 收到的 `mcpServers` 存进这个会话的扩展列表，人以后在 goose 里恢复这个会话会去启动 Latch 的桥。进程正常停止前，Latch 对每个给过它的服务器发 `_goose/unstable/session/extensions/remove`（只从这个会话的列表里拿掉，1.57.0 实测其他扩展不动），最多等 3 秒，期间不接别的请求。进程崩溃时条目留着，下次打开按名字替换、停止时再拿掉。

**goose 一轮的 tokens。** goose 每次模型调用在 `sessions.db` 的 `usage_ledger` 记一行（会话、到秒的时间、输入含缓存、输出、缓存读写），子 Agent 的在它自己的会话里。一轮结束 1 秒后（`cliStores`，定义的预设是 goose）只读查这个会话、这一轮时间里的行相加；本轮开始的那一秒里有行（可能是上一轮的）、计数不是整数、或一行也没有，就一个数也不写。只进轮次记录，不进会话的 `TurnStats`。

**删除。**

- goose：`sessions.db` 里 `parent_session_id` 指向要删的会话的（任意层），先逐个 `session/delete`，最多 1000 个。读不了就只删主会话。
- DeepSeek Harness：进程停下后删除 `~/.dsh/sessions/<projectKey(cwd)>/<ID>/`（日志与锁）与 `~/.dsh/storages/session_projcache/sessions/<ID>.json`，以及头里 `parentSession` 指向它（任意层）的同目录会话。前提与读 tokens 相同（使用默认或已绑定的目录、它自己的配置说会话存储是原样的、每层目录是本人的真目录），另要日志头的 ID 与目录正是这个会话的。附件按内容去重、可能被别的会话用，不删。只删 Latch 自己开的会话：删除会话时的那些 ID（接入的原会话不在其中），以及读模型列表那次的空会话。

**Qwen Code 的自更新（`selfUpdates`）。** 安装的入口会改去运行 `<QWEN_HOME>/updates/npm/<入口路径 sha256 前 16 位>/active.json` 指的版本（0.27.4 `scripts/cli-entry.js`），所以真正运行的代码可以在两次启动之间换掉而命令路径不变。Host 读这个文件与该版本的 `package.json`，摘要计入 `definitionHash`（`runningCode`）；没有更新时什么也不计入，指纹与以前相同。`QWEN_HOME` 取环境，否则取 `~/.qwen/.env`、`~/.env` 里的那一行（与它自己的顺序相同），文件其余内容不留。更新之后已有会话按「定义已变化」处理，换新会话继续。

## 接入已有会话

用户在 Latch 之外用 CLI 做过的会话，可以经它自己的适配器（Claude 的直连线经 SDK 的会话函数）列出、预览并接入为一个 Latch 会话。接管终端里正开着的会话不做，遇到时拒绝。

**范围与权限。**

- 只对 profile 声明 `historyImport` 的预设开放：Codex（直连经 `thread/list` 与 `thread/read`；经 codex-acp 时 `session/list` 给元数据、`session/load` 重放）、OpenCode 2.x、Claude Agent、Grok Build 1.0.89，以及 Host 有 `cliStore` 时的 pi（都见下）。
- Codex 直连列两次再按 ID 合并、按更新时间倒序：一次不带 `sourceKinds`（Codex 默认的交互来源：终端、编辑器与 app-server 客户端，包括 Latch 自己，以及显式写 `sourceKinds` 时会漏掉的 `atlas`、`chatgpt`），一次 `sourceKinds: ["exec"]`（`codex exec` 跑的会话，只有这样才列得出）。两次都带 `sortKey: "updated_at"` 与 `modelProviders: []`；翻页的游标同时记两次各自的位置。不认 `exec` 的旧 Codex 只给第一次的。
- 运行中的 Agent 没有同时声明 `sessionCapabilities.list` 与 `loadSession` 时返回 409 `history-not-supported`，不发 `session/list`。
- 每一步都要 `run` 与数据范围 `all`，不弹确认。`catalog.features.historyImport` 只对这样的设备出现。
- 接入的会话一律私有（`sessions-meta.json` 的 `imported`），只对数据范围 `all` 的设备可见，分叉出的会话同样私有。
- 审计 `history.list`、`history.preview`、`history.import` 在每一步之前写入，写不进就不做；只含 Harness 与项目 ID、外部会话 ID 的哈希、方式、请求 ID 的哈希与新会话 ID。

**OpenCode 2.x 的规则（`HistoryImportRule`）。**

- 要求 `agentInfo.version` 是 2.x：1.x 没有 `session/list`。
- 它的 `session/load` 与 `session/resume` 会把收到的 `additionalDirectories` 存成会话自己的目录授权，而 Latch 不给 OpenCode 其他文件夹。所以带授权的会话不列出：Driver 只把它们的目录交给 Host（`ExternalSessionList.withheld`），Host 只数出在主文件夹之内的个数（`HistoryList.withheld`）。
- 加载前在同一进程上按会话目录再读一次这一行；仍带授权或已不在列表里时 409 `history-session-changed`，不发 `session/load`。
- 它没有写锁，也不报告会话是否正在别处使用：终端里正开着的会话同样能加载，Latch 不察觉；预览带 `useUnknown` 说明这一点。
- 接入之后在别处给这个会话加的目录授权，会在 Latch 下一次恢复它时被去掉。预览结束时的 `session/close` 只让 OpenCode 丢弃从未发过消息的新会话，不动加载的会话。
- 直连时列出是 `GET /api/session`（`directory`、倒序、每页 100），载入按 `GET /api/session/:id/message` 重放，授权读写与适配器相同；`opencode acp` 建的会话在直连上载入并重放已用真实 2.2.6 核对。
- 列表行确实带回 `permissions` 与 `metadata["opencode.acp.additionalDirectories"]`：照 Latch 的写法 `PATCH` 后用真实 2.2.6 读过。另一个前提关不上：再读一行与 `session/load` 之间没有别的客户端加授权（ACP 没有带条件的加载）。

**pi（`pi-store.ts`）。** pi 的 RPC 没有列出会话的命令，pi 自己列出时会建目录、打开时会往文件里写（缺思考条目时补一条、旧格式整份重写、补末尾换行），所以列出与预览都是 Latch 自己有界地读 pi 的文件，不起 pi、不调 pi 的任何代码；只有接入后的第一轮才在 pi 里 `switch_session`。

- **只在启动脚本给了 `cliStore`（人的主目录）时**：测试 Host 没有它，Driver 不声明 `historyImport`，什么都不读。
- **会话在哪。** 按 Latch 启动 pi 时给的环境（`agentEnvironment`）：`PI_CODING_AGENT_SESSION_DIR`，否则全局 `settings.json` 的 `sessionDir`（只取这一项，两者都是平铺目录），否则 `<PI_CODING_AGENT_DIR 或 ~/.pi/agent>/sessions/--<目录编码>--/`。项目自己 `.pi/settings.json` 指的目录不找。`PI_CODING_AGENT_SESSION_DIR` 进了 pi 的 `inheritEnv`（profile 版本 8），终端里设了它的人，Latch 启动的 pi 写到同一处。
- **怎么读。** 默认布局只打开名字像项目主文件夹（或其下目录）的目录；编码有损（`/a-b/c` 与 `/a/b-c` 同名），所以由每个文件头的 `cwd` 决定。只读本人的真目录与本人的普通文件（不跟随链接）、名字是 pi 的、文件头 `version` 为 3 且 `id` 与名字相同；最多 2,000 个目录、5,000 个文件。标题按 pi 的规则：最新的 `session_info.name`，否则第一条人的消息（只读文件头尾各 256 KiB），时间是文件的修改时间。读不建目录、不改任何文件（`pi-store.test.ts` 比对前后的大小与修改时间）。
- **预览。** 整份读（64 MiB、单行 16 MiB 内），从最后一条沿 `parentId` 取 pi 当前的分支：人和模型的文字，工具只有名字与结束状态，思考与工具输出不留。再走与其他 Harness 相同的重放、遮密钥与上限。文件头的 `cwd` 必须是请求的目录。
- **接入。** 再读一次文件头，`cwd` 的真实路径必须是核对过的会话目录，然后只记录；第一轮照常 `session/resume`，线在 `switch_session` 前再核对一次（见「pi 的 RPC 模式」）。pi 没有锁，预览带 `useUnknown`。旧格式（v1、v2）的文件不列出：打开会被 pi 整份重写。

**Claude Agent 的规则。**

- 两条路线算同一份存储：`Bridge.historyStore` 是 Claude 配置目录（绑定的账号目录优先，否则取 Host 环境或登录 shell 的 `CLAUDE_CONFIG_DIR`，缺省 `~/.claude`）真实路径的哈希，同一会话不会经两条路线各接入一次。
- 适配器 0.99 起的 0.x（`agentInfo.version`）：它自己的 `session/list`、`session/load` 与 `session/delete`，0.101 的源码核对过。它列出 SDK 启动的会话；Latch 自己的会话照常由「Latch 会话用过的不列出」去掉。
- 直连线只在 `cliStore` 打开时：`session/list` 是 `listSessions({ includeProgrammatic: false })`，与终端的 `/resume` 一样不列 SDK 启动的会话（Latch 直连开始的、分叉出的都是 `sdk-ts`）；标题是 Claude 的自定义标题、自动标题或第一条提示。`session/load` 先查 Claude 的注册表（`<配置目录>/sessions/<pid>.json`，进程活着且启动时间吻合，`.key` 文件从不打开），被别的 `claude` 开着时回答 busy，Host 给 409 `history-session-busy`；再 `getSessionMessages` 重放，然后照常 `resume` 原会话——接入续写原会话，与 Codex 相同。
- 重放：人的文字（去掉 Claude Code 的命令标记与 `<system-reminder>`；它自己回答的 `/compact`、`/model`、`/mcp` 等整条不显示，别的命令写成 `/名字 参数`）、Claude 的文字、工具调用与结果（标题照工具行）。不重放：Claude 自己加的说明（`isMeta`）、压缩摘要、`<synthetic>` 的登录与限额提示、思考、图片的字节、子 Agent 里面的消息（只有 Agent 调用与它的结果）。`getSessionMessages` 只给最后一次压缩之后的部分，压缩之前的只在 Claude 里。
- 它没有写锁：接入时没开着的会话，之后仍可在终端里打开，预览带 `useUnknown`。

**Grok Build 1.0.89 的规则。**

- 版本取它 `initialize._meta.agentVersion`（它不报告 `agentInfo`，profile 的 `versionInMeta`），只认 1.0.89：别的版本在列出前返回 409 `history-not-supported`。
- `session/list` 不带目录时列出所有目录的会话（`sessionId`、`cwd`、`title`、`updatedAt`），没发过消息的不列；`session/load` 按会话的 `updates.jsonl` 重放，每条带 `_meta.isReplay`。这是在临时 `GROK_HOME` 里对照手写的会话核对的（`grok.live.test.ts`），没有读它的源码，也没有用人自己的会话核对。
- 载入按记录重放，停在计划模式的会话回来仍在计划模式（核对过）；Latch 读不回 Grok 的其他档位，所以接入后它可能比 Latch 显示的更严。always-approve 是否随会话保存没有核对（要发提示）。
- 它不报告会话是否正在别处使用，也没有 Latch 看得见的锁：终端里正开着的会话同样能载入，预览带 `useUnknown`。`grok sessions list --all` 另查云端会话，ACP 列表只有本机的。
- 列出用人自己的登录启动（经网关的私有家里没有人的会话）。接入的原会话从不删除；之后在 Latch 里开的会话删除时经 `_x.ai/session/delete` 删除（见「持久化与恢复」）。

**步骤。**

| 步骤 | 接口 | 做什么 |
| --- | --- | --- |
| 列出 | `POST /history/list { projectId, harnessId }` | 在数据目录下 0700 的私有空文件夹里起一个进程，只发 `initialize` 与 `session/list`（不带 `cwd`），最多 500 条或 20 秒，然后停掉进程、删掉文件夹。不加载任何内容 |
| 预览 | `POST /history/previews { handle }` | 在会话自己的目录起一个进程，照常核对项目配置与启动指纹，`mcpServers` 为空，`session/load`（60 秒）。从不发 `session/prompt` |
| 接入 | `POST /history/imports { requestId, previewId \| handle, harnessId? }` | 先写审计与 `history-imports.json` 的回执，再做任何事 |

- **列出的过滤。** Host 按真实路径过滤：在项目主文件夹或它下面开始的会话返回（标题经 `redactSecrets`、最多 200 字符），最多 50 行、按更新时间倒序；在项目其他文件夹里的只给数量 `otherFolders`；项目之外的不返回、不计数。任何 Latch 会话用过的 Agent 会话不列出；已接入的带 `importedTaskId`。每行一个不透明句柄，只对这台设备、10 分钟有效。
- **预览的内容。** 重放留在 Host 内存里（最新的 5,000 条或 8 MiB）。返回最后 40 条消息与工具调用，每条最多 4 KiB，整个响应最多 256 KiB；工具只有标题与状态（`outputHidden`），思考不保留，所有文字经 `redactSecrets`。
- **预览的生命。** Agent 说会话在别处打开时 409 `history-session-busy`，不重试、不抢。每台设备同时只有一个预览：关闭（`DELETE /history/previews/:id`）、10 分钟后或新开一个时 `session/close` 并停掉进程。
- **接入的幂等。** 同一 `requestId` 的重试（Host 重启之后也是）完成或回答同一次接入；`GET /history/imports/:requestId` 查回执（未完成时 202）。完成的回执只留 ID。确定失败时回滚 Latch 的记录与回执。
- **只能接入一次。** 同一个外部会话的另一个请求得到 409 `history-already-imported` 与 `taskId`；同一来源的接入串行。「同一个」按 Driver 报告的记录身份（`Bridge.historyStore`）加外部会话 ID：ACP 不报告 Agent 读的是哪份存储，所以按命令解析出的真实路径算，运行同一适配器的两个定义算同一份。
- **接入时重做**目录检查（会话目录仍在主文件夹之内，否则 `history-outside-project`）与启动指纹。

**原样接入**（继续用来源 Harness，默认）。

- Host 先选好会话 ID 并把 `imported` 写进 `sessions-meta.json`，会话从存在起就是私有的。Driver 关掉预览进程后记录会话：`acp.json` 记 `imported.agentSessionId`，历史是重放的最新 500 条或 4 MiB，每条带 `imported: true`。
- 之后照常 `session/resume` 或 `session/load`；第一轮前设回 Latch 的预期模式并读回，不沿用原会话的权限。
- 会话的 `cwd` 是核对过的真实路径，Agent 从不经符号链接拿到目录。每次启动、恢复与输入都要求它不变且仍在主文件夹的真实路径之内，否则 409 `workspace-changed`。
- 重放的文字在整条消息拼好后才经 `redactSecrets`，分块到达的密钥也被替换。

**按文字重建。** 选了另一个 Harness，或原样接入的会话之后得到 `harness-session-lost` 时（`{ requestId, fromTaskId, harnessId? }`）。

- 用分叉的种子：只取用户与 Agent 的文字，不含工具输出、思考与压缩，经 `redactSecrets`，保留最后 20 万字符。
- 新会话照常走启动与审计，但不开始一轮：它等用户的第一条消息（`CreateTaskInput.seed`，Driver 声明 `seededStart`），发出时才把这段文字作为消息的开头一起发给模型服务（`TaskSummary.imported.mode` 为 `text`，`prefixLength` 是它的长度）。第一条消息清空上下文时不带这段文字。
- 只能重建到 ACP Harness；内置 Harness 返回 409 `history-not-supported`。同一来源仍只能接入一次。
- 原来的会话之后只能查看（`TaskSummary.imported.fromTaskId` 指回它的会话存在时）。

**界面。**

- 「接入已有会话」只在所选的已保存项目里有可列出会话的就绪 Harness（`HarnessInfo.history.list`）且设备有 `run` 时出现；数据范围不是 `all` 的设备看到上锁的同一行。
- 选来源以外的就绪 Harness（`HarnessInfo.history.rebuild`）就是按文字重建，界面写明不是原样恢复。
- 没有答复时写结果未确认，并用同一 `requestId` 重试；409 `history-already-imported` 直接打开那个会话。
- 文字重建的会话在第一条消息发出前写明这段文字会一起发给模型服务；之后它在第一条消息里折叠显示（`Message.importContext`，Host 按 `prefixLength` 标注）。
- **iPhone/iPad** 用同样的条件与请求（判断在 `PhoneHistory`）。列表与预览在正文窗口内读取、不存盘。接入与按文字重建是持久的待确认写入，只用同一请求重试、不自动重放；手机同时只留一个待确认写入。离开预览即关闭它；还有未确认接入引用的预览不关。`history-handle-expired` 说明没有接入，`task-deleted` 说明接入过而会话后来被删除。

**尚未实现。**

- 接入后又在终端里继续了同一会话时 Latch 不察觉。
- 项目其他文件夹里的会话只给数量。
- pi：项目 `.pi/settings.json` 另指的会话目录不找；v1、v2 格式的会话不列出。
- OpenCode 1.x：ACP 没有 `session/list`。
- Qwen Code、goose：源码声明了列出与加载，但加载对原会话的影响（恢复旧模式、写回设置等）没有读完，也没有用真实程序核对。
- Antigravity：没有核对。Cursor 不开放。
- Claude：压缩之前的历史不带上（要按原始条目自己接回，未做）；子 Agent 里面的消息不重放。
- iPhone/iPad 的列表与预览不显示「未列出」的数量与「看不出是否在别处使用」；停止行没有「在新会话中继续」。

## 会话命令

命令由当前会话的 Harness 报告，也可以在会话中更新。发送 Harness 命令时，Latch 保留命令原文，ACP Harness 通过普通的 `session/prompt` 接收它。[ACP v1 会话命令规范](https://agentclientprotocol.com/protocol/v1/slash-commands)

**当前会话。**

- Harness 可以在创建或恢复会话时报告命令（`available_commands_update`、会话响应的 `availableCommands`，或 Grok Build `initialize._meta.availableCommands`），也可以在运行中更新。Latch 在等待会话建立时暂存 `available_commands_update` 与技能报告，拿到会话标识后采用这个会话最后一份有效报告。命令随 `TaskDetail.commands` 发给客户端并持久化，空列表撤下旧命令。恢复时重放的聊天内容仍由已有历史提供。
- 每份 ACP 报告按顺序检查至多 400 项，取前 200 条可公开的命令。名称最多 100 字符，不能含空白或控制字符，允许冒号；名称畸形时整份报告丢弃并保留上一份报告。说明与输入提示先脱敏再分别截断到 1000 与 500 字符（空值省略），超长说明不会丢弃整份命令列表。
- Harness 把本机 MCP 提示报告为 `mcp:服务器:提示` 一类的命令时，列在它的普通命令组里，发送时保留名称（见 [MCP.md](MCP.md#提示)）。
- 点按与 Tab 只把命令插入草稿；键盘 Enter 的条件见 [DESIGN.md](DESIGN.md)。
- Codex、pi、OpenCode 与 Claude 的直连在打开或恢复会话时就提供已知命令。打开输入框里的菜单只读已有目录。公开命令取决于接入方式和项目，比如 Codex 直连提供 `/compact`，pi 还会列出本项目加载的扩展命令。
- 带 `idleOnly` 的命令在运行中置灰；排队、把排队的消息改成它或追加时 Host 以 409 `command-queued` 拒绝。

**草稿目录（开始前）。**

- 新会话优先读同项目、同真实目录身份、同启动指纹下上次真实会话报告的命令目录（`source=previous-session`，含项目扩展命令），未命中或来源对当前设备不可见时回退到该 Harness 定义在私有空目录读取到的自身命令目录（`source=harness`）。项目缓存是数据目录里的 `harness-commands.json`（0600，最多 64 份、2 MiB），定义自身命令随 `acp.json`（`ownCommands`）按 `definitionHash` 保存，均原子写入；空报告有别于未报告。
- `POST /agents/:id/commands` 只读已保存的缓存与定义级目录，自身从不启动或探测 CLI，也不读 CLI 自有存储；目录只是建议，不授予执行能力，也不给当前结构化调用提供路径。还没有任何目录且当前定义尚未核对过自身命令时，打开草稿 `/` 菜单走统一的 `POST /agents/:id/catalogue` 按需读取一次。
- `POST /agents/:id/commands` 接受正常开始会话的选择项，不接受任意 cwd；要 `view`。命中 `previous-session` 时异步查找后复查设备、项目、来源可见性、真实目录与完整启动指纹；新工作树、独立会话文件夹没有现成项目目录，或上次会话已转为私有时，只返回公开的 `source=harness` 目录，不创建目录、不泄露私有会话命令。
- 响应只有 `commands`、`reportedAt`、`source`（`previous-session` 或 `harness`）与可选的 `skills`、`skillsTruncated`。删除来源、改变启动配置或失去来源权限后不再返回该来源的项目缓存；定义变化后旧的 `harness` 目录作废。
- `HarnessInfo.commandCatalogue`（每次挂载 Driver 生成 `generation`，带可选的 `checked` 与 `reportedAt`）与 `TaskSummary.commandsVersion`（每次会话命令报告后更新）驱动客户端失效与重读。可见集合或选择改变时页面立即撤下旧结果并取消在途查询，迟到的响应不回填。
- 可见草稿每 30 秒只读重验，后台暂停。没有公开通知的 public→private 变化可能让之前的公开提示保留到下次重验；HTTP 每次仍重新授权。

**Codex 直连。**

- 声明 `/compact`，用 `thread/compact/start` 执行，不接受参数或附件。立即的 RPC 回答不是完成：手动压缩以对应 `turn/completed` 结算，取消用 `turn/interrupt` 并等真实结算。自动压缩以自身的 `item/completed` 为成功证据；普通一轮结束却缺少它时显示结果未知。
- 原生 compact 没有每轮的模型、思考或权限覆盖。执行前按 `thread/resume` 的实际读回核对 thread、目录、模型、思考、完整沙箱与审批策略；缺项、未知或非空的 `activePermissionProfile` 都拒绝。改过配置时先由普通消息应用，不发空轮次代替。
- 原生 `/review` 尚未接入（它会改变询问行为，并可能用独立的审阅模型）：直接输入或追加时拒绝，不调用 `review/start`，也不转成普通提示。

**pi。** 打开或加载会话时用 `get_commands`，只采用实际报告的 extension、prompt 与 skill。公开列表有界，去掉路径、`sourceInfo` 与私有权限扩展的命令。扩展与原生 compact 只在空闲时执行；提示模板与技能可以在追加时由 pi 展开。pi 自己报告 `/mcp` 不表示 Latch 能向它注入 MCP。

**人物 brief。** 线的 `commandsWithoutContext` 区分必须保留原生前缀的命令。只有完整首词与线确认的命令集合一致时才省略本次的人物 brief，下一条普通消息继续携带它；未知名字或读取目录失败时不省略。

**原生技能。**

- `TaskDetail.skills` 与 `HarnessCommandCatalogue.skills` 只有公开的 `name`、精确的 `invocation`、可选 `description` 与已知 `scope`，不含路径、正文或 `sourceInfo`。目录最多 200 项、64 KiB；先保名称，再分配说明。名称或数量超限时 `skillsTruncated: true`。Host 再次校验字段与预算。
- Codex 的 `$name` 不放进斜杠命令；pi 的 `/skill:name` 保留在 `commands` 里，已列为技能的不重复显示。Web 把技能放在技能组，点按、Tab、Enter 都只插入草稿；最近选择按 Harness 隔离。输入框与已发送的消息按同一规则把目录里的技能画成块（`apps/web/src/composer/prompt-tokens.ts`），线不附加的写法不画；发送的仍是原文。
- **Codex 的目录。** 开 thread 或恢复时以实际 cwd 调用 `skills/list {cwds:[cwd],forceReload:true}`。原生路径只留在当前线的 enabled 映射里，不从客户端或提示内容接收路径。`skills/changed` 立即清空映射并重读，旧代次的回答不得恢复旧路径。读取失败或目录不完整时撤下当前目录，错误里的私有路径不外发。
- **Codex 的调用。** Host 在加人物 brief、文件引用、撤销说明、seed 与历史之前保留本轮原文，只经内部调用上下文传给线，不接受公共 HTTP 的来源声明。线只从这份原文里完整的、空白分隔的 `$name` 匹配官方清单，补充 `{type:'skill',name,path}`；原文照常发送。未知、带前后缀、转义或引号包围的名字保持文字；同名的 enabled 项明确拒绝。没有原文证据时不扫描完整 prompt 兜底。这只限定 Latch 生成的结构化项，不限制 CLI 或模型自己的行为。

## 扩展

「设置 › 扩展」（`admin`，与「Harness」「MCP」相同）按 Harness 列出技能、命令、MCP 与插件。「Harness 自带」和「Latch 提供」各用一处标题标明来源。

- `GET /extensions` 给每个外部 Harness 当前定义下最新一份普通会话的报告（`Bridge.latestCommandReport`），附报告时间与项目。Host 在会话创建后登记普通来源，等待登记结束才收报告。我的 Agent、通用、导入、定时及归属未登记的会话不能成为来源。
- `harness-extensions.json` 在 Driver 的数据目录里按普通会话各保留最新一份报告（0600，最多 64 份、2 MiB，原子写入）。同一目录下可有多个普通来源。删除来源、把来源变为私有或项目不可用时，查找下一份有效的普通报告。读取与发送前核对 Driver、来源、项目和实际目录身份（设备号与 inode）。在同一路径重建目录后不沿用旧报告。
- 扩展页从升级后登记的普通会话开始收录。用想查看的 Harness 新建普通会话并发送消息，收到报告后这里会更新。
- 页面根据 Driver 代次、可见会话的报告版本和项目状态撤下旧记录并取消在途读取。页面可见时每 30 秒复查一次，以发现没有通知的目录变化。读取只用 Latch 的缓存，不启动 CLI。
- Harness 自己的 MCP 来自 `HarnessInfo.ownMcp`。「读取」只在人按下时启动 Harness。Codex 直连的同一份报告带它会运行的钩子，列在 MCP 下的「钩子」组：何时运行、来自哪里、是否受管理策略强制、停用或未信任，不显示命令。

Host 经 `HarnessInfo.extensionSupport` 给出当前适配器能报告的类别与插件清单不可用的原因。报告为空会明确显示。支持报告且还没有普通会话的类别显示「还没有会话报告」。有普通会话报告但这项未读到时显示「上次会话没有读到」。当前适配器没有报告的类别显示「这个 Harness 没有报告」。

| Harness | 报告 |
| --- | --- |
| Codex 直连 | 命令（`/compact`）、技能（`skills/list`）、MCP（`mcpServerStatus/list`）、钩子（`hooks/list`） |
| pi | 命令、技能与注册过命令的扩展（`get_commands`） |
| DeepSeek Harness、Cursor SDK 直连 | 当前接入方式没有命令目录。Cursor 通过 `cursor-agent acp` 连接时可接收 ACP 命令报告 |
| 其他 ACP Harness（含 Codex ACP） | 收到的命令（`available_commands_update`）。有些 Harness 把技能作为命令报告 |

**pi 的插件一栏。** 按 `sourceInfo` 聚合扩展命令，显示包或扩展目录的最后一段，独立文件显示文件名去掉代码后缀。精确排除 Latch 的权限扩展，也略过 pi 内置扩展。不同来源同名时省略该名称并标出清单不完整。最多 200 个名称，每个最多 200 字符。完整路径和安装来源只参与线内归组。清理后的名称只进入普通会话的扩展报告。空报告表示没有扩展命令。

**Codex 直连的插件清单尚未实现。** Codex 0.169.0 的 `plugin/installed` 会尝试同步账号已装插件，可能下载或更新本机插件包。这个版本的协议没有纯读取清单的接口。Codex 自己启动时亦可能同步，清单请求可以再触发一次。ACP 适配器没有插件报告。[Codex 0.169.0 的清单处理](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/app-server/src/request_processors/plugins.rs#L847)

**安装、更新、卸载。** `HARNESS_EXTENSIONS`（`packages/protocol/src/extensions.ts`）记录厂商文档或 CLI 帮助给出的命令。命令经「在终端里打开」填进 Latch 的终端（只填不执行），由人补全参数后按回车。Codex 卸载须指定市场和插件，pi 卸载须指定原安装来源。名称只用于显示。MCP 的单项卸载命令只接受 `namedExtensionCommand` 校验过的名称。没有文档化命令时，悬停可查看原因。

**Latch 提供的。** 都是数据：我的 Agent 的技能与「操控这台 Mac」的规则经 `latch-skills`；预览浏览器的工具经 `latch-browser`（桌面端开着时）；Latch 的 MCP 服务器经会话的 `mcpServers`（Codex 为线程配置），只给 `HarnessInfo.skills === 'server'` 的 Harness；提示词模板由 Latch 填进输入框（全部 Harness 的与只给这个 Harness 的）；数据插件（技能与数据面板）与页面在 Latch 里，不交给 Harness。含代码的插件（工具、面板模块、模型、Harness、连接）只在折叠的「这台 Mac 上的开发者」里，标「可信的本地代码」，不隔离。Latch 内置的插件（项目文件、演示的工具与模型，`PluginInfo.builtIn`）不列。Latch 自己的 MCP 与插件仍在「设置 › MCP」「设置 › 插件」里管理，改动照旧本机确认；「设置 › MCP」与 Harness 页只留一行通往「扩展」。

## 错误

本文其他章节给出的错误码不在此重复。

| 代码 | 含义 |
| --- | --- |
| `mode-unsupported`（400） | ACP Agent 只支持 Agent 模式 |
| `agent-env-reserved`（400） | 定义设置了由 Latch 管理的环境变量 |
| `agent-args-reserved`（400） | 定义的参数里有由线决定的参数（Codex、pi）；Claude 直连的定义不能带任何参数 |
| `approval-option-hidden`（400） | 该选项会持久保存授权，Latch 不提供 |
| `workspace-unavailable`（400） | 工作目录不是 Host 登记的项目目录，或所选项目的文件夹与登记的不一致 |
| `l3-confirmation-missing`（409） | 会话没有启动指纹的记录 |
| `agent-definition-changed`（409） | 定义或解析出的命令已变化 |
| `project-config-changed`（409） | 计入启动指纹的项目配置在会话启动后变了 |
| `permission-unverified`（409） | 无法确认 Agent 已进入预期模式，本轮未发送 |
| `permission-drift`（409） | 检测到权限模式漂移，会话不再接收输入 |
| `harness-version-unsupported`（409） | 版本规则不匹配，或低于版本门槛 |
| `workspace-changed`（409） | 会话使用的文件夹已不在项目中、被替换或找不到，或项目已不在列表中 |
| `agent-auth-required`（409） | Agent 要求登录 |
| `harness-session-lost`（409） | Agent 无法恢复该会话 |
| `harness-no-login`（404） | Latch 不知道这个 Harness 的登录命令 |
| `terminal-open-failed`（502） | 没有打开终端 |
| `not-supported`（501） | Agent 不支持修改该选项 |
| `agent-not-found`、`agent-start-failed`、`agent-paused`、`agent-busy`、`agent-exited`（503） | 命令缺失、启动失败、连续崩溃后暂停、同时运行的进程过多、进程已退出或正在停止 |
| `agent-handshake-timeout`（504） | `initialize`（30 秒）、建立会话（60 秒）或握手之后的启动设置（如经 Latch 使用模型服务时的 `providers/list`，120 秒）没有回答；Latch 等进程真实退出后这一轮才失败 |
| `agent-timeout`（504） | Agent 长时间没有响应其他设置请求（120 秒） |

## 尚未实现

| 项目 | 原因 |
| --- | --- |
| 操作系统沙箱、Agent 出站代理 | 因此 ACP 会话固定为 L3，Agent 自己的文件与网络访问不受 Latch 约束 |
| 中和项目配置（如启动前屏蔽 `.opencode` 插件） | Latch 只把项目配置计入启动指纹 |
| 托管安装 Agent | 预设只使用本机已安装的命令 |
| macOS 以外的 Host 打开登录终端 | 只显示命令 |
| OpenCode 2.x 的私有子会话通道 | Latch 不声明 `opencode/child-session-updates`，改读发在启动会话上的更新（见「子 Agent」） |
| OpenCode 1.x 的子 Agent | 1.x 的 ACP 不回答子会话的权限请求，`task` 保持禁用 |
| OpenCode 2.x 经 `opencode acp` 在后来的一轮里继续的子 Agent 的请求 | OpenCode 的 ACP 不转发，这一轮会一直等到停止；直连转发同一进程里见过的子会话 |
| 单独停止没有宣告 `capabilities.cancel` 的子 Agent | ACP 不允许。OpenCode 2.x 不宣告：它的后台子 Agent 在一轮结束或停止后仍可能继续，直到空闲进程被结束 |
| 让启动子 Agent 的 Agent 回答子 Agent 的请求 | ACP 没有把客户端收到的权限请求交给另一个 Agent 回答的方法 |
| goose 的运行中追加 | 它的私有方法要 goose 自己的运行标识，也没有声明字段，未经真实核对 |
| 按会话放行 OpenCode 访问其他文件夹 | 需要按会话改变 OpenCode 的配置并提高 profile 版本；2.x 的 ACP 字段尚未使用 |
| Claude Agent 的其他文件夹（`additionalDirectories`） | Claude 访问会话目录以外的路径时逐次询问 |
| ACP 的原生分叉（`session/fork`） | `session/fork` 只能分叉整个会话；Claude 适配器按某一条分叉只认另一个客户端的私有 `_meta`，`resumeSessionAt` 也不对客户端开放。pi、Codex 与 Claude 直连线以外的分叉都用背景文本 |
| 「从这里编辑」原地回退 Harness 的上下文 | Codex 0.169 有 `thread/revert`，但 Latch 的会话记录是会话的权威，原地回退会让记录与 Harness 的记忆分开。编辑都从那一条之前分叉，原会话不动（[STREAMING.md](STREAMING.md#从这里编辑)） |
| 编辑 Harness 的计划 | Claude、Cursor 的 ACP 都没有这个回答 |
| 回答提问时附文件 | 没有哪个 Harness 的提问协议能收文件 |
| 只有主文件夹的 Codex 会话把 `.agents/skills/` 计入启动指纹 | 原生技能目录读取已接入，指纹范围没有扩展 |
| iOS 的原生技能选择菜单 | iOS 仍可手动输入原生调用文字 |
| Codex 的 `/review` | 见「会话命令」 |
| Qwen Code、goose、Grok Build 去掉「实验性」，以及清理工具子进程里的网关凭据 | 见「经 Latch 使用模型服务」 |
| Qwen Code 经 Latch 时的思考档位与子 Agent | 思考只提供它自己经 ACP 报告的选项；子 Agent 关掉，直到 Qwen Code 能把子 Agent 的模型限制在指定的服务上 |
| goose 固定 `delegate` 子 Agent 的服务 | goose 没有文档化的设置能固定或关掉它 |
| Antigravity、Cursor 经 Latch 使用模型服务 | Cursor 做不了：推理走它的后端。Antigravity 有 Gemini API key 路线（见「经 Latch 使用模型服务」），要先有网关的 Gemini 协议，地址是否生效未核对 |
| Antigravity 接入已有会话 | 有内容的会话要发提示才造得出，列出与加载没有核对 |
| Grok Build 的权限档位菜单 | 1.0.89 的 ACP 不报告模式；`plan` 能设能读回，`auto` 与 always-approve 只能在建会话、载入或恢复时经 `_meta` 设，设了读不回。要做成「重启并恢复会话」的启动设置，运行时还没有为不报告模式的 Harness 合成档位的路径 |
| Grok Build 的扩展页（`grok inspect --json` 的 MCP、技能、插件与钩子） | 没有接：它不开会话就能列出，但 MCP 的 `target` 可能带令牌，要先定脱敏；没有核对它在人自己的家里的耗时 |
| Grok Build 记住的回答的内容 | `permission*.toml` 的格式没有文档，只说有没有 |
| Cursor 的登录状态 | `cursor-agent status --format json` 的输出形状只读过源码，没有运行过，不做 |
| Cursor 的真实验收 | 权限档位只按文档接线；SDK 路线只用假 SDK 模块测过，从未连过 Cursor |
| Cursor SDK 路线的逐次询问 | SDK 没有逐次审批的回调；1.3.1 的类型里有替换工具执行器的 `resourceProviderOptions.override*Executor`，文档没写、接口只按形状给出，不拿来做审批；文件钩子要写 `.cursor/hooks.json`，违反「不修改原 CLI 配置」 |
| Cursor SDK 路线的 Auto-review 档 | `local.autoReview` 在后端没有分类器时悄悄退回默认行为（文档写明不是安全边界），给不出真实的档位 |
| 只装 SDK、不装 `cursor-agent` 的 Cursor | SDK 路线仍以 Cursor 预设的定义（`cursor-agent acp`）为入口，启动前的命令检查照旧要找到 `cursor-agent`，虽然这条路线不运行它 |
| 桌面安装包里的 Cursor SDK 路线 | 打包的 Host 不带 `node_modules`，找不到 `@cursor/sdk` 时走 `cursor-agent acp`；SDK 是专有许可，是否随包分发未定 |
| 关掉 Cursor SDK 的使用统计 | 没有文档化的开关，见「Cursor 的 SDK 路线」 |
| Cursor SDK 路线的项目其他文件夹、接入已有会话与分叉 | 没有接线：只给主文件夹，分叉用背景文本 |
| Cursor SDK 路线在 Host 重启后恢复会话 | agent 的记录在会话私有临时目录，Host 停止时随运行目录删除；要放到数据目录还得接上删除会话时的清理 |
| Cursor SDK 路线只读档里的 Latch MCP 服务器（技能、浏览器、桥） | 只读档不给 `mcp`，否则 MCP 工具不受只读约束 |
| Claude 适配器路线第一轮前的额度 | 适配器只在每轮模型回答后的限额事件里报告；它的 `/usage` 要开一个 Claude 会话并发提示，Latch 不发。直连线见「Claude 的 Agent SDK 线」 |
| Codex 按模型的额度桶 | 只显示套餐自己的桶 |
| Cursor、OpenCode、Qwen Code、goose、pi 的额度 | 程序不报告；没有可用的官方接口与凭据，见「DeepSeek Harness 的余额」。OpenCode 2.x 有 `GET /api/experimental/usage/limits`，只覆盖 OpenCode Console/Go 账号，登录后的形状没有核对 |
| pi 接收 Latch 的 MCP 与技能 | pi 0.99 起内置 MCP，Latch 的私有扩展可用 `pi.registerMcpServer` 只为当前会话登记；需要 0.99 的单独门槛，没有用真实 pi 核对 |
| OpenCode 删除后的核对 | `DELETE /api/session/:id` 失败时仍不提示；进程不在时为删除起一个服务 |
| DeepSeek Harness 用 DeepSeek 账号登录时的余额 | 没有文档化的余额接口 |
| Qwen Code、goose、DeepSeek Harness 的登录状态 | 仍是「未知」：Qwen 的 `qwen/status/workspace/preflight` 与 goose 的 `_goose/unstable/providers/config/status` 都要在 `initialize` 之后发扩展请求，探测现在只做 `initialize` |
| 权限菜单写出这些 CLI 自己的设置 | Qwen 不信任文件夹时设不上的档位与 `permissions.allow` 规则数、goose `permission.yaml` 的总是允许、DeepSeek Harness 被改过的权限预设：读法已查清，菜单尚未接上 |
| Qwen Code、DeepSeek Harness、goose 接入已有会话 | Qwen 的列出要带每个文件夹的 `cwd`、判忙要读它的 `sessions/<pid>.json`；dsh 没有 `session/load`，要从日志预览再 `session/resume`；goose 加载会写回原会话并启动人的扩展。都没有用真实程序核对 |
| 进程崩溃后 goose 会话记录里留下的 Latch MCP 条目 | 只在正常停止前拿掉；下次打开按名字替换 |

## 测试

命令、假 Agent（`fake-acp-agent.mjs`、`fake-codex-app-server.mjs`、`fake-pi-agent.mjs`）、回放与需要显式开启的真实程序用例见 [TESTING.md](TESTING.md)。本包运行 `pnpm test --project @latch/harness-acp`。

- 默认测试不启动真实 Agent；预设的权限配置经 `presetId` 套用到假 Agent 上测试。
- 假 Agent 的网关模式（`FAKE_ACP_GATEWAY`）与回放是照各程序的源码与文档写的，不是真实程序的录制：它们不证明真实 CLI 的行为。
- 「不修改原 CLI 配置」的回归用临时 HOME、项目与假 Agent 核对原配置与 hooks 哨兵文件不变；真实 CLI 的行为要单列证据。
