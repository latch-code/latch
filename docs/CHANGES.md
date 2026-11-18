---
description: 每轮快照、改动范围（本轮、这个会话、未提交、与 main 比较）、归属、撤销与恢复、丢弃、补丁与保留上限，以及行级反馈。
sources:
  - apps/host/src/changes
  - apps/host/src/routes/changes.ts
  - apps/host/src/audit-actions/changes.ts
  - packages/protocol/src/changes.ts
  - packages/protocol/src/review-notes.ts
  - apps/host/src/review-notes.ts
  - apps/host/src/routes/review-notes.ts
  - apps/host/test/review-notes.test.ts
  - apps/web/src/panel/changes/notes.ts
  - e2e/review-notes.e2e.ts
  - apps/web/src/phone-review
  - e2e/phone-review.e2e.ts
  - apps/host/src/files/ignore.ts
  - apps/host/src/branch-reader.ts
  - apps/host/test/changes-diff.test.ts
  - apps/host/test/changes-snapshots.test.ts
  - apps/host/test/changes-git.test.ts
  - apps/host/test/changes-engine.test.ts
  - apps/host/test/changes-routes.test.ts
  - e2e/changes.e2e.ts
  - packages/testkit/fixtures/fake-acp-agent.mjs
---
# 改动记录

`ChangesEngine`（`apps/host/src/changes/engine.ts`）在每轮开始与结算时记录会话文件夹，回答「改动」面板的四个范围，并执行撤销本轮、恢复、撤销此文件与撤销全部改动。`routes/changes.ts` 把它接到 HTTP 路由与会话生命周期；`catalog.features.changes` 表示 Host 有这些路由。界面是右侧面板的「改动」页签（`apps/web/src/panel/changes`）。

## 快照

一轮开始与结算时各记录一次会话冻结的文件夹，结算时与开始时比较。

- **开始。** `runStarted` 带着项目与文件夹触发 `beginTurn`；记录写入磁盘后才返回，这一轮的第一条提示等它完成，最长 15 秒。同一会话的下一轮等上一轮记录完。
- **结算。** `runSettled` 从打开这一轮的用户消息之后的工具消息取得 `ToolDetail.diffs`，交给 `settleTurn`。分不清哪些消息属于这一轮时不做归属。
- **不记录的。** 与输出观察同一套忽略规则（`files/ignore.ts`）：`.git`、`node_modules`、`dist`、`build`、`.next`、`.venv`、`__pycache__`、`.DS_Store` 与 `*.tmp`。不跟随符号链接，跳过 Host 受保护路径。
- **遍历上限。** 最多 50,000 个目录项、32 层、10 秒；超出时该文件夹记为不完整（`partial`），不据此推断新增或删除。一轮最多记 20,000 个改动，超出同样是 `partial`。
- 会话删除时一并删除它的记录。`recover()` 在 Host 每次启动时把停止时仍在运行的轮次按中断结算，不做归属：`hostStopping` 之后这些运行不再有 `runSettled`。

内容按 SHA-256 存一份，同一项目的会话共享：

| 文件 | 留存 |
| --- | --- |
| 1 MB 以内 | 读取后复制 |
| 更大、在同一卷上 | `/bin/cp -c`（clonefile）做 APFS 克隆；Node 的 `copyFile` 在 macOS 上从不克隆，所以不用它 |
| 另一卷上超过 1 MB，或超过 128 MB | 只记元数据（「太大，没有留存」） |
| 名称像密钥（`.env`、私钥、凭据文件等） | 从不读取，只记元数据 |
| 内容含密钥 | 只记哈希，不存内容 |
| 元数据未变 | 沿用上一次的记录，不再读取 |

## 存储与保留

记录在数据目录的 `snapshots/` 下：`<项目>/objects/` 存内容，`<项目>/sessions/<会话>/` 存 `head.json`（最近一次记录）与 `turns.json`（保留的轮次）。目录必须是本用户的普通目录，否则 500 `changes-store-insecure`。

