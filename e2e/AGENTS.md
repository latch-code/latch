# @latch/e2e

端到端用例：Vitest 内驱动真实浏览器、Electron 或原生链路，Host 由 `startTestHost` 在测试进程内启动。单模块用例在各项目的 `test/` 与根 `tests/`。

| 路径 | 职责 |
| --- | --- |
| `*.e2e.ts` | 浏览器登记、接管、流式、审批、插件、项目、布局、搜索与文件预览；桌面壳为 `desktop*.e2e.ts`（`LATCH_ELECTRON_E2E=1`，仅 macOS），场景与截图见 [TESTING.md](../docs/TESTING.md) |
| `helpers/host.ts`、`helpers/browser.ts` | `startTestHost`（经 `@latch/host` 绑定 testkit 的夹具，与 `apps/host/test/helpers/host.ts`、`apps/desktop/test/helpers/host.ts` 保持一致）；`enrollBrowser`、`connected` 与 `browserLaunchOptions` |
| `helpers/layout.ts`、`helpers/motion.ts`、`helpers/visual.ts`、`helpers/security.ts` | 控件可达、横向溢出、回到手机的会话列表与打开、离开设置（含从分区里的页面一级级返回）；按令牌读出的过渡与动画；视觉截图的视口、固定时钟、截图、索引与逐像素比较；向页面注入样式并核对安全界面不变 |
| `vitest.config.ts` | 文件依次运行，用例与钩子超时 120 秒 |

`desktop-native.e2e.ts` 检查 Mac 手机配置、系统确认接线、三宽浅深色和样式覆盖；只截无邀请的设置，生成的二维码不截图。
`workbench-keyboard.e2e.ts` 以真实临时 Host 的待处理请求和文件验证三宽键盘循环、焦点及草稿保留；截图写入 `test-results/workbench-keyboard/`。

`ios-app.e2e.ts` 用临时 DerivedData、固定依赖和禁签名的 iOS Simulator SDK 构建真实 App，检查 Mach-O 产物不含夹具身份；不启动模拟器或访问钥匙串。SDK 编译不能代替运行时布局、平台许可或真机验收。

`webkit.e2e.ts` 用 Playwright WebKit 检查三宽、授权文件与引用发送；不称为真机 Safari 验收。`desktop-models.e2e.ts` 在隔离 Electron 和假 ACP 中检查真实配置读回、失回执不重发及三宽菜单；不调用真实 Agent 或模型。

`personal-*.e2e.ts` 经真实 Host 验证群聊、例行任务、只读成员记录、草稿返回和撤权；不写私有草稿到浏览器存储。
`native-swift-relay.e2e.ts` 用真实双Go与Swift检查单流、旧能力兼容、首块前后取消与App换代；每块复核原权限，测速含子连接握手。

运行环境 node；依赖都写在 devDependencies：host、protocol、sdk、testkit 与原生全链的 relay、link-client、link-wire；Playwright、vite 用于界面与原语总览。用例与运行器用根项目的同一份 Vitest，所以本项目不声明 `vitest`。

不变量：

- 在仓库根运行 `pnpm test:e2e`，或 `pnpm exec vitest run --config e2e/vitest.config.ts e2e/<name>.e2e.ts`：配置的 `include` 与用例里的 `dist/web`、`apps/desktop/src/main.cjs`、`test-results/` 都按工作目录解析。
- 页面来自 `dist/web`（或 `LATCH_E2E_UI_DIR`），改客户端后先 `pnpm build`。浏览器用 `pnpm --filter @latch/e2e exec playwright install chromium` 安装的 Chromium，或 `LATCH_BROWSER_PATH` 指定的 Chrome。
- Playwright 从自己的安装位置解析 `electron`，只能找到根 `node_modules` 中的那一份，所以根 `package.json` 保留 `electron`。
- 只用临时目录、端口 0、测试确认后端与本地假模型；Electron 用例另用临时 `--latch-user-data` 与 `--use-mock-keychain`。截图写入 `test-results/`，不含凭据。
- 视觉截图每次运行结果相同：时钟、名称、内容与项目路径固定，画面中没有随机值；改截取的状态或稳定措施前读 [docs/TESTING.md](../docs/TESTING.md#视觉截图)「视觉截图」。

改动前先读 [docs/TESTING.md](../docs/TESTING.md#浏览器-e2e)「浏览器 e2e」、「视觉截图」与「Electron e2e」。
