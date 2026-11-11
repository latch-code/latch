---
description: 定时任务：任一 Harness 上的定时运行、开启与暂停、错过的时间、运行记录。
sources:
  - apps/host/src/automations.ts
  - apps/host/src/schedule.ts
  - apps/host/src/agent-plans.ts
  - apps/host/src/routes/automations.ts
  - apps/host/src/server.ts
  - packages/protocol/src/automations.ts
  - apps/web/src/agents/Schedules.tsx
  - apps/web/src/agents/scheduleModel.ts
---
# 定时任务

定时任务按时用一个 Agent 新开会话，做一件保存好的事；每次运行都是新的会话，所以总从新的上下文开始，不带上一次的对话。可以用任一 Harness：选了外部 Harness 的 Agent 就在它上面运行，开启不需要确认，每次运行都写启动审计（`task.l3.started`，带第一条输入的哈希）。`catalog.features.automations` 声明下面的接口。定义在 `automations.json`。

| 接口 | 作用 |
| --- | --- |
| `GET`、`POST /automations` | 列表；新建，保存后即开启 |
| `GET`、`PATCH`、`DELETE /automations/:id` | 详情与最近 50 条运行记录；修改；删除。运行中不能修改或删除 |
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

**错过的时间**：Mac 关机、睡眠或 Host 没有运行时错过，记一条 `missed`，定时任务保持开启，下一次照常。不会补跑，也不会在醒来时一起运行；需要时用立即运行。

**运行期间经过的时间**：上一次运行还没结束时到了下一个时间，结束时补记一条 `skipped`，同样不补跑。`lastRun` 仍是那次真实运行的结果。

**没有人看着时**：运行照常在每个审批处停下，超过审批时限（`unattended.approvalTtlHours.standard`）后取消，不会自动批准。结果未知的启动不会重发。

**同时最多两个运行**：到点时已有两个在运行，这一次排队，有位置时按到点先后开始，不算错过；排队期间 Host 重启则记为 `missed`。

## 界面

定时任务在「我的 Agent」的 Agent 页（和「通用」页）的「定时」标签里，只在 `catalog.features.automations` 存在时出现；手机上同样在推入的 Agent 页里。快照暂时没有 `automations`（另一项写入的结果在确认中）时显示正在确认，不显示空列表。

- **每一项**：名称；「每天 / 工作日 / 每周几 HH:MM · 下次 · 上次 结果」，时间按这台设备的时钟写成「今天 / 明天 / 11月17日 09:00」；工作位置（项目，或「每次新的文件夹」）和每次输入的第一行（读自详情路由）；状态词「已开启 / 运行中 / 已关闭」，暂停时是琥珀色「已暂停」，ⓘ 里是 Host 给的 `pause.message`。上一次真实运行之后错过或跳过的时间合计为琥珀色「错过 N 次」，ⓘ 里逐条写时间和原因。
- **运行记录**：详情路由的最近 50 条，第一项默认展开，先显示 5 条。有 `sessionId` 的一行打开那个会话；`missed` 与 `skipped` 写「没有运行」，ⓘ 里是原因（Mac 关机、睡眠或 Latch 没有运行 / 上一次运行还没结束，都不补跑）。
- **新建 / 编辑**：名称、重复（每天、工作日、每周与星期）、几点、工作位置、每次的输入、「结果出来时通知我」。工作位置是一个项目，或「不选项目」（每次在启动目录下有自己的文件夹）：Agent 有默认项目时预填它，表单里看得见也能改，保存就是选择；没有默认项目时必须手动选。输入是每次运行的第一条消息，要用的文件写出它在工作位置里的路径；附加文件尚未实现。模型不在表单里，按「字段」的缺省取值。编辑带打开表单时的 `baseRevision`，只发改了的字段，清除项目发 `projectId: null`；运行中不能编辑或删除。
- **操作**：「暂停」「继续」（暂停后是「重新开启」）经 `/enabled`；「立即运行」经 `/run`；「删除」先确认。每个写入都带 `requestId`，结果未知时保留原请求并显示「重试同一请求」，期间不能做别的修改；`automation-changed` 显示为已在别处修改并可载入最新；Host 的拒绝（如 `automation-owner`、`automation-limit-running`）原样显示。
- **不能做时**：没有 `run` 的设备只看列表和记录，不显示任何操作，提示「只能查看」；Mac 离线时操作都不可用；Agent 的 `canAutomate` 为假时不能新建、继续或立即运行，提示里是 `unavailableReason`，暂停和删除仍可用。
