---
description: 经 ACP 接入外部 Agent：完全访问（L3）、使用、预设的权限配置、项目配置、项目的多个文件夹、启动诊断、进程、映射、审批、取消、持久化与恢复、错误与测试。
sources:
  - packages/harness-acp/src
  - packages/protocol/src/agent-presets.ts
  - apps/host/src/hub.ts
---
# 接入外部 Harness（ACP）

Latch 用 [Agent Client Protocol](https://agentclientprotocol.com)（ACP v1）驱动外部 Agent。每个启用的 Agent 定义成为一个 HarnessDriver，与内置 `standard` 并列出现在新会话的 Harness 选择器中。实现是包 `@latch/harness-acp`（`packages/harness-acp/`，只有 Host 依赖它）；浏览器可见的预设（命令、参数、许可证、安装提示）位于 `packages/protocol/src/agent-presets.ts`，只在 Host 上使用的权限配置位于 `packages/harness-acp/src/profiles/`（每个预设一个文件）。整体架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

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
2. 新会话直接列出命令已经装好的预设（`catalog.harnesses` 中带 `offer` 的项，只发给有 `admin` 的设备），不用先添加；第一次发送时页面先保存它的定义，再开始会话，保存不运行任何东西。`startServer` 只有收到 `detectPreset`（启动脚本传入）才找命令，测试不传，所以运行测试的电脑上装的 Agent 不会被选中。也可以在「设置 → Harness」选择预设或填写自定义命令（可执行文件名或绝对路径、参数、环境变量）；有 `admin` 的设备都能改，每次改动都有 `agent.defined` 审计，变量的值不返回。可以先「测试启动」，不发送内容地核对程序能否运行。
3. 新建会话时默认用这台设备上次的 Harness，否则按预设顺序用第一个能开始的，Latch 内置最后，不提问。项目在标题里选；Harness 没有项目、启动目录又是 Host 自己选的（`catalog.sessionFolders`）时，按发送打开项目列表、保留草稿、不开始；选「不选项目」就在新的空文件夹里开始。 发送就开始，没有确认。

   这个启动指纹在这台 Host 上第一次启动时，`sessions-meta.json` 记 `firstStart`，摘要带 `firstStart: true`，会话记录最上面显示一行：「Codex 能读写这台 Mac 上的文件并运行命令。权限是 Codex 自己的设置，Latch 不隔离它。」；从不询问的 Harness 写「pi 执行前不询问，Latch 不限制它。」。Driver 不会收到这一项。
4. 会话头部显示 Agent 提供的模型、模式等选项，修改后从下一轮生效；任何档位都能直接选，也包括由模型代为批准和不再询问的模式。

预设收录开源 Agent，以及厂商官方文档支持的已安装命令（Claude Agent、Cursor）；都只使用本机已安装的命令，不使用 `npx` 等运行时下载，不捆绑、不修改它们：

| 预设 | 命令 | 许可证 | 说明 |
| --- | --- | --- | --- |
| Codex | `codex-acp` | Apache-2.0 | `npm i -g @agentclientprotocol/codex-acp`；登录、模型与沙箱由 Codex 管理 |
| pi | `pi-acp` | MIT | `npm i -g pi-acp`，需要已安装 pi（预设的 `companion`，与适配器分别检测）；pi 执行工具前不请求审批 |
| OpenCode | `opencode acp` | MIT | `npm i -g opencode-ai`；支持 1.x 与 2.x |
| DeepSeek Harness | `dsh --profile acp` | MIT | 需要 `@deepseek-ai/dsh` 0.2.1-rc.2 或更高；按完整消息回复 |
| Gemini CLI | `gemini --acp --approval-mode default` | Apache-2.0 | `npm i -g @google/gemini-cli` |
| Qwen Code | `qwen --acp` | Apache-2.0 | `npm i -g @qwen-code/qwen-code` |
| goose | `goose acp` | Apache-2.0 | 见项目文档 |
| Claude Agent | `claude-agent-acp` | Apache-2.0 适配器；Claude Code 专有（Anthropic 条款） | `npm i -g @agentclientprotocol/claude-agent-acp`；用这个人在 Claude Code 中已有的登录（或它设置里的 API key、Bedrock、Vertex）。名称只用「Claude Agent」，不用 Claude Code 的名称或 logo，图标是中性图形 |
| Cursor | `cursor-agent acp` | 专有（Cursor 服务条款） | Cursor 官方安装脚本；用这个人自己的 Cursor 账号。安装脚本同时建 `agent` 与 `cursor-agent` 两个链接，预设用后者，因为 `agent` 这个名字可能属于别的程序；图标是中性图形 |

Claude Agent 与 Cursor 不是开源软件，Latch 只启动这个人自己装好、未经修改的命令。Latch 不提供 Claude 的登录（不写登录命令、不调用 `authenticate`、不声明 terminal auth，所以适配器也不列出登录方法），不读取、保存或转交任何一家的凭据，不调用私有接口。对外发布并宣传「可用 Claude 订阅」之前，需要先取得 Anthropic 的书面确认；在自己的电脑上个人使用不受影响。

Host 启动时、开始监听之前，用账户的 shell 跑一次 `-ilc`，读出 `PATH` 和下文点名的变量（「进程与环境」），8 秒内没结束就杀掉整个进程组，退回下面这些目录。登录 shell 的 PATH 排在 Host 自己的 PATH 之前。

启动脚本让 Host 在 PATH 以及 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.npm-global/bin`、`~/.local/bin`、`~/.bun/bin` 中查找命令，不经过 shell；含 `/` 的相对路径按找不到处理。从图形界面启动的 Host 通常没有登录 shell 的 PATH，所以还查找用户目录里 Node 版本管理器与包管理器的全局目录：fnm 的 `$FNM_DIR`（或 `~/.local/share/fnm`）下的 `aliases/default/bin`、nvm 的 `~/.nvm/alias/default`（经 `lts/*` 这类别名解析）指向的 `~/.nvm/versions/node/<版本>/bin`、Volta 的 `~/.volta/bin`、asdf 的 `~/.asdf/shims`、mise 的 `~/.local/share/mise/shims`、pnpm 的 `$PNPM_HOME` 与 `~/Library/pnpm`、Yarn 的 `~/.yarn/bin`。来自环境变量的目录只在是绝对路径时使用，只接受可执行的普通文件，查到的绝对路径计入启动指纹；这些目录也追加到 Agent 进程的 PATH 上。找不到时 Agent 在选择器中显示为不可用，并给出安装提示；仍找不到时请填写绝对路径。

预设可以声明 `companion`：适配器命令要连接的另一个程序（pi-acp 连接 pi）。Host 用同样的规则查找它，「设置 → Harness」与选择器据此写出缺的是哪一个（「已安装 pi，还差让 Latch 连接它的适配器 pi-acp」「已找到适配器 pi-acp，还没找到 pi」或两者都没找到）；缺任何一个时这个 Agent 都不可用。Harness 状态里的命令查找结果缓存 5 秒；读取 `GET /link/api/agents`（设置页的「重新检测」，以及窗口重新获得焦点时）会清掉这个缓存，所以刚在终端里装好的命令下一次就能看到。这个列表里的每个预设也带同样的查找结果（`detected`，还没有据它添加 Agent 时也有），新会话页的「添加 Agent」据此在添加之前说出这台电脑上缺的是哪个程序；旧版 Host 不发它，那里只显示安装命令。Latch 不提供一键安装，只显示可复制的安装命令与项目主页。

## 预设的权限配置

每个预设的权限配置是 `packages/harness-acp/src/profiles/` 下的一个 `HarnessProfile`，只在 Host 上使用；浏览器只看到复制进 `TaskDetail.permission` 的展示字段。

- `permission`（`AcpPermissionProfile`）：`approvals`（Agent 是否请求审批）、`defaultEnv`、`expectedMode`、`modeLadder`（严格 → 宽松，由模型代为批准的模式排在询问与不再询问之间）、`hiddenOptionIds`（精确 ID，或以 `*` 结尾的前缀）、`readback`、`versionRule`（见「版本规则」）、`systemSettings`（Gemini CLI）、`configEnv`（见下）与中文 `notes`。
- `version`：计入启动指纹。改变配置的行为时应递增它，已有会话因此停止接受输入，换新会话继续。
- `projectConfigPaths`、`projectConfigManaged`：见「项目配置」。
- `materialize`：启动前在 Host 上准备 Agent 需要的文件，返回要加入的环境变量（目前只有 Gemini CLI 使用）。

选择规则：按定义的 `presetId`，否则按命令的文件名匹配预设的命令。只要选中了预设，它的环境变量和模式规则就生效；只有 `presetId` 与参数都与预设完全一致、命令就是预设的命令，并且定义没有设置会改变该 Agent 读取配置位置的变量（`configEnv`）时，定义才算「已验证的预设」，否则显示为「未验证的定义」。「就是预设的命令」指只写命令名（由 Host 自己查找），或写 Host 按这个命令名查找到的那个文件（按真实路径比较，指向它的链接也算）；其他目录里同名的文件（例如项目 `node_modules/.bin` 里的 `codex-acp`）不算，每次启动时重新判断。没有匹配任何预设的定义不设置模式，但会话中 Agent 自行改变模式一律按漂移处理。

目前只有 OpenCode 预设列出 `configEnv`：`XDG_*`、`OPENCODE_*`（其中由 Latch 管理的几个本来就不能设置）和 `USERPROFILE`，比较时不区分大小写。OpenCode 从 XDG 目录（或主目录）读取用户配置、Agent 定义与插件，且在 Latch 的规则之后加载；其余 `OPENCODE_*` 开关对询问规则的影响 Latch 没有逐一核对。设置了其中任何一个的定义仍可保存和运行，但显示为「未验证的定义」，会话权限说明中注明：`定义设置了 <变量名>，OpenCode 可能改从其他位置读取配置、Agent 定义与插件，覆盖 Latch 设置的询问规则；该定义不作为已验证的预设`。

| 预设 | Latch 设置的环境变量 | 预期模式 | 模式顺序（严格 → 宽松） | 不提供的模式 | 隐藏的选项 | 读回 |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | `INITIAL_AGENT_MODE=read-only` | `read-only` | `read-only`、`workspace-write`、`agent-full-access` | `agent` | `accept_execpolicy_amendment`、`apply_network_policy_amendment*` | 可读回 |
| Qwen Code | — | `default` | `plan`、`default`、`auto-edit`、`yolo` | `auto` | — | 可读回；恢复会话会恢复旧模式，Latch 每轮前重新设置 |
| goose | `GOOSE_MODE=approve` | `approve` | `chat`、`approve`、`auto` | `smart_approve` | — | 可读回 |
| Gemini CLI | `GEMINI_CLI_SYSTEM_SETTINGS_PATH` | `default` | `plan`、`default`、`autoEdit`、`yolo` | — | `proceed_always_and_save`、`ProceedAlwaysAndSave` | 可读回 |
| DeepSeek Harness | `DSH_PERMISSION_MODE=read-only`、`DSH_TELEMETRY_DISABLED=1` | — | — | — | — | 无法读回权限模式 |
| OpenCode | `OPENCODE_CONFIG_CONTENT`（见下） | `build` | `plan`、`build` | — | — | 可读回 |
| pi | — | — | — | — | — | 无法读回；pi 执行工具前不请求审批 |
| Claude Agent | — | `default`（Manual） | `plan`、`default`、`acceptEdits`、`auto`、`bypassPermissions` | — | — | 可读回；适配器新会话默认进 `auto`，Latch 每轮前设回预期模式 |
| Cursor | — | `agent` | `ask`、`plan`、`agent` | — | `allow-always` | 可读回 |

- DeepSeek Harness：Latch 总是设置 `DSH_TELEMETRY_DISABLED=1`（它把任何非空值当作关闭遥测），定义里同名的变量会被这个值覆盖。会话仍是完全访问（L3），Latch 读不回它的权限模式，也不确认它自己的限制是否生效。
- Gemini CLI：每次启动进程前，Host 把 `{"security":{"disableAlwaysAllow":true,"enablePermanentToolApproval":false}}` 写入 `<数据目录>/harnesses/<agent-id>/gemini-system-settings.json`，路径通过 `GEMINI_CLI_SYSTEM_SETTINGS_PATH` 传给 Gemini CLI。这些键名尚未在 Gemini CLI 的正式版本上核对。
- OpenCode：`OPENCODE_CONFIG_CONTENT` 让除读取、glob、grep、list 以外的工具都先询问，访问工作目录以外的路径（`external_directory`）先询问，拒绝读取 `.env` 与 `.env.*`，禁用子 Agent（`task`）；同样的规则也写进 `build` 与 `plan` 两个 Agent，避免它们各自的设置覆盖全局设置。这些规则只是默认值：OpenCode 还会合并用户与项目的配置（用户配置目录、从工作目录向上查找的 `opencode.json`/`opencode.jsonc`、项目与主目录下 `.opencode` 目录中的配置和 Agent 定义），其中一部分在 Latch 的规则之后加载，可以把询问改成直接允许，模式读回仍显示 `build`。Latch 无法关闭这些来源；项目中的这些配置计入启动指纹（见「项目配置」），用户配置不计入。OpenCode 启动时还会在 `.opencode` 目录中安装依赖并加载插件，因此在不信任的项目中使用 OpenCode 会运行项目里的代码。OpenCode 会话的权限说明注明了这两点。OpenCode 2.x 把 `OPENCODE_CONFIG_CONTENT` 放在用户与项目的配置文件之后、系统托管设置之前读取，所以那些文件里给 `build`、`plan` 写的规则排在 Latch 的规则之前；托管设置、`.opencode` 中的插件（插件可以改变询问的结果）和项目新定义的 Agent 仍不受这些规则约束；这样的 Agent 不在模式顺序里，按更宽的模式对待。2.x 默认放行工作目录以外的路径，Latch 的 `external_directory: 'ask'` 让它照样先询问。
- Claude Agent：五档都按 Claude 自己的名字与说明给出，Bypass 标为不询问，不预选任何更宽的一档。自动模式由 Claude 的分类器决定是否执行；计划模式在自动模式可用时，命令也可能由分类器决定（适配器默认开启 `useAutoModeDuringPlan`）。会话权限说明还写明：Claude 不需要批准的调用（工作目录内读取、只读命令）不出现在审批里，Claude Code 设置里的允许规则与 hooks 先于 Latch 生效，项目 `.mcp.json` 的服务器直接连接。版本规则要求 0.99 或之后的 0.x 适配器。
- 人选的换档（`modeAnswers`）：Agent 用一次询问来换模式时，人的「仅此一次」回答就是选了那一档。Claude 的 ExitPlanMode 只留 `exit-plan-default`（回到 Manual，其余是会持久保存的选项），EnterPlanMode 是 `switch_mode` 调用上的 `allow-once`（进入 `plan`）。Latch 在把回答交给 Agent 之前把这一档记为预期模式，所以随后的换档不算漂移；没有人回答的换档仍按漂移处理。
- 所有预设一律隐藏 `allow_always` 与 `reject_always` 类型的选项，这一点不可配置。

### 版本规则

预设可以用 `versionRule` 要求 `initialize` 返回的 `agentInfo.version` 匹配一个正则。不匹配或未报告版本时，Latch 结束该进程，会话以 409 `harness-version-unsupported` 失败（`<名称> 版本 <v> 未经验证（<说明>），已拒绝启动。`）。OpenCode 的规则是 `^[12]\.`，说明为 `OpenCode 仅支持 1.x 与 2.x`：上面的配置键是 1.x 的格式，2.x 仍读取 `OPENCODE_CONFIG_CONTENT`，并把 1.x 的 `permission` 与 `agent.<名称>.permission` 换成同样的有序规则（后写的规则优先，没有匹配时询问；`task` 换名为 `subagent`），`build` 与 `plan` 两个 Agent 和模式 ID 不变；3.x 及以后的读取方式未经核对。Claude Agent 的规则见上。核对依据是 2.x 的源码与按它手写的回放（`replay/opencode/2.x/`），不是运行中的 OpenCode。

## 项目配置

多数 Agent 启动时会读取项目里的配置，其中的设置可以改变询问规则、加载插件或扩展。Latch 把预设列出的项目配置（`projectConfigPaths`）的内容计入启动指纹（见「启动指纹」），会话启动之后它们的任何变化都会让会话不能继续。会话页面不列出找到的项目配置。

| 预设 | 计入启动指纹的项目配置 | 不计入（Agent 自己写入的内容） |
| --- | --- | --- |
| OpenCode | `opencode.json`、`opencode.jsonc`、`.opencode/` | `.opencode/` 下的 `node_modules`、`bun.lock`、`bun.lockb`、`.gitignore`、`plans`；`.opencode/package.json` 中 OpenCode 自己添加的 `@opencode-ai/plugin` 依赖（文件只剩这一项时整个不计入） |
| Codex | `.codex/`；收到其他文件夹的会话还有 `.agents/skills/` | — |
| Gemini CLI | `.gemini/` | — |
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

一个项目可以由几个文件夹组成（见 [ARCHITECTURE.md](./ARCHITECTURE.md#会话与项目)）。ACP 会话的工作目录（ACP 的 `cwd`，也是进程的工作目录）始终是主文件夹；其他文件夹能否交给 Agent，取决于 Agent 自己：

| 预设 | 其他文件夹怎样交给它 | `HarnessInfo.projectFolders` | 说明 |
| --- | --- | --- | --- |
| Codex | ACP 的 `additionalDirectories`：`session/new`、`session/resume` 与 `session/load` 每次都发送完整列表 | `{ access: 'all' }` | 只在 `initialize` 声明了 `sessionCapabilities.additionalDirectories`（一个对象）时发送。没有声明时 Latch 结束该进程并返回 409 `agent-folders-unsupported`，会话不会创建。codex-acp 把每个文件夹当作受信项目并加载其中的 `.agents/skills`；在 `workspace-write` 模式下这些文件夹也可写 |
| Gemini CLI、Qwen Code | 在定义的参数之后，每个其他文件夹追加一次 `--include-directories <真实路径>`；每个会话有自己的进程，参数只对它生效 | `{ access: 'all', max: 5 }` | 最多 4 个其他文件夹，超出时返回 409 `harness-folder-limit`，不启动进程。它们按逗号拆分这个参数，含逗号的路径返回 400 `workspace-folder-chars`（Host 本来就不接受这样的新文件夹） |
| OpenCode | 不传（1.x 的 ACP 不支持；2.x 声明支持，Latch 尚未使用） | `primary-asks` | Latch 设置的 `external_directory: 'ask'` 让它访问工作目录以外的路径之前先询问；2.x 默认放行这类访问，这条规则让它照样先询问 |
| DeepSeek Harness | 不传（它拒绝这个字段） | `primary` | — |
| pi、goose | 不传（它们没有这个概念） | `primary-unbounded` | 它们不限制工具能访问的路径 |
| 未匹配预设的定义 | 不传 | 无（客户端按 `primary` 显示） | — |

- 只有 Codex、Gemini CLI 与 Qwen Code 的 Driver 声明 `projectFolders: 'all'`，Host 只把项目标识与文件夹交给它们，其他 ACP Driver 只收到主文件夹。Driver 用 Host 的 `projects()` 再核对一次：项目在列表中、`folders[0]` 是主文件夹，每个文件夹的标识与真实路径都属于这个项目，否则 400 `workspace-unavailable`。交给 Agent 的是各文件夹的真实路径，按项目中的顺序，不含主文件夹，也不重复。
- 只收到主文件夹的 Driver，其会话摘要由 Host 标记 `folderAccess: 'primary'`。`workspaces()` 也列出项目内仍可用的旧主文件夹，调整顺序后的已有会话继续使用原工作目录。
- 其他文件夹计入启动指纹与项目配置（见「项目配置」），审计记下文件夹数量（`folderCount`）。文件夹范围由 Agent 自己执行，不是隔离。
- 会话把项目与文件夹记在摘要中（`workspaceId`、`folders`、`folderAccess: 'all'`），把交给 Agent 的真实路径与方式记在 `acp.folders` 与 `acp.folderVia`，之后不再改变：项目新加的文件夹只用于新会话，改变主文件夹也不影响已有会话。每次输入、修改设置、启动进程、恢复或加载会话，以及为删除会话临时启动进程之前，Latch 确认这些文件夹仍属于该项目且仍在原来的真实路径；文件夹被移出项目、被替换、找不到，或项目已不在列表中时返回 409 `workspace-changed`，删除时只删除 Latch 的记录。之后启动的进程不再声明支持时，本轮不发送，返回 409 `agent-folders-unsupported`，进程被结束。
- 这些文件夹只是 Agent 自己执行的范围，不是隔离。ACP 会话仍是完全访问（L3），Agent 可以访问 Host 用户能访问的任何路径。

## 启动指纹

开始会话不弹确认。启动指纹（`launchHash`）由解析出的命令路径、参数、定义的变量、预设（含 `inheritEnv` 的名字与 `programEnv` 找到的路径，见「进程与环境」）、计入的项目配置与交给 Agent 的其他文件夹算出，不含项目配置与文件夹的部分另记为 `definitionHash`。启动审计 `task.l3.start-requested` 记下 `launchHash`，`task.l3.started` 再记下 `definitionHash`；两者随会话保存在 `acp.launchHash` 与 `acp.definitionHash`。之后按「项目配置」所列的时机重新计算：定义或解析出的命令变化时返回 409 `agent-definition-changed`，只有项目配置变化时返回 409 `project-config-changed`。已有会话随之停止接受输入，换新会话继续。

## 启动诊断

Agent 详情页提供「测试启动」，在原位显示握手结果与诊断。缺少权限或命令没有找到时按钮停用并写明原因。

`POST /link/api/agents/:id/probe { requestId }` 接受同时持有 `admin` 与 `run` 的设备，不弹确认。

探测只发送 ACP `initialize`（有登录状态命令的预设之后再问一次，见「登录」），不发送 `authenticate`、`session/new` 或提示词；握手最多等待 15 秒，随后停止进程组并等待真实退出。登录检查与下面的版本读取在剩下的时间里同时进行，每项最多 10 秒；整次测试启动最多 20 秒（`AGENT_PROBE_MAX_MS`），页面等 25 秒，超时才显示结果未确认。Host 关闭也会取消和等待探测。能力包含图片、恢复、加载和附加文件夹。`authMethods` 只说明程序提供哪些登录方法，不证明尚未登录；因此握手成功只表示 `ready`，模型访问仍未验证。只有明确的 `auth_required` RPC 错误表示 `authentication-required`，其他失败为 `failed`。

适配器驱动这个人自己装的程序时（Codex 预设经 `CODEX_PATH` 驱动 `codex`，profile 的 `programVersion`），探测之后再用登录检查的规则读一次那个程序的版本（`codex --version`）。运行的是会话里适配器会用的那个程序：定义设了 `CODEX_PATH` 时用它的值，绝对路径直接运行，名字按 Host 找命令的规则找；否则是 Host 按 `agentCommand` 找到的程序。限时，不经过 shell，只留下版本号。定义里的相对路径要在项目文件夹里才能解析，测试启动不在那里运行，写「版本未知」；空值让适配器用自带的那份。结果的 `program` 写出程序名与版本，页面把它和握手报告的适配器版本写在一起；读不出版本时写「版本未知」，没有装这个程序、定义也没指定（适配器用自带的那份）时不写。两个版本都知道、又不在 profile 的 `checked` 里时，`program.unchecked` 为真，页面显示琥珀色提示「这个组合 Latch 没有核对过」，不阻止启动。`checked` 是写预设时从每个适配器版本的 `package.json` 抄来的依赖范围（codex-acp 2.3.0 配 Codex 0.164.x，2.4.0 与 2.5.0 配 0.165.x），运行时不下载任何东西；适配器的预览版不在其中。

结果带 `checkedAt`、`launchHash` 与最多 4 KiB 的诊断；先按定义变量与秘密格式脱敏，再截取结尾。最近结果以可选 `AgentRecord.lastProbe`、`probedDefinitionHash` 保存，`AgentSettings.lastProbe` 只返回同一定义的记录；修改启动内容会清除它。探测通过不等于会话已经启动，不修改 `startedHash`，也不授予以后启动会话的信任。运行前写审计 `agent.probe.requested`，结束后记录 `agent.probed`；审计只含 ID、哈希与状态。当前 Host 生命周期内，同设备同 `requestId` 共享整次探测与记录过程，重试不再执行程序；这份记录只在内存中，Host 重启后同一 `requestId` 会再执行一次探测。

## 进程与环境

- 每个 Latch 会话有自己的 Agent 子进程（一个 ACP 会话），首次需要时启动，工作目录为该会话的主文件夹；Gemini CLI 与 Qwen Code 的参数之后追加其他文件夹（见「项目的多个文件夹」）。同一个 Agent 定义最多同时运行 8 个进程（`AcpAgentOptions.maxProcesses`）；达到上限时，Latch 停止最久未使用的、可以恢复的空闲进程，没有可停的进程时返回 503 `agent-busy`（`同时运行的 <名称> 会话过多，请先结束一些会话`）。
- 子进程在独立进程组中运行。stderr 持续读取到 64 KiB 环形缓冲，只在启动失败或崩溃时以脱敏的短摘要写入 Host 日志，不进入会话记录。
- Agent 得到的环境来自 `agentEnvironment`，后者覆盖前者：Host 的白名单（`HOME`、`LANG`、`LC_*`、`TERM`、`USER`、`SHELL`）；代理（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及小写）、CA 文件（`SSL_CERT_FILE`、`SSL_CERT_DIR`、`NODE_EXTRA_CA_CERTS`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE`）与 `__MISE_DIFF`；profile 的 `inheritEnv`（各家的 home，见下表）；profile 的 `programEnv`（`CODEX_PATH`、`PI_ACP_PI_COMMAND`，指向 Host 找到的程序，没装就不设，适配器用自带的）；Agent 定义的变量；profile 的 `defaultEnv` 和 Latch 强制的值（`TMPDIR`、`NODE_TLS_REJECT_UNAUTHORIZED=1`、Git 设置）。最后删除 `NODE_OPTIONS`、`LATCH_*`、`npm_*`、`DYLD_*`、`LD_*`。从终端启动的 Host 已有的变量优先于登录 shell 读到的。

  | 预设 | 继承的 home |
  | --- | --- |
  | Codex | `CODEX_HOME`、`CODEX_SQLITE_HOME` |
  | pi | `PI_CODING_AGENT_DIR` |
  | OpenCode | `XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME`、`XDG_CACHE_HOME` |
  | DeepSeek Harness | `DSH_HOME` |
  | Gemini CLI | `GEMINI_CLI_HOME` |
  | Qwen Code | `QWEN_HOME`、`QWEN_RUNTIME_DIR` |
  | goose | `GOOSE_PATH_ROOT`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME` |
  | Claude Agent | `CLAUDE_CONFIG_DIR`（定义不能设置） |

  没有预设的自定义定义只继承代理、CA 与 `__MISE_DIFF`。`inheritEnv` 不能点名 `*_KEY`、`*_TOKEN` 这类秘密（`test/login.test.ts`）；读登录 shell 时只取点名的变量，其余输出丢弃，不记日志，shell 也拿不到 `LATCH_*` 与 `NODE_OPTIONS`。
- 启动指纹只计 `inheritEnv` 的名字和 `programEnv` 找到的路径，不计任何值：`launchHash` 会发给客户端，代理地址可能带密码。代理与 CA 的名字是固定的，不进指纹；换代理不影响已有会话。诊断与预览不显示值，带账号密码的代理地址在诊断里被遮盖。
- 模型服务的密钥、地址等需要在 Agent 自己的配置里设置，或写进 Agent 定义的环境变量。
- `initialize` 返回的协议版本必须是 1，否则启动失败。Latch 声明 `fs.readTextFile`、`fs.writeTextFile` 与 `terminal` 能力均为 false，Agent 使用自己的文件与命令执行能力；声明 `session.notices` 与 `session.compaction`，见「通知与压缩」。`session/new`、`session/resume`、`session/load` 只在会话带着技能时传一个 MCP 服务器：Latch 的只读技能服务器（`skills-server.ts`，列出并读取技能，不写、不联网），其余情况传空列表；Agent 发来的请求只处理 `session/request_permission`，其他方法返回 method not found。Latch 不调用 `authenticate`：Agent 要求登录时返回 409 `agent-auth-required`，文字是「Codex 还没登录。按它自己的方式登录后重试。」（预设写了 `signIn` 的用它：Claude Agent 是「在终端里按 Claude Code 自己的方式登录（或在它的设置里使用你自己的 API key）后重试。」），并停掉这个进程，因为 Agent 可能只在启动时读取登录状态：下一次重试启动新进程。这一轮的 `runEnd` 是 `login-required`，页面给出登录命令和「重试」；已有 ACP 会话时下一轮走 `session/resume`，不用新建会话。见「登录」。
- 空闲 10 分钟且 Agent 支持恢复会话时，进程会被优雅停止，下次需要时再启动。
- 进程崩溃时，该会话转为 `failed`，`runEnd` 为 `process-exited` 并列出结果未知的调用，`runOutcome` 仍是 `interrupted`（见 [STREAMING.md](./STREAMING.md#运行的真实状态)）；之后的重启从 250 ms 开始按最近的崩溃次数加倍延迟（最多 5 秒），同一定义一分钟内崩溃 3 次会暂停自动重启一分钟（503 `agent-paused`）。

## 通知与压缩

- **通知（`notice`）。** Agent 不属于对话历史的提示，例如 Codex 的配置警告。每条在时间线上一行系统消息：「Codex 警告：……」，`severity` 为 `error` 时写「报告错误」，其他写「提示」，`description` 另起一行。它不改变本轮状态，也不让本轮失败。
- **压缩（`compaction_update`、`compaction_summary_chunk`）。** 一次压缩一行，按 `compactionId` 找到同一行并就地更新：「正在压缩上下文……」「已压缩上下文」「压缩上下文失败：原因」「已取消压缩上下文」；Agent 给出的摘要接在后面。行的位置是第一次报告到达时，在它之前的回复先结束。压缩失败不让本轮失败。
- **各家说法不同的地方。** profile 的 `normalizeUpdate` 把 Agent 自己的说法换成 ACP 的，只换不添：Qwen Code 只在 `_meta.toolName` 里给出工具名，填进 `name`；OpenCode 把回复的思考放在推理片段的 ID 下，会把一条回复拆成两条，去掉这个 ID 后思考归入它所属的回复。调用的 `kind` 只是 `other` 时用它的标题命名（DeepSeek Harness 的 `bash`）。
- **用量。** `session/prompt` 的 `usage` 只取 `inputTokens` 与 `outputTokens`。缓存与思考的令牌数各家含义不同：Codex 的输入含缓存读取，OpenCode 的不含，所以不映射。

## 登录

Latch 从不替人登录，不调用 `authenticate`，不读凭据文件或钥匙串。它只运行程序自己的命令。

- **命令。** `AgentPreset.login` 记录登录命令（`codex login`、`opencode auth login`、`goose configure`、`cursor-agent login`；Claude Agent 没有，页面不显示登录命令或按钮，只在失败时说一句 `signIn`；pi、Gemini CLI、Qwen Code 是进入程序后按说明操作；DeepSeek Harness 没有记录）。Codex 没单独安装时用适配器自带的 `codex-acp cli login`。自定义定义没有。经 `HarnessInfo.login` 发给客户端。
- **三态。** `POST /link/api/harnesses/:id/login-status`（`run`，可带 `fresh`）返回 `authenticated`、`unauthenticated` 或 `unknown`。目前只有 Codex 有说得清的命令：`codex login status`。退出 0 算已登录；退出 1 且文字是 `Not logged in` 才算未登录，它的其他错误也退出 1，所以都算 `unknown`；超时 10 秒。输出只在判断时读一次，可能含账号或部分密钥，不返回、不记录。其他 Harness 始终 `unknown`，要到 `session/new` 被拒绝才知道。结果缓存 30 秒。每次实际运行之前写审计 `agent.login.requested`（写不进就不运行），结束后写 `agent.login.checked`，只含 ID 与状态。「测试启动」的结果带 `login`。
- **页面。** 选中 Harness 时检查一次，窗口回到前台时再查；只在 `unauthenticated` 时显示，不挡发送，因为程序才说了算。一轮被拒绝后在这一轮的结尾显示命令和「重试」。
- **终端。** `POST /link/api/harnesses/:id/login-terminal` 只接受 `host.sock` 与 `run`（`features.loginTerminal`，仅 macOS）。Host 写一个 0700 的 `.command` 临时文件交给 `open`，用这个人默认的终端和它自己的环境运行程序的绝对路径；脚本先删除自己。写审计 `agent.login.opened`。页面还没有终端界面（[TERMINAL.md](TERMINAL.md)），所以不是内置终端。其他设备只看到命令和「在这台 Mac 的终端里运行」。
- **测试 Host。** `startServer` 没有 `loginPrograms` 时不运行任何登录命令，也不显示命令；没有 `commandDirectories` 时只认绝对路径，按名字找命令一律找不到（Agent 的命令、适配器、`programEnv` 指向的程序与预设检测都一样）。只有启动脚本传 `resolveCommand` 与 `personCommandDirectories`。这样带预设定义和假适配器的测试 Host 碰不到同一台电脑上真实安装的程序；测试要找命令时把自己的临时目录传给 `commandDirectories`。

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
- **读取。** 还没有列表时，可以不开始会话就读一次（`HarnessInfo.catalogueRead`，`POST /link/api/agents/:id/catalogue { auto? }`）：在 Host 临时目录下新建的空文件夹里启动 Agent，`session/new` 带空的 `mcpServers`，不发提示；Agent 声明 `sessionCapabilities.delete` 就 `session/delete`，否则声明了 `close` 就 `session/close`；然后停止进程并删除文件夹，最多等 20 秒。Codex 预设不开会话：用定义的命令加 `cli app-server`（codex-acp 用 `CODEX_PATH` 指向的 Codex，没有就用自带的），只发 `initialize`、`config/read` 与 `model/list`（按 `nextCursor` 翻页，最多 5 页），不开线程；结果写成 codex-acp 会话里同样的 `model` 与 `reasoning_effort` 选项，所以开始前的选择能直接用在随后的会话上，列表里原有的其他选项保留。
  - 什么时候读：新会话里选中这个 Harness，或打开它的模型菜单，或打开 Latch 没有权限 profile 的 Harness 的权限菜单（它的模式只能从读取或会话得知），而它既没有列表、这份定义也没读过时，自动读一次（`auto: true`；Host 再查一遍，不符合就不读，返回 `ran: false`）。从不按时间读，失败后也不再自动重读。pi 只在菜单里点「读取 pi 的模型列表」时读，因为它启动时会加载用户的扩展、运行会话钩子。菜单里随时可以「重新读取」。
  - 谁能读：和开始会话同一道门，要 `run` 范围，Harness 可以开始（不可用时 409）；只读设备只看已有列表。同一定义同时只读一次，其他请求共用结果。启动进程之前写审计 `agent.catalogue.requested`（写不进就不启动），结束后写 `agent.catalogue.read`（只记成功与否）。
  - 结果：成功时列表来源为 `check`；失败时保存 `last: { ok: false, message }`，消息经过脱敏，菜单写「没有读到：…」，如「OpenCode 还没登录。按它自己的方式登录后重试。」，不弹登录。定义一变，上次读取的结果也不再下发。
- **自己填的模型 ID。** 菜单里「填写模型 ID…」把 Harness 没列出的模型 ID 存进这个 Harness 的 `acp.json`（`HarnessInfo.customModels`，`PUT /link/api/agents/:id/models { models }`，要 `run`，最多 32 个，每个最多 256 字符、不能换行，审计 `agent.models.changed` 只记个数），在模型列表里标「自己填写」，换定义也保留。只有列表里有模型选项时才能填，因为 ACP 只能经这个选项设置模型。开始时和会话里都原样发给 Agent；开始时 Agent 拒绝或没换过去，这一轮失败，文字和不再提供时一样说出下一次会用什么（「<名称> 没有换到模型「…」，这条消息没有发出。再发送会用「…」，也可以先在模型里换一个。」），之后的发送用会话显示的模型。
- **显示。** 新会话的模型、思考与权限都从这份列表画，和会话里是同一个组件；菜单底部写「来自上次会话 · 时间」或「读取于 时间」。选了一个列表没说思考深度的模型时，思考写「开始后才告诉 Latch」。没有列表时写「默认模型 · 默认思考」；能读取时菜单里是读取的入口，读取中写「正在读取…」，不能读取时写「开始后才报告」。Latch 没有权限 profile 的 Harness，权限在能读取时写「读取后可以选」，读取中写「正在读取…」，读到的列表没有模式或这台设备读不了时写「开始后可以选」。设备记住模型与思考的选择（按 Harness），不记住模式：每个新会话都从开始前设好的模式开始。
- **应用。** 开始请求带 `config: [{ configId, value }]`（最多 16 项，同一项只能一次），计入请求摘要；Latch 内置 Harness 用 `model`，带 `config` 返回 400 `config-unsupported`。`session/new` 之后、第一条提示之前，依次设置模型、Agent 为这个模型提供的其他选项（思考等）、模式；模式交给「权限模式」的设置与读回。每项都从 Agent 的回答读回。
- **不再提供时。** 选的模型或模式 Agent 不再提供：这一轮失败，不发提示，文字说出它的名字和下一次会用什么（「Codex 现在没有模型「Large」，这条消息没有发出。再发送会用「Small」，也可以先在模型里换一个。」）。失败之前照常设好草稿里的其他选择，再设好并读回模式，没有哪一项留到下一次，所以会话显示的就是之后运行的。思考等其他选项不再提供或被拒绝：保持 Agent 的默认值，并在会话里加一条系统消息。会话里改了某一项，就取代开始前对这一项的选择。Agent 要先登录时，还没设好的选择留到登录后的那次发送；在那之前会话显示不出它们（尚未实现：会话详情不带还没设好的选择）。
- **审计。** `task.l3.start-requested` 与 `task.l3.started` 带 `configHash`（所选内容的摘要，值是 Agent 自己的文字，不原样记录）。开始前选更宽的模式和会话里一样不弹确认。

会话选项修改的未知结果通过 Host 配置回执查询，不自动再次发送 `set_config_option`；Agent 超时或连接关闭无法证明没有执行。回执只有请求摘要与状态，不保存自定义选项原值。`SetConfigOptions.authorize` 在准备连接前和实际发送 RPC 前同步复查 Host 授权；详情见 [ARCHITECTURE.md](ARCHITECTURE.md#会话配置修改回执)。

**时间。** 时间都由 Host 的时钟（`HarnessHostOptions.clock`）记录，含义见 [STREAMING.md](./STREAMING.md)「时间与用量」。一轮从 Latch 接受提示开始：发出提示之前（启动进程、建立或恢复会话、设置模式）`activity` 是 `starting`，提示发出后是 `model`；`since` 只在阶段或工具变化时更新。正文与思考片段的第一段到达时记下这一段的开始，结算时写入 `completedAt`、`reasoningMs` 与模型（会话里 Agent 报告的当前模型选项的值）；工具第一次被记录时写 `createdAt`，第一次进入 `in_progress` 时写 `startedAt`，Agent 报告完成或失败时写 `completedAt`；一轮结束时 Latch 替它结算的工具，只有运行过的才写 `completedAt`。审批活动的 `since` 与原等待起点 `runWaitingSince` 使用同一个时间戳，跨毫秒取时也不会分裂。询问挂起期间计入这一轮的等待时间；一轮结算时把 `turn` 写在开启它的用户消息上。

`TaskDetail.permission` 描述该会话：`level: 'L3'`、`enforcer: 'NONE'`、能否读回模式、定义是否为已验证的预设、是否请求审批、预期模式、漂移记录、预设说明和定义的说明；不列出项目配置与其他文件夹。

未知的更新类型会被忽略。单条工具文本上限 64 KiB；每个工具最多 32 个 diff，每个 diff 的原内容与新内容各截断到 128 KiB；单行协议消息超过 64 MiB 会终止进程。

## 审批

- 选项类型按任意字符串解析。Latch 去掉 `allow_always`、`reject_always`、预设隐藏的选项 ID 和未知类型，只展示「仅此一次允许」与「仅此一次拒绝」。
- 去掉之后若没有「仅此一次允许」，Latch 不展示审批，直接以「仅此一次拒绝」答复（没有该选项时答复为取消），追加系统消息「已自动拒绝：<名称> 只提供会持久保存的选项或未知选项，Latch 不提供。」，并记录安全事件。
- 选择被去掉的选项返回 400 `approval-option-hidden`；选择的选项必须属于该审批，且与允许/拒绝方向一致。只说"允许"时使用「仅此一次允许」；只说"拒绝"时使用「仅此一次拒绝」，没有该选项时答复为取消。
- 一个会话可以同时存在多个审批；多设备竞争时只有一个决定生效。不在进行中的一轮里的询问答复为取消。
- 允许 ACP 询问要求 `run` 权限，任何设备都可以（不弹确认，不提供「始终允许」）；拒绝可以在任何已登记且有查看权限的设备上进行。
- 询问结束后，那次工具调用带上决定记录 `ToolDetail.decision`（见 [ARCHITECTURE.md](./ARCHITECTURE.md)「决定记录与拒绝说明」）：人的允许或拒绝记 `allowed`、`rejected` 与在哪里决定；取消、一轮结束、进程退出、Host 重启时还开着的询问，以及权限漂移时 Latch 自己拒绝的询问，记 `cancelled`，不算作某人的拒绝；Agent 撤回的询问不留记录；同一调用询问多次时，已经给出的允许不被之后的拒绝或取消覆盖。拒绝不保证 Agent 不执行：Agent 之后报告的开始、完成与差异照常显示。ACP 的权限回复不能带文字，所以拒绝附带的说明（「告诉 Harness 改做什么」）不会转给 Agent。
- 有些 Agent（例如 pi，或处于自动批准模式的 Agent）不请求审批，Latch 不会显示审批卡片。Latch 的审批不是操作系统沙箱。

## 取消

任何已登记且有查看权限的设备都可以取消。每一轮有自己的 `runId`（在把这一轮写入会话时生成并持久化）；取消带着它时，Driver 只在它仍是当前这一轮时取消，否则什么也不做（Host 回答 `ended`，见 [STREAMING.md](./STREAMING.md#取消的请求-id-与回执)）。

1. 发送 `session/cancel`，同时把该会话所有未决的审批答复为 `cancelled`。
2. 继续接收 Agent 的更新，等待本轮 `session/prompt` 结算后才确认取消；状态记为 `cancelled`，无论 Agent 返回什么 stopReason。
3. 30 秒内仍未结算时终止该会话的 Agent 进程组，会话转为 `interrupted`；其他会话有各自的进程，不受影响。执行中的工具标记为结果未知，请核对副作用；`TaskSummary.runEnd`（`forced-stop`）与取消回执列出它们，见 [STREAMING.md](./STREAMING.md#运行的真实状态)。

## 运行中追加

Agent 在 `initialize` 的 `_meta.steering = { supported: true }` 声明后，运行中的输入经 `_session/steering` 加入当前这一轮，始终带 `_meta.steering.idleBehavior: "promptRequired"`，让 Agent 在没有轮次时不自己开新一轮，完成、用量与失败都留在原来的 `session/prompt` 上。`injected` 记为这一轮里的用户消息；`promptRequired` 交回 Host 排队；其他结果或错误不发出、报错；30 秒没有回答记为结果未知，不重发。停止开始后不再追加。没有声明的 Agent 照常排队。语义见 [STREAMING.md](./STREAMING.md#追加到运行中的一轮)。

## 子 Agent

Latch 在 `initialize` 声明 `clientCapabilities.subagents: {}`（ACP 子 Agent 草案）。Agent 在一个会话上发 `subagent_update` 宣告它启动的子 Agent 后，Latch 在宣告到达的位置放一行 `Message.subagent`：名字、说明、它自己最后报告的状态（`running`、`requires_action`、`idle` 及停止原因、`unknown`），以及它的回复与工具调用（不含思考，最多 200 步，每段文字最多 64 KiB）。子 Agent 自己的子 Agent 放在它的步骤里，最多 4 层；同一进程同时最多 64 行，报告已停止的子 Agent 在一轮结束后不再计入。超出行数、层数或 200 步的部分不显示，会话里写一条说明，但它们请求的审批照常出现，不会被替人取消。子 Agent 不是 Latch 会话，不能发消息、不进侧栏。

- 子 Agent 在自己的会话上请求权限时，审批出现在启动它的会话里，`Approval.subagent` 写明是谁；它的调用只在子 Agent 的步骤里，不在会话自己的记录中。规则与会话自己的审批相同（可选项过滤、任何有 `run` 的设备都能允许）。
- 停止会话时，子 Agent 挂起的请求与会话自己的一起答复为 `cancelled`。
- 一轮结束时仍说自己在运行或等批准的子 Agent 记为「状态未知」，不当作还在运行；它未完成的调用与会话自己的一样结算：在跑的记为结果未知，还没开始或在等批准的记为未执行，之后它再报告完成或失败时以报告为准。
- 没有宣告的会话 ID 的更新照旧丢弃，不猜归属；不支持的 Agent 仍把子 Agent 的工作当作普通工具调用报告。

## Agent 自己的请求

预设的 profile 可以读某个 Agent 在 ACP 之外发来的请求（`extensions`）。这些请求不带会话 ID，而一个进程只跑一个会话，所以归到这个进程的会话。目前只有 Cursor：

- `cursor/create_plan`：在会话里成为一条审批「计划：<名称>」，内容是它的概述与计划正文，选项是「接受计划」与「不接受」。回答按 Cursor 的形状回传（`{ outcome: { outcome: "accepted" | "rejected" | "cancelled" } }`），停止会话时是 `cancelled`；回答后这一行结束。
- `cursor/update_todos`：成为会话的计划进度；`merge` 按条目 `id` 合并到上一份，被取消的条目不再列出。
- `cursor/ask_question`：Latch 还不能在这里回答 Cursor 的选择题，所以回答 `skipped`，并在会话里写一行它问了什么（问题与选项），请人在下一条消息里回答。
- `cursor/task`、`cursor/generate_image` 等通知不处理。

其他 Harness 发来同名请求时照「看不懂的请求」处理。

## 看不懂的请求

Latch 只处理 Agent 发来的 `session/request_permission`。其他请求（包括未声明的文件系统、终端与追问）和读不懂的询问都立刻答复错误（`-32601`、`-32602`），Agent 不会一直等一个不会来的回答，同时不被吞掉：会话记录里写一条系统消息，说明方法名与脱敏后的内容（带附件的一轮不写内容，内容最多 2000 字符），同一轮同一方法只写一次，最多 8 种；运行中的 `TaskSummary.live.unrecognized` 给出次数与时间。`unrecognized.at` 不早于 `lastEventAt` 表示 Agent 之后再无动静，会话进「等你处理」；一有动静，Host 就让列表重读。会话尚未建立时只写入 Host 日志。

## 持久化与恢复

- 数据保存在 `<数据目录>/harnesses/<agent-id>/acp.json`，与 Standard 相同的原子写入与锁文件，字段由 `packages/harness-acp/src/store.ts` 的 zod schema 校验。请求回执与用户消息在发送 `session/prompt` 之前写入。每个会话还记录启动指纹、定义指纹、经确认的预期模式、漂移记录、选中的预设，以及收到全部文件夹的会话的项目、文件夹与交给 Agent 的文件夹；旧文件没有这些字段时照常读取。
- Host 重启后，运行中或待审批的会话转为 `interrupted`，不会自动重发输入。
- 继续一个进程已退出的会话时，先核对启动指纹（含项目配置），再依次尝试 `session/resume`、`session/load`（丢弃重放的历史，因为 Latch 已保存），然后读回权限模式；都不支持时返回 409 `harness-session-lost`，需要新建会话。恢复与加载都重新发送完整的 `additionalDirectories`。会话的项目目录或文件夹已不在 Host 的项目列表中时返回 409 `workspace-changed`。
- 删除会话会删除 Latch 的记录、结束该会话的进程并清理临时目录；只有 Agent 声明支持时才调用 `session/delete`，否则 Agent 自己的存储中仍保留该会话。进程已退出时，只有项目目录仍在 Host 的项目列表中（收到全部文件夹的会话还要求它的文件夹都仍属于该项目）才会为此启动进程，因为 Agent 启动时可能运行工作目录中的代码；项目已移除时只删除 Latch 的记录，Agent 中的副本保留，并在 Host 日志中注明。

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
| `harness-version-unsupported`（409） | Agent 版本未经验证（目前用于 OpenCode） |
| `workspace-unavailable`（400） | 工作目录不是 Host 登记的项目目录，或所选项目的文件夹与 Host 登记的不一致 |
| `workspace-folder-chars`（400） | 要以参数交给 Agent 的文件夹路径含逗号 |
| `workspace-changed`（409） | 会话使用的文件夹已不在项目中、被替换或找不到，或项目已不在 Host 的项目列表中；新建会话的过程中交给 Agent 的文件夹变了 |
| `agent-folders-unsupported`（409） | Agent 的当前版本没有声明 `additionalDirectories`，会话没有开始或本轮没有发送 |
| `harness-folder-limit`（409） | 项目的文件夹超过 Agent 能使用的数量（Gemini CLI、Qwen Code 最多 5 个） |
| `agent-auth-required`（409） | Agent 要求登录；按它自己的方式登录后点重试 |
| `harness-no-login`（404） | Latch 不知道这个 Harness 的登录命令 |
| `terminal-open-failed`（502） | 没有打开终端；自己在终端里运行这条命令 |
| `harness-session-lost`（409） | Agent 无法恢复该会话 |
| `agent-not-found`、`agent-start-failed`、`agent-paused`、`agent-busy`、`agent-exited`（503） | 命令缺失、启动失败、连续崩溃后暂停、同时运行的进程过多、进程已退出或正在停止 |
| `agent-timeout`（504） | Agent 长时间没有响应会话建立或设置请求（初始化超时属于 `agent-start-failed`） |
| `not-supported`（501） | Agent 不支持修改该选项 |

## 尚未实现

| 项目 | 原因 |
| --- | --- |
| 操作系统沙箱、Agent 出站代理 | 未实现；因此 ACP 会话固定为完全访问（L3），Agent 自己的文件与网络访问不受 Latch 约束 |
| 中和项目配置（例如在启动前屏蔽 `.opencode` 插件） | 未实现；Latch 只把项目配置计入启动指纹，变化时停止会话 |
| 托管安装 Agent | 未实现；预设只使用本机已安装的命令 |
| OpenCode 2.x 的子会话通道（`opencode/session/child_update`） | 未实现；Latch 不声明 `opencode/child-session-updates`，子 Agent 仍按上面的规则禁用 |
| 单独停止某个子 Agent | 未实现；停止只作用于整个会话 |
| goose 的运行中追加 | 未实现；它的私有方法要 goose 自己的运行标识，也没有声明字段，要等真实录制核对 |
| 按会话放行 OpenCode 访问其他文件夹 | 未实现；需要按会话改变 OpenCode 的配置并提高其 profile 版本。OpenCode 访问其他文件夹时逐次询问；2.x 的 ACP 字段尚未使用 |
| Cursor 的选择题（`cursor/ask_question`）放进提问卡片 | 未实现；提问卡片还没有接到 ACP 驱动上，现在回答 `skipped` 并把问题写进会话 |
| Claude Agent 的其他文件夹（`additionalDirectories`） | 未实现；Claude 访问会话目录以外的路径时逐次询问 |
| 只有主文件夹的 Codex 会话计入 `.agents/skills/` | 未实现；需要提高 Codex profile 的版本，已有 Codex 会话届时要新建 |

## 测试

`packages/harness-acp/test/acp.test.ts`（`pnpm test --project @latch/harness-acp`）使用 `packages/testkit/fixtures/fake-acp-agent.mjs`（`@latch/testkit` 的 `FAKE_ACP_AGENT`，确定性的假 Agent，按环境变量与输入关键词切换场景，可模拟模式、粘滞模式、恢复后的模式与不报告模式的恢复、修改模式时自行切换的模式、缺少类别或缺失的模式选项、版本号、`additionalDirectories` 能力（`FAKE_ACP_CAPS_FILE` 让同一定义之后的进程改变声明）和环境转储，并记录启动参数），覆盖流式、思考、工具与 diff（含 diff 是否为新文件的记录与持久化）、审批与选项过滤、自动拒绝、取消（含不遵守协议的 Agent）、崩溃、恢复、启动指纹、模式读回与漂移（含运行中修改模式）、环境变量白名单、改变 OpenCode 配置位置的定义变量、项目配置（项目内与上级目录、经过符号链接的项目路径、OpenCode 自己写入的内容、开始过程中与之后的变化、空闲后重启与删除前的检查）、每会话进程与进程上限、项目移除后的删除、项目的多个文件夹（Codex 的能力门槛与恢复时重发、Gemini CLI 与 Qwen Code 的参数与上限、不接收文件夹的预设、文件夹被移出、替换或删除后的停止、每个文件夹中的项目配置）、旧式模型选项、异常输出与幂等。预设的权限配置通过 `presetId` 套用到假 Agent 上测试。测试从不启动真实 Agent。

### 会话命令

ACP `available_commands_update` 的当前列表作为可选 `TaskDetail.commands` 发送给客户端，并随 ACP 会话持久化。每次更新替换之前的列表（空列表撤下命令）；最多 200 条，名称 100 字符、说明 1000 字符、输入提示 500 字符，畸形更新不接受。名称不能包含空白或控制字符。界面只在草稿开头的 `/` 词项匹配它们，选择后插入可编辑草稿；不会自动发送或由 Host 执行另一个命令。名称与说明按可见安全文本显示，旧 Host 没有该字段时不展示命令建议。

分叉由 Host 以一条背景文本加新输入开启会话，ACP 不需要私有分叉方法；仍是新的启动。用户消息的 requestId 在 ACP 存储中保留，用于关联确认后的输入与客户端待发送气泡。

Host 队列只在明确 runOutcome=completed 后自动派发。ACP 只有 session/prompt 的 end_turn 算 completed，取消、输出上限、拒绝、未知 stopReason 与断连都暂停。Standard 仍要求 Provider 的有效 finish 事件。两种 Driver 接收 PromptOptions.queuedAt，只作为用户消息的排队时间，不改变输入幂等哈希与权限；第三方 Driver 没有明确 outcome 时，由用户继续。

ACP 附件只走 `session/prompt` 的内容块。initialize 的 `promptCapabilities.image` 和 `embeddedContext` 必须各自为 true；Probe 缺少字段不代表支持，实际启动后再次核对。图片为 base64 image，文本为含 `latch-attachment:<id>` URI 和正文的 embedded resource，不在项目创建文件。Agent 输出图片通过 Host 回调存为会话附件，任务快照只写引用。含附件会话的 stderr 不进入 Host 日志，RPC 失败也不回显附件；具体限额和授权见 [ATTACHMENTS.md](ATTACHMENTS.md)。

显式 `fileRefs` 由 Host 对固定目录再次验证，ACP 仅在本轮模型输入里追加真实目录映射，公开消息保留原文与引用 metadata。附件及文件引用 schema 都随会话持久化；假进程回归覆盖实际协商、内容块、图片输出与重启。

分叉由 Host 以一条背景文本加新输入开启会话，ACP 不需要私有分叉方法；仍是新的启动。用户消息的 requestId 在 ACP 存储中保留，用于关联确认后的输入与客户端待发送气泡。

文件变化的范围、运行结算、可选插件契约与验证见 [运行期间的文件变化](FILE-OUTPUTS.md)。
