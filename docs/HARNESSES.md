---
description: 经 ACP 或 pi 的 RPC 模式接入外部 Agent：完全访问（L3）、使用、预设的权限配置、项目配置、项目的多个文件夹、启动诊断、进程、映射、审批、取消、持久化与恢复、错误与测试。
sources:
  - packages/harness-acp/src
  - packages/protocol/src/agent-presets.ts
  - apps/host/src/hub.ts
---
# 接入外部 Harness（ACP）

Latch 用 [Agent Client Protocol](https://agentclientprotocol.com)（ACP v1）驱动外部 Agent；Agent 自己有官方的机器协议时直连它（见「直连优先」）：Codex 用它的 app-server，pi 用它的 RPC 模式。每个启用的 Agent 定义成为一个 HarnessDriver，与内置 `standard` 并列出现在新会话的 Harness 选择器中。实现是包 `@latch/harness-acp`（`packages/harness-acp/`，只有 Host 依赖它）；浏览器可见的预设（命令、参数、许可证、安装提示）位于 `packages/protocol/src/agent-presets.ts`，只在 Host 上使用的权限配置位于 `packages/harness-acp/src/profiles/`（每个预设一个文件）。整体架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 权限级别：完全访问（L3）

ACP Agent 是本机运行的可信代码，Latch 不给它加操作系统沙箱，也不代理它的网络。因此每个 ACP 会话都是完全访问（L3）：

- Agent 能以 Host 用户的身份读写文件、执行命令，包括 Latch 的数据目录和 Host 身份私钥，也能冒用本机 Electron 在其他电脑上的设备身份。
- Agent 自己发起的审批询问只是提示（`advisory: true`，按 `R2` 展示），不是安全边界：拒绝会转达给 Agent，但不能阻止它执行其他操作。
- Latch 能做的是：记录每次启动的命令、项目配置与第一条输入的哈希；在启动前把 Agent 设到它最严格的可用权限模式，并在每轮输入前读回确认；发现 Agent 自己放宽模式时停止该会话；去掉会持久保存授权的选项。

谁能做什么：

- 新建 ACP 会话、发送输入、修改会话设置（包括放宽模式）、允许询问与删除会话：任何连上的设备都可以，要求 `run` 权限，不弹确认，也不限于这台 Mac。每次启动写两条审计（`task.l3.start-requested`、`task.l3.started`，`stepup: 'none'`），带启动指纹与第一条输入的哈希；放宽模式写 `task.mode.widened`。启动目录位于数据目录内或与 Latch 程序目录重叠时，不能用于 ACP 会话（409）。
- 只有 `view` 的设备可以查看、拒绝询问和取消。修改标题、置顶与归档只改 Latch 自己的会话记录，不触达 Agent。
- 任何 L3 会话运行中或等待审批时，比会话更长久的授权要等它结束：登记新设备、为设备增加权限、放宽安全策略与确认新的模型服务地址返回 409 `presence-blocked`，桌面端点名挡住它的会话（`blockingTasks`），提供「查看会话」「停止会话」。

## 使用

1. 在运行 Host 的电脑上安装 Agent，并按它自己的方式完成登录与模型配置。
2. 新会话直接列出命令已经装好的预设（`catalog.harnesses` 中带 `offer` 的项，只发给有 `admin` 的设备），不用先添加；第一次发送时页面先保存它的定义，再开始会话，保存不运行任何东西。`startServer` 只有收到 `detectPreset`（启动脚本传入）才找命令，测试不传，所以运行测试的电脑上装的 Agent 不会被选中。也可以在「设置 → Harness」选择预设或填写自定义命令（可执行文件名或绝对路径、参数、环境变量）；新增定义、改命令、参数或任何变量（新增、修改或移除：移除 `CODEX_PATH` 或 `DISABLE_*` 同样改变运行的程序）只在这台 Mac 的桌面端（`host.sock`），并要本机确认 `harness.command.apply`（系统表单写「让 Harness 运行 <命令>（「名称」）」，确认绑定名称与命令解析出的路径，完全访问的会话运行或等你处理时被挡），因为它决定运行哪个程序。确认时记下解析出的路径（`confirmedCommand`）：之后同一个命令解析到别的程序时 Harness 不可用、会话不启动（409 `harness-command-moved`），在这台 Mac 上再保存一次命令即重新确认；在确认之前保存的旧定义没有这条记录，照旧启动。改名、开关、删除、模型与权限预设照旧，有 `admin` 的设备都能改。每次改动都有 `agent.defined` 审计（确认过的带 `lpc-local`），变量的值不返回。Host 只为确认过、且仍解析到同一路径的定义运行 `--version`：新增的定义在确认之后才读版本（太旧时那时拒绝，什么都不保存）。在这个改动之前保存的定义没有记下路径：在这台 Mac 上第一次用它开始会话时先确认一次并记下（`agent.defined` 带 `lpc-local`），在此之前其他设备开始它会被拒绝（409 `harness-unconfirmed`），它的版本也不读；升级后请在这台 Mac 上用每个 Harness 开始一次会话。新会话里直接列出的预设（`offer`）也只给这台 Mac 的桌面端：第一次发送时页面保存它的定义，同样先确认。可以先「测试启动」，不发送内容地核对程序能否运行。
3. 新建会话时默认用这台设备上次的 Harness，否则按预设顺序用第一个能开始的，Latch 内置最后，不提问。项目在标题里选；Harness 没有项目、启动目录又是 Host 自己选的（`catalog.sessionFolders`）时，按发送打开项目列表、保留草稿、不开始；选「不选项目」就在新的空文件夹里开始。 发送就开始，没有确认。

   这个启动指纹在这台 Host 上第一次启动时，`sessions-meta.json` 记 `firstStart`，摘要带 `firstStart: true`，会话记录最上面显示一行，带 Harness 的标记：「Latch 不隔离 Codex」，ⓘ 后是「Codex 能读写这台 Mac 上的文件并运行命令。权限是 Codex 自己的设置。」；执行工具前不询问的 Harness 写明它不询问，ⓘ 解释实际询问来源；pi 的权限扩展会在工具前询问，不能沿用未接扩展时的「pi 不询问」说明。Driver 不会收到这一项。网页帮手话题的同一事实已在页头说明中时，不再重复画时间线首启行；页头警告也保留完整本机能力说明。Code 与没有帮手页头的兼容界面维持原提示。
4. 会话头部显示 Agent 提供的模型、模式等选项，修改后从下一轮生效；任何档位都能直接选，也包括由模型代为批准和不再询问的模式。权限菜单的写法见「权限菜单」。

### 直连优先

Agent 自己提供官方的机器协议时，Latch 直接说这个协议，ACP 适配器只作后备：少一层转换，能用到协议的全部，版本也只跟着 Agent 自己走。

| Harness | 路线 | 为什么 |
| --- | --- | --- |
| Codex | `codex app-server`（见「Codex 的 app-server」） | Codex 自己的客户端用的 JSON-RPC 协议；codex-acp 本身也是启动它再转成 ACP。需要 Codex 0.156.0 或更高：它的发布说明从这一版起在一轮被中断或失败时保留已经流出的回答与计划，另一个直连 app-server 的开源客户端也以 0.156.0 为支持下限。`codex` 低于 0.156.0 时以 409 `harness-version-unsupported` 拒绝并给出升级命令，不改用 codex-acp：适配器会经 `CODEX_PATH` 运行同一个旧 Codex。只有这台电脑没有 `codex`、却装了 `codex-acp` 时，从草稿选 Codex 才保存为 `codex-acp`，它运行自己随包带的 Codex（[codex-acp 的 README](https://github.com/agentclientprotocol/codex-acp)：npm 包依赖一个兼容的 `@openai/codex`，`CODEX_PATH` 只用来换成别的 Codex；Codex 没装时 Latch 不设它），预设列表这时写它经适配器运行。定义的命令是 `codex-acp`（之前保存的定义）或任何别的命令时走 ACP，「设置 › Harness」在它的行上写「经 codex-acp」，ⓘ 后是直连需要的版本；两者都没装时，预设就是 Codex 本身，给出它的安装命令 |
| pi | `pi --mode rpc`（见「pi 的 RPC 模式」） | pi 官方的 RPC 模式 |
| DeepSeek Harness | `dsh --profile acp` | dsh 随包提供的 `acp` 配置就是它给自动化客户端的官方协议；`--profile sdk` 是给它自己的 SDK 用的 JSON-RPC，换过去没有收益 |
| 其他预设 | ACP | 它们的官方集成方式就是 ACP（OpenCode、Qwen Code、goose、Cursor 的 `acp` 命令，Claude Agent 的官方适配器） |

预设收录开源 Agent，以及厂商官方文档支持的已安装命令（Claude Agent、Cursor）；都只使用本机已安装的命令，不使用 `npx` 等运行时下载，不捆绑、不修改它们：

| 预设 | 命令 | 许可证 | 说明 |
| --- | --- | --- | --- |
| Codex | `codex app-server` | Apache-2.0 | `npm i -g @openai/codex`，0.156.0 或更高版本；不用适配器；没装 Codex 而装了 `codex-acp`（Apache-2.0）时经它运行它自带的 Codex；登录、模型与沙箱由 Codex 管理 |
| pi | `pi --mode rpc` | MIT | `npm i -g @earendil-works/pi-coding-agent`，0.84.4 或更高版本（与 1.5.0 核对过握手）；不用适配器；Latch 的私有 pi 扩展提供四档权限，默认先问你 |
| OpenCode | `opencode acp` | MIT | `npm i -g @opencode/cli`；当前安装包为 2.x，仍支持已有 1.x 与 2.x |
| DeepSeek Harness | `dsh --profile acp` | MIT | 需要 `@deepseek-ai/dsh` 0.2.2-rc.1 或更高（`acp` 配置自 0.1.2 起随包提供；0.2.1-rc.1 起它的 ACP 一轮等子 Agent 结束才结算、取消等真实停止，见 `@deepseek-ai/dsh-acp` 0.2.0-rc.2 与 0.2.1-rc.1 的 README；2026-11 的 latest 是 0.2.2-rc.1，参数不变）；它要求 Node.js 24.9 或更高；按完整消息回复 |
| Qwen Code | `qwen --acp` | Apache-2.0 | `npm i -g @qwen-code/qwen-code` |
| goose | `goose acp` | Apache-2.0 | 见项目文档 |
| Claude Agent | `claude-agent-acp` | Apache-2.0 适配器；Claude Code 专有（Anthropic 条款） | `npm i -g @agentclientprotocol/claude-agent-acp`；用这个人在 Claude Code 中已有的登录（或它设置里的 API key、Bedrock、Vertex）。名称只用「Claude Agent」，图标使用官方 Claude 品牌资源；来源与商标使用条件见界面的开源许可 |
| Cursor | `cursor-agent acp` | 专有（Cursor 服务条款） | Cursor 官方安装脚本；用这个人自己的 Cursor 账号。安装脚本同时建 `agent` 与 `cursor-agent` 两个链接，预设用后者，因为 `agent` 这个名字可能属于别的程序；图标使用官方 Cursor 品牌资源 |
| Antigravity | `agy acp --disable-telemetry --process-per-session` | Google Antigravity 条款 | 1.5.8 或更高版本；使用本机 CLI 的登录，模型与思考选项由 ACP 报告，思考档位随所选模型变化 |
| Grok Build | `grok --no-auto-update --permission-mode default agent stdio` | 发布版条款；开源源码 Apache-2.0 | 1.0.77 或更高版本；使用本机 CLI 的登录，模型与推理档位由 ACP 报告，权限档位尚不能经 ACP 读回 |

Claude Agent 与 Cursor 不是开源软件，Latch 只启动这个人自己装好、未经修改的命令。Latch 不提供 Claude 的登录（不写登录命令、不调用 `authenticate`、不声明 terminal auth，所以适配器也不列出登录方法），不读取、保存或转交任何一家的凭据，不调用私有接口；它的登录状态命令只读结论与到期日期（见「登录」）。对外发布并宣传「可用 Claude 订阅」之前，需要先取得 Anthropic 的书面确认；在自己的电脑上个人使用不受影响。

Host 启动时、开始监听之前，用账户的 shell 跑一次 `-ilc`，读出 `PATH` 和下文点名的变量（「进程与环境」），8 秒内没结束就杀掉整个进程组，退回下面这些目录。登录 shell 的 PATH 排在 Host 自己的 PATH 之前。

启动脚本让 Host 在 PATH 以及 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.npm-global/bin`、`~/.local/bin`、`~/.bun/bin`、`~/.grok/bin` 中查找命令，不经过 shell；含 `/` 的相对路径按找不到处理。从图形界面启动的 Host 通常没有登录 shell 的 PATH，所以还查找用户目录里 Node 版本管理器与包管理器的全局目录：fnm 的 `$FNM_DIR`（或 `~/.local/share/fnm`）下的 `aliases/default/bin`、nvm 的 `~/.nvm/alias/default`（经 `lts/*` 这类别名解析）指向的 `~/.nvm/versions/node/<版本>/bin`、Volta 的 `~/.volta/bin`、asdf 的 `~/.asdf/shims`、mise 的 `~/.local/share/mise/shims`、pnpm 的 `$PNPM_HOME` 与 `~/Library/pnpm`、Yarn 的 `~/.yarn/bin`。来自环境变量的目录只在是绝对路径时使用，只接受可执行的普通文件，查到的绝对路径计入启动指纹；这些目录也追加到 Agent 进程的 PATH 上。找不到时 Agent 在选择器中显示为不可用，并给出安装提示；仍找不到时请填写绝对路径。

预设可以声明 `agentCommand`：适配器驱动的那个人熟悉的程序；有 `fallback` 适配器的预设由 `fallback.drives` 说（codex-acp 驱动 codex），只用于保存在适配器上的定义。Host 用同样的规则查找它，只装了程序时「设置 → Harness」与选择器写「已安装 codex，还差让 Latch 连接它的适配器 codex-acp」；适配器才是启动的命令，没有它这个 Agent 不可用。Harness 状态里的命令查找结果缓存 5 秒；读取 `GET /link/api/agents`（设置页的「重新检测」，以及窗口重新获得焦点时）会清掉这个缓存，所以刚在终端里装好的命令下一次就能看到。这个列表里的每个预设也带同样的查找结果（`detected`，还没有据它添加 Agent 时也有），新会话页的「添加 Agent」据此在添加之前说出这台电脑上缺的是哪个程序；旧版 Host 不发它，那里只显示安装命令。Latch 不提供一键安装，只显示可复制的安装命令与项目主页。每个预设还有 `helperCard`：新建 Agent 时这个 Harness 作为候选的样子（开始时的括号与眼睛、一句话、能力标签与出处 `source`），只写做得到的，「上网」在真实 Harness 上核对之前不写；Latch 内置的是 `BUILTIN_HELPER_CARD`，见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#界面)。

### 版本门槛

profile 可以声明 `minimumVersion`：它自己的命令支持的最低版本，用 `<命令> --version` 读出：只读标准输出的第一行，整行是版本号（可带 `v`）才算，夹着更新提示等其他文字的不算。不经过 shell，不发提示，10 秒上限，程序退出后还占着输出的子进程被结束；与登录检查同一规则，只在启动脚本经 `startServer({ loginPrograms })` 打开后运行，测试 Host 碰不到真实程序，也只读登录检查会运行的那个文件：定义的命令就是预设的命令名，或是指向同一文件的路径；其他命令（经 `node` 等运行时启动的、项目文件夹里的同名文件）不读，也不挡。现在有 DeepSeek Harness（0.2.2-rc.1，权限服务桥经此版本核对，见上表）与 pi（0.84.4，RPC 的 `clear_queue` 检查仍保留给读不出版本的 pi）。

- 只读已保存且启用的定义：Host 启动时、开始监听之前读一次（最多 5 秒），`GET /link/api/agents`（「重新检测」）清掉缓存后等新的结果（最多 5 秒）再回答；没添加过的预设与停用的定义不读，设置里这样的预设写「已找到」，ⓘ 后是「版本未读」（`CommandDetection.versionUnread`）。从新会话或「添加 Harness」选中一个预设时（即在这台 Mac 上确认它），保存它的定义之前读一次：太旧就以同一个 409 拒绝，不保存定义、不开会话，草稿留在输入框；这个结果保留下来，之后设置与「添加 Harness」写「需要升级」，「重新检测」也重读这样选过的预设。读到的结果按文件缓存（文件被替换或改动、「重新检测」时重读）；缓存说太旧时，新会话、已有会话的下一轮与进程启动前都再读一次（同一次读取共用），因为 Volta、asdf、mise 的 shim 在升级后还是同一个文件。读完发现变化时 Host 发一次 `refresh`，已打开的页面重新读取目录。
- 低于门槛时：定义状态是 `unavailable`，文字是「<名称> 需要 <最低> 或更高版本（当前 <版本>）。升级：<命令>」；检测结果（`CommandDetection.outdated`）带 `need` 与 `upgrade`，设置写「需要升级」并给出升级命令与「重新检测」。只有读到的版本太旧时（不是没读过），定义与预设在目录里是 `unavailable`、带 `statusReason: 'outdated'`：新会话的 Harness 菜单把它列成灰色的「需要升级」，不能新选；草稿已经选了它（选中时才发现太旧）时选择不变，输入框上方就地写出原因与升级命令，不会自己换成另一个 Harness。Codex 同样。新会话、已有会话的下一轮（已在运行的进程也不再接收）与「测试启动」都在启动进程之前拒绝，同一个 409 `harness-version-unsupported` 与同一句话；「测试启动」在读版本之后、启动之前再查一次是否已取消；这不记为它的「上次运行异常」。读版本发生在启动前的项目配置复查之前，复查仍是启动前的最后一步。
- 读不出版本（命令失败、超时、没有打印版本）不挡任何事；这时由下面「进程与环境」的握手时限兜底。

## 预设的权限配置

每个预设的权限配置是 `packages/harness-acp/src/profiles/` 下的一个 `HarnessProfile`，只在 Host 上使用；浏览器只看到复制进 `TaskDetail.permission` 的展示字段。

- `permission`（`AcpPermissionProfile`）：`approvals`（Agent 是否请求审批）、`defaultEnv`、`expectedMode`、`modeLadder`（严格 → 宽松，由模型代为批准的模式排在询问与不再询问之间）、`modeTiers`（每个模式的档位与一句话，见「权限菜单」）、`reviewCallPrefix`（Agent 把自己的模型审阅一次请求报告成工具调用时，调用 ID 的前缀）、`hiddenOptionIds`（精确 ID，或以 `*` 结尾的前缀）、`readback`、`versionRule`（见「版本规则」）、`configEnv`（见下）与中文 `notes`。
- `version`：计入启动指纹。改变配置的行为时应递增它，已有会话因此停止接受输入，换新会话继续。
- `projectConfigPaths`、`projectConfigManaged`：见「项目配置」。
- `materialize`：启动前在 Host 上准备 Agent 需要的文件，返回要加入的环境变量（目前没有预设使用）。
- `normalizeUpdate`、`readRetry`：见「通知与压缩」。

选择规则：按定义的 `presetId`，否则按命令的文件名匹配预设的命令。只要选中了预设，它的环境变量和模式规则就生效；只有 `presetId` 与参数都与预设完全一致、命令就是预设的命令，并且定义没有设置会改变该 Agent 读取配置位置的变量（`configEnv`）时，定义才算「已验证的预设」，否则显示为「未验证的定义」。「就是预设的命令」指只写命令名（由 Host 自己查找），或写 Host 按这个命令名查找到的那个文件（按真实路径比较，指向它的链接也算）；其他目录里同名的文件（例如项目 `node_modules/.bin` 里的 `codex-acp`）不算，每次启动时重新判断。没有匹配任何预设的定义不设置模式，但会话中 Agent 自行改变模式一律按漂移处理。

目前只有 OpenCode 预设列出 `configEnv`：`XDG_*`、`OPENCODE_*`（其中由 Latch 管理的几个本来就不能设置）和 `USERPROFILE`，比较时不区分大小写。OpenCode 从 XDG 目录（或主目录）读取用户配置、Agent 定义与插件，且在 Latch 的规则之后加载；其余 `OPENCODE_*` 开关对询问规则的影响 Latch 没有逐一核对。设置了其中任何一个的定义仍可保存和运行，但显示为「未验证的定义」，会话权限说明中注明：`定义设置了 <变量名>，OpenCode 可能改从其他位置读取配置、Agent 定义与插件，覆盖 Latch 设置的询问规则；该定义不作为已验证的预设`。

| 预设 | Latch 设置的环境变量 | 预期模式 | 模式顺序（严格 → 宽松） | 不提供的模式 | 隐藏的选项 | 读回 |
| --- | --- | --- | --- | --- | --- | --- |
| Codex（经 codex-acp；直连见「Codex 的 app-server」） | `INITIAL_AGENT_MODE=read-only` | `read-only` | `read-only`、`workspace-write`、`agent`、`agent-full-access` | — | `accept_execpolicy_amendment`、`apply_network_policy_amendment*` | 可读回 |
| Qwen Code | — | `default` | `plan`、`default`、`auto-edit`、`auto`、`yolo` | — | — | 可读回；恢复会话会恢复旧模式，Latch 每轮前重新设置 |
| goose | `GOOSE_MODE=approve` | `approve` | `chat`、`approve`、`smart_approve`、`auto` | — | — | 可读回 |
| DeepSeek Harness | 私有 `--patch` 插件、`DSH_PERMISSION_MODE`、`DSH_TELEMETRY_DISABLED=1` | `read-only` | `read-only`、`workspace-write`、`danger-full-access` | — | — | 公共权限服务读回；空闲换档重启恢复 |
| OpenCode | `OPENCODE_CONFIG_CONTENT`（见下） | `build` | `plan`、`build`、`auto-edit`、`yolo` | — | — | 可读回 |
| pi | 私有 `-e` 扩展 | `ask` | `plan`、`ask`、`rule`、`never` | — | — | 扩展报告当前档位 |
| Claude Agent | — | `default`（Manual） | `plan`、`default`、`acceptEdits`、`auto`、`bypassPermissions` | — | — | 可读回；适配器新会话默认进 `auto`，Latch 每轮前设回预期模式 |
| Cursor | `--mode` 或 `--force` 启动参数 | `agent` | `ask`、`plan`、`agent`、`agent-force` | — | `allow-always` | ACP 报告前三档；force 只标启动设置 |
| Antigravity | — | `default` | `default`、`accept-edits`、`auto`；`plan` 不作为更严格的权限 | — | 仅保留单次选择 | 原生 mode 读回；工具权限规则仍由 CLI 管理 |
| Grok Build | — | — | — | — | 仅保留单次选择 | 不报告权限模式；不生成虚构的四档选择 |

Antigravity 的 `plan` 只追加规划指令，不能称为「只看不改」。它保留原生名称与说明，未归入权限档位；仅由人显式选择，不参与跨 Harness 的只读档位继承。默认草稿与分叉差异说明采用该 Harness 的实际默认名称。`default` 名称保留为「默认」：本机 `toolPermission`、允许与拒绝规则仍优先，所以默认模式也可能直接改文件。Latch 输入前设定并读回 mode，但不能据此断言每次工具调用都询问；一旦 CLI 请求审批，只提供单次选择。项目 `.agents`、兼容目录 `.agent` / `_agents` / `_agent` 中的 hooks、MCP 与插件，以及 `.gemini/config.json` 的个人定制目录入口计入启动指纹；清单引用这些目录之外的代码不在该指纹覆盖范围内。额外目录通过 ACP 能力协商后传入；创建空会话可能加载扩展，所以模型列表只在用户请求时读取。

Antigravity 1.5.8 宣告 `session/resume`、`session/load`、`session/list`、`session/close` 与 `additionalDirectories`（2026-11-15 实测）。Latch 用 `session/resume` 恢复会话；「接入已有会话」对它尚未实现，所以不调用 `session/list`。恢复后 CLI 报告的模型与思考档位回到它的默认值，不是会话原先所选：Latch 在下一条消息发出前按会话原先显示的值重新设置并逐项读回（先模型、后思考），CLI 不再提供原先的模型或没有采用时这条消息不发出，并写明现在用的是哪个。因此这两项的「核对」不重新打开会话，结果保持未知；权限模式照常核对。服务端拒绝一轮时（例如所在地区不受支持），CLI 只发来一段正文「⚠ Agent execution terminated due to error.」并以 `end_turn` 结束，不经 ACP 报告原因（agy 1.5.8，2026-11-15 实测）。profile 的 `terminatedReplies` 记下这段正文：一轮的全部回复正好是它时（整段相等，首尾空白除外；只是包含这段文字、或前后还有别的回复的，仍是普通回复），驱动把这一轮记为失败，那条回复沿用原来的消息 ID 并标为失败，后面是 Latch 自己的一行「Antigravity 中止了这一轮，没有给出原因」和「重试」。只对 Antigravity 生效，别的 Harness 发来同样的文字仍是回复（`packages/harness-acp/test/acp.test.ts`，用假 Agent 的 `FAKE_ACP_REPLY_QUEUE`）。

Grok Build 的 stdio 模式是独立 Agent 进程，不连接终端使用的共享 leader。Latch 不运行 `grok leader kill`，只停止自己启动的进程。项目 `.grok` 计入启动指纹；继承 `GROK_HOME` 的变量名和路径，不读取其中的登录或历史文件。经 Latch 使用模型服务见「经 Latch 使用模型服务」。Antigravity 同样不把 CCPA 地址选项当作 Gemini API 网关地址。

- DeepSeek Harness：Latch 保持 `DSH_TELEMETRY_DISABLED=1`。每次启动在会话私有临时目录写入 0600 的 `--patch` 文件和插件，经公开 `permissionPresets.set/current` 设置与报告当前档位；不读写 dsh 自己的会话文件。报告同时绑定当前进程与 ACP session ID，未知组合拒绝发送。草稿选择计入启动指纹；会话空闲、没有后台子 Agent 时换档，结束旧进程、带选择启动新进程并恢复同一会话，真实读到目标值才完成。核对省略 setter，只报告服务当前值。`workspace-write` 直接允许工作目录及许可临时目录写入，扩大范围才询问。会话仍为 L3，模式不是 Latch 的 OS 隔离。
- OpenCode：`OPENCODE_CONFIG_CONTENT` 让除读取、glob、grep、list 以外的工具都先询问，访问工作目录以外的路径（`external_directory`）先询问，拒绝读取 `.env` 与 `.env.*`；同样的规则也写进 `build` 与 `plan` 两个 Agent，避免它们各自的设置覆盖全局设置，`plan` 在这些规则之后再拒绝 `edit`（也管写入与补丁工具）和 `bash`，所以计划模式不改文件也不运行命令，它自己的计划文件也不写。子 Agent：规则先写 `task: 'deny'`，再写 `subagent: 'ask'`。1.x 只认 `task`，子 Agent 保持禁用，因为 1.x 的 ACP 不回答子会话的权限请求，子 Agent 会一直等下去；2.x 把 `task` 读作 `subagent`，后写的 `subagent: 'ask'` 生效，`build` 中启动子 Agent 先问你，子 Agent 的请求出现在启动它的会话里；在后来的一轮里被继续的子 Agent 例外，OpenCode 不转发它的请求（见「子 Agent」）。`plan` 另写 `subagent: 'deny'`，因为子 Agent 按它自己的 Agent（`general`、`explore`）加上这些全局规则工作，不受 `plan` 的拒绝约束。2.x 自带的 `explore` 本来放行命令与工作目录以外的路径，全局规则排在它自己的规则之后，所以它同样先问。2.x 默认不允许子 Agent 再启动子 Agent（`experimental.subagent_depth` 为 1）。这些规则只是默认值：OpenCode 还会合并用户与项目的配置（用户配置目录、从工作目录向上查找的 `opencode.json`/`opencode.jsonc`、项目与主目录下 `.opencode` 目录中的配置和 Agent 定义），其中一部分在 Latch 的规则之后加载，可以把询问改成直接允许，模式读回仍显示 `build`。Latch 无法关闭这些来源；项目中的这些配置计入启动指纹（见「项目配置」），用户配置不计入。OpenCode 启动时还会在 `.opencode` 目录中安装依赖并加载插件，因此在不信任的项目中使用 OpenCode 会运行项目里的代码。OpenCode 会话的权限说明注明了这两点，以及 2.x 的子 Agent 可以在一轮结束或停止后继续（见「子 Agent」）。OpenCode 2.x 把 `OPENCODE_CONFIG_CONTENT` 放在用户与项目的配置文件之后、系统托管设置之前读取，所以那些文件里给 `build`、`plan` 写的规则排在 Latch 的规则之前；托管设置、`.opencode` 中的插件（插件可以改变询问的结果）和项目新定义的 Agent 仍不受这些规则约束；这样的 Agent 不在模式顺序里，按更宽的模式对待，2.x 也可以把它作为子 Agent 启动（启动前先问你，请求里写着它的名字）。2.x 默认放行工作目录以外的路径，Latch 的 `external_directory: 'ask'` 让它照样先询问。
- Cursor：保留官方 Ask、Plan、Agent 名称，最宽档用 `Agent --force`。前两档以 `--mode` 启动，Agent 不传 mode，force 只在明确选择时附加；空闲换档重启恢复并核对 ACP 模式。`--force` 不覆盖显式拒绝，ACP 不独立报告此标志，当前 force 档带 `source: launch`，不能把一次重启当成旧标志的只读核对。尚未做真实 Cursor 验收。
- OpenCode 的新增主 Agent：`auto-edit` 沿用 build，只将文件编辑放行；`yolo` 直接允许工具。默认仍为 build，plan 的拒绝保留。这些主 Agent 由同一个 `OPENCODE_CONFIG_CONTENT` 声明，模式读回仍来自 OpenCode。
- Claude Agent：五档按「权限菜单」的档位给出，Bypass 是不再询问，不预选任何更宽的一档。自动模式由 Claude 的分类器决定是否执行；计划模式在自动模式可用时，命令也可能由分类器决定（适配器默认开启 `useAutoModeDuringPlan`）。会话权限说明还写明：Claude 不需要批准的调用（工作目录内读取、只读命令）不出现在审批里，Claude Code 设置里的允许规则与 hooks 先于 Latch 生效，项目 `.mcp.json` 的服务器直接连接。版本规则要求 0.99 或之后的 0.x 适配器。
- 人选的换档（`modeAnswers`）：Agent 用一次询问来换模式时，人的「仅此一次」回答就是选了那一档。Claude 的 ExitPlanMode 只留 `exit-plan-default`（回到 Manual，其余是会持久保存的选项），EnterPlanMode 是 `switch_mode` 调用上的 `allow-once`（进入 `plan`）。Latch 在把回答交给 Agent 之前把这一档记为预期模式，所以随后的换档不算漂移；没有人回答的换档仍按漂移处理。
- 所有预设一律隐藏 `allow_always` 与 `reject_always` 类型的选项，这一点不可配置。

### 版本规则

预设可以用 `versionRule` 要求 `initialize` 返回的 `agentInfo.version` 匹配一个正则。不匹配或未报告版本时，Latch 结束该进程，会话以 409 `harness-version-unsupported` 失败（`<名称> 版本 <v> 未经验证（<说明>），已拒绝启动。`）。OpenCode 的规则是 `^[12]\.`，说明为 `OpenCode 仅支持 1.x 与 2.x`：上面的配置键是 1.x 的格式，2.x 仍读取 `OPENCODE_CONFIG_CONTENT`，并把 1.x 的 `permission` 与 `agent.<名称>.permission` 换成同样的有序规则（后写的规则优先，没有匹配时询问；`task` 换名为 `subagent`，`bash` 换名为 `shell`），`build` 与 `plan` 两个 Agent 和模式 ID 不变；3.x 及以后的读取方式未经核对。Claude Agent 的规则见上。核对依据是 2.x 的源码与按它手写的回放（`replay/opencode/2.x/`），不是运行中的 OpenCode。

## 项目配置

多数 Agent 启动时会读取项目里的配置，其中的设置可以改变询问规则、加载插件或扩展。Latch 把预设列出的项目配置（`projectConfigPaths`）的内容计入启动指纹（见「启动指纹」），会话启动之后它们的任何变化都会让会话不能继续。会话页面不列出找到的项目配置。

| 预设 | 计入启动指纹的项目配置 | 不计入（Agent 自己写入的内容） |
| --- | --- | --- |
| OpenCode | `opencode.json`、`opencode.jsonc`、`.opencode/` | `.opencode/` 下的 `node_modules`、`bun.lock`、`bun.lockb`、`.gitignore`、`plans`；`.opencode/package.json` 中 OpenCode 自己添加的 `@opencode-ai/plugin` 依赖（文件只剩这一项时整个不计入） |
| Codex | `.codex/`；收到其他文件夹的会话还有 `.agents/skills/` | — |
| Qwen Code | `.qwen/` | — |
| pi | `.pi/`、`.agents/skills/` | `.pi/npm`、`.pi/git`（pi 按项目设置安装的包；项目设置本身计入） |
| Claude Agent | `.claude/`、`.mcp.json` | `.claude/worktrees`（Claude 为子 Agent 建的工作区） |
| Cursor | `.cursor/`、`.cursorrules` | — |
| goose、DeepSeek Harness | 无（未发现它们读取项目级配置目录） | — |

- 查找范围：从会话目录开始，逐级向上直到根目录，分别沿 Agent 收到的路径（Host 登记的项目路径，可能经过符号链接）和它解析后的真实路径查找；同一个目录只查一次。主目录本身跳过，因为 `~/.codex`、`~/.opencode`、`~/.gemini`、`~/.pi` 等是 Agent 的用户级数据，不是项目配置；会话目录就是主目录时，这些目录也不计入。查找范围比各 Agent 自己的（通常到 Git 仓库根目录为止）更宽。
- 其他文件夹：Agent 收到的其他文件夹（见「项目的多个文件夹」）同样从它们开始逐级向上查找，与会话目录共用上限，同一个目录只查一次；这样的 Codex 会话在每个文件夹（包括主文件夹）中还计入 `.agents/skills/`，因为 codex-acp 加载它收到的每个文件夹中的技能。其他文件夹中找到的文件在说明中用绝对路径列出。只有主文件夹的会话查找范围与指纹都不变。
- 这些文件的内容计入启动指纹；变化后已有会话停止接受输入，换新会话继续。
- 何时重新计算（含其他文件夹）：新建会话时、每次输入与修改设置之前、每次启动 Agent 进程之前（新会话的首次启动、恢复会话、空闲停止后的重启；启动前的等待之后再查一次），以及为删除会话临时启动进程之前。只有项目配置变化时返回 409 `project-config-changed`（`项目中的 <名称> 配置与会话启动时不同，该会话不能继续。请新建会话。`），定义也变化时仍是 409 `agent-definition-changed`；为删除会话而启动进程的检查不通过时只删除 Latch 的记录。
- Agent 按用户要求修改了这些配置（例如编辑 `opencode.json`），之后的输入同样被拒绝，需要新建会话。
- 这是启动前的一致性检查，不是隔离：Agent 是完全访问的本机代码，可以在运行中读写任何文件。

## 项目的多个文件夹

一个项目可以由几个文件夹组成（见 [ARCHITECTURE.md](./ARCHITECTURE.md#会话与项目)）。ACP 会话的工作目录（ACP 的 `cwd`，也是进程的工作目录）始终是主文件夹，在新工作树里开始的会话除外：它的工作目录是工作树，启动指纹按工作树里的项目配置计算，不交给 Agent 其他文件夹（见 [BRANCHES.md](./BRANCHES.md#在工作树里开始会话)）；其他文件夹能否交给 Agent，取决于 Agent 自己：

| 预设 | 其他文件夹怎样交给它 | `HarnessInfo.projectFolders` | 说明 |
| --- | --- | --- | --- |
| Codex | 直连时是 `workspace-write` 一轮的可写根（`sandboxPolicy.writableRoots`）；经 codex-acp 时是 ACP 的 `additionalDirectories`：`session/new`、`session/resume` 与 `session/load` 每次都发送完整列表 | `{ access: 'all' }` | 只在 `initialize` 声明了 `sessionCapabilities.additionalDirectories`（一个对象）时发送。没有声明时 Latch 结束该进程并返回 409 `agent-folders-unsupported`，会话不会创建。codex-acp 把每个文件夹当作受信项目并加载其中的 `.agents/skills`；在 `workspace-write` 模式下这些文件夹也可写 |
| Qwen Code | 在定义的参数之后，每个其他文件夹追加一次 `--include-directories <真实路径>`；每个会话有自己的进程，参数只对它生效 | `{ access: 'all', max: 5 }` | 最多 4 个其他文件夹，超出时返回 409 `harness-folder-limit`，不启动进程。它按逗号拆分这个参数，含逗号的路径返回 400 `workspace-folder-chars`（Host 本来就不接受这样的新文件夹） |
| OpenCode | 不传（1.x 的 ACP 不支持；2.x 声明支持，Latch 尚未使用） | `primary-asks` | Latch 设置的 `external_directory: 'ask'` 让它访问工作目录以外的路径之前先询问；2.x 默认放行这类访问，这条规则让它照样先询问 |
| DeepSeek Harness | 不传（它拒绝这个字段） | `primary` | — |
| pi、goose | 不传（它们没有这个概念） | `primary-unbounded` | 它们不限制工具能访问的路径 |
| 未匹配预设的定义 | 不传 | 无（客户端按 `primary` 显示） | — |

- 只有 Codex 与 Qwen Code 的 Driver 声明 `projectFolders: 'all'`，Host 只把项目标识与文件夹交给它们，其他 ACP Driver 只收到主文件夹。声明 `historyImport` 的 Driver（现在另有 OpenCode）也拿到 `projects()`，只用来核对接入的会话目录仍在项目主文件夹之内，不因此收到其他文件夹。Driver 用 Host 的 `projects()` 再核对一次：项目在列表中、`folders[0]` 是主文件夹，每个文件夹的标识与真实路径都属于这个项目，否则 400 `workspace-unavailable`。交给 Agent 的是各文件夹的真实路径，按项目中的顺序，不含主文件夹，也不重复。
- 只收到主文件夹的 Driver，其会话摘要由 Host 标记 `folderAccess: 'primary'`。`workspaces()` 也列出项目内仍可用的旧主文件夹，调整顺序后的已有会话继续使用原工作目录。
- 其他文件夹计入启动指纹与项目配置（见「项目配置」），审计记下文件夹数量（`folderCount`）。文件夹范围由 Agent 自己执行，不是隔离。
- 会话把项目与文件夹记在摘要中（`workspaceId`、`folders`、`folderAccess: 'all'`），把交给 Agent 的真实路径与方式记在 `acp.folders` 与 `acp.folderVia`，之后不再改变：项目新加的文件夹只用于新会话，改变主文件夹也不影响已有会话。每次输入、修改设置、启动进程、恢复或加载会话，以及为删除会话临时启动进程之前，Latch 确认这些文件夹仍属于该项目且仍在原来的真实路径；文件夹被移出项目、被替换、找不到，或项目已不在列表中时返回 409 `workspace-changed`，删除时只删除 Latch 的记录。之后启动的进程不再声明支持时，本轮不发送，返回 409 `agent-folders-unsupported`，进程被结束。
- 这些文件夹只是 Agent 自己执行的范围，不是隔离。ACP 会话仍是完全访问（L3），Agent 可以访问 Host 用户能访问的任何路径。

## 启动指纹

首轮设置未完成时，会话里的新选择取代对应草稿项；相同值也算重新选择，实际模式 ID 同时取代草稿的 `~mode`。新的选择在恢复会话或应用其他草稿项之前持久化，进程档位与私有思考设置遵守同一规则，之后不会重设旧草稿。

开始会话不弹确认。启动指纹（`launchHash`）由解析出的命令路径、参数、定义的变量、预设（含 `inheritEnv` 的名字与 `programEnv` 找到的路径，见「进程与环境」）、计入的项目配置、交给 Agent 的其他文件夹与经 Latch 使用的模型服务（服务 ID、源、协议、交给 Agent 的方式与变量名，不含凭据，见「经 Latch 使用模型服务」）算出，不含项目配置、文件夹与模型服务的部分另记为 `definitionHash`。启动审计 `task.l3.start-requested` 记下 `launchHash`，`task.l3.started` 再记下 `definitionHash`，接收 Latch MCP 服务器的 Harness 另记 `mcpSetHash`（见 [MCP.md](MCP.md)）；两者随会话保存在 `acp.launchHash` 与 `acp.definitionHash`。之后按「项目配置」所列的时机重新计算：定义或解析出的命令变化时返回 409 `agent-definition-changed`，只有项目配置变化时返回 409 `project-config-changed`。已有会话随之停止接受输入，换新会话继续。

## 启动诊断

Agent 详情页提供「测试启动」，在原位显示握手结果与诊断。缺少权限或命令没有找到时按钮停用并写明原因。

`POST /link/api/agents/:id/probe { requestId }` 接受同时持有 `admin` 与 `run` 的设备，不弹确认。

低于版本门槛的命令不运行探测（见「版本门槛」）。探测只发送 ACP `initialize`（宣告了登录状态推送的 Agent 等它最多 5 秒；没收到时，有登录状态命令的预设之后再问一次，见「登录」），不发送 `authenticate`、`session/new` 或提示词；握手最多等待 15 秒，随后停止进程组并等待真实退出。登录检查与下面的版本读取在剩下的时间里同时进行，每项最多 10 秒；整次测试启动最多 20 秒（`AGENT_PROBE_MAX_MS`），页面等 25 秒，超时才显示结果未确认。Host 关闭也会取消和等待探测。能力包含图片、恢复、加载和附加文件夹。附件能力不只来自测试启动：会话启动与选中时读取可选项的握手也记下 `initialize` 报告的图片与 embeddedContext（驱动状态的 `promptCapabilities`，按定义哈希），见 [ATTACHMENTS.md](ATTACHMENTS.md)。`authMethods` 只说明程序提供哪些登录方法，不证明尚未登录；因此握手成功只表示 `ready`，模型访问仍未验证。只有明确的 `auth_required` RPC 错误表示 `authentication-required`，其他失败为 `failed`。

适配器驱动这个人自己装的程序时（保存在 codex-acp 上的 Codex 定义经 `CODEX_PATH` 驱动 `codex`，profile 的 `programVersion`），探测之后再用登录检查的规则读一次那个程序的版本（`codex --version`）。运行的是会话里适配器会用的那个程序：定义设了 `CODEX_PATH` 时用它的值，绝对路径直接运行，名字按 Host 找命令的规则找；否则是 Host 按 `agentCommand` 找到的程序。限时，不经过 shell，只留下版本号。定义里的相对路径要在项目文件夹里才能解析，测试启动不在那里运行，写「版本未知」；空值让适配器用自带的那份。结果的 `program` 写出程序名与版本，页面把它和握手报告的适配器版本写在一起；读不出版本时写「版本未知」，没有装这个程序、定义也没指定（适配器用自带的那份）时不写。两个版本都知道、又不在 profile 的 `checked` 里时，`program.unchecked` 为真，页面显示琥珀色提示「这个组合 Latch 没有核对过」，不阻止启动。`checked` 是写预设时从每个适配器版本的 `package.json` 抄来的依赖范围（codex-acp 2.3.0 配 Codex 0.164.x，2.4.0 与 2.5.0 配 0.165.x），运行时不下载任何东西；适配器的预览版不在其中。

结果带 `checkedAt`、`launchHash` 与最多 4 KiB 的诊断；先按定义变量与秘密格式脱敏，再截取结尾。最近结果以可选 `AgentRecord.lastProbe`、`probedDefinitionHash` 保存，`AgentSettings.lastProbe` 只返回同一定义的记录；修改启动内容会清除它。探测通过不等于会话已经启动，不修改 `startedHash`，也不授予以后启动会话的信任。运行前写审计 `agent.probe.requested`，结束后记录 `agent.probed`；审计只含 ID、哈希与状态。当前 Host 生命周期内，同设备同 `requestId` 共享整次探测与记录过程，重试不再执行程序；这份记录只在内存中，Host 重启后同一 `requestId` 会再执行一次探测。

## 进程与环境

- 会话、启动指纹、权限模式、审批与取消只有一份，在 `runtime.ts`；它说 ACP 的方法、读 ACP 的会话更新，经 `wires/` 里的一条线与进程交谈。`wires/process.ts` 启动、读写与停止进程，`wires/acp.ts` 把 ACP 原样经 JSON-RPC 发出。
- 每个 Latch 会话有自己的 Agent 子进程（一个 ACP 会话），首次需要时启动，工作目录为该会话的主文件夹；Qwen Code 的参数之后追加其他文件夹（见「项目的多个文件夹」）。同一个 Agent 定义最多同时运行 8 个进程（`AcpAgentOptions.maxProcesses`）；达到上限时，Latch 停止最久未使用的、可以恢复的空闲进程，没有可停的进程时返回 503 `agent-busy`（`同时运行的 <名称> 会话过多，请先结束一些会话`）。
- 子进程在独立进程组中运行。stderr 持续读取到 64 KiB 环形缓冲，只在启动失败或崩溃时以脱敏的短摘要写入 Host 日志，不进入会话记录。
- Agent 自己写的文字（回复、思考、工具输出）原样进入会话。它报告的错误、提示（`notice`）、压缩失败与停止原因先遮蔽定义的变量值、Host 的秘密变量与网关凭据，再经 `redactSecrets` 去掉认得出形状的密钥，才进入会话记录：模型服务的报错常带着密钥的一部分。
- Agent 得到的环境来自 `agentEnvironment`，后者覆盖前者：Host 的白名单（`HOME`、`LANG`、`LC_*`、`TERM`、`USER`、`SHELL`）；代理（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及小写）、CA 文件（`SSL_CERT_FILE`、`SSL_CERT_DIR`、`NODE_EXTRA_CA_CERTS`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE`）与 `__MISE_DIFF`；profile 的 `inheritEnv`（各家的 home，见下表）；profile 的 `programEnv`（`CODEX_PATH`，指向 Host 找到的程序，没装就不设，适配器用自带的）；Agent 定义的变量；profile 的 `defaultEnv` 和 Latch 强制的值（`TMPDIR`、`NODE_TLS_REJECT_UNAUTHORIZED=1`、Git 设置）。最后删除 `NODE_OPTIONS`、`LATCH_*`、`npm_*`、`DYLD_*`、`LD_*`。从终端启动的 Host 已有的变量优先于登录 shell 读到的。

  | 预设 | 继承的 home |
  | --- | --- |
  | Codex | `CODEX_HOME`、`CODEX_SQLITE_HOME` |
  | pi | `PI_CODING_AGENT_DIR` |
  | OpenCode | `XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME`、`XDG_CACHE_HOME` |
  | DeepSeek Harness | `DSH_HOME` |
  | Qwen Code | `QWEN_HOME`、`QWEN_RUNTIME_DIR` |
  | goose | `GOOSE_PATH_ROOT`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME` |
  | Claude Agent | `CLAUDE_CONFIG_DIR`（定义不能设置） |

  没有预设的自定义定义只继承代理、CA 与 `__MISE_DIFF`。`inheritEnv` 不能点名 `*_KEY`、`*_TOKEN` 这类秘密（`test/login.test.ts`）；读登录 shell 时只取点名的变量，其余输出丢弃，不记日志，shell 也拿不到 `LATCH_*` 与 `NODE_OPTIONS`。
- 启动指纹只计 `inheritEnv` 的名字和 `programEnv` 找到的路径，不计任何值：`launchHash` 会发给客户端，代理地址可能带密码。代理与 CA 的名字是固定的，不进指纹；换代理不影响已有会话。诊断与预览不显示值，带账号密码的代理地址在诊断里被遮盖。
- 会话用 Harness 自己的登录与模型时，模型服务的密钥、地址等在 Agent 自己的配置里设置，或写进 Agent 定义的环境变量。会话用设置里保存的模型服务时，Agent 拿到的是网关凭据，不是密钥，见「经 Latch 使用模型服务」。
- **握手时限。** `initialize` 最多等 30 秒（`handshakeTimeoutMs`），`session/new`、`session/resume`、`session/load` 与分叉最多 60 秒（`sessionSetupTimeoutMs`），都不超过一般请求的 120 秒；到时 Latch 结束整个进程组，这一轮失败并写「<名称> 30 秒内没有完成启动握手（initialize），已停止它。确认它是 <最低版本> 或更高版本、能在终端里正常运行后重试。」（504 `agent-handshake-timeout`；没有版本门槛的预设不写版本那半句）。这样太旧或坏掉的 Agent 不会让会话一直停在运行中，排在后面的消息也不会一直等。提示词一轮本身不设时限，长任务照常运行。
- `initialize` 返回的协议版本必须是 1，否则启动失败。Latch 声明 `fs.readTextFile`、`fs.writeTextFile` 与 `terminal` 能力均为 false，Agent 使用自己的文件与命令执行能力；声明 `session.notices` 与 `session.compaction`，见「通知与压缩」；除写了 `signIn` 的预设外声明 `auth.terminal`，见「登录」。`session/new`、`session/resume`、`session/load`（与分叉）的 `mcpServers` 先是 Latch 自己的两个服务器，再是这个会话「用在」的每个 Latch MCP 服务器各一个 `latch-mcp` 桥（命令是 Host 的 Node，参数只有网关套接字与令牌文件的路径，`env` 为空，名字是服务器的名称；远程地址的桥只把消息转给 Host，请求头不到 Agent 这一侧；坏掉的服务器不挡会话，见 [MCP.md](MCP.md)）。Latch 自己的两个是：会话带着技能、或属于某个 Agent 或「和通用的对话」时有 Latch 的技能服务器 `latch-skills`（`skills-server.ts`，列出并读取技能；后一种会话另有两个写工具 `propose_memory` 与 `propose_schedule`，只往会话私有目录的 `proposals.jsonl` 追加记忆或定时提议，见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#记忆提议)；不联网）；打开、恢复、载入或分叉会话的那一刻，这台 Mac 的桌面端已登记为浏览器提供者、且会话有项目（不属于某个 Agent 或「和通用的对话」）时，另有浏览器服务 `latch-browser`（`browser-server.ts`，把浏览器工具转给 Host 的工具网关，令牌 `lbt1.` 在网关目录里一个 0600 文件中，服务只拿到文件路径、读出后即删，参数与 `env` 里都没有它，每次都换新，见 [PREVIEW-BROWSER.md](PREVIEW-BROWSER.md#agent-的工具) 的「外部 Harness」）；不满足时 `mcpServers` 与以前一样。桌面端没开时打开的会话没有这个服务，同一个进程里也不会补上，要到会话下次恢复（新的进程）时才有；会话开着时桌面端关掉，服务还在，调用回答「这台 Mac 上的 Latch 窗口没有打开」。两者都没有时传空列表。pi 的预设写了 `skillServer: false`，两个都不给，所以 pi 没有技能服务器，也没有浏览器工具。浏览器工具在完全访问的会话里：看与本机地址上的动作直接执行并审计，往密码等敏感字段输入一律拒绝。Codex 直连时 `latch-browser` 与各 `latch-mcp` 桥（后者带 `startup_timeout_sec: 60`）随线程的 `config.mcp_servers` 交给 app-server，Codex 可能把线程配置写进它自己在用户家目录下的会话文件：那里留下的是套接字与令牌文件的路径，没有令牌。会话归档后，同一进程上的浏览器工具回答「会话恢复（Agent 进程重新启动）后再试」，取消归档后要等进程重新启动才回来；Agent 发来的请求只处理 `session/request_permission`，其他方法返回 method not found。Latch 不调用 `authenticate`：Agent 要求登录时返回 409 `agent-auth-required`，文字是「Codex 还没登录。按它自己的方式登录后重试。」（预设写了 `signIn` 的用它：Claude Agent 是「在终端里按 Claude Code 自己的方式登录（或在它的设置里使用你自己的 API key）后重试。」），并停掉这个进程，因为 Agent 可能只在启动时读取登录状态：下一次重试启动新进程。这一轮的 `runEnd` 是 `login-required`，页面给出登录命令和「重试」；已有 ACP 会话时下一轮走 `session/resume`，不用新建会话。见「登录」。
- 外部 Harness 的记忆随话题的首轮块发送。驱动按当前上下文已经送达的资料标记记忆与定时提议的来源。清空上下文后按新上下文送达的内容判断。见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#不是用户原话的记忆)。
- 空闲 10 分钟且 Agent 支持恢复会话时，进程会被优雅停止，下次需要时再启动。
- 进程崩溃时，该会话转为 `failed`，`runEnd` 为 `process-exited` 并列出结果未知的调用，`runOutcome` 仍是 `interrupted`（见 [STREAMING.md](./STREAMING.md#运行的真实状态)）；之后的重启从 250 ms 开始按最近的崩溃次数加倍延迟（最多 5 秒），同一定义一分钟内崩溃 3 次会暂停自动重启一分钟（503 `agent-paused`）。

## 经 Latch 使用模型服务

模型菜单同时保留 Harness 自己的模型与可经 Latch 使用的已保存服务。两组的前提不同：Harness 自己的模型要它自己的登录；服务的模型由 Latch 转发、用设置里的密钥，**不需要这个 Harness 登录**。新会话选了服务的模型时不显示「还没登录」那一行，模型菜单里也不写「还没登录」（`composerChoice.ts` 的 `loginHarness`），Codex 直连在这样的会话里也不查自己的账户。Host 根据实际协议能力和自己的服务记录重新核对每次开始，客户端不能决定转发地址或密钥。当前四种入口优先同协议透传，另支持实验性的 Responses/Anthropic→Chat，以及 Responses↔Anthropic 转换；其余组合明确不可选；模型、能力、令牌、用量和安全机制见 [MODEL-GATEWAY.md](MODEL-GATEWAY.md)。会话开始时还定下所选服务各模型的「出错时改用」候选，计入路由与启动指纹；回复开始前的故障切换、健康与排队见[调度](MODEL-GATEWAY.md#调度)。

| Harness | 当前支持 | 交给 Agent 的方式 |
| --- | --- | --- |
| Codex 直连 | Responses；Chat、Anthropic 需实验性转换 | 自定义 provider 的启动参数；LMG_TOKEN 环境变量；config/read 保留原命令环境规则后在线程配置中额外排除令牌 |
| codex-acp | Responses；Chat、Anthropic 需转换（实验性） | ACP providers/set；仅使用适配器声明且列出的 provider/API，模型限于适配器认识的服务模型 |
| OpenCode | 四种同协议服务，至少 2.2.6 | 私有 provider 配置与官方 shell hook；工具环境清空令牌值 |
| DeepSeek Harness | 三种同协议服务，至少 0.2.2-rc.1 | 私有 Cordis patch 与原生 llm provider |
| Claude Agent | Anthropic 同协议服务；Chat、Responses 需实验性转换，实际 Claude Code 至少 2.1.318 | 官方环境变量与会话 modelPicker；逐次核对适配器自带 CLI 版本，精确模型 ID 与子进程凭据清理 |
| pi | 四种同协议服务，至少 1.5.0 | 官方 provider 扩展；精确目录上限或显式运行预算；凭据仅在进程内存 |
| Qwen Code | Chat、Responses、Anthropic 同协议服务，实验性，至少 0.26.8 | `QWEN_CODE_SYSTEM_SETTINGS_PATH` 指向 0600 会话私有系统设置（`modelProviders` 的 `envKey` 只写变量名 `LMG_TOKEN`，其他内置协议的列表置空）；模型经 `session/set_config_option` 只对会话生效；经 Latch 的会话没有子 Agent |
| goose | Chat、Responses、Anthropic 同协议服务，实验性，至少 1.57.0 | 只有环境变量：`GOOSE_PROVIDER`、`GOOSE_MODEL`、`GOOSE_SUBAGENT_*`、`GOOSE_TOOLSHIM=false`、`OPENAI_HOST` 与显式 `OPENAI_BASE_PATH`，或 `ANTHROPIC_HOST`；凭据在 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY`；它的 `provider` 选项不提供 |
| Grok Build | Chat、Responses、Anthropic 同协议服务，实验性，至少 1.0.77 | `GROK_HOME` 指向会话私有的家目录，其中 0600 的 `config.toml` 为服务的每个模型写一个自定义模型（`env_key = "LMG_TOKEN"`）；这个人自己的 Grok 登录、钩子与插件不在这个家里 |
| Antigravity、Cursor | 不能 | Antigravity 的 `--help` 只有 `--model` 与 `models`，没有模型服务地址（`cloud_code_endpoint` 是 Google 自己的地址）；Cursor 的 `--endpoint` 与 `--api-key` 是 Cursor 自己的接口。模型菜单不给它们列服务 |

Qwen Code、goose 与 Grok Build 没有清理工具子进程环境的官方开关（Qwen Code 的 `packages/core/src/utils/sanitize-child-env.ts` 只去掉它自己的内部令牌）：它们运行的命令（以及钩子、stdio MCP 服务器）继承 Agent 进程的环境，用 `printenv` 就能读到网关凭据。这个凭据不是模型服务的密钥：它只能在这台电脑的回环端口上使用这个会话选定的服务与候选，进程退出或服务设置变化后失效；会话本来就是完全访问（L3）。goose 的凭据放在它规定的 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY` 里，所以 Agent 运行的、会读这些变量的工具可能把它发给真实厂商：它在那里没有用，但离开了这台电脑。三者的 profile 声明 `credentialInherited`（`HarnessCapabilities.models.credentialInherited`），模型菜单「经 Latch」的 ⓘ 末尾多一句「<名称> 运行的命令读得到这个会话的转发凭据，不是密钥。」。Codex、Claude Agent、OpenCode、DeepSeek Harness 与 pi 各有清理办法，见 [MODEL-GATEWAY.md](MODEL-GATEWAY.md#harness-交付)。

Qwen Code 的私有系统设置替代了系统设置路径，这个进程不再读取真正的系统设置文件里的管理策略。为了不让一轮里的一部分请求绕开网关，它把每个内置协议键（`openai`、`anthropic`、`gemini`、`vertex-ai`、旧的 `openai-responses`）的 `modelProviders` 列表都写出来：所选协议的只有这个服务的模型，其余为空；清空 `fastModel`、`visionModel`、`compactionModel`、`advisorModel`、`imageModel`、`voiceModel` 与 `modelFallbacks`，内置 Explore 用会话模型，`agents.allowedGrades` 为空（不给任何模型档位），并以 `permissions.deny: ["Agent"]` 关掉子 Agent。关掉子 Agent 是因为关不掉另外两条路：这个人自己起名的服务（`providerProtocol` 映射的 ID）和 Qwen Code 内置的 OAuth 模型删不掉，而子 Agent 自己的定义文件可以点名任何模型。依据与出处见 [MODEL-GATEWAY.md](MODEL-GATEWAY.md#qwen-code)。Latch 从不调用 `unstable_setSessionModel`（`session/set_model`）与 `authenticate`：它们会改写这个人的 Qwen 设置；模型选择带 `_meta["qwen.session.modelPersistDefault"]: false`。仍不经过网关、也不算这个会话的模型请求的：这个人自己配置的钩子（`prompt` 钩子可以点名模型）、网页搜索的模型（`tools.webSearch.model`）、`batch.model`、实验性的 Live Voice 与 omni，它们各有自己的地址或条目，Latch 没有改动。接线依据 0.26.8 与 0.27.3 的官方源码与文档；0.26.8 在没有登录的临时 HOME 下经三种协议各跑通一轮（2026-11-15，每个 CLI 在空的临时 HOME 下、不带任何登录，经临时 Host 与本地假服务各跑一轮：`apps/host/test/gateway-no-login.live.test.ts`）。假 Agent 与回放夹具是照源码读出来写的，不是录制。

goose 只用它文档里的环境变量，先于它的配置文件与钥匙串读取，所以不需要它自己的登录；1.57.0 在没有登录的临时 HOME 下经三种协议各跑通一轮（2026-11-15，每个 CLI 在空的临时 HOME 下、不带任何登录，经临时 Host 与本地假服务各跑一轮：`apps/host/test/gateway-no-login.live.test.ts`）。它标「实验性」有一个去不掉的原因：`delegate` 工具启动子 Agent 时，服务按「配方的 `settings.goose_provider`、环境变量 `GOOSE_SUBAGENT_PROVIDER`、调用参数 `provider`」的顺序取，带 `model` 的 agent 来源还会把模型自己传的 `provider` 写进配方设置（`crates/goose/src/agents/platform_extensions/summon.rs`）；这样的子 Agent 用这个人在 goose 里另外配置的服务（没有配置过就没有密钥、直接失败），按轮的核对发现不了。Latch 不给会话传 `_meta.provider`：goose 那样会改用该服务的默认模型而不是 `GOOSE_MODEL`（`crates/goose/src/model_config.rs`，真实运行里见到）。

Grok Build 的自定义模型只能写在用户配置里（[docs.x.ai/build/settings](https://docs.x.ai/build/settings)：`[model."<id>"]` 的 `base_url`、`env_key`、`api_backend` 为 `chat_completions`、`responses` 或 `messages`），没有另指配置文件的参数，所以经 Latch 的会话把 `GROK_HOME` 指向会话私有目录，里面只有 Latch 写的 `config.toml`（`[models]` 的 `default` 与 `web_search` 都是会话模型）。这个家里没有这个人的 Grok 登录、钩子、插件与 MCP；Grok 自己的会话记录也写在这里，随 Latch 会话删除。1.0.77 在没有登录的临时 HOME 下经三种协议各跑通一轮（2026-11-15，每个 CLI 在空的临时 HOME 下、不带任何登录，经临时 Host 与本地假服务各跑一轮：`apps/host/test/gateway-no-login.live.test.ts`）。它给会话起标题时用内置的 `grok-4.6` 向同一个地址发请求，网关以「不在这个会话的模型服务里」拒绝，Grok 改用截断的用户文字（真实运行里见到），不影响这一轮。接线依据是文档与这次运行，没有读它的源码，所以标「实验性」。

Codex 直连使用服务的模型列表，可以选择原生目录之外的模型；codex-acp 保留其已知模型限制。经网关的会话不能换服务，同服务内的模型可选。服务停用、删除、密钥或地址不再可用时明确失败，不回退到 Harness 自己的登录或演示模型。整轮没有经过网关时会如实提示和审计；这不证明每个辅助请求都经过它。订阅仍由各 Harness 自己使用，不借给网关。


## Codex 的 app-server

`wires/codex.ts` 运行 `codex app-server`（定义的参数之后加 `app-server`；定义的参数不能有 `app-server`、`exec`、`login`、`logout`、`resume`、`fork`、`review`、`apply`、`--help`、`--version`，保存时就拒绝，400 `agent-args-reserved`），一个进程一个会话（Codex 的 thread），把运行时说的 ACP 换成 Codex 的请求，把 Codex 的通知换成 ACP 的会话更新，所以运行时的检查（启动指纹、模式读回、审批、取消、项目配置）照旧适用。协议形状按 Codex 0.167 的 `codex app-server generate-ts` 核对。

- **握手与登录。** `initialize` 之后发 `initialized`；版本取自回答的 `userAgent`。开会话前先 `account/read`：没有账号且需要 OpenAI 登录时按未登录处理（409 `agent-auth-required`，「Codex 还没登录。按它自己的方式登录后重试。」），不开 thread。
- **会话。** 新会话 `thread/start`，恢复 `thread/resume`（`excludeTurns`）。只有 Codex 自己说没有这个 thread（`no rollout found for thread id`、`invalid session id`）时是「该 Harness 已找不到这个会话」；其他拒绝照原样（脱敏后）显示它的理由，接入已有会话时据此认出「正在别处使用」。会话带技能时，只读技能服务器经 thread 的 `config.mcp_servers` 交给 Codex。
- **一轮。** `turn/start` 带输入（文字；图片作 data URL；显式技能用官方目录中的 name/path）、模型、思考深度与当前模式的设置，等到 `turn/completed` 才结束：`completed` 正常结束，`interrupted` 算取消，`failed` 带 Codex 的原因失败。`item/agentMessage/delta` 与推理增量流式显示，`commandExecution`（输出增量）、`fileChange`（每个文件的 diff）、`mcpToolCall`、`webSearch` 显示为工具调用，`turn/plan/updated` 是计划，`thread/tokenUsage/updated` 是用量；`willRetry` 的 `error` 是一条「Codex 正在重试」的提示。运行中追加用 `turn/steer`（带当前一轮的 ID）。 `commandExecution` 条目自带 Codex 对命令的解析 `commandActions`（0.167 实测：开始与结束的条目都带；`read` 有 `name` 与绝对 `path`，`listFiles` 有 `path`，`search` 有 `query` 与 `path`，其余是 `unknown`；`cat a | wc -l` 这样的管道它只报告一项读取）。全部动作都是读取、列出或搜索时，Latch 把它们作为工具条目的可选字段 `actions` 带给客户端，有一项 `unknown` 或不认得的形状就不带；命令原文照旧保存。这个字段只从 Codex 线路接受，其他 Agent 发来的被丢弃；页面对带管道、重定向或多条命令的命令行不使用它（[STREAMING.md](STREAMING.md#工作过程的行)）。 推理摘要分段到达（`summaryIndex`）而段与段之间没有分隔，Latch 在换段时补一个空行，结算时的整条摘要也用空行连接，所以每段开头的加粗标题各占一行。
- **权限模式。** 四档与 ACP 路线同名、同说明，对照写在 `profiles/codex.ts`（改动时提高 profile 的 `version`），模式由 wire 保存，每一轮都随 `turn/start` 发出（thread 开始与恢复时也带上）：

  | 模式 | `approvalPolicy` | 沙箱 | 谁审 |
  | --- | --- | --- | --- |
  | `read-only` | `untrusted` | `readOnly`（不联网） | 人 |
  | `workspace-write` | `on-request` | `workspaceWrite`（项目的其他文件夹是可写根，不联网） | 人 |
  | `agent` | `on-request` | `workspaceWrite` | Codex 的审阅模型（`auto_review`） |
  | `agent-full-access` | `never` | `dangerFullAccess` | — |

- **审批。** `item/commandExecution/requestApproval` 与 `item/fileChange/requestApproval` 交给人，只有「允许」「拒绝」两个一次性选项（不提供 `acceptForSession` 与策略修改）：允许回 `accept`，拒绝回 `decline`（Codex 不做这一步，继续这一轮），没有回答（停止、停止之后才到的请求）回 `cancel`。卡片写出允许给的是什么：带 `networkApprovalContext` 的是「联网：<主机>」与「允许后，这条命令可以访问 <主机>（<协议>）」；命令写「允许后，这条命令在沙箱之外运行」（完全访问模式下只写运行这条命令）；改文件写允许写入的文件夹（`grantRoot`）。子 Agent（同一进程里的其他 thread）的审批标为它的，由运行时按会话自己的模式决定交给人还是拒绝并说明。
- **MCP 工具。** Codex 运行 MCP 服务器的工具前，用标了 `codex_approval_kind: mcp_tool_call` 的 elicitation 询问：这是一张普通的审批卡片，写「调用 <服务器>.<工具>」、参数与「允许后，Codex 调用 MCP 服务器「<服务器>」的工具「<工具>」一次」，允许回 `accept`，拒绝回 `decline`，没有回答回 `cancel`。0.167 的这个请求没有原生调用 ID：仅在当前轮同 threadId / turnId 下，已开始未结束、尚未被另一审批认领、服务器、工具与完整原始参数全部相同的调用只有一项时，共用其记录。它是内容关联，不是假称协议提供了调用 ID；并行同参、缺字段或旧轮请求保持独立记录和未知结果，不以名称配对。允许本身不结清执行；完成或失败仍由原生 item 事件报告，停止后的迟到回答不批准新一轮。MCP 调用与网页搜索同命令一样，看到结果才算运行。卡片上来自 Codex 的文字（主机、协议、文件夹、理由、命令、参数）都经过 `escapeSecurityText`，每个客户端都看到被显示出来的不可见字符。
- **不交给人的请求。** 要求更多权限（`item/permissions/requestApproval`，回空权限、只限这一轮）、MCP 服务器自己的 elicitation（不是工具审批的那些，回 `decline`）、旧式的 `execCommandApproval` 与 `applyPatchApproval`（回 `abort`）由 profile 当场回答：会话里写一行「已自动拒绝：…」（例如「已自动拒绝：Codex 请求联网。权限只随你在「权限」里选的模式变。」），并记审计 `task.approval-auto-rejected`（`harness-declined`）；会话还没记下时审计照记，这一行在会话记下时补进去。其他请求按「看不懂的请求」写进会话并回 method not found。
- **模型审阅与拒绝。** `agent` 模式下 Codex 的审阅模型代替人决定：`item/autoApprovalReview/started` 与 `completed` 成为一行「Codex 的模型审阅」（ID 以 `guardian_assessment:` 开头），带它的结论与理由，按「模型的判断」记录。命令与改文件先显示为等待，看到输出、完成或人允许了它才算运行（安静的命令允许后就是运行中）；Codex 报告 `declined` 而没有人回答过的调用，是它的审阅模型（带理由）或它自己的规则与沙箱拦下的，显示为「拦下」，从不记成「没有问你就运行」。
- **子 Agent。** 同一进程里其他 thread 的命令、改文件等调用显示为该子 Agent 的行，`agent` 模式下审阅模型对它们的决定也是该子 Agent 的「Codex 的模型审阅」行，同样记录；它们的文字回复不显示。
- **停止。** `turn/interrupt`，等 Codex 报告这一轮 `turn/completed`（`interrupted`，或以 `failed` 结束），并且这一轮开始的每条命令都报告了 `item/completed`，才算停下；`turn/start` 还没回答时，拿到这一轮的 ID 后立刻中断；这个 ID 会从 `turn/start` 的回答和 `turn/started` 各到一次，一轮只发一次 `turn/interrupt`。Codex 中断一轮后不结束它开始的命令（允许在沙箱外运行的也一样，0.167 实测），所以 wire 对会话的 thread 与这一轮报告过调用的子 Agent thread 各发 `thread/backgroundTerminals/list`，找到这一轮还在跑的命令逐条 `thread/backgroundTerminals/terminate`。2 秒内 Codex 还没报告结束时，Latch 读一次进程列表（`/bin/ps`，不带环境变量），按 Codex 列出的 `osPid` 结束那条命令；只有每条剩下的命令都是这个 app-server 的子孙进程、自成进程组、结束后整个进程组都已消失（`kill(-pgid, 0)` 为 ESRCH），才确认停止，没有结果的那条记为结果未知。进程列表读不到、`osPid` 不是这个进程的、或组长已退出而组还在时，不确认：等到取消的时限（30 秒），Latch 先结束 app-server 启动的、自成进程组的子孙进程，再结束进程，并写「取消未在 30 秒内完成，已强制结束 Codex 进程…」。审批被拒绝或因停止没有回答的命令不会运行，不等它。Codex 自己中断、Latch 没有要求停止的一轮同样先等它的命令；30 秒后仍没有结束证据时，Latch 强制结束 app-server，轮次标为「已中断」，那些命令的结果未知，不把 Codex 的中断通知当成命令已经停止。
- **模型。** `model/list`（最多 5 页）给出模型与各自的思考深度，与 ACP 路线同样的选项 ID；开始前读取用同一个程序的 `codex app-server`，不开 thread。
- **Codex 自己的 MCP 服务器。** 只读，只经 app-server 报告：Latch 从不读写 `~/.codex/config.toml`，不调用 `mcpServer/oauth/login`，不碰 Codex 的令牌。thread 开始或恢复后，wire 发一次 `mcpServerStatus/list`（带 `threadId`、`detail: toolsAndAuthOnly`，复用 thread 已有的连接，不启动新东西；最多 4 页、200 个），再跟随 `mcpServer/startupStatus/updated`（`starting`、`ready`、`failed`、`cancelled`；`failureReason: reauthenticationRequired` 是「需要登录」）；每次变化作为 Latch 自己的会话更新 `_latch_mcp_status` 交给运行时，运行时把它记为这个 Harness 的最近报告（`HarnessInfo.ownMcp`，只在内存里，换了定义就作废），不进会话文字。线程配置里 Latch 自己的服务器（`latch-skills`、`latch-browser`、各 `latch-mcp` 桥）按名字排除。「读取」（`POST /link/api/agents/:id/mcp`，`run`，与开始会话同一道门；审计 `agent.mcp.requested` 与 `agent.mcp.read`）在 Host 临时目录下新建的空文件夹里启动 `codex app-server`，不开 thread，发不带 `threadId` 的 `mcpServerStatus/list`（整个读取、各页合计最多 60 秒），然后停止进程；可能启动它配置的服务器，所以只在人按下时读，从不定时。Codex 0.167 不带 thread 时只列出配置里的名字，不给 `runtimeStatus`，也不列插件在 thread 里加上的服务器：这时报告标 `namesOnly`（状态都是 `unknown`，不带工具数），设置页只列名字，ⓘ「开一个会话后才有状态」；已有会话的报告时，只有名字的读取不覆盖它。每个服务器只留名字（不可见字符被写出来）、状态、工具数与 `httpOrigin` 的源；Codex 报告需要登录、且名字只有字母、数字、`-` 与 `_`、不以 `-` 开头时，给出可复制的 `codex mcp login <名字>`。见 [MCP.md](MCP.md#harness-自己的-mcp)。
- **接入已有会话。** `thread/list` 列出，`thread/resume` 载入后 `thread/read`（`includeTurns`）重放说过的话、回复与工具调用；Latch 从不读 Codex 自己的文件夹。
- **模型服务与分叉。** 经 Latch 的 Responses 服务使用自定义 provider，见[模型网关](MODEL-GATEWAY.md)；分叉仍沿用文字记录，尚未使用 Codex 的 `thread/fork`。

## pi 的 RPC 模式

pi 不经适配器：`wires/pi.ts` 启动 `pi --mode rpc`（这两个参数接在定义的参数后面，启动预览里也列出），把运行时的 ACP 方法换成 pi 的命令，把 pi 的事件换成 ACP 的会话更新，所以启动指纹、项目配置、取消、审批与持久化和其他 Harness 是同一份代码。依据 pi 自己的 `rpc-types.ts`、`rpc-mode.ts` 与 `docs/rpc*.md`、`docs/json.md`。

- **版本与参数。** 需要 pi 0.84.4 或更高：一轮以 `agent_settled` 结束，`message_update` 只带增量，停止前能清空队列。pi 的 RPC 不报告版本，所以进程启动时 `get_state` 之后先发一次 `clear_queue`（刚启动的进程没有排队的内容）：pi 答「Unknown command」时它早于 0.84.4，会话与测试启动都拒绝并写「pi 的版本低于 0.84.4（它不认识 clear_queue），已拒绝启动。升级到 0.84.4 或更高版本后再试。」（409 `harness-version-unsupported`），不会开会话，也不会停在一轮永远不结束的运行里。pi 1.5 的 RPC 与 0.84.x 相同（公开 changelog 中 1.0 到 1.5 的不兼容改动都在扩展与界面，不在 RPC）：在临时 HOME 下对 1.5.0 做的不调用模型的握手里，`get_state`、`clear_queue`、`get_available_models`（没有登录时为空，按未登录处理）、`get_available_thinking_levels` 的形状不变；它在回答第一条命令前先发一条 `queue_update` 事件，`new_session` 的回答可能晚于其后发出的命令，wire 按 `id` 对应，忽略不认识的事件（假 pi 以 `FAKE_PI_SHAPE=1.5` 重现）。定义的参数不能有 `--mode`、`--print`/`-p`、`--session`、`--session-id`、`--no-session`、`--continue`/`-c`、`--resume`/`-r`、`--fork`、`--export`、`--list-models`、`--help`/`-h`、`--version`/`-v`，这些决定协议和会话，保存时就拒绝（400 `agent-args-reserved`）。
- **会话。** pi 启动时就有一个新会话；`get_state` 报告的会话文件就是 Latch 记下的会话标识。恢复用 `switch_session` 切到这个文件，再用 `get_state` 核对，不是同一个文件就是「该 Harness 已找不到这个会话」。pi 没有删除会话的命令，删除 Latch 的会话时留下 pi 自己的副本。pi 不接收 MCP 服务器。
- **权限扩展。** 启动追加 Latch 私有 0600 `latch-permission.ts`（`-e`），profile 版本计入指纹。默认 ask：read/grep/find/ls 不问，其余调用先问；plan 拦截所有非读取，rule 直接允许 edit/write、其他先问，never 直接允许。wire 通过私有命令换档，并只接受 `get_commands` 报告的完整扩展路径与本次进程的状态回报；用户提示不能直接调用该控制命令。扩展拒绝或询问失败不执行调用。其他可信扩展仍可在工具回调之外运行代码，这不是隔离。
- **模型与思考。** `get_available_models` 列出模型（值写作 `provider/model`），一个都没有说明 pi 还没有可用的登录或密钥，按未登录处理；`get_available_thinking_levels` 列出当前模型的思考深度，换模型后重读，读回 `get_state` 才算换好。列表只在人点「读取 pi 的模型列表」时读，因为 pi 启动时会加载这个人的扩展、运行会话钩子。
- **一轮。** `prompt` 发出这一轮，等到 `agent_settled` 才结束，然后读 `get_session_stats`：这个会话的输入与输出令牌、上下文占用和花费（美元）。回复以 `error` 结束时这一轮失败，写 pi 给的原因；以 `length` 结束时按达到长度上限处理。扩展把这条输入当作自己的命令处理（`handled`）时这一轮立即结束。
- **停止。** 先 `clear_queue` 再 `abort`：不清空队列，`abort` 会接着处理排队的追加。清掉的追加内容写进会话：「pi 提示：停止前追加的内容还没送到 pi，已撤回」。
- **运行中追加。** pi 在跑这一轮（`agent_start` 到 `agent_end`）时用 `steer` 加进去，pi 在手上的工具调用结束后、下一次请求模型之前读到它；其他时候交回 Host 排队。
- **`/compact`。** pi 的 RPC 不列出它自己界面里的 `/compact`，当作文字发出去会交给模型，所以会话第一轮开始时 Latch 把它列为 pi 的命令（「把之前的对话总结成摘要，腾出上下文；可以在命令后写总结时要注意什么」）。一条消息只有 `/compact`，或 `/compact` 后跟空白和说明、不带图片时，发 pi 的 `compact` 命令（说明放在 `customInstructions`），不发 `prompt`。这条消息留在记录里，作为一轮运行：pi 的 `compaction_start`、`compaction_end` 成为已有的压缩行（「pi 已压缩上下文」加摘要，「pi 压缩上下文失败：原因」，或「pi 已取消压缩上下文」，pi 自己加在原因前的 `Compaction failed: ` 去掉），pi 回答 `compact` 时这一轮结束；pi 报告了压缩时，压缩失败或被扩展取消都不让这一轮失败，还没报告压缩就拒绝时这一轮失败并写 pi 的原因（遮住像密钥的部分）。停止照常先 `clear_queue` 再 `abort`，pi 会中止压缩，这一轮是已停止。之后的上下文占用未知，直到下一条回复，因为 pi 在压缩后不报告它。pi 压缩前会先中止手上的事，所以 `/compact` 只在两轮之间：它的命令带 `idleOnly`，运行中斜杠菜单保留置灰，排队、把排队的消息改成它或追加时 Host 拒绝（409 `command-queued`，「/compact 不能排队或追加，请等本轮结束后发送。」），线也不把它当作追加。pi 自己的扩展、提示模板与技能命令来自 `get_commands`，见「会话命令」。
- **工具与其他事件。** `tool_execution_*` 成为工具行：`bash` 是命令，`read` 是读取，`edit`、`write` 是改文件，`grep`、`find`、`ls` 是搜索，`edit` 的 diff 以文本显示。压缩成为压缩行；自动重试、扩展的通知与扩展出错成为通知。模型服务的错误可能带出一段密钥：pi 转来的失败回复、重试原因、压缩失败原因与扩展出错都先遮住像密钥的部分。
- **扩展的提问。** 扩展的 `confirm` 像审批一样交给人，选项是「允许」「拒绝」；`select`、`input`、`editor` 按「不支持的请求」写进会话，并回答 pi「已取消」。
- **分叉。** 从一个 pi 会话分叉到同一个 pi 定义、同一个文件夹时（「从这里分叉」与「从这里编辑」都是），Latch 用 pi 自己的会话文件分叉：新会话带着 pi 到那一轮为止的原样记录，第一条只发人写的话，不发背景文本（`HarnessCapabilities.fork: 'native'`，见 [ARCHITECTURE.md](ARCHITECTURE.md#会话分叉)）。做法：新会话的进程 `switch_session` 到来源的会话文件，`get_entries` 读出记录，沿 pi 所在的分支找来源下一轮开始（那条用户消息记下的时间）之后的第一条用户消息，`fork` 在它之前；分叉点就是最新一轮时 `clone` 整条分支。Latch 在上一轮结算之后才开始下一轮，所以这个时间之前写下的都属于分叉点及以前；pi 与 Host 在同一台电脑上用同一个时钟。分叉后用 `get_entries` 从预期的最后一条往后读，核对 pi 复制出的新文件正好停在那里（pi 复制时保留条目 ID；之后只能有设置、标签之类模型看不到的条目）。分叉在发送时才做，而且只在第一轮做：第一轮在 pi 打开会话之前就结束了（停止、进程没能启动）时，下一轮像其他新会话一样开始，不再分叉，也不写分叉的原因；背景文本只在第一条消息里，重试第一轮会连同它一起重发，另写一条新消息则不带。pi 的 `fork` 返回的那条消息文字不用：「从这里编辑」已经把 Latch 记下的原文放进输入框，pi 的文字里还有 Latch 附加的指令块与文件引用。做不到时退回背景文本，并在新会话里写一行「pi 没有用它自己的记录分叉：<原因>。这次以文字带上来源会话到这一轮为止的记录。」：不在来源的文件夹里、分叉点之后清空过上下文、来源会话文件已不在（pi 打开不存在的文件得到空会话，`get_entries` 没有记录）、下一轮开始之后的压缩（例如 `/compact`）会被带进来、扩展取消了 `switch_session` 或 `fork`、pi 拒绝命令或复制出的文件没有停在那一轮。退回前进程先 `new_session` 离开来源（这一步也被扩展取消时停止进程），Latch 的会话不会在来源的文件上继续，分叉也不往来源的文件里写（pi 的扩展在打开会话时自己写的除外）。已知限制：系统时钟在两轮之间往回拨时，按时间找到的位置可能错一轮，核对只能确认 pi 停在了所要求的条目上。

## 通知与压缩

- **通知（`notice`）。** Agent 不属于对话历史的提示，例如 Codex 的配置警告。每条在时间线上一行系统消息：「Codex 警告：……」，`severity` 为 `error` 时写「报告错误」，其他写「提示」，`description` 另起一行。它不改变本轮状态，也不让本轮失败。
- **压缩（`compaction_update`、`compaction_summary_chunk`）。** 一次压缩一行，按 `compactionId` 找到同一行并就地更新：「正在压缩上下文……」「已压缩上下文」「压缩上下文失败：原因」「已取消压缩上下文」；Agent 给出的摘要接在后面。行的位置是第一次报告到达时，在它之前的回复先结束。压缩失败不让本轮失败。
- **重试。** profile 的 `readRetry` 把 Agent 标明的重试读成一行系统消息「<Harness> 重试：<原因>」，第二行「第 n 次重试，最多 m 次」，不进思考；回复中途断开、从头重新生成时，已经收到的文字丢掉，重新生成的文字接在同一条消息里（消息 ID 不变），已经收到的思考保留。原因先遮蔽像密钥的部分，最多 300 字。目前没有预设声明 `readRetry`，其他 Agent 的 `_meta` 不解释。
- **各家说法不同的地方。** profile 的 `normalizeUpdate` 把 Agent 自己的说法换成 ACP 的，只换不添：Qwen Code 只在 `_meta.toolName` 里给出工具名，填进 `name`；OpenCode 把回复的思考放在推理片段的 ID 下，会把一条回复拆成两条，去掉这个 ID 后思考归入它所属的回复。调用的 `kind` 只是 `other` 时用它的标题命名（DeepSeek Harness 的 `bash`）。
- **用量。** `session/prompt` 的 `usage` 只取 `inputTokens` 与 `outputTokens`。缓存与思考的令牌数各家含义不同：Codex 的输入含缓存读取，OpenCode 的不含，所以不映射。

## 登录

Latch 从不替人登录，不调用 `authenticate`，不读凭据文件或钥匙串。它只运行程序自己的命令，并听 Agent 自己怎么说。

- **Agent 声明的终端登录。** `initialize` 声明 `clientCapabilities.auth.terminal: true`（写了 `signIn` 的预设除外，见下），Agent 于是可以在 `authMethods` 里列出 `type: "terminal"` 的方法（如 OpenCode 2.x 的 `opencode acp --login`）。会话、读取可选项与「测试启动」的握手都记下这些方法，以及宣告它们的程序路径（`src/auth.ts`，只在内存）。方法本身不能指定程序：登录时运行的就是会话运行的那个程序，加定义的参数，再加方法的 `args`；方法的 `env` 只接受普通变量名，点名 Latch 设置或清除的变量（`PATH`、`NODE_OPTIONS`、`DYLD_*`、`CODEX_HOME` 等）的整个方法丢弃，参数与变量有数量和长度上限。打开终端之前重新查找程序，路径和宣告时不同就拒绝（409 `login-program-changed`）。定义自己的环境变量不写进登录脚本，因为里面可能有密钥；脚本在终端自己的环境里运行，结束时按退出码说完成或没有完成。Agent 列了方法时，页面用它们代替预设的命令。
- **预设的命令。** Agent 没列方法时用 `AgentPreset.login`（`codex login`、`opencode auth login`、`goose configure`、`cursor-agent login`；pi、Qwen Code 是进入程序后按说明操作；DeepSeek Harness 没有记录）。Codex 没单独安装时用适配器自带的 `codex-acp cli login`。经 `HarnessInfo.login` 发给客户端。
- **Claude Agent。** 预设写了 `signIn`：Latch 不对它声明 terminal auth（适配器于是不列出 claude.ai 登录），也不运行它列出的任何登录；说怎么登录时，页面只给出 `signIn` 这句话，没有登录命令，也没有「在终端里登录」。页面显示它报告的登录状态、标签与到期日（见下）；适配器宣告 `logout` 时也显示「退出登录」，之后要在 Claude Code 里自己重新登录。Latch 不读取它的凭据。
- **Agent 推送的状态。** 经 codex-acp 的 Codex 与 Claude Agent 的适配器推送 `_auth/status_update`（以 `agentCapabilities._meta.authStatus` 宣告）：`initialize` 之后一次，之后只在内容变化时。Codex 的适配器把 Codex 的 `account/updated` 转成推送，在别的终端里登录或退出也会推送。Claude Agent 的只在 `initialize`、建会话与每轮开始时重新读取登录，所以进程空闲时，别的终端里的登录或退出要到下一轮才推送，在那之前推送可能是旧的。Latch 只读 `kind` 与 `label`：`none` 是未登录，`account`、`api_key`、`gateway`、`external` 是已登录，其他是 `unknown`；`label` 显出不可见字符、遮住像密钥的部分、最多 80 字，含 `@` 的整个不用。`account`（email、组织、套餐）在解析时就丢掉，不进内存里的记录、日志、SSE、快照或磁盘。推送只在发出它的进程还在时算数，进程退出就忘掉，回到状态命令。`HarnessInfo.login.reported` 把它发给客户端。
- **三态。** `POST /link/api/harnesses/:id/login-status`（`run`，可带 `fresh`）返回 `{ status, label?, expiresAt? }`，`status` 是 `authenticated`、`unauthenticated` 或 `unknown`。有正在运行的进程推送过、而状态命令说不出推送没有的东西时，直接用推送，不运行程序；否则运行状态命令。Codex 的命令是 `codex login status`：退出 0 算已登录；退出 1 且文字是 `Not logged in` 才算未登录，它的其他错误也退出 1，所以都算 `unknown`。Claude Agent 的是适配器自带 CLI 的 `claude-agent-acp --cli auth status --json`：只读 `loggedIn`、`apiKeySource`、`apiProvider` 与 `loginExpiresAt`，claude.ai 登录、密钥或其他服务都算已登录，存下的登录到期日期（ISO 字符串或秒、毫秒数，不合理的丢掉）作为 `expiresAt` 返回；有推送时它仍运行，因为推送里没有日期，而且可能是旧的。两者都有时较新的说了算：命令运行之后推送变了，用推送；否则用命令的明确结论，命令说不清时用推送。标签只取推送的，日期只取命令的，各自只在结果与它的来源都说已登录时给出。页面对 Host 的回答也这样：提问之后到达的推送比回答新，否则显示回答，所以「重新检查」显示的是程序刚说的。超时 10 秒。输出只在判断时读一次，可能含账号或部分密钥，不返回、不记录。其他 Harness 始终 `unknown`，要到 `session/new` 被拒绝才知道。结果缓存 30 秒；「测试启动」读到的明确登录状态与缓存不同，或测试结束时还有检查在运行，缓存作废，下一次提问重新运行状态命令（`agent-login.ts` 的 `probed`）。每次实际运行之前写审计 `agent.login.requested`（写不进就不运行），结束后写 `agent.login.checked`，只含 ID 与状态。「测试启动」的结果带 `login`：宣告了推送的 Agent 在握手后最多等 5 秒，收到就不再运行状态命令。页面打开期间完成的测试启动说的与「登录」一组显示的不同时，这一组带 `fresh` 再问一次；页面只显示最后一次提问的回答。
- **页面。** 选中 Harness 时检查一次，窗口回到前台时再查；新会话上方只在 `unauthenticated` 时显示登录说明，登录在 10 天内到期时显示琥珀色的「<Harness> 的登录 M 月 D 日到期」，都不挡发送，因为程序才说了算。没有状态命令的 Harness（预设里除 Codex 与 Claude Agent 之外的每一个，`login.checkable` 为空）问不了：读它的模型列表被它以没登录拒绝时（`catalogueRead.last.loginRequired`，见「开始前读取」），新会话上方显示同一行登录说明（命令、复制、这台 Mac 上的「在终端里登录」），模型菜单里只写琥珀色的「还没登录」；这一行的「重新检查」重新读一次列表，读到了就消失，登录命令以 0 结束后只有选中时自动读取的 Harness 会自己再读；之后有运行中的进程报告已登录、或有会话带着它的列表开始，也不再显示。一轮被拒绝后在这一轮的结尾显示命令和「重试」；在这一行里登录、Harness 自己回答已登录之后，这一行只剩「已登录」与「重试」，不再写「还没登录」和登录命令，消息仍由人按「重试」发出，这一轮在记录里仍是失败；下一轮启动新进程，读到新的登录。「设置 › Harness › <名称>」有「登录」一组：状态（已登录时带 Agent 的标签与到期日）、「重新检查」、没登录时的登录方式，已登录时的「退出登录」或「换账号」。状态命令说已登录、最近一次测试启动却说还没登录时（例如存下的登录不再被接受，握手被拒绝），这一组写「登录可能已失效」并列出登录方式，直到测试启动不再这样说。
- **退出登录。** Agent 宣告 `agentCapabilities.auth.logout` 时才显示。`POST /link/api/harnesses/:id/logout`（`run`，空请求体）先写审计 `agent.logout`（写不进就不做），再在私有空文件夹里起一个进程调用 ACP `logout`，然后停掉它；这个 Harness 有会话正在运行时拒绝（409 `harness-busy`），没宣告时 409 `logout-unsupported`。之后停掉能恢复会话的空闲进程，下一轮读到新的登录；不能恢复的进程留着，带着它启动时读到的登录。Agent 的登录可能被这台电脑上别处共用，确认框写明这一点。
- **终端。** `POST /link/api/harnesses/:id/login-terminal`（可带 `method`，即 Agent 声明的方法）只接受 `host.sock` 与 `run`。命令由 Host 从 Harness 的定义得出，调用方不能指定。写审计 `agent.login.opened`，运行 Agent 声明的方法时带 `source: 'harness'`。
  - 请求带 `terminal` 时在 Latch 自己的终端里运行（`features.terminal`：这台电脑、`run`、数据范围 `all`、组件可用）：会话里是这个会话「终端」页签中以 Harness 命名的一个终端，没有会话时是一个不属于任何会话的终端，在对话框里。命令结束后 Host 丢掉记住的登录状态，页面在它以 0 退出后重新检查；被拒绝的那一轮不自动重发，仍按「重试」。规则见 [TERMINAL.md](TERMINAL.md#登录命令)。
  - 不带时用这台电脑默认的终端（`features.loginTerminal`，仅 macOS）：Host 写一个 0700 的 `.command` 临时文件交给 `open`，用这个人默认的终端和它自己的环境运行程序的绝对路径；脚本先删除自己。页面只在 Host 不给这台设备 Latch 终端时走这条路：组件缺失，或这个窗口的数据范围是 `work`。
  - 其他设备（手机、远程浏览器、其他电脑）两个都没有，只看到命令和「在这台 Mac 的终端里运行」；macOS 以外的 Host 上终端与默认终端的路径都尚未实现，同样只有命令。Claude Agent 没有登录命令，也就没有按钮。
- **测试 Host。** `startServer` 没有 `loginPrograms` 时不运行任何登录命令，也不显示命令；没有 `commandDirectories` 时只认绝对路径，按名字找命令一律找不到（Agent 的命令、适配器、`programEnv` 指向的程序与预设检测都一样）。只有启动脚本传 `resolveCommand` 与 `personCommandDirectories`。这样带预设定义和假适配器的测试 Host 碰不到同一台电脑上真实安装的程序；测试要找命令时把自己的临时目录传给 `commandDirectories`。

## 额度

Harness 用自己的订阅登录时，Latch 把它自己的程序报告的额度显示在输入框的控件之后、发送之前（它在会话开始几秒后才出现，放在最后不挪动别的控件）：一个小环加用得最多的那个窗口的百分比；悬停一行（「每周额度已用 68% · 5 天 23 小时后重置」，窗口的叫法与面板里那一行相同）；点开列出每个窗口的格条、百分比与重置时间，下面是套餐与遮住的账号（手机上是底部面板）。一点没用、离重置正好还有一整个窗口的窗口还没开始计，不写重置时间。80% 起是琥珀，到上限是红，都带数字。Latch 只听它已经为会话运行的那个进程：不读任何 CLI 的令牌或存储，不自己调用厂商接口，不为额度启动进程，不发模型轮次，不定时轮询。

| Harness | 来源 | 显示 |
| --- | --- | --- |
| Codex（app-server 直连） | 会话的线程打开后在同一进程上发一次 `account/rateLimits/read`（带 `excludeResetCreditDetails`）与 `account/read`，之后每轮的 `account/rateLimits/updated` 按 Codex 的说明并入（稀疏更新不清除已知的值） | 套餐自己的桶（`rateLimitsByLimitId.codex`，没有时用 `rateLimits`）的两个窗口：`windowDurationMins` 为 300 的是「5 小时」，10080 的是「每周」，其他长度按分钟数显示，没有长度的不显示；`resetsAt`（秒）、`planType`；ChatGPT 登录的邮箱遮成 `n•••@f•••.com`。按模型的其他桶不显示（名字是 Codex 起的文字）。经 Latch 使用模型服务的会话不读也不显示 |
| Codex（经 codex-acp） | 适配器不转发 | 不显示 |
| Claude Agent | 适配器放在 `usage_update._meta["_claude/rateLimit"]` 里的限额事件，以及一轮因限额失败时错误 `data` 里的 `{ errorKind: "rate_limit", rateLimit }` | 没有常驻的百分比：只在某个窗口 `allowed_warning`（琥珀）或 `rejected`（红）时显示警告标记与重置时间，同一窗口再报 `allowed` 就消失。只认 `five_hour`、`seven_day`、`seven_day_opus`、`seven_day_sonnet`；`utilization` 不用（不一定有，刻度没有文档）。Latch 不自动发送 `/usage`，也不解析它的文字 |
| Grok Build | ACP 扩展请求 `_x.ai/billing`（Grok 自己的 `/usage` 用的那个），在会话接上进程时与每轮结束时发，两次之间至少 5 分钟；经 Latch 使用模型服务的会话在自己的 `GROK_HOME` 里没有登录，不问 | 本计费周期一行（`creditUsagePercent`、`currentPeriod.end`），不是 5 小时或每周；`subscriptionTier` 在已知集合里时显示；`prepaidBalance`（分）大于零时显示为余额 |
| Antigravity | 它自己的命令 `agy -p /usage --output-format json`（`profiles/antigravity-quota.ts`；在 agy 1.5.8 上确认：不提问、约 6 秒退出、`num_turns` 为 0、不起模型轮次），在会话接上进程时与每轮结束时在旁边运行，两次之间至少 5 分钟，不等它；按登录状态命令的规则运行（只在启动脚本允许 Host 运行本机程序之后、Harness 的环境加 `AGY_CLI_DISABLE_AUTO_UPDATE=true`、不经 shell、没有输入、20 秒后连同进程组结束），失败不说任何话 | `command.data.groups[].buckets[]` 的 `remaining_fraction` 是剩余比例，已用是 1 减它；`window` 只认 `5h` 与 `weekly`，`reset_time` 是重置时间。只显示两个通用的组，面板里各成一节：「Gemini 模型」（`Gemini Models`）与「Claude 与 GPT 模型」（`Claude and GPT models`），小环取其中用得最多的窗口；单个模型的组与不认识的组整个丢掉，不显示它们的名字；`num_turns` 不为 0 或形状不同的输出整个不用 |
| Cursor、OpenCode、Qwen Code、goose、pi、DeepSeek Harness | 它们的程序不报告订阅额度 | 不显示，也没有占位 |

- **形状。** `HarnessInfo.quota`（`packages/protocol/src/quota.ts`）：`windows`（`kind`、`group?`（分开计量的模型组，固定集合）、`usedPercent?`、`resetsAt?`、`windowMinutes?`、`state?`）、`plan?`、`account?`、`balanceCents?`、`state`（`ok`、`near`、`limited`）、`observedAt`。全部是数字与固定集合里的值，没有厂商写的文字：不认识的窗口种类整个丢掉，不在集合里的套餐名不显示（`packages/harness-acp/src/quota.ts` 的 `harnessQuota`）。Codex 的 `rateLimitUpsell`、`limitName`、`accountId` 与完整邮箱不离开读它的进程；邮箱在读到时就遮住，只留两边的首字符与最后一段。
- **只在内存里。** 按 Agent 定义保存在驱动里，不写磁盘、日志与审计。窗口过了重置时间就不再显示（页面也按自己的时钟隐藏）；报告它的进程退出后，有重置时间的窗口留到重置为止，因为额度属于账号；没有重置时间的随进程一起消失。退出登录、定义变化（命令、参数、环境变量）后全部清除。同一个窗口以最新的报告为准。
- **谁能看到。** 随 Harness 目录（快照的 `catalog.harnesses`）发给能看到这个 Harness 的设备，没有单独的接口与权限；没有凭据的请求拿不到目录。内容变了才推送。
- **不显示的时候。** Harness 什么都没报、所有窗口都已重置、会话经 Latch 使用模型服务（订阅的额度不是它的），都不画任何东西。经模型服务的会话也不读、不问、不记：Codex 不发 `account/rateLimits/read`，Grok 不发 `_x.ai/billing`，Claude Agent 的限额事件不读。
- **到上限。** 百分比到 100、Claude 报 `rejected`、或 Codex 的 `rateLimitReachedType` 不为空时是 `limited`。Latch 不因此拦截发送：能不能继续由 Harness 自己决定，被拒绝的一轮照常显示它的错误。

## 权限菜单

有 profile 的预设给每个模式一个档位和一句话（`modeTiers`），随 `HarnessInfo.permission` 与 `TaskDetail.permission` 发给页面与 iPhone。档位从严到宽是「只看不改」（`plan`）、「先问你」（`ask`）、「按规则放行」（`rule`）、「由模型判断」（`model`，Agent 自己的模型代人决定）与「不再询问」（`never`）；菜单的标题用档位词（Cursor 保留官方名称），「权限说明」按需展开这个 Harness 在每一档实际怎么做：

| 预设 | 只看不改 | 先问你 | 按规则放行 | 由模型判断 | 不再询问 |
| --- | --- | --- | --- | --- | --- |
| Codex | — | `read-only` | `workspace-write` | `agent`（Codex 的 Auto review，直连与经 codex-acp 都有：沙箱同 `workspace-write`，本来要问的由 Codex 的审阅模型放行或拦下，不转给人） | `agent-full-access` |
| Qwen Code | `plan` | `default` | `auto-edit` | `auto`（用户自己的允许规则、只读工具与项目里的文件编辑先放行，`.git`、`package.json` 等会影响之后运行的文件除外；其余由它的分类器判断，判断不了时问） | `yolo` |
| goose | `chat` | `approve` | — | `smart_approve`（工具声明或模型判断为只读的不问，其余问） | `auto` |
| OpenCode | `plan`（不改文件、不运行命令） | `build` | `auto-edit` | — | `yolo` |
| pi | `plan` | `ask` | `rule` | — | `never` |
| DeepSeek Harness | `read-only` | — | `workspace-write` | — | `danger-full-access` |
| Cursor | `ask`、`plan`（按官方名称） | `agent` | — | — | `agent-force`（启动参数） |
| Claude Agent | `plan` | `default` | `acceptEdits` | `auto`（Claude 的分类器） | `bypassPermissions` |

没有匹配预设的定义按 Agent 自己报告的模式与说明列出，没有报告时写「权限无法确认」。Agent 报告了表里没有的模式时，菜单不列它，除非会话正处在这个模式，那时用 Agent 自己的名字显示。

- **三行。** 模式超过三个时，菜单只列「先问你」、一个中间档（有「由模型判断」用它，否则「按规则放行」）与「不再询问」，其余（只看不改、另一个中间档）收在「更多」里；当前的模式总是列出。「不再询问」的标题、说明与触发器是琥珀色，「由模型判断」不是。
- **谁能选。** 任何有 `run` 的设备都能选任何一档，不弹确认，放宽写 `task.mode.widened`。
- **默认。** 会话总从预设的预期模式（「先问你」或更严，dsh 默认只读）开始，Latch 自己从不选更宽的一档。设备记住人在草稿里为每个 Harness 选的模式与其他选项，下一个草稿照用，换到别的 Harness 再换回来也还在。分叉的草稿用来源会话当时的模型、思考与模式，而不是这台设备记住的；模式是 Latch 让来源会话保持的那一档（`permission.expectedMode`，人选的），不是 Harness 报告的、它自己换到的那一档，所以设置被 Harness 自己改了之后的「在新会话中继续」仍从人选的档位开始，Latch 不知道人选的档位时从目标 Harness 的默认模式开始并写明。具体是：还是同一个 Harness 时照原样带上（经 Latch 转发到保存的服务的，带上那个服务与模型）；换了 Harness 时，模型与思考按同样的值带上，模式按档位找同一档，没有这一档时用比它严的最宽一档，比它严的也没有时用最严的一档；来源没有模式或档位对应不上时从 Harness 的默认模式开始，来源只对话、不读写文件而目标 Harness 没有这种方式时也是如此；档位对应不上、模式被 Harness 自己改过与来源只对话这三种情况在分叉说明里各写一行。草稿里写明哪些没有沿用（「没有沿用来源会话的模型「Large」：goose 在这里不能选。」「来源会话的权限是「按规则放行」，goose 没有这一项，这里用更严的「先问你」。」）；目标 Harness 的选项还没读到时（读取中、读取失败，或像 pi 那样要人去读），还不知道它有没有这些，草稿不说没有沿用，只写「来源会话的模型「Large」、思考「High」与权限「按规则放行」要等读到 goose 的选项后才能沿用。」，读到后换成上面的说明；人仍可以在草稿里改；分叉草稿里选的模型、思考与模式只用于这一份草稿，不写入设备记住的选项。
- **模型的判断。** Codex 报告自己的模型审阅一次请求（直连时 wire 把 `item/autoApprovalReview/started` 与 `completed` 换成同样的一行，见「Codex 的 app-server」；以下字段是 codex-acp 的）：ID 以 `guardian_assessment:` 开头、类别为 `think` 的工具调用，`rawOutput`/`rawInput` 带 `review.status`（`approved`、`denied`、`timedOut`、`aborted`）。这一行在时间线上写「Codex 的模型审阅」与「放行」「拦下」或「没有判断」（`ToolDetail.judged`），它的文字是 Agent 自己的、不可信的输出；它不是人的批准，没有决定记录，被拦下的在 Latch 里不能改为允许（codex-acp 没有改判的方法）。Claude Agent 只报告它拦下的调用：适配器把这次调用报为 `failed` 的 `tool_call_update`，内容是「Permission denied: <理由>」，`_meta.claudeCode.toolResponse` 带 `decisionReasonType` 与理由（`decisionReason`，没有时是 `message`）。来源是 `classifier`（它的自动模式询问的模型）时，这一行仍是那次调用本身，写「拦下」，下面一行「Claude Agent 的模型审阅：<理由>」；会话在「由模型判断」档时它带 `ToolDetail.judged`（`denied`）并记录。来源是 `rule` 或 `mode` 时写「拦下」与「被 Claude Agent 自己的规则或当前模式拦下：<理由>」，提示说模式拦下的在「权限」换一档后可以放行、规则拦下的要改 Claude Agent 自己的权限设置；在任何档都这样，不算模型的判断，不记录。两种都放在 `ToolDetail.blocked`（`by`、`source`、`reason`），不显示成失败；理由是 Agent 的不可信文字，Host 遮住像密钥的部分（与重试、压缩失败的原因一样）并限 1000 字，行下只显示第一行的前 120 字，没显示全的在展开这一行后的细节里完整显示（适配器之后发的失败结果会替换掉内容里的理由）。折叠的一轮写「模型拦下 N 次」「规则拦下 N 次」，不算失败的步骤。其他来源（钩子、安全检查等 Latch 叫不出名字的）照旧是一行失败；问过人的调用、已经开始运行的调用不算 Claude 自己拦下的。`classifier` 这个取值来自适配器注释对来源的称呼，它的测试里没有出现，也还没有在真实的自动模式下见过；取值不同时这些调用照旧是失败，不会被说成模型的判断。不报告判断的 Harness（Qwen Code `auto`、goose `smart_approve`）与不报告放行的 Claude Agent `auto`，在「由模型判断」档里没有问人就运行的调用写「没有问你」，不说是模型放行的，因为也可能是它自己的规则。
- **记录。** 每个审阅结论、每个被模型拦下的调用（来源 `agent-report`）、每个这样没问就运行的调用写一条 `task.tool.judged`：`callHash`、`modeHash`、类别、结果（`approved`、`denied`、`timed-out`、`aborted`、`unknown`、`ran-unasked`）与来源（`agent-report` 或 `no-ask-seen`），只有哈希与枚举，不写 Agent 的文字。这是事后的记录，不是关口；写不进去时取消这一轮并写明「Latch 没能记下一次由 <Harness> 的模型代你决定的调用，已取消本轮。」。

## 权限模式

权限模式被放宽时 Latch 停止该会话。这一轮读不回权限模式时（`permission-unverified`）没有发送任何内容，输入框保持可用，页面提供「在新会话中继续」（带上没有发出的文字）；有东西可发时还提供「重试」，警告在真正再次发送时才消失。切换模式时读不回同样如此，只是页面写的是确认不了是否切换。

## 映射

| ACP | Latch |
| --- | --- |
| `agent_message_chunk` | 流式正文与 `liveMessageId`；消息 ID 为 `msg:<messageId>` 或首个片段时生成的 UUID，结算后保持不变 |
| `agent_thought_chunk` | `liveReasoning`，结算到消息的 `reasoning` |
| `tool_call` / `tool_call_update` | 工具消息 `tool:<轮次>:<toolCallId>`，状态 pending/in_progress/completed/failed → queued/running/completed/failed；参数、输出、位置与 diff 进入 `tool`。diff 的 `oldText` 明确为 `null` 时记为 `previous: 'none'`（新文件），为字符串时记为 `'text'`，缺少时不设置 `previous`（界面显示「原内容未知」） |
| `session/request_permission` | 审批（提示性质，`advisory: true`、`risk: 'R2'`），只含过滤后的选项；`toolCallId` 为 `<轮次>:<toolCallId>` |
| `plan` | `TaskDetail.plan`（整体替换） |
| `configOptions`，或旧式 `models` / `modes` | `TaskDetail.config`（只保留下拉选项）；`setConfig` 调用对应的 `session/set_config_option`、`set_model` 或 `set_mode` |
| `current_mode_update` / `config_option_update` | 更新记录的模式；被放宽时见「权限模式」 |
| `session_info_update.title` | 会话标题（用户重命名优先） |
| `PromptResponse.usage` | 会话用量（整体替换）；只取输入与输出两个总数 |
| `usage_update` | `TaskDetail.usageReport`：当前上下文已用（`used`）、窗口大小（`size`）与费用（`cost`，ISO 货币代码），整体替换；缺少或格式不对的字段丢弃。它是 Agent 的报告，不算可见输出，也不计入 tokens |

### 开始前的选项

ACP 没有会话之外的模型接口，模型、思考与模式随 `session/new` 返回。所以 Harness 的选项来自它自己的会话，或者一次不发提示的读取：

- **记录。** 每个新会话的 `session/new` 回答记为这个 Harness 的选项列表（`HarnessInfo.catalogue`：`options` 与会话的 `config` 同形状，`perModel` 是各模型下跟着模型变的选项，如思考深度，`reportedAt` 是时间，`source` 是 `session` 或 `check`）。会话之后报告的选项（换模型后、`config_option_update`）只更新 `perModel`。列表存在该 Harness 的 `acp.json`，按定义指纹（`definitionHash`）保存，同时记下启动指纹与 Agent 版本；定义一变就不再下发，读坏时丢弃，不影响会话。模式的当前值写成预设每次开始前设好的模式（如 Codex 的 `read-only`），不是 Agent 碰巧报告的那个。条目数、文字长度与总大小（64 KiB，超出时先丢最早见过的模型，再整份不下发）有上限，因为每份目录都带着它，手机整份读取，超过 1 MiB 就拒收。
- **读取。** 还没有列表时，可以不开始会话就读一次（`HarnessInfo.catalogueRead`，`POST /link/api/agents/:id/catalogue { auto?, model? }`）：在 Host 临时目录下新建的空文件夹里启动 Agent，`session/new` 带空的 `mcpServers`，不发提示；Agent 声明 `sessionCapabilities.delete` 就 `session/delete`，否则声明了 `close` 就 `session/close`；然后停止进程并删除文件夹，最多等 20 秒。Codex 预设不开会话：用定义的命令加 `cli app-server`（codex-acp 用 `CODEX_PATH` 指向的 Codex，没有就用自带的），只发 `initialize`、`config/read` 与 `model/list`（按 `nextCursor` 翻页，最多 5 页），不开线程；结果写成 codex-acp 会话里同样的 `model` 与 `reasoning_effort` 选项，所以开始前的选择能直接用在随后的会话上，列表里原有的其他选项保留。它不报告模式，所以 `catalogueRead.modes` 是 `false`；开会话的读取和开始时一样报告模式，是 `true`。
  - 什么时候读：新会话里选中这个 Harness，或打开它的模型菜单，或打开读取会报告模式的 Harness 的权限菜单（`catalogueRead.modes`；Codex 的模型列表不报告，所以打开它的权限菜单不读取），而它既没有列表、这份定义也没读过时，自动读一次（`auto: true`；Host 再查一遍，不符合就不读，返回 `ran: false`）。从不按时间读，失败后也不再自动重读。
  - 哪些自动读：每个预设在 profile 里写明（`catalogueRead`）。只有读取不跑一轮、不调模型、也不运行人自己的会话钩子或扩展时才自动读：Codex（直连与 codex-acp）的 `model/list` 不开线程；DeepSeek Harness、Cursor、Goose、Qwen Code、OpenCode 与没有 profile 的自定义命令是不发提示的空会话。pi 与 Claude Agent 只在菜单里点「读取 <Harness> 的模型列表」时读，因为它们启动会话时会加载人的扩展或插件、运行会话开始的钩子。
  - 只读确认过的定义：自动读取遇到这台 Mac 没确认过的定义，或命令已解析到别的程序，直接不读（`ran: false`，不写审计、不启动）；人点读取时返回原因（409 `harness-unconfirmed` 等）。新会话里还没有定义的预设（`offer`）从不自动读；菜单里「读取 <Harness> 的模型列表」先保存它的定义（这台 Mac 上确认），再读取。
  - 菜单：读取中写「正在读取 <Harness> 的模型列表…」；失败写「没有读到：…」与「重新读取」，因为没登录而失败时只写「还没登录」；有列表时是「刷新模型列表」，读一次并替换列表；还没有列表时是「读取 <Harness> 的模型列表」。
  - 谁能读：和开始会话同一道门，要 `run` 范围，Harness 可以开始（不可用时 409）；只读设备只看已有列表。同一定义同时只读一次；同一模型请求共用结果，不同模型排队各读自己的结果。启动进程之前写审计 `agent.catalogue.requested`（写不进就不启动），结束后写 `agent.catalogue.read`（只记成功与否）。
  - 结果：成功时列表来源为 `check`；失败时保存 `last: { ok: false, message }`，消息经过脱敏，菜单写「没有读到：…」。Harness 以 ACP 的 `auth_required`（-32000，即 409 `agent-auth-required`）拒绝时，`last` 另带 `loginRequired: true`：按 Harness 自己的错误码判断，不看消息的文字；页面据此显示登录（见「登录」的「页面」），不弹登录。定义一变，上次读取的结果也不再下发。
- **自己填的模型 ID。** 菜单里「填写模型 ID…」把 Harness 没列出的模型 ID 存进这个 Harness 的 `acp.json`（`HarnessInfo.customModels`，`PUT /link/api/agents/:id/models { models }`，要 `run`，最多 32 个，每个最多 256 字符、不能换行，审计 `agent.models.changed` 只记个数），在模型列表里标「自己填写」，换定义也保留。只有列表里有模型选项时才能填，因为 ACP 只能经这个选项设置模型。开始时和会话里都原样发给 Agent；开始时 Agent 拒绝或没换过去，这一轮失败，文字和不再提供时一样说出下一次会用什么（「<名称> 没有换到模型「…」，这条消息没有发出。再发送会用「…」，也可以先在模型里换一个。」），之后的发送用会话显示的模型。
- **显示与换模型。** 新会话与会话里共用控件。已知权限预设在草稿就给出从严到宽的全部档位（`permission.modes/startMode`，暂用 `~mode` ID）；列表随后到达不能抹掉人的选择，开始时再匹配 Agent 实际模式 ID。草稿换模型后，在私有空会话切到该模型读取选项，绝不发提示；自动读取与需人请求的边界同上。OpenCode、dsh 明确按模型报告思考，没有时写「这个模型没有思考档位」；Cursor 写「在模型列表里选」。无法读取或失败保持实际未知，不把别的模型的档位搬过来。设备按 Harness 记住选择，默认从预设严格档开始。Harness、模型和思考列表主要显示名称、分组与勾选，不常驻普通描述、成功读取时间或快捷键；未知结果、不可用原因与启动设置边界仍直接显示。权限的档位说明按需展开。显式重选当前权限或启动设置仍交给 Host，取代未完成的旧草稿。
- **应用。** 开始请求带 `config: [{ configId, value }]`（最多 16 项，同一项只能一次），计入请求摘要；Latch 内置 Harness 用 `model`，带 `config` 返回 400 `config-unsupported`。`session/new` 之后、第一条提示之前，依次设置模型、Agent 为这个模型提供的其他选项（思考等）、模式；模式交给「权限模式」的设置与读回。原生选项从 Agent 的回答读回；Cursor force 仅报告其启动配置完成，不冒充有效值独立读回。
- **我的 Agent 默认项。** Host 从定义的 `engineOptions` 生成同一份开始配置并冻结在原 `requestId` 的选择回执中；开始之后改定义不改已有话题。网页设置复用同样的模型、思考与权限控件；它自己的选项与 Latch 服务路由分别保存，合成菜单标识不传给 Agent。权限回读不符时保留失败理由并锁住继续输入。ACP 的当前指令和记忆可经会话中显式清空上下文应用，Latch 会话标识和历史保留（[CUSTOM-AGENTS](CUSTOM-AGENTS.md#家与工具)）。
- **不再提供时。** 选的模型或模式 Agent 不再提供：这一轮失败，不发提示，文字说出它的名字和下一次会用什么（「Codex 现在没有模型「Large」，这条消息没有发出。再发送会用「Small」，也可以先在模型里换一个。」）。失败之前照常设好草稿里的其他选择，再设好并读回模式，没有哪一项留到下一次，所以会话显示的就是之后运行的。明确选择的思考等其他选项不再提供、被拒绝或没采用时同样拒绝本轮；说出下次会使用的值，不悄悄用默认值发送。会话里改了某一项，就取代开始前对这一项的选择。Agent 要先登录时，还没设好的选择留到登录后的那次发送；在那之前会话显示不出它们（尚未实现：会话详情不带还没设好的选择）。
- **审计。** `task.l3.start-requested` 与 `task.l3.started` 带 `configHash`（所选内容的摘要，值是 Agent 自己的文字，不原样记录）。开始前选更宽的模式和会话里一样不弹确认。

会话选项修改的未知结果通过 Host 配置回执查询，不自动再次发送 `set_config_option`；Agent 超时或连接关闭无法证明没有执行。回执只有请求摘要与状态，不保存自定义选项原值。`SetConfigOptions.authorize` 在准备连接前和实际发送 RPC 前同步复查 Host 授权；详情见 [ARCHITECTURE.md](ARCHITECTURE.md#会话配置修改回执)。

- **确定没改的拒绝。** 请求发出之前的拒绝（启动或恢复会话失败、未登录、启动指纹变了、项目目录不在、授权撤回），以及 Agent 在动手之前就拒绝的回答（没有这个方法时 501 `not-supported`，会话不存在，要先登录）都带 `details.configOutcome`（`not-sent` 或 `refused`），Host 记为失败，页面直接说没有改。其他错误回答一律是结果未知：OpenCode 2.x 先记下选择再让自己的服务切换，切换失败时它已经用上所选值，也不一定发 `config_option_update`。
- **等待上限。** 一次修改等 Agent 回答最多 30 秒（`AcpAgentOptions.configTimeoutMs`，不超过 `requestTimeoutMs`）；超过后是结果未知。页面等它最多 150 秒（含进程启动与恢复会话），2 秒后控件写「等 <Harness> 回应…」。
- **核对（`Bridge.readConfig`）。** 只在会话空闲时读：结束这个会话的进程（未回答的那次修改从此不会再落地），再由新进程用 `session/resume` 或 `session/load` 打开会话，取它报告的这一项。运行中、等你处理、另一次修改未结束或子 Agent 可能还在后台运行时不读（`busy`），在结束进程的同一步再查一次；读取期间这个会话的发送、追加与修改都答 409 `config-check-running`。修改在异步启动指纹与项目目录检查后同步复查核对锁，再保留写入占用；改成当前值的请求也不能绕过。读取只读：不设开始前的选择，也不把模式设回去；读到的模式是所选的那一档时，它成为会话的预期模式。Agent 不能恢复会话、没有报告或打开失败时不算读到。Driver 说读到的是不是所选的值（`asked`）：OpenCode 1.4 到 1.14 读回的模型带档位后缀，profile 的 `configValueMatches` 把它算作所选的值。

**OpenCode 的设置。** 按 OpenCode 的公开源码（`anomalyco/opencode`，原 `sst/opencode`）：2.x（`packages/cli/src/acp/`，读到 2.2.7）与 1.15 起的 1.x（`packages/opencode/src/acp/`）实现 `session/set_config_option`，`model`（值 `<provider>/<id>`，名字 `<provider>/<名字>`）、`effort`（类别 `thought_level`，档位随模型变，含 `default`）与 `mode` 三项，立即用完整的 `configOptions` 回答，需要先打开会话，否则答「会话不存在」；1.x 另有 `session/set_model`（`unstable_setSessionModel`）与 `session/set_mode`，1.4 之前没有 `set_config_option`。正常情况下它不迟答；能拖住回答的是它读取模型目录（2.x 首次读取要等插件与模型列表，最多重试 5 秒）和 Latch 自己的冷启动（启动进程、恢复会话）。1.4 到 1.14 的 `model` 带档位后缀（`<provider>/<id>/<档位>`），只选模型时读回的值和所选不同：修改当时是结果未知，核对把它算作所选的模型；Latch 不支持这些版本的思考档位。

**时间。** 时间都由 Host 的时钟（`HarnessHostOptions.clock`）记录，含义见 [STREAMING.md](./STREAMING.md)「时间与用量」。一轮从 Latch 接受提示开始：发出提示之前（启动进程、建立或恢复会话、设置模式）`activity` 是 `starting`，提示发出后是 `model`；`since` 只在阶段或工具变化时更新。正文与思考片段的第一段到达时记下这一段的开始，结算时写入 `completedAt`、`reasoningMs` 与模型（会话里 Agent 报告的当前模型选项的值）；工具第一次被记录时写 `createdAt`，第一次进入 `in_progress` 时写 `startedAt`，Agent 报告完成或失败时写 `completedAt`；一轮结束时 Latch 替它结算的工具，只有运行过的才写 `completedAt`。审批活动的 `since` 与原等待起点 `runWaitingSince` 使用同一个时间戳，跨毫秒取时也不会分裂。询问挂起期间计入这一轮的等待时间；一轮结算时把 `turn` 写在开启它的用户消息上。

`TaskDetail.permission` 描述该会话：`level: 'L3'`、`enforcer: 'NONE'`、能否读回模式、定义是否为已验证的预设、是否请求审批、预期模式、漂移记录、预设说明和定义的说明；不列出项目配置与其他文件夹。

未知的更新类型会被忽略。单条工具文本上限 64 KiB；每个工具最多 32 个 diff，每个 diff 的原内容与新内容各截断到 128 KiB；单行协议消息超过 64 MiB 会终止进程。

## 审批

文件编辑的展示按设备数据范围投影，执行端的原审批参数和完整结果仍保留。Codex fileChange、pi明确的diff分别提供不含文件正文的输出摘要；普通ACP没有此来源事实的编辑输出对work设备保守省略内容段。Host仍保留状态、路径和结果未知/错误证据，不把拒绝当作Agent必定未执行。见 [STREAMING](STREAMING.md#文件差异的设备投影)。

- 选项类型按任意字符串解析。Latch 去掉 `allow_always`、`reject_always`、预设隐藏的选项 ID 和未知类型，只展示「仅此一次允许」与「仅此一次拒绝」。
- 去掉之后若没有「仅此一次允许」，Latch 不展示审批，直接以「仅此一次拒绝」答复（没有该选项时答复为取消），追加系统消息「已自动拒绝：<名称> 只提供会持久保存的选项或未知选项，Latch 不提供。」，并记录安全事件。
- 选择被去掉的选项返回 400 `approval-option-hidden`；选择的选项必须属于该审批，且与允许/拒绝方向一致。只说"允许"时使用「仅此一次允许」；只说"拒绝"时使用「仅此一次拒绝」，没有该选项时答复为取消。
- 一个会话可以同时存在多个审批；多设备竞争时只有一个决定生效。不在进行中的一轮里的询问答复为取消。
- 允许 ACP 询问要求 `run` 权限，任何设备都可以（不弹确认，不提供「始终允许」）；拒绝可以在任何已登记且有查看权限的设备上进行。
- 询问结束后，那次工具调用带上决定记录 `ToolDetail.decision`（见 [ARCHITECTURE.md](./ARCHITECTURE.md)「决定记录与拒绝说明」）：人的允许或拒绝记 `allowed`、`rejected` 与在哪里决定；取消、一轮结束、进程退出、Host 重启时还开着的询问，以及权限漂移时 Latch 自己拒绝的询问，记 `cancelled`，不算作某人的拒绝；Agent 撤回的询问不留记录；同一调用询问多次时，已经给出的允许不被之后的拒绝或取消覆盖。拒绝不保证 Agent 不执行：Agent 之后报告的开始、完成与差异照常显示。ACP 的权限回复不能带文字，所以拒绝附带的说明（「告诉 Harness 改做什么」）不会转给 Agent。
- 有些 Agent（例如处于自动批准模式的 Agent）不请求审批，Latch 就不会显示审批卡片。pi 执行工具前不请求审批，但它的扩展要求确认时，Latch 照样显示审批卡片（见[pi 的 RPC 模式](#pi-的-rpc-模式)）。Latch 的审批不是操作系统沙箱。

## 取消

任何已登记且有查看权限的设备都可以取消。每一轮有自己的 `runId`（在把这一轮写入会话时生成并持久化）；取消带着它时，Driver 只在它仍是当前这一轮时取消，否则什么也不做（Host 回答 `ended`，见 [STREAMING.md](./STREAMING.md#取消的请求-id-与回执)）。

1. 发送 `session/cancel`，同时把该会话所有未决的审批答复为 `cancelled`。
2. 继续接收 Agent 的更新，等待本轮 `session/prompt` 结算后才确认取消；状态记为 `cancelled`，无论 Agent 返回什么 stopReason。
3. 30 秒内仍未结算时终止该会话的 Agent 进程组，会话转为 `interrupted`；其他会话有各自的进程，不受影响。执行中的工具标记为结果未知，请核对副作用；`TaskSummary.runEnd`（`forced-stop`）与取消回执列出它们，见 [STREAMING.md](./STREAMING.md#运行的真实状态)。

## 运行中追加

Agent 在 `initialize` 的 `_meta.steering = { supported: true }` 声明后，运行中的输入经 `_session/steering` 加入当前这一轮，始终带 `_meta.steering.idleBehavior: "promptRequired"`，让 Agent 在没有轮次时不自己开新一轮，完成、用量与失败都留在原来的 `session/prompt` 上。`injected` 记为这一轮里的用户消息，在 Host 读到这个回答的那一刻把之前的回复结算成一条，所以紧跟在回答后面、同一次读到的输出算作它之后的回复；`promptRequired` 交回 Host 排队；其他结果或错误不发出、报错；30 秒没有回答记为结果未知，不重发。停止开始后不再追加。没有声明的 Agent 照常排队。语义见 [STREAMING.md](./STREAMING.md#追加到运行中的一轮)。

## 清空上下文

一条带 `freshContext` 的输入在新的 ACP 会话里开始（语义见 [STREAMING.md](./STREAMING.md#清空上下文)）：Latch 放下当前的 Agent 会话，Agent 声明 `session/close` 时关闭它，在同一个进程上用 `session/new` 开新的（pi 是 `new_session`）。人在这个会话里选的模型、思考与其他选项作为开始前的选项在新会话上重新设置，权限模式照常设置并读回；Agent 不再提供所选模型时这一轮被拒绝，与开始前选项的规则相同。Agent 的指令（`agentBrief`）随新上下文的第一轮再发一次，因为新会话里没有它们。旧会话的上下文用量、费用与计划不再显示。从请求到新会话上记下第一条用户消息之前，任务记着上下文已清空（`acp.json` 的 `contextCleared`，详情里的 `TaskDetail.contextCleared`）：这一轮被拒绝或进程退出时，下一条消息不论是否要求，都在新会话里并带分隔线，页面写「上下文已经清空」且不给「保留上下文」，不会出现记录还在而 Agent 已不知道、界面却不说的情况。重试同一请求不会再开一个会话。

每一步助手消息在 `Message.model` 之外记下当时的思考深度 `Message.thinking`（Agent 的叫法，来自 `thought_level` 选项的当前值）。

## 子 Agent

Latch 在 `initialize` 声明 `clientCapabilities.subagents: {}`（ACP 子 Agent 草案）。Agent 在一个会话上发 `subagent_update` 宣告它启动的子 Agent 后，Latch 在宣告到达的位置放一行 `Message.subagent`：名字、说明、它自己最后报告的状态（`running`、`requires_action`、`idle` 及停止原因、`unknown`），以及它的回复与工具调用（不含思考，最多 200 步，每段文字最多 64 KiB）。子 Agent 自己的子 Agent 放在它的步骤里，最多 4 层；同一进程同时最多 64 行，报告已停止的子 Agent 在一轮结束后不再计入。超出行数、层数或 200 步的部分不显示，会话里写一条说明，但它们请求的审批照常出现，不会被替人取消。子 Agent 不是 Latch 会话，不能发消息、不进侧栏。

- 宣告了 `capabilities.cancel` 的子 Agent（`stoppable`）在网页、桌面端与 iPhone/iPad 的行尾都有「停止」（`POST /tasks/:id/stop-subagent`，只要 `view`）；发出后行写「正在停止…」，直到 Host 报告它在停止或已不能单独停止；请求失败或没有答复时这几个字立即撤下。iPhone 的请求不带 requestId（Host 的结构不收），不重发，行只显示 Host 读回的状态；已经结束的子 Agent 回答 409 `subagent-not-stoppable`，手机照 Host 的话说。
- 子 Agent 在自己的会话上请求权限时，审批出现在启动它的会话里，`Approval.subagent` 写明是谁；它的调用只在子 Agent 的步骤里，不在会话自己的记录中。规则与会话自己的审批相同（可选项过滤、任何有 `run` 的设备都能允许）。
- 子 Agent 的调用与会话自己的一样标出并记录模型的判断（见「权限菜单」）：Codex 在子 Agent 会话上报告的审阅显示「放行」「拦下」或「没有判断」，不报告判断的 Harness 在「由模型判断」档里没有问人就运行的调用写「没有问你」，每个都写一条 `task.tool.judged`；Claude Agent 在子 Agent 里拦下的调用同样写「拦下」，只有它的模型拦下的写这条记录。Latch 不知道子 Agent 自己的模式，按启动它的会话的模式判断。超出 200 步或没有行的调用不显示，记录照写（每个子 Agent 最多跟踪 200 个这样的调用，满了先忘掉最早结束的一个）。
- **以会话的权限为上限。** 子 Agent 的请求不会让它比启动它的会话宽：会话在「只看不改」时，子 Agent 只有只看的请求（`read`、`search`、`think`、`fetch`）会交给你，其他种类（改文件、删除、移动、运行命令，以及 `other`、没有种类或 Latch 不认识的）Latch 直接拒绝，即使这个 Harness 在这一档自己会为只读命令问你（如 Claude Agent 的 `plan`），因为 Latch 分不出子 Agent 的命令是否只读；回答会换模式的选项（`modeAnswers`）只在换到的模式不比会话宽时给你，换到哪一档 Latch 认不出的（比如没有 profile 的 Harness、`switch_mode` 调用上没列出的选项）不给你。拿掉之后没有「仅此一次允许」时，Latch 不展示审批，直接以「仅此一次拒绝」答复（没有时答复为取消），会话里写「已拒绝：子 Agent「<名字>」请求「<调用>」，这个会话是「只看不改」，Latch 没有交给你。」或「…会把权限换得比这个会话宽，或换到 Latch 认不出的模式…」，并写审计 `task.approval-auto-rejected`（原因 `subagent-wider`），和会话自己被自动拒绝的请求一样。子 Agent 的回答从不算作人为会话选的档位。其他档位的子 Agent 请求照旧交给你：「按规则放行」「由模型判断」的规则由 Harness 自己执行，Latch 不知道它放行的范围，所以不替它放行任何请求；「不再询问」档里 Agent 仍然问的，是它自己的规则或安全检查要人看。
- **子 Agent 报告自己的模式时**（在它自己的会话上发 `current_mode_update`，或带模式选项的 `config_option_update`），比会话的预期模式宽或 Latch 认不出时按会话自己放宽处理：取消这一轮、拒绝挂起的请求、会话不再接受输入，说明写「子 Agent「<名字>」报告的权限模式比这个会话宽（<预期> → <报告>）…」。ACP 不允许客户端改子会话的模式，Latch 只能这样守住上限。目前读到的 Harness（Codex、OpenCode 2.x）都不报告子会话的模式。
- 子 Agent 的请求只是提示性审批，从不经本机确认；它的请求挂起时（一轮中或一轮后）会话处于等你处理，本机确认的动作（`PRESENCE_ACTIONS`）全部被拒绝，与会话自己的请求挂起时一样。
- 停止会话时，子 Agent 挂起的请求与会话自己的一起答复为 `cancelled`。
- **单独停止。** 子 Agent 宣告 `capabilities.cancel`（ACP 子 Agent 草案，`subagent_update` 里整体替换，`null` 或省略 `cancel` 即收回）且正在运行或等批准时，详情里它那一行带 `Subagent.stoppable`，页面在状态后面给「停止」。停止（`POST /tasks/:id/stop-subagent { subagentId }`，`subagentId` 是那一行的消息 ID；权限 `view`，和停止会话一样）先写审计 `task.subagent.stopped`（写不进去不阻止停止），再对子会话发 `session/cancel`，把这个子 Agent 自己挂起的请求答复为 `cancelled`（决定记录带 `subagentStopped`，调用上写「已取消（子 Agent 停止）」），之后它再发来的请求也直接答复为 `cancelled`。会话的这一轮照常继续。那一行带 `Subagent.stopping`，写「正在停止…」，直到它报告 `idle`（写它报告的结果，取消是「已停止」，它未完成的调用按停止的一轮结算）或 `unknown`（它的调用不按停止结算），或这一轮结束（记为「状态未知」），或一轮之后发出的停止所在的空闲进程被结束；发出停止不等于停下，所以在它报告之前不写「已停止」。`stoppable` 与 `stopping` 只来自运行中的进程，不保存。不能单独停止的行、已经结束的行或别的会话的行返回 409 `subagent-not-stoppable`。它启动的子 Agent 的请求不替它答复：草案说停下哪些后代由 Agent 决定，以它们自己的报告为准。停止会话照旧停止全部。
- 一轮结束时仍说自己在运行或等批准的子 Agent 记为「状态未知」，不当作还在运行；它未完成的调用与会话自己的一样结算：在跑的记为结果未知，还没开始或在等批准的记为未执行，之后它再报告完成或失败时以报告为准。
- 一轮自己结束（不是停止或失败）时仍在等你批准的子 Agent 请求不取消，一轮结束后才到的子 Agent 请求也照常给你：会话显示「等你处理」直到你答复，期间空闲进程不结束。答复后会话回到这一轮结束时的状态，那次调用记为结果未知（允许）或未执行（拒绝），之后它再报告时以报告为准。这时停止会话把这些请求答复为 `cancelled`，排队的消息和其他停止一样暂停，不会接着发出。
- 没有宣告的会话 ID 的更新照旧丢弃，不猜归属；不支持的 Agent 仍把子 Agent 的工作当作普通工具调用报告。
- **OpenCode 2.x** 不发 `subagent_update`。Latch 不声明它的私有能力 `opencode/child-session-updates`，于是子会话的更新与权限请求都发在启动它的会话上，带 `_meta["opencode/child-session"]`（`id`、`parentID`、`depth`、`title`），调用 ID 前加 `<子会话>:`，调用标题前加子会话的标题。profile 的 `readProjectedChild` 读这个键、去掉两个前缀，把它当作那个子 Agent 在自己会话上的报告：第一次出现时放一行，名字取它的标题，在一轮中出现记为运行中；`parentID` 是另一个子 Agent 时放进那个子 Agent 的步骤，父级没出现过的放在会话这一层。子会话结束时没有报告，所以按会话自己的 `subagent` 调用读（`readChildEnd`）：调用完成且 `rawOutput.metadata.status` 为 `completed` 记为完成；为 `running` 表示它在后台继续，状态不变；调用失败记为失败，在你停止这一轮时失败的记为已取消（OpenCode 会中断它在等的子 Agent）。一轮结束后 OpenCode 不再发子 Agent 的更新，只发它的请求，所以后台子 Agent 在一轮之后是「状态未知」。OpenCode 的 ACP 每一轮只跟踪这一轮里新建的子会话：模型在后来的一轮里用 `subagent` 调用的 `sessionID` 继续一个已有的子 Agent 时，OpenCode 不新建子会话，这个子 Agent 的更新与权限请求都不发给 Latch。它要批准时请求不会出现，在前台等它的 `subagent` 调用不结束，这一轮一直显示运行中，只能停止；继续它的那次 `subagent` 调用是会话自己的调用，和启动子 Agent 一样按规则先问你，参数里有 `sessionID`。这一点按 OpenCode 2.x 的源码确认，尚未在真实运行中核对。启动子 Agent 是会话自己的一次 `subagent` 调用，和子 Agent 那一行同时显示。

## Agent 自己的请求

预设的 profile 可以读某个 Agent 在 ACP 之外发来的请求（`extensions`）。这些请求不带会话 ID，而一个进程只跑一个会话，所以归到这个进程的会话。目前只有 Cursor：

- `cursor/create_plan`：在会话里成为一条审批「计划：<名称>」，内容是它的概述与计划正文，选项是「接受计划」与「不接受」。回答按 Cursor 的形状回传（`{ outcome: { outcome: "accepted" | "rejected" | "cancelled" } }`），停止会话时是 `cancelled`；回答后这一行结束。
- `cursor/update_todos`：成为会话的计划进度；`merge` 按条目 `id` 合并到上一份，被取消的条目不再列出。
- `cursor/ask_question` 不再只属于 Cursor，见下节「Agent 的提问」。
- `cursor/task`、`cursor/generate_image` 等通知不处理。

其他 Harness 发来 `cursor/create_plan`、`cursor/update_todos` 时照「不支持的请求」处理。

## Agent 的提问

源码：[questions.ts](../packages/harness-acp/src/questions.ts)。Host 给 Driver `askUser` 与 `questionSettled`（`HarnessHostOptions`），提问与内置 Harness 的「向你提问」是同一张卡、同一个回答接口（`POST /tasks/:id/questions/:qid/answer`，要 `run`，`requestId` 重试同一回答）。

- **ACP 标准提问 `elicitation/create`。** 只在 Host 提供 `askUser` 时在 `initialize` 声明 `clientCapabilities.elicitation: { form: {} }`；不声明 URL 模式（它会把人带到 Latch 无法担保的页面）。表单的每个字段是一道题：`enum`、`oneOf`/`anyOf` 的取值是选项，`boolean` 是「是 / 否」，元素是枚举的数组可多选，没有取值的字符串、数字用「其他」填写；没有字段的表单问「同意 / 不同意」。超过 10 个字段、超出提问卡的长度（说明 2000、题目与同意问题 1000、选项 500 字符）、URL 模式或读不懂的字段答复 `-32602`，会话里写一行「这个提问的形式 Latch 还不能显示」；URL 模式的请求内容（含链接）不写进会话。回答后答复 `{ action: 'accept', content }`（数字按填写的文字解析，解析不了的字段不填）；停止或这一轮结束时答复 `{ action: 'cancel' }`。
- **`cursor/ask_question`，任何 Harness 发来都读。** 校验与原来相同（最多 10 题、每题 20 个选项，文字 4000 字符），另读 Cursor 文档里的 `id` 与 `allowMultiple`。问题与选项都有 `id` 时放进提问卡，回答按 Cursor 的形状 `{ outcome: { outcome: 'answered', answers: [{ questionId, selectedOptionIds }] } }`；人只写了「其他」时 Cursor 无法收选项外的文字，答复 `skipped` 并把这段文字放在 `reason` 里。超出提问卡的长度时同样答复 `-32602` 并写一行说明；缺 `id` 或 Host 不提供 `askUser` 时照旧答复 `skipped`，在会话里写下它问了什么，请人在下一条消息里回答。
- **行与状态。** 每个提问都有自己的一行 `ask_user`（`tool:<轮次>:ask-<UUID>`），从不借用 Agent 同 ID 的调用行（那一行可能还在运行，两次提问也可能同 ID）；Agent 的调用 ID 只作为这一行的链接。等待时会话为 `waiting-approval`、计时算等人；回答按选项位置（`optionIds`）而不是文字映射回 Agent 的取值。回答写进这一行的结果（`latch.question-result`）并落盘后，才由 `questionSettled` 给回答的设备回执；落盘失败时回执是「结果尚未确认」，不说已回答。没人回答（停止、这一轮结束）的提问记为已结束，Host 停止时这一行带 `interrupted`。Host 的问答记录逐条读取，读不了的一条跳过并在日志里记下条数，不会让 Host 无法启动。

## 不支持的请求

Latch 处理 Agent 发来的 `session/request_permission` 与上一节的提问。其他请求（包括未声明的文件系统与终端）和读不懂的询问都立刻答复错误（`-32601`、`-32602`），Agent 不会一直等一个不会来的回答，同时不被吞掉：会话记录里写一条系统消息「<Harness> 发来请求 <方法>：Latch 不支持这个请求」与脱敏后的内容（带附件的一轮不写内容，内容最多 2000 字符），同一轮同一方法只写一次，最多 8 种；运行中的 `TaskSummary.live.unrecognized` 给出次数与时间。不支持的请求同时更新 `unrecognized.at` 与 `lastEventAt`，两者使用同一时间且不早于已知输出。`lastEventAt` 尚未晚于该请求时，会话进「等你处理」；一有动静，Host 就让列表重读。会话尚未建立时只写入 Host 日志。

## 持久化与恢复

- 数据保存在 `<数据目录>/harnesses/<agent-id>/acp.json`，与 Standard 相同的原子写入与锁文件，字段由 `packages/harness-acp/src/store.ts` 的 zod schema 校验。请求回执与用户消息在发送 `session/prompt` 之前写入。每个会话还记录启动指纹、定义指纹、经确认的预期模式、漂移记录、选中的预设，以及收到全部文件夹的会话的项目、文件夹与交给 Agent 的文件夹；旧文件没有这些字段时照常读取。
- Host 重启后，运行中或待审批的会话转为 `interrupted`，不会自动重发输入。
- 继续一个进程已退出的会话时，先核对启动指纹（含项目配置），再依次尝试 `session/resume`、`session/load`（丢弃重放的历史，因为 Latch 已保存），然后读回权限模式；都不支持时返回 409 `harness-session-lost`，需要新建会话。恢复与加载都重新发送完整的 `additionalDirectories`。会话的项目目录或文件夹已不在 Host 的项目列表中时返回 409 `workspace-changed`。
- 删除会话会删除 Latch 的记录、结束该会话的进程并清理临时目录；只有 Agent 声明支持时才调用 `session/delete`，否则 Agent 自己的存储中仍保留该会话。接入的会话（见「接入已有会话」）的原会话从不删除，清空上下文后 Latch 新开的会话照常删除。清空过上下文的会话，每次清空前的 Agent 会话也一并删除（`acp.json` 的 `earlierSessionIds`）。进程已退出时，只有项目目录仍在 Host 的项目列表中（收到全部文件夹的会话还要求它的文件夹都仍属于该项目）才会为此启动进程，因为 Agent 启动时可能运行工作目录中的代码；项目已移除时只删除 Latch 的记录，Agent 中的副本保留，并在 Host 日志中注明。

## 接入已有会话

这个人在 Latch 之外用 CLI 做过的会话，可以经它自己的 ACP 适配器列出、预览，并接入为一个 Latch 会话。这与 Latch 自己开始的会话在进程退出后的继续（上一节）不同；接管终端里正开着的会话不做，遇到时拒绝。

- **范围。** 只对 profile 声明 `historyImport` 的预设开放（`HarnessDriver.historyImport`）：Codex（直连时经 `thread/list` 与 `thread/read`，见「Codex 的 app-server」；经 codex-acp 时它列出 Codex 的会话，只有元数据，`session/load` 重放内容）与 OpenCode 2.x（见下一条）。运行中的 Agent 没有同时声明 `sessionCapabilities.list` 与 `loadSession` 时返回 409 `history-not-supported`，不发 `session/list`。Latch 从不读取任何 CLI 的文件夹（如 `~/.codex`、OpenCode 的数据目录），一切经适配器。
- **OpenCode 2.x。** 依据是 2.2.6 的 ACP 源码（`acp/service.ts`、`acp/replay.ts`、`acp/directories.ts`）：`initialize` 声明 `loadSession` 与 `sessionCapabilities.list`，`session/list` 每页 100 条、按 `nextCursor` 翻页，`session/load` 要求原来的目录并按时间重放用户文字、回答、思考与工具调用。profile 的规则（`HistoryImportRule`）另要求 `agentInfo.version` 是 2.x：1.x 没有 `session/list`（它声明了也不算核对过），3.x 及以后已被版本规则拒绝；不满足时同样 409 `history-not-supported`，不发 `session/list` 与 `session/load`。OpenCode 的 `session/load` 与 `session/resume` 会把收到的 `additionalDirectories` 存成会话自己的目录授权，Latch 不给 OpenCode 其他文件夹，所以带这种授权的会话（列表行带 `additionalDirectories`）不列出，Driver 只把它们的目录交给 Host（`ExternalSessionList.withheld`），Host 数出在项目主文件夹之内的个数（`HistoryList.withheld`，不含标题与 ID），列表下方一行灰字「另有 N 个带额外目录的会话未列出」；加载前在同一进程上按会话目录再读一次这一行（`session/list` 带 `cwd`），仍带授权或已不在列表里时 409 `history-session-changed`，不发 `session/load`。这道检查有两个前提，都要等真实核对：2.x 的列表行确实带 `additionalDirectories`（2.2.6 的 `acp/service.ts` 只在会话有授权时写这个字段；别的版本不写的话，这样的会话会被当成没有授权而照常加载、授权被去掉），以及再读一行与 `session/load` 之间没有别的客户端给它加授权（这个窗口很短但关不上，ACP 没有带条件的加载）。预览结束时的 `session/close` 只让 OpenCode 丢弃从未发过消息的新会话，不动加载的会话。OpenCode 没有写锁，也不报告会话是否正在别处使用：终端里正开着的会话同样能加载，Latch 不察觉（只有它自己用锁或占用拒绝时才是 `history-session-busy`）；预览带 `useUnknown`，它的 ⓘ 末尾写「OpenCode 不报告会话是否正在别处使用，Latch 看不出来。」。接入之后在别处给这个会话加的目录授权，会在 Latch 下一次恢复它时被去掉。尚未用真实 OpenCode 核对。
- **权限。** 每一步都要 `run` 与数据范围 `all`，不弹确认：有 `run` 的设备本来就能让 Agent 在这台电脑上读这些文件。接入的会话一律私有（`sessions-meta.json` 的 `imported` 计入私有），只对数据范围 `all` 的设备可见，分叉出的会话同样私有。`catalog.features.historyImport` 只对这样的设备出现。
- **审计。** `history.list`、`history.preview`、`history.import` 在每一步之前写入，写不进就不做；只含 Harness 与项目 ID、外部会话 ID 的哈希、方式、请求 ID 的哈希与新会话 ID，不含标题、路径或内容。
- **列出。** `POST /history/list` `{ projectId, harnessId }`：在数据目录下 0700 的私有空文件夹里起一个进程，只发 `initialize` 与 `session/list`（不带 `cwd`），按 `nextCursor` 翻页，最多 500 条或 20 秒，然后停掉进程、删掉文件夹。Host 按真实路径过滤：在项目主文件夹或它下面开始的会话返回（标题经 `redactSecrets`、最多 200 字符，更新时间，相对主文件夹的子目录），最多 50 行、按更新时间倒序；在项目其他文件夹里的只给数量 `otherFolders`；项目之外的不返回、不计数。任何 Latch 会话用过的 Agent 会话（`acpSessionId` 与 `earlierSessionIds`）不列出；已接入的带 `importedTaskId`。每行给一个不透明句柄，只对这台设备、10 分钟有效。列表不加载任何内容。
- **预览。** `POST /history/previews` `{ handle }`：在会话自己的目录起一个进程，照常核对项目配置与启动指纹，`mcpServers` 为空、带完整的 `additionalDirectories`，先绑定再 `session/load`（60 秒），重放留在 Host 内存里（最新的 5,000 条或 8 MiB，更早的只计数）。从不发 `session/prompt`，所以没有工具运行。显示最后 40 条用户、Agent 消息与工具调用，每条最多 4 KiB，整个响应最多 256 KiB；工具只显示标题与状态（`outputHidden`），思考不保留，所有文字经 `redactSecrets`。Agent 说会话在别处打开（写锁）时 409 `history-session-busy`，不重试、不抢。每台设备同时只有一个预览：关闭（`DELETE /history/previews/:id`）、10 分钟后或新开一个时 `session/close` 并停掉进程。
- **接入。** `POST /history/imports` `{ requestId, previewId | handle, harnessId? }`。先写审计与 `history-imports.json` 的回执，再做任何事；同一 `requestId` 的重试（也在 Host 重启之后）完成或回答同一次接入，`GET /history/imports/:requestId` 查回执（未完成时 202，已受理、回执还没写下时同样 202）。同一个外部会话只能接入一次：另一个请求得到 409 `history-already-imported` 与 `taskId`；同一来源的接入串行。「同一个」按 Driver 报告的记录身份（`Bridge.historyStore`）加外部会话 ID 判断：ACP 不报告 Agent 读的是哪份存储，所以按命令解析出的真实路径（经过符号链接）算，重新安装到另一个路径就是另一份；运行同一适配器的两个定义（例如两个 Codex 定义共用 `CODEX_HOME`）算同一份；环境指向别处时第二次接入也被拒绝，不会重复。完成的回执只留 ID，不留目录与标题。导入时在 Host 上重做目录检查（会话目录仍在项目主文件夹之内，`history-outside-project`）与启动指纹。确定失败时回滚 Latch 的记录与回执。
- **原样接入**（继续用来源 Harness，默认）。Host 先选好会话 ID 并把 `imported` 写进 `sessions-meta.json`（会话从存在起就是私有的），Driver 关掉预览进程后记录会话：ACP 会话 ID 绑定到原会话，`acp.json` 记 `imported.agentSessionId`，历史是重放的最新 500 条或 4 MiB（更早的写一行「更早的 N 条消息只在 Codex 里」），每条带 `imported: true`。之后照常 `session/resume`（或 `session/load`，丢弃重放），第一轮前设回 Latch 的预期模式并读回：不沿用原会话的权限。加载与接入都用会话目录核对过的真实路径：它就是会话的 `cwd`（`acp.json` 的 `cwd` 与 `imported.cwd`），Agent 从不经过符号链接拿到目录，之后改指别处的链接不会移动它。每次启动、恢复与输入都要求这个路径的真实路径不变且仍在主文件夹的真实路径之内，否则 409 `workspace-changed`。重放的文字在整条消息拼好后才经 `redactSecrets`，分成几块到达的密钥也被替换。
- **按文字重建。** 选了另一个 Harness，或原样接入的会话之后得到 `harness-session-lost`（`{ requestId, fromTaskId, harnessId? }`）时，用分叉的种子：只取用户与 Agent 的文字，不含工具输出、思考与压缩，经 `redactSecrets`，保留最后 20 万字符，标题写明「按文字重建，不是原样恢复」。新会话照常走启动与审计，但不开始一轮：它空着等这个人的第一条消息（`CreateTaskInput.seed`，Driver 声明 `seededStart`），发出这条消息才把这段文字连同它一起发给模型服务，文字是这条消息的开头（`TaskSummary.imported.mode` 为 `text`，`prefixLength` 是它的长度）。第一条消息清空上下文时不带这段文字，`prefixLength` 随之去掉。现在只能重建到 ACP Harness：内置 Harness（Standard）还不能这样等第一条消息，返回 409 `history-not-supported`。同一来源仍只能接入一次。
- **界面。** 新会话页输入框下方的「接入已有会话」只在所选的已保存项目里有可列出会话的就绪 Harness（`HarnessInfo.history.list`）且设备有 `run` 时出现；数据范围不是 `all` 的设备（或 Host 没给 `catalog.features.historyImport`）看到上锁的同一行，ⓘ 说明要在 Mac 上开启「可以看项目文件」。点开是对话框（手机上是整页，预览推入在列表之上，浏览器返回逐级退回）：顶部写项目与 Harness，列表按更新时间倒序，每行标题、子目录（主文件夹本身写它的名字）与相对时间，已接入的行带勾、点开即打开那个会话；另写「另有 N 个在项目的其他文件夹里 · 尚未支持」。列表有读取中、空、失败（原因与重试）、`history-not-supported` 与 `agent-auth-required`（登录命令）几种状态。预览按时间排列消息，工具只写标题、状态与「输出已隐藏」，顶部写「工具输出和思考不显示」；`history-session-busy` 写「这个会话正在别处使用」，只有「再看一次」，不提供接管。底部「继续用」默认来源 Harness（原样接入）；选别的就绪 Harness（`HarnessInfo.history.rebuild`，现在是 ACP Harness）立刻变成琥珀色「按文字重建，不是原样恢复」。主按钮「接入」，进行中写「正在接入」，没有答复时写「结果未确认」并用同一 `requestId` 重试；409 `history-already-imported` 直接打开 `taskId` 那个会话。接入的会话页头带「已接入」（文字重建时「已接入 · 按文字重建」，悬停说明来源与方式）。文字重建的会话在第一条消息发出前，输入框下方写明第一条消息会把重建的对话文字一起发给它用的模型服务；之后第一条消息里这段文字折叠为「按 <来源> 会话的文字重建」（`Message.importContext`，Host 按 `prefixLength` 标注；开始新上下文的第一条消息不带）。原样接入的会话发消息得到 `harness-session-lost` 时，输入框上方的停止行写「Harness 找不到原来的会话了」，除「在新会话中继续」外还有「按文字重建」：同一个「继续用」选择（只列能接受重建的就绪 Harness，自己的排第一）与同一句琥珀色「按文字重建，不是原样恢复」，请求带 `fromTaskId`，没有答复时用同一 `requestId` 重试；新会话同样等第一条消息。原来的会话之后只能查看（`TaskSummary.imported.fromTaskId` 指回它的那个会话存在时），停止行换成「已按文字重建为新会话」与打开它的按钮。
- **iPhone/iPad。** 同样的条件、文字与请求（判断在 `PhoneHistory`）：新会话面板首条消息下方一行「接入已有会话」或上锁的同一行；点开是全屏的导航栈，列表在下、预览推入，iPad 相同；打开时取定项目与 Harness，之后条件变化也不会出现空白页。列表与预览经 `NativeWorkspace.historyRead` 在正文窗口内读取、不存盘，窗口关闭时整页撤下。离开预览即 `DELETE /history/previews/:id`；它要正文窗口，没有窗口时 previewId 只在内存里排队，下一个窗口打开时发出；被拒为 `history-already-imported` 或晚到、被丢弃的预览同样关闭；还有未确认接入引用的预览不关。接入与按文字重建是持久的待确认写入（`requestId` 与请求体存在加密资料库），没有答复时写「结果未确认」（重试被拒但没有定论时附上 Host 的话），只用同一请求重试、不自动重放；Host 先查回执（或加入进行中的同一请求）再看预览，所以预览的接入重试得到 `history-handle-expired` 说明没有接入，写「这次接入没有完成」并放下；`task-deleted` 说明接入过、那个会话后来被删除，写「已接入，但这个会话后来被删除了」并放下。「核对并放下」读 `GET /history/imports/:requestId`：完成则打开那个会话（在全屏页上时等它关闭后打开），没有回执则放下，已受理或仍在进行则保留。答复晚到（换了连接或窗口已关）的预览与因待确认接入而保留、之后没有接入的预览同样关闭。手机同时只留一个待确认写入，所以结果未确认期间「继续用」不能改选；列表的待确认条写「接入结果未确认」。原样接入（`imported.mode` 为 `native`）的会话发消息得到 `harness-session-lost` 时，输入框换成停止行「Harness 找不到原来的会话了」与「按文字重建」；其他会话照常报错。手机的停止行还没有「在新会话中继续」。
- **尚未实现。** 接入后又在终端里继续了同一会话时 Latch 不察觉。其余 Harness 没有开放，原因各不相同：
  - pi：它的 RPC（1.5.0 的 `rpc-types.ts`）没有列出会话的命令，`switch_session` 只接受 pi 自己存储里的会话文件路径；发现会话只能读它的存储或用它 SDK 里扫描存储的 `SessionManager.list`，这违反「外部会话只经适配器」，所以不做，等 pi 提供列出会话的 RPC。
  - OpenCode 1.x：ACP 没有 `session/list`，不做。
  - Qwen Code（0.27.3）、goose（1.59.0）：源码声明了 `session/list` 与 `loadSession`，但加载对原会话的影响（恢复旧模式、写回设置等）还没有读完，也没有用真实程序核对，暂不开放。
  - Claude Agent、Grok Build、Antigravity：适配器或官方文档有列出与加载，没有核对；Claude 的会话记录按所有者的规定不碰。Cursor 不开放。
  - iPhone/iPad 的列表与预览还不显示「未列出」的数量与「看不出是否在别处使用」这两处。

## 错误

| 代码 | 含义 |
| --- | --- |
| `mode-unsupported`（400） | ACP Agent 只支持 Agent 模式 |
| `agent-env-reserved`（400） | Agent 定义设置了由 Latch 管理的环境变量 |
| `approval-option-hidden`（400） | 该选项会持久保存授权，Latch 不提供 |
| `l3-confirmation-missing`（409） | 会话没有启动指纹的记录 |
| `agent-definition-changed`（409） | Agent 定义或解析出的命令已变化 |
| `project-config-changed`（409） | 项目中计入启动指纹的 Agent 配置在会话启动后有增删或修改 |
| `permission-unverified`（409） | 无法确认 Agent 已进入预期的权限模式，本轮未发送 |
| `permission-drift`（409） | 该会话检测到权限模式漂移，不再接收输入 |
| `harness-version-unsupported`（409） | Agent 版本未经验证（OpenCode 的版本规则），或低于预设的版本门槛（DeepSeek Harness、pi，见「版本门槛」） |
| `workspace-unavailable`（400） | 工作目录不是 Host 登记的项目目录，或所选项目的文件夹与 Host 登记的不一致 |
| `workspace-folder-chars`（400） | 要以参数交给 Agent 的文件夹路径含逗号 |
| `workspace-changed`（409） | 会话使用的文件夹已不在项目中、被替换或找不到，或项目已不在 Host 的项目列表中；新建会话的过程中交给 Agent 的文件夹变了 |
| `agent-folders-unsupported`（409） | Agent 的当前版本没有声明 `additionalDirectories`，会话没有开始或本轮没有发送 |
| `harness-folder-limit`（409） | 项目的文件夹超过 Agent 能使用的数量（Qwen Code 最多 5 个） |
| `agent-auth-required`（409） | Agent 要求登录；按它自己的方式登录后点重试 |
| `harness-no-login`（404） | Latch 不知道这个 Harness 的登录命令 |
| `login-program-changed`（409） | 登录方式来自之前找到的程序，现在找到的不是它；重新检测后再试 |
| `logout-unsupported`（409） | Agent 没有宣告 `logout` |
| `harness-busy`（409） | 这个 Harness 有会话正在运行，不能退出登录 |
| `terminal-open-failed`（502） | 没有打开终端；自己在终端里运行这条命令 |
| `harness-session-lost`（409） | Agent 无法恢复该会话 |
| `history-session-changed`（409） | 接入已有会话时，Harness 说这个会话带着它自己存的目录授权（加载会改写它），或已不再列出它；没有加载 |
| `agent-not-found`、`agent-start-failed`、`agent-paused`、`agent-busy`、`agent-exited`（503） | 命令缺失、启动失败、连续崩溃后暂停、同时运行的进程过多、进程已退出或正在停止 |
| `agent-handshake-timeout`（504） | Agent 在时限内没有回答 `initialize`（30 秒）、建立会话（`session/new`、`session/resume`、`session/load`、分叉，60 秒）或握手之后的启动设置（如经 Latch 使用模型服务时的 `providers/list`，120 秒）；Latch 停止它、等进程真实退出后这一轮才失败，并写明哪一步、建议核对版本 |
| `agent-timeout`（504） | Agent 长时间没有响应其他设置请求（120 秒） |
| `not-supported`（501） | Agent 不支持修改该选项 |

## 尚未实现

| 项目 | 原因 |
| --- | --- |
| 操作系统沙箱、Agent 出站代理 | 未实现；因此 ACP 会话固定为完全访问（L3），Agent 自己的文件与网络访问不受 Latch 约束 |
| 中和项目配置（例如在启动前屏蔽 `.opencode` 插件） | 未实现；Latch 只把项目配置计入启动指纹，变化时停止会话 |
| 托管安装 Agent | 未实现；预设只使用本机已安装的命令 |
| OpenCode 2.x 的子会话通道（`opencode/session/child_update`） | 未实现；Latch 不声明 `opencode/child-session-updates`，改读子会话发在启动它的会话上的更新与请求（见「子 Agent」） |
| OpenCode 1.x 的子 Agent | 未实现；1.x 的 ACP 不回答子会话的权限请求，`task` 保持禁用 |
| OpenCode 2.x 在后来的一轮里继续的子 Agent 的请求 | 未实现；OpenCode 的 ACP 不转发它们，Latch 收不到，这一轮会一直等到你停止（见「子 Agent」） |
| 单独停止没有宣告 `capabilities.cancel` 的子 Agent | 未实现；ACP 不允许客户端停止没有宣告的子会话，停止只能作用于整个会话。OpenCode 2.x 不宣告：它在后台运行的子 Agent 在一轮结束或停止后仍可能继续，停止会话只答复它已经发来的请求；会话空闲到进程被结束时，它随进程结束 |
| 让启动子 Agent 的 Agent 回答子 Agent 的请求 | 未实现；没有 Harness 经 ACP 提供这件事，ACP 也没有把客户端收到的权限请求交给另一个 Agent 回答的方法。子 Agent 的请求由你在会话里回答，并以会话的权限为上限（见「子 Agent」） |
| goose 的运行中追加 | 未实现；它的私有方法要 goose 自己的运行标识，也没有声明字段，要等真实录制核对 |
| 按会话放行 OpenCode 访问其他文件夹 | 未实现；需要按会话改变 OpenCode 的配置并提高其 profile 版本。OpenCode 访问其他文件夹时逐次询问；2.x 的 ACP 字段尚未使用 |
| Cursor 的选择题（`cursor/ask_question`）放进提问卡片 | 未实现；提问卡片还没有接到 ACP 驱动上，现在回答 `skipped` 并把问题写进会话 |
| Claude Agent 的其他文件夹（`additionalDirectories`） | 未实现；Claude 访问会话目录以外的路径时逐次询问 |
| ACP 的原生分叉（`session/fork`） | 未实现；Codex 等 Agent 声明的 `session/fork` 只能分叉整个会话（从某一轮分叉的位置在其他客户端的私有 `_meta` 里，Latch 不借用），新进程能否分叉另一个进程的会话还没有用真实 Agent 核对。现在 pi 以外的 Harness 的分叉都由 Host 以背景文本开启新会话 |
| 回答 pi 扩展的选择题与输入框 | 未实现；它们回答「已取消」并写进会话 |
| 只有主文件夹的 Codex 会话把 `.agents/skills/` 计入启动指纹 | 尚未实现；原生技能目录读取已接入，但没有扩展这个指纹范围 |
| iOS 的原生技能选择菜单 | 尚未实现；Web 命令菜单已按真实目录提供技能，iOS 仍可手动输入原生调用文字 |
| Qwen Code、goose、Grok Build 去掉「实验性」 | 尚未做：三者都在没有登录的临时 HOME 下对本地假服务跑通了一轮，但没有对真实服务、带工具与多轮跑过；Qwen Code 的 `agents.allowedGrades: []` 与 `permissions.deny: ["Agent"]`、goose 的 `provider` 选项隐藏只按源码与假 Agent 核对 |
| Qwen Code、goose、Grok Build 清理工具子进程里的网关凭据 | 未实现；三者没有这样的官方开关，见「经 Latch 使用模型服务」 |
| Qwen Code 经 Latch 时的思考档位与子 Agent | 未实现；思考只提供它自己经 ACP 报告的选项。子 Agent 在经 Latch 的会话里被关掉，直到 Qwen Code 能把子 Agent 的模型限制在指定的服务上 |
| goose 固定 `delegate` 子 Agent 的服务 | 未实现；goose 没有文档化的设置能固定或关掉它（见「经 Latch 使用模型服务」），所以它的路线标「实验性」 |
| Antigravity、Cursor 经 Latch 使用模型服务 | 做不了：两者都不接受别人的模型服务地址（见「经 Latch 使用模型服务」的表），模型菜单只列它们自己的模型 |
| Claude Agent 常驻的额度百分比 | 尚未实现；适配器只转发每轮的限额事件，完整的用量要发 `/usage` 或等适配器暴露结构化用量，Latch 不自动发 |
| Codex 按模型的额度桶、Codex 开会话前的额度 | 尚未实现；只显示套餐自己的桶，并且要等第一个会话的线程打开后才读 |
| Cursor、OpenCode、Qwen Code、goose、pi、DeepSeek Harness 的额度 | 未实现；它们的程序不经协议或命令报告订阅额度，Latch 不读它们的令牌去问厂商 |
| 其他协议翻译方向 | 未实现；当前只开放 Responses/Anthropic→Chat 与 Responses↔Anthropic，其余组合列出但不能选 |

## 测试

`packages/harness-acp/test/acp.test.ts`（`pnpm test --project @latch/harness-acp`）使用 `packages/testkit/fixtures/fake-acp-agent.mjs`（`@latch/testkit` 的 `FAKE_ACP_AGENT`，确定性的假 Agent，按环境变量与输入关键词切换场景，可模拟模式、粘滞模式、恢复后的模式与不报告模式的恢复、修改模式时自行切换的模式、缺少类别或缺失的模式选项、版本号、`additionalDirectories` 能力（`FAKE_ACP_CAPS_FILE` 让同一定义之后的进程改变声明）和环境转储，并记录启动参数；`FAKE_ACP_GATEWAY=opencode|dsh|qwen|goose|grok` 让它按对应程序的方式读网关配置并用声明的协议请求一次（Qwen Code 的系统设置文件与 `envKey`，`FAKE_QWEN_USER_SETTINGS` 代表这个人自己的设置、按 Qwen Code 的规则合并在系统设置之下；goose 的环境变量与路径规则；Grok Build 家目录里的 `config.toml`；这些是照源码与文档读出来写的，不是真实程序的录制），没有登录的假 Agent 被指向一个服务后照常回答，覆盖流式、思考、工具与 diff（含 diff 是否为新文件的记录与持久化）、审批与选项过滤、自动拒绝、取消（含不遵守协议的 Agent）、崩溃、恢复、启动指纹、模式读回与漂移（含运行中修改模式）、环境变量白名单、改变 OpenCode 配置位置的定义变量、项目配置（项目内与上级目录、经过符号链接的项目路径、OpenCode 自己写入的内容、开始过程中与之后的变化、空闲后重启与删除前的检查）、每会话进程与进程上限、项目移除后的删除、项目的多个文件夹（Codex 的能力门槛与恢复时重发、Qwen Code 的参数与上限、不接收文件夹的预设、文件夹被移出、替换或删除后的停止、每个文件夹中的项目配置）、旧式模型选项、异常输出与幂等。预设的权限配置通过 `presetId` 套用到假 Agent 上测试。`test/connect.test.ts` 与 `apps/host/test/harness-connect.test.ts` 覆盖版本门槛（太旧、升级后重新检测、读不出版本、测试 Host 不读）、不回答 `initialize`（`FAKE_ACP_INIT_SILENT=1`）与不回答 `session/new`（`FAKE_ACP_NEW_SILENT=1`）的 Agent、pi 1.5 的回答顺序；`e2e/harness-connect.e2e.ts` 在 1440 与 390、浅色与深色下检查设置与新会话里的说法。默认测试不启动真实 Agent。显式授权的本机验收独立运行、使用临时 Host 与项目；测试确认后端不等于系统确认。

额度（见「额度」）：`packages/harness-acp/test/quota.test.ts` 用 Codex 0.167 自己的 schema 形状、Claude Agent SDK 的 `SDKRateLimitInfo` 与 Grok 的 `BillingConfigResponse` 字段核对解析、遮住账号、丢掉未知种类与文字、只在内存里、过了重置时间与进程退出后的保留，并用假 app-server（`FAKE_CODEX_RATE_LIMITS`、`FAKE_CODEX_RATE_LIMITS_UPDATE`）与假 ACP Agent（`limit <json>` 一轮、`FAKE_ACP_BILLING`）走驱动，Antigravity 用一个对 `-p /usage` 打印录制形状的假 `agy`；`apps/host/test/harness-quota.test.ts` 核对随目录发给谁、原始内容不进快照、日志与数据目录；`apps/web/test/harness-quota.test.ts` 与 `e2e/harness-quota.e2e.ts` 核对界面。

### 会话命令

新会话可以读取同项目、真实目录身份与准确启动指纹下，上次真实会话报告的完整命令目录。ACP 的派生缓存为私有数据目录中的 `harness-commands.json`（0600，最多 64 份目录、2 MiB），严格检查文件与持久来源，原子写入；空报告有别于未报告。缓存只收已绑定进程的实际报告，异步核对后再检查同一进程、会话与报告序号，不启动或探测 CLI，也不读 CLI 自有存储。

`POST /agents/:id/commands` 接受正常开始会话的选择项，不接受任意 cwd；需要 view，并在异步查找后复查设备、项目、来源可见性、真实目录与完整启动指纹。新分配的文件夹、工作树与助手家没有真实目录时不命中，也不为查提示创建目录。响应包含 commands、reportedAt、source=previous-session，以及可选的 skills、skillsTruncated；sourceSessionId、启动指纹和私有路径只在 Host 内使用。删除来源、改变启动配置或失去来源权限后不返回。缓存只是建议，不授执行能力。

Host 每次挂载 Driver 生成 `HarnessInfo.commandCatalogue.generation`；ACP 每次命令报告完成缓存核对后更新并持久化 `TaskSummary.commandsVersion`。它们都是不透明标识，普通正文帧不改变命令版本。Web 用本来可见的任务 ID 与版本、Host、设备授权、Driver 代次、项目和实际开始选择确定提示范围；可见集合或选择改变时立即撤下旧结果并取消在途查询，迟到响应不回填。

Code 首页、新会话页和手机选项面板标记「上次会话」，点按、Tab、Enter 都只插入草稿。可见草稿每 30 秒只读重验，后台暂停，重新可见立即重验；等待时不打断草稿或菜单焦点。磁盘配置变化和没有公开通知的 public→private 可能使之前的公开提示保留到下次重验；私有活动的事件过滤不变，HTTP 每次仍重新授权，不能返回私有化后的新报告。

ACP `available_commands_update` 的当前列表作为可选 `TaskDetail.commands` 发送给客户端，并随 ACP 会话持久化。每次更新替换之前的列表（空列表撤下命令）；最多 200 条，名称 100 字符、说明 1000 字符、输入提示 500 字符，畸形更新不接受。名称不能包含空白或控制字符，允许冒号。若 Harness 把本机 MCP 提示报告为 `mcp:服务器:提示` 一类的命令，Latch 将它列在这个 Harness 的普通命令组中，发送时保留名称。是否报告和执行由 Harness 决定。桥的能力见 [MCP.md](MCP.md#提示)。名称与说明按可见安全文本显示。点按与 Tab 只插入可编辑草稿；桌面键盘 Enter 的执行条件、参数提示和保留动作见 [DESIGN.md](DESIGN.md)。带 `idleOnly` 的命令在运行中保留置灰；排队、把排队的消息改成它或追加到运行中的一轮时，Host 以 409 `command-queued` 拒绝。

Codex 直连声明 `/compact`，用 `thread/compact/start` 执行，不接受参数或附件。立即 RPC 回答不是完成；进度来自 `contextCompaction`，手动压缩以对应 `turn/completed` 的成功、失败或中断结算，取消用原有 `turn/interrupt` 并等待真实结算。自动压缩以自身 `item/completed` 为成功证据；普通一轮结束却缺少这个完成事件时显示「压缩上下文结果未知」，不推断已完成。每次压缩的终态只通知一次。

原生 compact 没有每轮模型、思考或权限覆盖参数。已加载 thread 的 `thread/resume` 读回不等于应用新配置；执行前按实际读回核对 thread、目录、模型、思考、完整沙箱及审批策略，缺项、未知或非空 `activePermissionProfile` 都拒绝。改过配置时先由普通消息应用，再用 compact；不发空轮次代替人应用配置。Codex profile 版本为 8。原生 `/review` 会改变询问行为，并可能采用独立的 `review_model`，当前尚未接入；直接输入或追加时明确拒绝，不调用 `review/start`，也不转成普通提示。

pi 在打开或加载会话时复用 `get_commands`，只采用实际报告的 extension、prompt、skill。公开列表有界，去掉路径、`sourceInfo` 和私有权限扩展命令，保留字面 `skill:name`；扩展和原生 compact 只在空闲时执行，提示模板和技能可以由 pi 在追加时展开。pi 自己报告 `/mcp` 不表示 Latch 能向它注入 MCP，`takesMcpServers` 不因此改变。pi profile 版本为 6。

线的可选 `commandsWithoutContext` 区分必须保留原生前缀的命令与只限空闲的命令。只有完整首词与线确认的命令集合一致才省略本次人物 brief；没有输入参数的原生命令同样不消耗 brief，下一条普通消息继续携带它。未知名字或读取目录失败不省略 brief；Codex 不把多文本上下文块当作原生命令。未携带 brief 的用户消息不标记 `agentBrief`。

**原生技能。** 可选 `TaskDetail.skills` 与 `HarnessCommandCatalogue.skills` 保存公开的 `name`、精确 `invocation`、可选 `description` 和已知 `scope`，不含路径、正文或 `sourceInfo`。旧 `commands` 保持兼容：Codex 的 `$name` 不放进斜杠命令，pi 的 `/skill:name` 继续保留，新增 skills 不重复 legacy 说明。目录最多 200 项，包含 JSON 包装和截断标记的 UTF-8 总量不超过 64 KiB；先保名称，再分配可选说明。仅省略说明不算目录截断，名称本身或数量超限时以 `skillsTruncated:true` 明示，随会话与缓存持久化。Host 再次校验字段和预算，拒绝夹带私有字段。Web 命令菜单把这些项放在技能组，Codex 插入 `$name `，pi 插入 `/skill:name `；已列为技能的 pi 命令不再重复显示在 Harness 组。点按、Tab、Enter 均只插入草稿，最近选择按 Harness 隔离，目录截断时显示「仅列出部分技能」。iOS 独立技能菜单尚未接入。

Codex 直连开 thread 或恢复时，以实际 cwd 调用 0.167 的 `skills/list {cwds:[cwd],forceReload:true}`；原生路径只留在当前 wire 的完整 enabled 映射里，不从客户端或提示内容接收路径。`skills/changed` 立即清空映射后重新读取，重叠读取合并，旧代次回答不得恢复旧路径。读取失败或目录不完整时撤下当前目录，错误中的私有路径不外发。不读取 CLI 存储，不另外启动探测进程。公开目录的数量与字节截断不截断当前 wire 的合规调用映射，原生 RPC 帧上限不变。

Host 在增加人物 brief、文件引用、撤销说明、seed 与历史之前保留本轮原文，只经内部调用上下文传给运行时与 wire；不接受公共 HTTP 的来源声明，不改变请求哈希、队列或回执。分叉仅在原文与已核对的完整输入一致时扣除已验证的背景前缀。Codex 只从该原文的完整空白分隔 `$name` 匹配官方清单，补充 `{type:'skill',name,path}`；原文字仍照常发送。未知、带前后缀、转义或引号包围的名字保持文字，同名 enabled 项明确拒绝，追加时也不改成另开一轮。没有原文证据时不扫描完整 prompt 兜底。它只限定 Latch 生成的结构化项，不限制 CLI 或模型自己的行为，也不是沙箱。

技能公开元数据沿会话和原有命令缓存保存；缓存复用同一项目、目录身份、启动指纹与来源会话可见性检查，读取不启动 CLI。恢复出的缓存仅是上次会话的建议，不能给当前结构化调用提供路径；新 wire 必须重新读取官方目录。磁盘变化没有额外主动探测，仍需 CLI 的目录变更通知或下次打开时重读。

分叉由 Host 以一条背景文本加新输入开启会话，ACP 不需要私有分叉方法；仍是新的启动。pi 在同一定义、同一文件夹内用它自己的分叉，见「pi 的 RPC 模式」。用户消息的 requestId 在 ACP 存储中保留，用于关联确认后的输入与客户端待发送气泡。

Host 队列只在明确 runOutcome=completed 后自动派发。ACP 只有 session/prompt 的 end_turn 算 completed，取消、输出上限、拒绝、未知 stopReason 与断连都暂停。Standard 仍要求 Provider 的有效 finish 事件。两种 Driver 接收 PromptOptions.queuedAt，只作为用户消息的排队时间，不改变输入幂等哈希与权限；第三方 Driver 没有明确 outcome 时，由用户继续。

ACP 附件只走 `session/prompt` 的内容块。initialize 的 `promptCapabilities.image` 和 `embeddedContext` 必须各自为 true；Probe 缺少字段不代表支持，实际启动后再次核对。图片为 base64 image，文本为含 `latch-attachment:<id>` URI 和正文的 embedded resource，不在项目创建文件。Agent 输出图片通过 Host 回调存为会话附件，任务快照只写引用。含附件会话的 stderr 不进入 Host 日志，RPC 失败也不回显附件；具体限额和授权见 [ATTACHMENTS.md](ATTACHMENTS.md)。

显式 `fileRefs` 由 Host 对固定目录再次验证，ACP 仅在本轮模型输入里追加真实目录映射，公开消息保留原文与引用 metadata。附件及文件引用 schema 都随会话持久化；假进程回归覆盖实际协商、内容块、图片输出与重启。

文件变化的范围、运行结算、可选插件契约与验证见 [运行期间的文件变化](FILE-OUTPUTS.md)。
