---
description: 交接：把一个会话里选出的材料与要求交给代码会话，再把结果按约定范围交回；记录、回执、版本校验、权限裁剪与审计。
sources:
  - apps/host/src/handoffs.ts
  - apps/host/src/routes/handoffs.ts
  - apps/host/src/server.ts
  - apps/host/src/audit-actions/sessions.ts
  - packages/protocol/src/handoffs.ts
  - apps/web/src/handoffs/model.ts
  - apps/web/src/handoffs/SourceHandoff.tsx
  - apps/web/src/handoffs/TargetHandoff.tsx
  - apps/web/src/handoffs/ReturnedResult.tsx
---
# 交接

交接把一个会话（来源，常是某个 Agent 的会话）里选出的材料与要求交给一个代码会话（目标：新会话，或已有会话），目标完成后把结果按约定范围交回来源。同一 Host 内、一次往返。

- 来源从不被改写。
- 目标永远是普通会话，经与 `POST /tasks`、`POST /tasks/:id/prompt` 相同的路径开始或接收输入。项目队列、项目与 Harness 检查、工作树、文件引用检查、启动审计与回执都和手动开始一样。
- 不做：自动组队、自动把结果发给来源的 Agent、跨 Host。

`catalog.features.handoffs` 声明下面的接口，网页只在它存在时提供交接。

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `POST /handoffs` | `run` | `HandoffCreate`：新建并开始目标，201；同一设备同一 `requestId` 的重试回答同一条交接，200 |
| `GET /handoffs?sessionId=` | `view`，且能读这个会话 | 以它为来源或目标的交接 |
| `GET /handoffs/:id` | `view` | 一条交接；来源与目标都读不了时 404 `handoff-not-found` |
| `POST /handoffs/:id/return` | `run`，且能读目标会话 | `{ requestId, summary, evidence }`：交回结果 |
| `POST /handoffs/:id/withdraw` | `run`，且能读来源会话 | `{ requestId }`：撤回或关闭（见「状态与回执」） |

## 新建

请求为 `{ requestId, sourceSessionId, target, materials, requirements, decisions, returnScope, locale? }`。

- `target` 是 `{ kind: 'new-session', projectId?, harnessId?, mode?, model?, worktree? }`（与 `POST /tasks` 的选择相同）或 `{ kind: 'session', sessionId }`。
- `materials` 每项是 `text`（选出的文字）、`message`（来源会话的一条用户或 Agent 消息）或 `file`（来源会话文件夹里的一个文件引用）。`message` 与 `file` 带内容的 SHA-256（消息正文的 UTF-8，文件的字节），即选定时的版本。

| 上限（`HANDOFF_LIMITS`） | 值 |
| --- | --- |
| 材料 | 32 项 |
| 文字材料与引用的消息合计 | 64 KB（413 `handoff-too-large`） |
| 要求 | 8 KB |
| 决定 | 16 条，每条 1000 字 |
| 交回的结论 | 16,000 字 |
| 证据 | 32 项 |
| 单个文件（材料或证据） | 4 MB（413 `handoff-file-too-large`） |

Host 依次检查，任何一项不通过都不留记录、不写审计：

1. 材料与要求不能都为空（400 `handoff-empty`）；目标不能是来源自己（400 `handoff-same-session`）。
2. 调用方能读来源会话，与 `GET /tasks/:id` 相同：私有会话要求数据范围 `all`，否则 403 `agent-scope-required`。
3. 目标：新会话的 Harness 已启用并就绪、项目存在；已有会话要通过与输入相同的检查。来源是私有会话时，已有会话也必须是私有的（403 `handoff-private-target`）；新会话则与分叉一样随来源成为私有会话。
4. 每项材料仍是选定时的版本，否则 409 `handoff-material-changed`，`materials` 列出变化的序号。消息不在来源里时 404 `handoff-material-missing`。

文件材料另有规则：

- 需要数据范围 `files`（403 `file-scope`），经 `@` 引用的检查后读取：不在会话文件夹里、受保护路径与疑似密钥都拒绝。
- 不同的 Harness 给同一个文件夹起的名字不同，所以文件按来源里解析出的真实路径在目标的文件夹里找，换成目标的文件夹名与相对路径。
- 在目标一侧再经同样的 `@` 引用检查、受保护路径与密钥判断、4 MB 上限，以不跟随链接的方式读一次：真实路径与哈希都必须和来源相同。文件不在目标的任何文件夹里，或在那里读不到同一个文件时，409 `handoff-file-elsewhere`。
- 新工作树只有已提交的文件，所以带文件材料时不能选新工作树（400 `handoff-worktree-files`）。

