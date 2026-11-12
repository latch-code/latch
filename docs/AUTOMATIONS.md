---
description: 定时任务：任一 Harness 上的定时运行、开启与暂停、错过的时间、运行记录。
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

定时任务按时用一个 Agent 新开会话，做一件保存好的事；每次运行都是新的会话，所以总从新的上下文开始，不带上一次的对话。可以用任一 Harness：选了外部 Harness 的 Agent 就在它上面运行，开启不需要确认，每次运行都写启动审计（`task.l3.started`，带第一条输入的哈希）。`catalog.features.automations` 声明下面的接口。定义在 `automations.json`。

| 接口 | 作用 |
| --- | --- |
| `GET`、`POST /automations` | 列表；新建，保存后即开启；带 `proposalId` 时是从 Agent 的定时提议保存（见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#定时提议)） |
| `GET`、`PATCH`、`DELETE /automations/:id` | 详情与运行记录（最近 50 次运行，另有最近 50 个错过或跳过的时间）；修改；删除。运行中不能修改或删除 |
| `POST /automations/:id/enabled` | `{requestId,baseRevision,enabled}` |
| `POST /automations/:id/run` | 立即运行，开或关都可以，不影响下一次时间；已有两个在运行时拒绝（`automation-limit-running`） |

快照的 `automations` 不含 `prompt`。

## 字段

`customAgentId` 缺省时用「通用」。`model` 缺省时用 Agent 的模型，「通用」用 Host 的默认模型。`projectId` 缺省时每次运行在启动目录下有自己的文件夹。`notify` 表示希望结果出来时通知；通知由客户端根据运行记录发出。

`schedule` 是 `{kind:'daily'|'weekdays',time}` 或 `{kind:'weekly',day,time}`（`day` 的 0 是周日），时间按这台 Mac 当前的时区计算，Mac 换时区后跟着重新计算。时钟跳过的时间当天不运行，重复的时间只在第一次运行。今天已经运行过后把时间改到今天更晚，今天还会再运行一次；只改名字等其他字段不会。

## 谁可以开启

任何可读取 Agent（要完整数据范围 `all`）、有 `run` 权限的设备都可以保存和开启，范围与它自己能开始的会话相同，与它在哪台设备上无关。开启它的设备是这个定时任务的授权来源：开启和每次运行前都复查这台设备仍可使用、有 `run` 与完整数据范围，并在 `unattended.pauseAfterIdleDays` 天内连接过；不符合时不能开启，已开启的暂停。`policy.json` 的 `unattended.maxLevel` 低于 L1 时不能开启或运行。

## 运行与状态

`state` 是 `off`、`ready`、`running`、`paused`。每次运行前都复查设备、策略和执行配置，配置变了就暂停而不是运行。

**暂停**时 `enabled` 变为 `false`，`pause` 给出原因和一句话：配置（模型、插件、策略）变了、开启它的设备已不能运行、Agent 或项目不可用、上次结果未知、审计写入失败。只有重新开启才恢复，修改字段不会。通过接口修改 Agent 或它的记忆时，定时任务会跟着新定义继续运行，保存与重新绑定之间的检查不会暂停它；删除 Agent 则暂停。插件正在更新这类一时的情况不算：检查时等下一次检查，已经开始的这次记为 `failed`，定时任务保持开启。

**运行记录**的 `state` 是 `running`、`waiting`（在等审批）、`completed`、`failed`、`cancelled`、`interrupted`、`unknown`、`missed`、`skipped`。运行是一个会话，`TaskSummary.automationId` 指向定时任务，标题是它的名字；它显示保存的提示，所以读取要完整数据范围，与定时任务本身相同。