- 每个会话保留最近 20 轮。
- 每个项目保留的内容按逻辑大小不超过 2 GB。超出时从最早的已结算轮次删起，没有轮次的会话随后删掉最近记录，再清除无人引用的内容。
- 快照的余量只扣除无法删除的部分（各会话最近记录与运行中的轮次），旧轮次在快照之后让位。
- 被删轮次之后的第一轮不再保留它开始之前的改动，因为任何范围都不早于它。

## 范围

| 范围（`scope`） | 比较 |
| --- | --- |
| 本轮 `turn` | 一轮开始与结束；运行中与此刻的工作区比较，并标明运行中 |
| 这个会话 `session` | 最早保留的一轮开始时与此刻：依次合并各轮的改动、轮次之间的改动和最近记录之后的改动；改回原样的文件不列出 |
| 未提交 `uncommitted` | 工作区与 HEAD，包括暂存与未跟踪（未被忽略）的文件 |
| 与 main 比较 `base` | 工作区与当前分支和 `main`（或 `master`，本地或 `origin`）的合并基点；分离 HEAD 或就在 main 上时没有此范围 |

- **列表。** 状态 A/M/D/R（内容相同的删除与新增合为重命名）、增删行数与标记：二进制、超过 1 MB、可能含密钥（只列路径，从不给内容）、未留存、执行位变化。
- **行级差异。** 在 Host 上用有工作量上限的 Myers 算法计算，超出上限时整段显示为替换；单个文件的差异可以带任意行数的上下文。
- **对话找到这一轮。** 打开这一轮的用户消息带 `turnId`；只对话模式的运行碰不到文件夹，没有这个字段。

**归属。** 来自时间窗口，不是进程跟踪：

- 本轮新增或删除的一行，若 Agent 自己的某次工具编辑新增或删除了同一行，算 Agent 的；其余算「由命令修改」，文件与行都带 `byCommand`。同一文件夹里其他程序在这一轮期间的写入也会算作命令。
- 这个会话范围里，轮次之间的改动带 `byUser`。
- 另一个会话这一轮期间也在同一文件夹（或其子文件夹、上层文件夹）运行时，这一轮带 `otherSessions`，界面标出「另一个会话也在改这里」。

