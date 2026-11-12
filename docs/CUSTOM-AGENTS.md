---
description: 我的 Agent 与「通用」：定义、记忆、会话归属、各 Harness 如何收到指令、记忆和技能。
sources:
  - apps/host/src/custom-agents.ts
  - apps/host/src/agent-plans.ts
  - apps/host/src/agent-journal.ts
  - apps/host/src/routes/agents.ts
  - apps/host/src/hub.ts
  - apps/host/src/server.ts
  - packages/protocol/src/custom-agents.ts
  - packages/core/src/runtime.ts
  - packages/core/src/registry.ts
  - packages/harness-acp/src/runtime.ts
  - packages/harness-acp/src/skills-server.ts
  - apps/web/src/agents/model.ts
  - apps/web/src/agents/useAgentData.ts
  - apps/web/src/agents/useAgentWrites.ts
  - apps/web/src/agents/AgentsPage.tsx
  - apps/web/src/agents/AgentsSpaceList.tsx
  - apps/web/src/shell/spaces.ts
  - apps/web/src/shell/SpaceNav.tsx
  - apps/web/src/agents/chat.ts
  - apps/web/src/agents/AgentChat.tsx
  - apps/web/src/agents/AgentFrame.tsx
  - apps/web/src/agents/TopicFrame.tsx
  - apps/web/src/agents/NewTopic.tsx
  - apps/web/src/agents/AgentProfile.tsx
  - apps/web/src/agents/Memory.tsx
  - apps/web/src/agents/AgentForm.tsx
  - apps/web/src/agents/Schedules.tsx
  - apps/web/src/agents/CarryResults.tsx
  - apps/web/src/agents/scheduleModel.ts
  - native/ios/Sources/LatchNativeCore/PhoneAgents.swift
  - native/ios/App/Agents/AgentsView.swift
---
# 我的 Agent

Agent 是用户使用的那个东西：名称、头像、说明、指令、技能、Harness、模型，再加记忆与默认项目。Harness（代码里仍叫 Harness）是运行它的程序，自带基础提示和工具。Agent 不替换 Harness，只往上加。

`catalog.features.customAgents` 声明下面的接口。这些路由与 `/link/api/agents` 无关：后者仍指 Harness 定义。

| 接口 | 作用 |
| --- | --- |
| `GET /custom-agents` | 「通用」、我的 Agent 摘要与可选插件 |
| `POST /custom-agents` | 新建；头像由 Host 分配 |
| `GET`、`PATCH`、`DELETE /custom-agents/:id` | 详情（含指令、记忆、会话）、按 `baseRevision` 修改、删除；可选字段传 `null` 清除 |
| `GET`、`POST /custom-agents/:id/memories`，`PATCH`、`DELETE …/:mid` | 记忆，只有用户能写，只有这个 Agent 能用 |
| `GET`、`PATCH /custom-agents/general` | 「通用」，不能删除；记忆路由同样可用 |

快照的 `customAgents` 只有摘要（不含指令、技能和工具的内容）。写操作都带 `requestId`，重试按回执回答；结果未知时拒绝其他修改和读取，Host 每秒自己重试写入，也可以重试同一请求；这期间快照没有 `customAgents` 和 `automations`，其余照常。定义在 `agents/custom.json`。

## 字段

