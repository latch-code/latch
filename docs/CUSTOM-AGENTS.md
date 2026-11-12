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
  - apps/web/src/agents/AgentPage.tsx
  - apps/web/src/agents/AgentForm.tsx
  - apps/web/src/agents/Schedules.tsx
  - apps/web/src/agents/CarryResults.tsx
  - apps/web/src/agents/scheduleModel.ts
  - native/ios/Sources/LatchNativeCore/PhoneAgents.swift
  - native/ios/App/Agents/AgentsView.swift
---
# 我的 Agent

Agent 是用户使用的那个东西：名称、图标、说明、指令、技能、Harness、模型，再加记忆与默认项目。Harness（代码里仍叫 Harness）是运行它的程序，自带基础提示和工具。Agent 不替换 Harness，只往上加。

`catalog.features.customAgents` 声明下面的接口。这些路由与 `/link/api/agents` 无关：后者仍指 Harness 定义。

| 接口 | 作用 |
| --- | --- |
| `GET /custom-agents` | 「通用」、我的 Agent 摘要与可选插件 |
| `POST /custom-agents` | 新建；图标由 Host 分配 |
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

摘要里的 `available` 与 `unavailableReason` 说明现在能否开始会话，`canAutomate` 说明能否用于定时任务。

## 「通用」

「通用」是内置 Agent，没有自己的 Harness：选了它的会话用当次选择的 Harness 和模型。写给它的指令和记忆对没选别的 Agent 的会话生效，这些会话没有 `TaskSummary.agent`。

只有完整数据范围的设备发出的一轮才带上「通用」：模型的回复可能复述它，其他设备读得到的会话不能收到它。范围较小的设备照常工作，就像「通用」是空的。

一轮带上「通用」后，这个会话的 `TaskSummary.agentPrivate` 就为真，写入时机在模型收到之前，读取与继续都要完整数据范围，范围较小的设备从此看不到它，即使是它开始的。分叉一个私有会话得到的新会话同样私有，定时任务的每次运行也是。

`skills` 缺省时这些会话加载全部已启用的技能，与之前一样；写成数组（包括空数组）后就只加载这些；其中插件已停用或移除的技能不再加载，不影响会话开始。

## 会话

`POST /tasks` 接受 `customAgentId`。新会话的标题取第一条输入从第一行非 `>` 引用的文字起（内置与外部 Harness 相同，`promptTitle`），所以带入的成果不会成为标题；只有引用时取第一个「上次成果」的标题。请求里同时给的 `harnessId`、`mode`、`model`、`workspaceId` 只影响这次会话，没给的取 Agent 的默认值；`workspaceId: 'default'` 是 Host 的起始文件夹（开了 `sessionFolders` 时是会话自己的文件夹），没有默认项目的 Agent 与这一次不用默认项目的委托都这样发送。只有用的是 Agent 自己的默认项目而它已移除时，开始以 409 `agent-unavailable`「默认项目已移除」拒绝；这一次另选的项目不存在时与普通会话一样是 400 `workspace-unavailable`。一个请求的选择在第一次时写入回执，所以结果未知后的重试不会换到后来改过的 Harness。

会话开始后 Agent 与 Harness 不再变，归属记录在 `TaskSummary.agent`。Agent 的会话内容只对完整数据范围的设备开放。

## 各 Harness 如何收到

`HarnessInfo.agentContext` 与 `HarnessInfo.skills` 说明 Harness 的接收方式；两者都由 Driver 声明。没有 `agentContext` 的 Harness 不能运行 Agent。

**内置 Harness**（`private`、`native`）：每轮的系统提示依次是 Latch 的基础提示、指令和记忆、技能。指令和记忆只在这一轮的运行里，不进消息、历史、分叉或导出；每轮按当前定义重新读取。技能目前随会话整段加载，尚未实现按需读取。Agent 删除后，它在内置 Harness 上的会话不再接受输入，提示在新会话中继续。

