# @latch/desktop

Electron 桌面壳：主进程与 preload，在 `latch://app/` 下显示 Host 提供的页面（`apps/web` 的构建）。

| 路径 | 职责 |
| --- | --- |
| `src/main.cjs` | 主进程：窗口、`latch://app/` 协议、渲染进程限制、调试参数检查；窗口图标取 `apps/web/public/icon.png` |
| `src/proxy.cjs`、`credentials.cjs`、`host.cjs`、`preload.cjs` | 经 `host.sock` 转发并附加凭据；设备密钥与凭据（safeStorage）；`host.json` 核对的 CJS 版；`latchShell` |
| `src/folders.cjs`、`confirmations.cjs`、`lifecycle.cjs` | 文件夹面板、拖入与在访达中显示；Host 的崩溃重启、防睡、登录项与睡眠报告 |
| `src/files.cjs` | `latchShell.files`：文件显示、快速查看与默认应用打开 |
| `test/` | `pnpm test --project @latch/desktop`；`test/helpers/host.ts`（`startTestHost`）与 `e2e/helpers/host.ts` 保持一致 |

运行环境 electron-main：CommonJS，由 Electron 按路径加载，不能导入 TypeScript 源码。运行时只依赖 `@latch/protocol`，测试另用 Host 与 testkit。

不变量：

- 渲染进程无网络与凭据；顶层使用 `latch:`，固定文档入口使用无凭据的 `latch-frame:`。子框、未知 frame 的 API 请求拒绝；权限请求一律拒绝。
- 顶层不能开窗或导航出 `latch://app/`；外链经主进程原生对话框确认完整地址后才交给系统浏览器。
- preload 只暴露 `latchShell`，渲染进程到主进程只有它列出的 IPC（见 `src/preload.cjs`），只接受 `latch://app/` 顶层页面；生命周期设置参数只为布尔值。回环邀请只由主进程申请，链接只给默认浏览器，不进渲染进程与日志，只在 macOS；页面经转发只能申请手机邀请。
- 通知只读 Host 快照，不接受页面正文；默认隐藏标题，按会话十秒节流（见 docs/ARCHITECTURE.md）。
- 主进程只按 `desktop-launch.json` 启动本仓库的 `dist/start.js`，不带额外 Node 参数，Node 属于当前用户或 root 且他人不可写；`--disable-sigusr1` 在前，环境不带 `HARNESS_*`。睡眠与停止只由主进程报告，页面得到 403。
- 设备密钥与凭据只在主进程，经 safeStorage 加密保存在 0600 文件中；没有安全存储时不保存。
- 文件夹操作需 `folders.protocolVersion: 1`，只回应主窗口顶层页面，窗口有焦点才开原生对话框；路径来自面板、经原生确认的拖入或 Host 已知会话目录，页面不给路径。主进程取 nonce、用设备私钥签名提交；页面的添加路由 403 `shell-managed`；在访达中只用 `showItemInFolder`（`test/desktop-folders.test.ts`）。
- 文件操作只回应主窗口的顶层页面，页面只传会话与引用或句柄。主进程经 `host.sock` 让 Host 裁决路径、内容与类型并先写审计；拿到真实路径后再核对普通文件、白名单与文件头，才调用 `shell.openPath`、`previewFile`（仅 macOS）或 `showItemInFolder`。从不 `openExternal`，不打开文件夹或应用；页面只可转发 resolve/search 和句柄内容/meta；其他文件路由 403 `shell-managed`，不透明来源 `Origin: null` 一律拒绝。检查见 [ARCHITECTURE.md](../../docs/ARCHITECTURE.md#会话文件) 与 `test/desktop-files.test.ts`。
- 只经 `host.json` + `host.sock` 找到并核对 Host，不通过环境变量或参数传 URL 与凭据。`host.cjs` 镜像 `apps/host/src/host-state.ts` 的检查，两边一起修改。
- 原生确认只收票据 ID，主进程自行取 Host 预览、验哈希并显示系统 sheet 后签名；批准路由对页面封闭，默认取消，共用对话框门禁。
- lint 的导入边界不检查 `require()`：这里不加载测试代码（检查方法见 [docs/TESTING.md](../../docs/TESTING.md)）。

修改后运行根「命令」的 Electron 用例。改动前先读 [docs/STREAMING.md](../../docs/STREAMING.md)（桌面端转发与续期）与 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。
