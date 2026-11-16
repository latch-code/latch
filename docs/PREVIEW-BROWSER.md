---
description: 桌面端预览浏览器（「浏览器」标签）：主进程的导航规则、页面可用的 latchShell.browser 接口、标注、遮挡与快捷键，以及内置 Harness 的 Agent 与外部 Harness（经 latch-browser MCP 与工具网关）经 Host 的 broker 操作标签。
sources:
  - apps/desktop/src/browser.cjs
  - apps/desktop/src/browser-agent.cjs
  - apps/host/src/browser-broker.ts
  - apps/host/src/routes/browser.ts
  - apps/host/src/plugins/tools/browser/index.ts
  - apps/host/src/tool-gateway.ts
  - packages/harness-acp/src/browser-server.ts
  - apps/host/test/tool-gateway.test.ts
  - apps/host/test/browser-mcp.test.ts
  - packages/harness-acp/test/browser-server.test.ts
  - e2e/desktop-browser-mcp.e2e.ts
  - apps/host/test/browser-broker.test.ts
  - apps/host/test/browser-routes.test.ts
  - e2e/desktop-browser-agent.e2e.ts
  - apps/desktop/src/preload.cjs
  - apps/desktop/src/main.cjs
  - apps/web/src/panel/browser
  - apps/web/test/browser-panel.test.ts
  - e2e/desktop-browser.e2e.ts
  - apps/desktop/test/desktop-browser.test.ts
  - e2e/desktop.e2e.ts
---
# 预览浏览器

「浏览器」标签在 Latch 桌面端里显示网页，多半是项目的本地开发服务。

| 部分 | 位置 |
| --- | --- |
| 标签、导航规则、截图、标注、日志 | Electron 主进程 `apps/desktop/src/browser.cjs`，经 preload 暴露为 `latchShell.browser` |
| Agent 的动作 | 主进程 `apps/desktop/src/browser-agent.cjs`，与页面接口分开的固定白名单 |
| 分级、审计、转发 | Host 的 broker `apps/host/src/browser-broker.ts` 与路由 `routes/browser.ts` |
| 外部 Harness 的入口 | `packages/harness-acp/src/browser-server.ts`（`latch-browser` MCP 服务）与 `apps/host/src/tool-gateway.ts` |
| 面板 | `apps/web/src/panel/browser/` |

**只在这台 Mac 的桌面端。** 会话面板的「浏览器」页签只在桌面端主窗口 `latch://app/` 的页面上出现，条件是：`latchShell.browser.protocolVersion` ≥ 2、会话没有归档、会话属于一个项目。浏览器、手机与其他电脑的窗口里只有只读的标签列表（见「手机与其他入口」）。

**不是操作系统级的隔离。** 这是 Chromium 的渲染进程沙箱加上主进程的请求与导航规则。来访页面（下称「页面」，区别于 Latch 自己的页面）以这台 Mac 的网络位置运行：和普通浏览器的标签一样，它能访问互联网、局域网设备与本机的其他服务，Latch Host 与模型网关除外。每个项目一个内存分区，只把它的 Cookie、存储与缓存同 Latch 自己的页面、其他项目分开。

## 导航

- 顶层只去 http(s) 地址；页面的子框架另可承载自己的 about:、data: 与 blob: 文档。
- 页面自己去私有地址需要用户刚在标签里点过。
- 地址栏的输入：纯端口号是 `http://localhost:<端口>/`；没有协议的本地地址用 http，其他用 https。不提供搜索。
- 窗口里最多 8 个标签（`tab-limit`）。

## `latchShell.browser`

`protocolVersion: 3`。preload 先检查每个参数的形状，不对时直接回答 `{ ok: false, error: 'invalid' }`；主进程再按同样的规则检查一遍。

