---
description: 我的 Agent 与「通用」：定义、记忆、会话归属、各 Harness 如何收到指令、记忆和技能。
sources:
  - apps/host/src/custom-agents.ts
  - apps/host/src/agent-plans.ts
  - apps/host/src/agent-journal.ts
  - apps/host/src/agent-activity.ts
  - apps/host/src/computer.ts
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
  - apps/web/src/core/agentCreation.ts
  - apps/web/src/core/deviceStorageScope.ts
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
  - apps/web/src/agents/proposals.ts
  - apps/web/src/agents/ProposalRow.tsx
  - apps/web/src/agents/TopicProposals.tsx
  - apps/web/src/agents/ScheduleProposalRow.tsx
  - apps/web/src/agents/ResultCard.tsx
  - apps/web/src/agents/TopicResults.tsx
  - apps/web/src/agents/Activity.tsx
  - apps/web/src/agents/activity.ts
  - apps/web/src/agents/usePaged.ts
  - apps/web/src/agents/AgentForm.tsx
  - apps/web/src/agents/HelperCreate.tsx
  - apps/web/src/agents/helpers.ts
  - apps/web/src/agents/personWords.ts
  - packages/protocol/src/agent-presets.ts
  - apps/web/src/agents/Schedules.tsx
  - apps/web/src/agents/CarryResults.tsx
  - apps/web/src/agents/scheduleModel.ts
  - apps/web/src/agents/Computer.tsx
  - apps/web/src/agents/computer.ts
  - apps/web/src/agents/roleTemplates.ts
  - native/ios/Sources/LatchNativeCore/PhoneAgents.swift
  - native/ios/App/Agents/AgentsView.swift
  - native/ios/Sources/LatchNativeCore/PhoneAgentChat.swift
  - native/ios/App/Agents/AgentChat.swift
  - native/ios/App/Agents/AgentProfile.swift
  - native/ios/Sources/LatchNativeCore/PhoneAgentComputer.swift
  - native/ios/App/Agents/AgentComputer.swift
  - native/ios/Sources/LatchNativeCore/PhoneAgentActivity.swift
  - native/ios/App/Agents/AgentActivity.swift
---
# 我的 Agent

Agent 是用户使用的那个东西：名称、头像、说明、指令、技能、Harness、模型，再加记忆与默认项目。Harness（代码里仍叫 Harness）是运行它的程序，自带基础提示和工具。Agent 不替换 Harness，只往上加。

`catalog.features.customAgents` 声明下面的接口。这些路由与 `/link/api/agents` 无关：后者仍指 Harness 定义。

