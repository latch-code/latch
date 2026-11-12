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

「浏览器」标签在 Latch 桌面端里显示网页，多半是项目的本地开发服务。本文描述 Electron 主进程一侧（`apps/desktop/src/browser.cjs`）与 preload 暴露的 `latchShell.browser`。

**只在这台 Mac 的桌面端。** 会话面板的「浏览器」页签（`apps/web/src/panel/browser/`）只在桌面端主窗口 `latch://app/` 的页面上出现：`latchShell.browser.protocolVersion` ≥ 2、会话没有归档、会话属于一个项目。浏览器、手机与其他电脑的窗口里只有只读的标签列表（见「Agent 的工具」）。内置 Harness 的 Agent 经 Host 的 broker 操作这些标签；外部 Harness 经 Latch 的 `latch-browser` MCP 服务与工具网关用同一组工具（见「外部 Harness」）。

这是 Chromium 的渲染进程沙箱加上主进程的请求与导航规则，**不是操作系统级的隔离**。来访页面（下称「页面」，区别于 Latch 自己的页面）以这台 Mac 的网络位置运行：和普通浏览器的标签一样，它能访问互联网、局域网设备与本机的其他服务（Latch Host 除外）。每个项目一个内存分区，只把它的 Cookie、存储与缓存同 Latch 自己的页面、其他项目分开。

## 导航

- 顶层只去 http(s) 地址；页面的子框架另可承载自己的 about:、data: 与 blob: 文档。
- 页面自己去私有地址需要用户刚在标签里点过。
- 地址栏的输入：纯端口号是 `http://localhost:<端口>/`；没有协议的本地地址用 http，其他用 https。不提供搜索。

## `latchShell.browser`

`protocolVersion: 3`（3 加了 `takeOver`、`handBack`、`showing`，事件 `opened` 与 `reveal`，状态里的 `opener`、`control`、`activity`）。preload 先检查每个参数的形状，不对时直接回答 `{ ok: false, error: 'invalid' }`，不打扰主进程；主进程再按同样的规则检查一遍。

| 调用 | 参数 | 成功时的回答 |
| --- | --- | --- |
| `open(projectId, sessionId, url?)` | 项目 ID、会话 ID；地址栏文字，省略时是空白标签 | `{ ok, tabId, state }`，`tabId` 形如 `brw_` 加 22 个字符 |
| `list()` |  | `{ ok, tabs }`：窗口里每个标签的 `{ tabId, projectId, sessionId, state }`，按打开的先后 |
| `close(tabId)` |  | `{ ok }` |
| `navigate(tabId, url)` | 地址栏文字 | `{ ok, url }`，`url` 是规范化后的地址 |
| `back`、`forward`、`reload`、`stop(tabId)` |  | `{ ok }` |
| `setBounds(tabId, rect)` | 面板矩形 `{ x, y, width, height }`，页面的 CSS 像素；`null` 隐藏 | `{ ok }` |
| `occlude(tabId, occluded)` | 页面的浮层盖住面板时为 `true` | `{ ok, image }`：隐藏前的最后一帧，没有时为 `null` |
| `focus(tabId)` |  | `{ ok }`；隐藏或被遮挡时 `hidden` |
| `capture(tabId)` |  | `{ ok, image }` |
| `annotate(tabId, point)` | `{ x, y }`，从标签左上角算起的页面 CSS 像素 | `{ ok, target }` |
| `hitTest(tabId, point)` | 同上 | `{ ok, target: { tag, rect } }`：只有标签与矩形 |
| `setViewport(tabId, preset, rotated)` | `fit`（适应面板）、`phone` 390×844、`tablet` 820×1180、`desktop` 1280×800；是否旋转 | `{ ok, viewport, size }` |
| `setColorScheme(tabId, scheme)` | `system`、`light` 或 `dark` | `{ ok, colorScheme }`；连不上调试接口时 `emulation-failed` |
| `logs(tabId)` |  | `{ ok, console, network }`：各自最近 200 条 |
| `zoom(tabId, direction)` | `in`、`out` 或 `reset` | `{ ok, zoom }` |
| `devTools(tabId)` |  | `{ ok }`，开发者工具在自己的窗口里 |
| `clearData(projectId)` |  | `{ ok }`：清除该项目分区的存储、Cookie、缓存、认证缓存与解析缓存 |
| `state(tabId)` |  | `{ ok, state }` |
| `takeOver(tabId)` |  | `{ ok }`：「接手」，Agent 对这个标签的调用等待 |
| `handBack(tabId)` |  | `{ ok }`：「交还给 Agent」，之前交出的元素引用全部作废 |
| `showing(sessionId)` | 会话 ID 或 `null` | `{ ok }`：页面现在显示哪个会话的「浏览器」面板 |
| `subscribe(callback)` |  | 返回取消订阅的函数 |