| 调用 | 参数 | 成功时的回答 |
| --- | --- | --- |
| `open(projectId, sessionId, url?)` | 地址栏文字，省略时是空白标签 | `{ ok, tabId, state }`，`tabId` 形如 `brw_` 加 22 个字符 |
| `list()` |  | `{ ok, tabs }`：窗口里每个标签的 `{ tabId, projectId, sessionId, state }`，按打开的先后 |
| `close(tabId)` |  | `{ ok }` |
| `navigate(tabId, url)` | 地址栏文字 | `{ ok, url }`，规范化后的地址 |
| `back`、`forward`、`reload`、`stop(tabId)` |  | `{ ok }` |
| `setBounds(tabId, rect)` | 面板矩形 `{ x, y, width, height }`，页面的 CSS 像素；`null` 隐藏 | `{ ok }` |
| `occlude(tabId, occluded)` | 页面的浮层盖住面板时为 `true` | `{ ok, image }`：隐藏前的最后一帧，没有时为 `null` |
| `focus(tabId)` |  | `{ ok }`；隐藏或被遮挡时 `hidden` |
| `capture(tabId)` |  | `{ ok, image }` |
| `annotate(tabId, point)` | `{ x, y }`，从标签左上角算起的页面 CSS 像素 | `{ ok, target }` |
| `hitTest(tabId, point)` | 同上 | `{ ok, target: { tag, rect } }` |
| `setViewport(tabId, preset, rotated)` | `fit`、`phone-small` 375×667 @2x、`phone` 390×844 @3x、`phone-large` 440×956 @3x、`android` 412×915 @2.625x、`tablet` 820×1180 @2x、`desktop` 1280×800 | `{ ok, viewport, size }` |
| `setColorScheme(tabId, scheme)` | `system`、`light` 或 `dark` | `{ ok, colorScheme }` |
| `logs(tabId)` |  | `{ ok, console, network }`：各自最近 200 条 |
| `zoom(tabId, direction)` | `in`、`out` 或 `reset` | `{ ok, zoom }` |
| `devTools(tabId)` |  | `{ ok }`，开发者工具在自己的窗口里 |
| `clearData(projectId)` |  | `{ ok }`：清除该项目分区的存储、Cookie、缓存、认证缓存与解析缓存 |
| `state(tabId)` |  | `{ ok, state }` |
| `takeOver(tabId)` |  | `{ ok }`：Agent 对这个标签的调用等待 |
| `handBack(tabId)` |  | `{ ok }`：之前交出的元素引用全部作废 |
| `showing(sessionId)` | 会话 ID 或 `null` | `{ ok }`：页面现在显示哪个会话的「浏览器」面板 |
| `subscribe(callback)` |  | 返回取消订阅的函数 |

**`state`** 是 `{ url, title, loading, canGoBack, canGoForward, zoom, crashed, error, viewport, colorScheme, logs, opener, control, activity }`：

- `opener` 是 `person` 或 `agent`；`control` 是 `agent`（Agent 的动作正在执行）、`person`（人接手了）或 `null`；`activity` 是主进程写的一句话，说 Agent 正在做什么。
- `error` 是主框架最近一次加载失败的 Chromium 网络错误码；`logs` 是这个文档以来的 `{ errors, warnings, failed }`。
- 地址超过 8192 个字符时去掉查询再去掉路径；标题去掉控制与双向字符，不超过 256 个字符。

**事件**（`subscribe`，preload 丢弃形状不对的）：

| 事件 | 含义 |
| --- | --- |
| `{ type: 'state', tabId, state }` | 同一标签最多每 32 毫秒一次 |
| `{ type: 'notice', tabId, notice, detail? }` | `notice` 是 `permission`、`download`、`popup`、`navigation` 或 `certificate`：被拦下的权限、下载、弹窗、导航，或证书问题 |
| `{ type: 'hidden', tabId }` | 主进程把它藏起来了，页面要重新放置 |
| `{ type: 'closed', tabId }` | 标签关闭 |
| `{ type: 'opened', tabId, projectId, sessionId, state }` | 窗口里新开了标签，不论哪个页面或 Agent 开的 |
| `{ type: 'reveal', tabId }` | Agent 要用这个标签，显示这个会话的面板切到它 |

**图片**是 `{ type: 'image/png', width, height, data }`，`data` 为 `Uint8Array`。截图与定格画面每边不超过 4096 像素、不超过 5 MiB（附件对图片的上限），放不下时按比例缩小。

