# @latch/e2e

端到端用例：Vitest 内用 Playwright 驱动真实浏览器与 Electron，Host 由 `startTestHost` 在测试进程内启动。单元与集成用例不在这里，在各项目的 `test/` 与根 `tests/`。

| 路径 | 职责 |
| --- | --- |
| `*.e2e.ts` | 浏览器：登记、接管、流式界面、权限展示、扩展、布局、侧栏的宽度、吸附与筛选胶囊（`sidebar.e2e.ts`）、视觉截图（`visual.e2e.ts`）；桌面端壳：`desktop.e2e.ts`（`HARNESS_ELECTRON_E2E=1`，仅 macOS） |
| `helpers/host.ts`、`helpers/browser.ts` | `startTestHost`（经 `@latch/host` 绑定 testkit 的夹具，与 `apps/host/test/helpers/host.ts`、`apps/desktop/test/helpers/host.ts` 保持一致）；`enrollBrowser`、`connected` 与 `browserLaunchOptions` |
| `helpers/layout.ts`、`helpers/visual.ts` | 控件可达、横向溢出与打开设置；视觉截图的视口、固定时钟、截图、索引与逐像素比较 |
| `vitest.config.ts` | 文件依次运行，用例与钩子超时 120 秒 |

运行环境 node；依赖都写在 devDependencies：workspace 包 host、protocol、sdk、testkit，`@playwright/test` 与 `vite`（视觉截图构建 `packages/ui/test/gallery` 的原语总览页）。用例与运行器用根项目的同一份 Vitest，所以本项目不声明 `vitest`。

不变量：

- 在仓库根运行 `pnpm test:e2e`，或 `pnpm exec vitest run --config e2e/vitest.config.ts e2e/<name>.e2e.ts`：配置的 `include` 与用例里的 `dist/web`、`apps/desktop/src/main.cjs`、`test-results/` 都按工作目录解析。
- 页面来自 `dist/web`（或 `HARNESS_E2E_UI_DIR`），改客户端后先 `pnpm build`。浏览器用 `pnpm --filter @latch/e2e exec playwright install chromium` 安装的 Chromium，或 `HARNESS_BROWSER_PATH` 指定的 Chrome。
- Playwright 从自己的安装位置解析 `electron`，只能找到根 `node_modules` 中的那一份，所以根 `package.json` 保留 `electron`。
- 只用临时目录、端口 0、测试确认后端与本地假模型；Electron 用例另用临时 `--latch-user-data` 与 `--use-mock-keychain`。截图写入 `test-results/`，不含凭据。
- 视觉截图每次运行结果相同：时钟、名称、内容与项目路径固定，画面中没有随机值；改截取的状态或稳定措施前读 [docs/TESTING.md](../docs/TESTING.md#视觉截图)「视觉截图」。

改动前先读 [docs/TESTING.md](../docs/TESTING.md#浏览器-e2e)「浏览器 e2e」、「视觉截图」与「Electron e2e」。