- `state` 是 `{ url, title, loading, canGoBack, canGoForward, zoom, crashed, error, viewport, colorScheme, logs, opener, control, activity }`；`opener` 是 `person` 或 `agent`，`control` 是 `agent`（Agent 的动作正在执行）、`person`（人接手了）或 `null`，`activity` 是主进程写的「正在点击「保存」」；`viewport` 是 `{ preset, rotated }`，`logs` 是这个文档以来的 `{ errors, warnings, failed }`；`error` 是主框架最近一次加载失败的 Chromium 网络错误码，没有时为 `null`。地址超过 8192 个字符时去掉查询再去掉路径，标题去掉控制与双向字符、不超过 256 个字符。
- `subscribe` 送来六种事件：`{ type: 'state', tabId, state }`（同一标签最多每 32 毫秒一次）、`{ type: 'notice', tabId, notice, detail? }`、`{ type: 'hidden', tabId }`（主进程把它藏起来了，页面要重新放置）、`{ type: 'closed', tabId }`、`{ type: 'opened', tabId, projectId, sessionId, state }`（窗口里新开了标签，不论哪个页面或 Agent 开的，「其他会话的标签」因此一直是全的）与 `{ type: 'reveal', tabId }`（Agent 要用这个标签，显示这个会话的面板切到它）。preload 丢弃形状不对的事件。
- 图片是 `{ type: 'image/png', width, height, data }`，`data` 为 `Uint8Array`。截图与定格画面每边不超过 4096 像素、不超过 5 MiB（附件对图片的上限），放不下时按比例缩小。
- 失败时为 `{ ok: false, error }`：`emulation-failed`、`shell-refused`（不是主窗口的顶层页面）、`not-found`、`unavailable`（没有窗口）、`tab-limit`、`project-limit`、`invalid-url`、`blocked`（附 `reason`）、`busy`（同一标签的截图或标注还没完成）、`capture-failed`、`no-target`、`hidden`、`clear-failed`。

## 标注

`annotate` 在页面的一个隔离世界里运行固定的脚本：取该点的元素，为它生成选择器（页面里唯一的 id，否则逐级的标签、最多两个类名与 `:nth-of-type`，最多八级、512 个字符），取它的可见文字（跳过脚本与样式；没有文字时用 `aria-label`、`alt`、`title` 或 `placeholder`；从不读取表单的值）与它的矩形。页面仍然决定该点是哪个元素（可以盖一层透明的元素）以及它的属性、文字和矩形，所以回答只说明页面呈现了什么，不能当作可信内容。脚本只读不写，也不在页面里留下任何东西。主进程再检查一遍回答的形状与长度，去掉控制与双向字符，文字截到 200 个字符；3 秒内没有回答即为 `no-target`。

`target` 是 `{ url, tag, selector, text, rect, image }`：`rect` 换算回调用时的单位（从标签左上角算起的页面 CSS 像素），`image` 是元素周围 8 像素内的截图，每边不超过 1600 像素、不超过 2 MiB。

## 遮挡、焦点与快捷键

