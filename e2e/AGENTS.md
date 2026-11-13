# @latch/e2e

Vitest 驱动浏览器、Electron 与原生；剪贴板回归用独立命名板，Host 用临时目录。

| 路径 | 职责 |
| --- | --- |
| `*.e2e.ts` | 浏览器登记、接管、流式、审批、插件、项目、布局、搜索与文件预览；桌面壳为 `desktop*.e2e.ts`（`LATCH_ELECTRON_E2E=1`，仅 macOS），场景与截图见 [TESTING.md](../docs/TESTING.md) |
| `helpers/host.ts`、`helpers/browser.ts` | `startTestHost`（经 `@latch/host` 绑定 testkit 的夹具，与 `apps/host/test/helpers/host.ts`、`apps/desktop/test/helpers/host.ts` 保持一致）；`enrollBrowser`、`connected` 与 `browserLaunchOptions` |
| `helpers/layout.ts`、`helpers/motion.ts`、`helpers/visual.ts`、`helpers/security.ts` | 可达与溢出、按 Host ID 打开会话、手机历史与设置返回；按令牌读出的过渡与动画；视觉截图的视口、固定时钟与冻结的动作（`stillMotion`）、截图、索引与逐像素比较；向页面注入样式并核对安全界面不变 |
| `vitest.config.ts` | 文件依次运行，用例与钩子超时 120 秒 |

`desktop-native.e2e.ts` 检查 Mac 手机配置、系统确认接线、三宽浅深色和样式覆盖；只截无邀请的设置，生成的二维码不截图。
`workbench-keyboard.e2e.ts` 在临时 Host、Chromium/WebKit 验证三宽键盘、浮层、焦点和草稿；截图在 `test-results/workbench-keyboard/`。

`ios-app.e2e.ts` 用临时 DerivedData、固定依赖和禁签名的 iOS Simulator SDK 构建真实 App，检查 Mach-O 产物不含夹具身份；不启动模拟器或访问钥匙串。SDK 编译不能代替运行时布局、平台许可或真机验收。

`changes-panel.e2e.ts` 在真实临时仓库走完改动页签的范围、撤销与恢复、回执和合并中的拒绝，并按 Host 的答复画出每个状态，截图写入 `test-results/changes-panel/`。

`webkit.e2e.ts` 用 Playwright WebKit 检查三宽、授权文件与引用发送；不称为真机 Safari 验收。`desktop-models.e2e.ts` 在隔离 Electron 和假 ACP 中检查真实配置读回、失回执不重发及三宽菜单；不调用真实 Agent 或模型。

网关 e2e 的真实 CLI 验收须授权（[TESTING](../docs/TESTING.md)）。

`native-swift-relay.e2e.ts` 用真实双Go与Swift检查单流、旧能力兼容、首块前后取消与App换代；每块复核原权限，测速含子连接握手。

`stream-delta.e2e.ts` 验证正文增量与完整帧修复。

`stream-performance.e2e.ts`：`LATCH_STREAM_BENCH=1`，[说明](../docs/TESTING.md)


node 环境；Host、protocol、sdk、testkit、relay、link-client、link-wire、Playwright、Vite 只写 devDependencies；Vitest 使用根项目的版本，本项目不重复声明。

不变量：

- 在仓库根运行 `pnpm test:e2e`，或 `pnpm exec vitest run --config e2e/vitest.config.ts e2e/<name>.e2e.ts`：配置的 `include` 与用例里的 `dist/web`、`apps/desktop/src/main.cjs`、`test-results/` 都按工作目录解析。
- 页面来自 `dist/web`（或 `LATCH_E2E_UI_DIR`），改客户端后先 `pnpm build`。浏览器用 `pnpm --filter @latch/e2e exec playwright install chromium` 安装的 Chromium，或 `LATCH_BROWSER_PATH` 指定的 Chrome。
- Playwright 从自己的安装位置解析 `electron`，只能找到根 `node_modules` 中的那一份，所以根 `package.json` 保留 `electron`。
- 只用临时目录、端口 0、测试确认后端与本地假模型；Electron 用例另用临时 `--latch-user-data` 与 `--use-mock-keychain`。截图写入 `test-results/`，不含凭据。
- 视觉截图每次运行结果相同：时钟、名称、内容与项目路径固定，画面中没有随机值；改截取的状态或稳定措施前读 [docs/TESTING.md](../docs/TESTING.md#视觉截图)「视觉截图」。

改动前先读 [docs/TESTING.md](../docs/TESTING.md#浏览器-e2e)「浏览器 e2e」、「视觉截图」与「Electron e2e」。

`helper-home.e2e.ts`：假 ACP，家/默认项/人工任务，三宽深浅与权限失败；跨断点同表单/焦点/未知请求（CUSTOM-AGENTS）。