**失败**是 `{ ok: false, error }`：`invalid`、`emulation-failed`（调试接口被占用）、`shell-refused`（不是主窗口的顶层页面）、`not-found`、`unavailable`（没有窗口）、`tab-limit`、`project-limit`、`invalid-url`、`blocked`（附 `reason`）、`busy`（同一标签的截图或标注还没完成）、`capture-failed`、`no-target`、`hidden`、`clear-failed`。

## 标注

`annotate` 在页面的一个隔离世界里运行固定的脚本，只读不写，也不在页面里留下任何东西：

- 取该点的元素，生成选择器：页面里唯一的 id，否则逐级的标签、最多两个类名与 `:nth-of-type`，最多八级、512 个字符。
- 取可见文字：跳过脚本与样式；没有文字时用 `aria-label`、`alt`、`title` 或 `placeholder`；从不读取表单的值。
- 主进程再检查回答的形状与长度，去掉控制与双向字符，文字截到 200 个字符；3 秒内没有回答即为 `no-target`。

`target` 是 `{ url, tag, selector, text, rect, image }`：`rect` 是从标签左上角算起的页面 CSS 像素，`image` 是元素周围 8 像素内的截图，每边不超过 1600 像素、不超过 2 MiB。

页面仍然决定该点是哪个元素（可以盖一层透明的元素）以及它的属性、文字和矩形，所以回答只说明页面呈现了什么，不能当作可信内容。

## 遮挡、焦点与快捷键

- **遮挡。** 原生视图画在页面之上，会盖住 Latch 页面的菜单、对话框与设置。页面打开这样的浮层时调用 `occlude(tabId, true)`：主进程先截下当前画面，再隐藏视图，页面把这一帧放在原处；浮层关闭后调用 `occlude(tabId, false)`。面板宽度的动画期间同样处理。
- 控件的提示（`role="tooltip"`）不算浮层。否则指针停在一个控件上画面就一直定格，Agent 的点击、输入与截图也都被拒绝。
- **焦点。** 隐藏或被遮挡的标签若有键盘焦点，焦点交还页面。没放在面板上的标签静音。
- **重新载入 Latch 页面。** 页面的新文档真正提交（`did-navigate`）或渲染进程退出时，标签不关闭：全部隐藏、交还焦点、发 `hidden`，新页面经 `list` 取回，按会话放回面板。被拒绝的导航不隐藏任何标签。
- **关闭。** 会话归档或删除时页面关闭它的标签（Host 的完整列表里不再有它，且这台设备能看到全部会话）；窗口关闭时全部关闭；标签的页面自己关闭时，页面收到 `closed`。
- **快捷键。** 标签有焦点时，应用的快捷键 ⌘K、⌘J、⌘B、⌥⌘B、⌘,、⇧⌘B 与 ⇧⌘S（其他系统上 Ctrl 代替 ⌘）由主进程在 `before-input-event` 截下，网页收不到；主进程把焦点交还页面，再把同样的按键送给页面。其他按键留给网页。

## 视口、外观、控制台与网络

- **视口。** 预设用 `enableDeviceEmulation` 按预设尺寸与像素比排版（手机与平板按移动设备），再按视图大小缩小，从不放大。旋转对调宽高。新文档沿用。
- **手机外框。** 手机预设的页面外面，面板画一圈圆角外框（10px，原生视图之外，视图会盖住画在它上面的东西），外框两侧的短线标出顶部与底部安全区伸到页面里多远。这只是示意：页面拿不到 `env(safe-area-inset-*)`。
- 移动端的用户代理与触摸事件尚未实现：那要经调试接口发 `Emulation.setUserAgentOverride` 与 `setTouchEmulationEnabled`，扩大了调试接口的用途，需要单独的安全审阅。要看真的 Safari，用[设备](DEVICE-PREVIEW.md)面板在模拟器里打开地址。
- **外观。** 只在选了浅色或深色时，主进程连上这个标签自己的 `webContents.debugger`，只发 `Emulation.setEmulatedMedia`（`prefers-color-scheme`）；「跟随系统」清除模拟并断开。调试接口被占用（例如开发者工具）时回答 `emulation-failed`，被断开时标签回到跟随系统。
- **控制台。** 每条去掉控制字符、格式字符（双向、零宽、软连字符、Unicode 标签）、其他默认可忽略的字符与行、段分隔符，截到 500 个字符，记来源的源与路径。每个标签在环形缓冲里保留最新 500 条，每条带递增的序号。
- 只因为是 Latch 的预览才出现的两条警告（Chromium 关于 Latch 加给每个文档的沙箱的警告、Electron 未打包时的不安全 CSP 警告）按原文精确匹配后不记，也不计数。
- **网络。** 分区的 `webRequest.onCompleted` 与 `onErrorOccurred`：方法、源与路径（不带查询）、类型、状态或错误名、耗时、`Content-Length`。从不记请求头、Cookie 与正文。每个标签保留最新 500 条。被拦下的请求（例如去 Host）记为 `ERR_BLOCKED_BY_CLIENT`。
- 主框架开始新文档时两张表清空。