- 原生视图画在页面之上，会盖住页面的菜单、命令面板、设置、对话框与提示。页面打开这样的浮层时调用 `occlude(tabId, true)`：主进程先截下当前画面，再隐藏视图，页面把这一帧放在原处，浮层关闭后调用 `occlude(tabId, false)`。面板宽度的动画期间同样处理。控件的提示（`role="tooltip"`）不算浮层：它只是悬停时的几个字，落在画面上的部分画在视图下面；否则指针停在「加入对话」上，画面就一直定格，Agent 的点击、输入与截图也都被拒绝。
- 隐藏或被遮挡的标签若有键盘焦点，焦点交还页面。页面的新文档真正提交（`did-navigate`）或渲染进程退出时，标签不关闭：全部隐藏、交还焦点、发 `hidden`，新页面经 `list` 取回，按会话放回面板；被拒绝的导航不隐藏任何标签。没放在面板上的标签静音。Host 报告会话已归档或已删除（完整列表里不再有它，且这台设备能看到全部会话）时，页面关闭这个会话的标签；窗口关闭时全部关闭；标签的页面自己关闭时，页面收到 `closed`。
- 标签有焦点时，应用的快捷键 ⌘K、⌘J、⌘B、⌥⌘B 与 ⌘,（其他系统上 Ctrl 代替 ⌘）由主进程在 `before-input-event` 截下，页面收不到；主进程把焦点交还页面，再把同样的按键送给页面。其他按键留给页面。

## 视口、外观、控制台与网络

- **视口。** 预设用 `enableDeviceEmulation` 按预设尺寸排版（手机与平板按移动设备），再按视图大小缩小，从不放大；页面把视图放在画布正中，下面写「390 × 844 · 75%」。旋转对调宽高。新文档沿用。
- **外观。** 只在选了浅色或深色时，主进程连上这个标签自己的 `webContents.debugger`，只发 `Emulation.setEmulatedMedia`（`prefers-color-scheme`）；「跟随系统」清除模拟并断开。调试接口被占用（例如开发者工具）时回答 `emulation-failed`，被断开时标签回到跟随系统。
- **控制台。** `console-message` 每条去掉控制字符、格式字符（双向、零宽、软连字符、Unicode 标签）、其他默认可忽略的字符（变体选择符）与行、段分隔符，截到 500 个字符，记来源的源与路径；每个标签在环形缓冲里保留最新 500 条，计数随进出增减，每条带递增的序号（抽屉按序号选择）。只因为是 Latch 的预览才出现的两条警告（Chromium 关于 Latch 加给每个文档的沙箱的警告、Electron 未打包时的不安全 CSP 警告）按原文精确匹配后不记，也不计数。
- **网络。** 分区的 `webRequest.onCompleted` 与 `onErrorOccurred`：方法、源与路径（不带查询）、类型、状态或错误名、耗时、`Content-Length`；从不记请求头、Cookie 与正文。每个标签保留最新 500 条。被拦下的请求（例如去 Host）记为 `ERR_BLOCKED_BY_CLIENT`。
- 主框架开始新文档时两张表清空。

## 模型网关

模型网关的回环端口由 Host 经 `host-info`（只在 `host.sock` 上）的 `modelGatewayPort` 告诉主进程，主进程把它同 Host 的监听端口一起拦下，标签的页面连不上它。

## 界面

`apps/web/src/panel/browser/`：会话面板的「浏览器」页签，排在「终端」之后、「交付」之前；启动面板一行「浏览器」（字母键 B），⇧⌘B 开关，命令面板也有。

