---
description: Latch 怎样启动并驱动用户本机的 Agent（ACP、Codex 的 app-server、pi 的 RPC）：预设与命令、不改原 CLI 配置、完全访问（L3）、权限模式与读回、项目配置与文件夹、启动指纹、进程与环境、经 Latch 使用模型服务、登录、额度、审批、取消、子 Agent、提问、持久化与恢复、接入已有会话、会话命令、错误与尚未实现。
sources:
  - packages/harness-acp/src
  - packages/protocol/src/agent-presets.ts
  - apps/host/src/hub.ts
---
# 接入外部 Harness（ACP）

Latch 只调用用户本机已经装好的 Agent：启动它的命令，可以交给它一个模型服务，并把它的协议对齐成 Latch 的会话。多数 Agent 经 [Agent Client Protocol](https://agentclientprotocol.com)（ACP v1）驱动；Agent 有自己的官方机器协议时直连（见「直连优先」）。每个启用的 Agent 定义是一个 HarnessDriver，与内置 `standard` 并列。

| 位置 | 内容 |
| --- | --- |
| `packages/harness-acp/`（`@latch/harness-acp`，只有 Host 依赖） | 驱动：`src/runtime.ts` 是会话、指纹、模式、审批与取消的唯一实现，`src/wires/` 是与进程交谈的线 |
| `packages/protocol/src/agent-presets.ts` | 浏览器可见的预设：命令、参数、许可证、安装与登录命令 |
| `packages/harness-acp/src/profiles/` | 只在 Host 上使用的每个预设的 `HarnessProfile`（字段说明在 `profiles/types.ts`） |

整体架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)；模型网关见 [MODEL-GATEWAY.md](MODEL-GATEWAY.md)；我的 Agent 见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md)。

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
- 启动目录在数据目录内或与 Latch 程序目录重叠时不能用于 ACP 会话（409）。
- 任何 L3 会话运行中或等待审批时，本机确认的动作（`PRESENCE_ACTIONS`）返回 409 `presence-blocked`，带挡住它的会话（`blockingTasks`）。

## 使用

1. 在运行 Host 的电脑上安装 Agent，并按它自己的方式登录。
2. 新会话直接列出命令已装好的预设（`catalog.harnesses` 中带 `offer` 的项，只发给有 `admin` 的设备）；第一次发送时页面先保存它的定义再开始，保存不运行任何东西，也不确认。也可在「设置 → Harness」选预设或填自定义命令（可执行文件名或绝对路径、参数、环境变量）。
3. 新建会话默认用这台设备上次的 Harness，否则按预设顺序取第一个能开始的，Latch 内置排最后。Harness 没有项目而启动目录由 Host 选（`catalog.sessionFolders`）时，发送先打开项目列表并保留草稿；选「不选项目」就在新的空文件夹里开始。
4. 会话头部显示 Agent 提供的模型、模式等选项，修改从下一轮生效；任何档位都能直接选（见「权限菜单」）。

**预设命令不确认，其他命令要在这台 Mac 上确认。**

- 定义只能经 `host.sock` 由有 `admin` 的设备新增或改命令；L3 会话运行或等待时被挡（409 `presence-blocked`）。
- 预设的原样命令（Host 自己的预设表里该预设或它的适配器的命令与参数，没有环境变量，在登录 shell 或进程的 PATH 上找到，且不是这个预设上次绑定的路径以外的程序）不确认，记 stepup `preset`；`presetId` 只选比较的条目，不决定结果。只在额外安装目录里找到的照常确认。
- 每个预设上次绑定的路径记在 `settings.json` 的 `presetBindings`，保存与删除定义时都写入；预设与它、与同一预设其他定义的路径都一致才不确认。客户端只收到这个路径以 Host 自己的密钥（`boundKey`）算出的摘要。绑定比较的是路径，不是文件内容：同一路径上的程序被替换时它不会发现。
- 其他都要本机确认 `harness.command.apply`：自定义命令、绝对路径、多出或改过的参数、任何环境变量（新增、修改、移除都算），确认绑定名称与命令解析出的路径。
- 保存时记下解析出的路径 `confirmedCommand`。之后同一命令解析到别的程序时会话不启动（409 `harness-command-moved`），在这台 Mac 上再保存一次即确认新路径，预设也一样。
- 没有 `confirmedCommand` 的定义：在这台 Mac 上第一次用它开始会话时绑定（预设不确认）；此前其他设备开始它被拒（409 `harness-unconfirmed`），版本也不读。
- 改名、开关、删除、模型与权限预设，有 `admin` 的设备都能改。每次改动写 `agent.defined`（确认过的带 `lpc-local`，预设带 `preset`），变量的值不返回。
- Host 只为确认过、且仍解析到同一路径的定义运行 `--version`。
- `startServer` 只有收到 `detectPreset`（启动脚本传入）才找预设的命令；测试不传，所以运行测试的电脑上装的 Agent 不会被选中。

**首启提示。** 一个启动指纹在这台 Host 上第一次启动时，`sessions-meta.json` 记 `firstStart`；每台设备只在一个 Harness 的第一次时在会话最上面一行写明 Latch 不隔离它、权限是它自己的设置。Driver 收不到这一项。

### 直连优先

Agent 自己提供官方机器协议时 Latch 直接说它，ACP 适配器只作后备：少一层转换，版本只跟 Agent 自己走。

| Harness | 路线 |
| --- | --- |
| Codex | `codex app-server`（见「Codex 的 app-server」） |
| pi | `pi --mode rpc`（见「pi 的 RPC 模式」） |
| DeepSeek Harness | `dsh --profile acp`：随包的 `acp` 配置是它给自动化客户端的官方协议 |
| 其他预设 | ACP：它们的官方集成方式（Claude Agent 用官方适配器） |

Codex 的后备规则：

- `codex` 低于 0.156.0（此版起被中断或失败的一轮保留已流出的回答与计划）时以 409 `harness-version-unsupported` 拒绝并给出升级命令，不改用 codex-acp：适配器会经 `CODEX_PATH` 运行同一个旧 Codex。
- 只有这台电脑没有 `codex`、却装了 `codex-acp` 时，从草稿选 Codex 才保存为 `codex-acp`（预设的 `fallback`），它运行自己随包带的 Codex。
- 定义的命令是 `codex-acp` 或任何别的命令时走 ACP，用 `profiles/codex-acp.ts`；设置里它的行写「经 codex-acp」。

预设只用本机已安装、未经修改的命令，不用 `npx` 等运行时下载，不捆绑。Latch 不提供一键安装，只显示可复制的安装命令与项目主页。

| 预设 | 命令 | 许可证 | 安装与版本 | 登录命令（`AgentPreset.login`） |
| --- | --- | --- | --- | --- |
| Codex | `codex`，线追加 `app-server` | Apache-2.0 | `npm i -g @openai/codex`，0.156.0 起 | `codex login`；只有适配器时 `codex-acp cli login` |
| pi | `pi`，线追加 `--mode rpc` | MIT | `npm i -g @earendil-works/pi-coding-agent`，0.84.4 起 | 进入 pi 后 `/login` |
| OpenCode | `opencode acp` | MIT | `npm i -g @opencode/cli`，1.x 与 2.x | `opencode auth login` |
| DeepSeek Harness | `dsh --profile acp` | MIT | `npm i -g @deepseek-ai/dsh`，0.2.2-rc.1 起；它自己要求 Node.js 24.9 起；按完整消息回复 | 无 |
| Qwen Code | `qwen --acp` | Apache-2.0 | `npm i -g @qwen-code/qwen-code` | 进入后 `/auth` |
| goose | `goose acp` | Apache-2.0 | `brew install block-goose-cli` | `goose configure` |
| Claude Agent | `claude-agent-acp` | 适配器 Apache-2.0；Claude Code 专有 | `npm i -g @agentclientprotocol/claude-agent-acp`，适配器 0.99 起的 0.x | 不提供（`signIn`，见「登录」） |
| Cursor | `cursor-agent acp` | 专有（Cursor 服务条款） | 官方安装脚本 | `cursor-agent login` |
| Antigravity | `agy acp --disable-telemetry --process-per-session` | 专有（Google Antigravity 条款） | 1.5.8 起 | `agy acp --login` |
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
- 预设的 `helperCard` 是它作为新建 Agent 候选的样子，只写做得到的，见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#界面)。

### 版本门槛

profile 的 `minimumVersion` 是它的命令支持的最低版本，用 `<命令> --version` 读出。

| 预设 | 最低版本 | 经 Latch 使用模型服务时另要 |
| --- | --- | --- |
| Codex | 0.156.0 | 0.167.0 |
| pi | 0.84.4 | 1.5.0 |
| DeepSeek Harness | 0.2.2-rc.1（0.2.1-rc.1 之前的 ACP 一轮不等子 Agent 结算，取消也不等真实停止） | 同左 |
| Antigravity | 1.5.8 | 不支持 |
| Grok Build | 1.0.77 | 同左 |
| OpenCode | 无（版本规则 1.x、2.x） | 2.2.6 |
| Qwen Code | 无 | 0.26.8 |
| goose | 无 | 1.57.0 |
| Claude Agent | 无（版本规则见下） | 适配器自带的 Claude Code 2.1.318（`--cli --version`） |

