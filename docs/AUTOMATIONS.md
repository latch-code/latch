---
description: 保存的任务：手动运行、受无人值守上限约束的定时运行、开启与暂停、运行记录。
sources:
  - apps/host/src/automations.ts
  - apps/host/src/computer.ts
  - apps/desktop/src/lifecycle.cjs
  - apps/host/src/schedule.ts
  - apps/host/src/agent-plans.ts
  - apps/host/src/routes/automations.ts
  - apps/host/src/server.ts
  - packages/protocol/src/automations.ts
  - apps/web/src/agents/Schedules.tsx
  - apps/web/src/agents/scheduleModel.ts
  - apps/web/src/agents/ResultCard.tsx
  - apps/web/src/agents/TopicResults.tsx
---
# 定时任务

定时任务按时用一个 Agent 新开会话，做一件保存好的事。每次运行都是新的会话，从新的上下文开始，不带上一次的对话。

- 后台执行受无人值守等级上限约束，不会自动批准任何东西。
- 等级超过上限的 Harness（外部 L3）只能保存为关闭的任务，由有权限的人点「立即运行」。L3 的人工运行沿用启动审计（`task.l3.started`）。
- `catalog.features.automations` 声明下面的接口。定义在 `automations.json`，最多 128 个（409 `automation-limit`）。

| 接口 | 作用 |
| --- | --- |
| `GET`、`POST /automations` | 列表；新建，默认保存并开启，`enabled: false` 只保存为关闭状态且不授予后台执行权限；带 `proposalId` 时是从 Agent 的定时提议保存（[CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#定时提议)） |
| `GET`、`PATCH`、`DELETE /automations/:id` | 详情与运行记录；修改；删除。运行中不能修改或删除（409 `automation-running`） |
| `POST /automations/:id/enabled` | `{ requestId, baseRevision, enabled }` |
| `POST /automations/:id/run` | 立即运行（202），开或关都可以，不影响下一次时间；已有两个在运行时拒绝（409 `automation-limit-running`） |

读写的权限与 Agent 相同：读要 `view` 加完整数据范围，写要 `run` 加完整数据范围。每个写入带 `requestId` 并按回执回答重试；`baseRevision` 过期是 409 `automation-changed`。审计动作是 `automation.changed` 与 `automation.ran`。快照的 `automations` 不含 `prompt`。

## 字段

| 字段 | 规则 |
| --- | --- |
| `customAgentId` | 缺省时用「通用」 |
| `model` | 缺省时用 Agent 的模型；「通用」用 Host 的默认模型 |
| `projectId` | 缺省时每次运行在所属 Agent 的家里（通用为 `helpers/general`）。不同运行共用目录，文件观察仍排除同时写同一目录的轮次 |
| `prompt` | 每次运行的第一条消息 |
| `notify` | 希望结果出来时通知；通知由客户端根据运行记录发出 |
| `schedule` | `{ kind: 'daily' \| 'weekdays', time }` 或 `{ kind: 'weekly', day, time }`，`day` 的 0 是周日，`time` 是 `HH:MM` |

时间按这台 Mac 当前的时区计算，Mac 换时区后重新计算。时钟跳过的时间当天不运行，重复的时间只在第一次运行。今天已经运行过后把时间改到今天更晚，今天还会再运行一次；只改名字等其他字段不会。

## 谁可以开启

**手动**：任何有 `run` 与完整数据范围的设备都可以保存关闭的任务和手动运行，范围与它自己能开始的会话相同。

- 手动运行在记录和审计中是 `trigger: manual`，只使用当前调用者的授权，不产生后台授权。
- 审批沿用普通会话，不附加无人值守的审批时限。

**后台**：开启后台执行的设备是定时任务的授权来源（`grant.deviceId`）。开启、恢复和每次运行前都复查，任何一项不符就是 403 `automation-owner`，已开启的暂停：

- 这台设备仍可使用，有 `run` 与完整数据范围；
- 它在 `policy.json` 的 `unattended.pauseAfterIdleDays` 天内连接过（默认 14）；
- Harness 的实际等级不超过 `unattended.maxLevel`。上限只能是 L0–L2（默认 L1），按实际等级核对，不能把外部 L3 Agent 当作 L1。

只有 Host 调度器创建 `trigger: schedule` 并给会话 `unattended: true`；客户端不能指定或伪造来源。

**授权的依据**（`grant.basis`）：开启时 Host 把这次运行会用到的东西算成一个哈希，每次运行前重算，不同就暂停而不是运行。它覆盖：

- 定时任务的 `customAgentId`、`projectId` 与 `prompt`；
- Agent 的 `definitionHash`（指令、技能、工具、Harness、模式、模型、记忆等，见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md)）；
- 实际使用的 Harness、模式、模型与可用工具的插件；
- 这些插件各自的修订；
- `policy.json` 的哈希、起始目录与项目的文件夹。

