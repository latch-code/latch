---
description: 插件页面：formatVersion 2 的 apps 清单与能力、按能力集合的本机信任、via 核对、页面开始的会话、插件数据与迁移代、诊断、回退；不透明页面框、桥与壳层。
sources:
  - apps/host/src/app-capabilities.ts
  - apps/host/src/app-frame.ts
  - packages/protocol/src/app-bridge.ts
  - packages/app-sdk/src
  - apps/web/src/plugin-pages
  - apps/web/src/app-frame/runtime.ts
  - apps/host/src/app-data.ts
  - apps/host/src/app-diagnostics.ts
  - apps/host/src/routes/apps.ts
  - apps/host/src/plugin-package-routes.ts
  - apps/host/src/plugin-assets.ts
  - packages/protocol/src/apps.ts
---
# 插件页面

插件包 `formatVersion: 2` 可以带「页面」（`apps`）。页面是插件作者写的界面，在不透明隔离框里运行，拿不到设备凭据，只能经父页面的桥使用清单里声明、并在这台电脑上确认过的能力，Host 再逐次核对。本文写清单、信任、会话、存储、诊断与回退（Host），以及页面框、桥与壳层（客户端）。Host 还不构建 `.ts`/`.tsx` 入口（尚未实现），在那之前页面的模块是包里预先构建的 `.js` 入口。

Host 声明 `catalog.features.appPages: 1`。

## 清单

```json
{
  "formatVersion": 2,
  "id": "release-check",
  "name": "发布检查",
  "version": "1.0.0",
  "description": "",
  "requires": { "appSdk": "^1" },
  "apps": [
    {
      "id": "main",
      "title": "发布检查",
      "icon": "list-checks",
      "entry": "src/index.tsx",
      "dataVersion": 1,
      "capabilities": {
        "tasks.read": true,
        "tasks.start": { "projects": "any" },
        "tasks.continue": true,
        "tasks.readOwn": true,
        "storage": ["plugin", "project", "session"]
      }
    }
  ]
}
```

- `formatVersion: 1` 的包原样加载；`formatVersion: 2` 也可以带 `host`、`skills`、`panels`、`dataPanels`。两种格式都是严格校验，未知字段、未知能力都使整个包无效。
- 格式 2 的插件名称与页面标题不能含「」『』、冒号（全角或半角）与换行，免得读起来像确认的固定文字。
- 每个插件最多 4 个页面，页面标识不重复；`entry` 是包内的 `.ts`、`.tsx` 源文件，或预先构建的 `.js` 模块（见「页面框」）；`requires.appSdk` 只接受 `^1` 的范围；同一插件的页面用同一个 `dataVersion`（存储是插件的）。
- 能力：`tasks.read`（会话摘要）、`tasks.start`（`projects` 为 `any` 或最多 32 个项目 ID）、`tasks.continue`（只对本页面开始的会话，须同时声明 `tasks.start`）、`tasks.readOwn`（本页面开始的会话的最后回复）、`storage`（`plugin`、`project`、`session` 的子集）。没有批准、授权、确认、配对或改设置类的能力。

## 信任

页面的信任绑定**能力集合**，不绑定代码：页面框拿不到页面权限，新代码能做的不超过已批准的能力。

