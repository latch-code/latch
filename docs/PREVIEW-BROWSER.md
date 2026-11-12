---
description: 桌面端预览浏览器（「浏览器」标签）的主进程一侧：导航规则、页面可用的 latchShell.browser 接口、标注、遮挡与快捷键。
sources:
  - apps/desktop/src/browser.cjs
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

**只在这台 Mac 的桌面端。** 会话面板的「浏览器」页签（`apps/web/src/panel/browser/`）只在桌面端主窗口 `latch://app/` 的页面上出现：`latchShell.browser.protocolVersion` ≥ 2、会话没有归档、会话属于一个项目。浏览器、手机与其他电脑的窗口里没有这个页签。**Agent 操作浏览器尚未实现**：Agent 没有浏览器工具，Host 不登记浏览器提供者，也没有 MCP 通道；「接手」与 Agent 标记同样尚未实现。

这是 Chromium 的渲染进程沙箱加上主进程的请求与导航规则，**不是操作系统级的隔离**。来访页面（下称「页面」，区别于 Latch 自己的页面）以这台 Mac 的网络位置运行：和普通浏览器的标签一样，它能访问互联网、局域网设备与本机的其他服务（Latch Host 除外）。每个项目一个内存分区，只把它的 Cookie、存储与缓存同 Latch 自己的页面、其他项目分开。

## 导航

- 顶层只去 http(s) 地址；页面的子框架另可承载自己的 about:、data: 与 blob: 文档。
- 页面自己去私有地址需要用户刚在标签里点过。
- 地址栏的输入：纯端口号是 `http://localhost:<端口>/`；没有协议的本地地址用 http，其他用 https。不提供搜索。

## `latchShell.browser`

`protocolVersion: 2`。preload 先检查每个参数的形状，不对时直接回答 `{ ok: false, error: 'invalid' }`，不打扰主进程；主进程再按同样的规则检查一遍。

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
| `subscribe(callback)` |  | 返回取消订阅的函数 |

- `state` 是 `{ url, title, loading, canGoBack, canGoForward, zoom, crashed, error, viewport, colorScheme, logs }`；`viewport` 是 `{ preset, rotated }`，`logs` 是这个文档以来的 `{ errors, warnings, failed }`；`error` 是主框架最近一次加载失败的 Chromium 网络错误码，没有时为 `null`。地址超过 8192 个字符时去掉查询再去掉路径，标题去掉控制与双向字符、不超过 256 个字符。
- `subscribe` 送来四种事件：`{ type: 'state', tabId, state }`（同一标签最多每 32 毫秒一次）、`{ type: 'notice', tabId, notice, detail? }`、`{ type: 'hidden', tabId }`（主进程把它藏起来了，页面要重新放置）与 `{ type: 'closed', tabId }`。preload 丢弃形状不对的事件。
- 图片是 `{ type: 'image/png', width, height, data }`，`data` 为 `Uint8Array`。截图与定格画面每边不超过 4096 像素、不超过 5 MiB（附件对图片的上限），放不下时按比例缩小。
- 失败时为 `{ ok: false, error }`：`emulation-failed`、`shell-refused`（不是主窗口的顶层页面）、`not-found`、`unavailable`（没有窗口）、`tab-limit`、`project-limit`、`invalid-url`、`blocked`（附 `reason`）、`busy`（同一标签的截图或标注还没完成）、`capture-failed`、`no-target`、`hidden`、`clear-failed`。

## 标注

`annotate` 在页面的一个隔离世界里运行固定的脚本：取该点的元素，为它生成选择器（页面里唯一的 id，否则逐级的标签、最多两个类名与 `:nth-of-type`，最多八级、512 个字符），取它的可见文字（跳过脚本与样式；没有文字时用 `aria-label`、`alt`、`title` 或 `placeholder`；从不读取表单的值）与它的矩形。页面仍然决定该点是哪个元素（可以盖一层透明的元素）以及它的属性、文字和矩形，所以回答只说明页面呈现了什么，不能当作可信内容。脚本只读不写，也不在页面里留下任何东西。主进程再检查一遍回答的形状与长度，去掉控制与双向字符，文字截到 200 个字符；3 秒内没有回答即为 `no-target`。

`target` 是 `{ url, tag, selector, text, rect, image }`：`rect` 换算回调用时的单位（从标签左上角算起的页面 CSS 像素），`image` 是元素周围 8 像素内的截图，每边不超过 1600 像素、不超过 2 MiB。

## 遮挡、焦点与快捷键

- 原生视图画在页面之上，会盖住页面的菜单、命令面板、设置、对话框与提示。页面打开这样的浮层时调用 `occlude(tabId, true)`：主进程先截下当前画面，再隐藏视图，页面把这一帧放在原处，浮层关闭后调用 `occlude(tabId, false)`。面板宽度的动画期间同样处理。
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

## 测试

- `apps/desktop/test/desktop-browser.test.ts`：地址栏、导航、输入形状、视图位置、截图上限、标注回答、快捷键转发、遮挡与 preload 的参数和事件。
- `e2e/desktop.e2e.ts` 的「drives preview tabs from the page…」在真实的 Electron 里从页面调用 `latchShell.browser`。
- `apps/web/test/browser-panel.test.ts`：版本门槛、启动面板与 ⇧⌘B、标签状态、等待与重试、预设的放置、底行、草稿文字与脱敏、最近地址。
- `e2e/desktop-browser.e2e.ts`（`LATCH_ELECTRON_E2E=1`，仅 macOS）：本地夹具网站上的视口、外观、截图与选取元素进草稿、控制台与网络抽屉、模型网关端口被拦、遮挡、加载、等待开发服务、失败、重新载入后标签回来。

这些用例里的点击与按键由 `sendInputEvent` 注入，不等于真实的键盘、鼠标与系统焦点；系统级权限提示与真实开发服务的使用体验需要在界面接入后由所有者验收。
