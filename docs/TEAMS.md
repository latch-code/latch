---
description: 团队：人给一个会话开始几个成员会话，各在所选的 Harness 上同时做一件事，全部结束后 Host 把结果作为一条消息交回这个会话；记录、成员状态、交回的措辞与上限、停止、可见范围与审计。
sources:
  - apps/host/src/teams.ts
  - apps/host/src/routes/teams.ts
  - apps/host/src/routes/work-items.ts
  - apps/host/src/routes/work-proposals.ts
  - apps/host/src/server.ts
  - apps/host/src/audit-actions/sessions.ts
  - packages/protocol/src/teams.ts
  - packages/protocol/src/work-proposals.ts
---
# 团队

一个会话（带队的，lead）加上几个成员会话：每个成员做一件事，各在为它选的 Harness 上，同时进行。成员全部结束后，Host 把它们的结果作为一条消息发给带队的会话，由它的 Agent 核对并汇总。

- 成员是普通的待办和普通的会话；团队只记录谁带队、有哪些成员、结果有没有交回。
- 什么都不会自己开始。团队只在人的设备调用 `POST /tasks/:id/team` 时开始；带队会话的 Agent 只能提议（`propose_todos` 的一组待办就是分工方案），没有开始团队的工具。
- 不做：团队套团队（成员不能再带队）、自动开始、在成员之间复制文件、带回最后一条回复以外的内容、跨 Host。

`catalog.features.teams` 声明下面的接口。

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `POST /tasks/:id/team` | `run`，且能读带队会话 | `TeamStartInput`：从提议或任务列表开始，每个成员开始或被拒之后答 201 `{ team }`；同一设备同一 `requestId` 的重试答同一个团队，200 |
| `GET /teams/:id` | `view`，且能读带队会话 | `{ team }` |
| `POST /teams/:id/stop` | `run`，且能读带队会话 | `{ requestId }`：停止，答 `{ team }` |

快照的 `teams` 列出读者能读的团队：没结束的全部，加最近结束的，合计最多 32 个。成员会话的摘要带 `teamOf`（`{ teamId, leadSessionId }`），由 Host 从团队记录填入，Driver 自报的被丢弃。

## 开始

请求是 `{ requestId, proposal?, tasks?, goal? }`，`proposal` 与 `tasks` 二选一。

- `proposal: { id, baseRevision, entries? }`：带队会话自己提出的一条待办提议（别的会话的提议 409 `team-proposal`）。`entries` 是 `{ index, title?, prompt?, harnessId? }`，不写就是全部待处理条目。这些条目按人改过的值被接受，与 `POST /work/proposals/:id/accept` 是同一个函数（同样的审计、回执与私有规则），再逐条开始。
- `tasks: [{ title, prompt, harnessId }]`：人写的列表，每项建成一条待办（与 `POST /work/items` 同一个函数）。标题 1–120 字，要求 1–4 000 个字符。
- 成员 1–8 个（`TEAM_LIMITS.members`），超出 400 `invalid-input`。

带队会话必须是这台设备能读的 Code 会话，没有归档，不是插件页面开始的，也不是某个团队的成员（团队结束后仍算），否则 409 `team-lead`。一个带队会话同时只有一个没结束的团队，否则 409 `team-open`。

顺序：核对带队会话与方案 → 写 `team.started`（写不进 503 `audit-unavailable`，什么都不做）→ 接受提议或建待办 → 保存团队记录（成员为 `starting`）→ 同时开始每个成员。每个成员经 `POST /work/items/:id/start` 的同一个函数开始，身份是调用的设备，审计与回执照常；各步的请求标识由设备、带队会话与 `requestId` 推出，重试不会多建或多开。同一项目的开始在项目队列里排队。

| 成员的设置 | 取值 |
| --- | --- |
| 项目 | 带队会话的项目（提议条目里写的项目不用） |
| Harness | 任务或条目写的；提议条目没写时用带队会话的 |
| 模型与权限 | Harness 与项目的默认值，不随带队会话 |
| 文件夹 | 项目是只有一个文件夹的已保存项目、且该文件夹是 Git 仓库时，每个成员在自己的新工作树里开始（与 `POST /tasks` 的 `worktree: true` 相同）；仓库此刻建不出工作树（还没有提交、工作树位置不可用等）时成员被拒，不改用共用文件夹。不是仓库、多个文件夹或默认项目时，与在该项目里手动开始的会话相同。只对话的 Harness 不用工作树 |
| 私有 | 带队会话私有时成员也私有（`privateFrom`），团队记下 `private`，此后不取消；不私有时成员不带私有上下文开始，这样它的回复才能交回 |
| 外部内容 | 带队会话从外部内容开始、或提议标了 `external` 时，成员以 `outsideStart` 开始 |

某个成员被拒（Harness 不可用、还没在这台 Mac 上确认过、工作树建不出来等）时，它记为 `unstarted` 并带 Host 的原话 `refusal`，团队照常带着其余成员进行。一个都没开始时不留团队记录，回答第一个成员的拒绝；已接受或建成的待办留在看板上，是普通的未开始待办，同一个请求（同一 `requestId` 与内容）重试时接着用它们开始，不再接受或新建。