## 模型网关

模型网关的回环端口由 Host 经 `host-info`（只在 `host.sock` 上）的 `modelGatewayPort` 告诉主进程，主进程把它同 Host 的监听端口一起拦下，标签的页面连不上它。

## 界面

`apps/web/src/panel/browser/`：会话面板的「浏览器」页签，面板「+」里一行「浏览器」（字母键 B，开着时再选新开一页），⇧⌘B 开关。布局与控件以源码为准，下面只写规则。

- **标签。** 标签条只列这个会话的标签；窗口里有其他会话的标签时另有一个菜单可以逐个或全部关闭。已结束会话的标签随会话关闭，不占名额。
- **空白页**列出这个会话终端里检测到的本地服务，与这个项目在本设备最近打开的 5 个地址（只记源与路径，存在本机）。终端行尾的本地服务链接在这里新开标签；⌘ 点按仍去系统浏览器（[TERMINAL.md](TERMINAL.md)）。
- **截图**把 `capture` 的 PNG 作为图片附件放进草稿，不发送。
- **选取元素**（⇧⌘S）先 `occlude` 定格，鼠标移动时每 80 ms 一次 `hitTest`，点击时 `annotate`，最多选 5 个。草稿里加一段标明「页面提供的内容」的文字（页面、选择器、标签、文字、尺寸，先脱敏），裁剪图由页面从定格的帧上裁出、作为附件。
  - 点击发生在 Latch 的页面上，网页收不到这次点击。
  - 文字与选择器是点击那一刻从实时页面读的，图片来自定格的帧，网页可以在两者之间改动 DOM。页面返回的元素框不再覆盖点击的位置时，只加入点击处的截图，并提示页面在选取时变了。
- **控制台与网络抽屉**每秒读一次 `logs`。「加入对话」把选中的条目或最近 20 条错误作为文本块放进草稿，先按 `@latch/protocol` 的凭据模式脱敏。抽屉显示的与放进草稿的是同一段文字：隐藏字符都经 `escapeSecurityText` 写成 `\u{XXXX}`，元素标题里的摘录也一样。
- **状态。** 加载失败、页面崩溃、或 Latch 页面自己的浮层盖住画布时视图隐藏。本机地址被拒绝连接时面板等待开发服务：可见期间每 2 秒重新载入，最多 60 秒。`notice` 事件给一条短提示。
- 界面写明这是内存分区，不是沙箱。

## Agent 的工具

内置 Harness 的 Agent 有 16 个浏览器工具（`apps/host/src/plugins/tools/browser/`）：`browser_tabs`、`browser_open`、`browser_navigate`、`browser_read`（可访问性树，元素引用如 `e12`）、`browser_find`、`browser_screenshot`、`browser_scroll`、`browser_viewport`、`browser_console`、`browser_network`、`browser_wait`、`browser_click`、`browser_key`、`browser_select`、`browser_type`、`browser_close`。

没有执行任意脚本、读 Cookie、开发者工具或清除数据的工具。

外部 Harness 经 `latch-browser` 拿到同样的工具，`initialize` 另带几条 `instructions`（`BROWSER_INSTRUCTIONS`，见 [HARNESSES.md](HARNESSES.md)）。