- `harnessId`：默认 Harness。`mode`：Harness 有多种模式时的默认值。
- `model`：只用于运行在 Host 模型服务上的 Harness。
- `engineOptions`：外部 Harness 自己的默认项（模型、思考、权限），`configId` 到值。Host 只保存，由启动会话的客户端经会话配置路由设置，走该路由的检查；Host 在第一轮之前不会替客户端设置。内置 Harness 目前没有思考档位。
- `instructions`：指令。`skills`：`catalog.skills` 里的 `pluginId:skillId`。
- `tools`：「可以使用」，只对内置 Harness 生效，是可调用工具的插件 ID；缺省时不额外限制。它只收紧，不授予新能力。
- `defaultProjectId`：新会话的默认项目。
- `avatar`：头像，`{ kind: 'face', bracket, eyes, hue }`，括号 `round`、`curly`、`square`、`angle`，眼睛 `dot`、`arc`、`oval`、`sleepy`，颜色 `ink`、`slate`、`pine`、`plum`、`wisteria`、`cocoa`、`sand`、`moss`、`mist`（`AGENT_BRACKETS`、`AGENT_EYES`、`AGENT_HUES`）。新建时 Host 分配一个还没用过的括号 × 颜色组合，眼睛用圆点；`PATCH` 带 `avatar` 修改，和其他字段一样经 `baseRevision`、`requestId`、先审计再写和回执，审计 detail 只有哈希。未知的字段与取值都拒绝。头像不进 `definitionHash`，会话收不到它。只有 `definitionHash` 变了的修改才把这个 Agent 的定时任务重新绑定到修改的设备（读不到时照旧重新绑定）；改名称、说明或头像既不移动也不暂停定时任务，但新名称会出现在之后运行的第一轮文本块里，因为它写着 Agent 的名称。`kind` 为以后上传图片留位，尚未实现。

摘要里的 `available` 与 `unavailableReason` 说明现在能否开始会话，`canAutomate` 说明能否用于定时任务。

## 「通用」

「通用」是内置 Agent，没有自己的 Harness：选了它的会话用当次选择的 Harness 和模型。写给它的指令和记忆对没选别的 Agent 的会话生效，这些会话没有 `TaskSummary.agent`。

只有完整数据范围的设备发出的一轮才带上「通用」：模型的回复可能复述它，其他设备读得到的会话不能收到它。范围较小的设备照常工作，就像「通用」是空的。

一轮带上「通用」后，这个会话的 `TaskSummary.agentPrivate` 就为真，写入时机在模型收到之前，读取与继续都要完整数据范围，范围较小的设备从此看不到它，即使是它开始的。分叉一个私有会话得到的新会话同样私有，定时任务的每次运行也是。

`skills` 缺省时这些会话加载全部已启用的技能，与之前一样；写成数组（包括空数组）后就只加载这些；其中插件已停用或移除的技能不再加载，不影响会话开始。

## 会话

`POST /tasks` 接受 `customAgentId`。新会话的标题取第一条输入从第一行非 `>` 引用的文字起（内置与外部 Harness 相同，`promptTitle`），所以带入的成果不会成为标题；只有引用时取第一个「上次成果」的标题。请求里同时给的 `harnessId`、`mode`、`model`、`workspaceId` 只影响这次会话，没给的取 Agent 的默认值；`workspaceId: 'default'` 是 Host 的起始文件夹（开了 `sessionFolders` 时是会话自己的文件夹），没有默认项目的 Agent 与这一次不用默认项目的委托都这样发送。只有用的是 Agent 自己的默认项目而它已移除时，开始以 409 `agent-unavailable`「默认项目已移除」拒绝；这一次另选的项目不存在时与普通会话一样是 400 `workspace-unavailable`。一个请求的选择在第一次时写入回执，所以结果未知后的重试不会换到后来改过的 Harness。

会话开始后 Agent 与 Harness 不再变，归属记录在 `TaskSummary.agent`。Agent 的会话内容只对完整数据范围的设备开放。

**和「通用」对话**：`customAgentId: 'general'` 开始的会话不指定 Agent，「通用」照常生效（与其他没选 Agent 的会话一样）；Host 只在会话元数据里记下 `generalChat`（`session-meta.ts` 的 schema），摘要里是 `TaskSummary.generalChat: true`，执行端声称的同名字段被丢弃，不进审计。这个标记本身就让会话私有（与 Agent 的会话一样，`agentPrivate` 为真，范围较小的设备读不到、列不出，事件流里也没有它的内容），不论「通用」当时是否为空、Harness 是否接收「通用」；开始时与开始前的复查都要求完整数据范围。客户端据此把它放进我的 Agent 而不是 Code。它要求完整数据范围（否则 403 `agent-scope-required`），不带项目、工作树或分叉（否则 400 `general-chat-project`）；网页按所选 Harness 有「只对话」时用它。

## 各 Harness 如何收到

`HarnessInfo.agentContext` 与 `HarnessInfo.skills` 说明 Harness 的接收方式；两者都由 Driver 声明。没有 `agentContext` 的 Harness 不能运行 Agent。

