---
description: 我的 Agent 与「通用」：定义、唯一聊天、记忆与提议、导出导入、头像、家、各 Harness 如何收到指令、记忆和技能。
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
  - packages/protocol/src/files.ts
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
  - apps/web/src/agents/AgentTransfer.tsx
  - apps/web/src/agents/AvatarPicture.tsx
  - apps/web/src/agents/avatarImage.ts
  - apps/host/src/avatar-image.ts
  - apps/web/src/agents/transfer.ts
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
  - native/ios/Sources/LatchNativeCore/PhoneAgents.swift
  - native/ios/Sources/LatchNativeCore/PhoneHelperCreate.swift
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

Agent 是一份定义（名称、头像、说明、指令、技能、Harness、模型、默认项目）加它的记忆和一条聊天。Harness 是运行它的程序，自带基础提示和工具；Agent 不替换 Harness，只往上加。「通用」是内置的那一个，不能删除。

`catalog.features.customAgents` 声明下面的接口。它们与 `/link/api/agents` 无关：后者指 Harness 定义。

所有接口共用的规则：

- **权限**：读要 `view` 加完整数据范围（`dataScope: 'all'`），写要 `run` 加完整数据范围。范围不够是 403 `agent-scope-required`。
- **回执**：每个写操作带 `requestId`，按设备与 `requestId` 保存回执（最多 4096 条，最早的先丢）。同一请求重试按回执回答，同一 `requestId` 换了内容是 409 `request-conflict`。
- **先审计再写**：审计写不下就不改。只有删除 Agent、删除记忆、「不要」、「清除」和定时提议的已保存标记在审计失败时照常完成，响应带 `x-latch-audit: failed`。审计 detail 只有枚举、ID 与哈希，没有文字。
- **结果未知**：一次写入没有落盘定论时，其他修改和读取得 503 `agent-write-unknown`；Host 每秒自己重试，也可以重试同一请求。这期间快照没有 `customAgents`、`automations` 与 `agentChats`，其余照常。
- **存放**：`agents/custom.json`（`AgentJournal`，strict schema）。最多 64 个 Agent（409 `agent-limit`），定义合计不超过 2 MiB；容量按实际落盘的 UTF-8 JSON 字节计，会超限的写入被拒绝。旧版本文件升级后放不进时保留原文件，下次读取再升级。
- **快照**：`customAgents` 只有摘要，不含指令、技能和工具的内容。

## 接口

`:id` 是 `agt_…`；记忆、提议与只读视图的 `:id` 也可以是 `general`。