### 通道

主窗口存在时，主进程向自己的 Host 登记为浏览器提供者。这组路由只收 `host.sock` 上、在 `host.sock` 登记的设备；主进程的代理对页面发往 `/link/api/browser-provider/*` 的请求回答 403 `shell-managed`。

| 路由 | 作用 |
| --- | --- |
| `POST /link/api/browser-provider/nonce` | 单次 nonce，与添加文件夹同一种 |
| `POST …/register` | 正文 `{ nonce, purpose: 'browser-provider' }` 用设备私钥签名，得到 `providerId` |
| `POST …/stream` | SSE：`call`、`cancel`、`session-ended`、`turn-ended` 与心跳 |
| `POST …/results` | 调用结果，JSON ≤ 1 MiB，带 `dispatched` |
| `PUT …/results/:callId/image` | 截图，PNG ≤ 5 MiB，先于结果上传 |
| `POST …/tabs` | 标签表：每秒最多一次，谁在操作变化时立即报 |

- 同一时间一个提供者，新登记结束旧的流；窗口关闭即结束流。
- 标签表只有标题、源与路径（不带查询）、加载中、谁在操作、谁开的，只在 Host 内存里。

### broker

- **没有提供者**时调用立即失败（`browser-unavailable`），不排队；Host 从不启动桌面端。
- **会话。** 标签不是这个会话的为 `not-found`。每个会话同一时间一个调用。
- **本机地址。** 标签或目标地址不在本机地址上时，除列标签与关标签外都拒绝（`not-local`）。本机地址在 broker 与主进程里是同一组：localhost、`*.localhost`、127/8、::1 与 IPv4 映射的 127/8（`::ffff:127.x.x.x`）；0.0.0.0 与 :: 不算；空白页算。
- **先审计再发出。** 写 `browser.call`，写入失败不发出。字段：会话、调用 ID、工具、标签 ID、源的类别（`loopback`、`private`、`internet`、`none`）、源的 SHA-256、风险、运行时的工具调用 ID `toolCallId`，问过人时还有 `approvalId`。`approval.decided` 同样记 `toolCallId`，两条记录由此对上。输入的文字、选择器与地址都不进审计。另记 `browser.provider.registered` 与 `browser.provider.ended`。
- **截止。** 默认 15 秒，打开、导航与等待 30 秒。
- **停止与超时。** 停止（任何能取消这一轮的设备）或超时后发 `cancel`，主进程停下等待或加载并回报，Host 这时才结算。5 秒内不回报或提供者中途断开时，读类调用失败，动作为「结果未知」（`result-unknown`）。

### 分级

`classifyBrowserCall`（`apps/host/src/risk.ts`）：

| 调用 | 级别 |
| --- | --- |
| 看（列标签、读取、查找、截图、滚动、视口、控制台、网络、等待） | R0 |
| 动（打开、导航、点击、按键、选择、输入） | R1 |
| 关标签 | Agent 开的 R0，人开的 R1 |
| 往密码框，`autocomplete` 为 `current-password`、`new-password`、`one-time-code`、`cc-*` 的字段或隐藏字段输入；往没读到过的引用输入 | R2 |

- 分级不看标签现在在哪（分级与执行之间它可以变）。不在本机地址上的调用由 broker 拒绝，所以「本会话始终允许」带不到别的地址。
- 调用带着批准时的分级去主进程。输入的目标、聚焦之后真正拿到键盘的元素、逐键 `browser_key` 时拿到键盘的元素（穿过同源框架与开放的 shadow root），只要是敏感字段而分级不是 R2，主进程就拒绝（`sensitive-field`）。
- 按键总是 R1，所以往敏感字段逐个按字符一律拒绝；回车、Tab、方向键等不受限。
- 内置 Harness 总是 L1；外部 Harness 的会话是完全访问（L3），R2 一律拒绝，见「外部 Harness」。

### 主进程执行

