---
description: 每轮快照、改动范围（本轮、这个会话、未提交、与 main 比较）、归属、撤销与恢复、丢弃、补丁与保留上限。
sources:
  - apps/host/src/changes
  - apps/host/src/routes/changes.ts
  - apps/host/src/audit-actions/changes.ts
  - packages/protocol/src/changes.ts
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

`ChangesEngine`（`apps/host/src/changes/engine.ts`）在每轮开始与结算时记录会话文件夹，回答「变更」面板的四个范围，并执行撤销本轮、恢复、撤销此文件与撤销全部改动。`routes/changes.ts` 把它接到 HTTP 路由与会话生命周期，`catalog.features.changes` 表示 Host 有这些路由。右侧面板的「变更」页签（`apps/web/src/panel/changes`）是它们的界面。

## 快照

`beginTurn` 在一轮开始时记录会话冻结的文件夹，记录写入磁盘后才返回，调用方可以让这一轮的第一条提示等它完成；`settleTurn` 在结算时再记录一次，并与开始时比较。遍历与输出观察使用同一套忽略规则（`files/ignore.ts`）：`.git`、`node_modules`、`dist`、`build`、`.next`、`.venv`、`__pycache__`、`.DS_Store` 与 `*.tmp` 不记录；不跟随符号链接，跳过 Host 受保护路径；最多 50,000 个目录项、32 层、10 秒，超出时该文件夹记为不完整，不据此推断新增或删除。

内容按 SHA-256 存一份，同一项目的会话共享。1 MB 以内的文件读取后复制；更大的文件在同一卷上用 `/bin/cp -c`（clonefile）做 APFS 克隆。Node 的 `copyFile` 在 macOS 上从不克隆，所以不用它。另一卷上超过 1 MB 的文件、超过 128 MB 的文件只记元数据（「太大，没有留存」）。名称像密钥的文件（`.env`、私钥、凭据文件等）从不读取，只记元数据；内容含密钥的文件只记哈希，不存内容。元数据未变的文件沿用上一次的记录，不再读取。

## 存储与保留

记录在数据目录的 `snapshots/` 下：`<项目>/objects/` 存内容，`<项目>/sessions/<会话>/` 存 `head.json`（最近一次记录）与 `turns.json`（保留的轮次）。

每个会话保留最近 20 轮；每个项目保留的内容按逻辑大小不超过 2 GB，超出时从最早的已结算轮次删起，没有轮次的会话随后删掉最近记录，再清除无人引用的内容。快照的余量只扣除无法删除的部分（各会话最近记录与运行中的轮次），旧轮次在快照之后让位。被删轮次之后的第一轮不再保留它开始之前的改动，因为任何范围都不早于它。`recover()` 把 Host 停止时仍在运行的轮次按中断结算，不做归属；Host 每次启动时调用，因为 `hostStopping` 之后这些运行不再有 `runSettled`。

## 范围

- 本轮：一轮开始与结束的比较；运行中与此刻的工作区比较，并标明运行中。
- 这个会话：最早保留的一轮开始时与此刻比较，依次合并各轮的改动、轮次之间的改动和最近记录之后的改动；改回原样的文件不列出。
- 未提交：工作区与 HEAD 比较，包括暂存与未跟踪（未被忽略）的文件。
- 与 main 比较：工作区与当前分支和 `main`（或 `master`，本地或 `origin`）的合并基点比较；分离 HEAD 或就在 main 上时没有此范围。

列表给出状态 A/M/D/R（内容相同的删除与新增合为重命名）、增删行数与标记：二进制、超过 1 MB、可能含密钥（只列路径，从不给内容）、未留存、执行位变化。行级差异用有工作量上限的 Myers 算法在 Host 上计算，超出上限时整段显示为替换；单个文件的差异可以带任意行数的上下文。

结算时调用方传入这一轮的工具编辑（`ToolDetail.diffs`）。本轮新增或删除的一行，若 Agent 自己的某次编辑新增或删除了同一行，就算 Agent 的，其余算「由命令修改」：文件与行都带 `byCommand`。这个会话中，轮次之间的改动标为 `byUser`。归属来自时间窗口：同一文件夹里其他程序在这一轮期间的写入也会算作命令。另一个会话这一轮期间也在同一文件夹（或其子文件夹、上层文件夹）运行时，这一轮带 `otherSessions`，界面写明归属可能不准。这一轮打开时的用户消息带 `turnId`，对话由它找到这一轮；只对话模式的运行碰不到文件夹，没有这个字段。

## 只读 Git

Git 只读运行，不执行仓库配置的钩子与过滤器；带过滤器或换行转换的文件可能显示为已修改。

只有位于工作树顶层、且 Git 元数据通过只读分支检查（[BRANCHES.md](BRANCHES.md)）的文件夹才运行 Git，`GIT_DIR` 来自那次检查。macOS 上只用 Homebrew 或开发者工具中的 Git，不用会弹出安装提示的 `/usr/bin/git`。符号链接、子模块与稀疏检出未展开的文件不列出。

仓库正在合并、变基、拣选或还原，或有 Git 标记为未合并的文件时，两个 Git 范围带 `conflict`（进行中的操作与冲突文件数），冲突文件带 `conflicted`。这时撤销未提交的改动报 409 `change-git-conflict`，一个文件也不写。撤销本轮不受影响：它只写回这一轮之后没再改过的文件。

## 撤销与丢弃

