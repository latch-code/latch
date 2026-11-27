# @latch/ui

浏览器客户端的设计系统：令牌 `src/tokens.css`、层叠层顺序与原语（`src/*.tsx`，入口 `src/index.ts`；样式在 `src/ui.css`、`base.css`、`styles/`）。`@latch/web` 先导入 tokens.css 再导入 ui.css。规则见 [docs/DESIGN.md](../../docs/DESIGN.md)「设计令牌」「界面原语」。页面布局在 `apps/web/src/styles/`。

运行环境 browser：依赖 React 与 lucide-react（长尾图标），不用其他 workspace 包。

不变量：

- 样式的颜色、阴影、间距、圆角与动效只用令牌；原语可声明几何变量。字号、行高用角色令牌，字重为 400、500、600（`apps/web/test/styles.test.ts`）。工作台两布局和预览共用 `--work-*` 底色。
- 每种颜色只表达一件事：主色只给主按钮、被勾选的控件、焦点、链接与执行状态；琥珀只表示等你处理与警告；红色只表示真实风险或失败；绿色只给新增行、通过的检查、在线点与短暂的成功对勾。选中行与计数是墨色，琥珀与红色都配文字。内容色板只用在内容里（DESIGN「令牌的类别」）。
- 深色在系统偏好（页面没有选浅色时）与 `data-theme="dark"` 下各写一份，两份相同，并重写每个含颜色的令牌（`test/tokens.test.ts#gives every colour token a dark value, identical under the system preference and under data-theme`）。换主题经 `switchTheme`，不播放过渡。
- 层叠层固定为 `tokens, custom, base, ui, app, security`；原语在 ui 层（`test/stylesheet.test.ts`）。安全界面带 `data-secure`，`data-lock` 只取令牌锁；tokens.css 末尾以 `!important` 锁住令牌，新令牌一并加入。自定义只写 `CUSTOM_TOKENS`，须在锁内（`test/tokens.test.ts`，[文档](../../docs/CUSTOMIZATION.md)）。
- `src/plugins.ts` 定义 `PluginPanelProps`，共享 React 与控件；`StatusPill` 是插件 API，不改名。
- 原语类名以 `ui-` 开头，变体和尺寸用 `data-*`，状态用 ARIA。禁用用 `aria-disabled`，可聚焦、拦点击。单选组只留一个 Tab 停靠点。弹层置顶，对话框管理并归还焦点，跨断点保留正文与底栏。
- 浮层只用本包，定位经 `pinLayer`，宽收 `LayerSize`（DESIGN「浮层」）。`Modal` 自身关闭不回调，浏览器关闭回调一次，内层不传外层；卸载用静态副本退场，安全界面与含密码框、iframe 的不留副本；`secure` 的 `Drawer` 不播动效。
- 原语只呈现真实能力；短模型目录可收紧，单一档位随模型显示。
- 图标：常用的在 `src/glyphs/`，线宽 `ICON_STROKE`，选中项 `solid`（`test/icon.test.tsx`）。
- 状态（`src/status.tsx`）：状态是状态词加至多一个 12px 图形，只有运行中的转圈会动；变化只为 `LiveChanges` 纪元不变时看见的变化交叉淡化；循环在视野外暂停，减少动效时停在静帧（`test/status.test.tsx`）。
- 动效（`src/motion.tsx`）：时长 `--m-*` 与曲线 `--e-*`，离开用 70%，`MOTION`、`EASING` 与令牌一致；高度只经网格行展开，其余只动不透明度与位移；收起用 `hidden="until-found"`；减少动效仅淡入淡出，最多 120ms（`test/motion.test.tsx`）。
- 动效用 `motionAllowed`；背景避让安全面、固定阅读窗，可见流式时暂停。滚动条随 CSS 媒体条件启停。
- `Tile.bare` 去底板。`TileChoice.compact` 用 20px，保留键盘与禁用语义。
- 圆角只取台阶或种类圆角（`--*-radius`），不用 `corner-shape`（`apps/web/test/styles.test.ts`）。
- 键位（`Kbd`、按钮的 `keys`）是一段淡色字「⌘N」，不画框。

`test/` 在真实浏览器中跑（见 [docs/TESTING.md](../../docs/TESTING.md)「组件测试」）；`test/gallery/` 是只供测试的原语总览页。新增或改动原语时在 gallery 补上每种状态，并补聚焦的浏览器用例。

改动后跑 `pnpm test --project '@latch/ui*' --project @latch/web`、`pnpm build`、`pnpm test:e2e`，看 `e2e/visual.e2e.ts` 截图（含 `ui-gallery`）。
