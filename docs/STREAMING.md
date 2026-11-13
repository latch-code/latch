---
description: 流式执行与阅读界面：三段链路、Host 的状态流、客户端的事件流与版本门禁、消息身份、审批与取消、时间与用量、阅读位置、Markdown 与代码渲染。
sources:
  - packages/core/src/runtime.ts
  - packages/core/src/store.ts
  - packages/sdk/src/bridge.ts
  - packages/protocol/src/types.ts
  - packages/harness-acp/src/mapping.ts
  - packages/harness-acp/src/runtime.ts
  - packages/core/src/node-kit/timing.ts
  - apps/host/src/server.ts
  - apps/host/src/hub.ts
  - apps/host/src/run-silence.ts
  - apps/host/src/session-meta.ts
  - apps/host/src/traffic.ts
  - apps/web/src/core
  - apps/web/src/components
  - apps/web/src/conversation.ts
  - apps/web/src/MessageContent.tsx
  - apps/desktop/src/proxy.cjs
---
# Latch 流式执行与阅读界面

本文件描述当前源码的实现，是传输、消息投影、重连、审批决定和阅读位置的单一机制参考。核心架构与持久化保证见 [ARCHITECTURE.md](./ARCHITECTURE.md)，扩展契约见 [PLUGIN-DEVELOPMENT.md](./PLUGIN-DEVELOPMENT.md)，ACP Agent 的事件映射见 [HARNESSES.md](./HARNESSES.md)，界面表现见 [DESIGN.md](./DESIGN.md)。

## 三段链路

原生连接设置使用持久请求编号与配置哈希确认结果，页面重试原始内容，超时不生成新编号。设备原生访问状态由 Host 判定；手机当前快照的正文期限只属于当前连接，Mac 管理列表可展示当前 App 打开代次的有效期限。

原生业务 SSE 在 Host 运行代次内使用独立连续序号，保留真实发布状态的有界重放日志，数量与字节分别封顶。它和界面批次 revision 分开：一个批次可有多个不同事件，列表快照更新也不能确认尚未应用的会话正文。客户端只在应用事件后推进选中流游标，换网后在同样的设备与正文窗口校验下接续；淘汰或重启明确要求快照/详情同步。浏览器的现有 revision SSE 保持兼容。

Swift `NativeWorkspace` 将最多 16 个流的已应用 epoch/sequence/revision 加密保存，列表与各会话分别确认；`heartbeat` 和 `resumed` 的注释尾帧也携带游标。`accepts` 不推进进度，调用者应用状态后再 `acknowledge`；确认前复核流的连接代次和正文 lease。窗口过期、旧连接迟到或其他选中会话的事件不确认；缓冲溢出只清除该流的恢复游标并要求 checkpoint，不撤销登记身份。

```text
Provider.stream             Standard Runtime             Host                   浏览器
  text 增量 ──────────────> 累计 liveText / 固定消息 ID
                             notify(sessionId) ────────> 约 40ms 合并
                                                       detail(sessionId)
                                                       task-state 全状态 ───> 版本检查后替换
  finish ─────────────────> 持久化最终消息、工具队列
                             notify(sessionId) ────────> task-state 全状态 ───> 同一消息行结算
  工具/审批/取消结算 ──────> 更新真实状态 ──────────────> 同上

  连接重新打开：浏览器 GET snapshot → GET 当前 detail → 版本检查 → 标记已连接
```

模型流与浏览器状态流的协议不同。Provider 的 `text` 与 `reasoning` 是新增片段；浏览器接收的是带累计正文与思考的完整 `TaskDetail`，不是逐 token 追加事件。工具执行目前返回一次 `{ text }` 结果，没有通用 stdout 流或百分比进度 SDK。

## Host 的状态流

源码：[server.ts](../apps/host/src/server.ts)、[hub.ts](../apps/host/src/hub.ts)、[bridge.ts](../packages/sdk/src/bridge.ts)、[types.ts](../packages/protocol/src/types.ts)。多个 Harness 的变化通知先经 HarnessHub 汇合，再进入下面的合并流程。

客户端用 `GET /link/api/events?sessionId=<当前任务>` 订阅，凭据与其他 API 请求相同（浏览器为设备 Cookie，桌面端由主进程附加），设备需要「查看」权限。Host 打开流后先发送一个 `refresh`。不传 sessionId 时只接收整体或列表变化，不接收其他任务正文。这里的“仅选中任务”是订阅与带宽策略，不是任务级权限控制；任何有「查看」权限的设备都可以读取此 Host 的全部任务。

`Bridge.subscribe` 的通知进入待处理集合。Host 自首次待发通知起等待约 40ms，将同一任务的多次变化合并；一轮读取尚未完成时不并发执行另一轮，期间新增通知安排下一轮。该间隔不是严格帧率，也不保证每个中间状态都会发送。