| 接口 | 作用 |
| --- | --- |
| `GET /custom-agents` | 「通用」、我的 Agent 摘要与可选插件 |
| `POST /custom-agents` | 新建；`avatar` 是创建时选的脸，缺省由 Host 分配 |
| `GET`、`PATCH`、`DELETE /custom-agents/:id` | 详情（含指令、记忆、会话）、按 `baseRevision` 修改、删除；可选字段传 `null` 清除 |
| `GET`、`POST /custom-agents/:id/memories`，`PATCH`、`DELETE …/:mid` | 记忆，只有用户能写，只有这个 Agent 能用 |
| `POST`、`DELETE /custom-agents/:id/memories/:mid/undo` | 撤销这条记忆最近一次的修改或删除；清除已删除记忆留着的文字 |
| `GET /custom-agents/:id/proposals`，`POST …/proposals/:pid/save`、`…/dismiss` | 记忆提议：列出、保存为记忆、不要 |
| `GET`、`PATCH /custom-agents/general` | 「通用」，不能删除；记忆路由同样可用 |
| `GET /custom-agents/:id/results` | 还没有话题时等着的定时结果卡（见 [AUTOMATIONS.md](AUTOMATIONS.md#结果回到对话)） |
| `GET /custom-agents/:id/activity?before=` | 动态，按时间倒序分页（每页 30 条） |
| `GET /custom-agents/:id/library?before=` | 资料库，按会话倒序分页（每页最多 8 组） |
| `GET /custom-agents/:id/computer` | 「电脑」：Host 记下的这台电脑（`computer`）与这个 Agent 的定时错过的时间（`missed`） |

快照的 `customAgents` 只有摘要（不含指令、技能和工具的内容）。写操作都带 `requestId`，重试按回执回答；结果未知时拒绝其他修改和读取，Host 每秒自己重试写入，也可以重试同一请求；这期间快照没有 `customAgents` 和 `automations`，其余照常。定义在 `agents/custom.json`。

## 创建的待确认请求

网页创建继续使用 `useAgentWrites` 与同一个 `POST /custom-agents`。发送前，`AgentCreation` 按来源与设备保存原请求编号和完整请求；无法保存时不发送。正常请求在切换入口、刷新后仍可原样重试，Host 按自己的回执回答。多个窗口由浏览器 Web Locks 串行准备与核对，另一窗口不能用新请求覆盖尚未确认的创建；缺少这种协调能力时明确拒绝发送。

创建内容都是私有数据，只在设备仍有完整数据范围、查看和运行权限时保留。像凭据的正文只放内存，磁盘只留不含正文的待确认标记；刷新后的页面不能补造请求，显示结果未知，允许明确「放弃这次创建的等待」。放弃只清理此设备保存的记录，不撤销 Host 可能已完成的创建。不可读的记录同样不能自动当作未发送。取消、返回或切换入口不会默默放下未知请求。

退出、换设备和撤权沿用草稿清理入口；创建、会话草稿与 Slash 最近项共用设备归属标记，旧句柄与迟到响应不能恢复已清理内容或覆盖新设备的请求。核对不从列表中的同名 Agent 推断成功；敏感正文丢失后的自动回执查询尚未实现。

放弃绑定打开确认框时看见的那条记录，取得跨窗口锁后仍须是同一条，不能清掉另一个窗口后来开始的创建；损坏记录也按其原始内容区分。存储暂时无法读取时继续显示未知，并暂停重试、放弃和新建，直到能重新读到记录，不能把读取失败当作不存在。

创建第二步的「换」只返回候选步骤，保留名字、职责、指令和头像；重新选择同一 Harness 保留模型，改选另一 Harness 回到它的默认模型。未按「创建」时取消不会写入 Host。

## 字段

- `harnessId`：运行它的 Harness，创建时定下，之后不变：`PATCH` 带另一个 Harness 得 409 `agent-harness-fixed`（「Agent 建好后不能换 Harness，要用别的 Harness 就新建一个 Agent。」），带它自己的照常；拒绝在写入与审计之前，同一 `requestId` 的重试先按回执回答。这不需要新标志：`harnessId` 本来就在定义里，只是不再接受别的值。想换 Harness 就新建一个 Agent。`mode`：Harness 有多种模式时的默认值。
- `model`：Host 模型服务的模型（含已声明的 `effort`）；内置 Harness 直接使用，外部 Harness 经 Host 核对可用的模型网关路线后使用。
- `engineOptions`：外部 Harness 自己的默认项（模型、思考、权限），`configId` 到值。Host 把本次选择写入启动回执，经原有 `startConfig` 路径在第一条提示之前设置并读回：模型先于依赖它的思考，权限最后核对。权限读回不符时不发提示并锁住后续输入；同一 `requestId` 重试不采用后来修改的默认值。带 `customAgentId` 的开始请求不接受客户端另传 `config`。内置 Harness 的思考存于 `model.effort`，只用模型服务实际声明的档位。
- `instructions`：指令。`skills`：`catalog.skills` 里的 `pluginId:skillId`。
- `tools`：「可以使用」，只对内置 Harness 生效，是可调用工具的插件 ID；缺省时不额外限制。它只收紧，不授予新能力。
- `defaultProjectId`：新话题的默认项目；这次显式选择的项目优先，没有项目时使用家。定时任务单独选择工作位置，缺省为家。
- `home`：Host 写入的相对目录 `helpers/<Agent ID>`（通用为 `helpers/general`），创建与修改请求的 strict schema 不接受此字段。
- `avatar`：头像，`{ kind: 'face', bracket, eyes, hue }`，括号 `round`、`curly`、`square`、`angle`，眼睛 `dot`、`arc`、`oval`、`sleepy`，颜色 `ink`、`slate`、`pine`、`plum`、`wisteria`、`cocoa`、`sand`、`moss`、`mist`（`AGENT_BRACKETS`、`AGENT_EYES`、`AGENT_HUES`）。新建时 Host 分配一个还没用过的括号 × 颜色组合，眼睛用圆点；`PATCH` 带 `avatar` 修改，和其他字段一样经 `baseRevision`、`requestId`、先审计再写和回执，审计 detail 只有哈希。未知的字段与取值都拒绝。头像不进 `definitionHash`，会话收不到它。只有 `definitionHash` 变了的修改才把这个 Agent 的定时任务重新绑定到修改的设备（读不到时照旧重新绑定）；改名称、说明或头像既不移动也不暂停定时任务，但新名称会出现在之后运行的第一轮文本块里，因为它写着 Agent 的名称。`kind` 为以后上传图片留位，尚未实现。

- `notifications`：`{ completed, failed, waiting }`，这个 Agent 的话题与定时运行完成、失败、需要你处理时桌面端是否通知；缺省时全部开启（与之前相同），`PATCH` 传 `null` 回到缺省。`keepAwakeForSchedules`：「到点前后保持唤醒」，缺省为关，只存为 `true`。两者都只经 `PATCH`（`baseRevision`、`requestId`、先审计再写、strict schema），不进 `definitionHash`，所以不移动也不暂停定时任务。

摘要里的 `available` 与 `unavailableReason` 说明现在能否开始会话，`canAutomate` 说明能否开启后台定时；它为假不等于不能手动运行保存的任务，见 [AUTOMATIONS](AUTOMATIONS.md#谁可以开启)。

## 记忆提议

Agent 会学，但从不静默保存。记忆只有两种来源：人在资料面板里写的，和人保存的提议。没有「自动接受」。

- **来源**：（a）人在某个 Agent 或「通用」的对话里发的消息以「记住」「记住：」「请记住」或 `remember` 开头时，Host 用去掉这几个字之后的文字建一条提议（`origin: 'user'`），消息照常发给 Harness；Code 里的会话没有这一步。排队的消息在真正从队列发出时才建提议，撤回的不建。（b）Agent 调用 `propose_memory(content, reason?)`（`origin: 'agent'`）。
- **哪些会话有 `propose_memory`**：只有这个 Agent 的会话和「和通用的对话」，由 Host 在执行上下文里写 `proposals`（`AgentExecutionContext`，从不接受客户端传入）。内置 Harness（`private`）由运行循环自己提供这个工具，同名的插件工具在这些会话里被它替换，不经分级、不需要批准，因为它只交给 Host 一条待确认的提议。它也是「只对话」运行唯一能调用的工具：这样的运行仍然叫只对话，不读写文件、不运行命令，其他工具照旧拒绝。外部 Harness 经技能服务（见下）提供。pi 不接受 MCP 服务，Agent 提议在 pi 上尚未实现，「记住…」照样可用。
- **存放**：在 `agents/custom.json` 的 `proposals`（按 Agent 或 `general`），strict schema；每条有 ID、文字、理由、来源（会话、那一轮的用户消息或请求）、`origin`、`external`、状态（`pending`、`saved`、`dismissed`）、时间与保存后的记忆 ID。每个 Agent 最多 64 条：放不下时先丢最早的「不要了」，再丢最早的已保存；全是待处理时拒绝新提议（409 `agent-proposal-limit`）。每个 Agent 的提议合计不超过 256 KB，其中 Agent 提出的最多占一半：超出时先丢它自己最早的已处理提议，仍超出就拒绝；Agent 的待处理提议最多 32 条，满了时它的新提议被拒绝，工具用英文告诉它。所以 Agent 从不挤掉人的「记住…」，人总有另一半的地方；一个会话最多提议 32 次（内置与外部 Harness 相同）。同一个来源（一行、一次调用或人的一次请求）只建一条，重读或重试不重复。Agent 删除时一并删除。
- **拒绝**：文字或理由像密钥（`redactSecrets` 会改动它，或 `containsSecret` 认出它）时拒绝（422 `agent-memory-secret`「内容像是密钥或凭据，没有记下。」），超过 4000 字（理由 500 字）时拒绝，含不可见或控制字符（换行除外）时 400 `agent-memory-invalid`，都在审计之前、不存任何东西。Agent 的工具结果写明原因；人的「记住…」被拒绝时消息照常发出，回答里带 `memoryRefused`，页面用提示条说出原因；会话详情的 `memoryRefusals`（按请求，只有原因，只在内存里）让那一轮下面写「没有记下」与原因，从队列发出的消息也是这样。
- **保存与不要**：带 `requestId`，经与添加记忆相同的回执、先审计再写（`agent.changed`，`kind: 'memory'`、`via: 'proposal'`）；保存在同一次写入里建记忆并把提议标为已保存，记忆带 `source`（提议 ID、`origin`、`external`、会话与消息、提议时间）。重试同一请求只按回执回答（`proposalId`、`memoryId`，提议与记忆还在时一并给出），提议已为腾地方被丢掉也一样；已处理的提议再保存或不要是 409 `agent-proposal-decided`。只有能写记忆的设备（`run` 与完整数据范围）能保存或不要。
- **审计**：建提议记 `agent.memory.proposed`（`origin`、`external`、`customAgentId`），不要记 `agent.changed`（`kind: 'proposal'`）；detail 里只有枚举与 ID，从没有文字。
- **外部内容**（`external`）：从会话的上下文上次重新开始（清空上下文）以来，运行过可能读到外部内容的工具；上下文里一直留着读到的东西，所以之后每一轮的提议都标外部。内置 Harness：Host 分级为 R2 的调用（任何插件的工具、会话文件夹以外的文件），记在会话上；之后的只对话运行没有工具，但继承这个标记，这是有意的，因为上下文里还留着读到的东西。外部 Harness 只能看 Agent 自报的工具行，所以从宽判定：`fetch`、`search`、`execute`、`think`、`other` 或没有 `kind` 的调用、子 Agent，以及没有 `locations` 或位置在项目文件夹之外的读写，都算外部；技能服务自己的三个工具不算：只看没有特定种类（`other`）的工具行的名称字段（Agent 不给名称时是标题），去掉服务前缀（如 `mcp__latch-skills__`）后确切相等才算，标题里只是提到这个名字的不算。位置先解析 `..` 与符号链接再判断是否在项目文件夹内。驱动只能把提议交给 Host 在它自己的会话里；插件 Harness 说的 `external: false` 不被采信。人的「记住…」从不标外部；只对话的运行没有其他工具，它的提议不标外部。后台定时的执行上下文带 `unattended`。Host 另按会话的 `automationId` 保守地把所有保存任务的运行提议标为外部，包括手动「立即运行」和人在其中继续的轮次；这只标记来源，不自动保存或拒绝提议。
- **何时生效**：内置 Harness 每轮重新读取记忆，保存后就生效；外部 Harness 只在话题的第一轮收到记忆，保存后从下一个话题起才收到。界面只这样写，不声称别的。
- **撤销**：每条记忆保留最近一次修改或删除（`changes`，每个 Agent 最多 64 条，strict schema），「撤销」（`POST …/undo`，带 `requestId` 与人看到的 `baseRevision`，不符时 409 `agent-changed`，审计 `via: 'undo'`）把它恢复为之前的文字或重新加回，用过即消失。删除的文字只留 7 天（`MEMORY_UNDO_DAYS`）：Host 启动时、每天一次和每次写入时删去过期的，「清除」（`DELETE …/undo`，不能撤销，页面先确认）立即删去；这条记忆若是从提议保存的，那条提议的文字也同时清空，只留 ID 与状态，`GET …/proposals` 不再列出它。话题本身的对话记录（人的原话、工具调用）不受影响，随会话保留或删除。修改一条从提议保存的记忆后，来源保留，另记 `edited: true`，资料面板在来源后写「已修改」；撤销修改时文字与这个标记一起恢复。
- **快照**：完整数据范围的设备（手机只在正文窗口内）收到 `agentProposals`：每个 Agent 待处理的数量和最近一次变化的时间，不含文字；页面据此重新读取提议。其他设备不知道有提议。

### 定时提议

Agent 也能提议定时任务：`propose_schedule(name, plan, prompt)`，与 `propose_memory` 走同样的路径（内置 Harness 的运行循环，外部 Harness 的技能服务与 `proposals.jsonl`），交给同一个 Host 存储（`proposals` 里 `kind: 'schedule'`，`schedule: { name, plan }`，`content` 是每次运行的输入，最多 4000 字）。会话的 32 次上限、Agent 待处理的 32 条与一半空间、密钥检查、外部内容标记、驱动只交自己会话的、审计（`agent.memory.proposed`，只有枚举与 ID，`kind` 写 `memory` 或 `schedule`）都与记忆提议相同，两种提议合算。每次的输入里连续的空行合为一个。`plan` 按定时任务自己的 schema（`schedule.ts` 的 `scheduleSchema`）检查，不符时用英文拒绝给 Agent（400 `agent-schedule-invalid`）；技能服务在写入文件之前就按同样的形状拒绝，Host 读到时再查一次。人的「记住…」不建定时提议。

定时提议从不创建或运行任何东西。对话里它是一行「想定时：<名称> · <每天 20:00>」，「打开」进入资料面板的定时编辑，表单按提议预填（名称、重复、时间、每次的输入；工作位置预选家，也可明确改成一个项目；输入框上方写「它写的」，外部内容时加琥珀色「来自外部内容」，输入框按行数长高到一屏，整段可读），人在那里保存：`POST /automations` 带 `proposalId`，Host 先核对它是这个 Agent 的、还没有处理过的定时提议，再按定时任务自己的回执创建（可后台执行时保存并开启，否则带 `enabled:false` 保存为关闭，只供人点「立即运行」）；定时任务的记录记下 `proposalId`，创建时在同一次写入里拒绝已经由它保存过的（409 `agent-proposal-decided`），所以同时的两次保存只建一个。然后把提议标为已保存并记下 `automationId`（`agent.changed`，`kind: 'proposal'`，`operation: 'update'`）；这一步失败时，同一请求的重试按两边的回执回答并补上标记，之后另一个请求的保存被拒绝，同时用第一个定时任务补上标记。「不要」与记忆提议相同。它不能当记忆保存（409 `agent-proposal-kind`），资料面板的「记忆」也不列它。

### 外部 Harness 的通道

技能服务以 `propose` 参数启动时多两个写工具 `propose_memory` 与 `propose_schedule`，其余照旧只读、不联网；`propose_schedule` 写的行是 `{ kind: 'schedule', name, plan, prompt }`，驱动交给 `HarnessHostOptions.proposeSchedule`，Host 照样只取这几个字段，`plan` 再按 schema 检查。每次调用在会话自己的私有目录（0700）里的 `proposals.jsonl`（会话存在期间保留文字；每次会话的服务启动之前，若 Host 已取走全部完整的行就清空它，取走的行数仍计入上限；删除会话时一并删除）（0600，`O_NOFOLLOW`、`O_NONBLOCK`，只接受只有一个链接的普通文件）追加一行 `{ content, reason? }`；每行不超过 8 KB，每个会话最多 32 行、128 KB，超出时工具返回错误。ACP 驱动在每个工具调用结束和每轮结束时，按 Host 读私有记录的方式（不跟随链接、不读 FIFO、只读打开时的大小、固定大小的缓冲）从上次的偏移读新增的完整行（行数与按字节计的偏移持久化在会话记录的 `proposalsRead`、`proposalsOffset`），逐行交给 Host（`HarnessHostOptions.proposeMemory`）。行里只取 `content` 与 `reason`，经 zod 和密钥检查；会话来自目录本身，归属由 Host 从自己的会话记录（`TaskSummary.agent` 或 `generalChat`）查出，从不取自文件；Host 只收下这个驱动自己的、开始时上下文带 `proposals` 的会话（记在会话元数据 `proposals`）的提议。无效的行跳过并在 Host 日志里只记种类（`not-json`、`invalid`），被拒绝的行照样算读过，驱动只记下 Host 的原因。

## 「通用」

「通用」的新话题固定使用 Standard 的 Agent 模式和 Host 模型服务，在 `helpers/general` 工作；已有话题保留原 Harness、模式与目录。写给它的指令和记忆对没选别的 Agent 的会话生效，这些会话没有 `TaskSummary.agent`。

只有完整数据范围的设备发出的一轮才带上「通用」：模型的回复可能复述它，其他设备读得到的会话不能收到它。范围较小的设备照常工作，就像「通用」是空的。

一轮带上「通用」后，这个会话的 `TaskSummary.agentPrivate` 就为真，写入时机在模型收到之前，读取与继续都要完整数据范围，范围较小的设备从此看不到它，即使是它开始的。分叉一个私有会话得到的新会话同样私有，定时任务的每次运行也是。

`skills` 缺省时这些会话加载全部已启用的技能，与之前一样；写成数组（包括空数组）后就只加载这些；其中插件已停用或移除的技能不再加载，不影响会话开始。

## 会话

`POST /tasks` 接受 `customAgentId`。新会话的标题取第一条输入从第一行非 `>` 引用的文字起（内置与外部 Harness 相同，`promptTitle`），所以带入的成果不会成为标题；只有引用时取第一个「上次成果」的标题。请求里的 `harnessId` 只能是 Agent 自己的，别的得 400 `agent-harness-fixed`，什么也不开始（在第一次选定时核对，所以已记下的开始的重试照旧按回执回答）；同时给的 `mode`、`model`、`workspaceId` 只影响这次会话，没给的取 Agent 的默认值；Agent 的 `workspaceId: 'default'` 由 Host 映射为它的家，实际 cwd 与 `sessionFolder` 由分配器持有，不把私有家登记进公共项目目录；普通 Code 的同名值仍使用原起始文件夹或会话自己的文件夹，没有默认项目的 Agent 与这一次不用默认项目的委托都这样发送。只有用的是 Agent 自己的默认项目而它已移除时，开始以 409 `agent-unavailable`「默认项目已移除」拒绝；这一次另选的项目不存在时与普通会话一样是 400 `workspace-unavailable`。一个请求的选择在第一次时写入回执，所以结果未知后的重试不会换到后来改过的 Harness。

会话开始后 Agent 与 Harness 不再变，归属记录在 `TaskSummary.agent`。Agent 的会话内容只对完整数据范围的设备开放。

**和「通用」对话**：`customAgentId: 'general'` 开始的会话不指定 Agent，「通用」照常生效（与其他没选 Agent 的会话一样）；Host 只在会话元数据里记下 `generalChat`（`session-meta.ts` 的 schema），摘要里是 `TaskSummary.generalChat: true`，执行端声称的同名字段被丢弃，不进审计。这个标记本身就让会话私有（与 Agent 的会话一样，`agentPrivate` 为真，范围较小的设备读不到、列不出，事件流里也没有它的内容），不论「通用」当时是否为空、Harness 是否接收「通用」；开始时与开始前的复查都要求完整数据范围。客户端据此把它放进我的 Agent 而不是 Code。它要求完整数据范围（否则 403 `agent-scope-required`），不带项目、工作树或分叉（否则 400 `general-chat-project`）；新话题固定用 Standard Agent，目录只由 Host 分配；旧参数的拒绝与未知结果保留见下文。

旧版「通用」的开始请求若显式指定外部 Harness 或 `mode:chat`，当时没有 Host 选择回执，不能通过新的 Standard Agent/家路径安全重放。Host 在绑定 Harness、分配家或新建会话前返回 `503 general-start-unconfirmed`；客户端保留原 `requestId` 和结果未知记录，允许重试、查看已有话题或由人明确放弃。不会用新的模式/cwd 试发来猜测旧结果，也不把 400/409 拒绝当成旧请求没有执行；已有话题照旧继续。

## 家与工具

`SessionFolders.helperHome` 在起始目录下惰性创建 `helpers/<Agent ID>`，显式指定 `--workspace` 时也如此。父目录与家精确设为 0700，不接管已存在的未知目录，不跟随链接；根目录、父目录与家的设备号和 inode 随根目录哈希存入 0600 `session-folders.json` 的 strict schema。恢复时仍核对这些身份，改路径、替换同名目录或与数据、程序、已登记项目重叠都拒绝；不移动、覆盖或删除原文件。已经分配的家不能再登记为公共项目。它只是默认工作位置，不是 OS 隔离，外部 Agent 仍是可信本机程序。

多个话题与没有显式项目的定时运行共用一个家；旧话题保留冻结的 cwd。`home` 只由分配器写入 `agents/custom.json`，先审计哈希再发布，不改变名称或指令的 revision。`GET /custom-agents/:id/home` 只读当前身份与策略，返回路径、可用性和原因；未创建时不因读取而建目录。它与 Agent 详情一样要求完整数据范围，文件内容仍只经所属私有会话的授权句柄读取。

资料 › 设置显示「家」，路径与“默认文件夹，不是隔离”的说明放在 ⓘ 里。执行端桌面应用的「在访达中显示」只向主进程交 Agent ID；主进程凭自己的设备身份读取上述只读接口，再核对真实目录并调用 `showItemInFolder`，不接受页面路径，也不新增确认动作。删除 Agent 的确认说明保留文件夹，删除本身从不删除家。

Agent 模式的话题使用原有工具、审批与浏览器分级。Standard 可以读写家、提问与提议记忆/定时，远程 MCP 仍是 R2；外部 Harness 在接受 MCP 时同时获得 `latch-skills` 与 `latch-browser`，私有上下文本身不再排除浏览器。每次浏览器调用仍核对原目录、归档、活动轮次、取消与原风险规则；只允许执行端本机地址，外部网站尚未实现。pi 的 RPC 不接收 MCP，因此这些 MCP 服务仍不会发送给它，权限按它实际报告的档位展示。

桌面、平板与手机只挂载一个 `AgentProfile`。`ProfileLayer` 持有稳定的 portal 容器，宽度改变时把同一容器移到桌面槽或原有 `Sheet`，不切换 React portal 的目标、不复制表单与待确认写入。空槽没有可读内容，始终只有一个资料 region；移动后恢复仍可见、非 inert 且在活动面板中的原焦点。跨断点关闭 Sheet 的回调不关闭资料；真正关闭仍由原层叠管理恢复触发器焦点。切换设备、撤权或关闭资料会卸载私有实例。

## 各 Harness 如何收到

`HarnessInfo.agentContext` 与 `HarnessInfo.skills` 说明 Harness 的接收方式；两者都由 Driver 声明。没有 `agentContext` 的 Harness 不能运行 Agent。

**内置 Harness**（`private`、`native`）：每轮的系统提示依次是 Latch 的基础提示、指令和记忆、技能。指令和记忆只在这一轮的运行里，不进消息、历史、分叉或导出；每轮按当前定义重新读取。技能目前随会话整段加载，尚未实现按需读取。Agent 删除后，它在内置 Harness 上的会话不再接受输入，提示在新会话中继续。

**外部 Harness**（`first-turn`）：Harness 的提示和工具都保留。指令和记忆作为一个带标注的文本块，在第一个真正到达 Harness 的轮次排在用户输入之前发送，写出后记录在那条用户消息的 `agentBrief` 上；`segments` 分开 Latch 的说明和用户写的内容，换行连接后就是发送的字符。第一轮没有到达 Harness（进程没有起来、发送前取消）时，文本块留到下一轮，重启后也一样；写出后、记录落盘前崩溃时下一轮会再发一次，不会一次都没发。`Message.text` 不含它，分叉的背景文本也不带它；pi 用自己的记录分叉时（见 [HARNESSES.md](HARNESSES.md#pi-的-rpc-模式)），新会话里是 pi 收到过的原样记录，来源会话发过的文本块也在其中，新会话自己的文本块照常随它的第一轮发送。发送过之后的轮次不再发送，改动指令不影响已开始的会话；清空上下文后，同一个文本块随新上下文的第一轮再发送一次并记在那条消息上，因为 Harness 的新会话里没有它。设备开始完全访问会话时，启动审计（`task.l3.start-requested`）的 `promptHash` 同时覆盖这个文本块。

**外部 Harness 的技能**（`server`）：Host 把所选技能复制到会话自己的目录，并在 `session/new`、`resume`、`load` 时附加一个 stdio MCP 服务 `latch-skills`。它有 `list_skills` 和 `read_skill` 两个只读工具；这个 Agent 的会话和「和通用的对话」另有一个写工具 `propose_memory`，只往同一目录的 `proposals.jsonl` 追加提议（见「记忆提议」），此外不写文件、不访问网络。没有技能的 Agent 会话也为了 `propose_memory` 附加它。删除会话时一并删除这个目录。服务的命令是 Host 自己 Node 程序的绝对路径，不带 `type`，环境变量为空，所以只接受命令为绝对路径的 stdio 服务的 Harness（DeepSeek Harness）也能启动它；`server/discover` 返回「方法不存在」，客户端退回 2025 版的 `initialize` 握手（假 Agent 的 `FAKE_ACP_MCP=dsh` 照此检查）。预设以 `skillServer: false` 声明不接受 MCP 的 Harness（目前是 pi），这些 Harness 没有 `HarnessInfo.skills`，技能不发送，界面据此提示。其余预设是否实际取用技能尚未逐一在真实 Agent 上验证。

`agentContext` 由 Host 构造，从不接受 HTTP 客户端传入。

## 界面

工作台可在总览与分拣台之间切换（见 DESIGN.md）。从 Agent 话题打开总览时，覆盖层属于 Code，新建动作也按 Code 处理；下面的话题与草稿保留，返回后仍属于我的 Agent。分拣台中的我的 Agent 继续使用「新对话…」选择 Agent，布局选择不改变话题的执行方式。

网页与桌面的帮手话题只在页头保留一处权限/不隔离说明，时间线不重复首启提示。新话题、已有话题与重开都可展开查看；「权限没确认」或「不先问你」的说明同样保留能读写本机文件、运行命令和权限由 Agent 自己设置的事实。没有帮手页头的兼容界面与 Code 会话保留原首启提示，Host 的 firstStart 记录不变。

网页与桌面端分成两个大空间：Code 与我的 Agent，只在 `catalog.features.customAgents` 存在时分开（没有时只有 Code，和以前一样）。宽窗口的侧栏最上方（电脑菜单与电脑名之下）是整宽的两段开关「Code | 我的 Agent」（`SpaceSwitch`，[SpaceNav.tsx](../apps/web/src/shell/SpaceNav.tsx)），它切换空间而不是筛选：主操作、列表与主区的首页一起换掉，底部的「应用」与「设置」两边共用。手机仍是底部标签栏里的一个标签。

- **会话属于哪边**：只看 `TaskSummary.agent` 与 `TaskSummary.generalChat`：某个 Agent 的会话与在我的 Agent 里和「通用」的对话只在我的 Agent，其余（包括在 Code 开始、带上「通用」的会话）在 Code。过滤在共享的会话列表模型里（[sessions.ts](../apps/web/src/sessions.ts) 的 `spaceOf`、`inSpace`，`filterSessions`、`listedSessions` 与 `waitingCount` 的空间参数），组件不各写一份；Host 没有我的 Agent 时不传空间，所有会话都在 Code。
- **当前空间**（[spaces.ts](../apps/web/src/shell/spaces.ts)）：我的 Agent 的页面在我的 Agent；打开的会话决定它所在的一边（打开一个话题就切到我的 Agent，开关跟着变）；新会话页是 Code 的首页；应用、设置与 Host 还没列出的会话停在上次的一边。每台设备记住上次所在的空间（本地存储 `latch.space.<来源>.<设备>`，从不发给 Host），宽窗口冷启动时回到那里。切过去时回到离开那边时打开的会话或我的 Agent 页面（会话已归档或不再属于那边时回到首页）。
- **主操作**：Code 是「新会话」；我的 Agent 是「新对话…」，同一个键（⌘N，浏览器 Alt N），打开 Agent 的选择菜单（「通用」在最前，不可用的 Agent 带原因、不能选，最后一项「新建 Agent」），选中后进入它的新话题，输入框拿到焦点。「搜索」两边相同。
- **侧栏列表**：Code 与以前一样按「等你处理 / 各项目 / 无项目 / 已归档」分组，没有我的 Agent 的会话。我的 Agent 是「我的 Agent」小标题（点它回到列表页）、「通用」（标「内置」）、各 Agent 一行（24 头像、名称、状态词：它在做什么（见「状态词」）、等你点头、失败、不可用；点一下打开它的当前话题），「新建 Agent」，然后「最近对话」：等你处理的话题（归档了的也算，和 Code 的「等你处理」一样）排在最前，其余未归档的按时间倒序，最多 6 条（等你处理的从不被截掉），每行是标题、所属 Agent（「通用」的写「通用」）与时间或运行状态（与 Code 的行同一套词），多于 6 条时「全部 N」原地展开；最后是安静的「已归档 N」，和 Code 的一样，点开后是归档的话题与回去的一行。每个话题只在其中一处。Agent 已删除的话题照样列出，Agent 处写「已删除的 Agent」（摘要暂缺时写「Agent」）。正在对话的 Agent 与打开的话题是选中行。没有完整数据范围时列表处是「这台设备看不到 Agent」；摘要因写入结果未知暂缺时写「正在确认上一项修改」。
- **等你处理**：另一边有等你处理的会话时，那一段名称后面隔开一点是一个琥珀点（不写数字，读屏从提示里读到原因）。每边只算自己的列表能显示的会话，所以点总有一行可指；Host 列不出的审批会话只算进总数（Dock 与标题行的「等你处理」），不算进哪一边。手机的「Code」与「我的 Agent」标签各自只算自己那边。应用页与设置这类两边共用的页面上开关两段都不选中，点哪段就回到哪边。
- **键盘与菜单**：⇧⌘1 到 Code、⇧⌘2 到我的 Agent（桌面端与浏览器相同，浏览器写作 Mod Shift 1/2），在页面上也有效，切过去后焦点落在那边的主操作上（看不到时落在那一段）；⌘1…⌘9 与上一个、下一个会话走当前空间画出的行（我的 Agent 里是「最近对话」，展开「全部」或在「已归档」里时跟着变）。设置 › 快捷键与 ⌘/ 只在有我的 Agent 时列出这两项，⌘N 只在这台设备能开始对话（能运行会话、完整数据范围）时写作「新会话 · 新对话」。桌面端「显示」菜单里有同名的「Code」「我的 Agent」，作用于有焦点的窗口：页面订阅时经 `latch:space:ready` 告诉主进程它有两个空间（只在 Host 有我的 Agent 时订阅），主进程只为这样的窗口启用这两项，页面导航后重新判断；选中时主进程只把空间名经 `latch:space` 发给页面，preload 只放行这两个值。
- **侧栏收起**：标题行的左端在 ◧ 之后是两个图标按钮（Code、我的 Agent，当前的一个是按下状态，另一边有等你处理时带琥珀点），再是当前空间的主操作（新会话或新对话…）。平板的抽屉里同样是开关加列表；我的 Agent 的页面在平板上保留 200px 的行内列表。
- **页头**：我的 Agent 的话题（和新话题）的页头是这个 Agent 的对话外框（`AgentFrame`）：左边是头像（24，手机 28）、名称与状态词，点它们打开资料面板；右边是「话题 ▾」，再是会话自己的面板开关与 ⋯（重命名、归档等都在 ⋯ 里）。「话题」列出这个 Agent 的会话：第一项「新话题」，然后未归档的按时间倒序（标题、时间与状态，打开的一个打勾），最后是「已归档」。手机的页头是返回、外框（名称下写话题标题）、话题、面板与 ⋯；手机的「我的 Agent」标签在 Agent 列表下面同样有「最近对话」与「已归档」；从话题返回，回到这个列表。
- **搜索面板**：⌘K 搜两边，会话行的第二行先写它在哪边：「Code」或 Agent 名称；我的 Agent 的会话的图标是 Agent 的头像。根命令里有「Code」与「我的 Agent」。
- **图标**：所有「我的 Agent」入口（开关、收起时的按钮、命令面板、手机网页的标签栏）用同一个单色图标 `AgentsGlyph`（[AgentAvatar.tsx](../apps/web/src/agents/AgentAvatar.tsx)）：头像家族的花括号加圆点眼 `{··}`，取 `avatarFace.ts` 的几何裁到只剩脸，线条比头像里稍粗（2.5），是 Lucide 图标，用法与其他图标一样，不动。

- **列表**：「通用」在最前并标「内置」，其余按 Host 的顺序；每行是头像、名称、一行职责（说明，没有时是指令的第一行）、默认项目与 `available`/`unavailableReason`；Harness 与模型不在列表里，在它的 资料 › 设置。点一行就是和它对话；主按钮是「给<名称>发消息…」（进入新话题），还没有自己的 Agent 时是「新建 Agent」。
- **对话**（[chat.ts](../apps/web/src/agents/chat.ts)）：选中一个 Agent（「通用」也一样）就是和它对话。打开的是它的**当前话题**：最近活动过、未归档、不是定时任务运行的会话（定时任务的运行在「话题 ▾」里；`agents/:id` 与侧栏、列表、命令面板都这样打开），主区就是会话视图，工具行、审批卡与右侧面板和 Code 里相同，但它读起来是一个人（见下面「像一个人」），输入框写「给 <名字> 发消息…」，发出的消息是这个会话的下一轮。没有话题，或在「话题 ▾」里选了「新话题」时，主区是新话题：中间是 Agent 的头像与名称，还没有任何话题时下面是它的第一句话「你好，我是<名字>。<职责>」：界面按定义画的固定文字，不是消息，不调用模型，Harness 收不到，不进历史，也就不会失败（「通用」照旧写它的职责）。底部的输入框经 `POST /tasks` 带 `customAgentId`（「通用」是 `general`）开始新会话，用 Agent 自己的 Harness、模型和默认项目；「通用」固定用 Standard Agent 和 Host 默认模型，在自己的家里工作；没有可用模型服务时说明去 设置 › 模型服务 接上一个。输入框只有输入、「＋」和发送：「＋」里是「添加文件…」（图片与文字附件按 Host 报告的能力）、「带入上次成果…」（没有之前的话题时带原因、不能选）和「在项目里做」（只对这一个话题：不在项目里或某个项目；「通用」没有这一节）。选了项目时输入框下一行写「在 <项目> 做」，不是 Agent 的默认项目时带 ✕ 回到默认，项目能开工作树时同一行有现有的文件夹选择（新工作树的起点按所选发送）。新话题复用现有 `useAttachments` 上传与秘密确认，上传完成后把引用放进同一 `PendingSubmission.attachmentIds`；结果未知保留原 requestId 和引用，重试不重新上传或新建话题。放弃原请求后只清掉此设备的附件草稿，重新发需重新添加；不会删除可能已被 Host 接受的附件。外部 Harness 的默认模型、思考与权限在 资料 › 设置 中用与 Code 相同的控件保存，在新话题第一条提示前应用，已有话题不重新配置。「带入上次成果」：选一个或多个之前的话题，从每个读出最后一条回复（默认勾选）和它提到的文件，作为引用文字（从「> 上次成果「标题」：」起每行都是 `>` 引用，文件只写路径）插在已写的文字后面；它不建交接记录，也不接着原来的上下文。Host 回答时还停在这个新话题上才就地打开它；这期间去了别处就留在那里，新话题在「话题 ▾」里。旧的 `agents/:id/memory|schedules|settings` 打开对话并把资料面板定位到那一节，旧的「委托」链接打开对话。
- **资料面板**（[AgentProfile.tsx](../apps/web/src/agents/AgentProfile.tsx)）：点外框的头像或名称才出现，宽窗口占右侧面板的位置，和改动、文件等面板互斥（面板开关把面板换回来），新话题上同样在右边，窄于 1024 时浮在对话上；手机上是底部面板；可以关掉。自上而下：大头像（能开始会话的设备点开头像选择器）、名称与职责、不可用或不在线时的原因；分段「动态 · 资料库 · 记忆」（见下面「动态与资料库」；记忆可以添加、修改、删除，规则见下面「写入」）；「即将进行」：这个 Agent 的定时任务，每条写名称与计划，带开关（经 `…/enabled`，带 `baseRevision` 与 `requestId`），「编辑」或「新建定时」进入现有的定时编辑；电脑与工作位置；技能与工具的数量；最后「设置」打开编辑表单（「通用」是指令与技能）。表单里「执行方式」是只读的「由 <Harness> 运行」（品牌图标在前，ⓘ 写建好后不能换 Harness；外部 Harness 另写它能读写这台 Mac 上的文件并运行命令、权限是它自己的设置）、「模型」（运行在 Latch 模型服务上的 Harness 是现有的模型菜单与「用默认模型」，经 `PATCH` 的 `model` 只影响之后开始的话题；其余写「它自己的默认」，ⓘ 写在开始时换它的模型尚未实现）与「做事前」（只读：Harness 声明的档位，执行前不询问的是琥珀色「不询问 · 由 <Harness> 决定」，其余档位在开始时设置尚未实现）。名称、职责、指令、默认项目、技能与「可以使用」照旧可改；保存只要名称不为空，Harness 现在不能运行时也能保存。我的 Agent 另有「MCP」：这个 Agent 的会话拿到的 Latch MCP 服务器（「所有会话」的标出来）与状态词；这台 Mac 的桌面端用开关把已有的服务器挂上或取下（改服务器的「用在」，不要确认）；内置 Harness 的 Agent 写「内置 Harness 只用远程地址」（它的会话只拿到远程地址的工具，每次调用都问；本机命令尚未实现）。新增在 设置 › MCP，见 [MCP.md](MCP.md)。「通用」的「即将进行」是不指定 Agent 的定时任务，在这里同样能开关、编辑和新建。
- **像一个人**（[personWords.ts](../apps/web/src/agents/personWords.ts)）：我的 Agent 的话题（`topicOwner` 有值，包括和「通用」的对话与已删除的 Agent 的话题）里，每一轮的作者行是 Agent 的头像（16）与名字（`Transcript` 的 `speaker`；已删除的写「已删除的 Agent」配中性的脸），不写 Harness、模型与「选的是…」，模型或思考的切换线也不画；演示模型回答时作者行后面仍有「演示」。推理写「在想」与「想了 N 秒」（整秒）。回合底部只有时间与用时，不写 tokens、经 Latch 的请求数与上下文（用量仍在 设置 › 用量）。运行行、送达词（「<名字> 已开始」）、撤销与追加的说明、提问抽屉、结束行里说是谁的地方写 Agent 的名字；只有要人去处理的「<Harness> 还没登录」写 Harness 的名字，配现有的登录步骤。工具行、审批卡的内容与 Host 写的失败原因原样不改。输入框只有输入、「＋」（附件，规则同 Code）和发送：没有 Harness、模型、思考与权限四个控件、会话选项菜单和底部的地点、路线与用量行；Code 的输入框不变。权限芯片不在了，外框在名字旁写安全事实：权限读不回时琥珀色「权限没确认」，执行前不询问（不再询问的档位，或 pi 这样的 Harness）时琥珀色「不先问你」，原因在 ⓘ，不点名 Harness；外部 Harness 默认的「先问你」仍有中性的「Latch 不隔离 <名字>」及说明入口。打开的话题按它的会话报告的权限判断，新话题按 Agent 的 Harness 声明的判断；手机也保留警告文字与 ⓘ；未知档位用它自己的名字。外部 Harness 第一次启动仍显示不隔离说明，并用 Agent 名字；创建第二步与 资料 › 设置 也保留该说明。模型路线绕过 Latch 或下一轮不可用时，输入框下保留短警告与完整原因。
- **状态词**：只来自 Host 已有的事件，没有事件不说话。对话里的运行行按最新一条运行中的工具行与阶段写细词：读文件（`read`、`read_file`、`list_files`、`list_folders`）「在看文件」，`search`「在找东西」，`fetch`「在查资料」，`browser_*`「在看网页」，`edit`、`write_file`、`delete`、`move`「在写文件」，`execute`「在跑命令」，MCP 工具（`mcp__<服务器>__…`）「在用 <服务器>」，子 Agent「在分头做」，其他或不明「在动手」；没有工具时，正文在流「在回复」，推理在流或在等模型「在想」，`starting`「在准备」，审批与提问「等你点头」，停止中「在停下」，没有动静时「没有动静 N 分钟」。外框、侧栏的 Agent 行、列表与「最近对话」只有摘要的 `RunLive.activity`，写粗词：`starting` 在准备、`model` 在想、`command` 在跑命令、`tool` 在动手、`approval` 等你点头、`cancelling` 在停下；Agent 等你处理时的状态词是「等你点头」（琥珀），失败仍是「失败」。
- **头像**：一对括号围着两只眼睛，放在浅色圆角方块上，颜色取 `--agent-<hue>` 令牌（「通用」是中性灰的圆括号加圆点）。列表 40、资料面板与新话题 56、侧栏 24、对话外框 24（手机 28）、命令面板 16；「我的 Agent」入口是上面的单色 `{··}`。资料面板的大头像打开选择器（桌面是弹层，手机是底部面板）：会动的预览，下面是括号、眼睛、颜色三行，选项本身就是头像，选中项是墨色环，每行一个 Tab 停靠点，方向键从当前焦点移动，空格或回车选择；「设置」里没保存的修改在 Agent 有新版本时保留，同一字段在别处也改了时提示「已在别处修改」；选了立即提交，只显示 Host 读回的值，失败、结果未知与离线沿用「写入」的提示与原 `requestId` 重试。
- **头像的状态**：只由 Host 已有的数据推出，来自这个 Agent 的会话（`TaskSummary.agent.customAgentId`）：等你处理 > 运行中 > 休息（摘要 `available: false`）> 最近一次未归档会话失败 > 空闲（`agentActivity`）。状态词始终写在旁边（它在做什么或运行中、等你点头、失败；休息时是「不可用」），头像只陪衬：运行中右下角闪烁的 `_`、眼睛看向它；等你处理眼睛抬起，右上角不时冒出琥珀色「?」；失败眼睛低下，右上角红色「!」；休息闭眼，飘出「z」；会话在页面打开时结束，笑眯眯一次。空闲时每隔几秒随机眨眼、看一眼或笑眯眯。32 px 起有全部动作与配件，20–31 px 只偶尔眨眼，16 px 不动。全页一个调度器（`avatarMotion.ts`）、一个计时器，只驱动视口内的头像，页面隐藏时停；同时笑眯眯或冒配件的不超过 3 个；只动 transform 与 opacity。减少动态效果或根元素 `data-motion="still"`（e2e 的 `stillMotion`，与固定时钟一起在 `visualContext` 里）时完全不动，配件静态显示。
- **电脑**（[Computer.tsx](../apps/web/src/agents/Computer.tsx)）：资料面板「即将进行」之下。状态词只来自 Host：页面连得上是「在线」；Host 在睡眠前宣布过（`host-state` 的 `sleeping`）且之后没连上是「睡眠中」；桌面端报告正在保持唤醒时是「保持唤醒中」（ⓘ 里是为会话还是为定时）；连不上又没有宣布是「不在线」。从不写「永远在线」，也没有电脑缩略图。下面是「上次唤醒」（桌面端报告的最近一次醒来，没有报告时不写），和琥珀色「错过 N 次」：这个 Agent 开启着的定时任务各自上一次真实运行（含立即运行）之后错过的时间，按定时任务分行，每个时间只按记录写原因：落在桌面端报告的、已经醒来的睡眠里是「Mac 在睡眠」，落在这个 Host 有序停止到下次启动之间是「Mac 关机或 Latch 没有运行」，其余（睡眠还没报告醒来、Host 崩溃、没有桌面端、早于保留的记录）一律是「睡眠、关机或 Latch 没有运行」，每行一个「立即运行」（带 `requestId`，结果未知时重试同一请求）；运行之后这一行消失。数据来自 `GET …/computer`：`computer` 与快照的 `computer`（完整数据范围的设备才有，不含 ID）相同；`missed` 由定时任务自己的运行记录得出（[AUTOMATIONS.md](AUTOMATIONS.md#运行与状态)），原因由 Host 的 `agents/computer.json` 判断：桌面端经 host.sock 报告的睡眠与醒来（再次报告睡眠时，前一段在那时结束、新的一段开始；Host 启动时丢掉没有醒来报告的那一段），以及 Host 有序停止到下次启动的时段，各最多 32 段，strict schema，只有时间；读不了的文件移到一边（`computer.json.invalid-<时间>`，日志只写原因），从空记录开始，不影响 Host 启动。我的 Agent 另有「到点前后保持唤醒」开关（需要 `run`），ⓘ 写明它只在 Latch 应用运行时有效、最长多久、不会唤醒已经睡眠的 Mac；桌面端没有在报告时写琥珀色「Latch 应用没有运行，现在不起作用」。机制见 [AUTOMATIONS.md](AUTOMATIONS.md#到点前后保持唤醒)。「通用」只有状态与错过的时间。
- **通知**：我的 Agent 的资料面板里「完成」「失败」「需要你处理」三个开关（`notifications`，需要 `run`），每次改一个，全部打开时发 `null`。桌面端按它过滤（[NOTIFICATIONS.md](NOTIFICATIONS.md)）；iPhone 与 iPad 目前只在 App 在前台时为其他电脑的「等你处理」发通知，不分 Agent，按 Agent 区分尚未实现；手机上的这三个开关只改 Mac 上的 Latch 应用怎么通知，ⓘ 里这样写。
- **新建**（[HelperCreate.tsx](../apps/web/src/agents/HelperCreate.tsx)，入口仍叫「新建 Agent」）：两步，一页。第一步标题「你想让谁成为你的帮手？」，「帮手」只出现在这一句，别处都是 Agent。每个就绪、有 `agentContext`、不是 `offer` 的 Harness 是一张卡（`agentHarnesses`，Latch 内置在最前，其余按 Host 的顺序；[helpers.ts](../apps/web/src/agents/helpers.ts)）：它开始时的脸（卡片的括号与眼睛，颜色是还没有 Agent 用的第一个）、Harness 的名字与品牌图标（名字只在这里出现）、一句话与能力标签（图标加两三个字：读写文件、跑命令、MCP、提问、记事、定时）。句子和标签来自预设的 `helperCard`（`AGENT_PRESETS`，内置是 `BUILTIN_HELPER_CARD`，各带出处 `source`），只列做得到的：Harness 报告不能运行命令时去掉「跑命令」；「上网」在真实 Harness 上核对之前一律不写，Codex、OpenCode 之外的「记事」「定时」也等核对后再加；没有预设的 Harness（自己定义的）只有名字。执行前不询问的 Harness（`HarnessInfo.permission.approvals === 'none'`，目前是 pi）带琥珀色「不先问你」。没就绪的（有 `agentContext` 但 `status` 不是 `ready`）收在「还有 N 个没准备好」里，灰色、不能选，各写「需要升级」「未安装」或「没准备好」，原因在 ⓘ，能改设置的设备有「设置 › Harness」。第二步：一行「选了 <Harness> · 换」（换回到第一步，写过的留着）；大头像（72，点开是同一个头像选择器，只改这份草稿）与「名字」（必填，占位「给它起个名字」）；「从模板开始」：代码审阅、周报、发布检查、资料整理（[roleTemplates.ts](../apps/web/src/agents/roleTemplates.ts)；选一个只填「职责」与「指令」，名字为空时也填名字，不预置任何工具、权限或 Harness）；「职责」；折叠的「多说几句」（指令）；折叠的「更多」：「用的模型」（运行在 Latch 模型服务上的 Harness 是模型菜单，不选就用 Host 的默认模型；其余写「它自己的默认」）、「做事前」（只读，同设置）与「在项目里做」（项目菜单，写进 `defaultProjectId`）。按「创建」之前什么都不存在：`POST /custom-agents` 带 `requestId`、所选的脸、`skills: []` 与 `agent` 模式（Harness 没有时用它的第一个），结果未知与失败沿用「写入」；成功后进入它的新话题，输入框拿到焦点。
- **定时**：这个 Agent 的定时任务（「通用」的是不指定 Agent 的那些），界面见 [AUTOMATIONS.md](AUTOMATIONS.md#界面)。
- **记忆提议**：对话里在提议来自的那一轮之后是一行「想记住：<文字>」，下面是来源的短词「你说的」或「它推断的」、外部内容时琥珀色的「来自外部内容」、理由（在 `Hint` 里）与「不要」「保存」（这一处唯一的蓝色主按钮）。保存中、不要中、已保存（「已保存」与「已生效」或「从下一个话题起」）、不要了、结果未知（保留原 `requestId`，「重试同一请求」）与失败（Host 的原因）都是真实状态。资料面板的「记忆」最上面是待处理的「提议」，同样的两个按钮（保存不用蓝色，面板的蓝色留给它的表单）；从提议保存的记忆写出来源、链到话题和时间；改过的记忆有「撤销修改」，删除的记忆在列表下面带「撤销」。
- **定时结果**：这个 Agent 的定时任务运行结束时，对话里出现一张结果卡（「定时 · <名称> · 时间 · 已完成」，规则见 [AUTOMATIONS.md](AUTOMATIONS.md#结果回到对话)），按它结束的时间排进当前话题；卡上是最后一条回复的开头（「展开」看全部存下的部分）、它改动或产出的文件（点开是那次运行的会话里的文件预览，删除的只写路径）、没有完成时的原因，和「打开运行」。失败与中断的卡按失败的错误码给一个下一步：「重试」类是「立即运行」（带 `requestId`，结果未知时「重试同一请求」），Harness 与模型服务类在这台 Mac 上打开对应的设置，其余在运行的会话里处理。还没有话题时，卡在新话题页的中间；人发出第一条消息开始的话题收下它们，排在第一条消息之前。同一处多于 3 张时只画最新的 3 张，上面是「还有 N 条结果」，打开资料面板的「动态」。卡不是消息，Harness 收不到，话题的上下文与历史不变。
- **定时提议**：对话里在来自的那一轮之后是一行「想定时：<名称> · <计划>」，下面是每次输入的第一行，「它推断的」、外部内容时琥珀色的「来自外部内容」，「不要」与「打开」（这一处唯一的蓝色主按钮）；保存后写「已保存」，不要后写「不要了」，都以 Host 为准。
- **动态与资料库**：都只来自 Host 已有的记录（[agent-activity.ts](../apps/host/src/agent-activity.ts)），不另记事件。「动态」按「今天 / 本周 / 更早」倒序列出：开始的话题（标题）、定时运行与它的状态（有结果卡的运行只列一次，写作「定时结果」）、记忆的增加、修改与删除（只写「记忆 +1」「记忆已修改」「记忆 −1」，不写文字，点一下到「记忆」）、提议（「提议记忆」「提议定时」与它的状态）；每行点开它发生的话题或运行；没有时写「还没有动态」，「加载更多」翻页。「资料库」按会话（话题与定时运行，最新的在前，只算为这个 Agent 运行的：定时任务移到别的 Agent 后，之前的运行仍在原来的 Agent，「动态」也一样）分组：每轮改动记录里这一轮改动的文件（只比较这一轮自己的开始与结束；另一个会话同时在同一文件夹运行的那一轮整轮不列，因为说不清是谁的），以及人给它的附件；运行期间观察到的产物（[FILE-OUTPUTS.md](FILE-OUTPUTS.md)）可能混有别的会话的写入，不用；没有改动记录的会话不列文件。结果卡的文件也是这样。文件在它所在的会话里用现有的文件预览打开，沿用那个会话的文件规则；看不到项目文件的设备写「这台设备看不到项目文件」，不能打开。一页最多读 24 个会话的详情。
- **写入**：新建、修改（带打开表单时的 `baseRevision`，只发改了的字段）、删除与记忆都带 `requestId`；结果未知时保留原请求，「重试同一请求」原样重发，`agent-changed` 显示为已在别处修改并可载入最新。新话题的待确认请求单独存放，不占用新会话的草稿，重试同样沿用原 `requestId`；卡片写出最后一次重试的原因，「放弃这次提交」只在这台设备上放下它，文字回到输入框（Host 如果其实收到了，它会作为一个话题出现）。
- **数据范围**：没有完整数据范围的设备看到「这台设备看不到 Agent」，不显示空列表；Host 返回 `agent-scope-required` 时同样处理，`agent-write-unknown` 时显示正在确认并稍后重读。
- **iPhone/iPad**：标签栏同样是 Code / 我的 Agent / 应用 / 设置，判断在 `PhoneTabs`、`PhoneAgents`、`PhoneAgentChat`、`PhoneProposals`、`PhoneMemories`、`PhoneScheduleWrite`、`PhoneResults`、`PhoneScheduleProposals` 与 `PhoneActivity`。手机只在正文窗口内拿到快照的 `customAgents`、`automations` 与 `agentProposals`，所以窗口外不显示任何 Agent 的名称、职责、记忆与定时，列表写「查看」（Face ID 关闭时自动打开）；离线保存的列表不含它们，窗口关闭时也从内存撤下（读到的提议一并撤下），Agent 的话题在窗口外页头只写「我的 Agent」，窗口内写 Agent 名称（「通用」；已删除的写「已删除的 Agent」）。选中一个 Agent（手机推入、iPad 在列表旁）就是和它对话，规则同网页：当前话题是最近活动、未归档、不是定时任务运行的会话，打开后这一页一直停在它上面；页头是头像（28）、名称与状态词、话题标题，点它们打开资料面板，右边是「话题 ▾」（新话题、未归档的话题由新到旧、已归档）与会话的 ⋯；输入框写「给 <名字> 发消息…」，发出的消息是这个会话的下一轮。没有话题或选了「新话题」时，中间是头像（56）、名称与职责，输入框上方能换这一次的项目（「通用」没有）与模型，Harness 固定为该 Agent 的默认值，「通用」固定为 Standard Agent，第一条消息经同一 `POST /tasks` 带 `customAgentId`（「通用」是 `general`、`harnessId: 'standard'`、`mode: 'agent'` 与 `workspaceId: 'default'`）开始会话，Host 回答时就地打开；它占用手机唯一的待确认写入，结果未知时「重试同一请求」或「放弃这次提交」（文字回到输入框）。对话里每条记忆提议排在它来自的那一轮之后：「想记住：…」、来源「你说的」或「它推断的」、琥珀色「来自外部内容」、理由在 ⓘ 里、「不要」「保存」（这一处的蓝色主按钮），已保存写「已生效」或「从下一个话题起」；没记下的「记住…」写红色「没有记下」与原因。资料面板是底部面板：大头像（64）、名称与职责、不可用或不在线的原因；「动态 · 资料库 · 记忆」（动态与资料库见下；记忆最上面是待处理的提议，保存不用蓝色，每条记忆写来源、链到话题与时间，改过的有「撤销修改」，删除的列在「已删除」下带「撤销」「清除」，都带人看到的 `baseRevision`）；「即将进行」是定时任务与开关（经 `…/enabled`，带 `baseRevision` 与 `requestId`，`automation-changed` 显示「已在别处修改」），点一行看运行记录，运行的会话在对话里打开；「电脑」同网页（`PhoneAgentComputer`）：电脑名与状态词（只来自 Host：连得上「在线」，Host 宣布睡眠后没连上「睡眠中」，桌面端报告保持唤醒时「保持唤醒中」、原因在 ⓘ 里，其余「不在线」），「上次唤醒」，琥珀色「错过 N 次」按定时任务分行、每个时间写记录里的原因，每行「立即运行」（`POST /automations/:id/run`），读 `GET …/computer`，快照的 `computer` 或这个 Agent 的定时变了时重读；我的 Agent 另有「到点前后保持唤醒」与「通知」的「完成」「失败」「需要你处理」，经 `PATCH /custom-agents/:id` 带人看到的 `baseRevision`（全部打开时 `notifications` 发 `null`），需要 `run`；工作位置；Harness · 模型与技能、工具的数量；「设置」只读。所有写入都占用手机唯一的待确认写入，结果未知时「重试同一请求」。提议、记忆与话题标题经 `PhoneConversation.visible` 把隐藏字符画成 `\u{…}`。已有话题与新话题的输入框都带「＋」附件，规则同 Code 的输入框（[ATTACHMENTS.md](ATTACHMENTS.md#iphone-与-ipad)）；新话题的附件按这一次的 Harness、项目与模型核对，随第一条消息开始会话。新建与修改 Agent（含职责模板）、修改定时任务与不经提议新建定时任务写「尚未实现」，在网页或桌面端修改；iOS 的话题仍是改版之前的样子（作者行是 Harness 与模型，新话题的我的 Agent 固定使用自己的 Harness，通用固定 Standard Agent，模型仍保留原选择，状态词是「运行中」「等你处理」），按网页的规则改是之后的一批；带入上次成果、外部 Harness 的 `engineOptions`、换头像的选择器与列表下的「最近对话」在 iOS 上尚未实现。会话属于哪边与网页相同（`PhoneSpaces`，同 `spaceOf`）：Code 标签只列 Code 的会话，Agent 的话题与和「通用」的对话只在我的 Agent；Host 没有我的 Agent 时全部在 Code。两个标签的琥珀点各自只算自己那边；回到 Code 时，开着的我的 Agent 话题随之关上。离线保存的列表也记下 `generalChat`，好让窗口外仍分得开。头像用 SwiftUI 画同样的几何与动作（`AgentFace`，状态由 `PhoneAgents.face` 推出），列表 40、新话题 56、资料面板 64、页头 28，一个共享时钟只在头像显示、App 在前台时走；开启「减弱动态效果」时不动；标签栏的「我的 Agent」图标由 iOS 另行更新。定时结果卡同网页（`PhoneResults`）：Agent 的话题详情带 `results` 时按运行结束的时间排在那一轮之后，一处最多 3 张，其上是「还有 N 条结果」（打开资料面板的动态）；卡上是名称、时间、结果词（已中断与结果未知琥珀、失败红）、回复开头与「展开」、文件（点开是那次运行的会话里的文件预览，规则同那个会话的文件，删除的只写路径）、没有完成的原因与「打开运行」（这个 Agent 的运行在对话里打开；「通用」的定时运行不属于任何 Agent，同网页在 Code 里打开，动态与资料库的行也一样）；失败或中断且错误码属于「重试」类、定时任务还在且没在运行、这台设备能运行并在线时，下一步是「立即运行」（`POST /automations/:id/run`，占用手机唯一的待确认写入，结果未知时「重试同一请求」）；Harness 与模型服务类的下一步只在那台 Mac 上，手机不给。还没有话题时，等着的卡（快照 `agentResults` 的 `unbound` 大于 0 时读 `GET /custom-agents/:id/results`）画在新话题页的中间，下一个话题收下它们。定时提议是一行「想定时：<名称> · <计划>」、每次输入的第一行、「它推断的」与琥珀色「来自外部内容」，「不要」与「打开」（蓝色主按钮）；「打开」是一张表单：名称与时间（只读，计划写成文字）、工作位置（Agent 的默认项目预选，没有时选「家」；同网页的项目选择，文件夹多于 Harness 能用的项目带原因、不能选，程序目录内的项目标琥珀色「在程序目录里，每次写入都问你」；「家」始终可选，不随 Code 的 `sessionFolders` 设置改变）、「结果出来时通知我」、「每次的输入 · 它写的」下面的整段输入；Agent 可用但不能后台运行时，表单写「保存为已关闭，可手动运行」并发送 `enabled:false`；「立即运行」只按当前可用性与设备权限判断，后台开启仍检查 `canAutomate`。「保存」经 `POST /automations` 带 `proposalId` 创建（`PhoneScheduleProposals`，同一 `requestId` 的重试按回执回答，结果未知时留在表单与行上）。我的 Agent 的所有写入（记忆、提议的保存与不要、撤销与清除、定时开关、立即运行、从提议保存、通知与保持唤醒的开关）都按 `PhoneAgentWrites`：Host 的拒绝写出它自己的原因，`agent-proposal-decided` 与别处修改显示为「已在别处修改」；重试只在回执重放或提议自己的写入收到 `agent-proposal-decided` 时算有答案，从提议保存的这时再读提议，它已保存并指向一个定时任务就算完成；结果未知时除「重试同一请求」外还有「核对并放下」：按 Host 现在的状态说明，并放下这台设备上的这一项，手机唯一的待确认写入总能腾出来。资料面板的「记忆」不列定时提议。「动态」与「资料库」读 `GET /custom-agents/:id/activity` 与 `/library`（`PhoneActivity`），按 Host 的 `next` 翻页（「加载更多」只把后一页接在它所属的那次读取后面，`PhonePagedRead`），快照里这个 Agent 的话题、运行、卡、记忆或提议变了时重读；动态按「今天 / 本周 / 更早」分组，只写种类、名称与状态词（记忆只写「记忆 +1」「记忆已修改」「记忆 −1」），点一行打开它发生的话题或运行，记忆行到「记忆」；资料库按会话分组，文件与附件在所属会话里用现有的文件预览打开（Quick Look 的限制不变）。这些都只在正文窗口内、完整数据范围的设备上读；锁定、撤销与窗口关闭时随正文撤下（等着的卡在 `PhoneResultStore`，与提议一样只采用最新一次读取），`withoutPrivate` 也去掉快照的 `agentResults` 与 `computer`，离线保存的列表不含它们。
- **原生读取状态**：只有 Host 的 `agent-write-unknown` 才表示正在确认先前修改；普通读取的 408/5xx 显示读取失败，连接超时显示离线，不改动原来待确认写入的请求编号与请求体。私有快照记录本地清理代次及当前正文窗口是否已确认：本地撤下字段不等于 Host 未确认写，旧读取不能恢复已撤下的内容。有效窗口内离线仍可看已获授权的缓存。资料读取只使用已有窗口，不隐式请求 Face ID；权限收紧或窗口关闭时，已推入的记忆编辑页和定时提议表单也撤下本地内容，持久的未知请求保留。