- 第一次应用、或能力比已批准的更宽（新页面、新能力、`projects` 变宽、存储作用域变多）时，`POST /plugin-packages/:id/apply` 经 PresenceService 的 `plugin.package.apply` 确认。系统表单本身用理由格式 `plugin.package.apply-pages`：「让插件页面可以：开始会话（任何项目）、继续它的会话、读它的会话回复、查看会话列表、保存数据（插件「名称」）」，能力在插件名称之前，所有页面的能力合在一起，最强的在前，不超过该槽位的 48 个字符，所以从不被截断；具体项目只在逐行内容里写名称，表单上写「开始会话（N 个项目）」。逐行内容每个页面一行「页面「标题」可以」（标题经 `escapeSecurityText`）；警告说明页面只能经 Host 使用这些能力、开始的会话用项目默认权限、这不是系统隔离。确认绑定的参数含能力集合的哈希。这个理由格式属于共享安全编码（`security-v1.json`、`LatchPresence.swift`），改动后确认组件签名会变。
- 能力不变或更窄的应用不确认，只审计。两种情况都先写 `plugin.package.app-trust`（`operation`、`trust: confirmed | capabilities-approved`、修订与能力哈希），写入失败就不应用。已批准的集合记在资产记录的 `approvedApps`：确认后换成确认里列出的那个集合，不确认的应用不改它。
- 含 `host` 或 `panels` 的包仍按可执行摘要逐次确认；两者都需要时合成一次确认。L3 会话运行或等待时，需要确认的应用照旧拒绝。
- 页面的每次调用都按 Host 存的已应用清单核对：插件已启用、`via.revision` 是 `appliedRevision`、页面存在、能力已声明且在已批准集合内。之后才是设备自己的 scope 与数据范围。

## 插件身份

每个插件记录在创建时得到自己的身份（`installId`）。页面开始的会话的 `origin` 记下它，数据目录的 `owner.json` 也记下它：删掉插件再用同一个 ID 创建，新的插件拿不到旧插件开始的会话（`lookup` 找不到，`continue`、`last-reply` 拒绝），驱动的请求 ID 也不同。删除时保留的数据只有在新插件的页面声明了存储、并且应用的确认里写着「接上保留的数据」（系统表单上也有）时才交给新插件；在那之前读写回答 409 `app-data-unclaimed`。

## 回退

资产记录保留最近 5 个之前应用过的快照（`history`，资产预算不够时先丢最旧的），摘要的 `rollbackRevisions` 列出它们。`POST /plugin-packages/:id/rollback` `{ requestId, revision }` 重新应用其中一个，草稿不变；能力不超过已批准的就不确认。可执行摘要在当初应用时已批准过。数据按下文切代。

## 会话

`POST /tasks` 带 `via: { app: "<pluginId>/<appId>", revision }` 时只接受 `{ via, requestId, prompt, title?, workspaceId?, harnessId?, model? }`：没有分叉、工作树、Agent、文件、附件或开始前的选项，所以会话用项目新会话的默认权限，放宽仍由人在会话里做。

1. 页面开始的会话不带私有上下文（通用 Agent 的说明与记忆），与没有完整数据范围的设备一样，所以它的回复可以交还页面。
1. 设备要有 `run`；页面要有 `tasks.start`，`workspaceId`（缺省 `default`）在清单允许的项目里。
2. 同一页面同一 `requestId` 已有会话时直接回答它（要能读这个会话，私有会话照常要求数据范围），不计限速。
3. 每个页面每台设备每分钟最多 6 次开始（429 `app-rate-limited`，`retryAfter: 60`）。
4. 先审计 `app.task.start`（插件、页面、修订、页面与请求 ID 的哈希、项目、Harness），再走同一个 `startSession`：同样的项目检查、L3 启动审计与驱动的请求回执。驱动拿到的请求 ID 由页面与页面的请求 ID 派生（UUID 形式），别的页面或手动开始的会话不会与它冲突。
5. 会话元数据记 `origin: { app, requestId }`（另有插件身份与开始请求的权限级别，不进快照；模式的基线是 Harness 的默认模式，不从开始后读回的状态取）（`sessions-meta.json`，与 `automationId` 一样由 Host 写，驱动的说法被丢掉）。写入失败回答 503 `app-origin-unknown`，用同一个请求重试会回到同一个会话再写一次。

`POST /tasks/:id/prompt` 带 `via` 时只接受 `{ via, requestId, prompt }`，页面要有 `tasks.continue`，会话必须是这个页面（这个插件身份）开始的，限速与开始共用同样的数字（单独计数）。这一轮同样不带私有上下文。有人在会话里改过权限模式（`POST /tasks/:id/config` 改模式时先记下，不论是否成功）或给过「本会话始终允许」（包括页面开始后、来源写下之前），会话不在 Harness 的默认模式，或权限级别、开始时记下的模式变了，回答 409 `app-session-changed`：新的页面代码不能接着用一个人放宽过的会话。

