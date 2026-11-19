---
description: 团队：人给一个会话开始几个成员会话，各在所选的 Harness 上同时做一件事，全部结束后 Host 把结果作为一条消息交回这个会话；记录、成员状态、交回的措辞与上限、停止、可见范围与审计。
sources:
  - apps/host/src/teams.ts
  - apps/host/src/routes/teams.ts
  - apps/host/src/routes/team-rounds.ts
  - packages/harness-acp/src/skills-server.ts
  - packages/core/src/runtime.ts
  - apps/host/src/routes/work-items.ts
  - apps/host/src/routes/work-proposals.ts
  - apps/host/src/server.ts
  - apps/host/src/audit-actions/sessions.ts
  - packages/protocol/src/teams.ts
  - packages/protocol/src/work-proposals.ts
  - apps/web/src/teams
  - apps/web/src/composer/CodexTeam.tsx
  - apps/web/src/board/ProposalReview.tsx
---
# 团队

一个会话（带队的，lead）加上几个成员会话：每个成员做一件事，各在为它选的 Harness 上，同时进行。成员全部结束后，Host 把它们的结果作为一条消息发给带队的会话，由它的 Agent 核对并汇总。

- 成员是普通的待办和普通的会话；团队只记录谁带队、有哪些成员、结果有没有交回。
- 什么都不会自己开始。团队只在人的设备调用 `POST /tasks/:id/team` 时开始；带队会话的 Agent 只能提议（`propose_todos` 的一组待办就是分工方案），没有开始团队或新建成员的工具。
- 之后可以给已有成员再派一轮（[轮](#轮)）：人从带队会话派；人为这个团队打开开关后，带队会话的 Agent 也能自己派（[Agent 派活](#agent-派活)）。
- 不做：团队套团队（成员不能再带队）、自动开始、在成员之间复制文件、带回最后一条回复以外的内容、跨 Host。

`catalog.features.teams` 声明下面的接口。

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `POST /tasks/:id/team` | `run`，且能读带队会话 | `TeamStartInput`：从提议或任务列表开始，每个成员开始或被拒之后答 201 `{ team }`；同一设备同一 `requestId` 的重试答同一个团队，200 |
| `GET /teams/:id` | `view`，且能读带队会话 | `{ team }` |
| `POST /teams/:id/stop` | `run`，且能读带队会话 | `{ requestId }`：停止，答 `{ team }` |
| `POST /teams/:id/rounds` | `run`，且能读带队会话与每个成员 | `TeamRoundInput`：再派一轮，答 201 `{ team }`；同一设备同一 `requestId` 答同一轮，200 |
| `PATCH /teams/:id` | `run`，且能读带队会话 | `{ agentDispatch: boolean }`：Agent 派活的开关，答 `{ team }` |

快照的 `teams` 列出读者能读的团队：没结束的全部，加最近结束的，合计最多 32 个。成员会话的摘要带 `teamOf`（`{ teamId, leadSessionId }`），由 Host 从团队记录填入，Driver 自报的被丢弃。

## 开始

请求是 `{ requestId, proposal?, tasks?, goal? }`，`proposal` 与 `tasks` 二选一。

- `proposal: { id, baseRevision, entries? }`：带队会话自己提出的一条待办提议（别的会话的提议 409 `team-proposal`）。`entries` 是 `{ index, name?, title?, prompt?, harnessId?, model?, config?, ownModel? }`，不写就是全部待处理条目。这些条目按人改过的值被接受，与 `POST /work/proposals/:id/accept` 是同一个函数（同样的审计、回执与私有规则），再逐条开始。
- `tasks: [{ name?, title, prompt, harnessId, model?, config?, ownModel? }]`：人写的列表，每项建成一条待办（与 `POST /work/items` 同一个函数）。标题 1–120 字，要求 1–4 000 个字符。
- **名字。** 每个成员有一个名字（`TeamMember.name`，一行，最多 16 字，`TEAM_LIMITS.nameChars`）：提议条目里带队会话的 Agent 起的 `name`（人改过的优先），人写的任务里的 `name`；都没有时取标题第一行到第一个标点为止的前 16 字。图、结果、@ 与交回的消息都用它称呼成员，标题作为说明。
- 成员开始时用的选择与 `POST /tasks` 相同：`model` 是 Latch 的一个模型服务，`config` 是 Harness 自己的选项（`[{ configId, value }]`，最多 16 项、每项一次，如它自己的模型、思考与速度），`ownModel: true` 是人选了 Harness 自己的默认模型、不被项目的默认模型替换。选权限档位的项（`~mode`，或这个 Harness 已报过的选项里类别是 `mode` 的）不收，这个成员记为没有开始。
- 成员 1–8 个（`TEAM_LIMITS.members`），超出 400 `invalid-input`。

带队会话必须是这台设备能读的 Code 会话，没有归档，不是插件页面开始的，也不是某个团队的成员（团队结束后仍算），否则 409 `team-lead`。一个带队会话同时只有一个没结束的团队，否则 409 `team-open`。

顺序：核对带队会话与方案 → 写 `team.started`（写不进 503 `audit-unavailable`，什么都不做）→ 接受提议或建待办 → 保存团队记录（成员为 `starting`）→ 同时开始每个成员。每个成员经 `POST /work/items/:id/start` 的同一个函数开始，身份是调用的设备，审计与回执照常；各步的请求标识由设备、带队会话与 `requestId` 推出，重试不会多建或多开。同一项目的开始在项目队列里排队。

| 成员的设置 | 取值 |
| --- | --- |
| 项目 | 带队会话的项目（提议条目里写的项目不用） |
| Harness | 任务或条目写的；提议条目没写时用带队会话的 |
| 模型 | 任务或条目带的 `model`、`config` 与 `ownModel`，原样交给会话开始，由同一套检查核对：开始前就不收的（不存在的服务、Latch 内置收到 Harness 选项）让这个成员记为没有开始；Agent 自己不提供的值要等它的会话起来才知道，那个会话在第一轮之前失败，成员记为失败。其余成员照常。都不带时与在该项目里手动开始的新会话相同。从不取带队会话的 |
| 权限 | Harness 与项目的默认值，不随带队会话 |
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

【名字】（Harness 名）：已完成
它的改动在分支 … 上，在它自己的工作树里。（成员有自己的工作树时）
最后一条回复，最多 1 600 个字符；更长时留结尾，前面写「…（前面省略）」

【名字】（Harness 名）：失败了 | 已取消 | 结束方式未知 | 没有开始
没有正常结束的成员不带结果；没开始的带拒绝原因

TEAM_RETURN_ASK
```

- 整条消息少于 16 000 个字符；放不下时所有成员的回复按同一长度再截短。
- 成员此刻是私有会话而带队会话不是时，它的回复不带回，只写明要到它的会话里看。
- 带队会话在运行、在等批准或回答、或队列里还有消息时不发，团队停在 `returning`，下次再看；所以不会插到人自己排队的消息前面。
- 只发一次：请求标识由团队 ID 推出，每次都用它；发之前先在带队会话的记录里找这个标识的消息，找到就记为已交回。
- 带队会话已归档或已删除：`kept: 'lead-gone'`。设备已移除、停用、没有 `run`，或发送时被拒为无权（401、403）：`kept: 'device-removed'`。
- 其他失败（Host 在安装更新、带队会话的 Harness 此刻不可用或不能恢复这个会话）留在 `returning`，之后每次再看时重试。从手机开始的团队按开始时的验证窗口发送：窗口结束后不再发，团队停在 `returning`。停在 `returning` 的团队由人按停止结束，结果留在页面上。

## 轮

开始是第 1 轮。之后的一轮给这个团队的一些已有成员各发一条消息，是各自会话的新一回合；这一轮的成员都结束后，结果按[交回](#交回)的同样方式回到带队会话：一条外部内容消息，以发起这一轮的设备身份，请求标识由团队 ID 与轮号推出，只发一次，带队会话忙时等着，发不出时留下原因。

- 请求是 `{ requestId, sends: [{ itemId, prompt }] }`，1–8 项，每条 1–4 000 个字符（同 `checkedPrompt`，像密钥的拒绝）。
- 成员必须在这个团队里（否则 404 `team-member-not-found`）、开始过（409 `team-member-unstarted`）、会话没有归档（409 `team-member-archived`）、上一件已经结束且没有在运行、等批准、等回答或排队（409 `team-member-busy`）。不替人排队。
- 一个团队同时只有一轮没结束：还有一轮在进行时 409 `team-round-open`，所以带队会话每轮只收到一条结果。所有轮都结束了（交回、留下或停止）的团队可以再派一轮，它因此重新打开；带队会话另有没结束的团队时 409 `team-open`。轮数不限；记录只留最近 32 轮的各成员状态（`TEAM_LIMITS.history`），更早的淘汰。
- 顺序：核对 → 写 `team.round.started`（写不进 503 `audit-unavailable`，什么都不发）→ 记下这一轮（每个成员这一轮的消息的请求标识由团队、轮号与待办推出）→ 同时发出每一条。每条走人发消息的同一条检查路径（`POST /tasks/:id/prompt` 的同一函数），身份是调用的设备。发不出的成员这一轮记为 `unstarted` 并带原因；一条都没发出时团队回到这一轮之前，答第一个拒绝。
- 人派的一轮里，带队会话从外部内容开始时，消息标为外部内容；否则是人自己的话。
- 成员结束看的是这一轮那条消息之后的回复，不看之前的轮；成员显示最新一轮的状态。交回的消息只列这一轮的成员。
- 记录：团队记下最新一轮（轮号、`by`、成员、请求、当时带队会话的最后一条消息）和之前每一轮（成员与各自结束的状态、各自那条消息的请求标识、交回的消息或留下的原因）。`TeamSummary.round` 与 `rounds` 在有不止一轮时给出这些，不含任何文字。
- `POST /teams/:id/stop` 停的是正在进行的那一轮的成员。

## Agent 派活

`PATCH /teams/:id { agentDispatch: true }` 让带队会话的 Agent 自己给这个团队的已有成员派一轮。默认关，Latch 不替人打开。

- 打开是放宽：先写 `team.dispatch.allowed`，写不进 503，什么都不变；记下打开它的设备。关是收紧：写 `team.dispatch.ended`（`reason: person`），写不进照样关，响应带 `x-latch-audit: failed`。
- 自己关：打开它的设备被移除或失去 `run`（设备变更时检查，`reason: device-removed`），或团队被停止（`reason: stopped`）。之后不会自己再打开。
- 只对会话最新的团队有效。带队会话的 Harness 没有给 Agent 的工具通道（看板的提议通道，pi 没有）时拒绝 409 `team-dispatch-unavailable`。原因放在 `TeamSummary.dispatchRefusal`，页面把开关画成灰的。
- 开着时带队会话的 Agent 有两个工具（说明在 `packages/protocol` 的 `LIST_MEMBERS_GUIDE`、`SEND_TO_MEMBERS_GUIDE`）：
  - `list_members`：这个团队的成员，各带短标识（`m1`…）、名字、标题、Harness 名与状态，还有是否有一轮在进行。ACP 会话从 Host 写在会话私有目录里的 `team.json`（0600，原子写；关时删掉）读；`latch-skills` 服务器只在它存在时列出这两个工具，变化时发 `notifications/tools/list_changed`。内置 Harness 在每次运行开始时向 Host 要。
  - `send_to_members({ sends: [{ member, prompt }] })`（`member` 是短标识或名字）：ACP 会话写进同目录的 `rounds.jsonl`（每个成员一行，按调用的标签成组，每次启动最多 64 行；与提议的文件分开，不占提议的额度），驱动交给 Host，再把 Host 的话写进 `round-answers.jsonl`：轮号，或拒绝的原因（Host 自己的英文句子，不引用要求）。内置 Harness 直接等 Host 的答复。
- Host 只认自己的记录：会话必须属于调用的 Driver 并有看板通道，不是插件页面、我的 Agent、定时或无人值守的会话；团队是这个会话最新的团队；成员只按短标识或名字在这个团队里找。Agent 不能开始新会话、不能新建成员（它仍可以 `propose_todos`，由人开始），也碰不到团队以外的会话。
- 这一轮与人派的一样，`by: 'agent'`，身份是打开开关的那台设备，请求标识由会话、团队与调用推出（同一行读两次只派一轮）。要求对成员是外部内容（这一回合标为外部内容），不带任何设备的输入授权（与引用别的设备的话的消息相同）。
- 拒绝（工具答出原因）：开关关着，设备此刻不能操作（手机验证窗口外）或已被移除，有一轮没结束，成员不在团队里、没开始、在忙或已归档。Agent 派几轮不设上限：开关是人给的授权，一次只有一轮，人随时可以关掉开关或停止团队。
- **不受无人值守上限。** 人为这个团队打开开关，就是对这些成员的信任：Agent 派的一轮不按 `policy.json` 的 `unattended`（`maxLevel` 等）拦截，L3 的外部 Harness 成员也可以派，也不加本机确认（所有者的决定）。打开开关的设备必须还在、有 `run`；其余边界照上：只派已有成员、一次一轮、外部内容、不沿用「始终允许」与 Latch 内置更宽的权限档位、设备移除或团队停止即关。

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
| `team.round.started` | `teamId`、`round`、`by`、`members` | 再派一轮、发出任何消息之前；写不进就不派 |
| `team.dispatch.allowed` | `teamId`、`leadSessionId` | 打开 Agent 派活之前；写不进就不开 |
| `team.dispatch.ended` | `teamId`、`reason` | 开关关上时（人、设备移除或失去 `run`、团队停止）；写不进照样关 |

成员的待办与会话另有各自的 `work.proposal.decided`、`work.item.changed`、`work.item.started`、`task.l3.started` 与 `task.cancelled`。

## Agent 得到的说明

`propose_todos` 的工具说明（`PROPOSE_TODOS_GUIDE`）告诉 Agent：用户可以把整组作为团队开始，各项同时运行，结果作为一条消息回到这个对话由它核对汇总，所以各项要互不依赖，只在确知某个 Harness 已安装且合适时才写 `harness`，并给每项起一个像角色的短名字（`name`），开成团队后人用 @、它用 `send_to_members` 都按这个名字叫成员。工具不列出有哪些 Harness；写了不存在的会被拒（`proposal-harness`）。

## 界面

页面只在 `catalog.features.teams` 时给出下面这些；画法见 [DESIGN.md](DESIGN.md)。

- **开始。** Code 会话输入框末行的「用团队分工」（[TeamEntry.tsx](../apps/web/src/teams/TeamEntry.tsx)）：会话已归档、自己是成员、由插件页面开始、设备没有 `run`，或它已有一个没结束的团队时不出现。面板里每行的整段文字是要求，第一行是标题；空行不算任务。第一行默认用这个会话的 Harness，之后的行优先用还没用过的可用 Harness。写到一半的列表按设备与会话留在页面内存里，关掉面板或切换会话后还在，刷新页面后没有，不写入浏览器存储。
- **模型。** 每行在 Harness 旁有与输入框开始新会话时同一个模型入口（模型、思考与速度）。它默认是这个人的输入框给该 Harness 的新会话记住的选择，按来源会话的项目解析（[memberModel.ts](../apps/web/src/teams/memberModel.ts)）；人在这一行改的只属于这一行，换 Harness 后回到那个 Harness 的默认。开始时按输入框开始新会话的同一个函数（`startChoices`）把它写成 `model`、`config` 与 `ownModel`，去掉权限档位。从提议开始时每条用该 Harness 的默认。
- **从提议开始。** 会话里审阅自己 Agent 的一组待办提议（待处理的不少于两条）时多一个「一起开始」，每条可改 Harness；「接受」与「不要」照旧。看板上的审阅没有它。409 `proposal-changed` 后页面重读提议。
- **结果未知。** 开始的请求没有收到答复时，列表锁住，「重试」原样再发（同一 `requestId` 与内容），「放弃」后才能改。停止同理。
- **对话里。** 团队的卡片排在 `messageId` 所在那一轮之后，找不到那条消息时排在最后（[placeTeams.tsx](../apps/web/src/teams/placeTeams.tsx)）。交回的消息按 `returnedMessageId` 认；快照里没有这个团队时，以 `TEAM_RETURN_HEADING` 开头的用户消息也画成结果卡，只是没有成员行。成员行展开时读的是成员会话的最后一条回复，不解析交回的文字。
- **再派一轮。** 带队会话的输入框里 @ 列出最新团队的成员（在文件上面），选中放入成员标记（成员的名字，前面是它 Harness 的图标）；消息里有成员标记时不发给这个会话，而是去掉标记后作为每个被提到成员的要求，派成一轮（`POST /teams/:id/rounds`；没收到答复时同样的内容再发用同一个 `requestId`）。图里能接活的成员行上有「再派一轮」，在图下打开一行输入只派给它。卡片画最新一轮，排在这一轮所在的回合之后；结果卡按 `rounds` 里的 `returnedMessageId` 认，标题写第几轮，展开读这一轮那条消息之后的回复。头一行的开关是「让它自己派活」。
- **Codex 自带的子 Agent** 是同一个面板的另一种分工方式（[CodexTeam.tsx](../apps/web/src/composer/CodexTeam.tsx)）：会话的 Harness 此刻能用它们（`codexTeam === 'available'`）时，面板顶上有「各开会话 / Codex 子 Agent」两段。选后者时每行只有文字；「开始」把 `CODEX_TEAM_REQUEST` 和编了号的各项作为一条消息，经输入框自己的发送路径发给这个会话（同样的检查、回执，运行中时排队），不建团队记录，输入框里的字不动。面板记住这个会话上次用的方式，只在页面内存里。有了委派后，入口打开委派记录，记录里的「用团队分工」回到面板。这个会话是成员或已有没结束的团队时，面板不出现，已有的委派记录照常。
- **列表。** 成员排在来源会话下面，按团队里的顺序（`nestMembers`）；来源会话不在同一组（被搜索或归档筛掉、成员在「等你处理」）时成员照常显示。
