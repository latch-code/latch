# @latch/desktop

| 路径 | 职责 |
| --- | --- |
| `src/main.cjs` | 窗口、协议、渲染限制、调试 |
| `src/proxy.cjs`、`credentials.cjs`、`host.cjs`、`preload.cjs` | host.sock 转发并附凭据；设备密钥；host.json 核对；`latchShell` |
| `src/folders.cjs`、`files.cjs`、`editors.cjs`、`lifecycle.cjs` | 目录面板；`latchShell.files`、`editors`；Host 重启、防睡、登录项与睡眠报告 |
| `test/` | Vitest |

electron-main：CommonJS，不导 TS；仅依赖 `@latch/protocol`，构建无测试代码。

不变量：

- 应用页无网络与凭据；顶层用 `latch:`，固定文档入口用无凭据的 `latch-frame:`。权限只给本窗口来源顶层页的 `clipboard-sanitized-write`（`h-` 页另需 5 秒内真实手势）；其余与子框、未知 frame 的 API 都拒（`execCommand` 复制不经权限）。
- 每个 webContents 加载前禁用非代理 WebRTC UDP；应用 session 用实际监听的回环黑洞代理并关隐式回环绕过。HTML 脚本开关只由有此二限的壳声明（DOCUMENT-PREVIEWS）。
- 顶层只在窗口所属电脑的来源：`latch://app/` 或 `latch://h-<hostId>/`（自有分区，按来源选凭据并固定证书）。本机页凭真实点击开网页与邮件链接，远程页与脚本外链先确认，别的协议拒绝。
- preload 只暴露 `latchShell`，IPC 只接受主窗口 `latch://app/` 顶层页；`latch://h-<hostId>/` 顶层页只到 computers 的 list/open/start/subscribe*、`spaces`（名进布尔出）与全屏布尔；add/remove/open/start 需该页一秒内的真实手势。生命周期参数只收布尔。`/pairings` 只由 macOS 主进程申请，链接不进页面或日志。
- 通知只读 Host 状态，取消/中断不冒充完成；首个后台结束时开通知；偏好串行存，标题默认隐藏（NOTIFICATIONS）。
- 主进程只按 `desktop-launch.json` 启动 `dist/start.js`。包内重启核对并记录实际 Node，打包关闭三个 Node 入口。`--disable-sigusr1` 在前，环境白名单。主进程报告睡眠与停止（页面 403）。包内 CLI 路径只给本机顶层页（ARCHITECTURE）。
- 设备密钥与凭据只在主进程，safeStorage 加密存 0600 文件，无安全存储不存。
- 文件夹操作需 `folders.protocolVersion: 1`，只回应主窗口顶层页，有焦点才开原生对话框；路径只来自面板、经原生确认的拖入或 Host 已知会话目录。主进程取 nonce 用设备私钥签名，页面添加 403；访达只用 `showItemInFolder`。显示家只收 Agent ID，经 Host 核对 owner 与可用性，再查真实目录（CUSTOM-AGENTS）。
- 文件操作只收顶层页会话引用或句柄（v2 含项目/Harness），经 Host 授权与审计。主进程查类型、文件头，仅 `openPath`、`previewFile`、`showItemInFolder` 或白名单编辑器（真实手势、固定模板、无 shell），不开目录。页面限 resolve/search/grep/list、句柄 GET/meta/PUT，拒 `Origin:null`（ARCHITECTURE）。
- 只经 `host.json` + `host.sock` 找到并核对 Host，URL 与凭据不经环境变量或参数。`host.cjs` 与 `host-state.ts` 同改。
- 主进程不显示、不批准本机确认（`PresenceService`），页面只读与取消票据。
- 预览标签（`browser.cjs`）不可信，到不了 Host 与模型网关，重载只隐藏。主进程经 host.sock 签名登记为浏览器提供者（页面请求 403）；Agent 动作（`browser-agent.cjs`）是与页面接口分开的固定白名单，只用显示着的本机标签；其输入不算手势，它用过的标签本轮不离本机（[PREVIEW-BROWSER](../../docs/PREVIEW-BROWSER.md)）。
- 更新只经 `updater.cjs`（[UPDATES](../../docs/UPDATES.md)）：源与公钥只来自 `update-source.cjs`，页面只得视图，`update-window` 仅主进程。

先读 [STREAMING](../../docs/STREAMING.md)、ARCHITECTURE。
- 仅 `POST /link/api/attachments` 有界流式上传，主进程不缓存字节；JSON 限 1 MiB，插件草稿 8 MiB + 64 KiB（[ATTACHMENTS](../../docs/ATTACHMENTS.md)）。