**私有会话。** 页面从不碰私有会话：`lookup` 找到的、`last-reply`、`continue`、重放开始与 `session:` 存储遇到私有会话一律 403 `app-private-session`，对任何设备都一样。是否私有先按 Host 自己的会话元数据判断，再去找会话，所以 Harness 已停用、找不到的会话不会被当成可读。页面开始的会话在有人带着私有上下文继续它之后就成为私有会话。

- `GET /apps/:pluginId/pages/:appId/lookup/:requestId?revision=`（`view`，`tasks.start`）：`found`（带 `sessionId`，同样要能读）、`pending`（原请求还在处理）或 `not-found`。Host 重启后从会话元数据找回。
- `GET /apps/:pluginId/pages/:appId/sessions/:sessionId/last-reply?revision=`（`view`，`tasks.readOwn`，只限本页面开始的会话）：`{ sessionId, status, runOutcome?, reply?: { messageId, text, truncated? } }`，正文最多 64 KiB。

## 存储

数据在 `plugin-data/<pluginId>/gen-<n>/data.json`（目录 0700、文件 0600，原子写入与目录同步）。文档键是 `(scope, key)`：`plugin`、`project:<projectId>`、`session:<sessionId>`；`key` 最多 256 个字符、不含控制字符。值是有限 JSON，单个 ≤ 256 KiB，每插件 ≤ 16 MiB、≤ 2,000 个文档。

| 请求 | 权限 | 说明 |
| --- | --- | --- |
| `GET /apps/:pluginId/data?scope=&app=&revision=` | `view` | 一个作用域的全部文档 |
| `GET /apps/:pluginId/data/status?app=&revision=` | `view` | `{ generation, dataVersion?, codeVersion, status, documents, bytes }` |
| `GET /apps/:pluginId/data/:scope/:key?app=&revision=` | `view` | 一个文档，没有时 404 `app-data-not-found` |
| `PUT /apps/:pluginId/data/:scope/:key` | `run` | `{ via, requestId, ifVersion, value }`；`ifVersion` 0 表示必须是新文档 |
| `DELETE /apps/:pluginId/data/:scope/:key` | `run` | `{ via, requestId, ifVersion }` |

- 作用域要在页面的 `storage` 里；`session:` 要能读那个会话，写要能写它，私有会话一律拒绝。
- 写入与删除每个页面每台设备每分钟最多 60 次（429 `app-rate-limited`）。
- 版本不对时 409 `app-data-conflict`（带当前 `version`）。同一设备同一 `requestId` 重试回答第一次的结果并带 `replay: true`；换了内容 409 `request-conflict`。写入结果未知时 503 `app-data-write-unknown`，用同一个请求重试。每一代最多保留 2,000 条回执、7 天。
- 变化经 SSE `app.data` `{ pluginId, scope, key, version }`（删除时 `version` 为 0）推给能读那个作用域的连接：私有会话的文档只给数据范围 `all` 的设备。数据写入不逐条审计。
- 会话删除时它的 `session:` 文档从每一代里删除，这些删除只通知数据范围 `all` 的设备（会话已不在，判断不了它是否私有）。某个插件的写入失败不影响其他插件，失败的会话在下一次删除时重试（只在这次 Host 运行内）。
- Host 在内存里最多保留 8 个插件的文档，其余按最久未用的先放下，需要时再从磁盘读。删除插件时 `deleteData: true` 才删除它的全部数据（审计 `app.data.removed`）；默认保留，同一 ID 再装回来接上。

### 代与迁移

每一代属于一个数据版本。用哪一代由已应用代码的 `dataVersion` 决定：有同版本的代就用其中最新的；还没有任何代时第一次写入建 `gen-1`；所有代都更旧时状态是 `needs-migration`；有更新的代、没有同版本的代时是 `data-newer`。所以回退到旧修订自动用回旧一代，再前进又找到新一代。`needs-migration` 与 `data-newer` 时读写都回答 409（`app-data-migration-required`、`app-data-newer`）。