插件的修订不能跨重启核对（`grant.persistent` 为假）时，Host 启动即暂停这样的任务。

经接口修改 Agent 或它的记忆时，授权随 `definitionHash` 重新绑定到修改的设备，定时任务跟着新定义继续运行；`definitionHash` 之外的修改（名称、说明、头像）不移动也不暂停。

## 运行与状态

`state` 是 `off`、`ready`、`running`、`paused`。

**暂停**时 `enabled` 变为 `false`，`pause` 给出原因和一句话。只有重新开启才恢复，修改字段不会。

| `pause.reason` | 何时 |
| --- | --- |
| `definition-changed` | 授权的依据变了（模型、插件、策略等），或它不能跨重启核对 |
| `owner-unavailable` | 开启它的设备已不能运行 |
| `agent-unavailable` | Agent（含已删除）、模型或项目不可用 |
| `unknown-outcome` | 上一次启动的结果未知；不重发 |
| `audit-unavailable` | 审计写入失败，这次没有运行 |

一时的情况不算（`plugin-busy`、`automation-changed`、`agent-write-unknown`、`host-updating`）：检查时等下一次检查；已经到点的这次，启动被这样拒绝时记为 `failed`（`host-updating` 记为 `missed`），定时任务保持开启。其他原因拒绝的启动记为 `failed` 并暂停。

**运行记录**的 `state` 是 `running`、`waiting`（在等审批）、`completed`、`failed`、`cancelled`、`interrupted`、`unknown`、`missed`、`skipped`。

- 运行是一个会话，`TaskSummary.automationId` 指向定时任务，标题是它的名字。它显示保存的提示，所以读取要完整数据范围。
- 保留最近 50 次真实运行，另保留最近 50 个错过或跳过的时间，两者互不挤占。

**错过的时间**（`missed`）：Mac 关机、睡眠、Host 没有运行或正在安装更新（启动得到 409 `host-updating`）时错过。

- 到点后一分钟内开始的照常运行，更晚就算错过。
- 调度器按计划逐个算出这段时间里每一个到点的时间，各记一条（Mac 睡了三天，每天一次的定时记三条）。回看只从够算出 50 个的时间开始：每天 52 天、工作日 75 天、每周 52 周。
- 不补跑，也不在醒来时一起运行；定时任务保持开启，下一次照常。需要时用立即运行。

**运行期间经过的时间**（`skipped`）：上一次运行还没结束时到了下一个时间，结束时补记一条，同样不补跑。`lastRun` 仍是那次真实运行的结果。

**没有人看着时**：定时触发的运行照常在每个审批处停下，不会自动批准；从到点起超过 `unattended.approvalTtlHours.standard`（默认 8 小时）仍在等审批就取消。

**同时最多两个运行**：到点时已有两个在运行，这一次排队，有位置时按到点先后开始，不算错过；排队期间 Host 重启则记为 `missed`。

## 到点前后保持唤醒

Agent 的 `keepAwakeForSchedules` 打开时，桌面端在它的定时任务到点前 2 分钟起保持这台 Mac 不闲置睡眠，直到这次运行结算，一次最长 32 分钟（`SCHEDULE_LEAD_MS` 加 `SCHEDULE_HOLD_MS`）。插电与用电池都一样，与设置里「有会话时保持唤醒」的开关无关。

