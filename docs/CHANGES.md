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

`ChangesEngine`（`apps/host/src/changes/engine.ts`）在每轮开始与结算时记录会话文件夹，回答「改动」面板的四个范围，并执行撤销本轮、恢复、撤销此文件与撤销全部改动。`routes/changes.ts` 把它接到 HTTP 路由与会话生命周期，`catalog.features.changes` 表示 Host 有这些路由。右侧面板的「改动」页签（`apps/web/src/panel/changes`）是它们的界面。

## 快照

`beginTurn` 在一轮开始时记录会话冻结的文件夹，记录写入磁盘后才返回，调用方可以让这一轮的第一条提示等它完成；`settleTurn` 在结算时再记录一次，并与开始时比较。遍历与输出观察使用同一套忽略规则（`files/ignore.ts`）：`.git`、`node_modules`、`dist`、`build`、`.next`、`.venv`、`__pycache__`、`.DS_Store` 与 `*.tmp` 不记录；不跟随符号链接，跳过 Host 受保护路径；最多 50,000 个目录项、32 层、10 秒，超出时该文件夹记为不完整，不据此推断新增或删除。

内容按 SHA-256 存一份，同一项目的会话共享。1 MB 以内的文件读取后复制；更大的文件在同一卷上用 `/bin/cp -c`（clonefile）做 APFS 克隆。Node 的 `copyFile` 在 macOS 上从不克隆，所以不用它。另一卷上超过 1 MB 的文件、超过 128 MB 的文件只记元数据（「太大，没有留存」）。名称像密钥的文件（`.env`、私钥、凭据文件等）从不读取，只记元数据；内容含密钥的文件只记哈希，不存内容。元数据未变的文件沿用上一次的记录，不再读取。

## 存储与保留

记录在数据目录的 `snapshots/` 下：`<项目>/objects/` 存内容，`<项目>/sessions/<会话>/` 存 `head.json`（最近一次记录）与 `turns.json`（保留的轮次）。

每个会话保留最近 20 轮；每个项目保留的内容按逻辑大小不超过 2 GB，超出时从最早的已结算轮次删起，没有轮次的会话随后删掉最近记录，再清除无人引用的内容。快照的余量只扣除无法删除的部分（各会话最近记录与运行中的轮次），旧轮次在快照之后让位。被删轮次之后的第一轮不再保留它开始之前的改动，因为任何范围都不早于它。`recover()` 把 Host 停止时仍在运行的轮次按中断结算，不做归属；Host 每次启动时调用，因为 `hostStopping` 之后这些运行不再有 `runSettled`。

## 范围

