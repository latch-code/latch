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

- Agent 能以 Host 用户的身份读写文件、执行命令，包括 Latch 的数据目录和 Host 身份私钥，也能冒用本机 Electron 在其他电脑上的设备身份。新建会话的确认内容带这两点警告。
- Agent 自己发起的审批询问只是提示（`advisory: true`，按 `R2` 展示），不是安全边界：拒绝会转达给 Agent，但不能阻止它执行其他操作。
- Latch 能做的是：只启动本机确认过的命令与项目配置；在启动前把 Agent 设到它最严格的可用权限模式，并在每轮输入前读回确认；发现模式被放宽时停止该会话；去掉会持久保存授权的选项。

谁能做什么：

- 新建 ACP 会话：只能在执行端电脑上的 Latch 桌面端（`host.sock`）进行，安全策略 `local.allowL3` 必须开启（默认开启；关闭时 403 `ceiling-exceeded`），并经本机确认：每设备、启动指纹与项目目录组合的首次启动用 Touch ID 或登录密码，之后每次启动仍在桌面原生表单核对并允许；变化后的指纹重新认证。本机确认目前只在 macOS 上提供，其他系统上无法新建 ACP 会话。启动目录位于数据目录内或与 Latch 程序目录重叠时，不能用于 ACP 会话（409 `workspace-inside-data`、`workspace-code-root`）。
- 发送输入、修改会话设置、允许询问与删除会话：只能在执行端电脑上的 Latch 桌面端进行，其他设备返回 403 `local-only`；前三项还要求 `local.allowL3` 仍开启。
- 其他设备（浏览器、手机）只能查看会话、拒绝询问和取消。修改标题、置顶与归档只改 Latch 自己的会话记录，不触达 Agent。
- 任何 L3 会话运行中或等待审批时，比会话更长久的授权要等它结束：登记新设备、为设备增加权限、放宽安全策略与确认新的模型服务地址返回 409 `presence-blocked`，桌面端点名挡住它的会话（`blockingTasks`），提供「查看会话」「停止会话」。

## 使用