- `POST /apps/:pluginId/data/migrate/lease` `{ via }`（`run`）：同一插件同时一个租约，60 秒；返回 `{ lease, fromGeneration, fromVersion, toVersion, expiresAt, documents }`。`documents` 只含这个页面声明的作用域，以及这台设备上页面能用的会话（私有、找不到或判断失败的会话都不交出）；没有交出的文档留在 Host 上，迁移时原样带进新的一代，页面不能覆盖它们。另一台设备持有时 409 `app-data-migrating`；租约期间状态是 `migrating`，只能读。
- `POST /apps/:pluginId/data/migrate` `{ via, requestId, lease, fromGeneration, toVersion, documents: [{ scope, key, value }] }`（`run`）：核对租约、代与版本（不符 409 `app-data-lease-lost`）和上限，先审计 `app.data.migrate`，再一次写成新的一代。之后只保留编号最大的 3 代。失败、超时或租约丢失时停在旧一代。

快照的 `apps[]` 列出每个已应用的页面：`{ pluginId, appId, title, icon?, pluginName, version, revision, capabilities, dataVersion, status, bundleHash? }`，`status` 为 `ready`、`disabled`、`migrating`、`needs-migration` 或 `data-newer`；`bundleHash` 是页面模块的 SHA-256，没有模块时不带。

## 诊断

每个页面保留最近 200 条，存在 `plugin-data/<pluginId>/diagnostics.json`（0600）。每条 `{ id, at, appId, source, code?, message }`，`message` 先经 `redactSecrets` 再截到 2 KiB。来源：`runtime`、`handshake`、`bridge`（页面上报）、`bridge`（Host 拒绝的能力，只记能力名）、`migration`、`build`（后续步骤）。

- `GET /apps/:pluginId/diagnostics?app=&revision=`（`view`）。
- `POST /apps/:pluginId/diagnostics` `{ via, source, code?, message }`（`view`）：每台设备每分钟最多 20 条，Host 记下的拒绝也计在里面。

## 页面框

页面框是一个固定的引导页：Host 在 `/link/app-frame/runtime.html` 提供（不需要凭据；别的设备只在 `sec-fetch-dest: iframe` 时得到它），桌面端在 `latch-frame://app/runtime.html` 经 `host.sock` 取来并核对。引导页里只有一个内联脚本：React、设计系统的令牌与原语、`@latch/app-sdk` 的桥与运行时。`pnpm build:web` 把它构建进 `app-frame/`，同样的源码得到同样的字节，脚本的哈希写在 `runtime.json` 里，Host 与桌面端读文件时再算一次，不一致就不提供。响应头：

```
sandbox allow-scripts; default-src 'none'; script-src 'sha256-<runtime>' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data:; connect-src 'none'; media-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'
```

桌面端的 `frame-ancestors` 是 `latch://app`。框没有 `allow-same-origin`（不透明来源：没有 Cookie、存储，读不到父页面），也没有弹窗、模态框、顶层导航、下载等沙箱权限；`<iframe allow>` 把全屏、剪贴板、摄像头、位置等特性都设为 `'none'`。`connect-src 'none'`：页面不能经 fetch、WebSocket 等联网。CSP 管不住 WebRTC（Chrome 不认 `webrtc` 指令），所以运行时在页面代码运行前删掉所有 `RTC*`、`WebTransport`、`MediaStream*` 构造器与 `navigator.mediaDevices`、`connection`、`sendBeacon`；`frame-src 'none'` 让页面拿不到新的子框来找回它们。桌面端每个 webContents 另有 `disable_non_proxied_udp`，网络经黑洞代理。

**仍有的旁路。** 框里的导航（`location.href = …`）会被拒绝或让父页面销毁框，但浏览器在拒绝之前可能已经为目标地址做了 DNS 查询或建立了 TCP 连接，所以页面能经域名把少量数据带到它选的 DNS 服务器或地址。这不是凭据或 Host 数据：页面本来就拿不到它们；能带出的只是页面经桥读到的东西（会话摘要、它开始的会话的回复、它的数据）。