然后依次：先写新建的审计（动作名见 `audit-actions/sessions.ts`；交接与会话 ID、目标类型、材料、文件与决定的条数、回传范围、第一条消息的哈希），写入失败就不新建；再写记录（状态 `starting`）与回执；最后开始目标。

**目标的第一条消息**由 Host 按固定模板写出：

- 一句说明、「要求」、编号的「已定的决定」、逐项的「材料」。文字与消息原样放在比其中任何反引号串都长的围栏里；文件只写引用，并作为结构化文件引用附上。
- 模板有中文与英文两套，由 `locale`（`zh-CN` 默认，或 `en`）选择。
- 它可以超过手动输入的 16,000 字符上限，驱动的 1 MB 上限仍适用。
- 新会话的标题取「要求」的第一行，没有要求时取第一项材料的第一行（文件取文件名），最多 60 个字符。标题随待发送的开始一起保存，重试用同一个。

## 状态与回执

| 状态 | 含义 |
| --- | --- |
| `starting` | 正在开始目标 |
| `started` | 目标已开始，`targetSessionId` 是它 |
| `start-unknown` | 开始没有得到回答（网络、超时、5xx 或 Host 在此期间停止）：可能已经有了目标会话；`failure` 若有，是最近一次重试被拒绝的原因 |
| `start-failed` | 确定没有开始：第一次开始就被拒绝（4xx），`failure` 是原因的代码与说明 |
| `returned` | 结果已交回 |
| `withdrawn` | 目标开始之前撤回 |
| `closed` | 目标开始之后关闭：目标会话照常保留，不再接受交回 |

**开始的请求 ID**：目标的开始与输入用一个只属于这条交接的随机 UUID，保存在记录里，从不返回给任何设备。驱动按请求 ID 保存创建与输入的回执，所以重试只会得到已经建好的会话，不会再建一个。第一条消息与它的文件引用只在开始有定论之前保存在记录里，所以重试发出的总是同一条。

`start-unknown` 有两种定论：

- **查询**：`GET` 时 Host 不发送任何东西，只找已有的会话。已有会话就看目标；新会话看最近 32 个所选 Harness、所选项目中创建时间晚于交接的会话。第一条用户消息（已有会话：带这个请求 ID 的那条）带这个请求 ID，且正文等于记录的第一条消息（哈希与长度相同），才记为 `started`。给已有会话的输入前面可能有 Host 的撤销说明和一个空行，不计入比较。
- **重试**：同一设备用同一 `requestId` 重发 `POST /handoffs`。Host 先查询；找不到才用同一个请求 ID 再开始一次，驱动的回执把它变成已有的会话，或在确实没有开始时现在开始。这次重试被拒绝（4xx）时状态仍是 `start-unknown`，`failure` 写明原因：之前那次没有回答的开始仍可能建了会话。

其他规则：

