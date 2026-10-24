# @latch/desktop

Electron 桌面壳：主进程与 preload。经 `host.json` 与 `host.sock` 找到并核对 Host，在 `latch://app/` 下显示 Host 提供的页面（`apps/web` 的构建）。不负责界面与 Host。

| 路径 | 职责 |
| --- | --- |
| `src/main.cjs` | 主进程：窗口、`latch://app/` 协议、渲染进程限制、调试参数检查；窗口图标取 `apps/web/public/icon.png` |
| `src/proxy.cjs`、`credentials.cjs`、`host.cjs`、`preload.cjs` | 经 `host.sock` 转发并附加凭据（纯函数，可单测）；设备密钥与凭据（safeStorage）；`host.json` 核对的 CJS 版；只暴露 `latchShell` |
| `test/` | `pnpm test --project @latch/desktop`；`test/helpers/host.ts`（`startTestHost`）与 `e2e/helpers/host.ts` 保持一致 |

运行环境 electron-main：CommonJS，由 Electron 按路径直接加载（`apps/host/scripts/desktop.ts`、`e2e/desktop.e2e.ts`），不能导入 TypeScript 源码。运行时只依赖 `@latch/protocol`，测试另用 Host 与 testkit（devDependencies）。

不变量：

- 渲染进程没有网络与凭据：只能请求 `latch:`（开发运行另允许 `devtools:`），权限请求一律拒绝（`test/desktop-proxy.test.ts#lets the renderer reach only the latch scheme, plus devtools in development`）。
- 不能开窗或导航出 `latch://app/`；外链经主进程原生对话框确认完整地址后才交给系统浏览器（`test/desktop-proxy.test.ts#opens an external link only after the owner confirms the full URL, one confirmation at a time`）。
- 设备密钥与凭据只在主进程，经 safeStorage 加密保存在 0600 文件中；没有安全存储时不保存（`test/desktop-proxy.test.ts#refuses to store credentials without secure storage`）。
- 只经 `host.json` + `host.sock` 找到并核对 Host，不通过环境变量或参数传 URL 与凭据。`host.cjs` 镜像 `apps/host/src/host-state.ts` 的检查，两边一起修改。
- lint 的导入边界不检查 `require()`：这里不加载测试代码（检查方法见 [docs/TESTING.md](../../docs/TESTING.md)）。

修改后运行 Electron 用例（`HARNESS_ELECTRON_E2E=1`，见根 `AGENTS.md`「命令」）。改动前先读 [docs/STREAMING.md](../../docs/STREAMING.md)（桌面端转发与续期）与 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。
