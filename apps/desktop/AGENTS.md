# @latch/desktop

Electron 桌面壳：主进程与 preload。经 `host.json` 与 `host.sock` 找到并核对 Host，在 `latch://app/` 下显示 Host 提供的页面（`apps/web` 的构建）。不负责界面与 Host。

| 路径 | 职责 |
| --- | --- |
| `src/main.cjs` | 主进程：窗口、`latch://app/` 协议、渲染进程限制、调试参数检查；窗口图标取 `apps/web/public/icon.png` |
| `src/proxy.cjs`、`credentials.cjs`、`host.cjs`、`preload.cjs` | 经 `host.sock` 转发并附加凭据（纯函数，可单测）；设备密钥与凭据（safeStorage）；`host.json` 核对的 CJS 版；只暴露 `latchShell` |
| `src/folders.cjs` | `latchShell.folders`：系统的文件夹选择面板、拖入的文件夹（先原生确认）、把会话自己的文件夹存为项目（先原生确认）与在访达中显示；主进程自己取 nonce、签名并经 `host.sock` 新建项目、加入或重新选择文件夹（依赖注入，可单测） |
| `test/` | `pnpm test --project @latch/desktop`；`test/helpers/host.ts`（`startTestHost`）与 `e2e/helpers/host.ts` 保持一致 |

运行环境 electron-main：CommonJS，由 Electron 按路径直接加载（`apps/host/scripts/desktop.ts`、`e2e/desktop.e2e.ts`），不能导入 TypeScript 源码。运行时只依赖 `@latch/protocol`，测试另用 Host 与 testkit（devDependencies）。

不变量：

- 渲染进程没有网络与凭据：只能请求 `latch:`（开发运行另允许 `devtools:`），权限请求一律拒绝（`test/desktop-proxy.test.ts#lets the renderer reach only the latch scheme, plus devtools in development`）。
- 不能开窗或导航出 `latch://app/`；外链经主进程原生对话框确认完整地址后才交给系统浏览器，与文件夹的对话框共用一个门，同一时间只有一个原生对话框（`test/desktop-proxy.test.ts#opens an external link only after the owner confirms the full URL, one confirmation at a time`）。
- 设备密钥与凭据只在主进程，经 safeStorage 加密保存在 0600 文件中；没有安全存储时不保存（`test/desktop-proxy.test.ts#refuses to store credentials without secure storage`）。
- preload 只暴露冻结的 `latchShell`：`kind`、`devMode`、`platform` 与冻结的 `folders`（`protocolVersion: 1`、`pick`、`drop`、`reveal`、`saveSessionFolder`）。文件夹操作只回应主窗口自己的顶层页面，窗口有焦点才打开对话框。加入项目的路径只来自原生选择面板，或 preload 从拖入的 `File` 读出、经默认「取消」的原生对话框确认后的路径，或主进程向 Host 查到的会话自己的文件夹（同样先经这样的对话框，页面只给会话 ID）；对话框里的项目名称取自 Host。主进程取 nonce 后用设备私钥签名请求体（`credentials.cjs` 的 `foldersSigningText` 与 `canonicalJson`，共享向量 `signing.folders`），经 `shellRequest` 提交；渲染进程发往添加路由的请求得到 403 `shell-managed`。在访达中显示只对 Host 已登记的文件夹的真实路径调用 `shell.showItemInFolder`，从不 `openPath` 或 `openExternal`（`test/desktop-folders.test.ts`、`test/desktop-proxy.test.ts#keeps the folder-add routes for main, however the page spells them`）。
- 只经 `host.json` + `host.sock` 找到并核对 Host，不通过环境变量或参数传 URL 与凭据。`host.cjs` 镜像 `apps/host/src/host-state.ts` 的检查，两边一起修改。
- lint 的导入边界不检查 `require()`：这里不加载测试代码（检查方法见 [docs/TESTING.md](../../docs/TESTING.md)）。

修改后运行 Electron 用例（`HARNESS_ELECTRON_E2E=1`，见根 `AGENTS.md`「命令」）。改动前先读 [docs/STREAMING.md](../../docs/STREAMING.md)（桌面端转发与续期）与 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。