**外部 Harness**（`first-turn`）：Harness 的提示和工具都保留。指令和记忆作为一个带标注的文本块，在第一个真正到达 Harness 的轮次排在用户输入之前发送，写出后记录在那条用户消息的 `agentBrief` 上；`segments` 分开 Latch 的说明和用户写的内容，换行连接后就是发送的字符。第一轮没有到达 Harness（进程没有起来、发送前取消）时，文本块留到下一轮，重启后也一样；写出后、记录落盘前崩溃时下一轮会再发一次，不会一次都没发。`Message.text` 不含它，分叉的背景文本也不带它；pi 用自己的记录分叉时（见 [HARNESSES.md](HARNESSES.md#pi-的-rpc-模式)），新会话里是 pi 收到过的原样记录，来源会话发过的文本块也在其中，新会话自己的文本块照常随它的第一轮发送。发送过之后的轮次不再发送，改动指令不影响已开始的会话；清空上下文后，同一个文本块随新上下文的第一轮再发送一次并记在那条消息上，因为 Harness 的新会话里没有它。设备开始完全访问会话时，启动审计（`task.l3.start-requested`）的 `promptHash` 同时覆盖这个文本块。

**外部 Harness 的技能**（`server`）：Host 把所选技能复制到会话自己的目录，并在 `session/new`、`resume`、`load` 时附加一个 stdio MCP 服务 `latch-skills`。它只有 `list_skills` 和 `read_skill` 两个工具，不写文件、不访问网络。删除会话时一并删除这份副本。服务的命令是 Host 自己 Node 程序的绝对路径，不带 `type`，环境变量为空，所以只接受命令为绝对路径的 stdio 服务的 Harness（DeepSeek Harness）也能启动它；`server/discover` 返回「方法不存在」，客户端退回 2025 版的 `initialize` 握手（假 Agent 的 `FAKE_ACP_MCP=dsh` 照此检查）。预设以 `skillServer: false` 声明不接受 MCP 的 Harness（目前是 pi），这些 Harness 没有 `HarnessInfo.skills`，技能不发送，界面据此提示。其余预设是否实际取用技能尚未逐一在真实 Agent 上验证。

`agentContext` 由 Host 构造，从不接受 HTTP 客户端传入。

## 界面

「我的 Agent」是侧栏里「Code」下面的第二个入口（手机是底部标签栏里的一个标签），只在 `catalog.features.customAgents` 存在时出现。宽窗口上，侧栏的位置换成「通用」与各个 Agent 的列表，工作面板是列表页或某个 Agent 的页面；手机上列表是根页，Agent 页推入在它之上。和设置一样，它盖在会话各栏上而不卸载会话。

- **列表**：「通用」在最前并标「内置」，其余按 Host 的顺序；每行是图标、名称、一行职责（说明，没有时是指令的第一行）、Harness · 模型、默认项目与 `available`/`unavailableReason`。主按钮是「委托<名称>…」，还没有自己的 Agent 时是「新建 Agent」。
- **Agent 页**：标签「委托 · 记忆 · 定时 · 设置」，「通用」没有「委托」。「委托」用会话的输入框经 `POST /tasks` 开始带 `customAgentId` 的会话，Agent 的 Harness、模型和默认项目预先选好，这一次可以换项目、文件夹（新工作树的起点按所选发送）、Harness 和模型（Harness 只列有 `agentContext` 的）；外部 Harness 的 `engineOptions` 尚未在开始时设置。下面的「近期委托」是 `TaskSummary.agent` 指向它的会话，打开的是普通对话，对话标题前写「为 <Agent> 委托」，点它回到 Agent 页；定时任务开始的会话（`automationId`）在这里和「带入上次成果」里带「定时」标记。输入框下方的「带入上次成果」选这个 Agent 之前的一个或多个委托，从每个读出最后一条回复（默认勾选）和它提到的文件，作为引用文字（从「> 上次成果「标题」：」起每行都是 `>` 引用，文件只写路径）插在已写的文字后面；它不建交接记录，也不接着原来的上下文。旁边的「新会话」提示说明这里总按 Agent 现在的定义开始新会话，要接着原来的对话就在近期委托里打开那个会话直接输入。手机上选择在底部面板里。
- **定时**：这个 Agent 的定时任务（「通用」的是不指定 Agent 的那些），界面见 [AUTOMATIONS.md](AUTOMATIONS.md#界面)。
- **写入**：新建、修改（带打开表单时的 `baseRevision`，只发改了的字段）、删除与记忆都带 `requestId`；结果未知时保留原请求，「重试同一请求」原样重发，`agent-changed` 显示为已在别处修改并可载入最新。委托的待确认请求单独存放，不占用新会话的草稿，重试同样沿用原 `requestId`。
- **数据范围**：没有完整数据范围的设备看到「这台设备看不到 Agent」，不显示空列表；Host 返回 `agent-scope-required` 时同样处理，`agent-write-unknown` 时显示正在确认并稍后重读。
- **iPhone/iPad**：标签栏同样是 Code / 我的 Agent / 应用 / 设置，判断在 `PhoneTabs`、`PhoneAgents`。手机只在正文窗口内拿到快照的 `customAgents` 与 `automations`，所以窗口外不显示任何 Agent 的名称、职责与定时，列表写「查看」（Face ID 关闭时自动打开）；离线保存的列表不含它们，窗口关闭时也从内存撤下，委托的会话在窗口外页头只写「委托」。Agent 页的「委托」经同一 `POST /tasks` 带 `customAgentId`，Harness 只列有 `agentContext` 的，默认文件夹不作为 `workspaceId` 发送；成功后转到 Code 打开会话，会话页头写「为 <Agent> 委托」。「记忆」可以添加、修改、删除，写入与委托都占用手机唯一的待确认写入，结果未知时「重试同一请求」，`agent-changed` 显示「已在别处修改」。「定时」只读，列出计划与运行记录；「设置」只读；新建与修改 Agent 或定时任务写「尚未实现」，在网页或桌面端修改。
