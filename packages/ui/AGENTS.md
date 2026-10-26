# @latch/ui

浏览器客户端的设计系统：设计令牌 `src/tokens.css`、样式层叠层的顺序与界面原语（`src/*.tsx`，入口 `src/index.ts`；样式在 `src/ui.css`、`src/base.css` 与 `src/styles/`）。`@latch/web` 的样式入口先导入 `@latch/ui/tokens.css` 再导入 `@latch/ui/ui.css`，组件从 `@latch/ui` 导入。令牌与原语的规则见 [docs/DESIGN.md](../../docs/DESIGN.md)「设计令牌」「界面原语」。不负责页面的布局与界面（`apps/web/src/styles/`）。

运行环境 browser：依赖 React 与 lucide-react，不使用其他 workspace 包（`tsconfig.web.json`、`.oxlintrc.json`）。

不变量：

- 页面与原语的颜色、阴影、字号与行高、间距、圆角与动效只来自这里的令牌：样式表只读已定义的令牌（原语可以声明自己的几何变量），颜色不写字面值，字号与行高只用角色令牌（`apps/web/test/styles.test.ts#takes every colour from the tokens`、`apps/web/test/styles.test.ts#sets type only through the role tokens, with weights 400, 500 and 600`）。
- 每种颜色只表达一件事：蓝色只给执行动作、被勾选的控件、焦点与链接，列表的选中行是中性的；琥珀只表示警告与等你处理；红色只表示真实风险或真实失败，琥珀与红色都配文字。运行中、计数与静止的图标用墨色。
- 深色在系统偏好（页面没有选浅色时）与 `data-theme="dark"` 下各写一份，两份相同，并重写每个含颜色的令牌（`test/tokens.test.ts#gives every colour token a dark value, identical under the system preference and under data-theme`）。
- 层叠层顺序固定为 `tokens, base, ui, app, security`；原语的规则都在 ui 层（`test/stylesheet.test.ts`），安全相关的界面在最上层。安全界面带 `data-secure`（`Dialog`、`Modal`、`InlineNotice` 的 `secure`），tokens.css 末尾为它们以 `!important` 锁住主题令牌，新增令牌时一并加入（`test/tokens.test.ts`）。
- `src/plugins.ts` 定义 `PluginPanelProps`，共享 React 与控件。
- 原语的类名以 `ui-` 开头，变体与尺寸用 `data-*`，状态用 ARIA 属性；禁用用 `aria-disabled`，保持可聚焦并拦下点击。成组的单选控件只有一个 Tab 停靠点，弹层在顶层显示，对话框限制并归还焦点。
- 菜单、内容自管的 `Modal` 与异步确认/输入框同样由本包提供，共用顶层、焦点与手机面板机制；页面不另写弹层。
- 只做真实能力需要的原语：产品还没有的功能，不在这里提前做界面。
- 活的指示（`src/live.tsx`、`src/styles/live.css`）：只有活的状态会动，动画只写在 `prefers-reduced-motion: no-preference` 里，静帧要能独立表达状态；一次性动效只为 `LiveChanges` 纪元不变时的变化播放（`test/live.test.tsx` 检查同一相位、接力、一次性动效与减少动效时没有动画）。
- `TileChoice` 的 `compact` 变体用 20px 身份图标，保留相同的键盘与不可选语义。
- 动效（`src/motion.tsx`、`src/styles/motion.css`）：高度只经网格行展开，其余只动不透明度与位移；收起的身体是 `hidden="until-found"`；时长与 `MOTION` 一致（`test/motion.test.tsx`）。
- 圆角矩形另加 `corner-shape: var(--corner-shape)`，胶囊与圆形不加（`apps/web/test/styles.test.ts#gives rounded rectangles the corner shape and keeps pills and circles round`）。

`test/` 在真实浏览器中运行（Vitest 浏览器模式，见 [docs/TESTING.md](../../docs/TESTING.md)「组件测试」）；`test/gallery/` 是只供测试的原语总览页。新增或改动原语时，在 gallery 里补上它的每种状态，并补聚焦的浏览器用例。

改动后运行 `pnpm test --project @latch/ui --project @latch/web`、`pnpm build` 与 `pnpm test:e2e`，并在手机、平板、桌面宽度与深色模式下查看 `e2e/visual.e2e.ts` 的截图（含 `ui-gallery`）。