1. 父页面用一个随机 nonce 打开框（地址片段 `#nonce=`），同时带自己的凭据取模块：`GET /link/api/app-modules/:pluginId/:appId/:bundleHash.js`（`view`，照常核对修订、启用与批准；`no-store`；旧哈希 404 `app-module-not-found`）。它以 `application/octet-stream` 与 `nosniff` 返回，`sec-fetch-dest` 不是 `empty` 时 403 `app-module-refused`，所以从不作为脚本、框或页面在壳层的来源上运行。
2. 框只说一次 `{ type: 'ready', protocol: 1, nonce }`。父页面核对 `event.source` 是自己的框、`origin` 是 `'null'`、nonce 一致，然后发 `init`，把一个 MessagePort 与模块字节一起转交。之后只走这个端口，窗口消息一概不理。
3. 运行时核对字节的 SHA-256 等于 `bundleHash`，从 Blob 地址导入，默认导出必须来自 `defineApp`。模块里的 `react`、`react/jsx-runtime` 与 `@latch/app-sdk` 是运行时放在 `globalThis.__latchModules` 的冻结对象，版本与 Web 同一 catalog。
4. 15 秒内没有 `ready` 与画好的页面、页面发来无法识别的消息、框离开引导页（第二次 `load`）或页面在画好前出错，都算一次打开失败：父页面销毁框，记诊断（`handshake` 或 `runtime`）。连续 3 次失败只显示错误卡；中间画好过也照样计数，页面不能画好又失败地无限重载。只有「重新加载」或新版本从零开始。

桌面端对 `latch-frame://app/` 拒绝一切权限请求；框里的导航（包括回到引导页）与新窗口一律拒绝；框里的脚本只能来自 Blob；preload 的 IPC 只回应顶层的 `latch://app/`，框里没有 `latchShell`。

## 桥

`@latch/app-sdk`（`appProtocol: 1`）给页面 `{ latch, ui }`。消息与校验在 `@latch/protocol` 的 `app-bridge.ts`，两边都严格核对字段。

| 页面调用 | 能力 | 父页面怎么做 |
| --- | --- | --- |
| `tasks.list(filter)`、`tasks.subscribe(filter, listener)` | `tasks.read` | 取自已同步的快照：只有 `id、title、status、running、runOutcome、projectId、projectName、harnessId、originApp、updatedAt`；带私有上下文的会话与已归档的不给 |
| `tasks.start(input)` | `tasks.start` | `POST /tasks` 带 `via`；设备没有 `run` 回答 `forbidden` |
| `tasks.lookup(requestId)` | `tasks.start` | `GET …/lookup/:requestId` |
| `tasks.continue(id, input)` | `tasks.continue` | `POST /tasks/:id/prompt` 带 `via` |
| `tasks.readReply(id)` | `tasks.readOwn` | `GET …/sessions/:id/last-reply` |
| `storage.get/list/put/delete`、`storage.onChange` | `storage`（作用域要声明） | 存储接口带 `via`；SSE `app.data` 里本插件、已声明作用域的变化转给页面 |
| `view.getState/setState` | 无 | 只收 JSON 值，按 JSON 计 ≤ 64 KiB，只在这个标签页的内存里，按页面保存；重新加载与新版本带过去 |
| `nav.openSession(id)` | 无 | 只限这台设备列出的会话；壳层盖着框时、父页面没有刚发生的用户手势时、或会话等你处理（审批或提问）时回答 `forbidden`，等你处理的会话只从列表打开 |
| `diag.report(message)` | 无 | `POST /apps/:pluginId/diagnostics`，来源 `bridge` |
| `host.info()` | 无 | SDK 版本、主题、是否离线、能否开始会话（`run`） |

