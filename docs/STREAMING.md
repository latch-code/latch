---
description: 流式执行与阅读界面：三段链路、Host 的状态流、客户端的事件流与版本门禁、原生客户端的流、消息身份、审批与取消、写入的结果未知、时间与用量、运行的真实状态、阅读位置、Markdown 与代码渲染。
sources:
  - packages/core/src/runtime.ts
  - packages/core/src/store.ts
  - packages/sdk/src/bridge.ts
  - packages/protocol/src/types.ts
  - packages/protocol/src/sessions.ts
  - packages/protocol/src/task-delta.ts
  - packages/harness-acp/src/mapping.ts
  - packages/harness-acp/src/runtime.ts
  - packages/core/src/node-kit/timing.ts
  - apps/host/src/server.ts
  - apps/host/src/hub.ts
  - apps/host/src/run-silence.ts
  - apps/host/src/session-meta.ts
  - apps/host/src/traffic.ts
  - apps/host/src/task-delta.ts
  - apps/host/src/native-replay.ts
  - apps/web/src/core
  - apps/web/src/components
  - apps/web/src/conversation.ts
  - apps/web/src/conversation/SideQuestion.tsx
  - apps/web/src/conversation/useTranscriptProjection.ts
  - apps/web/src/hooks/useSubmission.ts
  - apps/web/src/MessageContent.tsx
  - apps/desktop/src/proxy.cjs
  - native/ios/Sources/LatchNativeCore/TaskStreamProjection.swift
  - native/ios/Sources/LatchNativeCore/BodyPublication.swift
  - native/ios/Sources/LatchNativeCore/BodyReading.swift
  - native/ios/Sources/LatchNativeCore/Workspace.swift
  - native/ios/Sources/LatchNativeCore/Events.swift
  - native/ios/Sources/LatchNativeCore/HTTP2.swift
---
# Latch 流式执行与阅读界面

