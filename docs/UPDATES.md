---
description: 桌面端自动更新：签名更新源、状态机、安装门禁与 Host 安装窗口、插件兼容、失败恢复，以及仍受外部条件阻塞的部分。
sources:
  - apps/desktop/src/updater.cjs
  - apps/desktop/src/update-source.cjs
  - apps/desktop/src/menu.cjs
  - apps/desktop/src/main.cjs
  - apps/desktop/src/preload.cjs
  - apps/desktop/src/proxy.cjs
  - apps/desktop/src/lifecycle.cjs
  - apps/desktop/test/updater.test.ts
  - apps/host/src/update-window.ts
  - apps/host/src/server.ts
  - apps/host/src/plugin-package-routes.ts
  - apps/host/test/update-window.test.ts
  - apps/web/src/settings/AboutSettings.tsx
  - apps/web/src/core/shellUpdates.ts
  - apps/web/test/about-updates.test.ts
  - e2e/desktop-update.e2e.ts
---
# 桌面端自动更新

更新只在 Electron 主进程（`updater.cjs`）里进行。

- 页面经 `latchShell.updates`（`get`、`check`、`download`、`install('now' | 'at-quit')`、`cancelWaiting`、`setAutoDownload`、`onChange`、`onShow`）只拿到状态视图：状态、版本、数量、更新说明与错误码。preload 逐字段校验视图后才交给页面。
- 页面从不拿到下载地址、文件路径或公钥。页面和插件都不能提供更新地址，也不能让主进程运行任意可执行文件。
- 桌面端只经 `host.json` 与 `host.sock` 找到这台 Mac 的 Host，从不更新其他电脑上的 Host。
- 浏览器与手机的关于页只显示 Host 版本，没有更新区。

## 来源与校验

- **来源固定在构建里。** 更新源地址、Ed25519 公钥（base64 SPKI）与是否已签名只写在 `update-source.cjs`，由打包步骤写入；源码检出里都为空。运行时的参数、环境变量、页面与插件都不能改变它们。
- **不支持时不检查。** 状态为 `unsupported`，原因是 `development`（未打包）、`platform`（不是 macOS）、`not-configured`（没有更新源或公钥）或 `unsigned`。
- **更新源文档**是 `{ payload, sig }`：`sig` 是对 `payload` 字节的 Ed25519 签名，`payload` 是发布信息 JSON：

  ```
  { version, notes: { 'zh-CN', en }, minHostProtocol, host: { version, protocol },
    pluginApi: { formats }, assets: [{ platform, arch, url, sha512, size }], publishedAt, expiresAt }
  ```

- 字段逐一严格校验。只接受稳定版本号 `x.y.z`（不会静默切到预览通道），只提供比当前更新的版本（不降级）。
- **过期拒绝。** 过了 `expiresAt` 的更新源即使签名正确也拒绝（`failed{stage:'check', code:'feed-expired'}`），托管方因此不能一直重放旧的签名更新源来冻结更新；发布方要在到期前重新签发。
- **资产**必须匹配本机平台与架构，地址必须是 HTTPS 且与更新源同源。请求用 Node 自己的 TLS（应用会话的网络是封闭的），不跟随重定向，不带凭据。
- **下载**写入 `<userData>/updates/<随机>.partial`（0600，不经符号链接），边下边算 SHA-512。大小或哈希不符即删除文件、状态 `failed{stage:'verify'}`，不安装。校验通过才改名为最终文件，并清除缓存里的其他文件。

## 状态

`idle`（未检查）· `checking` · `up-to-date` · `available` · `downloading{received,total}` · `ready` · `waiting{count,running,waiting,unknown,queued,terminals,services}` · `installing` · `failed{stage,code}` · `unsupported{reason}`。

- **检查。** 后台检查在启动 10 分钟后一次，之后每 6 小时一次；睡眠唤醒时若上次检查已超过 6 小时立即补检。后台与手动检查共用一次请求；下载同时只有一个；下载、待安装、等待与安装中再检查不改变状态。
- **自动下载**是主进程保存的偏好（`<userData>/updates.json`，0600，默认开）。
- **失败都不影响当前版本。** 检查失败可再检查；下载中断可重试；校验失败的重试先重新读取更新源；安装失败离开安装窗口、清除插件计划并给出恢复步骤。数据目录不在应用包内，升级不动数据。

## 只换 App 与换 Host