| SSE 事件 | 发送条件 | 客户端动作 |
| --- | --- | --- |
| `task-state` | 某任务变化，且此连接选中了该任务 | 校验事件和版本，替换当前 detail；同时合并该任务的摘要和审批 |
| `tasks-invalidated` | 未选中的任务摘要或审批变化。私有会话（Agent、通用、接入、定时与 `agentPrivate`）的这一帧不发给数据范围不是 `all` 的设备，连不带 ID 的提示也不发（否则能看出私有会话何时有动静）；原生回放同样按读者略过，原生游标只看先后，序号留下空缺没有关系 | HTTP 只同步 snapshot；不逐 token 拉取当前 detail |
| `refresh` | 设备、配置等整体变化（含 Harness 的版本检测结果变化），流刚打开，或读取任务失败后的回退 | HTTP 同步 snapshot 与选中 detail |
| `host-state` | Host 宣布它即将不再应答：`stopping`（Host 关闭时，每条流的最后一帧）或 `sleeping`（电脑即将睡眠）；以及电脑醒来后的 `awake` | 见下文「Host 宣布的停止与睡眠」 |
| `app.data` | 插件页面的一个文档变了：`{ type, instanceId, pluginId, scope, key, version }`（删除时 `version` 为 0）；只发给能读那个作用域的连接，私有会话的文档只给数据范围 `all` 的设备 | 打开着该插件页面的客户端只把本插件、页面声明过的作用域的变化经桥转给页面（`storage.onChange`），页面自己决定是否重读；不参与 revision 顺序，不带 SSE `id`（[APP-PAGES.md](./APP-PAGES.md#存储)） |
| `app.updated` | 插件的已应用页面变了（应用、回退、启停、删除）：`{ type, instanceId, pluginId }`，发给每条仍被接受的流 | 客户端重读快照；快照里页面的修订或 `bundleHash` 变了，打开着的框带着 `view` 状态重建；不参与 revision 顺序，不带 SSE `id`（[APP-PAGES.md](./APP-PAGES.md#桥)） |

`task-state` 形状如下，正文省略：

```ts
{
  type: 'task-state',
  instanceId: string,
  revision: number,
  sessionId: string,
  hostTime?: string,
  detail: {
    summary, messages, approvals, liveText, cursor,
    activity?, liveMessageId?, liveReasoning?, liveReasoningStartedAt?, liveReasoningMs?,
    runStartedAt?, runWaitMs?, runWaitingSince?, lastOutputAt?, usageReport?,
    plan?, config?, permission?,
    sync: { instanceId, revision, hostTime? }
  }
}
```

`hostTime` 是 Host 发出这一帧时自己的时钟（ISO 时间），同时写在事件与 `detail.sync` 上；快照（`GET /link/api/snapshot`）也带 `hostTime`。`GET` 单个会话的 detail 不带它，所以两台设备同时读到的 detail 仍完全相同。时间字段的含义见下文「时间与用量」。

每个实例生成一个 `instanceId`，每次通知递增内存 `revision`。合并会跳过中间 revision，同一轮不同任务可以共享一个传输 revision；它不是连续增量日志。每帧的 SSE `id` 就是这个 revision，客户端不使用它。`TaskDetail.cursor` 则是 Driver 的状态版本，Standard 中随持久提交增加，不能用于区分每个内存文本片段。

每条连接保存 `lastSentRevision`，丢弃比它更旧的待发事件，避免慢外部 Bridge 的旧 flush 在新订阅建立后倒序送达。同 revision 的不同事件仍允许发送。

`host-state` 不参与 revision 顺序，也不带 SSE `id`，形状为 `{ type: 'host-state', instanceId, state: 'stopping' | 'sleeping' | 'awake', reason?: 'restart' | 'update' | 'sleep' | 'shutdown', retryAfter?: 秒, at }`；`stopping` 与 `sleeping` 必带原因与 `retryAfter`。谁报告、各原因的默认 `retryAfter` 见 [ARCHITECTURE.md](./ARCHITECTURE.md)「Host 的生命周期」。Host 关闭时先向每条仍被接受的流写出 `stopping`，再结束这些流，最多等 0.5 秒让最后一帧发出；`awake` 之后另发一次 `refresh`。

某个会话的 detail 读取失败时，本轮只向各连接发送一次 `refresh`。Host 每 15 秒发送注释心跳。每次推送与心跳前，Host 检查打开该流的凭据是否仍会被接受，不再被接受时结束该流。若连接已积压超过 256 KiB，断开该慢连接，让客户端重新同步。这是积压保护，不是单个事件或总内存的硬上限。每个 task-state 仍包含该任务完整 messages 与累计 liveText，负载会随会话历史增长；40ms 合并减少发送次数，并没有消除长历史的序列化和带宽成本。同一轮发给多条连接的 task-state 只序列化一次。

### 流量计数

Host 从启动起计数自己发出的字节（[traffic.ts](../apps/host/src/traffic.ts)），作为以后改进同步方式时的基线，只在内存中，重启清零：

- **计什么。** 事件流每一帧写出的文本（`task-state`、`tasks-invalidated`、`refresh`、`host-state`、`app.data`、`app.updated` 与心跳），以及客户端重新同步时读取的快照（`GET /snapshot`）与会话详情（`GET /tasks/:id`）的响应体。HTTP 头、分块编码与 TLS 记录不计入：同一份内容经 TLS 发出时，线上字节还要多出记录头与握手。
- **怎么分。** 每一类有次数、字节数与大小分布（≤256 B、1、4、16、64、256 KiB、1、4 MiB 与更大，共 9 档）；每个会话有点名它的帧（`task-state`、`tasks-invalidated`，所有连接合计）与它的详情响应；每条事件流有入口类别、打开与关闭时间、帧数（含心跳）、字节数与心跳数。会话最多保留 1000 个（最近计入的），已关闭的事件流保留最近 100 条。
- **只有数字。** 计数只含次数、字节、时间、入口类别、Host 内的连接序号与会话 ID，不含正文、标题、设备 ID 或设备名。
- **谁能看。** `GET /link/api/traffic` 只读，需要 `admin`，或 `host.sock` 上的匿名命令行；`pnpm latch traffic` 打印摘要（`--json` 打印原样）。

## 客户端：事件流、凭据与版本门禁

设置切换的未知结果按会话保留原始请求；模型菜单、思考控件和输入框的「⋯」共用同一道写入门禁。未知时输入框上方写出所选的值、时间、「结果未知」、「核对」与「重试同一请求」，不出红色横幅；核对请 Host 向 Agent 读取当前设置后结算（Agent 忙、读不到或读到第三个值时仍未知），重试同一请求只得到回执，两者都不再发送修改；结算后再选用新的请求编号。核对没能结算之后可以「放弃这次结果」：只在这个页面上放下，Host 的回执不变，原请求编号不再发送。旧 Host 没有核对时只查回执；没有配置回执时，只有真实配置已经读回目标值才解除未知状态，不能把一个仍旧的值当成失败。项目目录失效的确定拒绝则由项目恢复面板承接，保留可编辑草稿；结果未知时不能转成一次新的分叉。实现见 [模型配置](./MODEL-CONFIGURATION.md) 与 [项目恢复](./WORKSPACE-RECOVERY.md)。

未发送的文字按设备与会话（新会话也算一份）存在本机浏览器存储 `latch.drafts.<origin>.<deviceId>`，刷新或重启后还在；桌面端用同一页面。只存文字，附件与文件引用只在内存。打开中的输入框稍后写入，离开页面时立即写入；同一设备的多个窗口只写自己改过的草稿。私有会话的草稿，以及含项目文件摘录（引用）的草稿，带私有标记，设备不再能读私有内容时移除。含 Host 日志会遮去的任何内容（凭据本身，以及 Cookie、设备请求头、`?token=`、URL 里的 `user:pass@`；`@latch/protocol` 的 `looksSecret`，与 `redactSecrets` 同一组规则）的草稿只在内存，不提示。数据范围不是 `all` 时，私有与含摘录的草稿在每次写入时都不存。重新发送的旧消息（`resent`）送达或被拒都不动输入框里的文字、附件与文件引用。14 天没有改动的草稿在下次加载时丢弃。删除会话时清除：在这里删除、打开中的会话被 Host 报告已删除，或一次完整的列表（快照的 `tasksComplete`，按配置而不只按已挂载的判断，见 [ATTACHMENTS.md](ATTACHMENTS.md)）在这台能看见全部会话的设备上不再有它；打开中的会话答 404 `task-not-found` 时，也只在同一次快照完整时才算删除，Harness 停用或重新挂载期间保持选中；列出失败、只列出一部分、已归档或因范围与私有被隐藏都不算删除。撤权与退出时立即清除：页面一收到不再被接受的回答，就删掉这个来源下所有设备的草稿，并写下共享的退出标记，所有窗口之后都不再写入；页面加载时只留下当前设备的。存储不可用时只在内存。提交捕获当前会话或新会话草稿的选择代次。同一页面中的重试按原请求编号保留首次来源，卸载后失效。回执到达前切换过会话时，只结算原请求，不自动选回原会话、清空当前输入或修改当前分叉。普通发送消费原会话的草稿；重新发送旧消息不消费草稿。当前会话被另一设备删除时，选择清空也同时清除对应活动草稿。刷新恢复未知结果时，只有原目标匹配当前输入才恢复文字；其余只恢复原请求卡片和编号。

源码：[useHarness.ts](../apps/web/src/core/useHarness.ts)、[eventStream.ts](../apps/web/src/core/eventStream.ts)、[credentials.ts](../apps/web/src/core/credentials.ts)、[api.ts](../apps/web/src/core/api.ts)、[projection.ts](../apps/web/src/core/projection.ts)。

创建 Agent 的未知请求独立于消息草稿，沿用创建控制器与原请求编号；跨窗口先取得 Web Lock，再核对同一记录。创建、草稿与 Slash 最近项共用当前设备归属，换设备后旧句柄不能重新落盘。创建正文的私有权限、敏感内容只留内存、存储故障与明确放弃规则见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#创建的待确认请求)。

### 基于 fetch 的事件流

客户端不使用 `EventSource`：`eventStream.ts` 用 `fetch(url, { credentials: 'same-origin', cache: 'no-store' })` 读取同一个 `text/event-stream` 响应，自带解析器处理 CR、LF、CRLF（包括跨数据块的行尾）、多行 `data`、`event`、`id`、注释与字节序标记。这样能看到 HTTP 状态：`401` 不会被当作“断线后无限重试”，而是交给认证处理；桌面端的事件流也经过主进程转发，与其他 API 请求一样。

| 情况 | 行为 |
| --- | --- |
| 响应 2xx | 触发 open，之后逐帧派发 `refresh`、`tasks-invalidated`、`task-state`、`host-state` |
| 连接失败、非 2xx、流结束，或 45 秒没有收到任何字节（含等待响应头的时间；Host 每 15 秒发心跳） | 视为断线，按 1、2、4、8 秒退避，之后每 15 秒重连；浏览器重新联网，或页面重新可见且在线时，跳过剩余等待立即重连 |
| 浏览器 offline | 断开事件流、取消在途 HTTP，并停止重连，直到浏览器重新联网或页面重新可见且在线 |
| `401 renewal-required` | 先续期凭据；续期成功后立即重连一次。续期失败、正在等待下一次续期（桌面端页面从不自己续期），或续期后流打开前 Host 仍要求续期，都按退避重连 |
| 其他 `401` | 按退避重试；每次断线后的快照同步决定进入连接页还是只是暂时失败，页面离开工作区时关闭事件流 |
| `deferReconnect(ms)` | 放下当前连接，此后每次重连前至少等待 `ms`（与退避取较大者），直到下一条流打开为止 |

事件流 open 不直接标记“已连接”：先完成 HTTP snapshot/detail 同步，确认选择仍有效、事件流仍打开且浏览器在线，`.app-shell` 的 `data-connection` 才变为 `connected`；其他取值为 `connecting`、`reconnecting`、`offline`。网络错误显示重连中；浏览器 offline 时保留已读内容，显示离线。online 或页面重新可见时再同步。`refresh` 与 `tasks-invalidated` 只有在 `instanceId` 与当前 Host 相同且 revision 新于当前 snapshot 时才触发同步；`instanceId` 不同则立即重新同步并重新绑定。

重新建立状态的同步（首次加载与连接页的「重试」、事件流每次打开、重新联网或页面重新可见、续期之后、任一请求发现凭据失效之后、断线时的同步，以及用户点「同步最新状态」、连接状态或横幅里的「重试」时的 `resync`）发布快照时，`useHarness` 的 `resyncs` 加一；跟随变化的同步（`refresh` 与 `tasks-invalidated` 事件、`task-state` 推送、用户操作之后的 `refresh`、选择会话）不加，排在一起的请求只要有一个是重新建立就算重新建立。工作区把 `resyncs` 作为外壳（侧栏与图标栏）的纪元交给 `LiveChanges`，对话区与会话详情的纪元另加打开的会话：计数的淡入、会话行状态的交叉淡化、工具卡的状态过渡这类一次性过渡只为同一纪元里的变化播放，首次加载与重连后的快照同步直接显示新值，切换会话时对话区也直接显示；会话列表跨会话存在，所以打开一个未读会话时它那一行的对勾照常淡出、时间淡入（[DESIGN.md](./DESIGN.md)「界面原语」）。

凭据失效时事件流结束，客户端重连；消息内容按不可信文本显示。

### Host 宣布的停止与睡眠

收到实例与当前 Host 相同、形状正确的 `stopping` 或 `sleeping`（[hostState.ts](../apps/web/src/core/hostState.ts) 校验）时，页面记下这条通告，连接状态变为 `reconnecting`，并以 `retryAfter` 调用 `deferReconnect`：Host 已说明暂时不会应答，所以页面不按 1 秒起的退避猜测，也不在断线时立即请求快照；浏览器重新联网或页面重新可见时照常立即重连一次。横幅标题按通告给出原因与开始时间，替代「连不上 <电脑>，正在重连…」：`sleeping` 为「电脑已休眠（22:41 起）」，`restart` 为「电脑上的 Latch 正在重启」，`update` 为「电脑上的 Latch 正在更新」，`shutdown` 为「电脑上的 Latch 已停止（21:03 起）」。重连后的快照同步成功、页面标为 `connected` 时清除通告；收到 `awake` 时清除通告并立即同步。只有连接失败才按通告等待：重连得到 `401` 说明 Host 已经在应答，续期不能解决时页面清除通告，照常请求快照，由快照决定进入连接页（设备被撤销、凭据过期等）还是显示暂时故障，不会停在过时的「电脑已休眠」上。实例不同的通告被忽略。没有通告时横幅只说页面知道的：浏览器报告没有网络（`navigator.onLine` 为假）时写「这台设备没有联网」；Host 以 5xx 应答时写「<电脑> 上的 Latch 出错（HTTP 503）」；Host 以其他错误拒绝时写它自己的原因；请求没有得到应答时写「连不上 <电脑>，正在重连…」，没有第二行，不猜原因。桌面端页面另外显示主进程对 Host 的判断（正在重启、反复崩溃后停止自动重启、已停止、没有响应），Host 停止或反复崩溃后横幅给出「启动 Host」。

### 失败的说法与旧 Host

页面上的失败只按页面知道的说（`errorMessage`，[api.ts](../apps/web/src/core/api.ts)）：Host 的错误与页面写给人的文字（`ClientError`、`MessageError`；`pnpm lint` 让 apps/web/src 里的 `new Error` 只带 ASCII 字面量的内部代码）照原文；fetch 本身失败（请求或答复没有到达；请求头不合法这类页面自己的错误在发出前就抛出，不算）在 `api()` 里变成 `NoAnswerError`，写「连不上 <电脑> 上的 Latch」；复制失败写「复制不可用，请手动选择」；其余都是页面自己的错误，写「页面出错了（<错误名>）· 刷新」，并把错误与调用栈打印到控制台一次，不上报。不把页面的错误说成网络问题。

每次构建页面生成构建号（UTC 构建时间加随机部分）：页面带着它，`dist/web/build.json` 记下它。Host 启动时读一次所在页面目录的 `build.json`，在快照的 `build` 里报告。页面的构建号比 Host 报告的新，或 Host 没有报告时（早于这项的 Host），显示一条琥珀提示「<电脑> 上的 Latch 还是旧版本」与「重启 Latch 后才能用新功能」，ⓘ 里写停止、需要时 `pnpm latch presence repin`、再启动。只有桌面端那台 Mac 的窗口给出「重启 Latch」（主进程的 `restartHost`）。比 Host 旧的页面（重启前打开的标签）不提示；开发服务器与测试里的页面没有构建号。页面不为旧 Host 写降级。iOS 尚未比较构建号。

### 桌面端的转发与流

桌面端页面加载自 `latch://app/link/`。`latch` 协议注册为支持 fetch 与流式响应，主进程（[proxy.cjs](../apps/desktop/src/proxy.cjs)）把请求经本机 `host.sock` 转发并附加设备凭据，响应体以流的形式回传；页面关闭或取消读取时主进程断开上游连接。因此桌面端与浏览器使用同一份事件流代码。

### 版本门禁

浏览器通过 `ProjectionGuard` 检查三件事：

1. **选择代次**：切换会话、绑定新的 Host 实例或使旧请求失效时，更新 generation。旧 HTTP 请求和旧事件流不能覆盖新选择。
2. **实例**：SSE/detail 的 sync.instanceId 必须等于当前 HTTP 确认的 Host。重启后的状态不能与旧实例混合。
3. **版本与来源**：同一选择中，低于已接受 revision 的 detail 被丢弃。相同 revision 时 stream 优先于 HTTP：流可以更新此前的 HTTP 正文，迟到 HTTP 和重复 stream 都不能覆盖已接受的流正文。已经接受带版本状态后，不再接受无版本 detail 回退。

切换会话会取消待处理 HTTP、清除当前 detail、重建带新 sessionId 的事件流。事件 JSON 至少验证事件类型、版本、session ID 与正文的基本形状；它不是对外提供的通用不可信 JSON 导入器。设备被撤销、登记满 30 天或凭据属于别的访问地址时，页面清除任务内容并进入连接页。

snapshot 与 task-state 可能交错。摘要与审批只在 detail.revision 大于或等于 snapshot.revision 时由选中 detail 覆盖；更旧 detail 不得覆盖较新的 snapshot。这个列表合并规则与上述正文来源优先级分开处理，不会把一个任务的 detail 替换到另一个任务上。

**当前没有 WAL、持久事件队列、Last-Event-ID 历史重放或逐事件缺口恢复。** 断线后通过当前快照收敛，不保证客户端看过所有短暂中间状态。SSE 关闭只移除订阅，不取消 run。创建/输入的幂等回执另由 Runtime 持久化，审批决定与取消的回执由 Host 随会话保存（见下文）；浏览器保存的待确认提交用于显式重试，不是自动离线任务队列。这条记录只有一条：输入框为它锁定；「未确认送达」和重试只显示在它所属的会话或新会话，其他会话写「另一个会话有消息未确认送达」并给「打开」与「放弃这次提交」。记录同时带着正在等待的确认票据（`awaitingConfirmation`）时，内容还没有发出：重新打开页面会取消这张票据（系统表单随之关闭），把文字放回输入框，不显示未确认送达。同一设备的另一个窗口结算后，经 `storage` 事件清除这一行。

## 消息、审批与取消

源码：[runtime.ts](../packages/core/src/runtime.ts)、[Transcript.tsx](../apps/web/src/components/Transcript.tsx)、[ToolCard.tsx](../apps/web/src/components/ToolCard.tsx)、[MessageRow.tsx](../apps/web/src/components/MessageRow.tsx)、[approvalDecision.ts](../apps/web/src/core/approvalDecision.ts)、[confirmations.ts](../apps/web/src/core/confirmations.ts)。

- 每次模型调用在收到文字前创建 `liveMessageId`。文字只更新内存里的累计 `liveText`，思考更新 `liveReasoning`；正常完成或异常保留部分内容时，最终 assistant 消息沿用该 ID，思考保存在其 `reasoning` 中。Harness 说这条回复中途断开、从头重新生成时（Gemini CLI 的重试，见 [HARNESSES.md](HARNESSES.md#通知与压缩)），`liveText` 清空后重新累计，ID 不变。detail 不同时暴露同 ID 的 live 与已提交消息。
- React 按 message.id 渲染，并为消息行设置 `data-message-id`。消息组件比较 ID、正文、状态和角色等字段，未变化的历史行不因每次状态替换而重渲染。
- 收到完整模型终止事件后，先持久化助手文字和工具批次，再串行执行工具。工具消息使用 `tool:<callId>`，按 `queued → awaiting-approval（若需要）→ running → completed/failed/cancelled` 更新同一行。拒绝不会经过 running。
- 审批显示在输入框上方的抽屉里，不进入对话；携带 `toolCallId` 时用 `tool:<toolCallId>` 工具行的文字与差异。审批按钮来自 `Approval.options`，缺省为允许与拒绝；当前设备能看到哪些按钮由风险等级与设备权限决定（见 [DESIGN.md](./DESIGN.md)）。工具行默认收起（带输出的失败自己展开），展开后显示参数、文件差异与纯文本输出（第一次展开时才渲染）；收起时文件差异作为证据显示在行下。
- 客户端把消息按回合分组（一条用户消息与回答它的一切，[conversation.ts](../apps/web/src/conversation.ts)），只是排列方式：每一行仍按 message.id 渲染、带 `data-message-id`。正常完成的回合把答案前的过程折叠成一行时，被折叠的行仍挂载在 `hidden="until-found"` 的容器里，文档里行的顺序与身份不变。
- `activity` 表达当前 `starting / model / tool / approval / cancelling`，用于区分正在启动 Agent（进程与会话在准备，还没有发出提示；已有会话的下一条在恢复会话期间还没有记录，摘要也投影为 `running` 与 `starting`，带这一轮新的 `runId`（不带上一轮的 `runOutcome`、`runEnd`），所以按它停止能停到这一轮；这时停止会把这条记为已发送、在送到 Agent 之前停止的一轮）、等待模型、执行工具、等待用户和取消中；`since` 是这个阶段开始的时间，只在阶段变化时更新。它不代表百分比进度。`plan` 为 Harness 报告的最新计划（整体替换）；`config` 为 Harness 允许修改的会话选项。
- 审批认领在异步等待前完成，重复或迟到的决定失败；同一审批的决定在 Host 上串行处理。取消会请求 Provider/工具中止，等待实际结束与状态提交；如果仅网络请求失败，UI 不能宣称已取消。
- 每次运行（创建或一次输入触发）有自己的 `TaskSummary.runId`，由 Driver 在运行开始时写入会话并持久化；取消用它指明要停止哪一次运行（见下文）。不记录运行的外部 Driver 不提供它。
- 模型流截断或取消会尽量保留已经收到的正文，并标记失败或已停止。崩溃前尚未结算的内存文字仍可能丢失。中断的工具结果可能未知，不会自动重放或自动回滚。

Provider 不能在 finish 后继续发送内容，缺少 finish 也视为失败；Standard 不会派发该次未确认的工具调用。普通 chat 模式遇到工具调用会明确失败，而非执行后隐藏记录。

### 审批决定的请求 ID 与回执

`POST /link/api/approvals/:id` 的请求体为 `{ decision, optionId?, requestId?, note? }`（`note` 是拒绝时「告诉 Harness 改做什么」的说明，同一说明的重试用同一个 `requestId`，换一句说明算换一个选择）。浏览器总是带上 `requestId`：为每个审批上的每个选择生成一个（`DecisionRequests`），同一页面同一审批同时只发出一个决定：

- **结果未知时重用。** 网络错误、超时（15 秒）、408 或 5xx 时，结果未知，`requestId` 保留，审批卡里出现「结果未知」与「重试」，说明可以重试同一选择、不会重复提交；「重试」或再按同一个按钮都重发同一请求。审批从快照里消失（已由某台设备结算）时，这条提示随之去掉。明确的 5xx 拒绝（见下文「确定的拒绝」）与其他明确回答之后，`requestId` 丢弃。换一个选择总是使用新的 `requestId`。
- **回执。** Host 接受后返回 `{ accepted: true, receipt: { approvalId, decision, optionId?, at } }`。同一设备用同一 `requestId` 重发时返回原回执并带 `replay: true`，不会再次决定或审计。
- **已被处理。** 其他情况下，已经处理或已失效的审批返回 `409 approval-settled`，`decidedBy` 为 `{ kind: 'device', self, deviceName, decision, optionKind, at }`，或 `{ kind: 'system' }`（会话结束或取消使其失效）。`deviceName` 是作出决定的设备当前的名称，Host 已不认识该设备时为空。客户端据此判断：本设备此前作出了同一决定（Host 给出 `optionKind` 时还要求选项类别相同）就视为已生效；本设备此前作了不同的选择时，提示本次选择未生效；由其他设备处理时提示「已由「设备名」处理」，设备名为空或不符合设备名称规则时只提示「该审批已结束」；`system` 同样提示「该审批已结束」。
- **随会话保存。** 决定记录（审批 ID、`requestId`、作出决定的设备 ID、决定与选项、时间）在回答之前写入数据目录的 `sessions-meta.json`，与该会话的标题、置顶等放在一起，所以 Host 重启后重试同一个 `requestId` 仍得到原回执（`replay: true`），其他设备仍得到 `decidedBy`。记录保留 7 天，每台设备最多 1 万条、合计最多 10 万条，最旧的先删除；删除会话时一并删除。写入失败时决定照常生效，记录留在内存中并进入下一次写入，日志记下失败。
- **决定不弹确认。** 允许与拒绝都由设备的权限范围决定，发出后等 Host 回执；结果未知时卡片可以用同一 `requestId` 重试。

### 取消的请求 ID 与回执

`POST /link/api/tasks/:id/cancel` 的请求体为 `{ requestId?, runId? }`，两项都可选，所以加入它们之前载入的页面仍能停止运行。页面总是带上 `requestId`，并带上它显示的那次运行的 `runId`（会话摘要有时）：同一会话同一次运行的停止在结果未知（网络错误、超时、408 或 5xx）时重用同一个 `requestId`，明确回答之后丢弃；运行变了就用新的（[cancelRequest.ts](../apps/web/src/core/cancelRequest.ts)）。

- **只停止指名的运行。** `runId` 与会话当前的运行不同（那次运行已经结束，之后又开始了新的一轮）时，Host 不停止任何东西，回答 `ended` 且不带 `status`；相同但已经结束时回答 `ended` 与它结束时的状态。指名的运行仍在进行时（Driver 列不出该会话、Host 无从判断时也一样），Host 先审计 `task.cancelled`（detail 含 `runId`），再把 `runId` 交给 Driver：Driver 在开始取消的同一步核对它，所以审计期间结束、又开始的新一轮不会被停止。等运行真正结算后回答 `stopped` 与结算后的状态（通常是 `cancelled`；结算前刚好完成时是 `idle`）。不带 `runId` 的请求保持原来的含义：停止正在进行的运行，没有时回答 `ended`。
- **回执。** 回答为 `{ accepted: true, receipt: { sessionId, requestId?, runId?, outcome: 'stopped' | 'ended', status?, at } }`。带 `requestId` 的回执与审批决定一样随会话保存（同样的保留期限与上限，按会话、设备与 `requestId` 区分），同一设备在同一会话用同一 `requestId` 重试，包括 Host 重启之后（该会话的 Driver 未能挂载时也一样），都得到原回执并带 `replay: true`，不会再次审计或取消；同一个 `requestId` 换了 `runId` 返回 409 `request-conflict`。同一请求的两个副本同时到达时，后到的等前一个结算，得到同一份回执。
- **强制停止。** 回执还带着这次运行的 `runEnd`（见下文「运行的真实状态」）：停止没有在宽限期内结算、进程被结束时，`reason` 是 `forced-stop`，`unknownResultCount` 说明有几条命令结果未知。回执不带它们的名称：原生客户端在正文窗口之外也能取消，名称在会话详情的 `runEnd` 里。
- **页面的显示。** 回答 `ended` 时页面立即结束「正在停止」：带状态时提示「这一轮已经结束，无需停止」，不带时提示「要停止的那一轮已经结束，新的一轮仍在运行」。旧 Host 只回答 `{ accepted: true }`，页面照旧等待会话状态变化。

经 `api.ts` 发出的请求在 `429 rate-limited` 且 `retryAfter` 不超过 5 秒时自动等待并重试一次：被限速的请求没有执行，所以重试是安全的。

撤销之后的第一条用户消息，文字最前面带一段给 Agent 的说明（[CHANGES.md](CHANGES.md#撤销与丢弃)），消息文字就是实际发出的内容。

## 时间与用量

源码：[timing.ts](../packages/core/src/node-kit/timing.ts)、[runtime.ts](../packages/core/src/runtime.ts)、[runtime.ts](../packages/harness-acp/src/runtime.ts)、[hostClock.ts](../apps/web/src/core/hostClock.ts)、[conversation.ts](../apps/web/src/conversation.ts)。

界面上的每个时间与计数都来自 Host 的记录，客户端不估算；字段都是可选的，旧 Host、插件 Driver 与记录这些字段之前的历史没有它们，缺少时对应的部分不显示。时间是 Host 时钟的 ISO 字符串，由 `ServerOptions.clock`（默认 `Date.now`）给出，内置 Harness 与 ACP Driver 经 `HarnessHostOptions.clock` 用同一个时钟。

- **持久的。** 会话摘要的 `createdAt`。每条消息的 `createdAt`（用户消息被接受、助手一步开始、工具调用被记录、说明写入的时刻）；工具的 `startedAt`（审批之后真正开始运行）与 `completedAt`（结算）；助手一步的 `completedAt`、`reasoningMs`（从第一段推理到第一段正文或这一步结束）与回答它的 `model`（内置 Harness 另有 `providerId`）。开启一轮的用户消息在这一轮结算时得到 `turn`：`endedAt`、`activeMs`（从提示到结束，减去等待审批的时间）与 `waitMs`（至少有一个审批在等人的时间，多个审批重叠时按并集计），会话经 Latch 转发到模型服务时还有 `routed`（网关自己数的请求、模型与令牌，见 [HARNESSES.md](./HARNESSES.md) 的「每轮的模型与用量」）。Host 重启中断的一轮没有 `turn`。这些字段都写进各自存储的 zod schema。
- **运行中的投影。** 运行期间 detail 带 `runStartedAt`、`runWaitMs`（已结束的审批等待）与 `runWaitingSince`（有审批正在等待时），客户端据此算出不含等待的已运行时间，等待时停住；`lastOutputAt` 是可见输出最后一次变化（正文、推理、工具、计划、新消息），客户端用它说出「N 分钟没有新输出」；`liveReasoningStartedAt` 与正文开始后的 `liveReasoningMs` 给出正在流出的思考用时。
- **Host 时钟。** 客户端从快照与每个 `task-state` 的 `hostTime` 得到 Host 时钟与本机时钟的差，变化小于一秒视为网络抖动、不更新；所有活的计时（已运行、工具用时、思考秒数）都按 Host 时钟计算，所以手机时钟不准时各设备读到的仍一样。旧 Host 不发 `hostTime` 时差为零，运行时间退回为页面看到运行开始以来的时间。走秒由页面共享的一个计时器驱动，只有显示数值的叶子组件订阅，页面隐藏时停止。
- **用量。** 每一步的 `usage` 是 `inputTokens`（含缓存）与 `outputTokens`（含推理），模型服务报告时另有 `cacheReadTokens`、`cacheWriteTokens` 与 `reasoningTokens`；Host 与客户端合计多步时，某一部分只有每一步都报告了才保留，所以合计从不把「没报告」当成 0。ACP Agent 报告的 `usage_update`（当前上下文已用、窗口大小与费用）存为会话的 `usageReport`，只作为 Agent 的报告显示，不当作账单，也不从 tokens 推算。

## 运行的真实状态

源码：[run-silence.ts](../apps/host/src/run-silence.ts)、[hub.ts](../apps/host/src/hub.ts)、[runtime.ts](../packages/core/src/runtime.ts)、[runtime.ts](../packages/harness-acp/src/runtime.ts)、[sessions.ts](../packages/protocol/src/sessions.ts)。

已运行时间不代表进展。Host 记录每次运行最后一次有动静的时间，只说事实，**从不因为沉默而停止运行**。`catalog.features.runLiveness` 声明这些都可用；旧 Host 没有这些字段，旧客户端忽略它们。

**`TaskSummary.live`**（运行期间才有，只在内存，不持久化）：

| 字段 | 含义 |
| --- | --- |
| `runId` | 这次运行 |
| `activity` | `starting`（进程与会话在准备）、`model`（等模型）、`command`（命令在运行）、`tool`（其他工具在运行）、`approval`（等人）、`cancelling`（停止中，等执行端结算） |
| `commandName` | `command` 与 `tool` 时运行的是什么，只有一行，已脱敏；**只在会话详情里** |
| `since` | 这项活动开始的时间 |
| `runStartedAt`、`runWaitMs`、`runWaitingSince` | 整次运行开始的时间与等人的时间，和详情里的同名字段一致。`since` 随活动重新开始，整次运行的时钟读这三项；列表也带它们，它们不含正文 |
| `lastEventAt` | 最后的动静：Harness 为这个会话发来的任何东西（输出、工具更新、用量报告、请求），或一项活动的开始（比如审批刚被答复）。Agent 的 stderr 不算：它不属于任何一次运行 |
| `lastOutputAt` | 可见输出最后一次变化 |
| `silenceThresholdMs`、`silent` | Host 的判断，见下 |
| `unrecognized` | Harness 发来过 Latch 不认识的请求：`count` 与最新的 `at`，`at` 不早于 `lastEventAt` 表示之后再无动静；Harness 继续时列表重读一次，不随每个词重读；会话详情里另有 `method` 与记录它的系统消息 `messageId` |

Driver 报告除 `silenceThresholdMs`、`silent` 以外的各项，`silenceThresholdMs` 与 `silent` 只由 Host 计算，Driver 的说法会被丢弃。Standard 的 `lastEventAt` 随 Provider 的每个事件前进，工具的 `kind: 'execute'` 算命令，名称是工具的标题；ACP 的 `lastEventAt` 随该会话的每个 `session/update` 与请求前进，`kind: 'execute'` 算命令，名称优先取调用的 `rawInput.command`。ACP 同时运行几个调用时，一个结束后活动仍是还在运行的那个，不会说成在等模型。

**阈值与沉默。** 模型（含 `starting`）2 分钟，命令与工具 10 分钟；等人和停止中没有阈值。`silent` 表示 `lastEventAt` 距今超过阈值，每次读取时计算，所以不会读到过期的答案。

**没有周期开销。** Host 只有一个定时器，等最早到期的阈值，只在有运行可能越过阈值或正在沉默时存在，读的是 `Bridge.liveRuns()`（内存中的运行，不列全部会话）。越过时只发一次普通的会话变化（`task-state`，其他连接收到 `tasks-invalidated`）；沉默中的运行每 30 秒复查一次，因为 Driver 不必为每个动静都通知，复查发现它恢复时同样发一次变化；空闲的 Host 没有定时器。没有 `liveRuns` 的 Driver 仍在读取时算出沉默、可以继续等，但 Host 不主动宣布越过。客户端自己用 `lastEventAt` 与 Host 时钟算出「N 分钟」，不需要 Host 持续推送。`lastEventAt` 的变化本身不会让其他设备重读列表，只有活动、阈值、沉默或 `unrecognized` 的计数变化才会，所以列表中的 `lastEventAt` 可以落后于详情，判断沉默以 `silent` 为准；要比较 `unrecognized.at` 与 `lastEventAt` 看 Harness 是否继续了，也只在详情里比较。电脑从睡眠中醒来时，睡眠的时间也算沉默。

**列表不带正文。** 快照的 `live` 不含 `commandName`、`unrecognized.method` 与 `messageId`，因为原生客户端在正文窗口之外也能读列表。

**继续等。** `POST /link/api/tasks/:id/keep-waiting`，权限 `view`，请求体 `{ runId, thresholdMs }`，`thresholdMs` 是页面看到的阈值。回答 `{ accepted: true, outcome, thresholdMs? }`：

| `outcome` | 含义 |
| --- | --- |
| `extended` | 阈值翻倍，只对这次运行的这类活动（模型与命令各算各的）；如果下一次询问会在半个原阈值之内到来（页面放了很久才点），再翻一倍 |
| `unchanged` | 阈值已不是请求看到的那个：一次重试或另一台设备已经点过。所以它不需要 `requestId`，重试总是安全的 |
| `not-silent` | 现在并不沉默，或正在等人、停止中 |
| `ended` | 这次运行已不是活动的 |

阈值只在内存：Host 重启会中断运行，运行结束时一并丢弃。这个操作不授予任何权限，不写审计。

**`TaskSummary.runEnd`**（随会话持久化，新运行开始时清除）说明一次运行不是以普通回答结束的：

| `reason` | 含义 | 会话状态 |
| --- | --- | --- |
| `process-exited` | Harness 进程自己退出，或超出协议限制被结束 | `failed`（停止途中退出时为 `interrupted`） |
| `forced-stop` | 停止在 30 秒内没有结算，Latch 结束了进程 | `interrupted` |
| `host-stopped` | Host 在运行期间停止或重启（正常停止与崩溃后重启都算，不当作谁的取消） | `interrupted`，`runOutcome` 也是 `interrupted` |
| `turn-ended` | Harness 结束了这一轮，但有调用没有报告结果 | 按这一轮的结果 |

`host-stopped` 的这一轮另外留下一条系统消息「Latch 重启时中断。…」（`state: 'cancelled'`、`Message.interrupted`），不是失败；当时没有报告结果的工具行带 `interrupted`：开始过的是 `failed` 且输出含 `TOOL_OUTCOME_UNKNOWN`（做了什么没人知道），没开始的是 `cancelled`；中断前已报告完成的调用照旧是完成。客户端把这些行写成「已中断 · 结果未知」或「已中断」（琥珀色），没有 `interrupted` 而结果未知的写「结果未知」，都不写成失败；最新一轮的结束行写「Latch 重启时中断」并给「重试」（ACP 会话重试时照常先 `session/resume`、`session/load`，都不支持则 `harness-session-lost` 与「在新会话中继续」），重试前的确认会说明有几个操作结果未知。

**失败在原地说明。** 一轮失败时的系统消息就是原因：Host 或模型服务的 `AppError` 文字、Harness 的错误，都先经 `redactSecrets`。它带 `Message.errorCode`（AppError 的 code；模型服务的 HTTP 状态记为 `http-401` 这样的码），客户端据此给出一个下一步（`apps/web/src/conversation/failureAction.ts`）：Harness 的命令、版本或定义问题「打开设置 › Harness」，模型不能回答「换个模型」（打开输入框的模型菜单），模型服务拒绝密钥或地址不允许「打开设置 › 模型服务」，会话不能继续「在新会话中继续」，项目目录失效不给按钮（由项目恢复面板说明），其他都是「重试」。设置只对所有者设备出现。输入框里被 Host 确定拒绝的发送按同一个 code 在原因旁给出同样的下一步。

`unknownResults` 列出当时在运行的调用（`messageId` 是工具行，`name` 是名称），最多 32 条，更多时带 `unknownResultsTruncated`。`name` 是命令文本，所以 `unknownResults` **只在会话详情里**；列表与取消回执只带条数 `unknownResultCount`。进程退出的运行 `status` 是 `failed`，但 `runOutcome` 仍是 `interrupted`：那条命令是否生效没人知道，定时任务不能把它当作可以重试的失败。

Standard 的工具与模型在进程内运行，没有可结束的进程：停止只发出中止信号并等待它们真实结算，没有强制停止，不理会中止的插件工具会让运行一直停在 `cancelling`。

## 阅读位置

源码：[useReadingPosition.ts](../apps/web/src/core/useReadingPosition.ts)。

滚动容器使用 hook 返回的 containerRef 与 handlers，正文 wrapper 使用 contentRef。`ready` 必须表示 detail 已加载且属于当前 session；在此之前不写滚动位置。App 不应再增加第二个 scrollTop 写入 effect。

| 模式 | 行为 |
| --- | --- |
| `follow` | 流式正文或容器尺寸变化后，保持在当前底部 |
| `read` | 记录首个可见 `data-message-id` 与其相对视口 offset；布局变化后尽量保持这条消息的位置，不跟随新增正文 |

上翻 wheel、键盘、触摸、滚动条拖动提供用户意图；嵌套可滚动区能消费的滚动不释放外层 follow。自己的程序滚动与视口变大引起的 clamp 不视为用户上翻。用户手势或惯性期间暂不做锚点补偿，避免与拖动竞争。

“回到最新”和成功提交输入显式恢复 follow；用户向下滚到接近底部也可恢复。`reveal(messageId)` 把指定消息行滚入视野（状态行的「查看」、回到等你允许的审批卡），它同样由 hook 执行，目标已在底部附近时等同于回到最新。目标在收起的折叠里时，页面先向它外层每个 `hidden="until-found"` 的容器派发 `beforematch`（与浏览器页内查找走同一条路径，各自的主人随之展开），下一帧再 `reveal`。展开块的高度动画对 hook 来说是内容尺寸变化，阅读模式按锚点保持位置。思考与运行中的工具输出这类嵌套滚动框用 `flex-direction: column-reverse` 从末尾排布，自然跟随最新内容，不写 `scrollTop`。切换会话保存独立模式与锚点，当前 hook 最多保留 100 个会话的内存记录。它不把阅读位置保存到磁盘或浏览器存储，刷新整页不保证恢复原锚点。锚点消息消失时使用限制在有效范围内的旧 offset。锚点只在读者滚动时更新，程序写入不替换它。

当前使用完整消息列表，没有历史分页或虚拟列表；也没有“已发送”阅读状态或预留回复空间。手机视口变化通过 ResizeObserver 参与布局，但浏览器尺寸验收不能等同于 iPhone/Android 真机软键盘和全部惯性滚动行为已经验证。

## Markdown、代码与安全边界

源码：[MessageContent.tsx](../apps/web/src/MessageContent.tsx)、[markdown.css](../apps/web/src/styles/markdown.css)、[DiffView.tsx](../apps/web/src/components/DiffView.tsx)。

消息里的 Markdown 不执行原始 HTML：`literalHtml` 把回复里的原始 HTML 换成文字（句中）或 HTML 代码块（成块），`<br>` 换成换行，注释省略，`<details>` 与 `<summary>` 只留其中的文字，文字不丢失；回复仍在到达时，这样的代码块在后面出现内容后即算结束；Markdown 文件预览仍跳过它们，由源码视图查看。URL 只允许安全协议，图片不加载；显示规则见 [DESIGN.md](./DESIGN.md#流式与阅读)。

回复到达时，只在空行后已经出现独立新块的位置切分，缓存前面没有改变的解析结果与元素；不凭结尾的空行认定前一块结束。引用定义、脚注、HTML、引用容器、块数学及其他不确定的文档上下文仍用整段解析。只补当前尾块的行内强调、代码与未完成链接的显示；尚未收到有效分隔行的管道表头暂时显示文字。补全不改消息原文，复制与保存仍用原文。结束时对原文完整解析一次，扁平元素序列保持相同的节点位置，保留代码的展开、焦点与已有表格行；文件预览始终整段解析。

Mermaid 围栏和块数学必须实际闭合后才交给原有安全渲染器；取消或失败不会替未闭合内容补围栏。内容未闭合时保留代码，图表及数学的帧隔离、URL 与 DOM 校验不变。

工具声明为读取且已完成的调用，其输出按读取的文件名着色（可能含密钥的文件名不着色，只报告结构化结果的 JSON 不按文件语言着色）：Agent 加的行号与外层标记留在语法之外，行进入视野附近才着色，最多着色 1,000 行或 20,000 个片段，其余保持纯文本。字重不变，所以着色不改变换行与阅读位置。运行中、失败的调用与命令输出保持纯文本。

代码块超过 18 行可展开/收起，支持复制，失败时提示手动选择。复制都经 `writeClipboard`（`@latch/ui`）：先用 Clipboard API，没有它（HTTP 局域网）或被拒时用隐藏文本框与 `execCommand('copy')`，两种都失败才说「复制不可用」，不显示虚假的复制成功。桌面端的权限处理只管异步 Clipboard API：`clipboard-sanitized-write` 只准本窗口来源的顶层页，另一台电脑的页还要 5 秒内的真实点按或按键（不消耗打开链接的手势）；读剪贴板一律拒绝。`execCommand('copy')` 不经这些处理，点按后的任何框（含子框）仍能用它复制选中的文字。表格横向滚动，脚注 ID 按消息隔离；组件类型保持稳定，避免每次分片创建新的代码组件。代码块在共享 worker 内着色，超出 200 KB 时整块保留纯文本，超过 1,000 字符的单行只有这一行保留纯文本。长行在代码块内横向滚动，可聚焦后用键盘滚动，还有内容的一侧边缘变暗。

调度（[highlightScheduler.ts](../apps/web/src/preview/highlightScheduler.ts)）：worker 串行，所以只有一项在途，其余在栈里等待，最新的先出；取消的直接出栈。已结算的块在接近视口（滚动容器上下 800 px，[viewportGate.ts](../apps/web/src/preview/viewportGate.ts)）时才请求，并且不等待：只有文本还在变时才防抖 300 ms；缓存命中在同一次渲染显示。看门狗只针对在途项（新 worker 的第一项还要等它加载，给 30 秒）：超时时销毁 worker，其余任务留在栈中，超时项放到栈底再试一次并给四倍时限，再超时才记入负缓存，之后不再请求。worker 连续崩溃三次时放弃等待中的任务，下一次请求重新开始。

未闭合的围栏逐行着色：worker 按块保留 `grammarState`，只分词新完成的行，每块只有一个请求在途，下一个带上这期间完成的所有行；最后一行可能还会变，保持纯文本。文本不再是已分词内容的延长时从头开始，worker 已不持有该块时回答 `restart`。已完成的行有稳定的 DOM 节点，闭合后整块分词的结果相同时也不替换。超过 18 行的未闭合块只渲染最新 17 行，上方一行「前 N 行已收起」，光标在最后一个字符之后，所以可见部分就是在变化的部分；总高度与闭合后的 18 行相同，不写滚动位置。这期间被收起的行不在 DOM 中，也就不在会话内查找的范围内，展开或闭合后恢复；复制取原文。闭合后折叠的块只把前 19 行渲染成 token，其余仍是文本，可以查找和选择。会话内查找把代码块当成一段文本，匹配可以跨 token，着色替换文本节点后重新定位而不移动阅读位置。

流式帧不重绘其他轮次：全量帧每次重新解析所有消息，`stableTurns` 把数据相同的轮次保留为同一个对象（逐字段比较，不会漏掉新字段），`TurnView` 只接收属于自己的内容，只有最新一轮看到 detail。已结算的轮次用 `content-visibility: auto`，打印时恢复显示；这个属性也裁剪超出轮次的绘制，轮次内的内容不能画到轮次之外。未绘制的轮次只占一个估计高度，它的行却按完整高度测量，所以 `useReadingPosition` 定位锚点时先让锚点所在轮次与视野内其下的轮次真正绘制（`data-drawn`），取视野顶部的行时也不算超出占位的部分；切回会话、页内查找和 `reveal` 因此落在同一行。未闭合围栏与失败内容保留源码，详见 [DOCUMENT-PREVIEWS.md](DOCUMENT-PREVIEWS.md)。

## 继续开发时的验证入口

| 改动 | 优先检查 |
| --- | --- |
| 合并、订阅、重连与版本 | [streaming.test.ts](../apps/host/test/streaming.test.ts)、[projection.test.ts](../apps/web/test/projection.test.ts) |
| 事件流解析、退避、401 续期、单飞、丢失的续期应答、审批回执与停止请求 | [client-security.test.ts](../apps/web/test/client-security.test.ts)、[enrollment.e2e.ts](../e2e/enrollment.e2e.ts) |
| 事件流随凭据失效而结束 | [server.test.ts](../apps/host/test/server.test.ts)、[auth.test.ts](../apps/host/test/auth.test.ts) |
| 桌面端转发、流式响应与主进程续期 | [desktop-proxy.test.ts](../apps/desktop/test/desktop-proxy.test.ts)、[desktop.e2e.ts](../e2e/desktop.e2e.ts)（`LATCH_ELECTRON_E2E=1`） |
| 模型、工具、审批与取消 | [runtime.test.ts](../tests/runtime.test.ts)、[providers.test.ts](../apps/host/test/providers.test.ts)、[acp.test.ts](../packages/harness-acp/test/acp.test.ts) |
| 多 Harness 路由 | [hub.test.ts](../apps/host/test/hub.test.ts)、[harness-host.test.ts](../apps/host/test/harness-host.test.ts) |
| 阅读意图与布局竞争 | [reading-position.test.ts](../apps/web/test/reading-position.test.ts) |
| Markdown、差异与危险内容 | [message-content.test.ts](../apps/web/test/message-content.test.ts)、[client-diff.test.ts](../apps/web/test/client-diff.test.ts)、[components-conversation.test.ts](../apps/web/test/components-conversation.test.ts)、[client-export.test.ts](../apps/web/test/client-export.test.ts) |
| 开发服务器代理 | [client-devproxy.test.ts](../apps/web/test/client-devproxy.test.ts) |
| 真实 Host 的完整界面链路 | [streaming-ui.e2e.ts](../e2e/streaming-ui.e2e.ts)、[takeover.e2e.ts](../e2e/takeover.e2e.ts)、[extensions.e2e.ts](../e2e/extensions.e2e.ts)、[permissions-ui.e2e.ts](../e2e/permissions-ui.e2e.ts) |

统一使用 Vitest；浏览器用例在 Vitest 内使用 Playwright。运行结果以最近一次实际执行为准，本文不固定测试数量。继续修改时重点保留：旧 HTTP 不能盖过新流、A/B 不串会话、live 结算不重复、审批位置不乱、同一审批决定不重复提交、取消不提前确认、阅读历史不被新文字抢走，以及危险链接/HTML 不执行。

## 插件的会话面板

面板发现来自 Host 的 `catalog.uiPanels`，缺少字段时不显示插件标签。数据面板的异步响应按包、面板、会话、运行与重试序号归属；切换会话或卸载时中止读取，迟到响应不能替换新内容。面板的读取租约保留到 Host 回调实际结算。客户端不会按流式 token 请求面板数据，在会话运行状态改变或明确刷新时重新读取。

React 模块按内容摘要加载，组件在切换会话、离开页签与停用包时卸载；组件 effect 返回自己的资源清理函数。`readData` 的请求跟随组件寿命取消，卸载后的 `compose` 回调不修改新会话草稿。「写入对话」只追加草稿，不发起运行；发送仍经 `useSubmission`，由它持久化待发送内容、保留结果未知状态和复用原 requestId。

Standard 的技能指令在每轮开始时与输入一起持久化，同轮的流式步骤固定该份正文。插件替换不改变已开始的一轮；下一轮从当前启用集合重新组装。

原生 HTTP/2 客户端复用相同的 Host API 与 SSE 内容格式，网络连接不决定执行结果。原生正文窗口按已认证连接与 App 打开回执绑定，过期后流停止；列表可重新读取。取消与无附言拒绝保持可用，只返回回执，写入结果未知时继续保留原 requestId。Node `NativeWorkspace` 在安装新路径前恢复正文回执并读取 checkpoint，同一 Host 实例的 revision 只能前进；新路径失败时保留旧连接，迟到的快照不覆盖当前路径。后台重连循环在真实连接关闭或网络变化时重新获取候选，用同一 PathManager 安装新连接，且从不自动重发写入。

iOS 客户端把超时的读取当作 Mac 暂时连不上：列表横幅说明，不弹提示；有效窗口内只读这个窗口已存的正文并标明是旧内容。停止的请求等到 Host 结算（至多 45 秒），一次只发一个，上一个未确认前不发下一个。运行中的一轮在 `TaskDetail.steer` 时，输入框的发送键写「追加」并带 `steer: true`，否则在 Host 有队列时写「排队」；两者与其他写入一样带持久的 requestId，结果未知时原样重试。会话中改权限/模型/思考、分叉、重试与更多里的审批选项也是这样的写入，一次只有一个待确认；结果未知的写入在会话列表与会话里都能「重试这次提交」，否则看不见的那一个会挡住之后的所有写入。消息（新会话的第一条与会话的下一条）另有「放弃这次提交」：先重新读一次该会话（读不到才用屏幕上的），已列出带这个 `requestId` 的用户消息时写「已送达」并撤掉这个会话的清空上下文；否则在本设备放下它，文字接在输入框已有的文字之后，队列里有同样文字的一项时另作提示（`PhonePending.prompt`、`delivered`、`queuedTwin`、`joined`）。重命名、置顶、归档与删除与网页一样是普通请求，不带 requestId、不留待确认；失败或没有答复时说明一次并重新读取列表，以 Host 列出的为准。正文搜索（`POST /search`）只在有效窗口内发，结果只在内存里，不进离线列表缓存；Host 一次只做一个搜索，429 时保留上次的结果，停顿后再问。

### 搜索定位与阅读标记

正文搜索响应不是会话状态更新。点击结果先切换到原会话，等待对应 detail 后再通过 `useReadingPosition` 定位消息；迟到的搜索响应不会改变当前会话正文。会话内查找只创建 DOM Range 与 CSS Highlight，折叠行通过 `beforematch` 展开，不改写消息节点或增加一条消息。手动「标为未读」是每台设备的本地阅读偏好，持久化到已有阅读标记中；重新打开或收到该会话更新时清除，删除会话后清理。

文件标签是客户端阅读状态，不改变 Host 的会话状态。文件分块读取绑定打开时的 ETag，元数据变化先显示待更新提示；权限失效卸载解析器，标签切换取消 fetch、worker、PDF render 与 MessagePort。手机文件页复用页面返回栈；阅读位置仍由会话的控制器管理。相关契约见 [DOCUMENT-PREVIEWS.md](DOCUMENT-PREVIEWS.md)。

### 输入身份与分叉上下文

Standard 与 ACP 在接纳用户输入时把原始 `requestId` 写到用户消息，两种消息存储的 schema 都保留它，客户端据此关联重试和发送中的气泡。Host 为分叉首条消息补充可选 `forkContext`，`prefixLength` 是正文开头的上下文字符数，其余是新输入；正文仍完整发送给 Harness，只有消息带 `nativeFork` 时例外：Harness 用自己的记录分叉了，开头的上下文没有发给它（见 [ARCHITECTURE.md](./ARCHITECTURE.md#会话分叉)）。重试这一轮时页面同样处理：带 `nativeFork` 的只重发新输入；其余的连同上下文一起重发，因为第一轮失败时上下文可能还没有到达 Harness。折叠只是显示方式，复制消息保留完整正文。旧 Host 不带这些字段时沿用原有显示。接入的会话（`TaskSummary.imported`）里从 Harness 重放来的消息带 `imported: true`，不属于任何一轮；按文字重建的会话首条消息开头 `imported.prefixLength` 个字符是带上的对话文字，Host 在这条消息上补充 `importContext`（来源 Harness 的名称与同一长度），页面据此折叠，重试只重发新输入，因为这段文字已随第一次发送交给会话（见 [HARNESSES.md](./HARNESSES.md#接入已有会话)）。

### 清空上下文

`TaskDetail.clearContext` 为真时，`POST /tasks/:id/prompt` 接受 `freshContext: true`：这一轮在新的上下文里开始，Harness 看不到之前的消息，消息仍留在会话记录里。Driver 把它记在这一轮的用户消息上（`Message.freshContext`，两种消息存储的 zod schema 都保留），所以重连、切换会话与刷新都不会丢掉或移动这条边界。它不能与 `queue`、`steer` 一起用（400 `fresh-context-queued`），不声明的 Driver 回答 409 `clear-context-unsupported`，早先助手跑过的会话回答 409 `session-read-only`。重试沿用原 `requestId`，带不带它是不同的请求（`request-conflict`）。Latch 内置清空发给模型的历史；ACP 开新的 Agent 会话，见 [HARNESSES.md](./HARNESSES.md#清空上下文)。从边界之后某一轮分叉时，种子从这条边界开始。

发送之前它只是本设备的一个选择（网页与桌面端输入框的 `/clear` 或会话菜单的「清空上下文」；iPhone/iPad 是页头会话菜单的「清空上下文」，只存在 App 的内存里），不写 Host；运行中不能选，一轮开始时选择撤掉。选定后点最新一轮的「重试」，重发的这一轮也带 `freshContext`。它随待发送的提交一起保存，结果未知时原样重试。Driver 在这一轮开始前已经放下旧的上下文、这一轮却被拒绝或没有开始时，详情带 `TaskDetail.contextCleared`：下一条消息不论是否要求都在新的上下文里，网页、桌面端与 iPhone 都写出这一点，不再提供撤销；带 `Message.freshContext` 的一轮在各处都画「清空了上下文」的线。

`Message.thinking` 是助手消息那一步的思考深度（Harness 的叫法，Latch 内置是深度 ID），与 `Message.model` 一起让客户端在两轮之间标出换了什么；没有记录的旧消息不标。

### 排队状态与实际发送

详情与 SSE 的 TaskDetail.queue 投影 `{id,text,queuedAt,state,reason?}`，state 为 waiting、parked 或 dropped；设备身份与请求回执不下发。入队回执不生成用户消息，实际派发才生成带 requestId 与 queuedAt 的正常消息。编辑换派发标识，原提交重试仍命中同一项。两种 Driver 的 zod 快照保留 queuedAt 与 TaskSummary.runOutcome；新运行清除旧 outcome，真实结算后才写明确完成、失败、取消或中断。队列不从网络状态、idle 或文字猜测完成。

### 追加到运行中的一轮

`TaskDetail.steer` 为真时，正在运行的这一轮还能接收文字：输入框的发送键是「追加」，提交带 `steer: true`。它只来自本轮进程的协商（ACP Agent 在 `initialize` 的 `_meta.steering.supported` 声明），轮次被要求停止后即消失。Host 经 `Bridge.steer` 转给 Harness，Agent 接收则回答 `{steered:true}`，消息作为带 `steered` 的用户消息进入这一轮，不开新的一轮，客户端也不按它分轮；Harness 不支持、轮次已结束或 Agent 回答 `promptRequired` 时，同一请求按排队处理（有轮次在跑就排队，没有就直接作为新一轮发送）。Agent 拒绝时返回 409 `steer-failed`：内容没有发出，这是确定的结果，不是「结果未知」。

追加用原 `requestId`：重试得到第一次的结果，第一次已按排队处理（直接作为新一轮发送或进入队列）时，重试也只命中那一轮或那一项，即使这时的轮次能接收追加；Agent 没有回答（超时或进程中断）时回执保持「发送中」，之后的重试一律 409 `steer-unknown`，不再发出，因为 Agent 给每次请求另起消息，分不出重发。`steered` 只表示 Agent 接收了，不表示它在本轮结束前读到了；本轮没有正常完成、期间有过追加、而最后一次追加之后 Agent 再没有任何输出时，结束时写一条系统消息说明它可能没有读到。追加不带附件和文件引用，也不替人拒绝等待中的审批。

### 子 Agent

Harness 启动的子 Agent 是会话记录里的一行工具消息，带 `Message.subagent`（名字、说明、状态、步骤）；它的状态只来自它自己的报告，所在的一轮结束时仍未报告停止的记为 `unknown`。它请求的审批在会话的 `approvals` 里，`Approval.subagent` 是它的名字，没有 `toolCallId`。一轮结束后才到或仍在等的这类审批让会话处于 `waiting-approval`，详情里没有 `activity`；答复后会话回到这一轮结束时的状态。能单独停止的子 Agent 带 `Subagent.stoppable`；停止它之后带 `stopping`，直到它报告结果或这一轮结束，页面在此之前不写「已停止」。机制见 [HARNESSES.md](./HARNESSES.md#子-agent)。

## Agent 提问与回答

`catalog.features.questions` 表示 Host 支持内置问答接口。ACP Agent 的提问（标准的 `elicitation/create` 表单模式，以及任何 Agent 发来的 `cursor/ask_question`）经 `HarnessHostOptions.askUser` 进入同一张提问卡，见 [HARNESSES.md](./HARNESSES.md#agent-的提问)。题包只在所选会话 detail/事件里出现，工具行按 toolCallId 显示向导。草稿与当前题号仅在本设备存储；切换会话或重载页面后恢复。提交前保存完整 requestId/answers；未知结果保持相同内容重试，卡片卸载不取消已经接纳的写请求。工具结果落盘后替换为可展开的已回答记录，随后模型继续。

问答沿用审批等待的传输状态，详情里的 questions 决定界面显示「等你回答」。工作计时与审批等待使用同一暂停区间。Host 重启结束未答题；回答接收与工具结果之间崩溃时，只有实际会话的 completed 输出完全匹配才恢复已回答回执，不据客户端声称的成功继续执行。

## 附件输入

附件字节独立上传，消息流只同步 `Message.attachments` 的 metadata。发送引用前保存原 requestId 和 attachmentIds；响应丢失后重试相同请求，绑定后的附件也能识别原创建请求。Host 中的 Standard 历史只存引用，在调用 Provider 前读取真实内容；ACP 内容块不进入公开会话响应。上传的中断或失败不等于消息已经发送，接口与权限见 [ATTACHMENTS.md](ATTACHMENTS.md)。

输入的附件队列是客户端草稿状态；点击发送后先等待上传再建立持久待确认提交。取消等待只终止上传，不调用会话取消。文件选择的结构化引用与原请求一起保存，文字编辑移除标记也移除其选择；网络重试继续使用已保存的引用。

### 本设备的发送投影

**确定的拒绝。** 一次写入是否「结果未知」按 Host 的错误码判断，不只看状态：网络错误、超时、408 与 5xx 是结果未知，只有一种例外：5xx 的错误码在 `NOT_ACCEPTED_5XX`（`@latch/protocol` 的 `refusedBeforeAccepting`）里。这些码只在 Host 记录请求之前抛出，说明什么都没有接收：`audit-unavailable`、`presence-unavailable`、`agent-busy`、`agent-start-failed`、`agent-refused`、`agent-paused`、`agent-handshake-timeout`、`model-gateway-unavailable`。4xx（408 除外）同样是确定的拒绝，例如 `harness-unavailable`、`harness-version-unsupported`。ACP 会话重新接上 Agent 时（这一轮还没有记录）进程退出或不再应答时，Host 答 503 `agent-start-failed`；Agent 回答错误（会话被别的客户端占用、回答无效）时答 502 `agent-refused`，带它自己的原因。确定的拒绝之后页面丢弃 `requestId`，文字留在输入框，原因就地显示，并按错误码给出下一步（Harness 起不来：能改设置的设备给「打开设置 › Harness」，所有设备给「重试」）；Host 同时放下为这个请求保留的附件。这些码只在 Host 什么都没有记下时出现：没有用户消息、没有回执，也没有之后还可能把它发出去的排队项。立即发送的排队消息（会话空闲时 `queue: true`）先写下排队回执再发送；发送被这样拒绝时，Host 先删掉这一项和它的回执再回答（为它写下的 `task.prompt.queued`、`task.prompt.sent` 审计各补一条 `action.failed`），删不掉就把这一项留作「发送结果未确认」并改答不在清单里的 503 `queue-send-unknown`，所以同一段文字永远只有一条重发的路。iPhone/iPad 用同一份清单（`NativeHostRefusal.notAccepted5xx`，`native-swift.test.ts` 核对两份一致）：第一次提交得到确定的拒绝时不留作「结果未知」，文字留在输入框，写出 Host 的原话。两端只在重试时不同：网页上，重试（同一 `requestId`）得到确定的拒绝也结束等待；iPhone/iPad 上，重试的拒绝只有 Host 按第一次提交的回执作答时（`retryAnswered`，例如 `attachment-released`）才结束等待，其他拒绝（4xx 与清单里的 5xx）仍留作「结果未知」并写出 Host 的原话，因为重试被拒绝说明不了第一次提交是否已被接收。网页能这样做，是因为 Host 对自己接收过的一轮先认回执：Driver 把这一轮写稳之后，Host 在内存里按会话、设备与 `requestId` 记下所发内容的哈希；同一设备带同样内容的重试不再做提交前的检查，直接答已接收（带附件的再补一次绑定），检查变化（项目、Harness 版本、模型、文件引用、数据范围）不会把已送达的消息说成被拒绝；同一 `requestId` 换了内容仍是 409 `request-conflict`；别的设备、还在写稳中的一轮与 Host 重启之后的重试照常检查（重启后 Driver 自己的回执仍按 `requestId` 防止重复）。新增一个在接收前拒绝的 5xx 时把它同时加入 `NOT_ACCEPTED_5XX` 与 Swift 核心；接收之后才可能出现的码不能加入。

`catalog.features.messageIdentity` 明确声明用户消息保留 requestId。客户端在本设备提交后立即显示临时文字，500ms 后才显示「发送中…」；按相同请求标识、文字及附件/文件引用匹配 Host 消息后隐藏临时投影，实际会话仍由 Host 维护。临时状态不写入 TaskDetail、快照或服务器存储。结果未知保留原提交，并以同一请求体重试，卡片写出最近一次重试为什么仍未确认（超时、Host 自己的 5xx 说明、断线或限流）；这句原因按 `requestId` 存在 `latch.pending.<origin>.<deviceId>.reason`，刷新后照旧显示，不退回「没有收到电脑的答复」（像凭据的原因只在内存）。未知只由两件事结束：Host 的证据，或人按「放弃这次提交」。证据是会话列出带这个 `requestId` 的用户消息（只比 `requestId`，不比文字）：打开的会话出现它时按已送达结算（「已送达」），不再占住输入框，原会话存着的同一段草稿一并删除。带附件的提交例外：Host 可能先列出消息、再以 503 `attachment-publish-unknown` 要求同一请求，页面因此用同一 `requestId` 静默再发一次，以它的答复结算；人放弃时才按已送达结算。新会话的提交在答复前没有会话 ID，无从核对。「放弃这次提交」先重新读一次该会话（读不到才用屏幕上的副本）：已列出就按上面结算。否则只在本设备放下它：存储里仍是这条记录时才删除，文字回到原输入框，原会话不在屏幕上时存为该会话的草稿；附件和文件引用清空并提示重新添加，因为附件已保留给放弃的那个请求（`attachment-claimed`）。再发送是一条新消息、新的 `requestId`（新会话则是另一个会话，可能另建一个工作树）；Host 如果其实已经收到，就多出一条。排队（或追加）的提交：会话的队列里有同样文字的一项时，卡片写「队列里有同样的一条在等待」（等这一轮结束自己发出）或「…已暂停」（只在有人发送时发出，Host 重启会暂停所有等待项），放弃之后提示在队列里发送或移除。队列不下发请求编号与设备，那一项可能是别的设备的，所以只比文字、只作说明，从不挡住放弃。同一设备的多个窗口：发送之前再读一次存储，另一个窗口已存下别的未确认消息时不发送，改为显示它的卡片；发送或重试中的窗口在 `latch.pending.<origin>.<deviceId>.sending` 写下 `{requestId, until}`（20 秒，超过请求的 15 秒超时，关掉的窗口不会一直占着），其他窗口在它到期或被清除前不提供放弃，写「另一个窗口正在重试」；每个窗口结算时只删除仍是自己这条 `requestId` 的记录。重试从不更换 `requestId`，每台设备仍只有一条未确认的消息。队列接收不生成临时气泡；新会话不论哪个 Harness（包括完全访问的）都和继续对话一样立即显示。旧 Host 缺少标记时保留原显示。
文件变化的范围、运行结算、可选插件契约与验证见 [运行期间的文件变化](FILE-OUTPUTS.md)。

文件列按 session 与 workspace/Harness 分开保留相对引用；切换上下文取消旧解析、目录读取与搜索，迟到结果不更新新上下文。项目预览不创建会话。目录与句柄见 [DOCUMENT-PREVIEWS.md](DOCUMENT-PREVIEWS.md)。

Harness 的进程级换档在空闲时结束旧进程、恢复同一外部会话；准备与恢复期间拒绝发送、追加和其他配置写入。dsh 以官方服务报告同会话的实际权限为证据；Gemini 启动设置与 Cursor force 只表示新进程的启动配置，界面明确标为未独立读回，未知结果仍沿原 requestId 保留。