- Host 重启时仍是 `starting` 的交接改为 `start-unknown`。开始的结果写入失败时交接留在 `starting`，下一次读取或重试按上面的查询定论。
- `start-failed` 不自动重试：用新的 `requestId` 新建一条，或撤回这一条。
- 桌面端的安装窗口里，新的开始被拒绝为 409 `host-updating`，按上面的规则第一次记为 `start-failed`、重试仍是 `start-unknown`；Host 已记录的开始请求 ID 的重试照常得到原来的回答（[UPDATES.md](./UPDATES.md#安装门禁与-host-安装窗口)）。

**撤回**（`withdraw`）按状态处理：

| 当前状态 | 结果 |
| --- | --- |
| `start-failed` | 改为 `withdrawn` |
| `started` | 改为 `closed` |
| `start-unknown` | 先查询。找到会话就关联它并回答 409 `handoff-start-found`（带 `targetSessionId`，要结束就再关闭一次）；找不到就改为 `withdrawn`，并把开始请求 ID 记为作废 |
| `withdrawn`、`closed` | 原样回答 |
| `starting` | 409 `handoff-starting`（包括同一请求的重试正在开始，在写入时核对） |
| `returned` | 409 `handoff-returned` |

作废的开始请求 ID 之后即使出现带它的会话也不会被关联，同一 `requestId` 的重试不再开始。撤回写审计（含原来的状态）；审计失败也照常撤回，响应带 `x-latch-audit: failed`。

**会话被删除**后，以它为来源或目标的交接只保留 ID 与状态（`contentRemoved: true`）：材料、要求、决定与结果从记录中删除。这次写入不成功时 Host 记日志，之后每次交接操作与每秒一次的重试都再做，直到写入。Host 在此之前停止则不再补做，但已不存在的会话对任何设备都不可读。

## 交回

只在 `started` 时可以交回一次。结果只写在交接记录里，供来源会话显示；Host 不会把它发给来源的 Agent。

- `returnScope` 为 `none` 时拒绝（409 `handoff-no-return`），为 `summary` 时丢掉证据，为 `summary-and-evidence` 时保留证据。
- 证据是目标会话里的消息或文件，带哈希，逐项核对：不是现在的版本时 409 `handoff-evidence-changed`，`evidence` 列出序号；消息不在目标里时 404 `handoff-evidence-missing`。文件证据需要数据范围 `files`。
- 已关闭时 409 `handoff-closed`，会话已删除时 409 `handoff-session-deleted`。
- 先写交回的审计（ID、证据条数、结论的哈希），写入失败就不交回。
- 同一设备同一 `requestId` 的重试回答同一结果。

## 谁读到什么

- **私有只增不减**：会话是否私有在新建、开始与交回时记进记录。会话被删除、Host 重启后它的驱动没有挂上，或私有标记因别的原因不在了，记录仍按私有对待。
- **不存在的会话**（已删除，或驱动未挂上）对任何设备都不可读；这样的交接对新建它的设备仍可见，只有 ID 与状态。
- **只看到自己能读的那一边**：能读来源才有 `materials`、`requirements` 与 `decisions`。读不了目标时，结果只有 `summaryWithheld: true`，每项证据都是 `{ kind: 'withheld' }`，不透露路径或消息。文件证据另外要求数据范围 `files`。两边都读不了时这条交接不存在。
- **快照**的 `handoffs` 只列来源或目标在 `tasks` 中的交接，只含 ID、状态、回传范围与时间；变化时 Host 通知客户端重新读取快照。

## 存储

记录在数据目录的 `handoffs/handoffs.json`（目录 0700、文件 0600，原子写入，zod 严格校验）。

- 最多 256 条。每次写入时，文件超过 8 MB（文件本身的上限是 32 MB）或条数超过上限，先删最旧的已结束交接及其回执，这次写入所改的那条除外。已结束指 `returned`、`withdrawn`、`closed`、`start-failed`、约定不交回的 `started`，以及会话已删除的。
- 仍在进行的交接占满 256 条时新建回答 409 `handoff-limit`，关闭其中一些即可。
- 作废的开始请求 ID 只存哈希，最多 4096 个。
- 回执按设备与 `requestId` 的哈希保存所请求内容的哈希，同一请求 ID 换了内容回答 409 `request-conflict`。
- 写入结果未知时回答 503 `agent-write-unknown`，下一次请求先完成那次写入。

## 界面

网页（`apps/web/src/handoffs/`）只用上面的接口，状态以 Host 的回答为准。

- **来源会话**：「交给代码任务…」在输入框上方打开交接卡，带上选中的消息、选中的文字和这一轮提到或写出的文件（数据范围 `files` 才有文件）。每个消息与文件材料在选定时按 SHA-256 固定版本，文件经预览的授权句柄读取；全部固定后才能交。私有来源只列私有的已有会话。
- **没有回答时**卡片保留原请求：「查询」只读列表找同一 `requestId`，「重试同一请求」原样再发。409 `handoff-material-changed` 指出变化的材料，「用现在的版本」重新固定。离线时不能交。
- **开始之后**卡片换成一行状态。`start-unknown` 有「查询」（`GET /handoffs/:id`）与「重试同一请求」（按记录原样重建请求）；`start-failed` 写原因，可「重试」（新的 `requestId`）或「撤回」。
- **目标会话**：页头写「来自 <来源会话>」，这台设备列不出来源时只写「来自另一个会话」。约定交回且这一轮结束后可以「交回结果」：结论默认取最后一条回复，证据在范围允许时从本会话的文件与消息里勾选，提交时逐项算哈希。「结束交接」走 `withdraw`。
- **来源的时间线**：「交回的结果」由记录画出，不是一条消息，放在它交回之前开始的最后一轮之后。读不了的证据写「无权查看」；「带入输入框」把结论作为引用放进草稿，发不发由人决定；会话删除后写「内容已随会话删除」。
- **会话列表**：交接已开始、约定交回、目标这一轮已结束时，目标会话的行写琥珀色「待交回」。
- **iPhone 与 iPad**（`PhoneHandoffs`）：同样的「来自」「待交回」「交回结果」与「交回的结果」；轮次的「交给代码任务…」带这一轮的消息为材料，选新会话或已有会话与回传。文字选段、文件材料与文件证据、已定的决定与工作树位置尚未实现；没有答复时只重试同一请求。

## 限制

- 文件材料与证据的哈希按解析后的真实路径读取，最后一级以 `O_NOFOLLOW` 打开；上级目录在检查与读取之间被换成符号链接的竞争没有排除。读取只用来回答哈希是否相符，内容不进入记录或响应。