怎样读：

- 只读标准输出第一行，整行是版本号（可带 `v`）才算。不经 shell，不发提示，10 秒上限，退出后还占着输出的子进程被结束。
- 与登录检查同一规则：只在启动脚本经 `startServer({ loginPrograms })` 打开后运行，测试 Host 碰不到真实程序。只读定义的命令就是预设命令名、或指向同一文件的路径时的那个文件；经 `node` 等启动的或项目里的同名文件不读也不挡。
- 只读已保存且启用的定义：Host 启动时读一次（最多 5 秒）；「重新检测」清缓存后等新结果（最多 5 秒）。没添加过的预设与停用的定义不读（`CommandDetection.versionUnread`）。
- 从新会话或「添加 Harness」选中预设时，保存定义之前读一次：太旧就拒绝，不保存、不开会话，草稿留在输入框。
- 结果按文件缓存。缓存说太旧时，新会话、已有会话的下一轮与进程启动前都再读一次：Volta、asdf、mise 的 shim 在升级后还是同一个文件。读完有变化时 Host 发一次 `refresh`。

低于门槛：

- 定义与预设在目录里是 `unavailable`、`statusReason: 'outdated'`，检测结果 `CommandDetection.outdated` 带 `need` 与 `upgrade`。草稿已选它时选择不变，不会自己换成别的 Harness。
- 新会话、已有会话的下一轮（已在运行的进程也不再接收）与「测试启动」都在启动进程前以 409 `harness-version-unsupported` 拒绝；这不记为「上次运行异常」。读版本发生在启动前的项目配置复查之前，复查仍是最后一步。
- 读不出版本（命令失败、超时、没打印）不挡任何事，由握手时限兜底（见「进程与环境」）。pi 的线另用 `clear_queue` 检查读不出版本的 pi（见「pi 的 RPC 模式」）。

## 预设的权限配置

每个预设的 `HarnessProfile` 只在 Host 上使用；浏览器只看到复制进 `TaskDetail.permission` 与 `HarnessInfo.permission` 的展示字段。

- **`version` 计入启动指纹。** 改变 profile 的行为时递增它；已有会话因此停止接受输入，换新会话继续。
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
| Claude Agent | — | `default` | `plan`、`default`、`acceptEdits`、`auto`、`bypassPermissions` | ExitPlanMode 只留 `exit-plan-default` | 可读回；适配器新会话默认进 `auto`，每轮前设回 |
| Cursor | `--mode` 或 `--force` 启动参数 | `agent` | `ask`、`plan`、`agent`、`agent-force` | `allow-always` | ACP 报告前三档；force 只标为启动设置 |
| Antigravity | — | `default` | `default`、`accept-edits`、`auto` | — | 可读回 |
| Grok Build | 预设参数 `--permission-mode default` | 无 | 无 | — | 不报告模式（`readback: 'none'`），不生成档位 |

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
- 这些只是默认值，不是保证。OpenCode 还合并用户与项目的配置（用户配置目录、向上查找的 `opencode.json`/`opencode.jsonc`、项目与主目录下 `.opencode` 中的配置和 Agent 定义），一部分在 Latch 的规则之后加载，可把询问改成直接允许，而模式读回仍是 `build`。项目里的计入启动指纹，用户配置不计入。
- 托管设置、`.opencode` 中的插件与项目新定义的 Agent 不受这些规则约束；这样的 Agent 不在模式顺序里，按更宽的模式对待。OpenCode 启动时会在 `.opencode` 安装依赖并加载插件，所以在不信任的项目里使用会运行项目里的代码。会话权限说明注明这两点。

**Cursor。** 前两档以 `--mode` 启动，`agent` 不传，`agent-force` 加 `--force`；空闲换档时重启、恢复并核对 ACP 模式。`--force` 不覆盖显式拒绝；ACP 不独立报告它，所以 force 档带 `source: launch`，一次重启不算对旧标志的核对。尚未做真实 Cursor 验收。

**Claude Agent。**

- 自动模式由 Claude 的分类器决定是否执行；计划模式在自动模式可用时，命令也可能由分类器决定。
- Claude 不需要批准的调用（工作目录内读取、只读命令）不出现在审批里；Claude Code 设置里的允许规则与 hooks 先于 Latch 生效；项目 `.mcp.json` 的服务器直接连接。
- **人选的换档（`modeAnswers`）。** Agent 用一次询问来换模式时，人的「仅此一次」回答就是选了那一档：ExitPlanMode 的 `exit-plan-default` 回到 `default`，EnterPlanMode 是 `switch_mode` 调用上的 `allow-once`，进入 `plan`。Latch 在把回答交给 Agent 之前把这一档记为预期模式，随后的换档不算漂移；没有人回答的换档仍是漂移。

**Antigravity。**

- `plan` 只追加规划指令，不保证只读：保留原生名称，不归入权限档位，只由人显式选择，不参与跨 Harness 的只读档位继承。
- `default` 下 CLI 自己的 `toolPermission`、允许与拒绝规则仍优先，可能直接改文件。Latch 设定并读回 mode，但不据此断言每次工具调用都询问；CLI 请求审批时只给单次选择。
- 用 `session/resume` 恢复。恢复后 CLI 报告的模型与思考回到它的默认值（`resumeResetsOptions`）：下一条消息发出前 Latch 按会话原先显示的值重设并逐项读回（先模型、后思考），CLI 不再提供或没有采用时这条消息不发出。所以这两项的「核对」不重新打开会话，结果保持未知；权限模式照常核对。
- 服务端拒绝一轮时 CLI 只发一段固定正文并以 `end_turn` 结束，不报告原因。profile 的 `terminatedReplies` 记下这段正文：一轮的全部回复正好是它（首尾空白除外）时记为失败，那条回复沿用原消息 ID 并标为失败；只是包含这段文字的仍是普通回复。只对 Antigravity 生效。
- 创建空会话可能加载扩展，所以模型列表只在人请求时读取。

**Grok Build。** stdio 模式是独立的 Agent 进程，不连接终端用的共享 leader；Latch 不运行 `grok leader kill`，只停自己启动的进程。继承 `GROK_HOME` 的名字与路径，不读其中的登录或历史文件。

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
| Qwen Code | `.qwen/` | — |
| pi | `.pi/`、`.agents/skills/` | `.pi/npm`、`.pi/git` |
| Claude Agent | `.claude/`、`.mcp.json` | `.claude/worktrees` |
| Cursor | `.cursor/`、`.cursorrules` | — |
| Antigravity | `.agents`、`.agent`、`_agents`、`_agent`、`.gemini/config.json`（清单引用的这些目录之外的代码不在覆盖范围内） | — |
| Grok Build | `.grok` | — |
| goose、DeepSeek Harness | 无 | — |

- **查找范围。** 从会话目录逐级向上到根目录，分别沿 Agent 收到的路径（可能经过符号链接）与它的真实路径；同一目录只查一次。主目录本身跳过，因为那里是 Agent 的用户级数据。范围比各 Agent 自己的（通常到 Git 仓库根）更宽。
- **其他文件夹。** Agent 收到的其他文件夹（见下节）同样从它们开始向上查找，与会话目录共用上限。
- **何时重算。** 新建会话时、每次输入与修改设置之前、每次启动 Agent 进程之前（首次启动、恢复、空闲停止后的重启；启动前的等待之后再查一次），以及为删除会话临时启动进程之前。
- **结果。** 只有项目配置变化时返回 409 `project-config-changed`，定义也变化时是 409 `agent-definition-changed`。为删除会话启动进程的检查不通过时只删除 Latch 的记录。Agent 按用户要求改了这些配置，之后的输入同样被拒绝。

## 项目的多个文件夹