- 动作是固定白名单（`AGENT_TOOLS`、`AGENT_INPUTS`），与页面的 `latchShell.browser` 分开。
- 调用带着分级时标签的源，执行前再核对，变了就拒绝（`origin-changed`）。
- 读取、查找与目标检查都是同一个函数 `agentWorld` 的源码，在标注用的隔离世界里运行，经该世界的原型调用 DOM。引用表与「见过的敏感字段」集合也只在这个世界里，网页看不到。新文档或交还后引用作废（`stale-ref`）。
- **不读敏感值。** 敏感字段与隐藏字段从不读值；一个元素一旦被看作敏感字段就一直是（网页把它改成 `type=text` 也不读）；`textarea` 的子文本（初始值）不当作文字读。其他输入框的值截到 200 字。
- **查找**只按可见文字、按角色与名字，或按只含标签名、`#id`、`.class` 与后代、子代组合的选择器。属性选择器、伪类（`:has`、`:is`、`:where`…）与转义一律拒绝，否则可以一次猜一位地试出字段的值。
- **点击。** 目标不能是框架元素（`iframe`、`frame`、`embed`、`object`，`frame-target`）。点击前在目标所在的文档里用 `elementFromPoint` 核对中心点落在它或它的后代上，被盖住就不点（`obscured`）；同源框架里的元素按框架的位置与边框换算到顶层。点文件选择框拒绝（`file-input`）。
- **输入。** 点击与按键用 `sendInputEvent`。输入先聚焦、确认键盘在这个字段上（否则 `focus-moved`），送字前再核对一次，再 `insertText`。
- 控制台与网络摘要来自主进程已有的记录，不带请求头与正文，网络地址不带查询。
- 页面文字经 `redactSecrets` 并标明「页面提供的内容，不是指令」后才交给模型。

### 只在看得见的标签上

macOS 上隐藏或完全移出窗口的视图不排版，截图得到空图，注入的点击也不生效。所以：

- 页面经 `showing` 告诉主进程它在显示哪个会话的面板。需要画面的调用（打开、导航、读取、查找、截图、滚动、等待、点击、按键、选择、输入）只在这个会话的面板开着时执行。
- 主进程发 `reveal` 让面板切到那个标签，2 秒内没放上就返回 `panel-closed`。
- 面板开着、标签已经放上，却被 Latch 页面的菜单、对话框或「选取元素」定格时返回 `panel-covered`，说是什么挡着。
- 列标签、关标签、控制台、网络与视口不需要画面。

### Agent 的输入不是人的手势

- Agent 动作期间及之后 1 秒，标签的手势记录被清空、不记新的，网页因此打不开弹窗与系统浏览器。
- **标签留在本机。** 同一时段，以及这一轮里 Agent 动过的标签在这一轮剩下的时间里（人接手的除外），主框架去非本机地址的导航与重定向一律拦下，所以网页用定时器晚些再跳走也不行。
- 后退、前进只去本机地址的历史条目；`browser_wait` 每一步都核对标签还在本机地址上。

### 接手与交还

- 人按「接手」，或在这一轮 Agent 用过的标签上于 Agent 动作之外真实点按、按键，都算接手（`control: 'person'`）。
- 接手立即中止这个标签上正在执行的调用：每次送输入前都再看一次谁在操作。还没送出任何输入的回 `taken-over`（broker 接着等），已经送出一部分的回「结果未知」。
- 接手期间 broker 让调用等待，按等你处理计时（不计入工作用时），最多 10 分钟，超时 `taken-over`。
- 「交还给 Agent」后继续，下一条结果说明人操作过这个页面，之前的引用全部作废。
- 一轮结束（`turn-ended`）时接手状态清除；会话归档或删除（`session-ended`）时关掉它的标签。

### 结果里的图片

- 截图作为工具结果的图片交给模型（见 [PLUGIN-DEVELOPMENT](PLUGIN-DEVELOPMENT.md)），存进 Host 的私有附件存储，按附件的规则在任何能读这个会话的设备上打开；工具卡写明截图会发给模型服务。
- 每次请求只再发最近 3 张工具图片（`TOOL_IMAGES_SENT`），更早的结果只带文字与一句说明。
- 模型没有 `vision` 时不提供 `browser_screenshot`。

### 外部 Harness