Host 在 `host-info` 与安装窗口接口里报告 `protocol`（`HOST_PROTOCOL`）与版本；发布信息里的 `host` 是新版包内 Host 的版本与协议。

- **`app`（只重启 App）**：两者都与正在运行的 Host 相同，运行中的协议不低于 `minHostProtocol`，并且没有插件会被停用。会话不受影响，不进安装窗口。
- **`host`**：其余情况，走下面的门禁。读不到 Host 时按 `host` 处理。

## 安装门禁与 Host 安装窗口

### 接口

`GET/POST /link/api/host/update-window` 只接受这台 Mac 上经 `host.sock` 登记并经 `host.sock` 调用的设备（`requireDesktop`），需 `run` 范围。

- 与文件夹授权同一规则：任何经 `host.sock` 登记的设备都算这台 Mac 的桌面端，不只限 Latch 应用。
- 桌面端代理对页面发来的这条路径一律 403 `shell-managed`，只有主进程自己的请求能到达。

| 请求 | 作用 |
| --- | --- |
| `GET` | 窗口状态、Host 版本与协议、插件格式、忙碌计数、已应用插件的格式，以及更新后被停用的插件 |
| `POST {open:true, pluginFormats?, version?}` | 进入或续期窗口；带插件格式时必须带目标版本 |
| `POST {open:false, reason:'cancelled'\|'installing'\|'failed'}` | 离开 |
| `POST …/commit` | 停止前的最后一步，见下 |

**忙碌计数**：运行中、等审批、结果未知（配置写入进行中或回执未落定、开始与发消息请求进行中、正在运行的 Git 交付写入）、排队中（会自己发出或正在发出的排队消息）、终端里正在运行的命令。本地服务数只列出，随终端一起结束。

### 窗口的生命期

- 10 分钟不续期即失效；Host 重启后窗口不存在。窗口已关闭时 409 `update-window-closed`。
- **持有者。** 窗口记下进入它的设备：打开期间只有这台设备能续期、提交或离开，其他设备（例如同一台 Mac 上与打包应用并存的开发运行）得到 409 `update-window-held`。
- **提交**在一步内核对忙碌计数：不为 0 即 409 `host-busy`；为 0 则 Host 进入「即将停止」，新工作一律不开始，终端不再新建也不接受输入，续期也不能撤销。
- 提交后离开窗口可撤销（停止前就失败的安装）。2 分钟内没有被停止（桌面端在此期间退出或崩溃）时窗口自行结束，开始与终端恢复，插件计划丢弃。
- **审计。** 进入、提交与离开各写一条 `host.update-window`（只有状态、原因枚举、忙碌数与是否记录了插件计划），自行结束写 `left`/`expired`；续期不写。这些都只是收紧，审计失败不阻止，响应带 `x-latch-audit: failed`。

### 窗口打开时 Host 拒绝什么

以下都回答 409 `host-updating`：

- 新会话开始（`POST /tasks`、定时任务启动）。
- 对已有会话的普通消息；在没有运行的会话上排队或追加（会立即开始一轮）；排队消息的「立即发送」。
- 提交之后，Host 自己运行用户 Git 的写入：交付的暂存、取消暂存、提交、推送与 PR，以及移除工作树。它们共用 `RepositoryHolds.enter()`，运行中的计入忙碌计数，提交要等它们结束。

规则：

- 门禁在会话开始与发消息的共用路径（`startSession`、`sendPrompt`）上，所以交接的新建、重试与发往已有会话也一样（记录方式见 [HANDOFFS.md](./HANDOFFS.md)）。
- 定时任务的启动与 `POST /tasks` 一样记为进行中的开始，结算前计入忙碌；窗口期间到点的运行记为 `missed`，定时任务保持开启。
- **照常接受：** 在运行中的会话上排队或追加（属于进行中的工作）；已有运行照常结算。
- **重试不受窗口影响。** 同一设备对同一会话重试 Host 已有记录的请求，得到原来的回答。开始与发消息按设备、会话与 `requestId` 在内存中记录进行中与已接受的，最近 4096 个：真正结束才算结束，客户端中途断开不提前结束，只有成功才算已接受；排队请求按排队记录。失败的请求不留记录，重试按新请求处理；Host 重启前的请求在窗口期间重试会被当作新的。

### 主进程一侧