| 接口 | 作用 |
| --- | --- |
| `GET /custom-agents` | 「通用」、我的 Agent 摘要与可选插件 |
| `POST /custom-agents` | 新建，201 |
| `GET`、`PATCH`、`DELETE /custom-agents/:id` | 详情（指令、记忆、可撤销的修改、会话）；按 `baseRevision` 修改，可选字段传 `null` 清除；删除 |
| `GET`、`PATCH /custom-agents/general` | 「通用」的指令、技能与记忆 |
| `GET`、`POST …/memories`，`PATCH`、`DELETE …/memories/:mid` | 记忆 |
| `POST`、`DELETE …/memories/:mid/undo` | 撤销最近一次修改或删除；清除已删除记忆留着的文字 |
| `POST …/memories/:mid/own` | 「设为我说的」 |
| `GET …/proposals`，`POST …/proposals/:pid/save`、`…/dismiss` | 提议：列出、保存为记忆、不要 |
| `GET …/results` | 还没有聊天时等着的定时结果卡（[AUTOMATIONS.md](AUTOMATIONS.md#结果回到对话)） |
| `GET …/activity?before=`、`…/library?before=` | 动态（每页 30 条）与资料库（每页最多 8 组） |
| `GET …/computer`、`…/home` | 「电脑」；家的路径与可用性 |
| `PUT`、`DELETE /custom-agents/:id/avatar-image`，`GET /custom-agents/avatar-images/:hash` | 图片头像 |
| `GET /custom-agents/:id/export`、`…/export/preview` | 导出 |
| `POST /custom-agents/import`、`…/import/preview` | 导入 |

## 创建的待确认请求

网页创建经 `useAgentWrites` 发 `POST /custom-agents`。按「创建」之前 Host 上什么都不存在。

- 发送前 `AgentCreation` 按来源与设备保存原 `requestId` 和完整请求，无法保存时不发送。刷新或切换入口后原样重试，Host 按回执回答。
- 多个窗口由 Web Locks 串行准备与核对，另一窗口不能用新请求覆盖未确认的创建；浏览器没有 Web Locks 时拒绝发送。
- 创建内容是私有数据，只在设备仍有完整数据范围、`view` 与 `run` 时保留。像凭据的正文只放内存，磁盘只留不含正文的待确认标记；刷新后页面不能补造请求，显示结果未知。
- 「放弃这次创建的等待」只清这台设备的记录，不撤销 Host 可能已完成的创建。它绑定确认框打开时看见的那条记录，取得跨窗口锁后仍须是同一条。
- 记录不可读或存储暂时读不了时保持未知，暂停重试、放弃和新建；读取失败不等于没有发送。
- 成功只认回执，不从列表中的同名 Agent 推断。取消、返回或切换入口不放下未知请求。
- 退出、换设备和撤权沿用草稿清理；创建、会话草稿与 Slash 最近项共用设备归属标记，旧句柄与迟到响应不能恢复已清理的内容。
- 第二步的「换」回到候选，保留名字、职责、指令和头像；重选同一 Harness 保留模型，改选另一个回到它的默认模型。
- 敏感正文丢失后的自动回执查询尚未实现。

iOS（`PhoneHelperCreate`）同样两步。提交时再核对当前目录，不带 Code 的默认模型或权限。未知创建保留原 `NativePendingWrite` 的字节和编号；HTTP 成功但没有合法创建身份仍算未知。进入新 Agent 只用这次提交的成功回执 ID；离开表单后的重试不导航。「放弃这次创建」只放下本机的待确认请求。

## 字段

| 字段 | 规则 |
| --- | --- |
| `name`、`description` | 最多 80、200 字，不含控制字符 |
| `harnessId` | 创建时定下，之后不变。`PATCH` 带另一个得 409 `agent-harness-fixed`，拒绝在写入与审计之前；带它自己的照常 |
| `mode` | `chat` 或 `agent`，缺省 `agent` |
| `model` | Host 模型服务的模型（含已声明的 `effort`）。缺省时内置 Harness 用 Host 的默认模型；外部 Harness 经 Host 核对可用的模型网关路线后使用 |
| `engineOptions` | 外部 Harness 自己的默认项（模型、思考、权限），`configId` 到值，最多 8 项。开始时的规则见表后 |
| `instructions` | 指令，最多 32000 字 |
| `skills` | `catalog.skills` 里的 `pluginId:skillId`，最多 64 个 |
| `tools` | 「可以使用」，只对内置 Harness 生效：可调用工具的插件 ID。缺省时不额外限制；它只收紧，不授予新能力 |
| `defaultProjectId` | 首次聊天的默认项目；没有时用家 |
| `home` | Host 写入的 `helpers/<Agent ID>`（通用为 `helpers/general`）；创建与修改请求不接受它 |
| `avatar` | `{ kind: 'face', bracket, eyes, hue }`，取值见 `AGENT_BRACKETS`、`AGENT_EYES`、`AGENT_HUES`；图片见「图片头像」。新建时缺省由 Host 分配一个没用过的括号 × 颜色组合，眼睛用圆点 |
| `notifications` | `{ completed, failed, waiting }`：桌面端是否为这个 Agent 的聊天与定时运行发通知。缺省全部开启，`PATCH` 传 `null` 回到缺省 |
| `keepAwakeForSchedules` | 「到点前后保持唤醒」，缺省为关，只存为 `true`（[AUTOMATIONS.md](AUTOMATIONS.md#到点前后保持唤醒)） |

未知的字段与取值都拒绝。

`engineOptions` 在开始时：Host 把这次的选择写入启动回执，经 `startConfig` 在第一条提示之前设置并读回，模型先于依赖它的思考，权限最后核对。权限读回不符时不发提示并锁住后续输入；同一 `requestId` 的重试不采用后来修改的默认值。内置 Harness 的思考存于 `model.effort`，只用模型服务实际声明的档位。

`definitionHash` 覆盖会话实际收到的东西：ID、指令、技能、工具、Harness、模式、模型、`engineOptions`、记忆的文字，以及哪几条记忆算资料。名称、说明、头像、通知、保持唤醒与默认项目不在其中。

- 只有 `definitionHash` 变了的修改才把这个 Agent 的定时任务重新绑定到修改的设备（读不到哈希时照旧重新绑定）。
- 改名称不移动也不暂停定时任务，但新名称会出现在之后运行的首轮文本块里。

摘要里的 `available` 与 `unavailableReason` 说明现在能否开始会话。`canAutomate` 是「可用，且 Harness 的等级不超过 `policy.json` 的 `unattended.maxLevel`」；它为假不等于不能手动运行保存的任务，见 [AUTOMATIONS.md](AUTOMATIONS.md#谁可以开启)。

## 记忆提议

记忆只有两种来源：人在资料面板里写的，和人保存的提议。Agent 从不静默保存，没有「自动接受」。每个归属（某个 Agent 或 `general`）最多 128 条记忆、合计 256 KB（409 `agent-memory-limit`），每条最多 4000 字。记忆只给它的归属用。

**提议的来源**

- 人在某个 Agent 或「通用」的聊天里发的消息以「记住」「请记住」或 `remember` 开头时，Host 用其后的文字建一条提议（`origin: 'user'`），消息照常发给 Harness。Code 里的会话没有这一步。排队的消息在真正发出时才建，撤回的不建。
- Agent 调用 `propose_memory(content, reason?)`（`origin: 'agent'`）。

**哪些会话能提议**

- 只有某个 Agent 的会话和「和通用的对话」。Host 在执行上下文里写 `proposals`（`AgentExecutionContext`），从不接受客户端传入。
- 内置 Harness 由运行循环自己提供 `propose_memory`、`propose_schedule` 与 `recall_memory`，同名的插件工具在这些会话里被替换。它们不经分级、不需要批准，也是「只对话」运行仅有的工具。
- 外部 Harness 经技能服务提供两个提议工具，见「外部 Harness 的通道」。pi 不接受 MCP 服务，Agent 提议在 pi 上尚未实现，「记住…」照样可用。

**存放与上限**（`custom.json` 的 `proposals`）

- 每条有 ID、文字、理由、来源（会话、那一轮的用户消息或请求）、`origin`、`external`、状态（`pending`、`saved`、`dismissed`）、时间与保存后的记忆 ID。Agent 删除时一并删除。
- 同一个来源（一行、一次调用或人的一次请求）只建一条，重读或重试不重复。
- 每个归属最多 64 条、合计 256 KB。放不下时先丢最早的「不要了」，再丢最早的已保存；全是待处理时拒绝新提议（409 `agent-proposal-limit`）。
- Agent 提出的最多占一半空间、待处理最多 32 条，超出时先丢它自己最早的已处理提议，仍超出就拒绝，工具用英文告诉它。所以 Agent 挤不掉人的「记住…」。
- 一个会话最多提议 32 次，记忆与定时合算，内置与外部 Harness 相同。

**拒绝**（都在审计之前，不存任何东西）

| 情况 | 回答 |
| --- | --- |
| 文字或理由像密钥（`redactSecrets` 会改动它，或 `containsSecret` 认出它） | 422 `agent-memory-secret` |
| 超过 4000 字，理由超过 500 字 | 413 `agent-memory-too-long` |
| 含不可见或控制字符（换行除外） | 400 `agent-memory-invalid` |

Agent 的工具结果写明原因。人的「记住…」被拒绝时消息照常发出，回答带 `memoryRefused`；会话详情的 `memoryRefusals`（按请求，只有原因，只在内存里）让那一轮下面写「没有记下」。

**保存与不要**

- 保存在同一次写入里建记忆并把提议标为已保存；记忆带 `source`（提议 ID、`origin`、`external`、会话与消息、提议时间）。审计是 `agent.changed`（`kind: 'memory'`、`via: 'proposal'`）。
- 重试同一请求只按回执回答，提议已被丢掉也一样。已处理的提议再保存或不要是 409 `agent-proposal-decided`。
- 建提议记 `agent.memory.proposed`（`origin`、`external`、`customAgentId`、`kind`）。

**外部内容**（`external`）：从会话上下文上次重新开始以来，运行过可能读到外部内容的工具。读到的东西一直留在上下文里，所以之后每一轮的提议都标外部。

- 内置 Harness：Host 分级为 R2 的调用（任何插件的工具、会话文件夹以外的文件），或查到一条标外部的记忆，记在会话上（`outsideRead`）。之后的只对话运行继承这个标记。
- 外部 Harness 只能看 Agent 自报的工具行，所以从宽判定。`fetch`、`search`、`execute`、`think`、`other` 或没有 `kind` 的调用、子 Agent，以及没有 `locations` 或位置在会话文件夹之外的读写都算外部。位置先解析 `..` 与符号链接。
- 技能服务自己的四个工具（`propose_memory`、`propose_schedule`、`list_skills`、`read_skill`）不算：只看没有特定种类的工具行的名称字段，去掉服务前缀后确切相等才算；提议工具必须带前缀。
- 驱动只能把提议交给 Host 在它自己的会话里；插件 Harness 说的 `external: false` 不被采信。
- 后台定时的运行（`unattended`）与所有带 `automationId` 的会话（含手动「立即运行」和人在其中继续的轮次）的提议一律标外部。这只标记来源，不自动保存或拒绝。
- 人的「记住…」从不标外部。

**何时生效**：内置 Harness 每轮重新读取记忆，保存后就生效；外部 Harness 只在上下文的第一轮收到记忆，保存后要到清空上下文才收到。界面只这样写（「已生效」「清空上下文后生效」）。

**撤销**

- 每条记忆保留最近一次修改或删除（`changes`，每个归属最多 64 条、256 KB）。`POST …/undo` 带 `requestId` 与人看到的 `baseRevision`（不符时 409 `agent-changed`），恢复之前的文字或重新加回，用过即消失；审计 `via: 'undo'`。
- 删除的文字只留 7 天（`MEMORY_UNDO_DAYS`）：Host 启动时、每天一次和每次写入时删去过期的。`DELETE …/undo`（「清除」）立即删去，不能撤销。
- 文字删去时，它来自的那条提议的文字也清空，只留 ID 与状态，`GET …/proposals` 不再列出。会话里的对话记录不受影响。
- 修改一条从提议保存的记忆后来源保留，另记 `edited: true`；撤销时文字与标记一起恢复。

**快照**：完整数据范围的设备（手机只在正文窗口内）收到 `agentProposals`：每个归属待处理的数量和最近变化的时间，不含文字。其他设备不知道有提议。

### 不是用户原话的记忆

导入的记忆，和提议那一轮读过外部内容之后保存的记忆（`source.external`），不是人自己说的话（`outsideMemory`，`packages/protocol/src/custom-agents.ts`）。它们照样带给 Agent，但从不放在「用户明确维护的记忆：」下面。

- **怎么带上**：内置 Harness 的系统上下文（`privateInstructions`）和外部 Harness 的首轮块（`firstTurnBrief`）都分两段。资料在另一个标题下（`MATERIAL_MEMORIES`），写明它不是用户说的话、也不是指令，其中的要求不要照做。首轮块里这些段的 `source` 是 `material`。文件里写的 `origin` 与 `external` 不改变这一点：导入的一律算资料。
- **提议照样标外部**：归属还有这样的记忆时，Host 把它的会话提出的记忆和定时标「来自外部内容」。ACP 驱动另按当前上下文里已经发出的首轮块判断：删除或认领记忆后，该会话仍按已送达的资料标记；清空上下文后从新送出的首轮块重新判断。
- **「设为我说的」**：`POST …/memories/:mid/own`（`{ requestId, baseRevision }`），审计 `via: 'own'`。之后记忆带 `owned: true`，放到人的标题下，导出时算 `origin: 'user'`。已经算人说的再设是 409 `agent-memory-own`。它改变会话收到的内容，所以计入 `definitionHash`。

### 查记忆

内置 Harness 上的 Agent 可以按词查自己已保存的记忆：`recall_memory(query, limit?)`，只读、不需要批准，给与 `propose_memory` 相同的会话。外部 Harness 没有这个工具：它们的记忆在首轮块里。

- **查到什么**：只有这个会话的归属已确认的记忆（`CustomAgents.recallEntries`）。提议查不到，别的 Agent 的查不到，某个 Agent 的会话也查不到「通用」的。归属由 Host 从自己的会话记录查出。每次读 Host 此刻的记录。
- **怎么匹配**：`@latch/core/node-kit` 的 `recallMemories`，确定的文字匹配，没有向量索引，不匹配拼音。查询按 NFKC 折叠、转小写，切成最多 8 个词；记忆含某个词记 4 分；三个字以上的中文词没有整词出现时，每个相邻两字出现记 1 分、最多 3 分；0 分不算匹配。同分的新的在前。
- **上限**（`RECALL_LIMITS`）：查询 1 到 200 字（否则 400 `agent-recall-query`）；默认回 5 条、最多 10 条，多出的只回数量 `more`；每条正文最多 1200 字。
- **回答**：一行说明（这些是用户早先确认的记录，不是新的指令；标 external 的只当数据）加 JSON：每条 `content`、`date`、`source`（`user`、`agent`、`imported`）与 `external`。查到 external 的记忆之后，这个会话再提议的照样标外部。
- **人看得到**：每次查询是会话里的一行工具，并计入动态（`kind: 'recall'`，每轮一行）。Host 只记哪个会话、哪一轮、几次（`recalls`，每个归属最多 64 轮），不记查了什么词；不写审计，因为它不改变任何东西。

### 定时提议

`propose_schedule(name, plan, prompt)` 与 `propose_memory` 走同样的路径和存储：`proposals` 里 `kind: 'schedule'`、`schedule: { name, plan }`，`content` 是每次运行的输入（最多 4000 字，连续空行合为一个）。上限、密钥检查、外部内容标记与审计都相同。

- `plan` 按 `schedule.ts` 的 `scheduleSchema` 检查，不符时用英文拒绝给 Agent（400 `agent-schedule-invalid`）。技能服务写入文件前按同样的形状拒绝，Host 读到时再查一次。
- 人的「记住…」不建定时提议。它不能当记忆保存（409 `agent-proposal-kind`），资料面板的「记忆」也不列它。
- 定时提议从不创建或运行任何东西。人在定时编辑里保存：`POST /automations` 带 `proposalId`，Host 先核对它是这个 Agent 的、还没处理过的定时提议，再按定时任务自己的回执创建。Agent 不能后台运行时保存为 `enabled: false`。
- 定时任务记下 `proposalId`，创建时在同一次写入里拒绝已经由它保存过的（409 `agent-proposal-decided`），所以同时的两次保存只建一个。
- 之后提议标为已保存并记下 `automationId`。这一步失败时，同一请求的重试按两边的回执补上标记；另一个请求的保存被拒绝，并用第一个定时任务补上标记。

### 外部 Harness 的通道

技能服务以 `propose` 参数启动时多两个写工具，其余只读、不联网。每次调用往会话私有目录（0700）里的 `proposals.jsonl` 追加一行：`{ content, reason? }` 或 `{ kind: 'schedule', name, plan, prompt }`。

- **文件**：0600，以 `O_NOFOLLOW`、`O_NONBLOCK` 打开，只接受只有一个链接的普通文件。每行不超过 8 KB，每个会话最多 32 行、128 KB（`PROPOSAL_LIMITS`），超出时工具返回错误。
- **读取**：ACP 驱动在每个工具调用结束和每轮结束时，从上次的偏移读新增的完整行（会话记录的 `proposalsRead`、`proposalsOffset`），逐行交给 `HarnessHostOptions.proposeMemory` 或 `proposeSchedule`。不跟随链接、不读 FIFO、只读打开时的大小。
- **只取内容**：行里只取上面几个字段，经 zod 和密钥检查。会话来自目录本身，归属由 Host 从自己的会话记录查出，从不取自文件。Host 只收这个驱动自己的、开始时上下文带 `proposals` 的会话的提议。
- **无效的行**跳过，Host 日志只记种类（`not-json`、`invalid`）；被拒绝的行照样算读过。
- **清空**：每次会话的服务启动前，Host 已取走全部完整的行就清空文件，取走的行数仍计入上限。删除会话时一并删除目录。

## 图片头像

人可以给 Agent 一张图片代替括号脸。`avatar` 这时是 `{ kind: 'image', image, bracket, eyes, hue }`：`image` 是 Host 自己重新编码的那份图片的 SHA-256，括号脸字段保留，图片显示不了时画它。快照、SSE 和读取接口里只有哈希。「通用」没有图片头像。

- **谁写 `image`**：只有上传。`POST` 与 `PATCH` 的 `avatar` 只接受 `kind: 'face'`；按 `PATCH` 选一张脸把脸放回来。
- **上传**：`PUT …/avatar-image?requestId=…&baseRevision=…`，请求体是原始字节（`application/octet-stream`，最多 2 MB）。类型只按文件头判断（`sniffImage`），不看文件名和声明的类型。
- **解码**：Host 进程自己不解析图片。PNG 交给只为这一次启动的解码进程（`avatar-image.ts`，环境变量为空，最多 10 秒、128 MB 堆，一次只跑一个），它只用 `node:zlib`，逐块核对长度与 CRC，只接受 8 位 RGB 或 RGBA、非隔行的 PNG。
- **重新编码**：先按声明的尺寸拒绝（每边 16 到 1024 像素），再按尺寸限定解压后的大小，取中间的正方形缩到 256×256，写出只有 `IHDR`、`IDAT`、`IEND` 的新 PNG。元数据与文件结尾之后的内容都不留。Host 再核对拿回来的确实是这样一张 PNG。
- **JPEG 与 WebP**：Host 没有它们的解码器。页面先拒绝超过 10 MiB 的原文件，从文件头读像素尺寸（读不出或任一边超过 8192 就拒绝，不调用浏览器解码器），解码后画成 256×256 的 PNG 再上传。
- **存放**：`agents/avatars/<哈希>.png`，0600，目录 0700，先写临时文件再改名。没有任何 Agent 再用的图片在替换、清除、选回脸或删除 Agent 后删掉；Host 启动时再清一遍，连同上传中断留下的半个文件。
- **排队**：已收下、还没回答的上传，同一台设备最多 2 个、全部设备最多 8 个，超出的在读请求体之前拒绝。
- **回执**：上传与清除（`DELETE …/avatar-image`，`{ requestId, baseRevision }`）都是这个 Agent 的一次修改，`baseRevision` 过期是 409 `agent-changed`。
- **读取**：`GET /custom-agents/avatar-images/<哈希>` 只回当前有某个 Agent 在用的哈希。响应固定为 `image/png`、`nosniff`、`Content-Security-Policy: sandbox; default-src 'none'`、`Cross-Origin-Resource-Policy: same-origin`、`Cache-Control: private, no-store`；读出时再核对文件与哈希。

| 拒绝 | 回答 |
| --- | --- |
| 不是 PNG、JPEG、WebP，或 PNG 不是上面那种 | 415 `agent-avatar-type` |
| 直接发给 Host 的 JPEG、WebP | 415 `agent-avatar-convert` |
| 超过 2 MB 或任一边超过 1024 | 413 `agent-avatar-too-large` |
| 任一边小于 16，或读不了 | 422 `agent-avatar-unreadable` |
| 排队已满 | 429 `agent-avatar-busy` |
| 哈希没有 Agent 在用 | 404 `agent-avatar-missing` |

尚未实现：iOS 上显示、上传、替换与清除图片（iOS 画保留着的括号脸）；导出文件不带图片。

## 导出与导入

人可以把一个 Agent 导出成文件，再在这台或另一台电脑上导入成一个新的 Agent。两头都是人显式做的，Agent 自己没有这个工具。「通用」不能导出。

**文件**（`AgentFile`，`format: 'latch-agent'`、`version: 1`，最多 4 MiB）只有：

- `agent`：名称、说明、`harnessId`、`mode`、指令、括号脸。
- `memories`：已确认的记忆（`content`、`savedAt`、`origin`、`external`）。
- `schedules`：定时的定义（`name`、`prompt`、`schedule`、`notify`），最多 16 个。
- `exportedAt`，与 `omitted`（因像密钥没导出的记忆与定时各几条）。

不含这台电脑自己的东西：模型与模型服务、`engineOptions`、默认项目、技能与「可以使用」、MCP 与秘密值、设备与审计记录、家、会话与提议、图片头像、本机 ID、修订号与回执。

**导出**

- `GET …/export/preview` 回 `AgentExportPreview`（几条记忆、几个定时、各省略几条），不写审计、不交出文件。人按「下载」后 `GET …/export` 才交出。
- 先写审计 `agent.exported`（Agent 的 ID、记忆与定时的条数），审计写不下就不给文件。
- 响应带 `Content-Disposition: attachment; filename="agent.latch-agent.json"`（固定的名字，Agent 的名称不进响应头）、`nosniff` 与 `Cache-Control: no-store`。

| 拒绝 | 回答 |
| --- | --- |
| 名称、指令、说明或 Harness ID 像密钥 | 422 `agent-export-secret` |
| 合格的定时超过 16 个（不省略多出的） | 422 `agent-export-schedule-limit` |
| 文件超过 4 MiB | 413 `agent-export-too-large` |

**导入**

- `POST /custom-agents/import/preview` 让 Host 按 strict schema 读一遍，回 `AgentImportPreview`：文件原样、Harness 在这台电脑上是否就绪（`harness.ready`）、定时能否导入（`canSchedule`）、是否已有同名的 Agent。预览不创建任何东西。
- `POST /custom-agents/import`（`{ requestId, file }`）**总是新建**，从不改动已有的 Agent。Harness 不存在或没就绪时 409 `agent-import-harness`。
- **记忆**标为导入（`AgentMemory.imported`：文件里的 `origin`、`external`、`savedAt`），再导出时保留原来的来源和时间。它们算资料，直到人「设为我说的」。
- **定时**以关闭状态创建，每个用 `<requestId>-s<序号>` 作请求（所以导入的 `requestId` 最多 100 个字符）。Harness 不能后台运行时不导入定时；定时已满时少建，回答的 `schedules` 如实计数。
- **审计**：Agent 与记忆在一次写入里建好，先写 `agent.imported`（新 Agent 的 ID、条数、文件的哈希）。
- **谁能导入**：任何有 `run` 与完整数据范围的设备的浏览器页面。原生连接（`isNativeListener`）不能导入也不能预览（403 `agent-import-device`），只能导出；在原生 App 里导入尚未实现。

| 拒绝（都不创建任何东西） | 回答 |
| --- | --- |
| 不是这个格式、多出字段、任何值超出 Host 自己记录的上限 | 400 `agent-import-invalid` |
| 别的版本 | 400 `agent-import-version` |
| 超过 4 MiB | 413 `agent-import-too-large` |
| 名称、指令、说明、Harness ID、记忆或定时里有像密钥的内容 | 422 `agent-import-secret` |

导入页把文件里的文字按隐藏字符规则显示（`VisibleText`）。跨电脑的 Agent 汇总尚未实现。

## 「通用」

「通用」的聊天固定使用 Standard 的 Agent 模式和 Host 模型服务，在 `helpers/general` 工作。写给它的指令和记忆也对没选别的 Agent 的会话生效；这些会话没有 `TaskSummary.agent`，仍属于 Code。

- 只有完整数据范围的设备发出的一轮才带上「通用」：模型的回复可能复述它。范围较小的设备照常工作，就像「通用」是空的。
- 一轮带上「通用」后，会话的 `TaskSummary.agentPrivate` 为真，在模型收到之前写入。此后读取与继续都要完整数据范围，即使这个会话是范围较小的设备开始的。分叉出的新会话同样私有，定时任务的每次运行也是。
- `skills` 缺省时这些会话加载全部已启用的技能；写成数组（包括空数组）后只加载这些。插件已停用或移除的技能不再加载，不影响会话开始。

## 会话

`POST /tasks` 接受 `customAgentId`。会话开始后 Agent 与 Harness 不再变，归属记录在 `TaskSummary.agent`。Agent 的会话内容只对完整数据范围的设备开放。

- **Harness**：请求里的 `harnessId` 只能是 Agent 自己的，别的得 400 `agent-harness-fixed`，什么也不开始。
- **本次选择**：`mode`、`model`、`workspaceId` 只影响这次会话，没给的取 Agent 的默认值。请求不接受客户端另传 `config`（400 `config-unsupported`）：默认项只来自定义的 `engineOptions`。
- **回执**：一个请求的选择在第一次时写入回执（`starts`），结果未知后的重试不采用后来改过的默认值。
- **位置**：`workspaceId: 'default'` 由 Host 映射为 Agent 的家，实际 cwd 与 `sessionFolder` 由分配器持有，家不登记进公共项目目录。
- **项目不可用**：Agent 自己的默认项目已移除时 409 `agent-unavailable`；这一次另选的项目不存在时与普通会话一样是 400 `workspace-unavailable`。
- **标题**：取第一条输入里第一行不是 `>` 引用的文字（`promptTitle`），带入的成果不会成为标题。
- **Agent 删除后**：它的会话保留、只读；继续输入得 409 `agent-deleted`。

**和「通用」对话**：`customAgentId: "general"` 要完整数据范围，使用 Standard 的 Agent 模式与固定的家，不接受项目、工作树或分叉（400 `general-chat-project`）。会话带 `TaskSummary.generalChat: true`，记在 Host 的会话元数据与内置 Standard 的首条消息里；外部 Harness 不能自报这个标记。带上「通用」指令的普通 Code 会话和定时运行各自保留原归属。

外部 Harness 的原生空闲命令不消耗首轮块，见 [HARNESSES.md](HARNESSES.md#会话命令)。

### 唯一聊天

Host 在 `custom.json` 的 `chats` 里为每个 Agent 与「通用」保留一个聊天槽。普通新消息只进这条聊天；历史会话可以查看，已接受的队列、审批、回答与取消仍在原会话处理。快照在完整数据范围中携带 `agentChats`（只有状态与会话 ID），客户端须看到 `catalog.features.singleAgentChat` 才开始首次聊天。

| 槽 | 含义与规则 |
| --- | --- |
| 没有槽 | 旧会话尚未核对。首次开始与归档、删除这个 Agent 的会话都得 503 `agent-chat-history-unknown` |
| `empty` | 还没有聊天。带 `customAgentId` 的 `POST /tasks` 把槽记为 `starting` |
| `starting` | 首条消息在确认。原请求（同设备、同 `requestId`）重试读取原结果；其他首次请求、删除 Agent、归档或删除它的会话都是 409 `agent-chat-starting` |
| `ready` | 记着会话 ID。原请求回答同一会话；其他首次请求是 409 `agent-chat-exists`（带 `sessionId`），草稿留在发送设备。这个会话不能归档或删除（409 `agent-chat-retained`） |

- **选定旧会话**：槽不存在时，Host 用完整的会话清单一次选定最近活动的未归档、非定时、非分叉会话，时间相同取 ID 较小的；一个都没有记 `empty`。清单不完整时等待。已有的槽不因排序变化、掉线或 Harness 暂时不可用而重选。历史不合并。
- **首次写入**：启动 Harness 之前原子记下发起设备、`requestId` 与请求摘要。同一 `requestId` 换了内容是 409 `request-conflict`；带 `forkOf` 或应用草稿是 409 `agent-chat-fork`。
- **没有开始**：请求在交给驱动之前失败，或被确定地拒绝且找不到已开始的证据时，槽回到 `empty`。
- **证据不足**：重启后按 Harness 持久的首条用户消息（同 `requestId`、同正文与附件）核对。只有完整清单和可读记录才能证明未开始并重发原请求，否则 503 `agent-chat-start-unconfirmed`，保持待确认。
- **历史会话**：向不是当前聊天的会话发新消息是 409 `agent-chat-history-read-only`；已有回执的旧请求重试照旧按回执回答。
- **删除 Agent**：保留会话和文件夹，清除记忆、提议、可撤销的修改与查询记录。
- **定时运行**仍是各自的会话，成果卡交给当前聊天；首次聊天之前结算的卡先等着。

定义的修改何时到达这条聊天：

- 内置 Harness：指令和记忆从下一轮生效；Agent 定义的模型是这条聊天的默认模型，本轮指定的模型优先。
- 外部 Harness：定义里的默认项只用于首次连接；之后模型、思考和权限按 Harness 实际报告展示，写入沿用会话设置的回执与读回，权限写入结果未知时输入框等待核对。「清空上下文」把当前指令和记忆随新上下文再送一次，聊天标识与历史保留。

`customAgentId: "general"` 的开始请求指定外部 Harness 或 `mode: chat` 时得 503 `general-start-unconfirmed`，在绑定 Harness、分配家或新建会话之前。这样的请求来自没有选择回执的旧版本，不能经 Standard 与家的路径重放；客户端保留原 `requestId` 与结果未知记录，由人重试、查看已有会话或明确放弃。

直连 Codex 的 Agent 可在同一条聊天里委派成员，见 [HARNESSES.md](HARNESSES.md#codex-的-agent-团队)。

### 待办里的 @

人在一条待办的讨论里 @ 某个 Agent（或「通用」）时，那条发言进它的唯一聊天，与人在聊天里发的消息走同一个函数（`sendPrompt`），不另开会话，也不排队（[ARCHITECTURE.md](ARCHITECTURE.md#待办的讨论)）。

- **只进已有的聊天。** 槽是 `ready` 才投递；`empty` 是 409 `agent-chat-empty`（首条消息会在标记之前开始第一轮，所以不经讨论开始聊天），`starting` 是 409 `agent-chat-starting`，没有槽 503 `agent-chat-history-unknown`。聊天在一轮中时 409 `post-target-busy`。这些都在存下发言之前拒绝。
- **记忆只取人的话。** 投递的正文是人写的那句加上引用的讨论（别的会话的回复是模型的输出）。「记住…」只看人写的那句（`rememberFromPerson` 收到的就是它），引用的内容与回复从不成为「你说的」提议。
- **外部标记。** 投递的这一轮带 `PromptOptions.outsideContent`，Driver 在记下这一轮用户消息的同一次写入里把聊天标为带外部内容（与 MCP 提示同一个持久标记：内置 Harness 的 `outsideRead`，ACP 的 `acp.outsideRead`），所以这一轮和之后各轮提出的记忆与定时都标「来自外部内容」，直到清空上下文。不能记这个标记的 Driver，Host 在交给它之前拒绝，发言记为没有送达（`post-unmarked`）。引用里每段的文字比段的标签深一层引用，回复冒充不了人的话。没有工具行会显示这一点，所以标记不看这一轮读了什么。
- **私有。** 待办在第一条 @ Agent 的发言存下之前标为私有，此后只有完整数据范围的设备能看到它和它的讨论。此后投给它的 Code 会话（较窄的设备读得到）的只有人写的那句，不带待办标题与引用。

## 家与工具

家是 Agent 的默认工作位置，不是 OS 隔离：外部 Agent 仍是可信本机程序。

- **分配**：`SessionFolders.helperHome` 在起始目录下惰性创建 `helpers/<Agent ID>`，显式指定 `--workspace` 时也如此。父目录与家设为 0700，不接管已存在的未知目录，不跟随链接。
- **身份**：根目录、父目录与家的设备号和 inode 存入 0600 的 `session-folders.json`（strict schema）。恢复时核对；改路径、替换同名目录，或与数据、程序、已登记项目重叠都拒绝（409 `helper-home-unavailable`），不移动、覆盖或删除原文件。
- **记录**：`home` 只由分配器写入 `custom.json`，先审计（`agent.home.assigned`，只有哈希），不改变定义的 revision。已分配的家不能再登记为公共项目。
- **共用**：聊天与没有显式项目的定时运行共用一个家；历史会话保留记录的 cwd。删除 Agent 从不删除家。
- **读取**：`GET …/home` 只读当前身份与策略，返回路径、可用性和原因，不因读取而建目录。文件内容仍只经所属私有会话的授权句柄读取。
- **在访达中显示**：桌面端只向主进程交 Agent ID；主进程凭自己的设备身份读上面的接口，核对真实目录后调用 `showItemInFolder`，不接受页面给的路径。

工具沿用原有的分级、审批与浏览器规则：

- 内置 Harness 可以读写家、提问与提议，远程 MCP 仍是 R2。
- 接受 MCP 的外部 Harness 同时获得 `latch-skills` 与 `latch-browser`。每次浏览器调用仍核对原目录、归档、活动轮次、取消与原风险规则；只允许执行端本机地址，外部网站尚未实现。
- pi 不接收 MCP，这些服务不发给它；权限按它实际报告的档位展示。
- 外部 Harness 的默认项（`engineOptions`）怎样在开始时设置与读回，见「字段」。

资料面板（`ProfileLayer`）跨桌面、平板与手机只挂载一个实例；切换设备、撤权或关闭资料时卸载私有内容。

## 各 Harness 如何收到

`HarnessInfo.agentContext` 与 `HarnessInfo.skills` 由 Driver 声明。没有 `agentContext` 的 Harness 不能运行 Agent。`agentContext` 的内容由 Host 构造，从不接受 HTTP 客户端传入。

**内置 Harness**（`agentContext: 'private'`，`skills: 'native'`）

- 每轮的系统提示依次是 Latch 的基础提示、指令和记忆、技能，按当前定义重新读取。
- 指令和记忆只在这一轮的运行里，不进消息、历史、分叉或导出。
- 技能随会话整段加载，按需读取尚未实现。

**外部 Harness**（`first-turn`）

- Harness 的提示和工具都保留。指令和记忆作为带标注的文本块，在第一个真正到达 Harness 的轮次排在用户输入之前发送，写出后记在那条用户消息的 `agentBrief` 上；`segments` 分开 Latch 的说明、用户写的内容与资料。
- 第一轮没有到达 Harness（进程没起来、发送前取消）时，文本块留到下一轮，重启后也一样。写出后、记录落盘前崩溃时下一轮再发一次：宁可重复，不会漏发。
- 发送过之后不再发送，改动指令不影响当前上下文；清空上下文后随新上下文的第一轮再发一次。
- `Message.text` 不含它，分叉的背景文本也不带它。pi 用自己的记录分叉时，新会话里有来源会话发过的文本块（[HARNESSES.md](HARNESSES.md#pi-的-rpc-模式)）。
- 设备开始完全访问会话时，启动审计（`task.l3.start-requested`）的 `promptHash` 覆盖这个文本块。

**外部 Harness 的技能**（`skills: 'server'`）

- Host 把所选技能复制到会话自己的目录，在 `session/new`、`resume`、`load` 时附加 stdio MCP 服务 `latch-skills`：只读工具 `list_skills`、`read_skill`，能提议的会话另有 `propose_memory`、`propose_schedule`。此外不写文件、不访问网络。没有技能的 Agent 会话也为了提议附加它。
- ACP 驱动只把带 Latch 技能服务前缀的 `propose_*` 工具行认作 Latch 自己的。
- 服务的命令是 Host 自己 Node 程序的绝对路径，环境变量为空，所以只接受绝对路径 stdio 服务的 Harness 也能启动它。
- 预设以 `skillServer: false` 声明不接受 MCP 的 Harness（pi）：它们没有 `HarnessInfo.skills`，技能不发送，界面据此提示。
- 其余预设是否实际取用技能，尚未逐一在真实 Agent 上验证。

## 界面

布局、尺寸与组件见 [DESIGN.md](DESIGN.md)；这里只写界面必须守住的规则。界面只展示 Host 给出的状态，写入规则见本节「写入」。

**两个空间**

- Code 与我的 Agent 只在 `catalog.features.customAgents` 存在时分开。开关切换空间，不是筛选。
- 会话属于哪边只看 `TaskSummary.agent` 与 `TaskSummary.generalChat`（`sessions.ts` 的 `spaceOf`）：某个 Agent 的会话与「和通用的对话」在我的 Agent，其余（包括带上「通用」的 Code 会话）在 Code。组件不各写一份判断。
- 每台设备记住上次所在的空间（本地存储 `latch.space.<来源>.<设备>`），从不发给 Host。
- 另一边有等你处理的会话时，开关上带琥珀点。每边只算自己的列表能显示的会话；Host 列不出的审批会话只算进总数。
- 桌面端「显示」菜单的「Code」「我的 Agent」只对订阅了 `latch:space:ready` 的窗口启用；主进程只把空间名经 `latch:space` 发给页面，preload 只放行这两个值。

**名册、总览与聊天**

- 名册（`roster.ts`）全部由快照的摘要算出。切换对话与看板不改变所在的 Agent、阅读位置和草稿。
- 仍有会话的已删除 Agent 写「已删除的 Agent」；摘要因写入结果未知暂缺时不推断谁被删除。断线时保留最后的状态并标「上次状态」。
- 点 Agent、旧深链或命令面板总是打开 Host 指定的聊天（`chat.ts`）。还没有聊天时首条消息开始它；另一台设备已经开始时，草稿可以带入已有聊天。
- 总览（`AgentsHome.tsx`）按 Host 的组（`board.group`）分「等你处理」「在工作」，另有「最近结果」。Agent 的会话没有交付，所以没有「可交付」。
- 删除 Agent 用原删除接口；已发送但结果未知的删除留在当前页面内存，用原 `requestId` 重试，「放弃等待」只清本页的记录。

**像一个人**（`personWords.ts`）

- 我的 Agent 的会话里，作者是 Agent 的头像与名字，不写 Harness、模型、tokens 与上下文；演示模型回答时仍标「演示」。只有要人去处理的「<Harness> 还没登录」写 Harness 的名字。
- 工具行、审批卡的内容与 Host 写的失败原因原样不改。
- 输入框没有 Harness、模型、思考与权限控件，安全事实改写在名字旁：权限读不回时琥珀色「权限没确认」，执行前不询问时琥珀色「不先问你」，原因是它的提示框。外部 Harness 始终保留「Latch 不隔离」的说明入口，创建第二步与设置里也有。
- 模型路线绕过 Latch 或下一轮不可用时，输入框下保留警告与完整原因。

**头像**

- 状态只由这个 Agent 的会话推出，优先级：等你处理 > 运行中 > 休息（摘要 `available: false`）> 最近一次未归档会话失败 > 空闲。状态词始终写在旁边，头像只陪衬。
- 全页一个调度器（`avatarMotion.ts`），只驱动视口内的头像，页面隐藏时停。系统的减少动态效果、根元素 `data-motion="reduce"` 或截图用的 `data-capture="still"` 时不动，配件静态显示。
- 「我的 Agent」的入口都用同一个单色图标 `AgentsGlyph`。

**电脑**（`GET …/computer`）

- 状态词只来自 Host：连得上「在线」；Host 宣布过睡眠且之后没连上「睡眠中」；桌面端报告正在保持唤醒「保持唤醒中」；其余「不在线」。从不写「永远在线」。
- `missed` 是这个 Agent 开启着的定时任务各自上一次真实运行之后错过的时间（[AUTOMATIONS.md](AUTOMATIONS.md#运行与状态)），每个时间带原因 `sleep`、`off` 或 `unknown`。只有已经结束的睡眠或有序停止的记录盖住它时才说原因，其余一律 `unknown`。
- 记录在 `agents/computer.json`：桌面端经 host.sock 报告的睡眠与醒来、Host 有序停止到下次启动的时段，各最多 32 段，strict schema，只有时间。读不了的文件移到一边（`computer.json.invalid-<时间>`），从空记录开始，不影响 Host 启动。
- 「到点前后保持唤醒」需要 `run`；桌面端没有在报告时写明它现在不起作用。「通用」只有状态与错过的时间。

**新建**（`HelperCreate.tsx`）

- 候选是每个就绪、有 `agentContext`、不是 `offer` 的 Harness（`agentHarnesses`）。没就绪的不能选，写出原因。
- 卡上的句子和能力标签来自预设的 `helperCard`（内置是 `BUILTIN_HELPER_CARD`，各带出处 `source`），只列做得到的：Harness 报告不能运行命令时去掉「跑命令」，「上网」在真实 Harness 上核对之前不写。没有预设的 Harness 只有名字。
- 执行前不询问的 Harness（`HarnessInfo.permission.approvals === 'none'`）带琥珀色「不先问你」。
- 创建这一步的「做事前」只读：在这里设置其他档位尚未实现。

**提议与结果卡**

- 提议排在它来自的那一轮之后，写来源（「你说的」「它推断的」）与琥珀色「来自外部内容」。保存中、已保存、不要了、结果未知与失败都以 Host 为准。
- 定时结果卡的规则见 [AUTOMATIONS.md](AUTOMATIONS.md#结果回到对话)。同一处多于 3 张时只画最新的 3 张，其余进「动态」。卡不是消息，Harness 收不到。
- 失败与中断的卡按错误码给下一步：可重试的是「立即运行」，Harness 与模型服务类只在那台 Mac 上打开设置，其余在运行的会话里处理。

**动态与资料库**（`agent-activity.ts`）

- 都只来自 Host 已有的记录，不另记事件。只算为这个 Agent 运行的会话：定时任务移到别的 Agent 后，之前的运行仍在原来的 Agent。
- 动态里记忆只写增加、修改、删除，不写文字。
- 资料库按会话分组：每轮改动记录里这一轮自己改动的文件，以及人给它的附件。另一个会话同时在同一文件夹运行的那一轮整轮不列。运行期间观察到的产物（[FILE-OUTPUTS.md](FILE-OUTPUTS.md)）可能混有别的会话的写入，不用。结果卡的文件也是这样。
- 一页最多读 24 个会话的详情，每组最多 30 项。文件在所属会话里用现有的预览打开，沿用那个会话的文件规则。

**写入**

- 修改带打开表单时的 `baseRevision`，只发改了的字段；`agent-changed` 显示为已在别处修改并可载入最新。
- 结果未知时保留原请求，「重试同一请求」原样重发，期间不能做别的修改。
- 首条消息的待确认请求单独存放，不占用草稿。「放弃这次提交」只在这台设备上放下它，文字回到输入框。
- 没有完整数据范围的设备看到「这台设备看不到 Agent」，不显示空列表；`agent-write-unknown` 时显示正在确认并稍后重读。

**通知**：`notifications` 的三个开关由桌面端过滤（[NOTIFICATIONS.md](NOTIFICATIONS.md)）。iPhone 与 iPad 只在 App 在前台时为「等你处理」发通知，按 Agent 区分尚未实现。MCP 的挂载见 [MCP.md](MCP.md)，定时的界面见 [AUTOMATIONS.md](AUTOMATIONS.md#界面)。

**iPhone 与 iPad**

- 手机只在正文窗口内拿到快照的 `customAgents`、`automations`、`agentProposals`、`agentResults` 与 `computer`。窗口外不显示任何 Agent 的名称、职责、记忆与定时，会话页头只写「我的 Agent」。
- 离线保存的列表不含这些；窗口关闭、锁定或撤权时从内存撤下，已推入的编辑页也撤下，持久的未知请求保留。读取资料只用已有的窗口，不隐式请求 Face ID。
- 会话属于哪边与网页相同（`PhoneSpaces`）。选中一个 Agent 打开 Host 指定的唯一聊天；首条消息经同一 `POST /tasks` 带 `customAgentId`。
- 所有写入占用手机唯一的待确认写入（`PhoneAgentWrites`）。结果未知时除「重试同一请求」外还有「核对并放下」：按 Host 现在的状态说明，并放下这台设备上的这一项。
- 只有 Host 的 `agent-write-unknown` 表示正在确认先前的修改；普通读取的 408 与 5xx 显示读取失败，连接超时显示离线，都不改动待确认写入。
- 提议、记忆与标题里的隐藏字符画成 `\u{…}`。Harness 与模型服务类的下一步只在那台 Mac 上，手机不给。
- 尚未实现：已有 Agent 的名字、职责、指令和头像编辑，修改定时任务与不经提议新建定时任务，带入上次成果，列表下的「最近对话」。

### 状态词

只来自 Host 已有的事件，没有事件不说话。

聊天里的运行行（`personStatus`）按最新一条运行中的工具行与阶段写细词：

| 来源 | 词 |
| --- | --- |
| 子 Agent | 在分头做 |
| MCP 工具（`mcp__<服务器>__…`） | 在用 <服务器> |
| `browser_*` | 在看网页 |
| `read_file`、`list_files`、`list_folders`，种类 `read` | 在看文件 |
| 种类 `search` | 在找东西 |
| 种类 `fetch` | 在查资料 |
| 种类 `edit`、`delete`、`move` | 在写文件 |
| 种类 `execute` | 在跑命令 |
| 种类 `think`；推理在流或在等模型 | 在想 |
| 其他或不明的工具 | 在动手 |
| 正文在流 | 在回复 |
| `starting` | 在准备 |
| 审批与提问 | 等你点头（琥珀） |
| 停止中 | 在停下 |

工具行没有种类时由 `toolKind` 按工具名猜。名册与总览只有摘要的 `RunLive.activity`，写粗词（`personActivity`）：`starting` 在准备、`model` 在想、`command` 在跑命令、`tool` 在动手、`approval` 等你点头、`cancelling` 在停下。失败写「失败」，长时间没有事件写「没有动静」。