接受 `mcpServers` 的 ACP Harness 多一个 stdio MCP 服务 `latch-browser`，条件是：在 `session/new`、`session/resume`、`session/load` 或分叉的那一刻，这台 Mac 的桌面端已登记为提供者，且会话有项目。桌面端没开时打开的会话要到下次恢复才有。

- **服务本身。** 命令是 Host 自己 Node 的绝对路径加 `node -e` 的固定源码，参数只有工具网关的套接字路径与令牌文件的路径，`env` 为空，不带 `type`；Agent 的路径上没有 Latch 的文件。它没有自己的工具，只把 `tools/list`、`tools/call` 与 MCP 的取消（`notifications/cancelled`）转给工具网关，除这个 Unix 套接字与令牌文件外不连网络、不读文件。
- 工具、参数 schema 与说明与内置 Harness 的同一份（`BROWSER_TOOL_DEFINITIONS`），图片用 MCP 的 `image` 内容返回。

**令牌 `lbt1.<43 字符>`：**

- 每次为会话打开、恢复、载入或分叉 Agent 的会话时签发一个，同时作废同一进程上一次的；进程退出、会话归档或删除、Host 停止时失效。Host 只存它的 SHA-256，绑定会话与这个进程的生命期。
- 令牌写在工具网关目录里新建的 0600 文件（`<随机>.lbt`）里，服务只拿到这个文件的路径。参数与环境都看得见（`ps` 能列出其他进程的参数与环境），所以令牌不进参数、环境、URL、日志、SSE、快照或审计。
- 服务启动时核对文件是这个用户的、0600、只有一个链接，否则不启动；第一次连网关时读出令牌并立即删掉文件。不在启动时读，因为 Agent 可能先启动一个只做握手的副本，由列出工具的那个副本拿走它。令牌作废时文件一并删除。
- Agent 的输出若回显它，运行时按自己发过的令牌替换掉；`redactSecrets` 与 `@latch/protocol` 的凭据模式都认得 `lbt1.`。

**工具网关**（`apps/host/src/tool-gateway.ts`，另见 [ARCHITECTURE.md](ARCHITECTURE.md)）：

- Host 运行目录（`host.sock` 所在的 0700 目录）里 0700 的 `tools/` 下的 `gateway.sock`（0600）。
- 每行一个请求 `{ id, token, method, params }`，每个请求都核对令牌，令牌不对或已作废时回答错误并断开。
- 浏览器令牌只能用 `tools/list`、`tools/call` 与 `cancel`，其他方法回答错误；不是 JSON 的行（例如 HTTP 请求）不回答直接断开。
- 它不是 API 的入口类别，持有令牌的进程不能当设备用；网页连不到 Unix 套接字。

**调用的规则：**

- **只在运行中的一轮里。** 会话没有正在运行的一轮（两轮之间、停止之后）或这一轮正在停止时，调用不执行，回答原因（`no-turn`、`stopping`）。
- **停止要等结算。** 停止这一轮时，运行时让网关中止这个进程在途的调用，并等它们结算（broker 等主进程最多 5 秒，运行时再留 2 秒余量）之后才确认取消，所以确认之后不会再有点击落下。有调用结果未知或等不到时，会话里写一条「浏览器调用结果未知」。一轮正常结束时还在途的调用同样中止并等待。MCP 的取消与连接断开也中止对应的调用。
- **归档**作废会话的令牌；之后这个进程再调用，得到的原因是会话恢复后再试。取消归档不在同一进程上换新令牌：会话下一次恢复时（新的进程，桌面端开着）重新附加。删除同样作废，不再恢复。
- **同一套规则。** 网关的调用走与内置 Harness 相同的 broker、分级、审计、本机地址、敏感字段、只在看得见的标签上与接手规则；审计 `browser.call` 多一个 `via: 'mcp'`。
- **哪些会话。** 有效工作目录中的 Agent 模式会话，包括我的 Agent 与「通用」的家；Host 每次调用核对目录身份与项目策略，旧助手、只对话与归档会话拒绝。
- **R2 一律拒绝。** 外部 Harness 的会话是完全访问（L3）：R0、R1 直接执行（完全访问是人选的看管程度），照样审计、可接手、可停止。R2 回答 `elevated-refused`，告诉 Agent 请人接手输入；主进程在输入时才认出的敏感字段同样按这条回答。