一个项目可以由几个文件夹组成（见 [ARCHITECTURE.md](./ARCHITECTURE.md#会话与项目)）。ACP 会话的工作目录（ACP 的 `cwd`，也是进程的工作目录）始终是主文件夹。在新工作树里开始的会话例外：工作目录是工作树，指纹按工作树里的项目配置算，不交其他文件夹（见 [BRANCHES.md](./BRANCHES.md#在工作树里开始会话)）。

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
- 预设（profile 版本、`inheritEnv` 的名字、`programEnv` 找到的路径）；
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
- 会话启动与读取可选项的握手也记下 `initialize` 报告的图片与 embeddedContext 能力（`promptCapabilities`，按定义哈希），见 [ATTACHMENTS.md](ATTACHMENTS.md)。
- 结果带 `checkedAt`、`launchHash` 与最多 4 KiB 的诊断：先按定义变量与秘密格式脱敏，再截取结尾。保存为 `AgentRecord.lastProbe` 与 `probedDefinitionHash`；改启动内容会清除它。
- 探测通过不等于会话已启动，不改 `startedHash`，不授予以后启动的信任。
- 审计：运行前 `agent.probe.requested`，结束后 `agent.probed`，只含 ID、哈希与状态。
- 同设备同 `requestId` 在当前 Host 生命周期内共享整次探测，重试不再执行程序；记录只在内存，Host 重启后会再执行一次。

**适配器驱动的程序（`programVersion`）。** 保存在 codex-acp 上的定义，探测后再读它驱动的 Codex 的版本：定义设了 `CODEX_PATH` 用它的值，否则是 Host 找到的 `codex`；相对路径不解析，写「版本未知」。两个版本都知道、又不在 profile 的 `checked` 里时 `program.unchecked` 为真，页面提示这个组合没核对过，不阻止启动。`checked` 是每个适配器版本 `package.json` 的依赖范围（codex-acp 2.3.0 配 Codex 0.164.x，2.4.0 与 2.5.0 配 0.165.x）。

## 进程与环境

- **每会话一个进程。** 首次需要时启动，工作目录是会话的主文件夹，在独立进程组中运行。同一定义最多同时 8 个进程（`AcpAgentOptions.maxProcesses`）：到上限时停掉最久未用、可恢复的空闲进程，没有可停的返回 503 `agent-busy`。
- **空闲。** 空闲 10 分钟且 Agent 支持恢复会话时优雅停止，下次需要时再启动。
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

1. `latch-skills`（`skills-server.ts`）：会话带技能、或属于某个 Agent 或「和通用的对话」时有。后一种另有 `propose_memory` 与 `propose_schedule` 两个写工具，只往会话私有目录的 `proposals.jsonl` 追加提议（见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#记忆提议)）；不联网。
2. `latch-browser`（`browser-server.ts`）：打开、恢复、载入或分叉会话的那一刻，这台 Mac 的桌面端已登记为浏览器提供者、且会话有项目时有。令牌 `lbt1.` 在网关目录的 0600 文件里，服务只拿到文件路径，读出即删，参数与 `env` 里没有它，每次换新。桌面端没开时打开的会话没有这个服务，同一进程里不会补上（见 [PREVIEW-BROWSER.md](PREVIEW-BROWSER.md#agent-的工具)）。
3. 会话「用在」的每个 Latch MCP 服务器各一个 `latch-mcp` 桥：命令是 Host 的 Node，参数只有网关套接字与令牌文件的路径，`env` 为空；坏掉的服务器不挡会话（见 [MCP.md](MCP.md)）。

- 都没有时传空列表。pi 的预设写了 `skillServer: false`，三者都不给。
- Codex 直连时这些服务器随线程的 `config.mcp_servers` 交给 app-server（桥带 `startup_timeout_sec: 60`）。Codex 可能把线程配置写进它自己的会话文件：留下的是套接字与令牌文件的路径，没有令牌。
- 会话归档后，同一进程上的浏览器工具回答要等会话恢复；取消归档后要等进程重新启动才回来。

外部 Harness 的指令与记忆随话题的首轮块发送，见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#各-harness-如何收到)；记忆与定时提议的来源按当前上下文已送达的资料标记，见[不是用户原话的记忆](CUSTOM-AGENTS.md#不是用户原话的记忆)。

## 经 Latch 使用模型服务

模型菜单同时列 Harness 自己的模型与设置里保存的服务。两组前提不同：自己的模型要它自己的登录；服务的模型由 Latch 转发、用设置里的密钥，**不需要这个 Harness 登录**。

- 选了服务的模型时不显示「还没登录」，Codex 直连在这样的会话里也不查自己的账户。
- Host 按实际协议能力与自己的服务记录重新核对每次开始；客户端不能决定转发地址或密钥。
- 经网关的会话不能换服务，同服务内的模型可选。服务停用、删除、密钥或地址不可用时明确失败，不回退到 Harness 自己的登录或演示模型。
- 订阅仍由各 Harness 自己使用，不借给网关。
- 整轮没有经过网关时如实提示并审计；这不证明每个辅助请求都经过它。
- 首次准备里为 Harness 选的模型来源，以及默认模型的选取顺序，见 [MODEL-CONFIGURATION.md](MODEL-CONFIGURATION.md#默认模型)。

路由、协议转换、调度、用量与凭据生命周期见 [MODEL-GATEWAY.md](MODEL-GATEWAY.md)；每个 Harness 的交付细节见其 [Harness 交付](MODEL-GATEWAY.md#harness-交付)。这里只列每个 Harness 的事实（来自 profile 的 `gateway`）：

| Harness | 它说的协议 | 最低版本 | 交法 | 限制 |
| --- | --- | --- | --- | --- |
| Codex 直连 | Responses（Chat、Anthropic 服务经网关的实验性转换） | 0.167.0 | 启动参数里的自定义 provider `latch`，凭据在 `LMG_TOKEN` | 模型取服务的列表，可选 Codex 原生目录之外的 |
| codex-acp | Responses，实验性 | — | ACP `providers/set`，只在适配器声明并列出该 provider 与 API 类型时 | 只能用适配器认识的服务模型（`knownOnly`） |
| OpenCode | Chat、Responses、Anthropic | 2.2.6 | `OPENCODE_CONFIG_CONTENT` 里的私有 provider 与私有插件 | 插件把工具子进程里的令牌值清空 |
| DeepSeek Harness | Chat、Responses、Anthropic | 0.2.2-rc.1 | 私有 `--patch` 的 provider `latch-gateway` | 这条路线关掉它的会话日志与包清单遥测插件 |
| Claude Agent | Anthropic（Chat、Responses 服务经实验性转换） | Claude Code 2.1.318 | 官方环境变量与会话的 `modelPicker` | 只按精确的模型 ID |
| pi | Chat、Responses、Anthropic | 1.5.0 | 私有扩展注册 provider，只在当前进程 | 见 [pi 运行预算](MODEL-GATEWAY.md#pi-运行预算) |
| Qwen Code | Chat、Responses、Anthropic，实验性 | 0.26.8 | `QWEN_CODE_SYSTEM_SETTINGS_PATH` 指向 0600 的会话私有系统设置 | 没有子 Agent；凭据被工具子进程继承 |
| goose | Chat、Responses、Anthropic，实验性 | 1.57.0 | 只有环境变量；凭据在 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY` | `provider` 选项不提供；`delegate` 子 Agent 固定不了服务；凭据被继承 |
| Grok Build | Chat、Responses、Anthropic，实验性 | 1.0.77 | `GROK_HOME` 指向会话私有的家目录，其中 0600 的 `config.toml` 给每个服务模型写一个自定义模型 | 这个家里没有用户的 Grok 登录、钩子、插件与 MCP；凭据被继承 |
| Antigravity、Cursor | 不支持（`ownModelsOnly`） | — | — | 两者都不接受别人的模型服务地址；模型菜单不给它们列服务 |

**凭据被工具子进程继承（`credentialInherited`）。** Qwen Code、goose 与 Grok Build 没有清理工具子进程环境的官方开关：它们运行的命令、钩子与 stdio MCP 服务器读得到网关凭据。

- 这个凭据不是模型服务的密钥：它只能在这台电脑的回环端口上使用这个会话选定的服务与候选，进程退出或服务设置变化后失效。会话本来就是 L3。
- goose 的凭据放在它规定的变量里，会读这些变量的工具可能把它发给真实厂商：在那里没有用，但离开了这台电脑。
- 模型菜单「经 Latch」的说明为这三者多写一句（`HarnessCapabilities.models.credentialInherited`）。其余 Harness 各有清理办法，见 [Harness 交付](MODEL-GATEWAY.md#harness-交付)。

**各自去不掉的限制**（依据与出处在 MODEL-GATEWAY.md 的 [Qwen Code](MODEL-GATEWAY.md#qwen-code)、[goose](MODEL-GATEWAY.md#goose)、[Grok Build](MODEL-GATEWAY.md#grok-build)）：

- **Qwen Code。** 私有系统设置替代了系统设置路径，这个进程不再读真正的系统设置里的管理策略。子 Agent 以 `permissions.deny: ["Agent"]` 关掉：它的定义文件可以点名任何模型，而用户自己起名的服务与内置 OAuth 模型删不掉。用户自己的钩子、网页搜索的模型、`batch.model` 与实验性语音仍不经网关。
- **goose。** `delegate` 启动子 Agent 时，配方的 `settings.goose_provider` 或模型自己传的 `provider` 先于 `GOOSE_SUBAGENT_PROVIDER`：这样的子 Agent 用用户在 goose 里另配的服务，按轮的核对发现不了。Latch 不给会话传 `_meta.provider`（goose 会改用该服务的默认模型而不是 `GOOSE_MODEL`）。
- **Grok Build。** 自定义模型只能写在用户配置里，所以用私有 `GROK_HOME`；Grok 自己的会话记录也写在这里，随 Latch 会话删除。它起标题时用内置模型向同一地址发请求，网关拒绝，Grok 改用截断的用户文字，不影响这一轮。

三者标「实验性」：都只在没有登录的临时 HOME 下对本地假服务跑通过一轮（`apps/host/test/gateway-no-login.live.test.ts`），没有对真实服务、带工具与多轮跑过。假 Agent 与回放夹具是照源码与文档写的，不是录制。

## Codex 的 app-server

`wires/codex.ts` 运行 `codex app-server`（定义的参数之后加 `app-server`），一个进程一个会话（Codex 的 thread）。它把运行时说的 ACP 换成 Codex 的请求，把 Codex 的通知换成 ACP 的会话更新，所以启动指纹、模式读回、审批、取消与项目配置的检查照旧适用。协议形状按 Codex 0.167 的 `codex app-server generate-ts` 核对。

- **保留参数。** 会让 `codex` 变成别的东西的参数（`app-server`、`exec`、`login`、`resume`、`--help` 等，线里的 `RESERVED`）保存时就拒绝，400 `agent-args-reserved`。
- **握手与登录。** `initialize` 之后发 `initialized`；版本取自回答的 `userAgent`。开会话前先 `account/read`：没有账号且需要 OpenAI 登录时按未登录处理（409 `agent-auth-required`），不开 thread。
- **会话。** 新会话 `thread/start`，恢复 `thread/resume`（`excludeTurns`）。只有 Codex 自己说没有这个 thread 时才是「该 Harness 已找不到这个会话」；其他拒绝脱敏后照原样显示，接入已有会话据此认出「正在别处使用」。
- **一轮。** `turn/start` 带输入（文字；图片作 data URL；显式技能用官方目录里的 name 与 path）、模型、思考与当前模式的设置，等到 `turn/completed` 才结束：`completed` 正常，`interrupted` 算取消，`failed` 带 Codex 的原因失败。运行中追加用 `turn/steer`（带当前一轮的 ID）。
- **事件。** 回答与推理增量流式显示；`commandExecution`、`fileChange`、`mcpToolCall`、`webSearch` 是工具调用；`turn/plan/updated` 是计划，`thread/tokenUsage/updated` 是用量；`willRetry` 的 `error` 是一条重试提示。推理摘要分段到达而段间没有分隔，Latch 在换段时补一个空行。
- **命令的解析（`commandActions`）。** 全部动作都是读取、列出或搜索时，作为工具条目的可选字段 `actions` 带给客户端；有一项 `unknown` 或不认得的形状就不带，命令原文照旧保存。这个字段只从 Codex 线接受（[STREAMING.md](STREAMING.md#工作过程的行)）。
- **模型。** `model/list`（最多 5 页）给出模型与各自的思考深度；开始前的读取用同一个程序的 `codex app-server`，不开 thread。
- **模型服务与分叉。** 见上节；分叉仍用文字记录，尚未使用 `thread/fork`。

**权限模式。** 四档与 ACP 路线同名同说明，对照在 `profiles/codex.ts`；模式由线保存，thread 开始、恢复与每一轮 `turn/start` 都带上。

| 模式 | `approvalPolicy` | 沙箱 | 谁审 |
| --- | --- | --- | --- |
| `read-only` | `untrusted` | `readOnly`（不联网） | 人 |
| `workspace-write` | `on-request` | `workspaceWrite`（项目的其他文件夹是可写根，不联网） | 人 |
| `agent` | `on-request` | `workspaceWrite` | Codex 的审阅模型（`auto_review`） |
| `agent-full-access` | `never` | `dangerFullAccess` | — |

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
5. 确认不了时等到取消的时限（30 秒），先结束 app-server 启动的自成进程组的子孙进程，再结束进程。

Codex 自己中断、Latch 没有要求停止的一轮同样先等它的命令；30 秒后仍没有结束证据时强制结束 app-server，轮次标为已中断、命令结果未知。

**Codex 自己的 MCP 服务器**只读、只经 app-server 报告：Latch 从不读写 `~/.codex/config.toml`，不调用 `mcpServer/oauth/login`，不碰 Codex 的令牌。

- thread 开始或恢复后发一次 `mcpServerStatus/list`（带 `threadId`、`detail: toolsAndAuthOnly`，最多 4 页、200 个），再跟随 `mcpServer/startupStatus/updated`。变化作为 `_latch_mcp_status` 交给运行时，记为 `HarnessInfo.ownMcp`（只在内存，换定义即作废）。Latch 自己的服务器按名字排除。
- 「读取」（`POST /link/api/agents/:id/mcp`，`run`；审计 `agent.mcp.requested` 与 `agent.mcp.read`）在 Host 临时目录的空文件夹里启动 `codex app-server`，不开 thread，最多 60 秒。它可能启动 Codex 配置的服务器，所以只在人按下时读。
- 不带 thread 时 Codex 只列配置里的名字：报告标 `namesOnly`，不覆盖已有的会话报告。
- 每个服务器只留名字、状态、工具数与 `httpOrigin` 的源。见 [MCP.md](MCP.md#harness-自己的-mcp)。

## pi 的 RPC 模式

`wires/pi.ts` 启动 `pi --mode rpc`（两个参数接在定义的参数后面），把运行时的 ACP 方法换成 pi 的命令，把 pi 的事件换成 ACP 的会话更新；指纹、项目配置、取消、审批与持久化是同一份代码。依据 pi 自己的 `rpc-types.ts`、`rpc-mode.ts` 与 RPC 文档。

- **版本。** 需要 0.84.4：一轮以 `agent_settled` 结束，`message_update` 只带增量，停止前能清空队列。pi 的 RPC 不报告版本，所以进程启动时 `get_state` 之后先发一次 `clear_queue`：pi 答「Unknown command」时它早于 0.84.4，会话与测试启动都拒绝（409 `harness-version-unsupported`）。
- **回答顺序。** pi 1.5 在回答第一条命令前先发一条 `queue_update`，`new_session` 的回答可能晚于其后发出的命令；线按 `id` 对应，忽略不认识的事件。
- **保留参数。** 决定协议与会话的参数（`--mode`、`--print`、`--session`、`--continue`、`--resume`、`--fork`、`--help` 等，线里的 `RESERVED`）保存时拒绝，400 `agent-args-reserved`。
- **会话。** pi 启动时就有一个新会话；`get_state` 报告的会话文件就是 Latch 记下的会话标识。恢复用 `switch_session` 切到这个文件再用 `get_state` 核对，不是同一个文件就是「该 Harness 已找不到这个会话」。pi 没有删除会话的命令，删除 Latch 的会话时留下 pi 自己的副本。pi 不接收 MCP 服务器。
- **权限扩展。** 启动追加 Latch 私有的 0600 扩展 `latch-permission.ts`（`-e`，`wires/pi-gate.ts`）。`ask`：read、grep、find、ls 不问，其余先问；`plan` 拦下所有非读取；`rule` 直接允许 edit 与 write，其他先问；`never` 直接允许。线经私有命令换档，只接受 `get_commands` 报告的完整扩展路径与本次进程的状态回报；用户提示不能调用这个控制命令。扩展拒绝或询问失败时不执行调用。pi 的其他扩展仍可在工具回调之外运行代码，这不是隔离。
- **模型与思考。** `get_available_models` 列出模型（值写作 `provider/model`），一个都没有按未登录处理；`get_available_thinking_levels` 列出当前模型的思考深度，换模型后重读，读回 `get_state` 才算换好。
- **一轮。** `prompt` 发出，等到 `agent_settled` 才结束，再读 `get_session_stats`（令牌、上下文占用与花费）。回复以 `error` 结束时这一轮失败；以 `length` 结束按达到长度上限处理；扩展把输入当自己的命令处理（`handled`）时立即结束。
- **停止。** 先 `clear_queue` 再 `abort`：不清空队列，`abort` 会接着处理排队的追加。清掉的追加内容在会话里写一行。
- **运行中追加。** pi 在跑这一轮（`agent_start` 到 `agent_end`）时用 `steer`；其他时候交回 Host 排队。
- **工具与其他事件。** `tool_execution_*` 成为工具行（`bash` 命令，`read` 读取，`edit`、`write` 改文件，`grep`、`find`、`ls` 搜索）。压缩成为压缩行；自动重试、扩展的通知与扩展出错成为通知。pi 转来的失败回复、重试原因、压缩失败原因与扩展出错都先遮住像密钥的部分。
- **扩展的提问。** `confirm` 像审批一样交给人；`select`、`input`、`editor` 按「不支持的请求」写进会话，回答「已取消」。

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

## 通知与压缩

- **通知（`notice`）。** Agent 不属于对话历史的提示。每条在时间线上一行系统消息，按 `severity` 写「报告错误」或「提示」。它不改变本轮状态。
- **压缩（`compaction_update`、`compaction_summary_chunk`）。** 一次压缩一行，按 `compactionId` 就地更新（正在、已压缩、失败、已取消），Agent 给的摘要接在后面。行的位置是第一次报告到达时，之前的回复先结束。压缩失败不让本轮失败。
- **重试（`readRetry`）。** 把 Agent 标明的重试读成一行系统消息，不进思考；回复中途断开重新生成时，已收到的文字丢掉，新文字接在同一条消息里（消息 ID 不变），已收到的思考保留。原因先脱敏，最多 300 字。目前没有预设声明它。
- **各家说法不同的地方（`normalizeUpdate`）。** 只换不添：Qwen Code 只在 `_meta.toolName` 给工具名，填进 `name`；OpenCode 把回复的思考放在推理片段的 ID 下，去掉这个 ID 后思考归入它所属的回复。调用的 `kind` 只是 `other` 时用标题命名。
- **用量。** `session/prompt` 的 `usage` 只取 `inputTokens` 与 `outputTokens`；缓存与思考的令牌数各家含义不同，不映射。

## 登录

Latch 从不替人登录：不调用 `authenticate`，不读凭据文件或钥匙串。它只运行程序自己的命令，并听 Agent 怎么说。

**登录方式。**

- **Agent 声明的终端登录。** Agent 可以在 `authMethods` 里列 `type: "terminal"` 的方法。握手记下这些方法与宣告它们的程序路径（`src/auth.ts`，只在内存）。方法不能指定程序：运行的就是会话运行的那个程序，加定义的参数，再加方法的 `args`。方法的 `env` 只接受普通变量名，点名 Latch 设置或清除的变量时整个方法丢弃；参数与变量有数量和长度上限。打开终端前重新查找程序，路径变了就拒绝（409 `login-program-changed`）。定义自己的环境变量不写进登录脚本，因为里面可能有密钥。
- **预设的命令。** Agent 没列方法时用 `AgentPreset.login`（见「直连优先」的表），经 `HarnessInfo.login` 发给客户端。
- **Claude Agent。** 预设写了 `signIn`：Latch 不对它声明 terminal auth，不运行它列出的任何登录，页面只给 `signIn` 那句话，没有登录命令与按钮。页面显示它报告的登录状态、标签与到期日。

**状态。**

- **Agent 推送。** codex-acp 与 Claude Agent 的适配器推送 `_auth/status_update`（以 `agentCapabilities._meta.authStatus` 宣告）。Latch 只读 `kind` 与 `label`：`none` 是未登录，`account`、`api_key`、`gateway`、`external` 是已登录，其他是 `unknown`。`label` 显出不可见字符、遮住像密钥的部分、最多 80 字，含 `@` 的整个不用。`account`（email、组织、套餐）在解析时就丢掉。推送只在发出它的进程还在时算数。Claude Agent 的适配器只在 `initialize`、建会话与每轮开始时重读登录，所以空闲进程的推送可能是旧的。
- **状态命令（`loginStatus`）。** 只有 Codex 与 Claude Agent 有；其他 Harness 始终 `unknown`，要到 `session/new` 被拒才知道。
  - Codex：`codex login status`。退出 0 算已登录；退出 1 且文字是 `Not logged in` 才算未登录，其他都是 `unknown`。
  - Claude Agent：适配器自带 CLI 的 `claude-agent-acp --cli auth status --json`，只读 `loggedIn`、`apiKeySource`、`apiProvider` 与 `loginExpiresAt`。有推送时它仍运行，因为推送里没有到期日。
  - 超时 10 秒。输出只在判断时读一次，可能含账号或部分密钥，不返回、不记录。
- **三态接口。** `POST /link/api/harnesses/:id/login-status`（`run`，可带 `fresh`）返回 `{ status, label?, expiresAt? }`。有运行中的进程推送过、而状态命令说不出更多时直接用推送，不运行程序。两者都有时较新的说了算；标签只取推送的，日期只取命令的，各自只在结果与它的来源都说已登录时给出。结果缓存 30 秒；「测试启动」读到不同的明确状态时缓存作废。`fresh`（「重新检查」）总会再运行程序，只有 2 秒内的上一次 `fresh` 结果能代替它。
- **审计。** 每次实际运行前写 `agent.login.requested`（写不进就不运行），结束后 `agent.login.checked`，只含 ID 与状态。
- **不挡发送。** 页面选中 Harness 与窗口回到前台时检查；只在 `unauthenticated` 时显示登录说明，登录 10 天内到期时提示，都不挡发送，因为程序才说了算。没有状态命令的 Harness 在读模型列表被以没登录拒绝时（`catalogueRead.last.loginRequired`）显示同一行说明。
- **被拒的一轮。** 在这一轮结尾显示命令与「重试」。登录后消息仍由人按「重试」发出，这一轮在记录里仍是失败；下一轮启动新进程，读到新的登录。

**退出登录。** Agent 宣告 `agentCapabilities.auth.logout` 时才显示。`POST /link/api/harnesses/:id/logout`（`run`）先写审计 `agent.logout`（写不进就不做），再在私有空文件夹里起一个进程调用 ACP `logout` 后停掉。这个 Harness 有会话在运行时拒绝（409 `harness-busy`），没宣告时 409 `logout-unsupported`。之后停掉能恢复会话的空闲进程；不能恢复的进程留着它启动时读到的登录。

**在终端里登录。** `POST /link/api/harnesses/:id/login-terminal`（可带 `method`）只接受 `host.sock` 与 `run`。命令由 Host 从定义得出，调用方不能指定。写审计 `agent.login.opened`（Agent 声明的方法带 `source: 'harness'`）。

| 请求 | 在哪里运行 |
| --- | --- |
| 带 `terminal` | Latch 自己的终端（`features.terminal`）：会话里是底部终端中以 Harness 命名的一个，没有会话时是不属于任何会话的终端。命令以 0 退出后页面重新检查；规则见 [TERMINAL.md](TERMINAL.md#登录命令) |
| 不带 | 这台电脑默认的终端（`features.loginTerminal`，仅 macOS）：Host 写一个 0700 的 `.command` 临时文件交给 `open`，脚本先删除自己。页面只在 Host 不给这台设备 Latch 终端时走这条路 |

其他设备只看到命令。macOS 以外的 Host 上这两条路径尚未实现。Claude Agent 没有登录命令，也就没有按钮。

**测试 Host。** `startServer` 没有 `loginPrograms` 时不运行任何登录命令；没有 `commandDirectories` 时只认绝对路径，按名字找命令一律找不到。只有启动脚本传 `resolveCommand` 与 `personCommandDirectories`，所以带预设定义的测试 Host 碰不到这台电脑上真实安装的程序。

## 额度

Harness 用自己的订阅登录时，Latch 显示它自己的程序报告的额度（界面见 [DESIGN.md](DESIGN.md)「额度与用量」）。Latch 只听它已经为会话运行的那个进程：不读任何 CLI 的令牌或存储，不自己调用厂商接口，不为额度启动会话或模型轮次，不定时轮询。

| Harness | 来源 | 显示 |
| --- | --- | --- |
| Codex 直连 | 线程打开后在同一进程上发一次 `account/rateLimits/read` 与 `account/read`，之后并入每轮的 `account/rateLimits/updated`（稀疏更新不清除已知值） | 套餐自己的桶（`rateLimitsByLimitId.codex`，没有时用 `rateLimits`）的窗口：300 分钟是「5 小时」，10080 是「每周」；`planType`；遮住的邮箱。按模型的桶不显示 |
| Codex 经 codex-acp | 适配器不转发 | 不显示 |
| Claude Agent | `usage_update._meta["_claude/rateLimit"]` 的限额事件，与一轮因限额失败时错误 `data` 里的 `rateLimit` | 没有常驻百分比：只在窗口 `allowed_warning` 或 `rejected` 时显示警告与重置时间，同一窗口再报 `allowed` 就消失。只认 `five_hour`、`seven_day`、`seven_day_opus`、`seven_day_sonnet`；不用 `utilization`。不发 `/usage` |
| Grok Build | ACP 扩展请求 `_x.ai/billing`，在会话接上进程时与每轮结束时发，两次至少隔 5 分钟 | 本计费周期一行（`creditUsagePercent`、`currentPeriod.end`）；已知的 `subscriptionTier`；`prepaidBalance` 大于零时显示为余额 |
| Antigravity | 它自己的命令 `agy -p /usage --output-format json`（`profiles/antigravity-quota.ts`，不起模型轮次），在会话接上进程时与每轮结束时在旁边运行，至少隔 5 分钟，不等它；按登录状态命令的规则运行，加 `AGY_CLI_DISABLE_AUTO_UPDATE=true`，20 秒后连进程组结束，失败不说话 | `remaining_fraction` 是剩余比例；`window` 只认 `5h` 与 `weekly`。只显示 `Gemini Models` 与 `Claude and GPT models` 两个组，其余整个丢掉；`num_turns` 不为 0 或形状不同的输出不用 |
| Cursor、OpenCode、Qwen Code、goose、pi、DeepSeek Harness | 程序不报告订阅额度 | 输入框不显示；「额度与用量」里写一行「尚未报告额度」 |

- **形状。** `HarnessInfo.quota`（`packages/protocol/src/quota.ts`）全部是数字与固定集合里的值，没有厂商写的文字：不认识的窗口种类整个丢掉，不在集合里的套餐名不显示（`packages/harness-acp/src/quota.ts` 的 `harnessQuota`）。Codex 的 `rateLimitUpsell`、`limitName`、`accountId` 与完整邮箱不离开读它的进程；邮箱读到时就遮住。
- **只在内存。** 按 Agent 定义保存在驱动里，不写磁盘、日志与审计。窗口过了重置时间不再显示；报告它的进程退出后，有重置时间的窗口留到重置为止（额度属于账号），没有的随进程消失。退出登录或定义变化后全部清除。
- **谁能看到。** 随 Harness 目录（`catalog.harnesses`）发给能看到这个 Harness 的设备，没有单独的接口与权限；内容变了才推送。
- **经 Latch 使用模型服务的会话**不读、不问、不显示：订阅的额度不是它的。
- **到上限**（百分比到 100、Claude 报 `rejected`、Codex 的 `rateLimitReachedType` 不为空）是 `limited`。Latch 不因此拦截发送，被拒的一轮照常显示 Harness 的错误。

## 权限菜单

有 profile 的预设给每个模式一个档位与一句话（`modeTiers`），随 `HarnessInfo.permission` 与 `TaskDetail.permission` 发给页面与 iPhone。档位从严到宽：「只看不改」（`plan`）、「先问你」（`ask`）、「按规则放行」（`rule`）、「由模型判断」（`model`）、「不再询问」（`never`）。

| 预设 | 只看不改 | 先问你 | 按规则放行 | 由模型判断 | 不再询问 |
| --- | --- | --- | --- | --- | --- |
| Codex | — | `read-only` | `workspace-write` | `agent` | `agent-full-access` |
| Qwen Code | `plan` | `default` | `auto-edit` | `auto` | `yolo` |
| goose | `chat` | `approve` | — | `smart_approve` | `auto` |
| OpenCode | `plan` | `build` | `auto-edit` | — | `yolo` |
| pi | `plan` | `ask` | `rule` | — | `never` |
| DeepSeek Harness | `read-only` | — | `workspace-write` | — | `danger-full-access` |
| Cursor | `ask`、`plan`（官方名称） | `agent` | — | — | `agent-force` |
| Claude Agent | `plan` | `default` | `acceptEdits` | `auto` | `bypassPermissions` |
| Antigravity | — | `default` | `accept-edits` | `auto` | — |

「由模型判断」各家的意思：

- Codex `agent`：沙箱同 `workspace-write`，本来要问的由 Codex 的审阅模型放行或拦下，不转给人。
- Qwen Code `auto`：用户的允许规则、只读工具与项目内的文件编辑先放行（`.git`、`package.json` 等除外），其余由它的分类器判断，判断不了时问。
- goose `smart_approve`：工具声明或模型判断为只读的不问，其余问。
- Claude Agent `auto`：Claude 的分类器。

规则：

- **没有匹配预设的定义**按 Agent 自己报告的模式与说明列出，没有报告时写「权限无法确认」。Agent 报告了表里没有的模式时菜单不列它，除非会话正处在这个模式。Grok Build 不报告模式，不生成档位。
- **三行。** 模式超过三个时只列「先问你」、一个中间档（有「由模型判断」用它，否则「按规则放行」）与「不再询问」，其余收在「更多」；当前模式总是列出。「不再询问」是琥珀色，「由模型判断」不是。
- **谁能选。** 有 `run` 的设备都能选任何一档，不弹确认；放宽写 `task.mode.widened`。
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
| `PromptResponse.usage` | 会话用量（整体替换），只取输入与输出两个总数 |
| `usage_update` | `TaskDetail.usageReport`：上下文已用、窗口大小与费用，整体替换；不算可见输出，不计入 tokens |

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

**读取。** 还没有列表时可以不开始会话读一次：`POST /link/api/agents/:id/catalogue { auto?, model? }`（`HarnessInfo.catalogueRead`）。

- 在 Host 临时目录的新空文件夹里启动 Agent，`session/new` 带空的 `mcpServers`，不发提示；Agent 声明 `sessionCapabilities.delete` 就 `session/delete`，否则声明了 `close` 就 `session/close`；然后停止进程并删除文件夹，最多 20 秒。
- Codex 不开会话：只发 `initialize`、`config/read` 与 `model/list`（最多 5 页）。经 codex-acp 时用定义的命令加 `cli app-server`。它不报告模式，`catalogueRead.modes` 是 `false`。
- **什么时候读。** 新会话里选中这个 Harness、打开它的模型菜单，或打开会报告模式的 Harness 的权限菜单，而它既没有列表、这份定义也没读过时，自动读一次（`auto: true`；Host 再查一遍，不符合就返回 `ran: false`）。从不按时间读，失败后也不自动重读。
- **哪些自动读**（profile 的 `catalogueRead`）。只有读取不跑一轮、不调模型、也不运行人自己的会话钩子或扩展时才自动读：

  | 自动读（`select`） | 只在人点「读取模型列表」时读（`request`） |
  | --- | --- |
  | Codex（`model/list`，不开线程）、DeepSeek Harness、Cursor、goose、Qwen Code、OpenCode、没有 profile 的自定义命令 | pi、Claude Agent、Antigravity、Grok Build：启动会话会加载人的扩展或插件、运行会话开始的钩子 |

- **只读确认过的定义。** 自动读取遇到没确认过的定义或命令已解析到别的程序时不读（`ran: false`，不写审计、不启动）；人点读取时返回原因（409 `harness-unconfirmed` 等）。还没有定义的预设（`offer`）从不自动读。
- **谁能读。** 与开始会话同一道门：`run`，Harness 可以开始。同一定义同时只读一次；同一模型的请求共用结果。启动进程前写 `agent.catalogue.requested`（写不进就不启动），结束后 `agent.catalogue.read`。
- **结果。** 成功时列表来源为 `check`；失败保存脱敏后的 `last: { ok: false, message }`。Harness 以 ACP 的 `auth_required`（-32000）拒绝时另带 `loginRequired: true`：按错误码判断，不看消息文字。

**自己填的模型 ID。** `PUT /link/api/agents/:id/models { models }`（`run`，最多 32 个，每个最多 256 字符、不能换行，审计 `agent.models.changed` 只记个数）把 Harness 没列出的模型 ID 存进 `acp.json`（`HarnessInfo.customModels`），换定义也保留。只有列表里有模型选项时才能填。Agent 拒绝或没换过去时这一轮失败并说出下一次会用什么。

**草稿。**

- 已知权限预设在草稿就给出全部档位（`permission.modes` 与 `startMode`，暂用 `~mode` ID），开始时再匹配 Agent 实际的模式 ID。之后到达的列表不能抹掉人的选择。
- 草稿换模型后在私有空会话里切到该模型读选项，不发提示；自动与需人请求的边界同上。读不到或失败时保持未知，不把别的模型的档位搬过来。OpenCode 与 DeepSeek Harness 按模型报告思考（`thinkingPerModel`），没有就是这个模型没有思考档位；Cursor 的思考在模型列表里选（`thinkingInModel`）。
- 首轮设置未完成时，会话里的新选择取代对应的草稿项（相同值也算重新选择），并在恢复会话或应用其他草稿项之前持久化。

**应用。**

- 开始请求带 `config: [{ configId, value }]`（最多 16 项，同一项只能一次），计入请求摘要。Latch 内置 Harness 用 `model`，带 `config` 返回 400 `config-unsupported`。
- `session/new` 之后、第一条提示之前，依次设置模型、Agent 为这个模型提供的其他选项、模式；模式交给「权限模式」的设置与读回。Cursor 的 force 只报告启动配置完成，不冒充读回。
- **不再提供时。** 选的模型、模式或其他选项 Agent 不再提供、被拒绝或没采用：这一轮失败、不发提示，文字说出它的名字与下一次会用什么。失败之前照常设好草稿里的其他选择并读回模式，所以会话显示的就是之后运行的。Agent 要先登录时，还没设好的选择留到登录后的那次发送（尚未实现：会话详情不带还没设好的选择）。
- **审计。** `task.l3.start-requested` 与 `task.l3.started` 带 `configHash`（所选内容的摘要，不原样记录）。
- **我的 Agent 默认项。** Host 从定义的 `engineOptions` 生成同一份开始配置并冻结在原 `requestId` 的选择回执里；见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#家与工具)。

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

## 取消

任何有 `view` 的设备都可以取消。每一轮有持久化的 `runId`；取消带着它时，Driver 只在它仍是当前这一轮时取消，否则什么也不做（Host 回答 `ended`，见 [STREAMING.md](./STREAMING.md#取消的请求-id-与回执)）。

1. 发 `session/cancel`，同时把该会话所有未决的审批答复为 `cancelled`。
2. 继续接收 Agent 的更新，等本轮 `session/prompt` 结算后才确认取消；状态记为 `cancelled`，不论 Agent 返回什么 stopReason。
3. 30 秒内仍未结算时终止该会话的进程组，会话转为 `interrupted`。执行中的工具标为结果未知；`TaskSummary.runEnd`（`forced-stop`）与取消回执列出它们（见 [STREAMING.md](./STREAMING.md#运行的真实状态)）。

## 运行中追加

Agent 在 `initialize` 的 `_meta.steering = { supported: true }` 声明后，运行中的输入经 `_session/steering` 加入当前一轮，始终带 `_meta.steering.idleBehavior: "promptRequired"`：Agent 在没有轮次时不自己开新一轮，完成、用量与失败都留在原来的 `session/prompt` 上。

| 回答 | 处理 |
| --- | --- |
| `injected` | 记为这一轮里的用户消息；Host 读到回答的那一刻把之前的回复结算成一条 |
| `promptRequired` | 交回 Host 排队 |
| 其他结果或错误 | 不发出，报错 |
| 30 秒没有回答 | 结果未知，不重发 |

停止开始后不再追加。没有声明的 Agent 照常排队。语义见 [STREAMING.md](./STREAMING.md#追加到运行中的一轮)。

## 清空上下文

带 `freshContext` 的输入在新的 ACP 会话里开始（语义见 [STREAMING.md](./STREAMING.md#清空上下文)）。

- Latch 放下当前的 Agent 会话（Agent 声明 `session/close` 时关闭它），在同一进程上用 `session/new` 开新的（pi 是 `new_session`）。
- 人在这个会话里选的模型、思考与其他选项作为开始前的选项重新设置，权限模式照常设置并读回；Agent 不再提供所选模型时这一轮被拒绝。
- Agent 的指令（`agentBrief`）随新上下文的第一轮再发一次。旧会话的上下文用量、费用与计划不再显示。
- 从请求到新会话上记下第一条用户消息之前，任务记着上下文已清空（`acp.json` 的 `contextCleared`，`TaskDetail.contextCleared`）：这一轮被拒或进程退出时，下一条消息不论是否要求都在新会话里并带分隔线。重试同一请求不会再开一个会话。

## Codex 的 Agent 团队

直连 Codex 的会话在读到原生 `multi_agent` 已启用后提供「用团队分工」：它把分工文字放进输入框，由人补充目标后作为普通消息发送。Codex 自己选成员、分工、通信与汇总。Latch 不改 Codex 的功能开关、项目配置或凭据。经 codex-acp 与其他 Harness 报告的子 Agent 走「子 Agent」。

- **成员。** 从已知父轮的 `collabAgentToolCall` 或 `subAgentActivity` 与 Codex 报告的直接父关系确认。
- **结算。** 根线程完成可以先显示答复，这一轮仍等已证实活跃的成员及其命令真正结算。
- **停止。** 向仍活跃的根、已证身份的成员及其已证实的后代发 `turn/interrupt`，等实际终态与命令结束。成员没有单独的停止按钮。
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
- 后来的一轮里用 `sessionID` 继续一个已有的子 Agent 时，OpenCode 不转发它的更新与权限请求：它要批准时这一轮一直显示运行中，只能停止。按 2.x 的源码确认，尚未在真实运行中核对。

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

## 不支持的请求

Latch 只处理 Agent 发来的 `session/request_permission` 与上一节的提问。其他请求（包括未声明的文件系统与终端）与读不懂的询问立刻答复错误（`-32601`、`-32602`），Agent 不会一直等。

- 会话里写一条系统消息与脱敏后的内容（带附件的一轮不写内容，内容最多 2000 字符）；同一轮同一方法只写一次，最多 8 种。
- 运行中的 `TaskSummary.live.unrecognized` 给出次数与时间。它的 `at` 与 `lastEventAt` 用同一时间且不早于已知输出；`lastEventAt` 尚未晚于该请求时会话进「等你处理」。
- 会话尚未建立时只写 Host 日志。

## 持久化与恢复

- 数据在 `<数据目录>/harnesses/<agent-id>/acp.json`，与 Standard 相同的原子写入与锁文件，字段由 `packages/harness-acp/src/store.ts` 的 zod schema 校验。请求回执与用户消息在发送 `session/prompt` 之前写入；用户消息保留 `requestId`。
- Host 重启后，运行中或待审批的会话转为 `interrupted`，不自动重发输入。
- **继续进程已退出的会话。** 先核对启动指纹（含项目配置），再依次尝试 `session/resume`、`session/load`（丢弃重放的历史，Latch 已保存），然后读回权限模式；都不支持时 409 `harness-session-lost`。没有启动指纹记录的会话是 409 `l3-confirmation-missing`。
- **删除会话**删除 Latch 的记录、结束进程并清理临时目录。只有 Agent 声明支持时才调用 `session/delete`。清空过上下文的会话，每次清空前的 Agent 会话也一并删除（`earlierSessionIds`）。接入的会话的原会话从不删除。
- 进程已退出时，只有项目目录仍在 Host 的项目列表中才会为删除启动进程（Agent 启动时可能运行工作目录里的代码）；否则只删 Latch 的记录，并在 Host 日志里注明。

**分叉。** 由 Host 以一条背景文本加新输入开启新会话，仍是新的启动；ACP 不需要私有分叉方法。pi 的例外见「pi 的 RPC 模式」。

**排队。** Host 队列只在明确的 `runOutcome=completed` 后自动派发。ACP 只有 `session/prompt` 的 `end_turn` 算 completed；取消、输出上限、拒绝、未知 stopReason 与断连都暂停。`PromptOptions.queuedAt` 只作为用户消息的排队时间，不改变输入的幂等哈希与权限。

**附件与文件引用。**

- ACP 附件只走 `session/prompt` 的内容块。`initialize` 的 `promptCapabilities.image` 与 `embeddedContext` 必须各自为 true；探测缺少字段不代表支持，实际启动后再核对。
- 图片是 base64 image，文本是带 `latch-attachment:<id>` URI 的 embedded resource，不在项目里创建文件。Agent 输出的图片经 Host 回调存为会话附件。
- 带附件会话的 stderr 不进 Host 日志，RPC 失败也不回显附件。限额与授权见 [ATTACHMENTS.md](ATTACHMENTS.md)。
- 显式 `fileRefs` 由 Host 对固定目录再次验证，ACP 只在本轮模型输入里追加真实目录映射，公开消息保留原文。
- 文件变化的范围与结算见 [FILE-OUTPUTS.md](FILE-OUTPUTS.md)。

## 接入已有会话

用户在 Latch 之外用 CLI 做过的会话，可以经它自己的适配器列出、预览并接入为一个 Latch 会话。Latch 从不读取任何 CLI 的文件夹。接管终端里正开着的会话不做，遇到时拒绝。

**范围与权限。**

- 只对 profile 声明 `historyImport` 的预设开放：Codex（直连经 `thread/list` 与 `thread/read`；经 codex-acp 时 `session/list` 给元数据、`session/load` 重放）与 OpenCode 2.x。
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
- 尚未用真实 OpenCode 核对。两个前提要等核对：2.x 的列表行确实带 `additionalDirectories`；再读一行与 `session/load` 之间没有别的客户端加授权（这个窗口关不上，ACP 没有带条件的加载）。

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
- pi：它的 RPC 没有列出会话的命令，发现会话只能读它的存储，违反「外部会话只经适配器」。
- OpenCode 1.x：ACP 没有 `session/list`。
- Qwen Code、goose：源码声明了列出与加载，但加载对原会话的影响（恢复旧模式、写回设置等）没有读完，也没有用真实程序核对。
- Claude Agent、Grok Build、Antigravity：没有核对；Claude 的会话记录不碰。Cursor 不开放。
- iPhone/iPad 的列表与预览不显示「未列出」的数量与「看不出是否在别处使用」；停止行没有「在新会话中继续」。

## 会话命令

Harness 报告的命令透传，是否报告与执行由 Harness 决定。

**当前会话。**

- ACP `available_commands_update` 的当前列表作为 `TaskDetail.commands` 发给客户端并随会话持久化。每次更新替换之前的列表（空列表撤下命令）。
- 上限：200 条，名称 100 字符、说明 1000 字符、输入提示 500 字符；畸形更新不接受。名称不能含空白或控制字符，允许冒号，按可见安全文本显示。
- Harness 把本机 MCP 提示报告为 `mcp:服务器:提示` 一类的命令时，列在它的普通命令组里，发送时保留名称（见 [MCP.md](MCP.md#提示)）。
- 点按与 Tab 只把命令插入草稿；键盘 Enter 的条件见 [DESIGN.md](DESIGN.md)。
- 带 `idleOnly` 的命令在运行中置灰；排队、把排队的消息改成它或追加时 Host 以 409 `command-queued` 拒绝。

**上次会话的目录（新草稿）。**

- 新会话可以读同项目、同真实目录身份、同启动指纹下，上次真实会话报告的命令目录。缓存是数据目录里的 `harness-commands.json`（0600，最多 64 份、2 MiB），原子写入；空报告有别于未报告。
- 缓存只收已绑定进程的实际报告，不启动或探测 CLI，不读 CLI 自有存储。它只是建议，不授予执行能力，也不给当前结构化调用提供路径。
- `POST /agents/:id/commands` 接受正常开始会话的选择项，不接受任意 cwd；要 `view`，异步查找后复查设备、项目、来源可见性、真实目录与完整启动指纹。新分配的文件夹、工作树与助手家没有真实目录时不命中，也不为此创建目录。
- 响应只有 `commands`、`reportedAt`、`source=previous-session` 与可选的 `skills`、`skillsTruncated`。删除来源、改变启动配置或失去来源权限后不返回。
- `HarnessInfo.commandCatalogue.generation`（每次挂载 Driver 生成）与 `TaskSummary.commandsVersion`（每次命令报告后更新）是不透明标识。可见集合或选择改变时页面立即撤下旧结果并取消在途查询，迟到的响应不回填。
- 可见草稿每 30 秒只读重验，后台暂停。没有公开通知的 public→private 变化可能让之前的公开提示保留到下次重验；HTTP 每次仍重新授权。

**Codex 直连。**

- 声明 `/compact`，用 `thread/compact/start` 执行，不接受参数或附件。立即的 RPC 回答不是完成：手动压缩以对应 `turn/completed` 结算，取消用 `turn/interrupt` 并等真实结算。自动压缩以自身的 `item/completed` 为成功证据；普通一轮结束却缺少它时显示结果未知。
- 原生 compact 没有每轮的模型、思考或权限覆盖。执行前按 `thread/resume` 的实际读回核对 thread、目录、模型、思考、完整沙箱与审批策略；缺项、未知或非空的 `activePermissionProfile` 都拒绝。改过配置时先由普通消息应用，不发空轮次代替。
- 原生 `/review` 尚未接入（它会改变询问行为，并可能用独立的审阅模型）：直接输入或追加时拒绝，不调用 `review/start`，也不转成普通提示。

**pi。** 打开或加载会话时用 `get_commands`，只采用实际报告的 extension、prompt 与 skill。公开列表有界，去掉路径、`sourceInfo` 与私有权限扩展的命令。扩展与原生 compact 只在空闲时执行；提示模板与技能可以在追加时由 pi 展开。pi 自己报告 `/mcp` 不表示 Latch 能向它注入 MCP。

**人物 brief。** 线的 `commandsWithoutContext` 区分必须保留原生前缀的命令。只有完整首词与线确认的命令集合一致时才省略本次的人物 brief，下一条普通消息继续携带它；未知名字或读取目录失败时不省略。

**原生技能。**

- `TaskDetail.skills` 与 `HarnessCommandCatalogue.skills` 只有公开的 `name`、精确的 `invocation`、可选 `description` 与已知 `scope`，不含路径、正文或 `sourceInfo`。目录最多 200 项、64 KiB；先保名称，再分配说明。名称或数量超限时 `skillsTruncated: true`。Host 再次校验字段与预算。
- Codex 的 `$name` 不放进斜杠命令；pi 的 `/skill:name` 保留在 `commands` 里，已列为技能的不重复显示。Web 把技能放在技能组，点按、Tab、Enter 都只插入草稿；最近选择按 Harness 隔离。
- **Codex 的目录。** 开 thread 或恢复时以实际 cwd 调用 `skills/list {cwds:[cwd],forceReload:true}`。原生路径只留在当前线的 enabled 映射里，不从客户端或提示内容接收路径。`skills/changed` 立即清空映射并重读，旧代次的回答不得恢复旧路径。读取失败或目录不完整时撤下当前目录，错误里的私有路径不外发。
- **Codex 的调用。** Host 在加人物 brief、文件引用、撤销说明、seed 与历史之前保留本轮原文，只经内部调用上下文传给线，不接受公共 HTTP 的来源声明。线只从这份原文里完整的、空白分隔的 `$name` 匹配官方清单，补充 `{type:'skill',name,path}`；原文照常发送。未知、带前后缀、转义或引号包围的名字保持文字；同名的 enabled 项明确拒绝。没有原文证据时不扫描完整 prompt 兜底。这只限定 Latch 生成的结构化项，不限制 CLI 或模型自己的行为。

## 错误

本文其他章节给出的错误码不在此重复。

| 代码 | 含义 |
| --- | --- |
| `mode-unsupported`（400） | ACP Agent 只支持 Agent 模式 |
| `agent-env-reserved`（400） | 定义设置了由 Latch 管理的环境变量 |
| `agent-args-reserved`（400） | 定义的参数里有由线决定的参数（Codex、pi） |
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
| OpenCode 2.x 在后来的一轮里继续的子 Agent 的请求 | OpenCode 的 ACP 不转发，这一轮会一直等到停止 |
| 单独停止没有宣告 `capabilities.cancel` 的子 Agent | ACP 不允许。OpenCode 2.x 不宣告：它的后台子 Agent 在一轮结束或停止后仍可能继续，直到空闲进程被结束 |
| 让启动子 Agent 的 Agent 回答子 Agent 的请求 | ACP 没有把客户端收到的权限请求交给另一个 Agent 回答的方法 |
| goose 的运行中追加 | 它的私有方法要 goose 自己的运行标识，也没有声明字段，未经真实核对 |
| 按会话放行 OpenCode 访问其他文件夹 | 需要按会话改变 OpenCode 的配置并提高 profile 版本；2.x 的 ACP 字段尚未使用 |
| Claude Agent 的其他文件夹（`additionalDirectories`） | Claude 访问会话目录以外的路径时逐次询问 |
| ACP 的原生分叉（`session/fork`）、Codex 的 `thread/fork` | `session/fork` 只能分叉整个会话，新进程能否分叉另一个进程的会话没有用真实 Agent 核对。pi 以外的分叉都用背景文本 |
| 回答 pi 扩展的选择题与输入框 | 它们回答「已取消」并写进会话 |
| 只有主文件夹的 Codex 会话把 `.agents/skills/` 计入启动指纹 | 原生技能目录读取已接入，指纹范围没有扩展 |
| iOS 的原生技能选择菜单 | iOS 仍可手动输入原生调用文字 |
| Codex 的 `/review` | 见「会话命令」 |
| Qwen Code、goose、Grok Build 去掉「实验性」，以及清理工具子进程里的网关凭据 | 见「经 Latch 使用模型服务」 |
| Qwen Code 经 Latch 时的思考档位与子 Agent | 思考只提供它自己经 ACP 报告的选项；子 Agent 关掉，直到 Qwen Code 能把子 Agent 的模型限制在指定的服务上 |
| goose 固定 `delegate` 子 Agent 的服务 | goose 没有文档化的设置能固定或关掉它 |
| Antigravity、Cursor 经 Latch 使用模型服务 | 做不了：两者都不接受别人的模型服务地址 |
| Antigravity、Grok Build 接入已有会话 | 没有核对它们的列出与加载 |
| Cursor 的真实验收 | 权限档位只按文档接线 |
| Claude Agent 常驻的额度百分比 | 适配器只转发每轮的限额事件，Latch 不自动发 `/usage` |
| Codex 按模型的额度桶、开会话前的额度 | 只显示套餐自己的桶，并且要等第一个会话的线程打开后才读 |
| Cursor、OpenCode、Qwen Code、goose、pi、DeepSeek Harness 的额度 | 程序不报告，Latch 不读它们的令牌去问厂商 |

## 测试

命令、假 Agent（`fake-acp-agent.mjs`、`fake-codex-app-server.mjs`、`fake-pi-agent.mjs`）、回放与需要显式开启的真实程序用例见 [TESTING.md](TESTING.md)。本包运行 `pnpm test --project @latch/harness-acp`。

- 默认测试不启动真实 Agent；预设的权限配置经 `presetId` 套用到假 Agent 上测试。
- 假 Agent 的网关模式（`FAKE_ACP_GATEWAY`）与回放是照各程序的源码与文档写的，不是真实程序的录制：它们不证明真实 CLI 的行为。
- 「不修改原 CLI 配置」的回归用临时 HOME、项目与假 Agent 核对原配置与 hooks 哨兵文件不变；真实 CLI 的行为要单列证据。