- 父页面先查：形状、清单里的能力（不在清单里的直接 `capability-denied`，不问 Host）、页面仍挂着；再用自己的凭据问 Host。写请求的 `requestId` 由 SDK 生成，结果未知（`unknown`）时错误里带回它，用同一个重试。
- 限速在父页面也镜像一份（开始与继续每分钟 6 次、写入 60 次、上报 20 次），只为让页面早点知道；Host 仍是权威。
- 订阅：断线时先发一次 `offline`（带上次的列表），重新同步后发一次完整列表，不跨缺口补增量。
- 停用、卸载、换版本时父页面关闭端口与订阅，之后什么都不再发。快照里页面的修订或 `bundleHash` 变了就重建框，`view` 状态带过去。

## 壳层

- 侧栏「应用」组（会话、我的 Agent 与应用页的侧栏都有）每个未停用的页面一行，图标与标题；路由 `apps/<pluginId>/<appId>`。手机网页在有页面时，底部栏多一个「应用」：Code / 我的 Agent / 应用 / 设置。停用后入口、框、端口与订阅立刻消失。
- 页面上方是壳层自己的页头：标题、灰色「插件 · 名称 版本」与 ⋯（重新加载、诊断；这台 Mac 的管理设备另有停用与「回退到 x.y.z」，用现有的插件接口与本机确认）。页面打开时会话栏不卸载，会话、草稿与阅读位置不变。
- 状态：打开中、页面没有打开（连续 3 次失败）、插件已停用、正在更新数据（`migrating`；`needs-migration` 时有 `run` 的设备取租约、在隐藏的框里跑页面的 `migrate` 并一次提交，失败写「数据更新没成功」）、数据需要更新（只能查看的设备）、数据比这个版本新、页面还没有构建。
- 框里画不出安全界面：审批、本机确认、登记与 Toast 都由壳层画在框外。壳层有 `[data-secure]` 界面、打开的对话框或 Toast 时，框设 `inert`。会话从页面下面回到眼前（页面的 `nav.openSession`、切回 Code、标签页重新显示）时，审批与提问卡重新经过 320 ms 的待命，双击的第二下落不到「允许」上。
- 框里的按键：运行时只转发真实按下的 Cmd/Ctrl 组合键与 Esc；父页面只在框有焦点、没被盖住、不在迁移时收，Cmd/Ctrl 还要有刚发生的用户手势。它们作为调用交给壳层，不在壳层里派发事件：Esc 只是手机上的返回，Cmd/Ctrl 只能开关侧栏或打开设置，从不打开新会话、输入框、命令面板或查找，焦点不会被带进壳层的输入框。`ui` 原语没有 `secure` 变体，也没有对话框、面板、菜单或 Toast。
- 页面开始的会话在会话列表与页头写「来自 <页面名>」；页面还在时点它回到页面。

## 失败码

页面看到的是固定的几种：`capability-denied`、`forbidden`、`offline`、`unknown`、`rate-limited`、`invalid-input`、`not-found`。Host 的回答由父页面对应过去，Host 的原文不给页面：

| Host | 页面 |
| --- | --- |
| 403 `app-capability-denied`、409 `app-revision-stale`、409 `app-disabled` | `capability-denied` |
| 403 `scope-required`、`agent-scope-required`、`native-verification-required` | `forbidden` |
| 429 `app-rate-limited` | `rate-limited` |
| 400 `invalid-input` 及其他 400 | `invalid-input` |
| 404 | `not-found` |
| 409 `app-data-conflict`、`request-conflict` | `invalid-input`（冲突时带当前 `version`） |
| 其他 409、401 | `forbidden` |
| 503、网络错误、超时 | `unknown`（同一个 `requestId` 重试） |

父页面自己判定的：设备没有 `run` 为 `forbidden`，这台设备不在线为 `offline`，超过镜像的限速为 `rate-limited`。

## 不变量

- 插件页面只在不透明隔离框中运行，不拿凭据；每次调用先由父页面核对，再由 Host 按已应用清单逐次核对能力、修订与启用状态，再按设备 scope 检查。
- 框里没有安全界面；有安全界面、对话框或 Toast 时框是 `inert`。
- 页面开始的会话只用项目的默认权限，记 `origin`，经同一个 `startSession`、启动审计与请求回执。
- 页面的信任绑定已确认的能力集合；更宽的能力要本机确认，相同或更窄的只审计。