**对上 Agent 自己的询问：**

- Agent 自己对 MCP 工具的询问仍按 Agent 的询问处理（`advisory`）。
- 运行时把网关的调用对上 Agent 报告的工具行：名字或标题必须正好是 `latch-browser` 的这个工具（`mcp__latch-browser__<工具>`、Codex 的 `latch-browser.<工具>` 或 `latch-browser: <工具>`），参数相同，还没对上过，取最早的那一行；审计因此带上它的 `toolCallId`。
- 只有这样的行恰好一行时，人在 Agent 的询问里的允许才记为 `approvalId`；两个分不清的相同调用都不记。别的 MCP 服务的同名工具（如 `mcp__playwright__browser_click`）对不上。

**哪些 Harness：**

- 经 ACP 的预设与自定义命令都附加。
- Codex 直连经 app-server 每个线程的 `config.mcp_servers` 传入。Codex 可能把线程配置写进它在用户家目录下的会话文件，里面只有套接字与令牌文件的路径，没有令牌。
- pi 不接受 MCP 服务（预设 `skillServer: false`），所以 pi 没有浏览器工具。
- 界面不为任何 Harness 写「支持」，见「测试」里没有验证的部分。

### 手机与其他入口

会话面板的「浏览器」一页（`BrowserTabList.tsx`）每 2 秒读 `GET /link/api/tasks/:id/browser-tabs`（要能读这个会话）：标题、源与路径、加载中、谁在操作；Mac 上的窗口没开时说明。

在手机上看实时画面或操作标签尚未实现：那要把带登录的页面画面传到别的设备，需要单独的安全审阅。

## 测试

| 范围 | 文件 |
| --- | --- |
| 主进程：地址栏、导航、截图上限、标注、快捷键、遮挡、preload 的参数与事件；`agentWorld` 在 happy-dom 上（敏感字段不出值、选择器白名单、被盖住与框架目标、手势、整轮不离本机、接手） | `apps/desktop/test/desktop-browser.test.ts` |
| 面板：版本门槛、标签状态、等待与重试、草稿文字与脱敏 | `apps/web/test/browser-panel.test.ts` |
| broker：没有提供者、先审计再发出、取消等结算、结果未知、`not-local`、接手、分级 | `apps/host/test/browser-broker.test.ts` |
| 路由：只有 `host.sock` 上签过名的设备能登记、截图进模型、标签列表、没有 `vision` 时不提供截图 | `apps/host/test/browser-routes.test.ts` |
| 每次请求只再发最近 3 张工具图片 | `tests/tool-images.test.ts` |
| MCP 服务：参数与环境里没有令牌、令牌文件规则、握手副本、转发与取消 | `packages/harness-acp/test/browser-server.test.ts` |
| 工具网关：套接字与目录权限、令牌逐请求核对、作废、停止等结算、各种拒绝 | `apps/host/test/tool-gateway.test.ts` |
| ACP 会话的浏览器工具、对上 Agent 的询问 | `packages/harness-acp/test/acp.test.ts`、`codex.test.ts`、`pi.test.ts` |
| 假 ACP Agent 经网关、broker 与假提供者 | `apps/host/test/browser-mcp.test.ts` |
| 真实 Electron（`LATCH_ELECTRON_E2E=1`，仅 macOS） | `e2e/desktop-browser.e2e.ts`、`e2e/desktop-browser-agent.e2e.ts`、`e2e/desktop-browser-mcp.e2e.ts`、`e2e/desktop.e2e.ts` |

这些用例不证明：

- 用例里的点击与按键由 `sendInputEvent` 注入，不等于真实的键盘、鼠标与系统焦点；系统级权限提示与真实开发服务的使用需要所有者验收。
- 假 ACP Agent 端到端验证的是通道本身。真实的 Claude Agent、Codex、DeepSeek Harness 等是否调用 `latch-browser`，由所有者用真实 Agent 核对。
- Codex 直连：假的 app-server 不启动 MCP 服务，所以只验证了传入的配置，尚未端到端验证。