## 状态

团队：`running`（成员在做）、`returning`（都结束了，结果等着发给带队会话）、`returned`（已发，`returnedMessageId` 是那条消息）、`stopping`（按了停止，成员还在结束）、`kept`（结果不会发了，`kept` 是原因）。

成员：`starting`、`running`、`waiting`（等批准或等回答问题）、`done`、`failed`、`cancelled`、`unknown`（Harness 没说怎么结束的，或会话被删）、`unstarted`。后五个是结束，到了就不再变。`said` 是它最后一条回复的第一行（最多 200 字）。读者读不了的成员会话不带 `sessionId` 与 `said`。

Host 在有团队没结束时每 500 毫秒看一次成员会话的摘要，运行结束（`runSettled`）时立即再看。成员第一轮运行结束后算结束；之后人在成员会话里继续聊不改变团队记下的结果。会话空闲而 Harness 没记结束方式时：有回复算 `done`，开始后 60 秒仍没有回复算 `unknown`。

**重启。** 团队记录在数据目录的 `work/teams.json`（0600，原子写，strict，最多 256 个，满了先删最早结束的）。Host 启动后接着看没结束的团队：停止时还在运行的成员按它的 Harness 报的状态记（通常是 `unknown`）；记录写下时还没开始的成员，若它的待办里已有会话就认这个会话，否则记为 `unstarted`，不会替人再开始。

## 交回

成员都结束后，Host 以开始团队的那台设备的身份，经与 `POST /tasks/:id/prompt` 相同的检查路径给带队会话发一条消息，并标为带有外部内容（之后这个上下文提的待办是 `external`）。

```
TEAM_RETURN_HEADING

【标题】（Harness 名）：已完成
最后一条回复，最多 1 600 个字符；更长时留结尾，前面写「…（前面省略）」

【标题】（Harness 名）：失败了 | 已取消 | 结束方式未知 | 没有开始
没有正常结束的成员不带结果；没开始的带拒绝原因

TEAM_RETURN_ASK
```

- 整条消息少于 16 000 个字符；放不下时所有成员的回复按同一长度再截短。
- 成员此刻是私有会话而带队会话不是时，它的回复不带回，只写明要到它的会话里看。
- 带队会话在运行、在等批准或回答、或队列里还有消息时不发，团队停在 `returning`，下次再看；所以不会插到人自己排队的消息前面。
- 只发一次：请求标识由团队 ID 推出，每次都用它；发之前先在带队会话的记录里找这个标识的消息，找到就记为已交回。
- 带队会话已归档或已删除：`kept: 'lead-gone'`。设备已移除、停用、没有 `run`，或发送时被拒为无权（401、403）：`kept: 'device-removed'`。
- 其他失败（Host 在安装更新、带队会话的 Harness 此刻不可用或不能恢复这个会话）留在 `returning`，之后每次再看时重试。从手机开始的团队按开始时的验证窗口发送：窗口结束后不再发，团队停在 `returning`。停在 `returning` 的团队由人按停止结束，结果留在页面上。

## 停止

`POST /teams/:id/stop` 把团队记为 `stopping`，对每个还没结束的成员走与 `POST /tasks/:id/cancel` 相同的取消（审计与回执照常）。成员的 Harness 真正结束后团队成为 `kept: 'stopped'`，结果留在页面上，不发给带队会话。`returning` 中的团队停止后直接成为 `kept: 'stopped'`。已经结束的团队 409 `team-ended`；成员正在开始时 409 `team-starting`。

## 可见范围

带队会话私有（或团队记过 `private`）时，只有数据范围 `all` 的设备能在快照里看到团队；其他设备的每个接口都答 404 `team-not-found`，与不存在的团队相同，它能读的成员会话也不带 `teamOf`。手机的正文验证窗口之外，快照不带 `teams` 与 `teamOf`。

## 审计

detail 只有 ID、计数、哈希与枚举，不含标题、目标或回复。

| 动作 | detail | 何时 |
| --- | --- | --- |
| `team.started` | `teamId`、`leadSessionId`、`members`、`harnessIds`、`proposalId?` | 接受、建待办与开始之前；写不进就不开始 |
| `team.returned` | `teamId`、`leadSessionId`、`members`、`promptHash` | 发给带队会话之前；写不进就下次再试 |
| `team.kept` | `teamId`、`reason` | 记为不再发送时（三种原因都写）；写不进照做 |
| `team.stopped` | `teamId` | 人按停止时；写不进照做并带 `x-latch-audit: failed` |

成员的待办与会话另有各自的 `work.proposal.decided`、`work.item.changed`、`work.item.started`、`task.l3.started` 与 `task.cancelled`。

## Agent 得到的说明

`propose_todos` 的工具说明（`PROPOSE_TODOS_GUIDE`）告诉 Agent：用户可以把整组作为团队开始，各项同时运行，结果作为一条消息回到这个对话由它核对汇总，所以各项要互不依赖，只在确知某个 Harness 已安装且合适时才写 `harness`。工具不列出有哪些 Harness；写了不存在的会被拒（`proposal-harness`）。