1. 在运行 Host 的电脑上安装 Agent，并按它自己的方式完成登录与模型配置。
2. 在 Latch 桌面端打开「设置 → Agent 成员」，选择预设或填写自定义命令（可执行文件名或绝对路径、参数、环境变量）。定义只能在桌面端保存，保存时不需要本机确认：保存本身不运行任何东西，下一步新建会话时的系统表单写出要运行的命令、参数与环境变量名。新建定义或修改命令、参数、环境变量与预设后，定义标为「还没有开启过会话」，直到第一个以它开启的完全访问会话（`AgentRecord.startedHash`）；之后每个新会话仍要确认。改名和启用/停用任何管理设备都可以，不改变这一标记。
3. 新建会话时选择该 Agent 与项目目录。确认内容列出：Harness、命令（解析出的绝对路径）、参数、Agent 启动时的全部环境变量名（不显示值）、工作目录（真实路径）、Agent 还会收到的其他文件夹（见「项目的多个文件夹」）、定义状态（「已验证的预设」或「未验证的定义」）、能否读回权限模式、是否请求审批、若干「说明」（预设的权限说明、定义的说明与项目中找到的 Agent 配置，见「项目配置」）、启动指纹与首条输入的哈希。这些是确认详情，桌面原生表单全部显示；首次系统 Touch ID 表单只写一句理由：「允许 Codex 读写这台 Mac 上的文件并运行命令（项目「Acme」）：/opt/homebrew/bin/codex-acp --flag」，定义设置了环境变量时另写「，另设 <变量名>」；命令、参数、定义的环境变量或项目配置与以前启动时不同时写「再次允许 Codex 读写这台 Mac 上的文件并运行命令（启动方式已变化，项目「Acme」）：…」。是否为预设自己的命令在上面列出的确认内容里。规则见 [ARCHITECTURE.md](./ARCHITECTURE.md#会话级别与审批风险)。
4. 会话头部显示 Agent 提供的模型、模式等选项，修改后从下一轮生效；放宽权限模式需要本机确认。

预设只收录开源 Agent，并且只使用本机已安装的命令，不使用 `npx` 等运行时下载：

| 预设 | 命令 | 许可证 | 说明 |
| --- | --- | --- | --- |
| Codex | `codex-acp` | Apache-2.0 | `npm i -g @agentclientprotocol/codex-acp`；登录、模型与沙箱由 Codex 管理 |
| pi | `pi-acp` | MIT | `npm i -g pi-acp`，需要已安装 pi（预设的 `companion`，与适配器分别检测）；pi 执行工具前不请求审批 |
| OpenCode | `opencode acp` | MIT | `npm i -g opencode-ai`；仅支持 1.x |
| DeepSeek Harness | `dsh --profile acp` | MIT | 需要 `@deepseek-ai/dsh` 0.2.1-rc.2 或更高；按完整消息回复 |
| Gemini CLI | `gemini --acp --approval-mode default` | Apache-2.0 | `npm i -g @google/gemini-cli` |
| Qwen Code | `qwen --acp` | Apache-2.0 | `npm i -g @qwen-code/qwen-code` |
| goose | `goose acp` | Apache-2.0 | 见项目文档 |

Host 在 PATH 以及 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.npm-global/bin`、`~/.local/bin`、`~/.bun/bin` 中查找命令，不经过 shell；含 `/` 的相对路径按找不到处理。从图形界面启动的 Host 通常没有登录 shell 的 PATH，所以还查找用户目录里 Node 版本管理器与包管理器的全局目录：fnm 的 `$FNM_DIR`（或 `~/.local/share/fnm`）下的 `aliases/default/bin`、nvm 的 `~/.nvm/alias/default`（经 `lts/*` 这类别名解析）指向的 `~/.nvm/versions/node/<版本>/bin`、Volta 的 `~/.volta/bin`、asdf 的 `~/.asdf/shims`、mise 的 `~/.local/share/mise/shims`、pnpm 的 `$PNPM_HOME` 与 `~/Library/pnpm`、Yarn 的 `~/.yarn/bin`。来自环境变量的目录只在是绝对路径时使用，只接受可执行的普通文件，查到的绝对路径计入启动指纹；这些目录也追加到 Agent 进程的 PATH 上。找不到时 Agent 在选择器中显示为不可用，并给出安装提示；仍找不到时请填写绝对路径。

预设可以声明 `companion`：适配器命令要连接的另一个程序（pi-acp 连接 pi）。Host 用同样的规则查找它，「设置 → Agent 成员」与选择器据此写出缺的是哪一个（「已安装 pi，还差让 Latch 连接它的适配器 pi-acp」「已找到适配器 pi-acp，还没找到 pi」或两者都没找到）；缺任何一个时这个 Agent 都不可用。Harness 状态里的命令查找结果缓存 5 秒；读取 `GET /link/api/agents`（设置页的「重新检测」，以及窗口重新获得焦点时）会清掉这个缓存，所以刚在终端里装好的命令下一次就能看到。这个列表里的每个预设也带同样的查找结果（`detected`，还没有据它添加 Agent 时也有），新会话页的「添加 Agent」据此在添加之前说出这台电脑上缺的是哪个程序；旧版 Host 不发它，那里只显示安装命令。Latch 不提供一键安装，只显示可复制的安装命令与项目主页。

## 预设的权限配置

每个预设的权限配置是 `packages/harness-acp/src/profiles/` 下的一个 `HarnessProfile`，只在 Host 上使用；浏览器只看到复制进 `TaskDetail.permission` 的展示字段。

- `permission`（`AcpPermissionProfile`）：`approvals`（Agent 是否请求审批）、`defaultEnv`、`expectedMode`、`modeLadder`（严格 → 宽松）、`forbiddenModes`、`hiddenOptionIds`（精确 ID，或以 `*` 结尾的前缀）、`readback`、`versionRule`（见「版本规则」）、`systemSettings`（Gemini CLI）、`configEnv`（见下）与中文 `notes`。
- `version`：计入启动指纹。改变配置的行为时应递增它，已有会话因此需要重新确认。
- `projectConfigPaths`、`projectConfigManaged`：见「项目配置」。
- `materialize`：启动前在 Host 上准备 Agent 需要的文件，返回要加入的环境变量（目前只有 Gemini CLI 使用）。

选择规则：按定义的 `presetId`，否则按命令的文件名匹配预设的命令。只要选中了预设，它的环境变量和模式规则就生效；只有 `presetId` 与参数都与预设完全一致、命令就是预设的命令，并且定义没有设置会改变该 Agent 读取配置位置的变量（`configEnv`）时，定义才算「已验证的预设」，否则显示为「未验证的定义」。「就是预设的命令」指只写命令名（由 Host 自己查找），或写 Host 按这个命令名查找到的那个文件（按真实路径比较，指向它的链接也算）；其他目录里同名的文件（例如项目 `node_modules/.bin` 里的 `codex-acp`）不算，每次启动时重新判断。没有匹配任何预设的定义不设置模式，但会话中 Agent 自行改变模式一律按漂移处理。

目前只有 OpenCode 预设列出 `configEnv`：`XDG_*`、`OPENCODE_*`（其中由 Latch 管理的几个本来就不能设置）和 `USERPROFILE`，比较时不区分大小写。OpenCode 从 XDG 目录（或主目录）读取用户配置、Agent 定义与插件，且在 Latch 的规则之后加载；其余 `OPENCODE_*` 开关对询问规则的影响 Latch 没有逐一核对。设置了其中任何一个的定义仍可保存和运行，但显示为「未验证的定义」，会话的本机确认与会话权限说明中注明：`定义设置了 <变量名>，OpenCode 可能改从其他位置读取配置、Agent 定义与插件，覆盖 Latch 设置的询问规则；该定义不作为已验证的预设`。

| 预设 | Latch 设置的环境变量 | 预期模式 | 模式顺序（严格 → 宽松） | 不提供的模式 | 隐藏的选项 | 读回 |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | `INITIAL_AGENT_MODE=read-only` | `read-only` | `read-only`、`workspace-write`、`agent-full-access` | `agent` | `accept_execpolicy_amendment`、`apply_network_policy_amendment*` | 可读回 |
| Qwen Code | — | `default` | `plan`、`default`、`auto-edit`、`yolo` | `auto` | — | 可读回；恢复会话会恢复旧模式，Latch 每轮前重新设置 |
| goose | `GOOSE_MODE=approve` | `approve` | `chat`、`approve`、`auto` | `smart_approve` | — | 可读回 |
| Gemini CLI | `GEMINI_CLI_SYSTEM_SETTINGS_PATH` | `default` | `plan`、`default`、`autoEdit`、`yolo` | — | `proceed_always_and_save`、`ProceedAlwaysAndSave` | 可读回 |
| DeepSeek Harness | `DSH_PERMISSION_MODE=read-only` | — | — | — | — | 无法读回权限模式 |
| OpenCode | `OPENCODE_CONFIG_CONTENT`（见下） | `build` | `plan`、`build` | — | — | 可读回 |
| pi | — | — | — | — | — | 无法读回；pi 执行工具前不请求审批 |

- 「不提供的模式」是由模型代为批准的模式，Latch 拒绝切换（400 `mode-forbidden`）。
- Gemini CLI：每次启动进程前（以及生成本机确认内容时），Host 把 `{"security":{"disableAlwaysAllow":true,"enablePermanentToolApproval":false}}` 写入 `<数据目录>/harnesses/<agent-id>/gemini-system-settings.json`，路径通过 `GEMINI_CLI_SYSTEM_SETTINGS_PATH` 传给 Gemini CLI。这些键名尚未在 Gemini CLI 的正式版本上核对。
- OpenCode：`OPENCODE_CONFIG_CONTENT` 让除读取、glob、grep、list 以外的工具都先询问，访问工作目录以外的路径（`external_directory`）先询问，拒绝读取 `.env` 与 `.env.*`，禁用子 Agent（`task`）；同样的规则也写进 `build` 与 `plan` 两个 Agent，避免它们各自的设置覆盖全局设置。这些规则只是默认值：OpenCode 还会合并用户与项目的配置（用户配置目录、从工作目录向上查找的 `opencode.json`/`opencode.jsonc`、项目与主目录下 `.opencode` 目录中的配置和 Agent 定义），其中一部分在 Latch 的规则之后加载，可以把询问改成直接允许，模式读回仍显示 `build`。Latch 无法关闭这些来源；项目中的这些配置计入启动指纹（见「项目配置」），用户配置不计入。OpenCode 启动时还会在 `.opencode` 目录中安装依赖并加载插件，因此在不信任的项目中使用 OpenCode 会运行项目里的代码。OpenCode 会话的权限说明注明了这两点。
- 所有预设一律隐藏 `allow_always` 与 `reject_always` 类型的选项，这一点不可配置。

### 版本规则

预设可以用 `versionRule` 要求 `initialize` 返回的 `agentInfo.version` 匹配一个正则。不匹配或未报告版本时，Latch 结束该进程，会话以 409 `harness-version-unsupported` 失败（`<名称> 版本 <v> 未经验证（<说明>），已拒绝启动。`）。目前只有 OpenCode 设置了规则：`^1\.`，说明为 `OpenCode 仅支持 1.x（V1）`，因为上面的配置键只在 OpenCode 1.x 的格式下有意义。

## 项目配置

多数 Agent 启动时会读取项目里的配置，其中的设置可以改变询问规则、加载插件或扩展。Latch 把预设列出的项目配置（`projectConfigPaths`）的内容计入启动指纹，因此本机确认覆盖它们，确认之后它们的任何变化都会让会话不能继续。

| 预设 | 计入启动指纹的项目配置 | 不计入（Agent 自己写入的内容） |
| --- | --- | --- |
| OpenCode | `opencode.json`、`opencode.jsonc`、`.opencode/` | `.opencode/` 下的 `node_modules`、`bun.lock`、`bun.lockb`、`.gitignore`、`plans`；`.opencode/package.json` 中 OpenCode 自己添加的 `@opencode-ai/plugin` 依赖（文件只剩这一项时整个不计入） |
| Codex | `.codex/`；收到其他文件夹的会话还有 `.agents/skills/` | — |
| Gemini CLI | `.gemini/` | — |
| Qwen Code | `.qwen/` | — |
| pi | `.pi/`、`.agents/skills/` | `.pi/npm`、`.pi/git`（pi 按项目设置安装的包；项目设置本身计入） |
| goose、DeepSeek Harness | 无（未发现它们读取项目级配置目录） | — |

- 查找范围：从会话目录开始，逐级向上直到根目录，分别沿 Agent 收到的路径（Host 登记的项目路径，可能经过符号链接）和它解析后的真实路径查找；同一个目录只查一次。主目录本身跳过，因为 `~/.codex`、`~/.opencode`、`~/.gemini`、`~/.pi` 等是 Agent 的用户级数据，不是项目配置；会话目录就是主目录时，这些目录也不计入。查找范围比各 Agent 自己的（通常到 Git 仓库根目录为止）更宽。
- 其他文件夹：Agent 收到的其他文件夹（见「项目的多个文件夹」）同样从它们开始逐级向上查找，与会话目录共用上限，同一个目录只查一次；这样的 Codex 会话在每个文件夹（包括主文件夹）中还计入 `.agents/skills/`，因为 codex-acp 加载它收到的每个文件夹中的技能。其他文件夹中找到的文件在说明中用绝对路径列出。只有主文件夹的会话查找范围与指纹都不变。
- 本机确认的「说明」列出找到的文件（会话目录内的用相对路径，目录外的用绝对路径，无法读取的标注「（无法读取）」，超过 8 个只列前 8 个并给出总数），例如：`项目中有 OpenCode 配置：.opencode/agent/build.md、opencode.json。启动指纹包含这些配置的内容，确认后如有增删或修改，该会话不能继续`。没有找到时没有这条说明，启动指纹与只看定义时相同。
- 何时重新计算（含其他文件夹）：生成本机确认内容时、新建会话时（与确认时的指纹比较）、每次输入与修改设置之前、每次启动 Agent 进程之前（新会话的首次启动、恢复会话、空闲停止后的重启；启动前的等待之后再查一次），以及为删除会话临时启动进程之前。只有项目配置变化时返回 409 `project-config-changed`（`项目中的 <名称> 配置在确认后发生了变化，该会话不能继续。请新建会话（需要本机确认）。`），定义也变化时仍是 409 `agent-definition-changed`；为删除会话而启动进程的检查不通过时只删除 Latch 的记录。
- Agent 按用户要求修改了这些配置（例如编辑 `opencode.json`），之后的输入同样被拒绝，需要新建会话重新确认。
- 这是启动前的一致性检查，不是隔离：Agent 是完全访问的本机代码，可以在运行中读写任何文件。

## 项目的多个文件夹

一个项目可以由几个文件夹组成（见 [ARCHITECTURE.md](./ARCHITECTURE.md#会话与项目)）。ACP 会话的工作目录（ACP 的 `cwd`，也是进程的工作目录）始终是主文件夹；其他文件夹能否交给 Agent，取决于 Agent 自己：

| 预设 | 其他文件夹怎样交给它 | `HarnessInfo.projectFolders` | 说明 |
| --- | --- | --- | --- |
| Codex | ACP 的 `additionalDirectories`：`session/new`、`session/resume` 与 `session/load` 每次都发送完整列表 | `{ access: 'all' }` | 只在 `initialize` 声明了 `sessionCapabilities.additionalDirectories`（一个对象）时发送。没有声明时 Latch 结束该进程并返回 409 `agent-folders-unsupported`，会话不会创建。codex-acp 把每个文件夹当作受信项目并加载其中的 `.agents/skills`；在 `workspace-write` 模式下这些文件夹也可写，所以放宽模式的本机确认逐个列出它们（「其他文件夹」） |
| Gemini CLI、Qwen Code | 在定义的参数之后，每个其他文件夹追加一次 `--include-directories <真实路径>`；每个会话有自己的进程，参数只对它生效 | `{ access: 'all', max: 5 }` | 最多 4 个其他文件夹，超出时返回 409 `harness-folder-limit`，不启动进程。它们按逗号拆分这个参数，含逗号的路径返回 400 `workspace-folder-chars`（Host 本来就不接受这样的新文件夹） |
| OpenCode 1.x | 不传（1.x 的 ACP 不支持） | `primary-asks` | Latch 设置的 `external_directory: 'ask'` 让它访问工作目录以外的路径之前先询问 |
| DeepSeek Harness | 不传（它拒绝这个字段） | `primary` | — |
| pi、goose | 不传（它们没有这个概念） | `primary-unbounded` | 它们不限制工具能访问的路径 |
| 未匹配预设的定义 | 不传 | 无（客户端按 `primary` 显示） | — |

- 只有 Codex、Gemini CLI 与 Qwen Code 的 Driver 声明 `projectFolders: 'all'`，Host 只把项目标识与文件夹交给它们，其他 ACP Driver 只收到主文件夹。Driver 用 Host 的 `projects()` 再核对一次：项目在列表中、`folders[0]` 是主文件夹，每个文件夹的标识与真实路径都属于这个项目，否则 400 `workspace-unavailable`。交给 Agent 的是各文件夹的真实路径，按项目中的顺序，不含主文件夹，也不重复。
- 只收到主文件夹的 Driver，其会话摘要由 Host 标记 `folderAccess: 'primary'`。`workspaces()` 也列出项目内仍可用的旧主文件夹，调整顺序后的已有会话继续使用原工作目录。
- 本机确认逐个显示其他文件夹（「其他文件夹」，真实路径）和一条说明（怎样交给 Agent；文件夹范围由 Agent 自己执行，不是隔离），并绑定它们；它们计入启动指纹与项目配置（见「项目配置」）。Codex 是否声明支持，要等进程启动、`initialize` 返回后才知道，所以这类会话先启动 Agent、读到声明之后才记录会话；同一请求标识的重试共用这一次启动。
- 会话把项目与文件夹记在摘要中（`workspaceId`、`folders`、`folderAccess: 'all'`），把交给 Agent 的真实路径与方式记在 `acp.folders` 与 `acp.folderVia`，之后不再改变：项目新加的文件夹只用于新会话，改变主文件夹也不影响已有会话。每次输入、修改设置、启动进程、恢复或加载会话，以及为删除会话临时启动进程之前，Latch 确认这些文件夹仍属于该项目且仍在原来的真实路径；文件夹被移出项目、被替换、找不到，或项目已不在列表中时返回 409 `workspace-changed`，删除时只删除 Latch 的记录。之后启动的进程不再声明支持时，本轮不发送，返回 409 `agent-folders-unsupported`，进程被结束。
- 这些文件夹只是 Agent 自己执行的范围，不是隔离。ACP 会话仍是完全访问（L3），Agent 可以访问 Host 用户能访问的任何路径。

## 启动确认

启动内容变化后需重新确认。

## 启动诊断

新版 Host 的 Agent 详情页提供「测试启动」，在原位显示系统认证、握手结果与诊断。远程设备只读最近结果并看到到执行端桌面端操作的说明；缺少权限、完全访问上限关闭、本机认证不可用或命令缺失时说明具体原因。结果没有宣称模型已经可用。列表的会话数和最近会话时间只根据当前设备可见的快照计算，不额外枚举其他会话。

`POST /link/api/agents/:id/probe { requestId }` 只在 `host.sock` 上接受同时持有 `admin` 与 `run` 的设备，并遵守本机完全访问上限。每次都需要系统认证。

探测只发送 ACP `initialize`，不发送 `authenticate`、`session/new` 或提示词；最多等待 15 秒，随后停止进程组并等待真实退出。Host 关闭也会取消和等待探测。能力包含图片、恢复、加载和附加文件夹。`authMethods` 只说明程序提供哪些登录方法，不证明尚未登录；因此握手成功只表示 `ready`，登录和模型访问仍未验证。只有明确的 `auth_required` RPC 错误表示 `authentication-required`，其他失败为 `failed`。

结果带 `checkedAt`、`launchHash` 与最多 4 KiB 的诊断；先按定义变量与秘密格式脱敏，再截取结尾。最近结果以可选 `AgentRecord.lastProbe`、`probedDefinitionHash` 保存，`AgentSettings.lastProbe` 只返回同一定义的记录；修改启动内容会清除它。探测通过不等于会话已经启动，不修改 `startedHash`，也不授予以后启动会话的信任。运行前写审计 `agent.probe.requested`，结束后记录 `agent.probed`；审计只含 ID、哈希与状态。当前 Host 生命周期内，同设备同 `requestId` 共享整次探测与记录过程，重试不再执行程序；Host 重启后的旧确认已失效，必须重新发起系统认证。

## 进程与环境

- 每个 Latch 会话有自己的 Agent 子进程（一个 ACP 会话），首次需要时启动，工作目录为该会话的主文件夹；Gemini CLI 与 Qwen Code 的参数之后追加其他文件夹（见「项目的多个文件夹」）。同一个 Agent 定义最多同时运行 8 个进程（`AcpAgentOptions.maxProcesses`）；达到上限时，Latch 停止最久未使用的、可以恢复的空闲进程，没有可停的进程时返回 503 `agent-busy`（`同时运行的 <名称> 会话过多，请先结束一些会话`）。
- 子进程在独立进程组中运行。stderr 持续读取到 64 KiB 环形缓冲，只在启动失败或崩溃时以脱敏的短摘要写入 Host 日志，不进入会话记录。
- 模型服务的密钥、地址等需要在 Agent 自己的配置里设置，或写进 Agent 定义的环境变量。
- `initialize` 返回的协议版本必须是 1，否则启动失败。Latch 声明 `fs.readTextFile`、`fs.writeTextFile` 与 `terminal` 能力均为 false，Agent 使用自己的文件与命令执行能力；`session/new`、`session/resume`、`session/load` 不传 MCP 服务器；Agent 发来的请求只处理 `session/request_permission`，其他方法返回 method not found。Latch 不调用 `authenticate`：Agent 要求登录时返回 409 `agent-auth-required` 并列出它报告的登录方式。
- 空闲 10 分钟且 Agent 支持恢复会话时，进程会被优雅停止，下次需要时再启动。
- 进程崩溃时，该会话转为 `failed`，`runEnd` 为 `process-exited` 并列出结果未知的调用，`runOutcome` 仍是 `interrupted`（见 [STREAMING.md](./STREAMING.md#运行的真实状态)）；之后的重启从 250 ms 开始按最近的崩溃次数加倍延迟（最多 5 秒），同一定义一分钟内崩溃 3 次会暂停自动重启一分钟（503 `agent-paused`）。

## 权限模式

权限模式被放宽时 Latch 停止该会话。

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

会话选项修改的未知结果通过 Host 配置回执查询，不自动再次发送 `set_config_option`；Agent 超时或连接关闭无法证明没有执行。回执只有请求摘要与状态，不保存自定义选项原值。`SetConfigOptions.authorize` 在准备连接前和实际发送 RPC 前同步复查 Host 授权；详情见 [ARCHITECTURE.md](ARCHITECTURE.md#会话配置修改回执)。

**时间。** 时间都由 Host 的时钟（`HarnessHostOptions.clock`）记录，含义见 [STREAMING.md](./STREAMING.md)「时间与用量」。一轮从 Latch 接受提示开始：发出提示之前（启动进程、建立或恢复会话、设置模式）`activity` 是 `starting`，提示发出后是 `model`；`since` 只在阶段或工具变化时更新。正文与思考片段的第一段到达时记下这一段的开始，结算时写入 `completedAt`、`reasoningMs` 与模型（会话里 Agent 报告的当前模型选项的值）；工具第一次被记录时写 `createdAt`，第一次进入 `in_progress` 时写 `startedAt`，Agent 报告完成或失败时写 `completedAt`；一轮结束时 Latch 替它结算的工具，只有运行过的才写 `completedAt`。审批活动的 `since` 与原等待起点 `runWaitingSince` 使用同一个时间戳，跨毫秒取时也不会分裂。询问挂起期间计入这一轮的等待时间；一轮结算时把 `turn` 写在开启它的用户消息上。

`TaskDetail.permission` 描述该会话：`level: 'L3'`、`enforcer: 'NONE'`、能否读回模式、定义是否为已验证的预设、是否请求审批、预期模式、漂移记录、预设说明和定义的说明（项目配置的说明只出现在本机确认中）。

未知的更新类型会被忽略。单条工具文本上限 64 KiB；每个工具最多 32 个 diff，每个 diff 的原内容与新内容各截断到 128 KiB；单行协议消息超过 64 MiB 会终止进程。

## 审批

- 选项类型按任意字符串解析。Latch 去掉 `allow_always`、`reject_always`、预设隐藏的选项 ID 和未知类型，只展示「仅此一次允许」与「仅此一次拒绝」。
- 去掉之后若没有「仅此一次允许」，Latch 不展示审批，直接以「仅此一次拒绝」答复（没有该选项时答复为取消），追加系统消息「已自动拒绝：<名称> 只提供会持久保存的选项或未知选项，Latch 不提供。」，并记录安全事件。
- 选择被去掉的选项返回 400 `approval-option-hidden`；选择的选项必须属于该审批，且与允许/拒绝方向一致。只说"允许"时使用「仅此一次允许」；只说"拒绝"时使用「仅此一次拒绝」，没有该选项时答复为取消。
- 一个会话可以同时存在多个审批；多设备竞争时只有一个决定生效。不在进行中的一轮里的询问答复为取消。
- 允许 ACP 询问只能在执行端电脑上的 Latch 桌面端进行（不需要本机确认，不提供「始终允许」）；拒绝可以在任何已登记且有查看权限的设备上进行。
- 询问结束后，那次工具调用带上决定记录 `ToolDetail.decision`（见 [ARCHITECTURE.md](./ARCHITECTURE.md)「决定记录与拒绝说明」）：人的允许或拒绝记 `allowed`、`rejected` 与在哪里决定；取消、一轮结束、进程退出、Host 重启时还开着的询问，以及权限漂移时 Latch 自己拒绝的询问，记 `cancelled`，不算作某人的拒绝；Agent 撤回的询问不留记录；同一调用询问多次时，已经给出的允许不被之后的拒绝或取消覆盖。拒绝不保证 Agent 不执行：Agent 之后报告的开始、完成与差异照常显示。ACP 的权限回复不能带文字，所以拒绝附带的说明（「告诉 Agent 改做什么」）不会转给 Agent。
- 有些 Agent（例如 pi，或处于自动批准模式的 Agent）不请求审批，Latch 不会显示审批卡片。Latch 的审批不是操作系统沙箱。

## 取消

任何已登记且有查看权限的设备都可以取消。每一轮有自己的 `runId`（在把这一轮写入会话时生成并持久化）；取消带着它时，Driver 只在它仍是当前这一轮时取消，否则什么也不做（Host 回答 `ended`，见 [STREAMING.md](./STREAMING.md#取消的请求-id-与回执)）。

1. 发送 `session/cancel`，同时把该会话所有未决的审批答复为 `cancelled`。
2. 继续接收 Agent 的更新，等待本轮 `session/prompt` 结算后才确认取消；状态记为 `cancelled`，无论 Agent 返回什么 stopReason。
3. 30 秒内仍未结算时终止该会话的 Agent 进程组，会话转为 `interrupted`；其他会话有各自的进程，不受影响。执行中的工具标记为结果未知，请核对副作用；`TaskSummary.runEnd`（`forced-stop`）与取消回执列出它们，见 [STREAMING.md](./STREAMING.md#运行的真实状态)。

## 看不懂的请求

Latch 只处理 Agent 发来的 `session/request_permission`。其他请求（包括未声明的文件系统、终端与追问）和读不懂的询问都立刻答复错误（`-32601`、`-32602`），Agent 不会一直等一个不会来的回答，同时不被吞掉：会话记录里写一条系统消息，说明方法名与脱敏后的内容（带附件的一轮不写内容，内容最多 2000 字符），同一轮同一方法只写一次，最多 8 种；运行中的 `TaskSummary.live.unrecognized` 给出次数与时间。Agent 之后是否继续，比较 `unrecognized.at` 与 `lastEventAt`；它因此停住时，沉默检测会说出来。会话尚未建立时只写入 Host 日志。

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
| `mode-forbidden`（400） | 该模式由模型代为批准，Latch 不提供 |
| `approval-option-hidden`（400） | 该选项会持久保存授权，Latch 不提供 |
| `local-only`（403） | 只能在执行端电脑上用 Latch 桌面端进行 |
| `ceiling-exceeded`（403） | 安全策略不允许完全访问会话（`local.allowL3` 关闭） |
| `stepup-required`（403） | 新建会话或放宽权限模式需要在本机确认 |
| `l3-confirmation-missing`（409） | 会话没有经过本机确认的启动指纹 |
| `agent-definition-changed`（409） | Agent 定义或解析出的命令已变化 |
| `project-config-changed`（409） | 项目中计入启动指纹的 Agent 配置在确认后有增删或修改 |
| `permission-unverified`（409） | 无法确认 Agent 已进入预期的权限模式，本轮未发送 |
| `permission-drift`（409） | 该会话检测到权限模式漂移，不再接收输入 |
| `harness-version-unsupported`（409） | Agent 版本未经验证（目前用于 OpenCode） |
| `workspace-unavailable`（400） | 工作目录不是 Host 登记的项目目录，或所选项目的文件夹与 Host 登记的不一致 |
| `workspace-folder-chars`（400） | 要以参数交给 Agent 的文件夹路径含逗号 |
| `workspace-changed`（409） | 会话使用的文件夹已不在项目中、被替换或找不到，或项目已不在 Host 的项目列表中；新建时交给 Agent 的文件夹与确认时不同 |
| `agent-folders-unsupported`（409） | Agent 的当前版本没有声明 `additionalDirectories`，会话没有开始或本轮没有发送 |
| `harness-folder-limit`（409） | 项目的文件夹超过 Agent 能使用的数量（Gemini CLI、Qwen Code 最多 5 个） |
| `agent-auth-required`（409） | Agent 要求登录；请在运行 Host 的电脑上按提示完成登录 |
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
| 按会话放行 OpenCode 访问其他文件夹 | 未实现；需要按会话改变 OpenCode 的配置并提高其 profile 版本。OpenCode 1.x 访问其他文件夹时逐次询问；2.x 的 ACP 字段要等 Latch 接受 2.x |
| 只有主文件夹的 Codex 会话计入 `.agents/skills/` | 未实现；需要提高 Codex profile 的版本，已有 Codex 会话届时要新建 |
| Linux 与 Windows 上新建 ACP 会话 | 这些系统还没有本机确认，新建会话所需的确认无法完成 |

## 测试

`packages/harness-acp/test/acp.test.ts`（`pnpm test --project @latch/harness-acp`）使用 `packages/testkit/fixtures/fake-acp-agent.mjs`（`@latch/testkit` 的 `FAKE_ACP_AGENT`，确定性的假 Agent，按环境变量与输入关键词切换场景，可模拟模式、粘滞模式、恢复后的模式与不报告模式的恢复、修改模式时自行切换的模式、缺少类别或缺失的模式选项、版本号、`additionalDirectories` 能力（`FAKE_ACP_CAPS_FILE` 让同一定义之后的进程改变声明）和环境转储，并记录启动参数），覆盖流式、思考、工具与 diff（含 diff 是否为新文件的记录与持久化）、审批与选项过滤、自动拒绝、取消（含不遵守协议的 Agent）、崩溃、恢复、启动指纹、模式读回与漂移（含运行中修改模式）、环境变量白名单、改变 OpenCode 配置位置的定义变量、项目配置（项目内与上级目录、经过符号链接的项目路径、OpenCode 自己写入的内容、确认期间与之后的变化、空闲后重启与删除前的检查）、每会话进程与进程上限、项目移除后的删除、项目的多个文件夹（Codex 的能力门槛与恢复时重发、Gemini CLI 与 Qwen Code 的参数与上限、不接收文件夹的预设、文件夹被移出、替换或删除后的停止、每个文件夹中的项目配置）、旧式模型选项、异常输出与幂等。预设的权限配置通过 `presetId` 套用到假 Agent 上测试。测试从不启动真实 Agent。

### 会话命令

ACP `available_commands_update` 的当前列表作为可选 `TaskDetail.commands` 发送给客户端，并随 ACP 会话持久化。每次更新替换之前的列表（空列表撤下命令）；最多 200 条，名称 100 字符、说明 1000 字符、输入提示 500 字符，畸形更新不接受。名称不能包含空白或控制字符。界面只在草稿开头的 `/` 词项匹配它们，选择后插入可编辑草稿；不会自动发送或由 Host 执行另一个命令。名称与说明按可见安全文本显示，旧 Host 没有该字段时不展示命令建议。

分叉由 Host 以一条背景文本加新输入开启会话，ACP 不需要私有分叉方法；仍是新的启动和本机确认。用户消息的 requestId 在 ACP 存储中保留，用于关联确认后的输入与客户端待发送气泡。

Host 队列只在明确 runOutcome=completed 后自动派发。ACP 只有 session/prompt 的 end_turn 算 completed，取消、输出上限、拒绝、未知 stopReason 与断连都暂停。Standard 仍要求 Provider 的有效 finish 事件。两种 Driver 接收 PromptOptions.queuedAt，只作为用户消息的排队时间，不改变输入幂等哈希与权限；第三方 Driver 没有明确 outcome 时，由用户继续。

ACP 附件只走 `session/prompt` 的内容块。initialize 的 `promptCapabilities.image` 和 `embeddedContext` 必须各自为 true；Probe 缺少字段不代表支持，实际启动后再次核对。图片为 base64 image，文本为含 `latch-attachment:<id>` URI 和正文的 embedded resource，不在项目创建文件。Agent 输出图片通过 Host 回调存为会话附件，任务快照只写引用。含附件会话的 stderr 不进入 Host 日志，RPC 失败也不回显附件；具体限额和授权见 [ATTACHMENTS.md](ATTACHMENTS.md)。

显式 `fileRefs` 由 Host 对固定目录再次验证，ACP 仅在本轮模型输入里追加真实目录映射，公开消息保留原文与引用 metadata。附件及文件引用 schema 都随会话持久化；假进程回归覆盖实际协商、内容块、图片输出与重启。

分叉由 Host 以一条背景文本加新输入开启会话，ACP 不需要私有分叉方法；仍是新的启动和本机确认。用户消息的 requestId 在 ACP 存储中保留，用于关联确认后的输入与客户端待发送气泡。

文件变化的范围、运行结算、可选插件契约与验证见 [运行期间的文件变化](FILE-OUTPUTS.md)。