**Agent 的结果卡与资料库**（[CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#界面)）只读每一轮自己的「本轮」范围：最近 20 轮已结算、未撤销、有改动且没有 `otherSessions` 的，合并成这个会话的文件。不用「这个会话」范围，因为两轮之间别的会话或人的改动不算它的。已结算轮次的列表缓存在内存里（最多 2,000 轮）。

## 只读 Git

两个 Git 范围用受限的 Git（运行器的选项、环境与钩子规则见 [GIT-DELIVERY.md](GIT-DELIVERY.md#git-进程)），不运行仓库里的任何程序。

- Git 只解析提交、列出提交的树与索引、返回 blob，从不比较工作区：比较会运行仓库配置的 clean filter。Host 自己按 Git 的方式给工作区文件算哈希，再与树比较，所以带过滤器或换行转换的文件可能显示为已修改。
- 只有位于工作树顶层、且 Git 元数据通过只读分支检查（[BRANCHES.md](BRANCHES.md)）的文件夹才运行 Git，`GIT_DIR` 来自那次检查。
- 符号链接、子模块与稀疏检出未展开的文件不列出。每个 Git 文件夹最多 100,000 个树条目与索引路径。
- **冲突。** 仓库正在合并、变基、拣选或还原，或有未合并的文件时，两个 Git 范围带 `conflict`（进行中的操作与冲突文件数），冲突文件带 `conflicted`。这时撤销未提交的改动是 409 `change-git-conflict`，一个文件也不写。撤销本轮不受影响：它只写回这一轮之后没再改过的文件。

## 撤销与丢弃

| 动作 | 做什么 |
| --- | --- |
| 撤销本轮 | 把这一轮改过的文件写回开始时的内容（新建的删除，删除的恢复） |
| 恢复 | 写回结束时的内容 |
| 撤销此文件 | 只处理选中的文件；没有恢复 |
| 撤销全部改动 | 把未提交的改动写回 HEAD 的内容并删除未跟踪的文件，不改 Git 索引。不可恢复，只在这台电脑上，先预览再带 `confirm` 执行 |

- **只写没再动过的文件。** 每个文件都还停在这一轮留下的样子（按内容哈希核对）时才执行，否则 409 `change-files-changed`；已是目标内容的文件跳过。
- **没有留存的不动。** 开始或结束时的内容有一边没有留存（太大或可能含密钥）的文件不写也不删，计入 `skipped`，恢复时同样不动。这一轮的文件全都如此时 409 `change-not-retained`，也不算撤销过。可能含密钥的文件在丢弃时既不写也不删。
- **运行中拒绝**（409 `change-running`）；这一轮还没记录完是 409 `change-not-settled`。
- **重试。** 带同一 `requestId` 的撤销或恢复返回原回执。
- **确认。** 撤销全部改动的 `confirm` 是预览给的 `planHash`：没有它 409 `change-confirm-required`，计划已变 409 `change-confirm-stale`。
- **审计先写。** 每次写入前，引擎把计划交给 `beforeWrite` 记审计（`change.undo`、`change.redo`、`change.discard`），内容只有 ID、计数与计划哈希，没有路径与内容；它抛错时一个文件也不写。
- **回执。** 列出没有动的文件 `notRestored`（原因：内容未留存、可能含密钥或文件夹已不在；超过 200 个时只列前面的，`skipped` 是总数）。撤销本轮另带 `notCovered`：这一轮的工具编辑提到、但快照不记录的文件（文件夹之外或被忽略的路径）。命令写到文件夹之外的文件没有痕迹，列不出来。

**告知 Agent。** 撤销不会改变 Agent 的记忆，所以写回文件后 `noteNextTurn` 为真，下一条消息带一段说明（`[Latch] 在这条消息之前，用户撤销了…`）。

- 说明写在消息文字的最前面并以空行隔开：Agent 与任何 Driver 收到同样的文字，对话里也看得到；`splitChangeNote` 把它和人写的内容分开。
- 撤销后又恢复且尚未告知时两者抵消；丢弃写过的文件仍要告知，没有写任何文件的丢弃不需要。
- 会话还没有轮次时，说明记在会话上，下一轮同样带上。
- 说明在下一轮开始时才算告知。同一 `requestId` 重试得到相同的文字，因为 Driver 拒绝文字不同的重试。
- 斜杠命令（以 `/` 开头紧跟非空白）不带说明，因为命令必须在消息最前面；说明留给下一条普通消息。
- 读取说明最多等 15 秒，超时后消息照发，说明留给下一条，这条消息的重试也不带。没有说明要告知时，消息不排在项目的改动队列后面。

## 退回到某一条之前

「从这里编辑」可以同时把文件退回到被编辑那一条之前（[STREAMING.md](STREAMING.md#从这里编辑)）。它是撤销本轮的规则用在那一条起的每一轮上，作为一个计划：

- **覆盖范围。** 那一条起每条开新一轮的用户消息都要带 `turnId`，记录从这一轮起的轮次必须正好是这些（记录里多一轮或少一轮都是 `not-recorded`），且都已结算、不是 `partial`；否则不提供（`not-recorded`、`not-settled`、`partial`）。这些轮次都没有改文件时也不提供（`no-changes`）。
- **每个文件**回到这些轮次里第一次改它的那一轮开始时的内容；它必须还是最后一次改它的那一轮留下的样子，并且两轮之间没有被别人改过，否则一个文件也不写（`changed-since`）。已撤销的一轮按它开始时的内容算。有一边没有留存的文件不写也不删，列在 `notRestored`；轮次的 `notCovered` 一并列出。
- **先预览再确认。** `POST changes/rewind/preview { messageId }` 回答 `RewindPreview`（要写回与删除的文件、`planHash`，或不能的原因）；`POST changes/rewind { messageId, requestId, confirm }` 只按这个 `planHash` 执行，计划变了 409 `change-confirm-stale`。审计 `change.rewind` 先写（计数与计划哈希，没有路径）。同一 `requestId` 重试得到同一回执（`replay`）。
- **之后。** 有文件在退回范围内的每一轮记为已撤销（文件全都没有留存的一轮不动），「恢复」可以逐轮放回；告诉 Agent 的说明按每一轮实际写回与跳过的文件数；原会话的下一条消息照撤销本轮告诉 Agent（分叉出去的新会话从没见过这些改动，不需要）。
- 权限与撤销本轮相同：`run`、数据范围 `files`、经过发消息的检查，运行中 409 `change-running`。

## 人的编辑

文件预览的「编辑」（[DOCUMENT-PREVIEWS.md](DOCUMENT-PREVIEWS.md#编辑)）经 `personEdit` 写文件。

- 写入在项目的锁里进行，不会落在一次快照、撤销或丢弃的中间。会话或同一文件夹里有一轮在运行时 Host 拒绝。
- 上一轮还在记录时，请求在拿锁之前等它记录完（最多 15 秒）；之后仍在记录就拒绝，从不在持锁时等待。
- 写完后引擎在 `turns.json` 里记下文件、写入内容的哈希与时间（`edits`，最多 100 条）。
- 这个会话范围里两轮之间改动的文件，内容仍是人最后一次保存的内容时带 `byPerson`（界面「你的修改」）；之后被别的程序改过就回到「两轮之间改动」。
- 每条编辑也是一条说明，与撤销的说明一样在下一条消息开始时告知：`[Latch] 在这条消息之前，用户编辑了 a.txt、b.txt。…`。最多列出五个路径，其余写「等 N 个文件」；主文件夹里的文件写相对路径，其他文件夹写完整路径；尚未被任何消息带上的同一文件只说一次。

## 路由

都在 `/link/api/tasks/:id/` 下。

| 路由 | 说明 |
| --- | --- |
| `GET changes?scope=&turn=` | 范围内的文件、合计、撤销与恢复的可用性 |
| `GET changes/file?scope=&turn=&root=&path=&context=` | 单个文件的差异 |
| `GET changes/patch?scope=&turn=` | 复制补丁 |
| `GET changes/turns` | 保留的轮次 |
| `POST turns/:turnId/undo`、`redo`（`{ requestId }`） | 撤销本轮、恢复 |
| `POST changes/rewind/preview`（`{ messageId }`）、`POST changes/rewind`（`{ messageId, requestId, confirm }`） | 把文件退回到这一条之前（「从这里编辑」） |
| `POST changes/discard`（`{ scope: 'turn', turnId, files }`） | 撤销此文件 |
| `POST changes/discard/preview`（`{ files? }`） | 撤销未提交改动前的确认内容：要删的文件、`planHash` 与确认框的 `warning` |
| `POST changes/discard`（`{ scope: 'uncommitted', files?, confirm }`） | 撤销未提交的改动 |
| `GET review-notes` | 行级反馈与修订号；`openSends` 是结果未定或在排队的发送 |
| `POST review-notes`（`{ requestId, root, path, range, side, scope, turnId?, lines, text }`） | 新建一条待发反馈 |
| `POST review-notes/:noteId/edit`、`status`、`delete`（`{ requestId, … }`） | 改文字（只限待发）、设状态、删除 |
| `POST review-notes/send`（`{ requestId, noteIds, queue? }`） | 把这些待发反馈作为一条消息发出，或排到下一轮 |
| `POST review-notes/sends/:sendId/retry`、`abandon`（`{ requestId }`） | 重试结果未知的发送，或在确认没有送出后放弃 |

- **权限。** 改动与反馈都显示消息没有提到的文件，所以读写都要数据范围 `files`，否则 403 `file-scope`；读取在返回前再查一次。读取要 `view`；写入要 `run`，并经过发消息的检查（`assertSessionInput`）。
- 撤销未提交的改动及其预览只接受这台电脑（`host.sock`）。
- 引擎没能打开时这些路由是 503 `change-unavailable`；会话的文件夹已不在项目中是 409 `workspace-changed`。

## 界面

「改动」页签按范围列出文件。范围菜单的「Git」一组是按行暂存与只读的历史（[GIT-DELIVERY.md](GIT-DELIVERY.md#界面)），它们显示时不画行级反馈与撤销的动作。「未提交」范围有「去交付」打开「交付」页签。界面必须守的规则：

- **`partial` 不隐藏**：可能还有没列出的文件，撤销也碰不到它们。
- **不能撤销时写明原因**（运行中、离线、超过保留上限）。还没有记录的轮次不算超过上限。
- **撤销本轮**有文件不会恢复时先说明，否则立刻执行。撤销此文件没有恢复，所以先确认；整轮因部分文件之后又改过而不能撤销时它仍可用，真正改过的文件由 Host 拒绝。
- **回执只来自这次按下的响应。** 重新打开或换设备时只显示 GET 能给的：已撤销、恢复、不在撤销范围内的文件。
- **刷新。** 轮次结束、回到窗口、连接恢复和点按时刷新；运行中与刷新失败时保留上次的列表并标明。切换范围后，新范围的回答到达前不显示列表和动作。
- **会话状态先于轮次记录变化**：面板按会话状态决定能否写入，并重读记录直到两者一致。
- 数据范围是 `work` 的设备读不到这些路由，面板写明原因。
- 文件很多时先列表，单个文件点开才读；差异列表每次 150 个文件。

**手机的复核页**（`apps/web/src/phone-review`）从会话列表直达：上一轮改了文件而这台设备还没看过、有没发出的反馈，或发出的反馈还没标为已复核时，列表里出现「复核 N 处改动」。

- N 是最近一轮的文件数，从 `GET changes/turns` 读，只对数据范围 `files` 的设备；读不到时只凭快照的反馈计数。
- 打开这一页算读过这个会话。数据范围是 `work` 的设备看到锁住的说明，仍有「去提交」。
- iPhone/iPad App 走同一条路，判断在共享核心 `PhoneReview`。「看过」记在这台电脑的加密资料库，不写 Host；超过单个 1 MiB 回答的文件写「文件太大，到 Mac 上看」。
- App 的反馈写入带持久的 `requestId`，没有答复时只重试同一请求。`openSends` 里列出（或已发出）的同一组反馈由 Host 接手，手机只丢掉自己的副本，再走 Host 的重试与放弃路由。

## 行级反馈

在差异里选中一行或几行写给 Agent 的反馈，按会话存在 Host 上（`review-notes.ts`）。

- **存储。** 数据目录 `review-notes/<会话 ID 的 SHA-256>.json`，0600，整文件原子写入，schema 是 strict；会话删除时一并删除。
- **一条反馈**记文件夹与路径、行范围（1 起、含两端，最多 100 行）、所在一侧（`new`：新增与未改动的行；`old`：删除的行）、锚点（做反馈时的范围与轮次、选中的原文与原文的 SHA-256）、文字（最多 4,000 字符）、状态、创建它的设备与时间，以及改过文字的设备（`editors`，含写下它的设备，最多 16 台，更多时 409 `review-note-editors`；不发给设备）。
- **上限。** 每个会话最多 200 条（409 `review-note-limit`），一次发送最多 50 条，同时最多 32 个没有结果的发送。

状态有四个，后三个只由人设定，Host 不推断「修好了」：

| 状态 | 含义 |
| --- | --- |
| `pending` 待发 | 在待发集合里；只有它能改文字 |
| `sent` 已发送 | 随 `messageId` 那条用户消息发出 |
| `agent-claimed` Agent 称已修 | 人看了 Agent 的回复后标记的 |
| `reviewed` 你已复核 | 人看过改动后勾选的 |

只有带消息 ID 的反馈能设 `agent-claimed` 与 `reviewed`（否则 409 `review-note-not-sent`）。

**发送。** 「发给 Agent」把所选的待发反馈拼成一条消息（`reviewNotesMessage`：每条的路径与行、用围栏引用的原文、文字，按给出的顺序），经 Host 的普通输入路径（与 `POST /tasks/:id/prompt` 同样的检查与 Driver 回执）发给这个会话。所选反馈的创建与修改设备随之交给输入路径（排队时记在排队项上）：这一轮的模拟器输入授权要它们都具备，见 [DEVICE-PREVIEW](DEVICE-PREVIEW.md)。

- 消息最多 16,000 个字符，与输入路由和队列相同；更长是 413 `review-note-too-long`，什么也不记。
- **两个 ID。** 设备的 `requestId`（UUID）只是这次写入的回执键。Host 为每次发送另生成消息的请求 ID（`promptRequestId`，记在发送记录里），只用它发送、只凭它在会话里认出这条消息，所以别的请求的消息不会让反馈成为已发送。
- **先记后发。** 发出之前先记下发送：拼好的文字原样保留，反馈锁定为发送中，仍算待发。会话里出现带这个 ID 的用户消息后，反馈才成为 `sent` 并带上消息 ID。
- **Host 明确拒绝**（4xx，例如这一轮还在运行）：反馈回到待发。

**排队。** 会话运行中、Host 支持排队（`features.queue`，与输入框相同）时，发送带 `queue`，走输入框的排队路径。

- 反馈保持待发并锁定，跟着排队项走：编辑排队项会换掉它的请求 ID，所以以排队项当前的 `sendRequestId` 找消息。
- 消息随下一轮发出后成为 `sent`；排队项被移除或丢弃时回到待发。
- 同一 `requestId` 换了排不排队是 409。Host 不支持排队时，运行中不能发。

**结果未知**（5xx、超时、连接断开）时发送保持打开，列表的 `openSends` 列出它。能写这个会话的任何设备都可以：

- `retry`：用 Host 的同一请求 ID 重发同一段文字。Driver 的回执去重，会话里已有这条消息就直接结算。
- `abandon`：Host 确认会话里没有这条消息、它不在队列里、也没有带这个 ID 的输入正在发送或已被接收后，反馈回到待发；否则 409（`review-send-delivered`、`review-send-queued`、`review-send-in-progress`）。
- 设备被移除后，它打开的发送若没有任何部分在路上，读取列表时回到待发。

**重新定位。** 页面按当前显示的差异重新定位每条反馈（`locateNote`），从不挪到别的代码上：

| 情况 | 结果 |
| --- | --- |
| 原位置的行与原文完全相同 | 原位 |
| 上下 200 行内有完全相同的原文 | 最近的一处为新位置 |
| 两处一样近；原文太单薄（去掉空白不足 8 个字符，只有一行时不足 20 个，如单独的 `}` 或 `return x`）；找不到 | 「位置可能过期」，单独显示原文 |

有反馈或正在选中的未改动行不折进「N 行未改动」。

**权限与同步。** 见[路由](#路由)的权限，另有：

- 写入经过会话输入的检查（私有会话、只读会话、文件夹）。
- 快照的 `reviewNotes` 只给每个会话的计数与修订号，凡能读这个会话的设备都收到；文字与原文只经列表路由。每次写入都刷新快照，其他设备按修订号重读列表。
- 每个写入带 `requestId`：同一设备重试得到原回执，同一 ID 换了内容是 409 `request-reused`。

## 补丁

复制补丁生成 `git apply` 可用的统一差异，会话有多个文件夹时路径前加文件夹 ID。二进制、过大、可能含密钥与未留存的文件不进入补丁，只计入 `omitted`；超过 8 MB 时截断。

## 验证

用例在 `apps/host/test/` 的 `changes-*.test.ts` 与 `review-notes.test.ts`，以及 `e2e/changes.e2e.ts`、`e2e/changes-panel.e2e.ts`、`e2e/review-notes.e2e.ts`、`e2e/phone-review.e2e.ts`；运行方式见 [TESTING.md](TESTING.md)。

- `changes-diff.test.ts` 用 `git apply` 往返校验补丁；`changes-git.test.ts` 用真实仓库核对 Git 进程的参数与环境。
- 归属用假 ACP Agent 的 `shell-edit` 一轮（自己的编辑与 shell 命令的编辑各一次）；反馈的 e2e 用 `FAKE_ACP_EDIT_QUEUE` 决定假 Agent 下一轮改什么。
- 这些用例只用临时目录与假 Agent，不代替真实 Agent 验收。