- **标签条**（`PanelTabs`）：这个会话的标签，标题或 `localhost:5173`，加载中是转圈；行尾「+」，窗口满 8 个标签时停用；窗口里有其他会话的标签时多一个「其他会话的标签 · N」菜单，可逐个或全部关闭。已结束会话的标签随会话关闭，不占名额。
- **工具行**（32 高）：后退、前进、重新载入（加载中是停止）、地址栏「网址或 localhost 端口」（在当前标签打开，没有标签时新开）、视口菜单与旋转、外观菜单、截图、选取元素（⇧⌘S）、⋯（缩放、开发者工具、在系统浏览器中打开、清除这个项目的浏览数据）。面板窄于 480 时视口与外观收进 ⋯。选中用墨色。
- **空白页**：这个会话终端里检测到的本地服务、这个项目在本设备最近打开的 5 个地址（只记源与路径，存在本机）；都没有时一行「终端里的本地服务会列在这里」。
- **截图**：`capture` 的 PNG 作为图片附件放进草稿，不发送。
- **选取元素**：先 `occlude` 定格，页面在原处显示这一帧；鼠标移动时每 80 ms 一次 `hitTest`，画 2px 墨色框；点击时 `annotate`，草稿里加一段「元素 · button「保存」（页面提供的内容）」（页面、选择器、标签、文字、尺寸，先脱敏），裁剪图由页面从定格的帧上裁出、作为附件。⇧ 点击可再选，最多 5 个；Esc 结束。点击发生在 Latch 的页面上，网页收不到这次点击；但文字与选择器是点击那一刻从实时页面读的，图片来自定格的帧，网页可以在两者之间改动 DOM。页面返回的元素框不再覆盖点击的位置时，只加入点击处的截图，并提示「页面在选取时变了」。
- **底行**（28 高）：「控制台 2 个错误 · 网络 1 个失败」（错误与失败红色、警告琥珀），点开是面板下部的抽屉（「控制台 | 网络」，每秒读一次 `logs`）；「加入对话」把选中的条目或最近 20 条错误作为文本块放进草稿，先按 `@latch/protocol` 的凭据模式脱敏。抽屉显示的与放进草稿的是同一段文字：隐藏字符都经 `escapeSecurityText` 写成 `\u{XXXX}`，元素标题里的摘录也一样。行尾 ⓘ「内存分区，不是沙箱」。
- **状态**：加载失败写「连不上 localhost:5173（ERR_…）」加「重新载入」；本机地址被拒绝连接时写「等待 localhost:5173…」，面板可见期间每 2 秒重新载入，最多 60 秒；页面崩溃写「页面崩溃了」。这些时候视图隐藏。页面自己的浮层（菜单、对话框、设置页等）盖住画布时视图隐藏，最后一帧代替它。被拦下的下载、弹窗、权限与导航在工具行下一行提示，4 秒后消失。
- **终端的本地服务**：终端行尾的链接在这里新开标签；⌘ 点按仍去系统浏览器。

## Agent 的工具

内置 Harness 的 Agent 有 16 个浏览器工具（`apps/host/src/plugins/tools/browser/`）：`browser_tabs`、`browser_open`、`browser_navigate`、`browser_read`（可访问性树，元素引用如 `e12`）、`browser_find`、`browser_screenshot`、`browser_scroll`、`browser_viewport`、`browser_console`、`browser_network`、`browser_wait`、`browser_click`、`browser_key`、`browser_select`、`browser_type`、`browser_close`。没有执行任意脚本、读 Cookie、开发者工具或清除数据的工具。

**通道。** 主进程（`browser-agent.cjs`）在主窗口存在时向自己的 Host 登记为浏览器提供者：经 `host.sock` 取 `POST /link/api/browser-provider/nonce`（与添加文件夹同一种单次 nonce），再 `POST …/register`，正文 `{ nonce, purpose: 'browser-provider' }` 用设备私钥签名，得到 `providerId`；然后 `POST …/stream`（SSE）收 `call`、`cancel`、`session-ended`、`turn-ended` 与心跳。结果 `POST …/results`（JSON ≤ 1 MiB，带 `dispatched`），截图先 `PUT …/results/:callId/image`（PNG ≤ 5 MiB）。标签表 `POST …/tabs` 每秒最多一次，谁在操作变化时立即报；只有标题、源与路径（不带查询）、加载中、谁在操作、谁开的，只在 Host 内存里。这组路由只收 `host.sock` 上、在 `host.sock` 登记的设备；主进程的代理对页面发往 `/link/api/browser-provider/*` 的请求回答 403 `shell-managed`。同一时间一个提供者，新登记结束旧的流；窗口关闭即结束流。

**broker**（`apps/host/src/browser-broker.ts`）。没有提供者时调用立即失败（`browser-unavailable`，「这台 Mac 上的 Latch 窗口没有打开」），不排队，Host 从不启动桌面端。标签不是这个会话的为 `not-found`；标签或目标地址不在本机地址上时，除列标签与关标签外都拒绝（`not-local`）。本机地址在 broker 与主进程里是同一组：localhost、`*.localhost`、127/8、::1 与 IPv4 映射的 127/8（`::ffff:127.x.x.x`）；0.0.0.0 与 :: 不算；空白页算。先写审计 `browser.call`（会话、调用 ID、工具、标签 ID、源的类别 loopback / private / internet / none、源的 SHA-256、风险、运行时的工具调用 ID `toolCallId`，问过人时还有审批 ID `approvalId`），写入失败不发出；`approval.decided` 同样记 `toolCallId`，两条记录由此对上。输入的文字、选择器与地址都不进审计。另记 `browser.provider.registered` 与 `ended`。每个会话同一时间一个调用；截止默认 15 秒，打开、导航与等待 30 秒。停止（任何能取消这一轮的设备）或超时后发 `cancel`，主进程停下等待或加载并回报，Host 这时才结算；5 秒内不回报或提供者中途断开时，读类调用失败，动作为「结果未知」（`result-unknown`）。