**内置 Harness**（`private`、`native`）：每轮的系统提示依次是 Latch 的基础提示、指令和记忆、技能。指令和记忆只在这一轮的运行里，不进消息、历史、分叉或导出；每轮按当前定义重新读取。技能目前随会话整段加载，尚未实现按需读取。Agent 删除后，它在内置 Harness 上的会话不再接受输入，提示在新会话中继续。

**外部 Harness**（`first-turn`）：Harness 的提示和工具都保留。指令和记忆作为一个带标注的文本块，在第一个真正到达 Harness 的轮次排在用户输入之前发送，写出后记录在那条用户消息的 `agentBrief` 上；`segments` 分开 Latch 的说明和用户写的内容，换行连接后就是发送的字符。第一轮没有到达 Harness（进程没有起来、发送前取消）时，文本块留到下一轮，重启后也一样；写出后、记录落盘前崩溃时下一轮会再发一次，不会一次都没发。`Message.text` 不含它，分叉的背景文本也不带它；pi 用自己的记录分叉时（见 [HARNESSES.md](HARNESSES.md#pi-的-rpc-模式)），新会话里是 pi 收到过的原样记录，来源会话发过的文本块也在其中，新会话自己的文本块照常随它的第一轮发送。发送过之后的轮次不再发送，改动指令不影响已开始的会话；清空上下文后，同一个文本块随新上下文的第一轮再发送一次并记在那条消息上，因为 Harness 的新会话里没有它。设备开始完全访问会话时，启动审计（`task.l3.start-requested`）的 `promptHash` 同时覆盖这个文本块。

**外部 Harness 的技能**（`server`）：Host 把所选技能复制到会话自己的目录，并在 `session/new`、`resume`、`load` 时附加一个 stdio MCP 服务 `latch-skills`。它只有 `list_skills` 和 `read_skill` 两个工具，不写文件、不访问网络。删除会话时一并删除这份副本。服务的命令是 Host 自己 Node 程序的绝对路径，不带 `type`，环境变量为空，所以只接受命令为绝对路径的 stdio 服务的 Harness（DeepSeek Harness）也能启动它；`server/discover` 返回「方法不存在」，客户端退回 2025 版的 `initialize` 握手（假 Agent 的 `FAKE_ACP_MCP=dsh` 照此检查）。预设以 `skillServer: false` 声明不接受 MCP 的 Harness（目前是 pi），这些 Harness 没有 `HarnessInfo.skills`，技能不发送，界面据此提示。其余预设是否实际取用技能尚未逐一在真实 Agent 上验证。

`agentContext` 由 Host 构造，从不接受 HTTP 客户端传入。

## 界面

网页与桌面端分成两个大空间：Code 与我的 Agent，只在 `catalog.features.customAgents` 存在时分开（没有时只有 Code，和以前一样）。宽窗口的侧栏最上方（电脑菜单与电脑名之下）是整宽的两段开关「Code | 我的 Agent」（`SpaceSwitch`，[SpaceNav.tsx](../apps/web/src/shell/SpaceNav.tsx)），它切换空间而不是筛选：主操作、列表与主区的首页一起换掉，底部的「应用」与「设置」两边共用。手机仍是底部标签栏里的一个标签。

- **会话属于哪边**：只看 `TaskSummary.agent` 与 `TaskSummary.generalChat`：某个 Agent 的会话与在我的 Agent 里和「通用」的对话只在我的 Agent，其余（包括在 Code 开始、带上「通用」的会话）在 Code。过滤在共享的会话列表模型里（[sessions.ts](../apps/web/src/sessions.ts) 的 `spaceOf`、`inSpace`，`filterSessions`、`listedSessions` 与 `waitingCount` 的空间参数），组件不各写一份；Host 没有我的 Agent 时不传空间，所有会话都在 Code。
- **当前空间**（[spaces.ts](../apps/web/src/shell/spaces.ts)）：我的 Agent 的页面在我的 Agent；打开的会话决定它所在的一边（打开一个话题就切到我的 Agent，开关跟着变）；新会话页是 Code 的首页；应用、设置与 Host 还没列出的会话停在上次的一边。每台设备记住上次所在的空间（本地存储 `latch.space.<来源>.<设备>`，从不发给 Host），宽窗口冷启动时回到那里。切过去时回到离开那边时打开的会话或我的 Agent 页面（会话已归档或不再属于那边时回到首页）。
- **主操作**：Code 是「新会话」；我的 Agent 是「新对话…」，同一个键（⌘N，浏览器 Alt N），打开 Agent 的选择菜单（「通用」在最前，不可用的 Agent 带原因、不能选，最后一项「新建 Agent」），选中后进入它的新话题，输入框拿到焦点。「搜索」两边相同。
- **侧栏列表**：Code 与以前一样按「等你处理 / 各项目 / 无项目 / 已归档」分组，没有我的 Agent 的会话。我的 Agent 是「我的 Agent」小标题（点它回到列表页）、「通用」（标「内置」）、各 Agent 一行（24 头像、名称、状态词：运行中、等你处理、失败、不可用；点一下打开它的当前话题），「新建 Agent」，然后「最近对话」：等你处理的话题（归档了的也算，和 Code 的「等你处理」一样）排在最前，其余未归档的按时间倒序，最多 6 条（等你处理的从不被截掉），每行是标题、所属 Agent（「通用」的写「通用」）与时间或运行状态（与 Code 的行同一套词），多于 6 条时「全部 N」原地展开；最后是安静的「已归档 N」，和 Code 的一样，点开后是归档的话题与回去的一行。每个话题只在其中一处。Agent 已删除的话题照样列出，Agent 处写「已删除的 Agent」（摘要暂缺时写「Agent」）。正在对话的 Agent 与打开的话题是选中行。没有完整数据范围时列表处是「这台设备看不到 Agent」；摘要因写入结果未知暂缺时写「正在确认上一项修改」。
- **等你处理**：另一边有等你处理的会话时，那一段名称后面隔开一点是一个琥珀点（不写数字，读屏从提示里读到原因）。每边只算自己的列表能显示的会话，所以点总有一行可指；Host 列不出的审批会话只算进总数（Dock 与标题行的「等你处理」），不算进哪一边。手机的「Code」与「我的 Agent」标签各自只算自己那边。应用页与设置这类两边共用的页面上开关两段都不选中，点哪段就回到哪边。
- **键盘与菜单**：⇧⌘1 到 Code、⇧⌘2 到我的 Agent（桌面端与浏览器相同，浏览器写作 Mod Shift 1/2），在页面上也有效，切过去后焦点落在那边的主操作上（看不到时落在那一段）；⌘1…⌘9 与上一个、下一个会话走当前空间画出的行（我的 Agent 里是「最近对话」，展开「全部」或在「已归档」里时跟着变）。设置 › 快捷键与 ⌘/ 只在有我的 Agent 时列出这两项，⌘N 只在这台设备能开始对话（能运行会话、完整数据范围）时写作「新会话 · 新对话」。桌面端「显示」菜单里有同名的「Code」「我的 Agent」，作用于有焦点的窗口：页面订阅时经 `latch:space:ready` 告诉主进程它有两个空间（只在 Host 有我的 Agent 时订阅），主进程只为这样的窗口启用这两项，页面导航后重新判断；选中时主进程只把空间名经 `latch:space` 发给页面，preload 只放行这两个值。
- **侧栏收起**：标题行的左端在 ◧ 之后是两个图标按钮（Code、我的 Agent，当前的一个是按下状态，另一边有等你处理时带琥珀点），再是当前空间的主操作（新会话或新对话…）。平板的抽屉里同样是开关加列表；我的 Agent 的页面在平板上保留 200px 的行内列表。
- **页头**：我的 Agent 的话题（和新话题）的页头是这个 Agent 的对话外框（`AgentFrame`）：左边是头像（24，手机 28）、名称与状态词，点它们打开资料面板；右边是「话题 ▾」，再是会话自己的面板开关与 ⋯（重命名、归档等都在 ⋯ 里）。「话题」列出这个 Agent 的会话：第一项「新话题」，然后未归档的按时间倒序（标题、时间与状态，打开的一个打勾），最后是「已归档」。手机的页头是返回、外框（名称下写话题标题）、话题、面板与 ⋯；手机的「我的 Agent」标签在 Agent 列表下面同样有「最近对话」与「已归档」；从话题返回，回到这个列表。
- **搜索面板**：⌘K 搜两边，会话行的第二行先写它在哪边：「Code」或 Agent 名称；我的 Agent 的会话的图标是 Agent 的头像。根命令里有「Code」与「我的 Agent」。
- **图标**：所有「我的 Agent」入口（开关、收起时的按钮、命令面板、手机网页的标签栏）用同一个单色图标 `AgentsGlyph`（[AgentAvatar.tsx](../apps/web/src/agents/AgentAvatar.tsx)）：头像家族的花括号加圆点眼 `{··}`，取 `avatarFace.ts` 的几何裁到只剩脸，线条比头像里稍粗（2.5），是 Lucide 图标，用法与其他图标一样，不动。

- **列表**：「通用」在最前并标「内置」，其余按 Host 的顺序；每行是头像、名称、一行职责（说明，没有时是指令的第一行）、Harness · 模型、默认项目与 `available`/`unavailableReason`。点一行就是和它对话；主按钮是「给<名称>发消息…」（进入新话题），还没有自己的 Agent 时是「新建 Agent」。
- **对话**（[chat.ts](../apps/web/src/agents/chat.ts)）：选中一个 Agent（「通用」也一样）就是和它对话。打开的是它的**当前话题**：最近活动过、未归档、不是定时任务运行的会话（定时任务的运行在「话题 ▾」里；`agents/:id` 与侧栏、列表、命令面板都这样打开），主区就是会话视图，记录、工具行、审批与右侧面板和 Code 里相同，输入框写「给 <名字> 发消息…」，发出的消息是这个会话的下一轮。没有话题，或在「话题 ▾」里选了「新话题」时，主区是新话题：中间是 Agent 的头像、名称与职责，底部的输入框经 `POST /tasks` 带 `customAgentId`（「通用」是 `general`）开始新会话，Agent 的 Harness、模型和默认项目预先选好，这一次可以换项目、文件夹（新工作树的起点按所选发送）、Harness 和模型（Harness 只列有 `agentContext` 的；「通用」不带项目）；外部 Harness 的 `engineOptions` 尚未在开始时设置。有之前的话题时下方有「带入上次成果」：选一个或多个之前的话题，从每个读出最后一条回复（默认勾选）和它提到的文件，作为引用文字（从「> 上次成果「标题」：」起每行都是 `>` 引用，文件只写路径）插在已写的文字后面；它不建交接记录，也不接着原来的上下文。Host 回答时还停在这个新话题上才就地打开它；这期间去了别处就留在那里，新话题在「话题 ▾」里。旧的 `agents/:id/memory|schedules|settings` 打开对话并把资料面板定位到那一节，旧的「委托」链接打开对话。
- **资料面板**（[AgentProfile.tsx](../apps/web/src/agents/AgentProfile.tsx)）：点外框的头像或名称才出现，宽窗口占右侧面板的位置，和改动、文件等面板互斥（面板开关把面板换回来），新话题上同样在右边，窄于 1024 时浮在对话上；手机上是底部面板；可以关掉。自上而下：大头像（能开始会话的设备点开头像选择器）、名称与职责、不可用或不在线时的原因；分段「动态 · 记忆」（动态是最近的话题，点一下进入；记忆可以添加、修改、删除，规则见下面「写入」）；「即将进行」：这个 Agent 的定时任务，每条写名称与计划，带开关（经 `…/enabled`，带 `baseRevision` 与 `requestId`），「编辑」或「新建定时」进入现有的定时编辑；电脑与工作位置；Harness · 模型、技能与工具的数量；最后「设置」打开现有的编辑表单（「通用」是指令与技能）。「通用」的「即将进行」是不指定 Agent 的定时任务，在这里同样能开关、编辑和新建。
- **头像**：一对括号围着两只眼睛，放在浅色圆角方块上，颜色取 `--agent-<hue>` 令牌（「通用」是中性灰的圆括号加圆点）。列表 40、资料面板与新话题 56、侧栏 24、对话外框 24（手机 28）、命令面板 16；「我的 Agent」入口是上面的单色 `{··}`。资料面板的大头像打开选择器（桌面是弹层，手机是底部面板）：会动的预览，下面是括号、眼睛、颜色三行，选项本身就是头像，选中项是墨色环，每行一个 Tab 停靠点，方向键从当前焦点移动，空格或回车选择；「设置」里没保存的修改在 Agent 有新版本时保留，同一字段在别处也改了时提示「已在别处修改」；选了立即提交，只显示 Host 读回的值，失败、结果未知与离线沿用「写入」的提示与原 `requestId` 重试。
- **头像的状态**：只由 Host 已有的数据推出，来自这个 Agent 的会话（`TaskSummary.agent.customAgentId`）：等你处理 > 运行中 > 休息（摘要 `available: false`）> 最近一次未归档会话失败 > 空闲（`agentActivity`）。状态词始终写在旁边（运行中、等你处理、失败；休息时是「不可用」），头像只陪衬：运行中右下角闪烁的 `_`、眼睛看向它；等你处理眼睛抬起，右上角不时冒出琥珀色「?」；失败眼睛低下，右上角红色「!」；休息闭眼，飘出「z」；会话在页面打开时结束，笑眯眯一次。空闲时每隔几秒随机眨眼、看一眼或笑眯眯。32 px 起有全部动作与配件，20–31 px 只偶尔眨眼，16 px 不动。全页一个调度器（`avatarMotion.ts`）、一个计时器，只驱动视口内的头像，页面隐藏时停；同时笑眯眯或冒配件的不超过 3 个；只动 transform 与 opacity。减少动态效果或根元素 `data-motion="still"`（e2e 的 `stillMotion`，与固定时钟一起在 `visualContext` 里）时完全不动，配件静态显示。
- **定时**：这个 Agent 的定时任务（「通用」的是不指定 Agent 的那些），界面见 [AUTOMATIONS.md](AUTOMATIONS.md#界面)。
- **写入**：新建、修改（带打开表单时的 `baseRevision`，只发改了的字段）、删除与记忆都带 `requestId`；结果未知时保留原请求，「重试同一请求」原样重发，`agent-changed` 显示为已在别处修改并可载入最新。新话题的待确认请求单独存放，不占用新会话的草稿，重试同样沿用原 `requestId`；卡片写出最后一次重试的原因，「放弃这次提交」只在这台设备上放下它，文字回到输入框（Host 如果其实收到了，它会作为一个话题出现）。
- **数据范围**：没有完整数据范围的设备看到「这台设备看不到 Agent」，不显示空列表；Host 返回 `agent-scope-required` 时同样处理，`agent-write-unknown` 时显示正在确认并稍后重读。
- **iPhone/iPad**：标签栏同样是 Code / 我的 Agent / 应用 / 设置，判断在 `PhoneTabs`、`PhoneAgents`。手机只在正文窗口内拿到快照的 `customAgents` 与 `automations`，所以窗口外不显示任何 Agent 的名称、职责与定时，列表写「查看」（Face ID 关闭时自动打开）；离线保存的列表不含它们，窗口关闭时也从内存撤下，委托的会话在窗口外页头只写「委托」。Agent 页的「委托」经同一 `POST /tasks` 带 `customAgentId`，Harness 只列有 `agentContext` 的，所选的文件夹照网页一样作为 `workspaceId` 发送（起始文件夹 `default` 也发送，Host 用它代替 Agent 自己的项目）；成功后转到 Code 打开会话，会话页头写「为 <Agent> 委托」。「记忆」可以添加、修改、删除，写入与委托都占用手机唯一的待确认写入，结果未知时「重试同一请求」，`agent-changed` 显示「已在别处修改」。「定时」只读，列出计划与运行记录；「设置」只读；新建与修改 Agent 或定时任务写「尚未实现」，在网页或桌面端修改。头像用 SwiftUI 画同样的几何与动作（`AgentFace`，状态由 `PhoneAgents.face` 推出），列表 40、Agent 页 56，一个共享时钟只在头像显示、App 在前台时走；开启「减弱动态效果」时不动；标签栏的「我的 Agent」图标由 iOS 另行更新；手机上换头像的选择器尚未实现。