- **Host 只给时间**：`host-info`（只在 host.sock）的 `scheduleWake` 是打开了这一项的 Agent 的定时任务里最早的 `nextRunAt`，和它们正在进行的定时运行数；没有 ID。每次运行只在到点后 30 分钟内计入，所以不结算的运行不会一直让 Mac 醒着。写入结果未知时为空。
- **主进程决定**（`createKeepAwake`）：用同一个 `powerSaveBlocker`（`prevent-app-suspension`），自己的计时器在窗口开始时生效，不等下一次读取；到上限就放开，直到不再临近定时才重新计。页面只得到视图（`cause: 'schedule'`）。
- **做不到的**：它不改系统的唤醒计划（不用 `pmset`，不需要管理员权限），不能唤醒已经睡眠或合上盖子的 Mac；桌面端没有运行时不起作用。界面这样写。
- **报告**：桌面端把保持唤醒的原因经 `POST /link/api/host/state`（`{ state: 'desktop', keepAwake: 'busy' | 'schedule' | null }`，只在 host.sock，页面经代理 403）在每次变化时、换了 Host 实例时和至少每 25 秒报告一次，退出时报告 `null`。
- **报告不是授权**：它经 host.sock、不带设备凭据，同一用户的本机进程也能报告。Host 只把它当作展示用的状态，只记在内存里，一分钟没有报告就当作桌面端没有运行。
- 睡眠与醒来的报告另记在 `agents/computer.json`，用来说明错过的原因（[CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#界面)）。

## 结果回到对话

一次运行结算（完成、失败、停止、中断或结果未知）时，Host 记一张结果卡，交给这个 Agent 的聊天；不指定 Agent 的定时任务交给「通用」的聊天。

- **记录**：卡在 `automations.json` 的 `results`（strict schema），每个 Agent 最多 64 张、合计最多 256 张，最早的先丢。它与结算在同一次写入里；ID 由定时任务与这次运行的请求得出，重启后再结算同一次运行也只有一张。
- **不是运行的也记**：启动就被拒绝的运行（例如默认项目已移除）记一张失败的卡，写 Host 的原因。因安装更新错过的时间不是运行，不记卡。
- **放在哪**：结算时 Host 为这个 Agent 确定的那条聊天（[CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#唯一聊天)）。那时还没有聊天，或 Agent 记录的写入结果未知，卡就等着（`GET /custom-agents/:id/results`）；聊天开始或选定时收下它们，排在第一条消息之前。
- **会话删除后**：聊天删除后，它收下的卡回到等着。运行的会话删除后，卡上取自它的回复、文件与原因一并删去，只留「运行的会话已删除」。Host 一知道删除就记在内存里，之后写下的卡在同一次写入里核对；写入失败时每次检查重试；启动后核对一次所有卡的会话是否还在。
- **卡上写什么**：结算时的名称、结果、运行的会话 ID、最后一条回复的前 2000 字、这次运行改动的文件（最多 20 个，另记个数）、没有完成时的原因（300 字）与错误码。文件取自每轮改动记录，不含另一个会话同时在同一文件夹运行的轮次。Host 读这些时等运行结束后的文件观察，最多 6 秒。
- **不是消息**：卡是 Host 的记录，只在会话详情的 `results` 里给能读这条聊天的设备。Harness 收不到，上下文与历史不变。快照的 `agentResults` 只有每个 Agent 等着的张数与最近的时间。
- 定时任务移到别的 Agent 时记下时间，之前的运行留在原来的 Agent 的「动态」里。

## 界面

定时任务在这个 Agent 的资料面板里（「通用」的是不指定 Agent 的那些），只在 `catalog.features.automations` 存在时出现。写入前 Host 再次核权，界面状态不是授权来源。

- **确认中**：快照暂时没有 `automations`（另一项写入的结果在确认中）时显示正在确认，不显示空列表。
- **状态**：「已开启 / 运行中 / 已关闭」；暂停是琥珀色「已暂停」，原因是 Host 给的 `pause.message`。上一次真实运行之后错过或跳过的时间合计为琥珀色「错过 N 次」，逐条写时间和原因，都写明不补跑。时间按这台设备的时钟显示。
- **表单**：工作位置预选「家」，定时提议也一样；项目要明确选择，不隐式继承 Agent 的默认项目。模型不在表单里，按「字段」的缺省取值。附加文件尚未实现：要用的文件在输入里写出它在工作位置里的路径。
- **写入**：编辑带打开表单时的 `baseRevision`，只发改了的字段，清除项目发 `projectId: null`。结果未知时保留原请求并显示「重试同一请求」，期间不能做别的修改。Host 的拒绝（如 `automation-owner`、`automation-limit-running`）原样显示。
- **不能做时**：没有 `run` 的设备只看列表和记录。Mac 离线或 Agent 不可用时不能新建和运行。Agent 可用但 `canAutomate` 为假时显示「仅手动运行」：新建保存为关闭状态，不能开启，「立即运行」、暂停和删除仍可用。