**分级**（`classifyBrowserCall`）。看是 R0，动（打开、导航、点击、按键、选择、输入）是 R1，关 Agent 开的标签 R0、人开的 R1；往密码框、`autocomplete` 为 `current-password`、`new-password`、`one-time-code`、`cc-*` 的字段或隐藏字段输入是 R2，没读到过的引用也按 R2。分级不看标签现在在哪（分级与执行之间它可以变）；不在本机地址上的调用由 broker 拒绝，所以「本会话始终允许」带不到别的地址。调用带着批准时的分级去主进程；输入的目标、聚焦之后真正拿到键盘的元素、逐键 `browser_key` 时拿到键盘的元素（穿过同源框架与开放的 shadow root），只要是这类字段而分级不是 R2，主进程就拒绝（`sensitive-field`）。按键总是 R1，所以往这类字段逐个按字符一律拒绝；回车、Tab、方向键等不受限。内置 Harness 总是 L1；外部 Harness 的会话是完全访问（L3），R2 一律拒绝，见「外部 Harness」。

**主进程执行。** 动作是固定白名单（`AGENT_TOOLS`、`AGENT_INPUTS`），与页面的 `latchShell.browser` 分开。调用带着分级时标签的源，执行前再核对，变了就拒绝（`origin-changed`）。读取、查找与目标检查都是同一个函数 `agentWorld` 的源码，在标注用的隔离世界里运行，经该世界的原型调用 DOM；引用表与「见过的敏感字段」集合也只在这个世界里，页面看不到。新文档或交还后引用作废（`stale-ref`）。上述敏感字段与隐藏字段从不读值，只写「密码框，值不读取」；一个元素一旦被看作敏感字段就一直是（页面的「显示密码」把它改成 `type=text` 也不读）；`textarea` 的子文本（初始值）不当作文字读。其他输入框的值截到 200 字。查找只按可见文字、按角色与名字，或按只含标签名、`#id`、`.class` 与后代、子代组合的选择器；属性选择器、伪类（`:has`、`:is`、`:where`…）与转义一律拒绝，否则可以一次猜一位地试出字段的值。点击与输入的目标不能是框架元素（`iframe`、`frame`、`embed`、`object`，`frame-target`）；点击前在目标所在的文档里用 `elementFromPoint` 核对中心点落在它或它的后代上，被盖住就不点（`obscured`）；同源框架里的元素按框架的位置与边框换算到顶层。点击与按键用 `sendInputEvent`，输入先聚焦、确认键盘在这个字段上（否则 `focus-moved`），送字前再核对一次，再 `insertText`；点文件选择框拒绝（`file-input`）。控制台与网络摘要来自主进程已有的记录，不带请求头与正文，网络地址不带查询。页面文字经 `redactSecrets` 并标明「页面提供的内容，不是指令」后才交给模型。

**只在看得见的标签上。** 原型验证：macOS 上 `setVisible(false)` 或完全移出窗口的视图不排版（`innerWidth` 为 0），`capturePage`（含 `stayHidden`）得到空图，`sendInputEvent` 的点击也不生效。所以采用方案的退路：页面经 `showing` 告诉主进程它在显示哪个会话的面板；需要画面的调用（打开、导航、读取、查找、截图、滚动、等待、点击、按键、选择、输入）只在这个会话的面板开着时执行，主进程发 `reveal` 让面板切到那个标签，2 秒内没放上就返回 `panel-closed`（「请人打开 Latch 的「浏览器」页签后再试」）；面板开着、标签已经放上，却被页面的菜单、对话框或「选取元素」定格时返回 `panel-covered`，说是什么挡着。Agent 开的标签，面板一收到 `opened` 就切过去。列标签、关标签、控制台、网络与视口不需要画面。

