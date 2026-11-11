# @latch/app-sdk

插件页面在不透明隔离框里用的一切：作者面的类型与 `defineApp`（`src/index.ts`）、桥客户端（`src/bridge.ts`）、界面原语的封装（`src/ui.tsx`）与框内运行时（`src/runtime.tsx`，入口 `@latch/app-sdk/runtime`）。线上消息与校验在 `@latch/protocol` 的 `src/app-bridge.ts`；机制见 [APP-PAGES](../../docs/APP-PAGES.md)。

运行环境 browser：只依赖 `@latch/protocol`、`react` 与 `react-dom`，不用其他 workspace 包。设计系统的原语由运行时入口（`apps/web/src/app-frame/runtime.ts`）传进 `startRuntime`，本包不导入 `@latch/ui`。

不变量：

- 本包只在页面框里运行：Web 页面只用 `@latch/protocol` 的消息类型与校验，不导入本包（运行时入口除外，它单独构建成框的固定引导页）。
- 框里没有凭据与 Host 地址：桥只经父页面给的一个 MessagePort，不发网络请求；`APP_BRIDGE_METHODS` 是框能调用的全部方法，没有批准、授权、确认、配对或改设置类的方法。
- 运行时只认父页面的一次 `init`（来源是 `parent`、nonce 来自地址的片段），先核对模块的 SHA-256 再从 Blob 导入；之后不再处理窗口消息。Cmd/Ctrl 组合键与 Esc 先转给壳层。
- 原语封装逐个列出能传的属性：不传 `secure`、图标、快捷键或其他属性；不提供对话框、面板、抽屉、菜单或 Toast。
- 页面产物导入的 `react`、`react/jsx-runtime` 与 `@latch/app-sdk` 由运行时放在 `globalThis.__latchModules`（冻结、不可改写），版本与 Web 同一 catalog。
- 运行时的脚本哈希写进 Host 与桌面端的 CSP，构建必须可复现（`apps/web/test/app-pages.test.ts`）；改本包后先 `pnpm build:web`。

`test/` 由 `pnpm test --project @latch/app-sdk` 运行；框与桥的端到端检查在 `e2e/app-pages.e2e.ts` 与 `e2e/desktop-app-pages.e2e.ts`。
