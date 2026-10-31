# @latch/desktop

Electron 主进程与 preload，共用 Web。

| 路径 | 职责 |
| --- | --- |
| `src/main.cjs` | 主进程：窗口、`latch://app/` 协议、渲染进程限制、调试参数检查 |
| `src/proxy.cjs`、`credentials.cjs`、`host.cjs`、`preload.cjs` | 经 `host.sock` 转发并附加凭据；设备密钥与凭据（safeStorage）；`host.json` 核对的 CJS 版；`latchShell` |
| `src/folders.cjs`、`confirmations.cjs`、`lifecycle.cjs` | 文件夹面板、拖入与在访达中显示；Host 的崩溃重启、防睡、登录项与睡眠报告 |
| `src/files.cjs` | `latchShell.files`：文件显示、快速查看与默认应用打开 |
| `test/` | Vitest；Host 夹具与 `e2e/helpers/host.ts` 保持一致 |

electron-main 环境：CommonJS，不导入 TypeScript 源码。运行时只依赖 `@latch/protocol`，测试另用 Host 与 testkit。

不变量：

- 应用页面无网络与凭据；顶层用 `latch:`，固定文档入口使用无凭据的 `latch-frame:`。子框、未知 frame 的 API 请求拒绝；权限请求一律拒绝。
- 每个 webContents 在加载前禁用非代理 WebRTC UDP；应用 session 使用实际监听的回环黑洞代理并关闭隐式回环绕过。HTML 脚本开关只由具备这两项限制的壳声明，见 DOCUMENT-PREVIEWS.md。
- 顶层不离开 `latch://app/`；主进程凭一次真实点击打开网页或邮件链接，脚本外链先确认，其他协议拒绝。
- preload 只暴露 `latchShell`，IPC 只接受主窗口 `latch://app/` 顶层页面；生命周期参数只收布尔。回环邀请仅 macOS 主进程申请并交默认浏览器，不进页面或日志；页面只能申请手机邀请。
- 通知只读 Host 状态，取消/中断不冒充完成；首个后台结束时打开通知；偏好串行保存，标题默认隐藏。见 [NOTIFICATIONS.md](../../docs/NOTIFICATIONS.md)。
- 主进程只按 `desktop-launch.json` 启动本仓库的 `dist/start.js`，无额外 Node 参数，Node 属当前用户或 root 且他人不可写；`--disable-sigusr1` 在前，环境无 `LATCH_*`。睡眠与停止只由主进程报告，页面得到 403。
- 设备密钥与凭据只在主进程，经 safeStorage 加密存于 0600 文件；没有安全存储时不保存。
- 文件夹操作需 `folders.protocolVersion: 1`，只回应主窗口顶层页面，窗口有焦点才开原生对话框；路径只来自面板、经原生确认的拖入或 Host 已知会话目录。主进程取 nonce 用设备私钥签名提交，页面的添加路由 403 `shell-managed`；访达只用 `showItemInFolder`（`test/desktop-folders.test.ts`）。
- 文件操作只收顶层页面的会话引用或句柄（`files.protocolVersion: 2` 另收项目/Harness）。Host 先裁决并审计，主进程复查普通文件、白名单与文件头后只调 `shell.openPath`、`previewFile` 或 `showItemInFolder`，不开目录或应用。页面只转发会话/项目的 resolve/search/list 与句柄内容/meta，`Origin: null` 拒绝。见 [ARCHITECTURE.md](../../docs/ARCHITECTURE.md#会话文件)、`test/desktop-files.test.ts`。
- 只经 `host.json` + `host.sock` 找到并核对 Host，不经环境变量或参数传 URL 与凭据。`host.cjs` 镜像 `apps/host/src/host-state.ts` 的检查，两边同改。
- 原生确认只收票据 ID，主进程取 Host 预览、验哈希并显示系统 sheet 后签名；批准路由对页面封闭，默认取消，共用对话框门禁。
- 预览标签（`browser.cjs`）不可信：按项目内存分区、无 preload 与 Node，拒绝权限、下载、JS 对话框、打印与新窗口，请求到不了 Host；文件面板等例外见 [PREVIEW-BROWSER.md](../../docs/PREVIEW-BROWSER.md)。
- 构建不含测试代码（TESTING.md）。

先读 [STREAMING.md](../../docs/STREAMING.md)（转发与续期）与 [ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

- 仅 `POST /link/api/attachments` 有界流式上传，不在主进程缓存字节；JSON 限 1 MiB，插件草稿 8 MiB + 64 KiB（[ATTACHMENTS.md](../../docs/ATTACHMENTS.md)、`test/desktop-uploads.test.ts`）。