**错过的时间**：Mac 关机、睡眠、Host 没有运行或正在安装更新（启动得到 409 `host-updating`）时错过。调度器按自己的计划逐个算出这段时间里每一个到点的时间，各记一条 `missed`（Mac 睡了三天，每天一次的定时记三条）。只留最新的 50 个错过或跳过的时间，与最近 50 次真实运行分开保留，所以错过再多也不挤掉运行记录；计算只从够算出这 50 个的时间往后走（每天 52 天、工作日 75 天、每周 52 周），醒来前一分钟内到点的那一次照常运行。定时任务保持开启，下一次照常。不会补跑，也不会在醒来时一起运行；需要时用立即运行。资料面板的「电脑」列出开启着的定时任务上一次真实运行之后错过的时间与原因（[CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#界面)）。

**运行期间经过的时间**：上一次运行还没结束时到了下一个时间，结束时补记一条 `skipped`，同样不补跑。`lastRun` 仍是那次真实运行的结果。

**没有人看着时**：运行照常在每个审批处停下，超过审批时限（`unattended.approvalTtlHours.standard`）后取消，不会自动批准。结果未知的启动不会重发。

**同时最多两个运行**：到点时已有两个在运行，这一次排队，有位置时按到点先后开始，不算错过；排队期间 Host 重启则记为 `missed`。

## 到点前后保持唤醒

Agent 的 `keepAwakeForSchedules` 打开时，Latch 应用（桌面端）在它的定时任务到点前 2 分钟起保持这台 Mac 不闲置睡眠，直到这次运行结算，一次最长 32 分钟（`SCHEDULE_LEAD_MS` 加 `SCHEDULE_HOLD_MS`），插电与用电池都一样，与设置里「有会话时保持唤醒」的开关无关。

- Host 只给时间：`host-info`（只在 host.sock）的 `scheduleWake` 是打开了这一项的 Agent 的定时任务里最早的 `nextRunAt`，以及它们正在进行的定时运行数（每次运行只在到点后 30 分钟内计入，所以不结算的运行不会一直让 Mac 醒着）；没有 ID。写入结果未知时为空。
- 由主进程决定（`createKeepAwake`）：用同一个 `powerSaveBlocker`（`prevent-app-suspension`），自己的计时器在窗口开始时生效，不等下一次读取；到上限就放开，直到不再临近定时才重新计。页面只得到视图（`cause: 'schedule'`）。
- 它不改系统的唤醒计划（不用 `pmset`，不需要管理员权限），不能唤醒已经睡眠或合上盖子的 Mac；Latch 应用没有运行时不起作用，界面这样写。
- 桌面端把正在保持唤醒的原因经 `POST /link/api/host/state`（`{ state: 'desktop', keepAwake: 'busy' | 'schedule' | null }`，只在 host.sock，页面经代理 403）在每次变化时、换了 Host 实例时立即、至少每 25 秒报告一次，只有 Host 收下的才算发过，退出时报告 `null`。它与睡眠、停止的报告同一级别：经 host.sock、不带设备凭据，所以同一用户的本机进程也能报告，Host 只把它当作展示用的状态，不据此授予任何东西；Host 只在内存里记下，一分钟没有报告就当作桌面端没有运行。睡眠与醒来的报告另记在 `agents/computer.json`，用来说明错过的原因。

## 结果回到对话

一次运行结算（完成、失败、停止、中断或结果未知）时，Host 记一张结果卡，放进这个 Agent 的对话（不指定 Agent 的定时任务放进「通用」的对话）。卡在 `automations.json` 的 `results`（strict schema，每个 Agent 最多 64 张、合计最多 256 张，最早的先丢），与结算写在同一次写入里：ID 由定时任务与这次运行的请求得出，Host 重启后再结算同一次运行也只有一张。启动就被拒绝的运行（例如默认项目已移除）同样记一张失败的卡，写 Host 的原因；因安装更新错过的时间不是运行，不记卡。

- **放在哪个话题**：结算时这个 Agent 的当前话题（最近活动过、未归档、不是定时运行的会话，与页面的判断相同）；那时还没有话题的卡等着（`GET /custom-agents/:id/results`），这个 Agent 下一次新开的话题收下它们。话题删除后，它收下的卡回到等着；运行的会话删除后，卡上取自它的回复、文件与原因一并删去，只留「运行的会话已删除」。Host 一知道删除就记在内存里，之后写下的卡在同一次写入里核对；写入失败时每次检查重试；启动后核对一次所有卡的会话是否还在，Host 没有运行时删掉的也照此处理。
- **卡上写什么**：名称（结算时的）、结果、运行的会话 ID、最后一条回复的前 2000 字、这次运行改动的文件（每轮改动记录，不含另一个会话同时在同一文件夹运行的轮次，最多 20 个，另记个数）、没有完成时失败说明的原因（300 字）与它的错误码。Host 读这些时会等运行结束后两秒的文件观察结束，最多 6 秒。定时任务移到别的 Agent 时记下时间，之前的运行留在原来的 Agent 的「动态」里。
- **不是消息**：卡是 Host 的记录，只在会话详情的 `results` 里给能读这个话题的设备（完整数据范围），Harness 收不到，话题的上下文与历史不变。快照的 `agentResults` 只有每个 Agent 等着的张数与最近的时间，页面据此重新读取。

## 界面

定时任务在「我的 Agent」里这个 Agent 的资料面板中（「通用」的是不指定 Agent 的那些），只在 `catalog.features.automations` 存在时出现：「即将进行」每条写名称与计划，带开关；「编辑」或「新建定时」进入下面的列表与表单，宽窗口在右侧面板，手机在底部面板。快照暂时没有 `automations`（另一项写入的结果在确认中）时显示正在确认，不显示空列表。

- **每一项**：名称；「每天 / 工作日 / 每周几 HH:MM · 下次 · 上次 结果」，时间按这台设备的时钟写成「今天 / 明天 / 11月17日 09:00」；工作位置（项目，或「每次新的文件夹」）和每次输入的第一行（读自详情路由）；状态词「已开启 / 运行中 / 已关闭」，暂停时是琥珀色「已暂停」，ⓘ 里是 Host 给的 `pause.message`。上一次真实运行之后错过或跳过的时间合计为琥珀色「错过 N 次」，ⓘ 里逐条写时间和原因。
- **运行记录**：详情路由的最近 50 条，第一项默认展开，先显示 5 条。有 `sessionId` 的一行打开那个会话；`missed` 与 `skipped` 写「没有运行」，ⓘ 里是原因（Mac 关机、睡眠或 Latch 没有运行 / 上一次运行还没结束，都不补跑）。
- **新建 / 编辑**：名称、重复（每天、工作日、每周与星期）、几点、工作位置、每次的输入、「结果出来时通知我」。工作位置是一个项目，或「不选项目」（每次在启动目录下有自己的文件夹）：Agent 有默认项目时预填它，表单里看得见也能改，保存就是选择；没有默认项目时必须手动选。输入是每次运行的第一条消息，要用的文件写出它在工作位置里的路径；附加文件尚未实现。模型不在表单里，按「字段」的缺省取值。编辑带打开表单时的 `baseRevision`，只发改了的字段，清除项目发 `projectId: null`；运行中不能编辑或删除。
- **操作**：「暂停」「继续」（暂停后是「重新开启」）经 `/enabled`；「立即运行」经 `/run`；「删除」先确认。每个写入都带 `requestId`，结果未知时保留原请求并显示「重试同一请求」，期间不能做别的修改；`automation-changed` 显示为已在别处修改并可载入最新；Host 的拒绝（如 `automation-owner`、`automation-limit-running`）原样显示。
- **不能做时**：没有 `run` 的设备只看列表和记录，不显示任何操作，提示「只能查看」；Mac 离线时操作都不可用；Agent 的 `canAutomate` 为假时不能新建、继续或立即运行，提示里是 `unavailableReason`，暂停和删除仍可用。
