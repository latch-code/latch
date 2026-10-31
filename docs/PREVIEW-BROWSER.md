---
description: 桌面端预览浏览器（「浏览器」标签）的主进程一侧：导航规则、页面可用的 latchShell.browser 接口、标注、遮挡与快捷键。
sources:
  - apps/desktop/src/browser.cjs
  - apps/desktop/src/preload.cjs
  - apps/desktop/src/main.cjs
  - apps/desktop/test/desktop-browser.test.ts
  - e2e/desktop.e2e.ts
---
# 预览浏览器

「浏览器」标签在 Latch 桌面端里显示网页，多半是项目的本地开发服务。本文描述 Electron 主进程一侧（`apps/desktop/src/browser.cjs`）与 preload 暴露的 `latchShell.browser`。

**界面尚未实现。** 右侧面板的浏览器标签、地址栏、截图与标注的输入框标签尚未实现；目前没有页面调用这些接口，用户还看不到这个功能。浏览器里（非桌面端）没有这个能力。Agent 操作浏览器（光标与「接手」）也尚未实现。

这是 Chromium 的渲染进程沙箱加上主进程的请求与导航规则，**不是操作系统级的隔离**。来访页面（下称「页面」，区别于 Latch 自己的页面）以这台 Mac 的网络位置运行：和普通浏览器的标签一样，它能访问互联网、局域网设备与本机的其他服务（Latch Host 除外）。每个项目一个内存分区，只把它的 Cookie、存储与缓存同 Latch 自己的页面、其他项目分开。

## 导航

- 顶层只去 http(s) 地址；页面的子框架另可承载自己的 about:、data: 与 blob: 文档。
- 页面自己去私有地址需要用户刚在标签里点过。
- 地址栏的输入：纯端口号是 `http://localhost:<端口>/`；没有协议的本地地址用 http，其他用 https。不提供搜索。

## `latchShell.browser`

`protocolVersion: 1`。preload 先检查每个参数的形状，不对时直接回答 `{ ok: false, error: 'invalid' }`，不打扰主进程；主进程再按同样的规则检查一遍。

| 调用 | 参数 | 成功时的回答 |
| --- | --- | --- |
| `open(projectId, url?)` | 项目 ID；地址栏文字，省略时是空白标签 | `{ ok, tabId, state }`，`tabId` 形如 `brw_` 加 22 个字符 |
| `close(tabId)` |  | `{ ok }` |
| `navigate(tabId, url)` | 地址栏文字 | `{ ok, url }`，`url` 是规范化后的地址 |
| `back`、`forward`、`reload`、`stop(tabId)` |  | `{ ok }` |
| `setBounds(tabId, rect)` | 面板矩形 `{ x, y, width, height }`，页面的 CSS 像素；`null` 隐藏 | `{ ok }` |
| `occlude(tabId, occluded)` | 页面的浮层盖住面板时为 `true` | `{ ok, image }`：隐藏前的最后一帧，没有时为 `null` |
| `focus(tabId)` |  | `{ ok }`；隐藏或被遮挡时 `hidden` |
| `capture(tabId)` |  | `{ ok, image }` |
| `annotate(tabId, point)` | `{ x, y }`，从标签左上角算起的页面 CSS 像素 | `{ ok, target }` |
| `zoom(tabId, direction)` | `in`、`out` 或 `reset` | `{ ok, zoom }` |
| `devTools(tabId)` |  | `{ ok }`，开发者工具在自己的窗口里 |
| `clearData(projectId)` |  | `{ ok }`：清除该项目分区的存储、Cookie、缓存、认证缓存与解析缓存 |
| `state(tabId)` |  | `{ ok, state }` |
| `subscribe(callback)` |  | 返回取消订阅的函数 |

- `state` 是 `{ url, title, loading, canGoBack, canGoForward, zoom, crashed, error }`；`error` 是主框架最近一次加载失败的 Chromium 网络错误码，没有时为 `null`。地址超过 8192 个字符时去掉查询再去掉路径，标题去掉控制与双向字符、不超过 256 个字符。
- `subscribe` 送来三种事件：`{ type: 'state', tabId, state }`（同一标签最多每 32 毫秒一次）、`{ type: 'notice', tabId, notice, detail? }` 与 `{ type: 'closed', tabId }`。preload 丢弃形状不对的事件。
- 图片是 `{ type: 'image/png', width, height, data }`，`data` 为 `Uint8Array`。截图与定格画面每边不超过 4096 像素、不超过 5 MiB（附件对图片的上限），放不下时按比例缩小。
- 失败时为 `{ ok: false, error }`：`shell-refused`（不是主窗口的顶层页面）、`not-found`、`unavailable`（没有窗口）、`tab-limit`、`project-limit`、`invalid-url`、`blocked`（附 `reason`）、`busy`（同一标签的截图或标注还没完成）、`capture-failed`、`no-target`、`hidden`、`clear-failed`。

## 标注

`annotate` 在页面的一个隔离世界里运行固定的脚本：取该点的元素，为它生成选择器（页面里唯一的 id，否则逐级的标签、最多两个类名与 `:nth-of-type`，最多八级、512 个字符），取它的可见文字（跳过脚本与样式；没有文字时用 `aria-label`、`alt`、`title` 或 `placeholder`；从不读取表单的值）与它的矩形。页面仍然决定该点是哪个元素（可以盖一层透明的元素）以及它的属性、文字和矩形，所以回答只说明页面呈现了什么，不能当作可信内容。脚本只读不写，也不在页面里留下任何东西。主进程再检查一遍回答的形状与长度，去掉控制与双向字符，文字截到 200 个字符；3 秒内没有回答即为 `no-target`。

`target` 是 `{ url, tag, selector, text, rect, image }`：`rect` 换算回调用时的单位（从标签左上角算起的页面 CSS 像素），`image` 是元素周围 8 像素内的截图，每边不超过 1600 像素、不超过 2 MiB。

## 遮挡、焦点与快捷键

- 原生视图画在页面之上，会盖住页面的菜单、命令面板、设置、对话框与提示。页面打开这样的浮层时调用 `occlude(tabId, true)`：主进程先截下当前画面，再隐藏视图，页面把这一帧放在原处，浮层关闭后调用 `occlude(tabId, false)`。面板宽度的动画期间同样处理。
- 隐藏或被遮挡的标签若有键盘焦点，焦点交还页面。页面重新加载、渲染进程退出或窗口关闭时，它的标签全部关闭；页面自己关闭时，页面收到 `closed`。
- 标签有焦点时，应用的快捷键 ⌘K、⌘J、⌘B、⌥⌘B 与 ⌘,（其他系统上 Ctrl 代替 ⌘）由主进程在 `before-input-event` 截下，页面收不到；主进程把焦点交还页面，再把同样的按键送给页面。其他按键留给页面。

## 测试

- `apps/desktop/test/desktop-browser.test.ts`：地址栏、导航、输入形状、视图位置、截图上限、标注回答、快捷键转发、遮挡与 preload 的参数和事件。
- `e2e/desktop.e2e.ts` 的「drives preview tabs from the page…」在真实的 Electron 里从页面调用 `latchShell.browser`。

这些用例里的点击与按键由 `sendInputEvent` 注入，不等于真实的键盘、鼠标与系统焦点；系统级权限提示与真实开发服务的使用体验需要在界面接入后由所有者验收。