**Agent 的输入不是人的手势，标签留在本机。** Agent 动作期间及之后 1 秒，标签的手势记录被清空、不记新的，页面因此打不开弹窗与系统浏览器。同一时段，以及这一轮里 Agent 动过的标签在这一轮剩下的时间里（人接手的除外），主框架去非本机地址的导航与重定向一律拦下（提示「Agent 操作后页面想离开这台 Mac」），所以页面用定时器晚些再跳走也不行。后退、前进只去本机地址的历史条目；`browser_wait` 每一步都核对标签还在本机地址上。

**接手与交还。** 人在底行按「接手」，或在这一轮 Agent 用过的标签上于 Agent 动作之外真实点按、按键，都算接手（`control: 'person'`）。接手立即中止这个标签上正在执行的调用：每次送输入前都再看一次谁在操作，还没送出任何输入的回 `taken-over`（broker 接着等），已经送出一部分的回「结果未知」。接手期间 broker 让调用等待，按等你处理计时（不计入工作用时），最多 10 分钟，超时 `taken-over`。「交还给 Agent」后继续，下一条结果写「人操作过这个页面」，之前的引用全部作废。一轮结束（`turn-ended`）时接手状态清除；会话归档或删除（`session-ended`）时关掉它的标签。界面：Agent 开的或正在操作的标签带单色 Agent 标记；Agent 动作时底行是转圈、`activity` 与「接手」，画布外一圈 2px 墨色；接手后底行写「你在操作」与蓝色主按钮「交还给 Agent」。

**结果里的图片。** 截图作为工具结果的图片交给模型（见 [PLUGIN-DEVELOPMENT](PLUGIN-DEVELOPMENT.md)），存进 Host 的私有附件存储；工具卡里是附件按钮与「截图会发给模型服务」，按附件的规则在任何能读这个会话的设备上打开。每次请求只再发最近 3 张工具图片，更早的结果只带文字与一句「截图较早，已不再发送」。模型没有 `vision` 时不提供 `browser_screenshot`。