新会话的常规草稿与创造草稿按不同键存放；未确认的首次提交保留 `pluginCreation` 和原请求 ID，重试同一份输入。创造标记来自 Host 的会话元数据，Driver 只负责向执行端投递指南。见[创造模式](PLUGIN-DEVELOPMENT.md#创造模式与插件市场)。

状态怎样从执行端到达每台设备并保持一致：传输、消息投影、重连、审批与取消的回执、写入的结果未知、阅读位置。架构与持久化见 [ARCHITECTURE.md](./ARCHITECTURE.md)，扩展契约见 [PLUGIN-DEVELOPMENT.md](./PLUGIN-DEVELOPMENT.md)，ACP Agent 的事件映射见 [HARNESSES.md](./HARNESSES.md)，界面表现见 [DESIGN.md](./DESIGN.md)。

## 请求组成、历史与上下文窗口

内置 Agent 会在组装好指令、筛完工具和附件之后，记录每次主模型请求。会话详情的 `contextSteps` 按请求顺序保留最近 32 条。序号跨轮连续，`turnId` 指向发起该轮的用户消息。清空上下文后，新请求从新的模型历史开始，图上保留先前的观测并标示分界。旧数据里的 `requestContext` 仍提供它实际保留的最后一次计数。

每条观测按 UTF-8 字节计量六类输入：指令、技能、工具定义、用户消息、Agent 消息、工具结果。文本附件计入所属消息。工具名称、说明、参数 schema 及历史调用的名称和参数按紧凑 JSON 计量。图片另计张数。无法序列化的工具定义记为未计量。观测只保存数值、时间、状态与轮次关联，签名、图片数据、协议封装及原始正文不进入观测。服务商回报的输入和输出 token 单独展示。未回报的值保持未知。请求耗时从调用模型服务到模型流结算，剔除观测落盘时间与后续工具执行。Host 异常退出时只恢复到准备标记的请求按中断显示，此时记录的时间是准备时刻，送达情况和耗时未知。审批判断所用的独立模型请求不进入这份历史。

每条内置观测另保留最多 5 条最大的工具结果，以及最多 5 条最大的首次纳入结果，均按请求实际组装出的 UTF-8 字节排序。首次纳入与后续重传按结果首次出现在哪条观测区分，旧结果缺少这项记录时保持未知。来源只保存 Host 生成的工具行和用户轮次标识。工具名称、服务商调用 ID、参数、结果正文和图片均不进入这两份列表。清空上下文后的请求从新的工具结果开始计量，先前的观测仍指向各自原有的来源。

外部 Harness 的 `usageReport` 保存窗口用量、容量、采样时间和已知来源。容量取自用户的模型设置时，由 `configuredContextSize` 标记。能归属到某轮的窗口报告还会写入该轮的 `turn.contextWindow`。只报告费用或在空闲时到达的读数不会归入下一轮。侧栏保留最近 32 轮的位置。前后两轮都有可比较的报告时，显示已用 tokens 的净变化。缺测、容量或来源改变、手动重新开始上下文、已确认完成的压缩都会中断比较。旧记录按已有字段展示。

Claude 原生接入沿用现有的用量查询，保存同次返回中的分类数值。已用、可用、预留和延迟加载各自有明确含义。消息内部的工具结果等明细属于消息这一项。服务商最近一次返回的输入和输出 tokens 单独展示。会话仅保留有明确来源的压缩事件和可核验的状态、时间及数值，能归属时关联到原轮次。窗口数值下降本身只形成一项读数变化。

## 三段链路

```text
Provider.stream             Standard Runtime             Host                   浏览器
  text 增量 ──────────────> 累计 liveText / 固定消息 ID
                             notify(sessionId) ────────> 约 40ms 合并
                                                       detail(sessionId)
                                                       完整基线 / 正文追加 ─> 流基线与版本检查
  finish ─────────────────> 持久化最终消息、工具队列
                             notify(sessionId) ────────> task-state 全状态 ───> 同一消息行结算
  工具/审批/取消结算 ──────> 更新真实状态 ──────────────> 同上

  连接重新打开：浏览器 GET snapshot → GET 当前 detail → 版本检查 → 标记已连接
```

- 模型流与状态流是两种协议。Provider 的 `text` 与 `reasoning` 是新增片段；Host 给客户端的是合并后的完整 `TaskDetail`，或在协商后、其余状态未变时的正文追加帧。追加帧属于 Host 的订阅基线，不转发 Provider 的 token。
- 工具执行只返回一次 `{ text }` 结果；通用的 stdout 流与百分比进度尚未实现。
- **没有 WAL、持久事件队列、Last-Event-ID 历史重放或逐事件缺口恢复。** 浏览器断线后通过当前快照收敛，不保证看过每个短暂的中间状态。SSE 关闭只移除订阅，不取消运行。创建与输入的幂等回执由 Runtime 持久化，审批决定与取消的回执由 Host 随会话保存。

## Host 的状态流

源码：[server.ts](../apps/host/src/server.ts)、[hub.ts](../apps/host/src/hub.ts)、[bridge.ts](../packages/sdk/src/bridge.ts)、[types.ts](../packages/protocol/src/types.ts)。各 Harness 的变化通知先经 HarnessHub 汇合。

**订阅。** `GET /link/api/events?sessionId=<当前会话>`，凭据与其他 API 相同，需要 `view`。不传 `sessionId` 时只收整体与列表变化。只推选中会话的正文是带宽策略，不是会话级权限；私有会话另按设备的数据范围过滤。流打开后 Host 先发一个 `refresh`。

**合并。** `Bridge.subscribe` 的通知进入待处理集合，自第一个待发通知起约 40ms 后一起读取。一轮读取未完成时不并发下一轮，期间的通知排到下一轮。这不是帧率，也不保证每个中间状态都发出。

| SSE 事件 | 发送条件 | 客户端动作 |
| --- | --- | --- |
| `task-state` | 某会话变化，且此连接选中它 | 经版本门禁后替换当前 detail，并合并该会话的摘要与审批 |
| `task-delta` | 已协商且已发过完整基线，只有正文或思考变长（见[协商后的正文追加](#协商后的正文追加)） | 校验基线后重建 detail，再过同一道版本门禁 |
| `tasks-invalidated` | 未选中的会话的摘要或审批变了 | 只同步 snapshot，不为每个 token 拉取 detail |
| `refresh` | 设备、配置等整体变化（含 Harness 版本检测结果），流刚打开，或本轮有会话读取失败 | 同步 snapshot 与选中的 detail |
| `host-state` | Host 即将不再应答（`stopping`、`sleeping`）或电脑醒来（`awake`） | 见 [Host 宣布的停止与睡眠](#host-宣布的停止与睡眠) |
| `app.data`、`app.updated` | 插件页面的文档或已应用页面变了 | 见 [APP-PAGES.md](./APP-PAGES.md#存储) 与[桥](./APP-PAGES.md#桥) |

摘要里的看板组（`board`）随会话元数据、记号与 Host 的交付事实变化，也经 `tasks-invalidated` 与 `task-state` 送达，事件种类不变。

**私有会话不泄露动静。** 私有会话（Agent、通用、接入、定时与 `agentPrivate`）的 `task-state` 与 `tasks-invalidated` 不发给数据范围不是 `all` 的设备，连不带 ID 的提示也不发；原生重放同样按读者略过。`app.data` 只发给能读那个作用域的连接。

**版本与顺序。**

- 每个 Host 进程有一个 `instanceId`，每次通知递增内存里的 `revision`。合并会跳过中间 revision，同一轮的不同会话共用一个 revision；它不是连续的增量日志。
- 浏览器入口每帧的 SSE `id` 是 revision，浏览器不使用它。`TaskDetail.cursor` 是 Driver 的状态版本（Standard 中随持久提交增加），区分不了内存里的每个文本片段。
- 每条连接记住 `lastSentRevision` 并丢弃更旧的待发事件，所以慢 Bridge 的旧一轮不会在新订阅之后倒序到达；同 revision 的不同事件照发。
- `task-state` 与它的 `detail.sync` 带 `{ instanceId, revision, hostTime }`，快照也带 `hostTime`。`GET` 单个会话的 detail 不带 `hostTime`，所以两台设备同时读到的 detail 完全相同。
- `host-state`、`app.data`、`app.updated` 不参与 revision 顺序，不带 SSE `id`。

**`host-state`。** 形状为 `{ type, instanceId, state: 'stopping' | 'sleeping' | 'awake', reason?: 'restart' | 'update' | 'sleep' | 'shutdown', retryAfter?: 秒, at }`；`stopping` 与 `sleeping` 必带 `reason` 与 `retryAfter`。Host 关闭时先向每条仍被接受的流写出 `stopping` 再结束它们，最多等 0.5 秒让最后一帧发出；`awake` 之后另发一次 `refresh`。谁报告、各原因的默认 `retryAfter` 见 [ARCHITECTURE.md](./ARCHITECTURE.md#host-的生命周期)。

**连接的保护。**

- Host 每 15 秒发注释心跳。每次推送与心跳前检查打开这条流的凭据是否仍被接受，不被接受就结束这条流。
- 某个会话的 detail 读取失败时，本轮只向各连接发一次 `refresh`。
- 连接积压超过 256 KiB 时断开它，让客户端重新同步。这是积压保护，不是单帧或总内存的上限：每个 `task-state` 仍含该会话的完整 `messages` 与累计 `liveText`，随历史增长。

### 协商后的正文追加

源码：[task-delta.ts](../packages/protocol/src/task-delta.ts)、[task-delta.ts](../apps/host/src/task-delta.ts)、[taskStream.ts](../apps/web/src/core/taskStream.ts)。

**协商。** 选中会话的请求带固定头 `x-latch-state: delta-v1`；Host 只在有 `sessionId` 且头精确匹配时接受。浏览器、本机 Electron 与 Swift App 的选中会话发它；列表流、Node 原生客户端与其他电脑的 Electron 页面不发，只收完整帧。

**基线。** 新连接的第一个正文帧是完整 `task-state`，带 `stream: { protocol: 'delta-v1', subscriptionId, stateSeq }`。`subscriptionId` 每个网络连接随机生成；`stateSeq` 从 1 开始，只数这条连接实际发出的正文帧，与 revision、cursor、原生重放序号互相独立。不带这个回执的完整帧按原协议显示，客户端不能用 HTTP 响应当追加基线。

**何时追加。** 只在 `running`、`runId` 与 `liveMessageId` 不变、正文与思考都只是前缀变长时。历史、工具、审批、队列、问题、计划、配置、权限、用量、活动阶段、终态或任何未知字段变化，都发完整状态。

**帧。** `task-delta` 只含实例、会话、`runId`、`liveMessageId`、revision、`hostTime`、`stream`、`baseSeq`，以及：

- 正文 `text` 与思考 `reasoning` 各为 `{ offset, append }`，`offset` 是上一份原文的 UTF-8 字节数。`reasoning` 为 null 表示前后都没有该字段，空字符串表示字段存在。
- 片段必须是 Unicode 标量串，未配对的 surrogate 不替换成别的字符后继续追加。
- 每帧正文与思考片段合计至多 64 KiB，每个累计串至多 16 MiB；越界或无法验证时发完整状态。
- 可带的元数据只有 `cursor`、`summary.updatedAt`、`detail.lastOutputAt`，以及已存在的 `summary.live` 的 `lastEventAt`、`lastOutputAt`；可选时间用 null 表示缺省。
- 客户端拒绝追加帧里的未知字段。

**Host 的基线缓存。**

- 每个订阅至多一份，Host 合计至多 128 份、32 MiB，单份至多 4 MiB（按 UTF-16 字符串占用估算并计固定开销）；超过预算只发完整帧。
- 基线保存不可变的签名与字符串，不保留可能被 Bridge 改写的对象引用。
- 每次编码前先按当前设备、凭据与数据范围过滤。scopes 或数据范围改变、失去授权、私有事件被省略或连接关闭时立即清掉基线；被省略的事件不推进序号也不发提示，恢复可见后先发完整基线。
- 未协商的完整帧共用一份序列化；带订阅回执的完整帧与追加帧按连接编码，不改共享事件与原生重放。

**客户端的流影子。**

- 每条连接一份，HTTP 不写它。每次追加校验实例、会话、订阅、精确的 `baseSeq`、run 与消息身份和 UTF-8 偏移，再重建 detail。
- 重建出的 detail 仍由 `ProjectionGuard` 决定能否发布；HTTP 已发布更高 revision 时，较旧的流只推进影子。
- 重复帧忽略；其他实例或会话的帧忽略；缺帧、身份或偏移不符、无法识别的操作触发修复。
- 一个逻辑订阅只修复一次：abort 请求并取消 reader，丢弃旧连接的缓冲，立即以完整帧协议重连，之后的重连都不再协商追加。换会话是新的逻辑订阅。
- 换设备或权限代次时清掉影子、关闭旧流并使旧的投影票据失效。阅读位置、草稿与写请求的 `requestId` 不参与这项传输优化。

### 文件差异的设备投影

Host 按发送时设备的数据范围生成详情与审批的展示投影：`all` 保留原内容，`files` 只保留路径都在会话文件夹内的文件正文，`work` 收不到文件正文。总规则见 [ARCHITECTURE.md](./ARCHITECTURE.md)；这里是协议与旧历史的规则。

- **`work` 省略什么。** `ToolDetail.diffs` 的正文省略，路径并入 `locations`；文件编辑的参数只留路径与有限的控制元数据，其他字符串与不明结构省略。`Message.text` 里的工具载荷副本同样投影，子 Agent 的步骤递归应用。
- **保留什么。** 消息、工具、审批与运行的身份，`requestId`、时间、`decision`、`judged`、`blocked`，以及失败、取消、结果未知的事实。
- **不膨胀、不改值。** 不为省略的字段插入占位文案；JSON 数字词元不重编码（大整数与 `-0` 不变）；生产者摘要的 JSON 编码字节数不得大于原输出，受限投影不会把合法的原生帧推过既有上限。
- **安全摘要。** 可信生产者可给 `ToolDetail.outputWithoutFiles`（原结果中不含文件正文的说明，空字符串表示原输出全是文件内容）。Standard 的 `ToolResult.textWithoutFiles` 进入它；Codex fileChange 与 pi 明确的 `details.diff` 标为文件输出，不拿未分类的另一段文字当摘要。ACP 每次替换 rawOutput 或 content 而没有新标记时清掉旧摘要。执行端追加的结果未知、未开始说明同时进入摘要。
- **来源字段不下发。** 两套会话 schema 都保存 `outputWithoutFiles`，但任何设备的响应都剥离它，`all` 也不收到。
- **没有摘要时保守。** 旧历史与没有摘要的编辑结果，省略分不清的内容段，保留路径、已知结果码与状态，不猜工具是否执行成功；普通命令、MCP 与聊天正文不按关键词改写。
- **不影响执行。** Host 仍用原参数分级、计算预览哈希并处理原审批 ID 与原 `requestId`；发给模型的完整结果不变。Markdown 导出消费同一份已授权的详情，没有另一个未过滤的出口。
- **编码顺序。** SSE 逐读者先投影再做追加编码，原事件与 Driver 对象不被修改，两种数据范围的帧缓存不共用。原生重放保存 canonical 事件，`work` 投影按该事件的身份另留内存、沿用原游标，重放时按当前范围重新选择。范围变化清掉追加基线，下一帧完整发送。

### 流量计数

Host 从启动起在内存里计数自己发出的字节（[traffic.ts](../apps/host/src/traffic.ts)），重启清零。

- **计什么。** 事件流每一帧写出的文本（含心跳），以及快照（`GET /snapshot`）与会话详情（`GET /tasks/:id`）的响应体。HTTP 头、分块编码与 TLS 记录不计入。
- **怎么分。** 每一类有次数、字节数与 9 档大小分布（≤256 B、1、4、16、64、256 KiB、1、4 MiB 与更大）；每个会话有点名它的帧与它的详情响应；每条事件流有入口类别、开关时间、帧数、字节数与心跳数。会话至多保留 1000 个，已关闭的事件流保留最近 100 条。
- **只有数字。** 只含次数、字节、时间、入口类别、Host 内的连接序号与会话 ID，不含正文、标题、设备 ID 或设备名。
- **谁能看。** `GET /link/api/traffic` 需要 `admin`，或 `host.sock` 上的匿名命令行；`pnpm latch traffic` 打印摘要，`--json` 打印原样。

## 客户端：事件流、凭据与版本门禁

源码：[useHarness.ts](../apps/web/src/core/useHarness.ts)、[eventStream.ts](../apps/web/src/core/eventStream.ts)、[credentials.ts](../apps/web/src/core/credentials.ts)、[api.ts](../apps/web/src/core/api.ts)、[projection.ts](../apps/web/src/core/projection.ts)。

### 基于 fetch 的事件流

客户端不用 `EventSource`：`eventStream.ts` 用 `fetch` 读同一个 `text/event-stream` 响应并自己解析，所以能看到 HTTP 状态，`401` 交给认证处理而不是无限重试。

| 情况 | 行为 |
| --- | --- |
| 响应 2xx | 触发 open，之后逐帧派发事件 |
| 连接失败、非 2xx、流结束，或 45 秒没有收到任何字节（含等响应头的时间） | 视为断线，按 1、2、4、8 秒退避，之后每 15 秒重连；浏览器重新联网，或页面重新可见且在线时，立即重连 |
| 浏览器 offline | 断开事件流、取消在途 HTTP 并停止重连，直到重新联网或页面重新可见且在线 |
| `401 renewal-required` | 先续期凭据，成功后立即重连一次。续期失败、正在等下一次续期（桌面端页面从不自己续期），或续期后 Host 仍要求续期，都按退避重连 |
| 其他 `401` | 按退避重试；每次断线后的快照同步决定进入连接页还是只是暂时失败 |
| `deferReconnect(ms)` | 放下当前连接，此后每次重连前至少等 `ms`（与退避取较大者），直到下一条流打开 |

**open 不等于已连接。** 流打开后先完成 snapshot 与 detail 的 HTTP 同步，确认选择仍有效、流仍打开且浏览器在线，`.app-shell` 的 `data-connection` 才变为 `connected`；其他取值是 `connecting`、`reconnecting`、`offline`。离线时保留已读内容。

**`refresh` 与 `tasks-invalidated`** 只在 `instanceId` 与当前 Host 相同且 revision 新于当前 snapshot 时触发同步；`instanceId` 不同则立即重新同步并重新绑定。

**重新建立与跟随。** `useHarness` 的 `resyncs` 只在重新建立状态的同步发布快照时加一：首次加载与连接页的重试、事件流每次打开、重新联网或页面重新可见、续期之后、任一请求发现凭据失效之后、断线时的同步，以及人按下的同步或重试。跟随变化的同步（`refresh`、`tasks-invalidated`、`task-state`、用户操作之后的刷新、选择会话）不加；排在一起的请求有一个是重新建立就算重新建立。界面用它作一次性过渡的纪元，见 [DESIGN.md](./DESIGN.md)「界面原语」。

### Host 宣布的停止与睡眠

[hostState.ts](../apps/web/src/core/hostState.ts) 只接受实例与当前 Host 相同、形状正确的通告。

- 收到 `stopping` 或 `sleeping`：记下通告，连接状态变为 `reconnecting`，以 `retryAfter` 调用 `deferReconnect`。Host 已说明暂时不应答，所以页面不按 1 秒起的退避猜测，也不在断线时立即请求快照；重新联网或页面重新可见时仍立即重连一次。
- 横幅按通告写原因与开始时间。没有通告时只说页面知道的：没有网络、Host 的 5xx、Host 自己给的拒绝原因，或请求没有得到应答；不猜原因。
- 清除通告：重连后的快照同步成功并标为 `connected`，或收到 `awake`（并立即同步）。
- 只有连接失败才按通告等待。重连得到 `401` 说明 Host 已在应答：续期解决不了时清除通告并照常请求快照，由快照决定进入连接页还是显示暂时故障。
- 桌面端页面另外显示主进程对 Host 的判断（正在重启、反复崩溃后停止自动重启、已停止、没有响应）。

### 失败的说法与旧 Host

页面上的失败只按页面知道的说（`errorMessage`，[api.ts](../apps/web/src/core/api.ts)），不把页面的错误说成网络问题：

- Host 的错误与页面写给人的文字（`ClientError`、`MessageError`）照原文。`pnpm lint` 让 `apps/web/src` 里的 `new Error` 只带 ASCII 字面量的内部代码。
- fetch 本身失败（请求或答复没有到达）在 `api()` 里变成 `NoAnswerError`。页面自己在发出前抛出的错误不算。
- 其余是页面自己的错误：写出错误名，并把错误与调用栈打印到控制台一次，不上报。

**构建号。** 每次构建页面生成构建号，`dist/web/build.json` 记下它；Host 启动时读一次，在快照的 `build` 里报告。页面的构建号比 Host 报告的新，或 Host 没有报告时，页面提示重启 Latch；只有桌面端那台 Mac 的窗口给出重启（主进程的 `restartHost`）。比 Host 旧的页面不弹提示，只由「检查更新」（[DESIGN.md](./DESIGN.md#布局)「侧栏底部」）点开时再读 `/link/build.json`，比本页新就带点并给「重新载入」；开发服务器与测试里的页面没有构建号。页面不为旧 Host 写降级。iOS 尚未比较构建号。`pnpm desktop` 在打开窗口前比较另一个构建号（`host-info` 的 `build`，见 [ARCHITECTURE.md](./ARCHITECTURE.md#host-的生命周期)「重建后启动」），空闲的旧 Host 先被重启，这条提示就不出现。

### 桌面端的转发与流

桌面端页面加载自 `latch://app/link/`。`latch` 协议注册为支持 fetch 与流式响应，主进程（[proxy.cjs](../apps/desktop/src/proxy.cjs)）经 `host.sock` 转发请求并附加设备凭据，响应体以流回传；页面关闭或取消读取时主进程断开上游。所以桌面端与浏览器用同一份事件流代码。

### 版本门禁

`ProjectionGuard` 检查三件事：

1. **选择代次。** 切换会话、绑定新的 Host 实例或使旧请求失效时更新 generation；旧的 HTTP 请求与旧事件流不能覆盖新选择。
2. **实例。** SSE 与 detail 的 `sync.instanceId` 必须等于当前 HTTP 确认的 Host；重启后的状态不与旧实例混合。
3. **版本与来源。** 同一选择中，低于已接受 revision 的 detail 丢弃。相同 revision 时 stream 优先于 HTTP：流可以更新此前的 HTTP 正文，迟到的 HTTP 与重复的 stream 都不能覆盖已接受的流正文。接受过带版本的状态后，不再接受无版本的 detail。

其他规则：

- 切换会话会取消待处理的 HTTP，并重建带新 `sessionId` 的事件流。最近八个已读详情按访问顺序保留在本页内存。列表仍可见的旧会话立即画上次已接收的正文，以该详情的 revision 和来源为起点，只接受通过版本门禁的新详情。重读前的摘要与审批从最新快照取。
- Host 实例、设备或权限投影改变及退出时清空全部缓存。确认删除时丢弃该会话。当前设备收到完整列表，且列表版本不低于已读详情时，即清除其中已缺失的会话。当前会话也缺失时，立即撤下正文与审批并关闭它的流，旧流和在途详情随选择代次失效。部分列表或版本较旧时保留已读正文，等待 Host 的进一步证据。缓存不进浏览器存储。
- snapshot 与 `task-state` 可能交错：选中 detail 只在它的 revision 不低于 snapshot 的 revision 时覆盖列表里的摘要与审批。这条列表合并规则与正文的来源优先级分开，也不会把一个会话的 detail 写到另一个会话上。
- 事件 JSON 至少校验事件类型、版本、会话 ID 与正文的基本形状；它不是通用的不可信 JSON 导入器。消息内容按不可信文本显示。
- 设备被撤销、登记满 30 天或凭据属于别的访问地址时，页面清除会话内容并进入连接页。

### 未发送的草稿

未发送的文字按设备与会话（新会话也算一份）存在浏览器存储 `latch.drafts.<origin>.<deviceId>`，桌面端用同一页面。

- **只存文字。** 附件与文件引用只在内存。存储不可用时草稿也只在内存。
- **不落盘的草稿。** 含 Host 日志会遮去的内容（`@latch/protocol` 的 `looksSecret`，与 `redactSecrets` 同一组规则）的草稿只在内存，不提示。私有会话的草稿与含项目文件摘录的草稿带私有标记：设备不再能读私有内容时移除，数据范围不是 `all` 时每次写入都不存。
- **写入时机。** 打开中的输入框稍后写入，离开页面时立即写入；同一设备的多个窗口只写自己改过的草稿。14 天没有改动的草稿在下次加载时丢弃。
- **删除会话时清除。** 在这里删除；打开中的会话被 Host 报告已删除；或一次完整的列表（快照的 `tasksComplete`）在能看见全部会话的设备上不再有它。打开中的会话答 404 `task-not-found` 时，也只在同一次快照完整时才算删除。列出失败、只列出一部分、已归档、因范围或私有被隐藏，都不算删除；Harness 停用或重新挂载期间保持选中。
- **撤权与退出时立即清除。** 页面一收到不再被接受的回答，就删掉这个来源下所有设备的草稿并写下共享的退出标记，所有窗口之后都不再写入；页面加载时只留当前设备的。
- **归属。** 草稿、创建 Agent 的请求与 Slash 最近项共用当前设备的归属，换设备后旧句柄不能再落盘。提交捕获当时的会话（或新会话）选择代次；同一页面里的重试按原 `requestId` 保留首次来源，卸载后失效。
- **提交与草稿。** 普通发送消费原会话的草稿，不来自输入框的消息（`resent`：重新发送旧消息，或团队面板交给 Codex 子 Agent 的那一条，运行中时排队）不动输入框里的文字、附件与文件引用。回执到达前切换过会话时只结算原请求，不自动选回原会话，不清空当前输入。
- **刷新后的未知结果。** 只有原目标匹配当前输入才恢复文字，其余只恢复原请求卡片与 `requestId`。

创建 Agent 的未知请求独立于消息草稿，沿用原 `requestId`，跨窗口先取得 Web Lock 再核对同一记录。

### 再次旁支提问

浏览器在当前窗口为每个会话保留一张 `/btw` 旁支卡。卡还在时再次发送，先询问是否替换。选择「保留第一问」或退出确认，原卡、原请求和第二问草稿都保留。切换会话取消这次确认，草稿跟随原会话。手机从旁支卡返回对话只收起卡，仍可重开或用「关闭并归档」结束。

「替换并发送」只对确认时那张卡的请求 ID 生效。若首问仍在启动，收到迟到的回执后只清理首问的分叉。首问结果未知时，可保留它并用原请求重试。确认替换时不会重发首问，若它已开始但回执丢失，其分叉仍可在会话列表里找到。第二问按自身的回执或失败状态更新旁支卡。

## 原生客户端的流

源码：[native-replay.ts](../apps/host/src/native-replay.ts)、`native/ios/Sources/LatchNativeCore/` 的 `Workspace.swift`、`BodyReading.swift`、`BodyPublication.swift`、`TaskStreamProjection.swift`、`Events.swift`。

原生 HTTP/2 客户端（Swift 核心与 Node `NativeWorkspace`）用同一组 Host API 与 SSE 内容格式。网络连接不决定执行结果；后台重连在连接关闭或网络变化时重新取候选路径，从不自动重发写入。

### 手机重连

源码：`Paths.swift`、`Reconnect.swift`、`Discovery.swift`，App 侧 `PhoneModel.swift`。

刚连上、重连或回到前台时，Host 可能还没列齐会话。App 先显示 Host 已给出的行，再限次补读列表。Host 给出 `tasksComplete: true` 后即停止补读，已确认的空列表也一样。同一实例、同一修订的快照按发起读取的先后取舍，离线缓存保留较新的结果。App 用同一份发布顺序处理列表刷新、事件恢复和聊天正文附带的快照。旧正文通知晚到时，已显示的列表得以保留，通知仍按实际应用回执确认。短暂切后台回来后先更新列表。原会话暂未列出时等待补齐，列出后用仍有效的窗口读一次正文；完整列表确认它已不可见时退回列表。用户已切页、换电脑或窗口失效时取消这次恢复。后续由事件流或轮询更新，离线时可在列表里立即重试连接。

- **先浏览再拨。** 存储打开时就开始 Bonjour 浏览；发现密钥与网络不变时不重建。还没有浏览结果时，直连候选最多等 500 ms，同时中继照常竞速；到时没有结果不记失败。
- **中继何时等。** 首次拨号有已知直连候选时中继等 250 ms，当前网关上次赢的是直连时等 600 ms；否则立即拨。用户主动选了连接簿中的局域网地址或扫描该 Mac 的新二维码时，已配对手机也尝试这些地址。通过身份和权限核验后，可在当前网络内复用已连通的地址；换网时清除。正在使用的连接失效后，直连与签名连接簿里可用的中继同时尝试。若所有可用中继都在冷却，按 App 退避重拨最早结束冷却的一条。只有通过 Host 身份和设备核验的连接可以接手。
- **网络变化。** 首个路径回调作为基准。网络变化时刷新发现结果，保留仍然健康的连接；正在恢复的工作台可以提前结束退避。前台只响应当前连接的关闭，旧连接晚到的关闭通知不影响已经接手的连接。
- **中继升级到直连。** 已装中继时浏览出现当前电脑，就在后台跑一轮只含直连的迁移：新连接照常核验撤销与窗口（`verification/resume`），装上后才关旧连接；有写入、上传或传输在途时不迁移，失败时中继留着。未知写入保留原 `requestId`，不重发。
- **核验并发。** 新连接上撤销与快照同时发出，先判撤销，被撤销时不解析快照；持有窗口或恢复证明时，先复核窗口再读快照。Face ID 关闭且没有窗口时，路径装上后就取验证质询，验证用掉它；质询会让本设备旧窗口失效，所以有窗口、恢复证明或验证在途时不取。
- **判活。** 已配对工作台的直连每 2 秒发 HTTP/2 PING，连续两次未收到应答后关闭。该连接收到系统路径变化或不可用的通知时，立即发 PING 核实。中继保持 10 秒间隔。
- **计时。** 每轮的阶段（回前台、存储、首个浏览结果、候选、各候选连接与核验、安装、验证、首个事件）只记阶段、路径种类与毫秒，存在内存环形缓冲里，不记地址、ID 或秘密。

### 重放与游标

- **独立序号。** 原生业务 SSE 在 Host 运行代次内有自己的连续序号与有界的重放日志（数量与字节分别封顶），保存不可变的 canonical 完整事件。它与 revision 分开：一个批次可以有多个事件。
- **SSE `id`。** 完整帧与追加帧的 `id` 都是该事件的 canonical 游标，不用 revision 或订阅序号代替；心跳与 `resumed` 注释帧也带游标。
- **续接。** 请求带 `resumeEpoch` 与 `resumeAfter`（不合法时 400 `invalid-resume`），在同样的设备与正文窗口校验下接续；回放的第一份正文是完整帧。日志已淘汰或 Host 重启时要求重新同步快照与详情。
- **未入日志的事件。** 即时 checkpoint 带 `resumeRequired`，并清掉追加基线。完整帧超过原上限时仍先记录 `refresh`，追加协议不放宽帧或缓存的上限。
- **先应用再确认。** 客户端只在应用事件之后推进游标；列表快照的更新不能确认尚未应用的会话正文。
- **Swift 的游标。** `NativeWorkspace` 加密保存至多 16 个流的已应用 epoch、sequence 与 revision，列表与各会话分别确认。`accepts` 不推进进度，应用后才 `acknowledge`，确认前复核流的连接代次与正文 lease。窗口过期、旧连接迟到或其他选中会话的事件不确认。缓冲溢出只清除该流的恢复游标并要求 checkpoint，不撤销登记身份。
- **Node 的路径切换。** `NativeWorkspace` 在安装新路径前恢复正文回执并读取 checkpoint；同一 Host 实例的 revision 只能前进，新路径失败时保留旧连接，迟到的快照不覆盖当前路径。
- **检查先于编码。** 正文窗口、scope、积压与原生 padding 的活跃状态先于追加编码检查；连接关闭时清掉活跃标记。活跃状态只决定控制连接的网格；显式传输的大块连接开连接 3.5 s 后不按时钟发，传输中不发哑单元，静默一秒后把总量补到大小档。
- **手机的节拍。** 手机按 Host 的同一规则（`PaddingClock`，Swift `NativePaddingPacer`）：有待发数据、2 s 内有过，或在 approve、deny、cancel 后的 15 s 保护期内，走 40 ms 网格，否则 250 ms；写入或保护把定时器提前到下一个 40 ms 格。单元平时是小档，大档仍只在 5 s 边界、待发超过 4 KiB 且不在保护期时开启；开连接 3.5 s 内大档仍走 250 ms 格，因为手机的外层 cover 没有写出回执，每 40 ms 只排得出一个大单元。漏过的格子跳过，不补发。旁观者因此看得出手机何时在用（Mac 一侧本来就看得出），看不出格子里单个请求的大小与时刻。Node 的 `client` 角色（link-client 的 `NativeWorkspace`、传输插件与测试里代表手机的客户端）仍按 250 ms。
- **连接设置。** 原生连接设置的写入用持久的请求编号与配置哈希确认结果，重试发原始内容，超时不生成新编号。设备的原生访问状态由 Host 判定；手机当前快照的正文期限只属于当前连接。

### 正文阅读与发布

Swift 的选中会话经独立的正文阅读接口接收追加帧；列表流保持完整模式，`events(for:incremental:)` 只在显式传 `true` 时协商。

**投影与发布门。**

- `NativeTaskStreamProjection` 是与网页流影子同一契约的纯值投影，不接受 HTTP 更新。
- `NativeTaskPublicationGate` 按实例、会话、选择与连接票据、revision 与来源优先级筛选 HTTP 与流的候选。替换连接使旧票据失效，但不降低版本地板。
- 候选与票据都不是正文 lease，不能用来确认原生游标。

**阅读对象。**

- `beginBody` 绑定当前实例、会话、Workspace 与已有的正文窗口，不签名也不开新窗口。
- 网络 collector 给每帧附上公开解析器构造不出的 reader 身份与连续序号；跨 reader、旧连接或旧选择的事件进不了影子。
- 新的打开意图先取消并等旧的打开过程关闭。收到响应头之前的取消也关闭实际的 HTTP/2 子流。Swift 客户端创建子流失败时，同时结束等待该子流响应的请求。响应处理器提前移除时也结束等待，发出的写入仍按原请求核对结果。

**发布回执。**

- `readBody` 与 `receive` 只给出外部构造不了的 `NativeBodyUpdate`。消费者在 `@MainActor NativeBodyPublication.apply` 的同步回调里核对自己的活动选择并赋值，返回 `true` 才得到 `NativeBodyApplied`；返回 `false`、重入、失去窗口或旧选择都不推进发布门。
- 回执只证明回调接受了值，不证明屏幕已绘制；App 仍负责关闭窗口、退到后台与切换页面后的撤下。
- 只有 `Workspace.applied` 接受发布回执后，才推进 `detailRevisions`、已应用来源与原生游标。新的正文 reader 拒绝旧的数字版 `acknowledge`。
- 正文与列表快照分别确认：较旧的 HTTP 正文可以被拒绝，同时应用更新的快照。`refresh` 与 `tasks-invalidated` 是元数据屏障，之后的正文或心跳不能越过尚未应用的屏障。
- 待处理记录与待确认候选各至多 8 条，只存证明元数据。槽位满时，已被应用回执覆盖的相邻正文与心跳证明可以合成一条；尚未应用的正文与所有快照屏障不合并，不跳过网络帧。
- 持久化在写盘与身份复核完成后，只清除本次写入捕获的序号前缀，不清等待期间形成的新证明。尚未应用的新候选不当成旧回执的缓存。

**修复。**

- 解析失败、缺帧或待应用记录耗尽时关闭旧流，至多做一次完整帧修复，此后这个阅读对象不再协商追加；第二次失败交还调用方。
- 同一阅读代次重开网络流时保留修复次数与发布地板，新建阅读对象绕不过限额。App 也记下 collector 在 `receive` 之前报告的坏帧与队列溢出。
- 元数据 notice 与恢复用的 HTTP 读取遇到网络不可用或明确的 408、5xx 时，在同一阅读内只重试一次；仍失败就关闭它所属的那条流，把错误交给 SSE 恢复，不能丢下元数据屏障等下一帧。过期不重试；旧读取的失败不关闭新 reader。
- 修复结果带固定的来源类别与有界计数，只供 `LatchScreens` 诊断；正常 App 不输出正文或修复日志。

**App 的使用。**

- `openSession` 与 `refresh` 走同一条 `readBody` 与发布路径，HTTP 详情不直接覆盖已发布的较新的流。
- 每帧先 `receive`，100ms 内只合并已校验的候选；元数据 notice 独立读取与发布。真正赋值后才提交 `applied` 回执；范围变化使 `adoptSnapshot` 撤下内容时，本次赋值停止且不出回执。
- 摘要取哪一份：同实例、同会话、非缓存且正文的 `sync.revision` 不低于快照的 `revision` 时用正文，否则用列表。两个版本都来自 Host 的全局计数，不用 Driver 的 `cursor`。已接受的正文摘要只替换快照里已有的同 ID 行。
- 切会话、换 Host、窗口与权限撤下时同步清掉待发布状态；替换连接保留发布地板，旧的网络证据失效。离线缓存的展示没有应用回执。

**编码边界。**

- 身份按 UTF-8 字节精确比较，长度按 UTF-16 单元与网页对齐。`JSONDecoder` 拒绝非法 UTF-8 与未配对的 surrogate。
- 原生输入与重建出的候选都受 `NativeJSON` 的 1 MiB、深度、数组与对象宽度限制；候选编码后再读回以确认，成本随历史增长。
- 原生时钟只接受完整的 ISO 时间，网页的 `Date.parse` 还接受只有日期的写法；共享向量 `packages/testkit/vectors/task-delta-v1.json` 写明这一区别，以及原生表示不了含非法 surrogate 的完整正文。
- 完整帧里的未知事实保留，追加帧里的未知字段拒绝。

SDK 编译与互操作用例不证明真机上的收益、键盘交互与 CPU 预算。

### 正文窗口

原生正文窗口绑定已认证的连接与 App 的打开回执，到期后正文流停止，列表仍可读。

- **到期只撤正文。** 到期撤下该窗口的正文与预览，不把仍有效的 HTTP/2 连接标为离线。事件流在响应头之前或之后遇到同一租约到期都报 `expired`；断流、超时或普通 5xx 不冒充到期。
- **按租约失效。** 事件打开与失效绑定同一个不透明租约，按租约身份原子失效；旧窗口与没有窗口的迟到应答关不掉新窗口。
- **新窗口。** 绑定新窗口不改会话选择、草稿或附件，但先撤旧正文、预览与本地文件编辑的显示；晚回的缓存仍核对原租约。文件编辑的未知请求留在待确认存储里，撤下编辑页不等于放弃写入。
- **范围变化不是到期。** 已验证的同实例 checkpoint 的权限范围变化只使阅读对象失效（`bodyAccessChanged`），真正过期的 lease 优先。App 先撤下内容再读一次元数据；只有窗口仍有效、设备仍有 `view` 且会话仍在可见列表时才重建阅读，沿用已用掉的修复次数，不签新窗口。
- **窗口外仍可用。** 取消与不带附言的拒绝只返回回执，写入结果未知时保留原 `requestId`。
- **待办正文。** 要求、发言、回复、PR 评论与检查日志走各自的正文路由，继续验证原生窗口。无窗口时快照不给私有待办或其成员关系，只列非私有待办的摘要，省去备注与提议。客户端切换窗口、进后台、锁屏或失去访问时撤下已读内容。

### 原生私有页面的到期恢复

Face ID 关闭时，前台原阅读意图的正文窗口到期后沿原验证入口自动恢复；开启时保留明确的「查看」入口，由人打开。关闭 Face ID 不绕过 Host 的正文验证。

- 我的 Agent 列表与人物话题都先验证并刷新私有快照，再沿 `refresh` 读仍选中的话题。单个话题的 detail 不能把 `PhonePrivateSnapshot.confirmed` 置为真，也不靠恢复流下一次碰巧的通知补齐快照。
- 恢复开始时固定 Host 代次、页面、Agent 路径、会话与阅读代次；验证晚回后不为已切换的意图读私有内容。
- 恢复频率限制、后台撤下与未知写入的回执不变。
- **短暂后台。** 进后台立即撤下正文与预览，但连接、工作区与内存里的窗口令牌最多留 30 s（`beginBackgroundTask`），期间不拨号、不开流、不轮询。回到前台时由 Host 经 `verification/resume` 在原连接上复核窗口，不延长到期时间；复核不过则只剩列表。锁屏、保护数据不可用、撤销、连接断开、网络变化、切换电脑或到时立即全部拆除。

### 原生待办

「会话 | 待办」切换要求 Host 同时声明 `workItems` 与 `workItemTurns`。任务状态读快照的 `items[].board`，发言和回复走同一条待办的详情接口。逐页读取讨论，较早的待处理发言按 `board.postId` 单取。完整回复始终沿同一个消息 ID 与 Unicode 码点偏移读，逐页核对会话和输入消息的来源。

待办正文、发言、回复、证据与日志使用已有的原生正文窗口。读取按 Host 实例、连接、选择与正文租约复核。断线、切换或到期时撤下正文与证据。断线后保留选中的待办 ID，重连按新连接读回。正文租约有效与网络接口未变都不能恢复上一条连接的待办内容。安装新传输时，Workspace 同时交付新连接代次、通过验证的快照和正文租约。即使在线换路恢复同一租约，旧连接读取的待办内容也会撤下。一次由多个 HTTP 请求组成的读取与最后一次发布都核对这个代次。

iOS 在团队关系到达前展示可读的会话摘要。点选缓存行时，手机只记录本次选择。当前连接的列表确认会话可读后，才走原有正文验证与读取流程。部分列表缺少该会话时继续等待；完整列表确认它已不可见时返回列表。

离线缓存只写已采纳的列表快照。并发写入按采纳顺序比较，同实例的磁盘修订不回退。新实例须随实际连接安装。离线快照仅保留非私有待办的列表信息，移除私有待办、提议、正文、归属引用和从发言得到的待处理状态。App 锁定时立刻撤下界面，并排队收尾最后一份投影、锁定旧资料库。前台重开等收尾后再复核打开代次和系统保护数据。若收尾既不能写入也不能清除旧快照，本进程要等该电脑的新连接保存已验证快照后才允许使用其离线缓存。设备撤销时撤下页面内容。Face ID 关闭时，前台的待办读取意图沿既有入口恢复。

从投递打开的原回合以会话与用户消息定位。来源离开可读会话列表后撤下原回复、行级证据和来源页面。列表不完整时只说明来源暂未确认。人的讨论发言仍按待办的权限显示，来源恢复后要重读回复。 如果已读过的早期分页含被撤下的回复，来源恢复时从最新页的游标重新开放读取。要处理待回答或审批的请求，还须匹配当前运行 ID 与 Host 指定的决定 ID。历史消息可读，决定结算后原回合仍可打开。问答、审批与停止沿用原生会话提交与回执，未知时复用原请求。打开普通会话仍可按现有会话流程继续。回退在同一个待办的详情栈内保留位置。

### iPhone 与 iPad 的连接和写入

- **SSE 失败只说明这条流失败。** App 在原连接上读一次经过校验的快照：成功才保持在线并退避重开事件流，失败才进入连接恢复。重试间隔从 0.5 秒增到 30 秒，收到心跳或持续有效的事件后复位。重开用真实的正文租约，不续期、不重放写入；迟到的成功不能覆盖新选择或新窗口。
- **短暂断链。** 工作台保留当前会话和未发送的草稿，后台尝试恢复，发送键在连接可用后恢复。只有当前连接的关闭或列表、事件流探测失败才启动恢复。没有可拨中继时，首轮失败或断链达到 6 秒即显示离线。有可拨中继时给握手留出时间，首轮失败可自动再试一次。两轮均失败或从确认断链起达到 24 秒，页面显示离线并继续重试。正文只在有效授权窗口内可读。
- **已打开会话的草稿。** 输入时按会话保存在本机内存。普通 Code 会话已打开正文且窗口仍有效时，断链期间可继续输入，恢复连接后可发送。正文窗口关闭时隐藏文字，重新核验后回到同一会话可继续编辑。输入框离开页面时不回写。App 锁定、换电脑、设备撤销或 Host 实例及权限范围变化时清空。
- **写入一次一个。** 发送、追加（`steer: true`）、排队、改权限、模型或思考、分叉、重试与审批选项都带持久的 `requestId`，结果未知时原样重试，一次只有一个待确认。结果未知的写入在会话列表与会话里都能重试，否则看不见的那一个会挡住之后的所有写入。
- **停止**等到 Host 结算（至多 45 秒），上一个未确认前不发下一个。
- **放弃这次提交**（新会话的第一条与会话的下一条）：先重新读该会话，已列出带这个 `requestId` 的用户消息就按已送达结算并撤掉这个会话的清空上下文选择；否则在本设备放下它，文字接回输入框（`PhonePending`）。
- **普通请求。** 重命名、置顶、归档与删除不带 `requestId`、不留待确认；失败或没有答复时说明一次并重读列表，以 Host 列出的为准。
- **搜索。** 正文搜索（`POST /search`）只在有效窗口内发，结果只在内存、不进离线缓存；Host 一次只做一个搜索，429 时保留上次的结果。
- **文件汇总。** 回合的文件汇总按 Host 固定的 `folders` 与 `cwd` 区分完整的文件身份，合并同一文件的绝对与相对引用，不合并不同目录的同名文件；路径按 UTF-8 字节比较，不把 Unicode 规范等价的字符串当作同一文件。这只影响显示与计数，打开文件仍由 Host 按根权限核对。

## 消息、审批与取消

自建助手改绑工作电脑后，原 Host 仍能核对已经接收的发送和追加。Host 在 `sessions-meta.json` 保存原会话、设备、请求 ID、请求体的 SHA-256 和接收方式，保留最近 4096 条，删除会话时一并清除。重试需来自原设备且请求内容一致。仅有旧消息或尚未结算的请求时，Host 保留「发送结果尚未确认」。排队请求继续沿用原有的队列回执。

源码：[runtime.ts](../packages/core/src/runtime.ts)、[Transcript.tsx](../apps/web/src/components/Transcript.tsx)、[ToolCard.tsx](../apps/web/src/components/ToolCard.tsx)、[conversation.ts](../apps/web/src/conversation.ts)、[approvalDecision.ts](../apps/web/src/core/approvalDecision.ts)、[cancelRequest.ts](../apps/web/src/core/cancelRequest.ts)。

**消息身份。**

- 每次模型调用在收到文字前创建 `liveMessageId`。文字只更新内存里的累计 `liveText`，思考更新 `liveReasoning`。正常完成或异常保留部分内容时，最终的 assistant 消息沿用这个 ID，思考存在它的 `reasoning` 里。
- detail 不同时给出同 ID 的 live 消息与已提交消息。
- Harness 说这条回复中途断开、从头重新生成时（profile 的 `readRetry`，见 [HARNESSES.md](HARNESSES.md#通知与压缩)），`liveText` 清空后重新累计，ID 不变。
- 页面按 `message.id` 渲染并给每行 `data-message-id`。按回合分组、把过程折叠成一行都只是排列方式：被折叠的行仍挂在 `hidden="until-found"` 的容器里，文档里行的顺序与身份不变。
- 流式帧不重绘历史行；尾轮转为历史或完整快照补入较早的轮次时，原轮次沿用原来的 key，保留展开、选择、复制与查找锚点。

**工具与结算的顺序。**

- 收到完整的模型终止事件后，先持久化助手文字与工具批次，再串行执行工具。Provider 不能在 finish 之后继续发内容，缺少 finish 视为失败；Standard 不派发那次未确认的工具调用。普通 chat 模式遇到工具调用明确失败，不执行后隐藏记录。
- 工具消息的 ID 是 `tool:<callId>`，按 `queued → awaiting-approval（需要时）→ running → completed/failed/cancelled` 更新同一行。拒绝不经过 `running`。
- 模型流截断或取消时尽量保留已收到的正文，并标为失败或已停止；崩溃前尚未结算的内存文字可能丢失。被中断的工具结果可能未知，不自动重放也不回滚。

**审批的位置与顺序。**

- 审批显示在输入框上方的抽屉里，不进入对话；带 `toolCallId` 时用 `tool:<toolCallId>` 那一行的文字与差异。按钮来自 `Approval.options`，缺省为允许与拒绝；当前设备能看到哪些由风险等级与设备权限决定（[DESIGN.md](./DESIGN.md)）。
- 审批的认领在异步等待之前完成，重复或迟到的决定失败；同一审批的决定在 Host 上串行处理。

**运行与活动。**

- 每次运行（创建或一次输入触发）有自己的 `TaskSummary.runId`，由 Driver 在运行开始时写入会话并持久化；不记录运行的外部 Driver 不提供它。
- `activity` 是 `starting / model / tool / approval / cancelling`，`since` 只在阶段变化时更新；它不是百分比进度。`plan` 是 Harness 报告的最新计划（整体替换），`config` 是 Harness 允许修改的会话选项。
- 已有会话的下一条在恢复会话期间还没有记录时，摘要也投影为 `running` 与 `starting`，带这一轮新的 `runId`，不带上一轮的 `runOutcome` 与 `runEnd`。所以这时停止能停到这一轮，记为已发送、在送到 Agent 之前停止的一轮。
- 桌面端把「思考中」放在本轮提问的回复位置。新提问尚未到达时，上一轮保留原来的回复和结束信息。正在输出的推理或回答会接替占位。工具运行后仍在等模型回答时，等待提示跟在本轮工具记录后。
- **取消等真实结算。** 取消请求 Provider 与工具中止，等实际结束与状态提交后才确认；只是网络请求失败时，界面不能说已取消。

经 `api.ts` 发出的请求在 `429 rate-limited` 且 `retryAfter` 不超过 5 秒时自动等待并重试一次：被限速的请求没有执行，重试是安全的。

撤销之后的第一条用户消息，文字最前面带一段给 Agent 的说明，消息文字就是实际发出的内容。

### 审批决定的请求 ID 与回执

`POST /link/api/approvals/:id` 的请求体为 `{ decision, optionId?, requestId?, note? }`。`note` 是拒绝时给 Harness 的说明；同一说明的重试用同一个 `requestId`，换一句说明算换一个选择。浏览器总是带 `requestId`：每个审批上的每个选择一个（`DecisionRequests`），同一页面同一审批同时只发出一个决定。

- **结果未知时重用。** 网络错误、超时（15 秒）、408 或 5xx 时结果未知，`requestId` 保留，重试或再按同一个按钮都重发同一请求。审批从快照里消失（已由某台设备结算）时提示随之去掉。这台设备此刻不能重发（Harness 未连接、权限变了、原选项已不在）时，卡片仍写结果未知，只给「核对」：重新读取会话，审批已结算就随之消失，否则保持未知。[确定的拒绝](#确定的拒绝)与其他明确回答之后丢弃 `requestId`。换一个选择总是用新的 `requestId`。
- **回执。** Host 接受后返回 `{ accepted: true, receipt: { approvalId, decision, optionId?, at } }`。同一设备用同一 `requestId` 重发时返回原回执并带 `replay: true`，不再决定也不再审计。
- **已被处理。** 其他情况下，已处理或已失效的审批返回 `409 approval-settled`，`decidedBy` 为 `{ kind: 'device', self, deviceName, decision, optionKind, at }`，或 `{ kind: 'system' }`（会话结束或取消使其失效）。`deviceName` 是作出决定的设备当前的名称，Host 已不认识它时为空。
- **客户端的判断。** 本设备此前作了同一决定（有 `optionKind` 时还要求选项类别相同）视为已生效；作了不同的选择时提示本次选择未生效；由其他设备处理时写出设备名，设备名为空或不合设备名称规则时、以及 `system`，只说该审批已结束。
- **随会话保存。** 决定记录（审批 ID、`requestId`、设备 ID、决定与选项、时间）在回答之前写入数据目录的 `sessions-meta.json`，所以 Host 重启后同一 `requestId` 仍得到原回执，其他设备仍得到 `decidedBy`。记录保留 7 天，每台设备至多 1 万条、合计至多 10 万条，最旧的先删；删除会话时一并删除。
- **写入失败不挡决定。** 决定照常生效，记录留在内存并进入下一次写入，日志记下失败。
- **决定不弹确认。** 允许与拒绝都由设备的权限范围决定。

### 取消的请求 ID 与回执

`POST /link/api/tasks/:id/cancel` 的请求体为 `{ requestId?, runId? }`，两项都可选。页面总是带 `requestId`，并带它显示的那次运行的 `runId`（摘要里有时）。同一会话同一次运行的停止在结果未知时重用同一个 `requestId`，明确回答之后丢弃；运行变了就用新的。

- **只停止指名的运行。** `runId` 与会话当前的运行不同时，Host 不停止任何东西，回答 `ended` 且不带 `status`；相同但已结束时回答 `ended` 与它结束时的状态。不带 `runId` 的请求停止正在进行的运行，没有时回答 `ended`。
- **先审计，再核对，再停止。** 指名的运行仍在进行时（Driver 列不出该会话、Host 无从判断时也一样），Host 先审计 `task.cancelled`（detail 含 `runId`），再把 `runId` 交给 Driver。Driver 在开始取消的同一步核对它，所以审计期间结束、又开始的新一轮不会被停止。
- **结算后才回答。** 运行真正结算后回答 `stopped` 与结算后的状态（通常是 `cancelled`；结算前刚好完成时是 `idle`）。
- **回执。** `{ accepted: true, receipt: { sessionId, requestId?, runId?, outcome: 'stopped' | 'ended', status?, at } }`。带 `requestId` 的回执与审批决定一样随会话保存（同样的期限与上限，按会话、设备与 `requestId` 区分）。
- **重试。** 同一设备在同一会话用同一 `requestId` 重试，包括 Host 重启之后与该会话的 Driver 未能挂载时，都得到原回执并带 `replay: true`，不再审计或取消。同一 `requestId` 换了 `runId` 返回 409 `request-conflict`。同一请求的两个副本同时到达时，后到的等前一个结算，得到同一份回执。
- **强制停止。** 回执带这次运行的 `runEnd`（见[运行的真实状态](#运行的真实状态)）：`reason` 为 `forced-stop` 时，`unknownResultCount` 说明有几条命令结果未知。回执不带它们的名称，因为原生客户端在正文窗口之外也能取消。
- **页面。** 回答 `ended` 时立即结束「正在停止」，并说明是这一轮已结束，还是要停的那一轮已结束而新的一轮仍在运行。不带回执的回答（旧 Host）让页面照旧等会话状态变化。

### 会话设置的写入

模型菜单、思考控件与输入框的「⋯」共用一道写入门禁，未知结果按会话保留原始请求。

- 未知时不出红色横幅，给出核对、重试同一请求与放弃。核对请 Host 向 Agent 读取当前设置后结算；Agent 忙、读不到或读到第三个值时仍未知。重试同一请求只得到回执。两者都不再发送修改。结算后再选才用新的 `requestId`。
- 放弃只在这个页面上放下，Host 的回执不变，原 `requestId` 不再发送。
- 没有配置回执的 Host：只有真实配置已读回目标值才解除未知，不能把一个仍旧的值当成失败。
- 项目目录失效的确定拒绝由项目恢复面板承接，保留可编辑的草稿；结果未知时不能转成一次新的分叉。

Harness 的进程级换档在空闲时结束旧进程并恢复同一外部会话，准备与恢复期间拒绝发送、追加与其他配置写入（[HARNESSES.md](./HARNESSES.md)）。

### 输入身份与分叉上下文

- **`requestId` 写在用户消息上。** Standard 与 ACP 在接纳用户输入时把原始 `requestId` 写到用户消息，两种消息存储的 schema 都保留它；`catalog.features.messageIdentity` 声明这一点。客户端据此关联重试与发送中的气泡。
- **分叉。** Host 为分叉的首条消息补 `forkContext`，`prefixLength` 是正文开头的上下文字符数，其余是新输入。正文完整发给 Harness；消息带 `nativeFork` 时例外：Harness 用自己的记录分叉了，开头的上下文没有发给它（[ARCHITECTURE.md](./ARCHITECTURE.md#会话分叉)）。
- **重试分叉的一轮。** 带 `nativeFork` 的只重发新输入（换回用过的 Harness 的那一条例外：它分叉的记录里没有离开之后的内容，重试连同记录一起重发）；其余连同上下文一起重发，因为第一轮失败时上下文可能还没到 Harness。折叠只是显示方式，复制消息保留完整正文。
- **接入的会话。** `TaskSummary.imported` 的会话里，从 Harness 重放来的消息带 `imported: true`，不属于任何一轮。按文字重建的会话首条消息开头 `imported.prefixLength` 个字符是带上的对话文字，Host 补 `importContext`；页面据此折叠，重试只重发新输入，因为这段文字已随第一次发送交给会话（[HARNESSES.md](./HARNESSES.md#接入已有会话)）。
- `Message.thinking` 是助手消息那一步的思考深度，与 `Message.model` 一起让客户端标出两轮之间换了什么；没有记录的消息不标。

### 从这里编辑

人自己的一条消息上的「从这里编辑」把它的文字（去掉分叉的背景与撤销的说明）、文件引用与附件放回新会话的输入框；发送后会话从这一条之前接着走。

- **机制：分叉，不原地回退。** 从这一条之前的那条消息分叉。第一条没有之前：分叉出来的会话从它的分叉点再分叉；其他会话由 Host 开新会话（`POST /tasks` 的 `editOf: { taskId }`，需要能读那个会话）：来源私有时新会话同样私有，来源从外部内容开始（交接、分叉、接入、定时或无人值守的运行）时新会话标为 `outsideStart`，它之后的提议照样标为外部。页面从不自己拼这个会话。原会话一条也不删，仍可打开；新会话带 `forkOf`。Harness 能用自己的记录分叉时用它（`nativeFork`：pi、Codex 与 Claude 的直连线，见 [HARNESSES.md](./HARNESSES.md)），其余（Claude 的适配器路线、其他 ACP、内置）用背景文本。从不把一个记着后来几轮的 Harness 说成已回退。
- **文件。** 这一条起的轮次改过文件、而且改动记录覆盖每一轮时，先给出「同时把文件退回到这一条之前」，列出要写回与删除的文件和不会改动的文件，确认后才写。覆盖不到时这一项不可选，悬停说明原因；没有改过文件时直接回到输入框。退回成功后才放回输入框，失败就留在对话框里说明。
- **运行中**按钮不可用，悬停写「这一轮结束后才能编辑」；Host 同样拒绝（`fork-running`、`change-running`）。
- **附件**经 `POST /attachments/:id/reuse { requestId, selection, sessionId? }`：Host 按读附件的同一条规则核对这台设备此刻能读那条消息（`view`，会话在它能看的范围里），按当前所选 Harness 核对能力，把存好的字节复制成这台设备的新草稿（审计 `attachment.add`），不从设备或项目重读。页面再读回草稿的字节作预览。读不到或不再允许时那一行只能移除。
- **文件引用**照原样放回；这台设备的数据范围不含会话文件夹时不带上，并提示一次。
- 需要 `run`；私有会话照旧只在能看到它的设备上出现。这台设备有一条还没确认送达的消息时不开始编辑（先于退回文件判断）。

### 本设备的发送投影

源码：[useSubmission.ts](../apps/web/src/hooks/useSubmission.ts)、[sendingMessage.ts](../apps/web/src/core/sendingMessage.ts)。

**临时气泡。** 提交后立即显示临时文字，500ms 后才显示「发送中…」；按相同的 `requestId`、文字与附件或文件引用匹配到 Host 的消息后隐藏。临时状态不写入 `TaskDetail`、快照或 Host 的存储；会话仍由 Host 维护。队列接收不生成临时气泡。看板「新建」发起的新会话在 Host 接下后不打开：草稿照常用掉，页面留在看板，结果未知时同样以原请求重试（`setStay`）。这个选择随待发送的提交一起存下（`stay`，不发给 Host），刷新后重试仍留在看板。待办卡的「开始」走同一个提交：待发送的提交多带 `itemId` 与读出要求时的修订，发往 `POST /work/items/:id/start`（`baseRevision`），重试与放弃不变（`setItem`）。待办讨论的发言不走这个提交：它在讨论里自己显示发送中与结果未知，重试用同一个 `requestId`；讨论的变化不新增事件种类，快照里待办的 `threadRevision` 变了、或某条回复所在的会话变了，页面重读讨论。

从对话起始页发送第一条时，以 `requestId` 在对话布局投影气泡与所选 Harness、项目。未知时保留原草稿和提交。Host 回执给出真实会话 ID 后在原位置接续，若人已打开别的会话则保留当前选择。临时投影不驻留详情缓存。

**结果未知。**

- 保留原提交，以同一请求体与同一 `requestId` 重试；重试从不更换 `requestId`。
- 每台设备只有一条未确认的消息：它所在的输入框为它锁定，其他输入框可以写，但都等它结束才发送。它不是离线任务队列：离线时不发新的写入。它所属的会话（或新会话）显示重试，其他会话只提示并给出打开与放弃。
- 卡片写出最近一次重试为什么仍未确认；原因按 `requestId` 存在 `latch.pending.<origin>.<deviceId>.reason`，像凭据的原因只在内存。
- 这台设备离线（`offline`）时不发送：发送键与回车同样不可用，文字留作可编辑的草稿；未确认的卡片写「这台设备没有联网」，不说连不上电脑。
- 连接断开（`offline` 或 `reconnecting`）后重新连上时，自动核对未确认的那一条：先重新读它的会话，已列出就按已送达结算；否则（含新会话的第一条与我的 Agent 的第一条）以同一 `requestId` 重试一次，由 Host 的回执或答复结算（另一个窗口正在重试时不做）；仍无答复就留着卡片。

**未知只由两件事结束：Host 的证据，或人放弃。**

- **证据**是会话列出带这个 `requestId` 的用户消息（只比 `requestId`，不比文字）：打开的会话出现它时按已送达结算，原会话存着的同一段草稿一并删除。新会话的提交在答复前没有会话 ID，无从核对。
- **带附件的例外。** Host 可能先列出消息，再以 503 `attachment-publish-unknown` 要求同一请求；页面因此用同一 `requestId` 静默再发一次，以它的答复结算，人放弃时才按已送达结算。
- **放弃**先重新读一次该会话（读不到才用屏幕上的副本），已列出就按已送达结算。否则只在本设备放下：存储里仍是这条记录时才删除，文字回到原输入框（原会话不在屏幕上时存为它的草稿），附件与文件引用清空并提示重新添加，因为附件已保留给被放弃的请求（`attachment-claimed`）。
- **放弃之后再发送**是一条新消息、新的 `requestId`；Host 如果其实收到过，就多出一条。
- **排队或追加的提交。** 会话的队列里有同样文字的一项时，卡片说明队列里有一条在等待或已暂停。队列不下发 `requestId` 与设备，那一项可能是别的设备的，所以只比文字、只作说明，从不挡住放弃。

**同一设备的多个窗口。**

- 发送前再读一次存储：另一个窗口已存下别的未确认消息时不发送，改为显示它的卡片。
- 发送或重试中的窗口在 `latch.pending.<origin>.<deviceId>.sending` 写下 `{requestId, until}`（20 秒，长于请求的 15 秒超时）；其他窗口在它到期或被清除前不提供放弃。
- 每个窗口结算时只删除仍是自己这条 `requestId` 的记录；另一个窗口结算后，经 `storage` 事件清除这一行。

### 确定的拒绝

一次写入是否「结果未知」按 Host 的错误码判断，不只看状态（`@latch/protocol` 的 `refusedBeforeAccepting`）：

- **结果未知：** 网络错误、超时、408 与 5xx。
- **确定的拒绝：** 4xx（408 除外），以及错误码在 `NOT_ACCEPTED_5XX` 里的 5xx：`audit-unavailable`、`presence-unavailable`、`agent-busy`、`agent-start-failed`、`agent-refused`、`agent-paused`、`agent-handshake-timeout`、`model-gateway-unavailable`。4xx 的例子：409 `harness-unavailable`、`harness-version-unsupported`。

规则：

- **清单里的码只在 Host 什么都没记下时出现**：没有用户消息、没有回执，也没有之后还可能把它发出去的排队项。新增一个在接收前拒绝的 5xx 时，同时加入 `NOT_ACCEPTED_5XX` 与 Swift 的 `NativeHostRefusal.notAccepted5xx`（`native-swift.test.ts` 核对两份一致）；接收之后才可能出现的码不能加入。
- **ACP 重新接上 Agent 时**（这一轮还没有记录）进程退出或不再应答，Host 答 503 `agent-start-failed`；Agent 回答错误（会话被别的客户端占用、回答无效）时答 502 `agent-refused`，带它自己的原因。
- **页面。** 确定的拒绝之后丢弃 `requestId`，文字留在输入框，原因就地显示，并按错误码给出下一步。Host 同时放下为这个请求保留的附件。
- **立即发送的排队消息**（会话空闲时 `queue: true`）先写下排队回执再发送。发送被这样拒绝时，Host 先删掉这一项与它的回执再回答，并为已写下的 `task.prompt.queued`、`task.prompt.sent` 审计各补一条 `action.failed`。删不掉就把这一项留作发送结果未确认，改答不在清单里的 503 `queue-send-unknown`。所以同一段文字只有一条重发的路。
- **重试被拒绝。** 网页上，同一 `requestId` 的重试得到确定的拒绝也结束等待。iPhone 与 iPad 上，第一次提交的确定拒绝不留作结果未知；重试的拒绝只有 Host 按第一次提交的回执作答时（`retryAnswered`，例如 `attachment-released`）才结束等待，其他拒绝仍留作结果未知，因为重试被拒绝说明不了第一次是否已被接收。
- **Host 先认回执。** Driver 把这一轮写稳之后，Host 在内存里按会话、设备与 `requestId` 记下所发内容的哈希。同一设备带同样内容的重试不再做提交前的检查，直接答已接收（带附件的再补一次绑定）；所以项目、Harness 版本、模型、文件引用或数据范围的变化不会把已送达的消息说成被拒绝。
- **仍照常检查的重试：** 别的设备、还在写稳中的一轮与 Host 重启之后（重启后 Driver 自己的回执仍按 `requestId` 防止重复）。同一 `requestId` 换了内容是 409 `request-conflict`。

### 清空上下文

`TaskDetail.clearContext` 为真时，`POST /tasks/:id/prompt` 接受 `freshContext: true`：这一轮在新的上下文里开始，Harness 看不到之前的消息，消息仍留在会话记录里。

- **边界持久。** Driver 把它记在这一轮的用户消息上（`Message.freshContext`，两种消息存储的 zod schema 都保留），重连、切换会话与刷新都不会丢掉或移动这条边界。从边界之后某一轮分叉时，种子从这条边界开始。
- **拒绝。** 与 `queue`、`steer` 一起用是 400 `fresh-context-queued`；不声明的 Driver 答 409 `clear-context-unsupported`；来自已移除 Agent 的只读会话答 409 `session-read-only`。
- **重试**沿用原 `requestId`；带不带 `freshContext` 是不同的请求（`request-conflict`）。
- **实现。** Latch 内置清空发给模型的历史；ACP 开新的 Agent 会话（[HARNESSES.md](./HARNESSES.md#清空上下文)）。
- **发送前只是本设备的选择。** 网页与桌面端是 `/clear` 或会话菜单，iPhone 与 iPad 是页头会话菜单（只在 App 内存里）；不写 Host，运行中不能选，一轮开始时选择撤掉。选定后重试最新一轮，重发的这一轮也带 `freshContext`。它随待发送的提交一起保存，结果未知时原样重试。
- **`TaskDetail.contextCleared`。** Driver 在这一轮开始前已放下旧上下文、这一轮却被拒绝或没有开始时，下一条消息不论是否要求都在新的上下文里；各端写出这一点，不再提供撤销。

### 排队状态与实际发送

支持附件排队的 Host 为上传的图片或文件保留原设备的占用。队列摘要给出附件数量。原生端使用同一条队列请求，可将空的说明和图片 ID 一起提交。实际派发时再校验模型能力、设备和会话，并沿用正常消息的附件绑定流程。暂停或编辑文字时保留附件，移除时释放，结果未知时保留原派发标识。

- 详情与 SSE 的 `TaskDetail.queue` 按 Host 的派发顺序给出每项的 `id`、`text`、`queuedAt`、`state` 和可选原因。`state` 为 `waiting`、`parked` 或 `dropped`。支持队列操作时，`orderRevision` 表示所见顺序的修订（省略时为 0），`canSteer` 标出具备追加条件的项。`delivery` 在派发中、普通发送结果未知或追加结果未知时分别为 `sending`、`uncertain`、`steer-unknown`。设备身份与请求回执留在 Host。
- 入队回执不生成用户消息；实际派发才生成带 `requestId` 与 `queuedAt` 的正常消息。编辑会换派发标识，原提交的重试仍命中同一项。
- 从队列追加还需本轮有 `TaskDetail.steer`。客户端带上所见 `runId` 与该项的 `contentRevision`（未编辑时为 0），Host 确认后，在这一轮保存一条带 `steered` 和原 `queuedAt` 的用户消息。迟到的操作不能追加到随后的轮次。
- 两种 Driver 的 zod 快照保留 `queuedAt` 与 `TaskSummary.runOutcome`。新运行清除旧 outcome，真实结算后才写完成、失败、取消或中断。队列不从网络状态、`idle` 或文字猜测完成。

### 追加到运行中的一轮

`TaskDetail.steer` 为真时，正在运行的这一轮还能接收文字，提交带 `steer: true`。它只来自本轮进程的协商（ACP Agent 在 `initialize` 的 `_meta.steering.supported` 声明），轮次被要求停止后即消失。

- **接收。** Host 经 `Bridge.steer` 转给 Harness；Agent 接收则回答 `{ steered: true }`，消息作为带 `steered` 的用户消息进入这一轮，不开新的一轮，客户端也不按它分轮。
- **退回排队。** Harness 不支持、轮次已结束或 Agent 回答 `promptRequired` 时，同一请求按排队处理：有轮次在跑就排队，没有就直接作为新一轮发送。
- **拒绝是确定的。** Agent 拒绝时返回 409 `steer-failed`：内容没有发出，不是结果未知。
- **重试用原 `requestId`**，得到第一次的结果。第一次已按排队处理时，重试只命中那一轮或那一项，即使这时的轮次能接收追加。
- **没有回答就不重发。** Agent 没有回答（超时或进程中断）时回执保持发送中，之后的重试一律 409 `steer-unknown`，因为 Agent 给每次请求另起消息，分不出重发。
- **`steered` 只表示 Agent 接收了**，不表示它在本轮结束前读到。本轮没有正常完成、期间有过追加、而最后一次追加之后 Agent 再没有任何输出时，结束时写一条系统消息说明它可能没有读到。
- 追加不带附件与文件引用，也不替人拒绝等待中的审批。

### 子 Agent

- Harness 启动的子 Agent 是会话记录里的一行工具消息，带 `Message.subagent`（名字、说明、状态、步骤）。它的状态只来自它自己的报告；所在的一轮结束时仍未报告停止的记为 `unknown`。
- 它请求的审批在会话的 `approvals` 里，`Approval.subagent` 是它的名字，`Approval.subagentId` 指向已记录的成员行（含嵌套成员），没有 `toolCallId`。一轮结束后才到或仍在等的这类审批让会话处于 `waiting-approval`，详情里没有 `activity`；答复后会话回到这一轮结束时的状态。
- 能单独停止的子 Agent 带 `Subagent.stoppable`；停止之后带 `stopping`，直到它报告结果或这一轮结束，页面在此之前不说已停止。

机制见 [HARNESSES.md](./HARNESSES.md#子-agent)。

### Codex Agent 团队

Codex 的原生委派在同一会话的详情里沿用 `Message.subagent`。

- 有父轮与直接父关系证据的行带 `Subagent.team`；待处理的 `Approval.subagentId` 指向发起审批的 Latch 消息。客户端只提交原有会话与审批的标识。
- 显式从 Web 或桌面的团队面板发给 Codex 的一轮，在用户消息上保存 `teamRequest: true`。排队或重试沿用标记，排队的分工独立成轮。概要按 `Subagent.team.userMessageId` 找对应用户消息，只有带标记的直接委派归入「团队成员」。刷新与重连仍按同一条消息归组。
- Team 的变化随完整的 `task-state` 传输，正文追加帧不承载它。
- Host 丢失进程时保存的成员留在原行；只有验证过的官方读回能补上缺失的状态，正文重连不自动派发工作。

## Agent 提问与回答

`catalog.features.questions` 表示 Host 支持内置问答接口。ACP Agent 的提问经 `HarnessHostOptions.askUser` 进入同一张提问卡（[HARNESSES.md](./HARNESSES.md#agent-的提问)）。

- 题包只出现在所选会话的 detail 与事件里，页面把它画在输入框上方的提问卡里（`QuestionDrawer`），不画在工具行上。草稿与当前题号只存在本设备，切换会话或重载后恢复。
- 提交前保存完整的 `requestId` 与 answers；结果未知时以相同内容重试，卡片卸载不取消已被接纳的写请求。工具结果落盘后才替换为已回答的记录，随后模型继续。
- 问答沿用审批等待的传输状态，详情里的 `questions` 决定界面显示提问卡；工作计时与审批等待共用同一暂停区间。
- Host 重启结束未答的题。回答被接收与工具结果落盘之间崩溃时，只有实际会话的 completed 输出完全匹配才恢复已回答的回执，不凭客户端声称的成功继续执行。
- **另一台设备先答了。** 题在每台设备上都显示；先被接收的回答生效。还显示着旧卡片的设备再提交时，Host 答 409 `question-answered`（题已结束是 `question-closed`，已不在是 `question-not-found`）：页面不把它当失败，丢掉本设备保存的草稿与待提交，提示「这个问题已在另一台设备回答」，重新读会话，卡片随之消失。
- **计划。** Harness 请人同意计划时（`Approval.plan`），审批卡把计划按 Markdown 显示全文，按钮是 Harness 自己的选项（「按计划执行」「继续规划」）；决定照审批记录与回执。见 [HARNESSES.md](./HARNESSES.md#计划审批)。

## 附件输入

附件字节独立上传，消息流只同步 `Message.attachments` 的元数据。与本文有关的规则：

- 发送引用前保存原 `requestId` 与 `attachmentIds`；响应丢失后重试相同请求，绑定后的附件也能认出原创建请求。上传中断或失败不等于消息已发送。
- 附件队列是客户端的草稿状态：点发送后先等上传，再建立持久的待确认提交。取消等待只终止上传，不调用会话取消。
- 文件选择的结构化引用与原请求一起保存；文字编辑移除标记也移除它的选择。

## 时间与用量

源码：[timing.ts](../packages/core/src/node-kit/timing.ts)、[hostClock.ts](../apps/web/src/core/hostClock.ts)、[conversation.ts](../apps/web/src/conversation.ts)。

界面上的每个时间与计数都来自 Host 的记录，客户端不估算。字段都可选（旧 Host、插件 Driver 与更早的历史没有），缺少时对应的部分不显示。时间是 Host 时钟的 ISO 字符串，来自 `ServerOptions.clock`；内置 Harness 与 ACP Driver 经 `HarnessHostOptions.clock` 用同一个时钟。

**持久的字段**（都在各自存储的 zod schema 里）：

| 字段 | 含义 |
| --- | --- |
| 摘要与消息的 `createdAt` | 用户消息被接受、助手一步开始、工具调用被记录、说明写入的时刻 |
| 工具的 `startedAt`、`completedAt` | 审批之后真正开始运行；结算 |
| 助手一步的 `completedAt`、`reasoningMs`、`model` | `reasoningMs` 从第一段推理到第一段正文或这一步结束；内置 Harness 另有 `providerId` |
| 用户消息的 `turn` | 这一轮结算时写入：`endedAt`、`activeMs`（提示到结束，减去等审批的时间）、`waitMs`（至少有一个审批在等人的时间，重叠时按并集）。经 Latch 转发到模型服务时另有 `routed`（[HARNESSES.md](./HARNESSES.md)「每轮的模型与用量」）；外部 Harness 报告了 tokens 时另有 `usage`，报告一次更新一次，所以运行中就有。Host 重启中断的一轮没有 `turn` |

**运行中的投影。** detail 带 `runStartedAt`、`runWaitMs`（已结束的审批等待）与 `runWaitingSince`（有审批正在等时），客户端据此算出不含等待的已运行时间，等待时停住。`lastOutputAt` 是可见输出（正文、推理、工具、计划、新消息）最后一次变化。`liveReasoningStartedAt` 与正文开始后的 `liveReasoningMs` 给出正在流出的思考用时。

**Host 时钟。** 客户端从快照与每个 `task-state` 的 `hostTime` 得到 Host 时钟与本机时钟的差；变化小于一秒视为网络抖动，不更新。所有活的计时都按 Host 时钟算，手机时钟不准时各设备读到的仍一样。Host 不发 `hostTime` 时差为零。走秒由页面共享的一个计时器驱动，页面隐藏时停止。

**用量。**

- 每一步的 `usage` 是 `inputTokens`（含缓存）与 `outputTokens`（含推理），模型服务报告时另有 `cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`。
- 合计多步时，某一部分只有每一步都报告了才保留：合计从不把没报告当成 0。
- ACP Agent 的 `usage_update`（上下文已用、窗口大小与费用）存为会话的 `usageReport`，只作为 Agent 的报告显示，不当作账单，也不从 tokens 推算。
- Claude 经模型网关时丢弃 CLI 对自定义模型推测的窗口与费用，只留已用上下文；pi 的网关同样不把运行预算与占位价格当成容量或费用。

## 运行的真实状态

源码：[run-silence.ts](../apps/host/src/run-silence.ts)、[hub.ts](../apps/host/src/hub.ts)、[sessions.ts](../packages/protocol/src/sessions.ts)。

已运行时间不代表进展。Host 记录每次运行最后一次有动静的时间，只说事实，**从不因为沉默而停止运行**。`catalog.features.runLiveness` 声明这些字段可用。

**`TaskSummary.live`**（运行期间才有，只在内存）：

| 字段 | 含义 |
| --- | --- |
| `runId` | 这次运行 |
| `activity` | `starting`（进程与会话在准备）、`model`（等模型）、`command`（命令在运行）、`tool`（其他工具在运行）、`approval`（等人）、`cancelling`（停止中，等执行端结算） |
| `commandName` | `command` 与 `tool` 时运行的是什么，一行、已脱敏；**只在会话详情里** |
| `since` | 这项活动开始的时间 |
| `queued`、`queuedFor` | 这次运行的模型请求在等空位；等某个服务的空位时 `queuedFor` 是它的名称。只由 Host 设置 |
| `runStartedAt`、`runWaitMs`、`runWaitingSince` | 整次运行的时钟，与详情里的同名字段一致；`since` 随活动重新开始，所以整次运行读这三项 |
| `lastEventAt` | 最后的动静：Harness 为这个会话发来的任何东西，或一项活动的开始（如审批刚被答复）。Agent 的 stderr 不算：它不属于任何一次运行 |
| `lastOutputAt` | 可见输出最后一次变化 |
| `silenceThresholdMs`、`silent` | Host 的判断，见下 |
| `unrecognized` | Harness 发来过 Latch 不认识的请求：`count` 与最新的 `at`。`lastEventAt` 尚未晚于 `at` 表示之后再无动静。详情里另有 `method` 与记录它的系统消息 `messageId` |

- **谁写。** Driver 报告除 `silenceThresholdMs`、`silent` 以外的各项；这两项只由 Host 计算，Driver 写了会被丢弃。
- **Standard。** `lastEventAt` 随 Provider 的每个事件前进；工具的 `kind: 'execute'` 算命令，名称是工具的标题。
- **ACP。** `lastEventAt` 随该会话的每个 `session/update` 与请求前进；`kind: 'execute'` 算命令，名称优先取 `rawInput.command`。同时运行几个调用时，一个结束后活动仍是还在运行的那个。
- **列表不带正文。** 快照的 `live` 不含 `commandName`、`unrecognized.method` 与 `messageId`，因为原生客户端在正文窗口之外也能读列表。

**阈值与沉默。** 模型（含 `starting`）2 分钟，命令与工具 10 分钟；等人与停止中没有阈值。`silent` 表示 `lastEventAt` 距今超过阈值，每次读取时计算，所以读不到过期的答案。电脑睡眠的时间也算沉默。

**没有周期开销。**

- Host 只有一个定时器，等最早到期的阈值；只在有运行可能越过阈值或正在沉默时存在，读的是 `Bridge.liveRuns()`（内存里的运行）。
- 越过时只发一次普通的会话变化。沉默中的运行每 30 秒复查一次（Driver 不必为每个动静都通知），发现恢复时同样发一次变化。
- 没有 `liveRuns` 的 Driver 仍在读取时算出沉默、可以继续等，但 Host 不主动宣布越过。
- 客户端用 `lastEventAt` 与 Host 时钟自己算分钟数，不需要 Host 持续推送。
- `lastEventAt` 的变化本身不让其他设备重读列表，只有活动、阈值、沉默或 `unrecognized` 计数的变化才会。所以列表里的 `lastEventAt` 可以落后于详情：判断沉默以 `silent` 为准，比较 `unrecognized.at` 与 `lastEventAt` 只在详情里做。

**继续等。** `POST /link/api/tasks/:id/keep-waiting`，权限 `view`，请求体 `{ runId, thresholdMs }`，`thresholdMs` 是页面看到的阈值。回答 `{ accepted: true, outcome, thresholdMs? }`：

| `outcome` | 含义 |
| --- | --- |
| `extended` | 阈值翻倍，只对这次运行的这类活动（模型与命令各算各的）；下一次询问会在半个原阈值之内到来时再翻一倍 |
| `unchanged` | 阈值已不是请求看到的那个：一次重试或另一台设备已点过。所以它不需要 `requestId`，重试总是安全的 |
| `not-silent` | 现在并不沉默，或正在等人、停止中 |
| `ended` | 这次运行已不是活动的 |

延长的阈值只在内存，运行结束时丢弃。这个操作不授予任何权限，不写审计。

**`TaskSummary.runEnd`**（随会话持久化，新运行开始时清除）说明一次运行不是以普通回答结束的：

| `reason` | 含义 | 会话状态 |
| --- | --- | --- |
| `process-exited` | Harness 进程自己退出，或超出协议限制被结束 | `failed`（停止途中退出时为 `interrupted`） |
| `forced-stop` | 停止在 30 秒内没有结算，Latch 结束了进程 | `interrupted` |
| `host-stopped` | Host 在运行期间停止或重启（正常停止与崩溃后重启都算，不当作谁的取消） | `interrupted`，`runOutcome` 也是 `interrupted` |
| `turn-ended` | Harness 结束了这一轮，但有调用没有报告结果 | 按这一轮的结果 |
| `login-required` | Agent 以要求登录拒绝了这一轮 | `failed` |

- **结果未知的调用。** `unknownResults` 列出当时在运行的调用（`messageId` 是工具行，`name` 是命令文本），至多 32 条，更多时带 `unknownResultsTruncated`。因为含命令文本，它**只在会话详情里**；列表与取消回执只带 `unknownResultCount`。
- **进程退出不是可重试的失败。** 进程退出的运行 `status` 是 `failed`，但 `runOutcome` 仍是 `interrupted`：那条命令是否生效没人知道，定时任务不能把它当作可重试的失败。
- **`host-stopped` 的记录。** 这一轮留下一条系统消息（`state: 'cancelled'`、`Message.interrupted`），不是失败。当时没有报告结果的工具行带 `interrupted`：开始过的是 `failed` 且输出含 `TOOL_OUTCOME_UNKNOWN`，没开始的是 `cancelled`；中断前已报告完成的调用照旧是完成。
- **客户端不把中断写成失败。** 最新一轮给出重试；ACP 会话重试时先 `session/resume`、`session/load`，都不支持则 `harness-session-lost`，改在新会话中继续。重试前的确认说明有几个操作结果未知。
- **Standard 没有强制停止。** 工具与模型在进程内运行，停止只发中止信号并等它们真实结算；不理会中止的插件工具会让运行一直停在 `cancelling`。

**失败在原地说明。** 一轮失败时的系统消息就是原因：Host 或模型服务的 `AppError` 文字、Harness 的错误，都先经 `redactSecrets`。它带 `Message.errorCode`（AppError 的 code；模型服务的 HTTP 状态记为 `http-401` 这样的码），客户端据此给出一个下一步（`apps/web/src/conversation/failureAction.ts`）；通向设置的下一步只对所有者设备出现，项目目录失效不给按钮（由项目恢复面板说明）。输入框里被 Host 确定拒绝的发送按同一个 code 给出同样的下一步。

## 阅读位置

源码：[useReadingPosition.ts](../apps/web/src/core/useReadingPosition.ts)。正文的 `scrollTop` 只由这个 hook 写入。`ready` 必须表示 detail 已加载且属于当前会话，在此之前不写滚动位置。

| 模式 | 行为 |
| --- | --- |
| `follow` | 流式正文或容器尺寸变化后保持在当前底部 |
| `read` | 记录首个可见 `data-message-id` 与它相对视口的 offset；布局变化后保持这条消息的位置，不跟随新增正文 |

- **谁能离开 follow。** 上翻的 wheel、键盘、触摸与滚动条拖动是用户意图。嵌套可滚动区能消费的滚动不释放外层的 follow；程序自己的滚动与视口变大引起的 clamp 不算上翻。
- **手势期间不补偿。** 用户手势或惯性期间不做锚点补偿，避免与拖动竞争。锚点只在读者滚动时更新，程序写入不替换它。
- **回到 follow。** 「回到最新」、成功提交输入，或用户向下滚到接近底部。
- **对齐时机。** 同一会话里，跟随位置随正文或视口的 ResizeObserver 尺寸变化在绘制前对齐；切换会话、收到首份详情与显式跳转立即对齐。阅读模式在提交时核对锚点，覆盖总高度不变但锚点已移动的重排。
- **`reveal(messageId)`** 把指定消息行滚入视野，目标已在底部附近时等同于回到最新。目标在收起的折叠里时，页面先向它外层每个 `hidden="until-found"` 的容器派发 `beforematch`（与浏览器页内查找同一条路径），下一帧再 `reveal`。
- **嵌套滚动框**（思考、运行中的工具输出）用 `flex-direction: column-reverse` 从末尾排布，自然跟随最新内容，不写 `scrollTop`。
- **每个会话各自的位置。** 切换会话保存各自的模式与锚点，至多 100 个会话，只在内存：不写磁盘或浏览器存储，刷新整页不保证恢复。锚点消息消失时用限制在有效范围内的旧 offset。
- **待办的来源跳转。** 从讨论按源消息定位，用该轮用户输入作为同轮内的备用位置。源回合不可用时回到待办。阅读同轮回复时保留锚点，返回后恢复待办滚动位置与焦点。
- **未绘制的轮次。** 视野外的已结算轮次用 `content-visibility: auto` 推迟绘制（打印时恢复）。它只占估计高度，行却按完整高度测量，所以定位锚点时先让锚点所在轮次与视野内其下的轮次真正绘制（`data-drawn`），且只在与视口相交的轮次里测量。切回会话、页内查找与 `reveal` 因此落在同一行。
- **会话定位条**与消息列表共用已提交轮次的投影，跳转用 `reveal`；只让正文变长的帧沿用同一份投影。

消息列表没有历史分页或虚拟列表。手机视口变化经 ResizeObserver 参与布局，但浏览器尺寸的验收不等于真机软键盘与惯性滚动。

### 搜索定位与阅读标记

- 正文搜索的响应不是会话状态更新。点击结果先切到原会话，等对应 detail 后再经 `useReadingPosition` 定位；迟到的搜索响应不改当前会话的正文。
- 会话内查找只创建 DOM Range 与 CSS Highlight，折叠行经 `beforematch` 展开，不改写消息节点。
- 查找打开时按 `detail.sync.revision` 重扫流式追加，没有同步版本时才退回 `detail.cursor`：正文追加可能让 `cursor` 与已提交的 `messages` 引用都不变，不能据此跳过新文字。重新计数按消息与匹配身份保留当前选择。
- 手动「标为未读」是每台设备的本地阅读偏好，存在已有的阅读标记里；重新打开或收到该会话的更新时清除，删除会话后清理。
- 打开失败会话时，客户端只在会话在视野内且文档可见时发送「打开过」标记。支持主窗口切换电脑的桌面端还要等主进程报告当前工作区已选中，切回时才标记此前在后台失败的回合。
- 文件标签是客户端的阅读状态，不改 Host 的会话状态；文件列按会话与项目分开保留引用，切换上下文取消旧的读取，迟到的结果不更新新上下文。

## 工作过程的行

源码：[ToolCard.tsx](../apps/web/src/components/ToolCard.tsx)、[shellUnwrap.ts](../apps/web/src/core/shellUnwrap.ts)、[conversation.ts](../apps/web/src/conversation.ts)。这一节只是画法：Host 给的消息、ID、状态与工具输入不变，报告的原文始终在行的提示与展开后的参数里。

**命令外壳的还原**（`unwrapShell`，共享向量 `packages/testkit/vectors/shell-unwrap-v1.json`）。

- 只在命令行是 `sh`、`bash` 或 `zsh`（裸名字，或正好在 `/bin`、`/usr/bin`、`/usr/local/bin`、`/opt/homebrew/bin` 下）加 `-c` 或 `-lc` 再加**恰好一个** shell 词时，显示这个词去掉引号后的内容。只还原一层。
- 别处的 shell、多出的参数、别的开关、词里有会被外层 shell 展开的 `$` 或反引号、未闭合的引号、空命令，都按报告的原样显示。
- 命令里的路径按报告的写，不改写成 `~`。

**审批卡不改写。** 调用的标题就是这条命令时，卡片显示还原后的整条命令，保留换行、不截断，并另写外壳报告的原样；标题是 Agent 另写的说明时显示说明。很长的命令在自己的框里滚动，框下写出还有几行，最后一行不会不声不响地藏在下面。

**行与块。** 已结束的命令是一行，输出展开后才出现。运行中、失败、被打断或结果未知的命令是块：显示输出的最后 5 行，每行不换行、至多 400 字符。协议不带退出码，所以不画退出码。

**终端颜色。** 输出里的 SGR 颜色（16 色、粗体、暗）映射到内容色板，其余转义序列（光标、标题、链接、256 色与真彩色）丢弃；回车覆盖的行只显示最后写的内容。复制、查找、折叠的尾行与失败原因都用去掉转义后的文字。失败原因取第一行写着 error（含 `AssertionError` 这类）、exception、fatal、panic 或「错误」的，没有时取第一行。

**Harness 自己分好类的命令。** `ToolDetail.actions`（可选，至多 16 项，`kind` 为 `read`、`list` 或 `search`，带 `path` 与 `query`）是 Harness 对一条命令的解析。

- 目前只有 Codex 报告（[HARNESSES.md](HARNESSES.md)），且只在它把命令的每一部分都认成读取、列出或搜索时才有。
- Host 只接受自己的 Codex 线路给出的 `actions`：其他 ACP Agent 发来的在读取处丢弃（`ownFields`），接入历史时同样丢弃。保留下来的 `path` 与 `query` 和标题、输入一样经过脱敏。
- 它只能把一条简单命令画得更安静，不能反过来：还原后的命令里有 `|`、`;`、`&`、`>`、`<`、反引号、`$(` 或换行（或命令行读不出来）时不用这个字段，命令照旧是命令行，不进分组。
- 等待批准或排队的调用始终按命令显示；审批卡不用这个字段。
- Latch 不从命令文字推断读取、列出或搜索：没有这个字段的 `cat`、`rg` 仍是命令行。

**分组**（`joinQuiet`）。同一段工作里连续 3 条及以上、已经结束、没有人需要决定的读取、列出与搜索收成一行，点开是原来的各行。

- 数字只数条目自己报告的：带 `actions` 的命令按动作数，其余每条算一次。
- 命令、改文件、失败、被拒、被打断、结果未知、带图片的调用与子 Agent 从不进组；正在运行的那一条留在外面，结束后才并入。
- 组以第一条的 ID 为键，变长时保持位置与展开状态。
- Harness 的图片工具行（`ToolDetail.imageGeneration`）不是工作：它在回复里自成一块（`turnBlocks` 的 `picture`），是图片的位置，从不进组、折叠或按档位隐藏，也不算进「已工作」与它的失败步数。

**显示档位。** `Preferences.workDisplay` 按设备存在浏览器里：全部显示（默认）、只留失败、收起。它只改这台设备画什么，不改会话、导出或其他设备。

- 后两档下始终显示的行（`alwaysShown`）：等待批准的调用、失败、被拒、已取消、被打断、结果未知、与批准记录矛盾的调用，以及还能单独停止或含有这类步骤的子 Agent。
- 提问、失败说明与回复正文不属于工作过程，任何档位都不隐藏；审批卡照旧在输入框上方。

**思考。**

- 思考按标题分节（`reasoningSections`）：空行之后整行只有一个加粗短语的是标题；没有这种行的思考是一节。
- 正文走回复的 Markdown 管线（同一个解析器、深度上限与 URL 规则），但只画段落、列表、强调、行内代码与 shell 代码块（`ReasoningContent`；代码块可复制或填入终端，不执行）。链接、图片、标题、引用、其他代码块与 HTML 都显示成写下的原文，不启用 GFM 与数学：思考里没有能点、能加载、能执行的东西。
- 含不可见字符或嵌套过深的思考整段按纯文本显示并标出每个字符。本页没有展开过的历史思考保持纯文本，展开时才解析一次。

**一帧最多画一次**（`core/frameGate.ts`）。只让正文或思考变长的帧立即通过版本门禁并更新最新状态，但每个动画帧最多渲染一次：一帧里到了几份只画最后一份，页面在后台时不画，回到前台画一次。画的永远是已接受的最新状态。其余的帧（状态、工具、审批、结算）立刻发布。

**匀速显现**（`core/pacedText.ts`）。正在生成的回复，新到的文字约 180ms 内匀速露出。

- 落后超过 1,200 字、页面在后台、减弱动效或连接断开时直接显示全部；未闭合的代码围栏里按整行露出；不切开代理对。页面打开时已在途的回复不重放。
- 只影响画出来的时刻：消息文字、消息 ID、复制的内容与阅读位置的计算都用原文，回复结束后画的就是原文。

## Markdown、代码与安全边界

源码：[MessageContent.tsx](../apps/web/src/MessageContent.tsx)、[DiffView.tsx](../apps/web/src/components/DiffView.tsx)、[highlightScheduler.ts](../apps/web/src/preview/highlightScheduler.ts)。显示规则见 [DESIGN.md](./DESIGN.md#流式与阅读)。

**安全边界。**

- 消息里的 Markdown 不执行原始 HTML：`literalHtml` 把它换成文字（句中）或 HTML 代码块（成块），`<br>` 换成换行，注释省略，`<details>` 与 `<summary>` 只留其中的文字。文字不丢失。
- URL 只允许安全协议，图片不加载。
- Mermaid 围栏与块数学必须实际闭合才交给各自的安全渲染器；取消或失败不替未闭合的内容补围栏，未闭合时保留代码。
- 脚注 ID 按消息隔离。

**流式解析。**

- 回复到达时，只在空行之后已出现独立新块的位置切分，缓存前面没有改变的解析结果与元素；不凭结尾的空行认定前一块结束。引用定义、脚注、HTML、引用容器、块数学等不确定的上下文仍整段解析。
- 只补当前尾块的行内强调、代码与未完成链接的显示；尚未收到有效分隔行的管道表头暂时显示文字。补全不改消息原文，复制与保存用原文。
- 中文正文里，`的**“重点”**是` 会将引号和其中的文字加粗。流式输出和结束后的加粗范围一致，复制保留原始 Markdown。
- 结束时对原文完整解析一次，保持相同的节点位置，保留代码的展开、焦点与已有的表格行。
- 回复先把代码外成对的 TeX 转义定界符换成美元符号。传给 Markdown 的字符串没有字面美元符号时不登记数学语法；深度限制、原始 HTML 与链接检查照常执行。
- 回复还在生成时回合脚部已可复制当前收到的原始 Markdown；结算用量、重试与分叉在结束后才出现，复制控件与消息节点保持不变。

**复制。** 都经 `@latch/ui` 的 `writeClipboard`：先用 Clipboard API，没有它（HTTP 局域网）或被拒时用隐藏文本框与 `execCommand('copy')`，两种都失败才说复制不可用，不显示虚假的成功。桌面端的权限处理只管异步 Clipboard API：`clipboard-sanitized-write` 只准本窗口来源的顶层页，另一台电脑的页还要 5 秒内的真实点按或按键；读剪贴板一律拒绝。`execCommand('copy')` 不经这些处理。

**代码着色的上限。**

- 代码块在共享 worker 里着色。整块超过 200 KB 时保留纯文本，超过 1,000 字符的单行只有这一行保留纯文本。超过 18 行的块可展开与收起；收起的已闭合块只把前 19 行渲染成 token，其余仍是文本，可以查找和选择。
- 工具声明为读取且已完成的调用，输出按读取的文件名着色：可能含密钥的文件名不着色，Agent 加的行号与外层标记留在语法之外，至多着色 1,000 行或 20,000 个片段。运行中、失败的调用与命令输出保持纯文本。
- 着色不改字重，所以不改变换行与阅读位置。

**调度。**

- worker 串行：只有一项在途，其余在栈里等，最新的先出，取消的直接出栈。
- 已结算的块接近视口（滚动容器上下 800 px，[viewportGate.ts](../apps/web/src/preview/viewportGate.ts)）时才请求，且不等待；只有文本还在变时才防抖 300 ms。缓存命中在同一次渲染显示。
- 看门狗只针对在途项（新 worker 的第一项给 30 秒）：超时时销毁 worker，其余任务留在栈里，超时项放到栈底再试一次并给四倍时限，再超时才记入负缓存。
- worker 连续崩溃三次时放弃等待中的任务，下一次请求重新开始。

**未闭合的围栏逐行着色。**

- worker 按块保留 `grammarState`，只分词新完成的行；每块只有一个请求在途。最后一行可能还会变，保持纯文本。
- 文本不再是已分词内容的延长时从头开始；worker 已不持有该块时回答 `restart`。已完成的行有稳定的 DOM 节点。
- 超过 18 行的未闭合块只渲染最新 17 行，总高度与闭合后相同，不写滚动位置。被收起的行不在 DOM 里，也就不在会话内查找的范围内，展开或闭合后恢复；复制取原文。
- 会话内查找把代码块当成一段文本，匹配可以跨 token；着色替换文本节点后重新定位，不移动阅读位置。

**不重绘其他轮次。** `stableTurns` 把数据相同的轮次保留为同一个对象（逐字段比较，不漏掉新字段），只有最新一轮看到 detail。运行开始或结算时，历史消息的编辑入口读会话的运行状态，正文继续复用。

## 插件的会话面板

页面与桥见 [APP-PAGES.md](./APP-PAGES.md)，面板的作者面见 [PLUGIN-DEVELOPMENT.md](./PLUGIN-DEVELOPMENT.md)。与状态一致性有关的规则：

- 面板来自 Host 的 `catalog.uiPanels`，没有这个字段时不显示插件标签。
- 数据面板的异步响应按包、面板、会话、运行与重试序号归属；切换会话或卸载时中止读取，迟到的响应不能替换新内容。读取租约保留到 Host 的回调实际结算。
- 客户端不按流式 token 请求面板数据，只在会话运行状态改变或明确刷新时重读。
- React 模块按内容摘要加载，组件在切换会话、离开页签与停用包时卸载；`readData` 的请求随组件寿命取消，卸载后的 `compose` 回调不改新会话的草稿。
- 「写入对话」只追加草稿，不发起运行；发送仍经 `useSubmission`，由它持久化待发送内容、保留结果未知并复用原 `requestId`。
- Standard 的技能指令在每轮开始时与输入一起持久化，同轮的流式步骤固定用这份正文。插件替换不改已开始的一轮，下一轮从当前启用的集合重新组装。

## 继续开发时的验证入口

命令、按改动选择回归与事件流的定向用例见 [TESTING.md](TESTING.md#按改动选择回归)，共享向量见 [TESTING.md](TESTING.md#共享向量)。那里没有列出的：

| 改动 | 用例 |
| --- | --- |
| 版本门禁与来源优先级 | `apps/web/test/projection.test.ts` |
| 工作过程的行、流式渲染与思考的收起 | `e2e/stream-render.e2e.ts` |
| Markdown、差异与危险内容 | `apps/web/test/message-content.test.ts`、`client-diff.test.ts`、`client-export.test.ts` |

流式性能的测量默认跳过，见 [TESTING.md](TESTING.md#性能测量)。