撤销本轮把这一轮改过的文件写回开始时的内容（新建的删除，删除的恢复），恢复则写回结束时的内容。只有每个文件都还停在这一轮留下的样子（按内容哈希核对）时才执行，否则报「之后又改过这些文件」；已是目标内容的文件跳过。开始或结束时的内容有一边没有留存（太大或可能含密钥）的文件不写也不删，计入 `skipped`，因为那一边无法再写回，恢复时同样不动；这一轮的文件全都如此时撤销报 409 `change-not-retained`，也不算撤销过。会话有轮次在运行时拒绝。带同一 `requestId` 的重试返回原回执。撤销此文件只处理选中的文件；撤销全部改动把未提交的改动写回 HEAD 的内容并删除未跟踪的文件，不改 Git 索引，可能含密钥的文件既不写也不删。

回执与结果列出没有动的文件（`notRestored`，原因是内容未留存、可能含密钥或文件夹已不在，超过 200 个时只列前面的，`skipped` 是总数）。撤销本轮的回执另带 `notCovered`：这一轮的工具编辑提到、但快照不记录的文件（文件夹之外或被忽略的路径）。命令写到文件夹之外的文件没有痕迹，列不出来。

撤销不会改变 Agent 的记忆，所以写回文件后 `noteNextTurn` 为真，下一条消息带一段说明（`[Latch] 在这条消息之前，用户撤销了…`），写在消息文字的最前面并以空行隔开：Agent 与任何 Driver 都收到同样的文字，对话里也看得到，`splitChangeNote` 把它和用户写的内容分开。撤销后又恢复且尚未告知时，两者抵消，但丢弃写过的文件仍要告知；没有写任何文件的丢弃不需要说明。会话还没有轮次时，说明记在会话上，下一轮同样带上。说明在下一轮开始时才算告知，同一 `requestId` 重试得到相同的文字，因为 Driver 拒绝文字不同的重试。斜杠命令（以 `/` 开头紧跟非空白）不带说明，因为命令必须在消息最前面；说明留给下一条普通消息。读取说明最多等 15 秒，超时后消息照发，说明留给下一条，这条消息的重试也不带。没有说明要告知时，消息不排在项目的改动队列后面。

每次写入前，引擎把计划交给调用方的 `beforeWrite` 记审计，内容只有 ID、计数与计划哈希；它抛错时一个文件也不写。

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

读取需要 view；写入需要 run，运行中拒绝；撤销未提交的改动只在这台电脑上，不可恢复。

## 界面

右侧面板的「变更」页签（⌘D，浏览器里 Alt D）按范围列出文件。范围行放撤销的动作，或没有动作的原因；撤销本轮有文件不会恢复时先说明，否则立刻执行，回执列出写回的数量、没有恢复的文件和原因（`notRestored`、`notCovered`）。回执只来自这次按下的响应，重新打开或换设备时只显示 GET 能给的：已撤销、恢复、不在撤销范围内的文件。撤销此文件没有恢复，所以先确认；这一轮只因部分文件之后又改过而不能整轮撤销时，它仍在，真正改过的文件由 Host 拒绝。

`partial` 不隐藏：可能还有没列出的文件，撤销也碰不到它们。列表在轮次结束、回到窗口、连接恢复和点按时刷新，运行中保留上次的列表并标明；刷新失败时也保留上次的列表并标明。切换范围后，新范围的回答到达前不显示列表和动作。会话状态先于轮次记录变化，面板按会话状态决定能否写入，并重读记录直到两者一致；运行中和离线时范围行写明不能撤销。选中的轮次超过保留上限时写明，还没有记录的轮次不算超过上限。数据范围不是 `all` 的设备读不到这些路由，面板写明原因。文件很多时先列表，单个文件点开才读；文件树只画视口附近的行，差异列表每次 150 个文件。

审计动作是 `change.undo`、`change.redo` 与 `change.discard`，经 `beforeWrite` 先写，写入失败就不执行。

运行开始时（`runStarted`）记录开始的快照，提示等它完成，最长等待 15 秒；运行结算时（`runSettled`）从打开这一轮的用户消息之后的工具消息取得 `ToolDetail.diffs`，交给 `settleTurn`。同一会话的下一轮等上一轮记录完。会话删除时一并删除它的记录。

## 补丁

复制补丁生成 `git apply` 可用的统一差异，会话有多个文件夹时路径前加文件夹 ID。二进制、过大、可能含密钥与未留存的文件不进入补丁，只计入 `omitted`；超过 8 MB 时截断。

## 验证

`changes-diff.test.ts` 用 `git apply` 往返校验补丁；`changes-snapshots.test.ts` 覆盖遍历、复制与克隆、密钥、上限与记录文件；`changes-git.test.ts` 用真实仓库核对各种状态、与 main 比较、Git 进程的参数与环境、超时与输出上限；`changes-engine.test.ts` 覆盖归属、撤销与恢复、审计失败、符号链接、会话范围、保留与恢复，并让假 ACP Agent 的 `shell-edit` 一轮分别做自己的编辑与 shell 命令的编辑。`changes-routes.test.ts` 经真实 Host 与假 ACP Agent 核对入口权限、审计先写、说明的文字与重试、确认过期和停止后的恢复；`e2e/changes.e2e.ts` 走完一轮 shell 编辑：归属、撤销与恢复、下一条消息的说明、确认后的丢弃。`e2e/changes-panel.e2e.ts` 走完面板的范围、状态、撤销与回执。这些用例只用临时目录，不代替真实 Agent 验收。