**外部 Harness。** 接受 `mcpServers` 的 ACP Harness，在 `session/new`、`session/resume`、`session/load` 与分叉的那一刻、这台 Mac 的桌面端已登记为提供者且会话有项目时，多一个 stdio MCP 服务 `latch-browser`（桌面端没开时打开的会话要到下次恢复才有）（`packages/harness-acp/src/browser-server.ts`）：命令是 Host 自己 Node 的绝对路径加 `node -e` 的固定源码，参数只有工具网关的套接字路径与令牌文件的路径，`env` 为空，不带 `type`；Agent 的路径上没有 Latch 的文件。它没有自己的工具，只把 `tools/list`、`tools/call` 与 MCP 的取消（`notifications/cancelled`）转给 Host 的**工具网关**，除这个 Unix 套接字与令牌文件外不连网络、不读文件。工具、参数 schema 与说明与内置 Harness 的同一份（`BROWSER_TOOL_DEFINITIONS`），图片用 MCP 的 `image` 内容返回。
- **令牌 `lbt1.<43 字符>`。** 每次为会话打开、恢复、载入或分叉 Agent 的会话时签发一个，同时作废同一进程上一次的；进程退出、会话归档或删除、Host 停止时失效。Host 只存它的 SHA-256，绑定会话与这个进程的生命期。令牌写在工具网关目录里新建的 0600 文件（`<随机>.lbt`）里，服务只拿到这个文件的路径：参数与环境都看得见（`ps` 能列出其他进程的参数，`ps eww` 能列出环境；Claude 的 SDK 可能把 `mcpServers` 放进子进程的参数），所以令牌不进参数、环境、URL、日志、SSE、快照或审计。服务启动时核对文件是这个用户的、0600、只有一个链接，否则不启动；第一次连网关时读出令牌并立即删掉文件。不在启动时读，因为 Agent 可能先启动一个只做握手的副本（DeepSeek Harness 先问一个副本 `server/discover`），由列出工具的那个副本拿走它。令牌作废时文件一并删除。Agent 的输出若回显它，运行时按自己发过的令牌替换掉；`redactSecrets` 与 `@latch/protocol` 的凭据模式都认得 `lbt1.`。
- **工具网关**（`apps/host/src/tool-gateway.ts`）：Host 运行目录（`host.sock` 所在的 0700 目录，路径短，放得下 Unix 套接字）里 0700 的 `tools/` 下的 `gateway.sock`（0600）。每行一个请求 `{ id, token, method, params }`，每个请求都核对令牌，令牌不对或已作废时回答错误并断开；只收 `tools/list`、`tools/call` 与 `cancel`，其他行（例如 HTTP 请求）不回答直接断开。它不是 API 的入口类别，持有令牌的进程不能当设备用；网页连不到 Unix 套接字。
- **只在运行中的一轮里。** 会话没有正在运行的一轮（两轮之间、停止之后）或这一轮正在停止时，调用不执行，回答原因（`no-turn`、`stopping`）。停止这一轮时，运行时让网关中止这个进程在途的调用，并等它们结算（broker 等主进程最多 5 秒，运行时再留 2 秒余量）之后才确认取消，所以确认之后不会再有点击落下；有调用结果未知或等不到时，会话里写一条「浏览器调用结果未知」。一轮正常结束时还在途的调用同样中止并等待。
- **归档。** 归档作废会话的令牌；之后这个进程再调用，得到的原因是「会话恢复（Agent 进程重新启动）后再试」。取消归档不在同一进程上换新令牌：Agent 进程空闲停止后，会话下一次恢复时（新的进程，桌面端开着）重新附加。删除同样作废，不再恢复。
- **执行。** 网关的调用走与内置 Harness 相同的 broker、分级、审计、本机地址、敏感字段、只在看得见的标签上与接手规则；审计 `browser.call` 多一个 `via: 'mcp'`。只给有项目的会话（我的 Agent 与「通用」的会话不附加这个服务，Host 每次调用再核对）。外部 Harness 的会话是完全访问（L3）：R0、R1 直接执行（完全访问是人选的看管程度），照样审计、可接手、可停止；R2（往密码、验证码、卡号或隐藏字段输入，或往没读到过的引用输入）一律拒绝（`elevated-refused`，告诉 Agent「请人接手输入」），主进程在输入时才认出的敏感字段同样按这条回答。Agent 自己对 MCP 工具的询问仍按 Agent 的询问处理（`advisory`）；运行时把网关的调用对上 Agent 报告的工具行：名字或标题必须正好是 `latch-browser` 的这个工具（`mcp__latch-browser__<工具>`、Codex 的 `latch-browser.<工具>` 或 `latch-browser: <工具>`），参数相同，还没对上过，取最早的那一行；审计因此带上它的 `toolCallId`。只有这样的行恰好一行时，人在 Agent 的询问里的允许才记为 `approvalId`，两个分不清的相同调用都不记；别的 MCP 服务的同名工具（如 `mcp__playwright__browser_click`）对不上。MCP 的取消与连接断开也中止对应的调用。
- **哪些 Harness。** 经 ACP 的预设与自定义命令都附加；Codex 直连经 app-server 每个线程的 `config.mcp_servers` 传入，已接线，但假的 app-server 不启动 MCP 服务，所以只验证了传入的配置，尚未端到端验证；Codex 可能把线程配置写进它在用户家目录下的会话文件，里面只有套接字与令牌文件的路径，没有令牌。pi 不接受 MCP 服务（预设 `skillServer: false`，它的 RPC 模式拒绝 `mcpServers`），所以 pi 没有浏览器工具。界面不为任何 Harness 写「支持」：假 ACP Agent 端到端验证的是这条通道本身，真实的 Claude Agent、Codex、DeepSeek Harness 等是否调用 `latch-browser`，由所有者用真实 Agent 核对。

**手机与其他入口。** 会话面板的「浏览器」一页（`BrowserTabList.tsx`）每 2 秒读 `GET /link/api/tasks/:id/browser-tabs`（要能读这个会话）：标题、源与路径、「加载中 / Agent 在操作 / 你在 Mac 上操作」；Mac 上的窗口没开时写「Mac 上的 Latch 窗口没有打开」。在手机上看实时画面或操作标签尚未实现：那要把带登录的页面画面传到别的设备，需要单独的安全审阅。

## 测试