- 本轮：一轮开始与结束的比较；运行中与此刻的工作区比较，并标明运行中。
- 这个会话：最早保留的一轮开始时与此刻比较，依次合并各轮的改动、轮次之间的改动和最近记录之后的改动；改回原样的文件不列出。
- 未提交：工作区与 HEAD 比较，包括暂存与未跟踪（未被忽略）的文件。范围行的「去交付」打开会话面板的「交付」页签（[GIT-DELIVERY.md](GIT-DELIVERY.md#界面)）。
- 与 main 比较：工作区与当前分支和 `main`（或 `master`，本地或 `origin`）的合并基点比较；分离 HEAD 或就在 main 上时没有此范围。

列表给出状态 A/M/D/R（内容相同的删除与新增合为重命名）、增删行数与标记：二进制、超过 1 MB、可能含密钥（只列路径，从不给内容）、未留存、执行位变化。行级差异用有工作量上限的 Myers 算法在 Host 上计算，超出上限时整段显示为替换；单个文件的差异可以带任意行数的上下文。

结算时调用方传入这一轮的工具编辑（`ToolDetail.diffs`）。本轮新增或删除的一行，若 Agent 自己的某次编辑新增或删除了同一行，就算 Agent 的，其余算「由命令修改」：文件与行都带 `byCommand`。这个会话中，轮次之间的改动标为 `byUser`。归属来自时间窗口：同一文件夹里其他程序在这一轮期间的写入也会算作命令。另一个会话这一轮期间也在同一文件夹（或其子文件夹、上层文件夹）运行时，这一轮带 `otherSessions`，界面用琥珀的「另一个会话也在改这里」标出。这一轮打开时的用户消息带 `turnId`，对话由它找到这一轮；只对话模式的运行碰不到文件夹，没有这个字段。

## 只读 Git

Git 只读运行，不执行仓库配置的钩子与过滤器；带过滤器或换行转换的文件可能显示为已修改。交付（[GIT-DELIVERY.md](GIT-DELIVERY.md)）的状态、暂存与取消暂存用同一个受限运行器。

只有位于工作树顶层、且 Git 元数据通过只读分支检查（[BRANCHES.md](BRANCHES.md)）的文件夹才运行 Git，`GIT_DIR` 来自那次检查。macOS 上只用 Homebrew 或开发者工具中的 Git，不用会弹出安装提示的 `/usr/bin/git`。符号链接、子模块与稀疏检出未展开的文件不列出。

仓库正在合并、变基、拣选或还原，或有 Git 标记为未合并的文件时，两个 Git 范围带 `conflict`（进行中的操作与冲突文件数），冲突文件带 `conflicted`。这时撤销未提交的改动报 409 `change-git-conflict`，一个文件也不写。撤销本轮不受影响：它只写回这一轮之后没再改过的文件。

## 撤销与丢弃

撤销本轮把这一轮改过的文件写回开始时的内容（新建的删除，删除的恢复），恢复则写回结束时的内容。只有每个文件都还停在这一轮留下的样子（按内容哈希核对）时才执行，否则报「之后又改过这些文件」；已是目标内容的文件跳过。开始或结束时的内容有一边没有留存（太大或可能含密钥）的文件不写也不删，计入 `skipped`，因为那一边无法再写回，恢复时同样不动；这一轮的文件全都如此时撤销报 409 `change-not-retained`，也不算撤销过。会话有轮次在运行时拒绝。带同一 `requestId` 的重试返回原回执。撤销此文件只处理选中的文件；撤销全部改动把未提交的改动写回 HEAD 的内容并删除未跟踪的文件，不改 Git 索引，可能含密钥的文件既不写也不删。

回执与结果列出没有动的文件（`notRestored`，原因是内容未留存、可能含密钥或文件夹已不在，超过 200 个时只列前面的，`skipped` 是总数）。撤销本轮的回执另带 `notCovered`：这一轮的工具编辑提到、但快照不记录的文件（文件夹之外或被忽略的路径）。命令写到文件夹之外的文件没有痕迹，列不出来。

撤销不会改变 Agent 的记忆，所以写回文件后 `noteNextTurn` 为真，下一条消息带一段说明（`[Latch] 在这条消息之前，用户撤销了…`），写在消息文字的最前面并以空行隔开：Agent 与任何 Driver 都收到同样的文字，对话里也看得到，`splitChangeNote` 把它和用户写的内容分开。撤销后又恢复且尚未告知时，两者抵消，但丢弃写过的文件仍要告知；没有写任何文件的丢弃不需要说明。会话还没有轮次时，说明记在会话上，下一轮同样带上。说明在下一轮开始时才算告知，同一 `requestId` 重试得到相同的文字，因为 Driver 拒绝文字不同的重试。斜杠命令（以 `/` 开头紧跟非空白）不带说明，因为命令必须在消息最前面；说明留给下一条普通消息。读取说明最多等 15 秒，超时后消息照发，说明留给下一条，这条消息的重试也不带。没有说明要告知时，消息不排在项目的改动队列后面。

每次写入前，引擎把计划交给调用方的 `beforeWrite` 记审计，内容只有 ID、计数与计划哈希；它抛错时一个文件也不写。

## 人的编辑

文件预览的「编辑」（[DOCUMENT-PREVIEWS.md](DOCUMENT-PREVIEWS.md#编辑)）经 `personEdit` 写文件：写入在项目的锁里进行，不会落在一次快照、撤销或丢弃的中间；会话或同一文件夹里有一轮在运行时 Host 拒绝。上一轮还在记录时，请求在拿锁之前等它记录完（最多 15 秒）；拿到锁后再看一次，那时仍在记录就直接拒绝，从不在持锁时等待。写完后引擎在会话的 `turns.json` 里记下文件、写入内容的哈希与时间（`edits`，最多 100 条）。这个会话范围里两轮之间改动的文件，内容仍是人最后一次保存的内容时带 `byPerson`，界面写「你的修改」；之后被别的程序改过就回到「两轮之间改动」。

每条编辑也是一条说明，与撤销的说明一样在下一条消息开始时告知：`[Latch] 在这条消息之前，用户编辑了 a.txt、b.txt。…`，最多列出五个路径，其余写「等 N 个文件」。主文件夹里的文件写相对路径，其他文件夹写完整路径。尚未被任何消息带上的同一文件只说一次。

## 路由

都在 `/link/api/tasks/:id/` 下，位于路由模块的 `route` 钩子，经过所有入口检查：

| 路由 | 说明 |
| --- | --- |
| `GET changes?scope=&turn=` | 范围内的文件、合计、撤销与恢复的可用性 |
| `GET changes/file?scope=&turn=&root=&path=&context=` | 单个文件的差异 |
| `GET changes/patch?scope=&turn=` | 复制补丁 |
| `GET changes/turns` | 保留的轮次 |
| `POST turns/:turnId/undo`、`redo`（`{ requestId }`） | 撤销本轮、恢复 |
| `POST changes/discard`（`{ scope: 'turn', turnId, files }`） | 撤销此文件 |
| `POST changes/discard/preview`（`{ files? }`） | 撤销未提交改动前的确认内容：要删的文件、`planHash` 与确认框的 `warning` |
| `POST changes/discard`（`{ scope: 'uncommitted', files?, confirm }`） | 撤销未提交的改动 |
| `GET review-notes` | 行级反馈与修订号；`openSends` 是结果未定或在排队的发送 |
| `POST review-notes`（`{ requestId, root, path, range, side, scope, turnId?, lines, text }`） | 新建一条待发反馈 |
| `POST review-notes/:noteId/edit`、`status`、`delete`（`{ requestId, … }`） | 改文字（只限待发）、设状态（`sent`、`agent-claimed`、`reviewed`）、删除 |
| `POST review-notes/send`（`{ requestId, noteIds, queue? }`） | 把这些待发反馈作为一条消息发出，或排到下一轮 |
| `POST review-notes/sends/:sendId/retry`、`abandon`（`{ requestId }`） | 重试结果未知的发送，或在确认没有送出后放弃 |

读取需要 view；写入需要 run，运行中拒绝；撤销未提交的改动只在这台电脑上，不可恢复。

## 界面

右侧面板的「改动」页签（⌘D，浏览器里 Alt D）按范围列出文件。范围行放撤销的动作，或没有动作的原因；撤销本轮有文件不会恢复时先说明，否则立刻执行，回执列出写回的数量、没有恢复的文件和原因（`notRestored`、`notCovered`）。回执只来自这次按下的响应，重新打开或换设备时只显示 GET 能给的：已撤销、恢复、不在撤销范围内的文件。撤销此文件没有恢复，所以先确认；这一轮只因部分文件之后又改过而不能整轮撤销时，它仍在，真正改过的文件由 Host 拒绝。

`partial` 不隐藏：可能还有没列出的文件，撤销也碰不到它们。列表在轮次结束、回到窗口、连接恢复和点按时刷新，运行中保留上次的列表并标明；刷新失败时也保留上次的列表并标明。切换范围后，新范围的回答到达前不显示列表和动作。会话状态先于轮次记录变化，面板按会话状态决定能否写入，并重读记录直到两者一致；运行中和离线时范围行写明不能撤销。选中的轮次超过保留上限时写明，还没有记录的轮次不算超过上限。数据范围不是 `all` 的设备读不到这些路由，面板写明原因。

行级反馈：按行号选中一行，Shift 加按（触屏上第二次按）选到那一行；键盘在行号上按 Enter，在空的反馈框里用 Shift ↑ / ↓ 增减一行；⌘ Enter 加入待发，Esc 取消。反馈卡片在它所在的最后一行下面，写着行、状态与文字；位置过期的卡片在文件开头，带原文，文件头标「位置可能过期」；不在当前范围的文件的反馈列在列表末尾。底栏写「待发反馈 N 条」，「清空」先确认，「发给 Agent」是这一页唯一的主操作，运行中与离线时不能按；发送结果未知时写明并提供「放弃这次发送」与「重试同一请求」；发出后写「Agent 在修订」，结束后写「N 条待你复核」。已发送的卡片有「Agent 称已修」与「标为已复核」。文件很多时先列表，单个文件点开才读（不另写一行说明）；文件树只画视口附近的行，差异列表每次 150 个文件。

审计动作是 `change.undo`、`change.redo` 与 `change.discard`，经 `beforeWrite` 先写，写入失败就不执行。

运行开始时（`runStarted`）记录开始的快照，提示等它完成，最长等待 15 秒；Driver 在 `createTask` 返回前就开始第一轮，这时项目还没写入会话记录，所以这一轮的项目取自正在进行的创建（`creatingProject`），否则它的记录会落到默认项目，新会话第一轮的 `changes/turns` 为空。运行结算时（`runSettled`）从打开这一轮的用户消息之后的工具消息取得 `ToolDetail.diffs`，交给 `settleTurn`。同一会话的下一轮等上一轮记录完。会话删除时一并删除它的记录。

## 行级反馈

在差异里选中一行或几行写给 Agent 的反馈。反馈存在 Host 上，按会话保存（`review-notes.ts`，数据目录 `review-notes/<会话 ID 的 SHA-256>.json`，0600，整文件原子写入，schema 是 strict）；会话删除时一并删除。每条记录文件夹与路径、行范围（1 起、含两端，最多 100 行）、所在一侧（`new`：新增与未改动的行；`old`：删除的行）、锚点（做反馈时的范围与轮次、选中的原文与原文的 SHA-256）、文字、状态、创建它的设备与时间。每个会话最多 200 条。

状态有四个，后三个只由人设定，Host 不推断「修好了」：

| 状态 | 含义 |
| --- | --- |
| `pending` 待发 | 在待发集合里；只有它能改文字 |
| `sent` 已发送 | 随 `messageId` 那条用户消息发出 |
| `agent-claimed` Agent 称已修 | 人看了 Agent 的回复后标记的 |
| `reviewed` 你已复核 | 人看过改动后勾选的 |

只有发出过的反馈能设后两种状态。

**发送。** 「发给 Agent」把所选的待发反馈拼成一条消息（`reviewNotesMessage`：每条的路径与行、用围栏引用的原文、文字，按给出的顺序），经 Host 的普通输入路径（`sendPrompt`，与 `POST /tasks/:id/prompt` 同样的检查与 Driver 回执）发给这个会话。消息最多 16,000 个字符，与输入路由和队列相同；更长时报 413 `review-note-too-long`（「反馈太长，分两次发」），什么也不记。设备的 `requestId` 只是这次写入的回执键（UUID）；Host 为每次发送另生成消息的请求 ID（`promptRequestId`，记在发送记录里），只用它发送、只凭它在会话里认出这条消息，所以别的请求的消息不会让反馈成为已发送。发出之前先记下发送（拼好的文字原样保留，反馈锁定为发送中，仍算待发），会话里出现带这个 ID 的用户消息后，反馈才成为 `sent` 并带上消息 ID。

会话运行中、Host 支持排队（`features.queue`，与输入框相同）时，按钮写「排到下一轮」，发送带 `queue`，走输入框的排队路径：反馈保持待发并锁定，卡片写「已排队」，跟着排队项走——编辑排队项会换掉它的请求 ID，以排队项当前的 `sendRequestId` 找消息；消息随下一轮发出后成为 `sent`；排队项被移除或丢弃时回到待发。同一 `requestId` 换了排不排队报 409。Host 不支持排队时运行中按钮写「本轮结束后发」且不能按。

Host 明确拒绝（4xx，例如这一轮还在运行）时反馈回到待发。结果未知（5xx、超时、连接断开）时发送保持打开，列表的 `openSends` 列出它：能写这个会话的任何设备都可以 `POST review-notes/sends/:id/retry` 用 Host 的同一请求 ID 重发同一段文字（Driver 的回执去重，会话里已有这条消息就直接结算），或 `abandon`「放弃这次发送」——Host 确认会话里没有这条消息、它不在队列里、也没有带这个 ID 的输入正在发送或已被接收后，反馈回到待发。设备被移除后，它打开的发送若没有任何部分在路上，读取列表时回到待发。只有带消息 ID 的反馈能设 `agent-claimed` 与 `reviewed`。

**重新定位。** 页面按当前显示的差异重新定位每条反馈（`locateNote`）：原位置的行与原文完全相同是原位；否则在上下 200 行内找完全相同的原文，最近的一处为新位置；两处一样近、原文太单薄（去掉空白不足 8 个字符；只有一行时不足 20 个，如单独的 `}` 或 `return x`）或找不到时标为「位置可能过期」，单独显示原文，从不挪到别的代码上。有反馈或正在选中的未改动行不折进「N 行未改动」。

**权限。** 反馈引用代码，所以读取与写入都要求数据范围 `all`（`file-scope`）；读取要 view，新建、改字、删除、设状态与发送要 run，并经过会话输入的检查（私有会话、只读会话、文件夹）。快照的 `reviewNotes` 只给每个会话的计数与修订号，凡能读这个会话的设备都收到；文字与原文只经列表路由。每次写入都刷新快照，其他设备按修订号重读列表。每个写入带 `requestId`：同一设备重试得到原回执，同一 ID 换了内容报 409 `request-reused`。

## 补丁

复制补丁生成 `git apply` 可用的统一差异，会话有多个文件夹时路径前加文件夹 ID。二进制、过大、可能含密钥与未留存的文件不进入补丁，只计入 `omitted`；超过 8 MB 时截断。

## 验证

`changes-diff.test.ts` 用 `git apply` 往返校验补丁；`changes-snapshots.test.ts` 覆盖遍历、复制与克隆、密钥、上限与记录文件；`changes-git.test.ts` 用真实仓库核对各种状态、与 main 比较、Git 进程的参数与环境、超时与输出上限；`changes-engine.test.ts` 覆盖归属、撤销与恢复、审计失败、符号链接、会话范围、保留与恢复，并让假 ACP Agent 的 `shell-edit` 一轮分别做自己的编辑与 shell 命令的编辑。`changes-routes.test.ts` 经真实 Host 与假 ACP Agent 核对入口权限、审计先写、说明的文字与重试、确认过期和停止后的恢复；`e2e/changes.e2e.ts` 走完一轮 shell 编辑：归属、撤销与恢复、下一条消息的说明、确认后的丢弃。`e2e/changes-panel.e2e.ts` 走完面板的范围、状态、撤销与回执。`review-notes.test.ts` 覆盖重新定位、消息文字、存储的回执与 strict schema、路由的权限与计数、发送与重试、拒绝后回到待发；`e2e/review-notes.e2e.ts` 用真实仓库与假 ACP Agent（`FAKE_ACP_EDIT_QUEUE` 决定它下一轮改什么）走完选中范围、两条反馈、发送、Agent 修改后一条随行移动一条过期、标记状态，以及 390 宽的第二个浏览器实时看到同样的反馈。这些用例只用临时目录，不代替真实 Agent 验收。