- 对 `host` 计划进入窗口后每 2 秒询问并续期，计数为 0 时请求提交，提交成功才停止 Host 并安装；提交答复仍忙就继续等待，状态 `waiting`。
- 进不了窗口（没有设备凭据、Host 没有这个接口、Host 出错或连不上）或提交得不到答复时不安装，状态 `failed{stage:'gate', code:'window-unavailable'}`。
- **取消**即离开窗口回到 `ready`。取消时若进入窗口或提交的请求还在路上，答复回来后再离开一次，不安装。
- 同一时间只有一次安装。桌面端每次启动先离开它上次可能留下的窗口（不支持自动更新的构建不发这个请求）。
- **退出。** 显式安装、「下次退出时安装」后的普通退出与等待中的退出走同一门禁：普通退出时若 Host 有工作就不安装、照常退出，更新保持待安装；等待中退出即放弃这次等待。
- **系统登出、重启或关机**（`powerMonitor` 的关机通知后 30 秒内的退出）从不被更新拖住，延到下次。

### 安装器

真实安装器只在已打包且已签名时使用 Electron 的 `autoUpdater`（Squirrel.Mac）：

1. 停止由桌面端按启动记录启动的 Host（宣布原因 `update`）。不是桌面端启动的 Host 拒绝安装，错误码 `host-external`。
2. 把已校验的文件经一次性回环地址以 Squirrel 默认的更新源格式（`{ url }`）交给它。
3. `update-downloaded` 后 `quitAndInstall`。

以下都算安装失败，走同一条恢复路径（重新启动 Host、离开窗口并清除插件计划）：

- `update-not-available`（`installer-refused`）、出错（`installer-failed`）、2 分钟没有结果（`installer-timeout`），或回环地址开不出来。
- 停止 Host 本身失败，例如 10 秒内没有退出（`host-stop-timeout`）。

放弃时回环服务连同进行中的传输一起关闭，Squirrel 不能在之后取完文件。**仍有一个缺口：** 文件已经完整取走、Squirrel 还在解包时到了 2 分钟，它仍可能把更新暂存到下次退出时应用，Electron 没有取消暂存更新的接口；这要在签名版本上实测。

## 插件兼容

发布信息的 `pluginApi.formats` 是新版能加载的插件包 `formatVersion`；目前用它充当插件 API 版本，正式的插件 API 版本尚未定义。

- 检查时把它与 Host 报告的已应用且启用的插件比较。不兼容的在关于页列出，并使更新按 `host` 处理。
- 进入窗口时把格式与目标版本交给 Host，Host 记在 `plugin-packages/update-held.json`（0600），计划随窗口一同到期。
- **只有目标版本的 Host 在窗口到期前首次启动时才按计划处理：** 格式不在其中的已应用插件不启用（资产与记录保留），审计 `host.update.plugins-held`（只有数量），插件列表显示原因。用户重新启用或删除该插件即解除。
- 旧版本 Host 重新启动（安装失败）、计划过期、取消或失败离开窗口时，计划都被丢弃，不停用任何插件。

## 菜单

主进程替换 macOS 的菜单栏（`menu.cjs`）。「检查更新…」在应用菜单里：选择后开始检查并让页面打开关于页（页面尚未订阅时由 preload 保留）。开发者工具只在开发运行中。「显示」菜单里切换空间的两项见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md)。

## 关于页

- 桌面端分别显示 Latch 应用的版本与这台 Mac 上 Host 的版本。
- 更新区按状态显示一行与至多一个主操作；等待用琥珀，失败用红色并说明当前版本照常可用。
- 更新说明显示更新源里的 `zh-CN` 一份（`en` 保留在数据里）。

## 尚未实现与外部阻塞

`pnpm package:desktop` 生成供本机验收的 ad-hoc 签名应用，包内带 Host、网页资源和 `latch`。发布仍需要以下配置与验收。

- **发布流水线**负责生成已签名的 zip 资产、启用并核对 Electron 的完整性保护、写入 `update-source.cjs`。
- **签名与公证**：`pnpm package:desktop -- --release` 用所有者的 Developer ID Application 证书与 notarytool 凭据签名并公证（[USAGE](USAGE.md#正式签名与公证)），尚未实际运行。Squirrel.Mac 只为签名一致的应用安装更新。
- **更新托管**：一个固定的 HTTPS 地址，提供签名后的更新源与同源资产。
- **Ed25519 发布密钥**：私钥由所有者离线保管用于签发更新源，公钥写入构建。
- **真实安装器**只有单元级替身与端到端假安装器覆盖，需在第一对签名版本上实测旧版 → 新版、失败恢复与插件停用。
- Windows 与 Linux 不支持自动更新。