- `apps/desktop/test/desktop-browser.test.ts`：地址栏、导航、输入形状、视图位置、截图上限、标注回答、快捷键转发、遮挡与 preload 的参数和事件。
- `e2e/desktop.e2e.ts` 的「drives preview tabs from the page…」在真实的 Electron 里从页面调用 `latchShell.browser`。
- `apps/web/test/browser-panel.test.ts`：版本门槛、启动面板与 ⇧⌘B、标签状态、等待与重试、预设的放置、底行、草稿文字与脱敏、最近地址。
- `apps/host/test/browser-broker.test.ts`：没有提供者、先审计再发出（带 `toolCallId` 与 `approvalId`）、取消等结算、断开后结果未知、`not-local`、本机地址的范围、接手的等待与超时、分级。`tests/tool-images.test.ts`：每次请求只再发最近 3 张工具图片。`apps/host/test/browser-routes.test.ts`：只有 `host.sock` 上签过名的设备能登记、截图进工具行与模型、手机的标签列表、没有 `vision` 时不提供截图、敏感字段的分级。
- `apps/desktop/test/desktop-browser.test.ts` 的「the Agent in the preview browser」：真实的 `agentWorld` 在 happy-dom 的页面上运行（密码框、验证码、隐藏字段不出值，改成 `type=text` 之后也不出；按文字找不到值）；动作白名单与只收标签名、id、class 的选择器；往密码框逐键与聚焦被挪走时拒绝；被盖住与框架目标不点；Agent 输入不算手势、整轮离不开本机、历史条目与等待中的跳走；接手中止进行中的输入（结果未知）；只在看得见的标签上；本机地址与 broker 同一组；提供者的登记与结果顺序。
- `e2e/desktop-browser-agent.e2e.ts`（`LATCH_ELECTRON_E2E=1`，仅 macOS）：假模型驱动内置 Harness 打开、读取、点击、输入、截图进工具卡；人往密码框输入的值与隐藏字段不出现在任何结果里；非本机导航被拒；接手时调用等待，交还后继续且旧引用作废；手机上的工具卡与标签列表。
- 外部 Harness：`packages/harness-acp/test/browser-server.test.ts`（stdio 上的 MCP 服务：参数与环境里没有令牌、令牌文件不在或不私有时不启动、握手副本不拿令牌、列工具后文件删除、转发、取消、网关不在时）；`apps/host/test/tool-gateway.test.ts`（套接字与目录权限、只有 Unix 套接字、令牌只存哈希并逐个请求核对、错的旧的已结束会话的令牌被拒、非本协议的请求被断开、取消与断开中止调用、停止后等调用结算并说结果未知、令牌文件 0600 且随作废删除、归档的原因、`gatewayRefusal` 对归档、我的 Agent、私有、通用对话、非 L3 与不在一轮里的拒绝）；`packages/harness-acp/test/acp.test.ts` 的「the browser tools for ACP sessions」（只有路径、进程结束时作废、恢复与清空上下文时换新、桌面端没开时不附加、对上 Agent 的询问、两个相同调用与别的服务的同名工具不记审批、停止等结算并写结果未知、我的 Agent 的会话没有）；`codex.test.ts`（Codex 线程的 `mcp_servers`）；`pi.test.ts`（pi 不签发令牌）；`apps/host/test/browser-mcp.test.ts`（假 ACP Agent 经网关、broker 与假提供者读取、点击、输入，审计 `via: 'mcp'` 带审批 ID，密码框被拒；提供者慢时停止等它结算才确认；两轮之间被拒；归档与删除作废令牌）；`e2e/desktop-browser-mcp.e2e.ts`（`LATCH_ELECTRON_E2E=1`，仅 macOS：真实桌面端上假 ACP Agent 经 `latch-browser` 打开、读取、在自己询问后点击、输入、截图，往密码框输入被拒，非本机导航被拒）。
- `e2e/desktop-browser.e2e.ts`（`LATCH_ELECTRON_E2E=1`，仅 macOS）：本地夹具网站上的视口、外观、截图与选取元素进草稿、控制台与网络抽屉、模型网关端口被拦、遮挡、加载、等待开发服务、失败、重新载入后标签回来。

这些用例里的点击与按键由 `sendInputEvent` 注入，不等于真实的键盘、鼠标与系统焦点；系统级权限提示与真实开发服务的使用体验需要在界面接入后由所有者验收。
