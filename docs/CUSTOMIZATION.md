---
description: 自定义：一台 Host 一份外观文档（数据，不是代码），校验与展开、修订与回执、只写名单内令牌的样式表、安全界面的令牌锁与钉住的标记、安全模式与恢复默认。
sources:
  - packages/protocol/src/customization.ts
  - packages/ui/src/custom.ts
  - packages/ui/src/tokens.css
  - apps/host/src/customization.ts
  - apps/host/src/routes/customization.ts
  - apps/host/src/audit-actions/host.ts
  - apps/host/scripts/latch.ts
  - apps/web/src/core/customBoot.ts
  - apps/web/src/core/customization.ts
  - apps/web/src/App.tsx
  - apps/web/src/components/CustomizationRecovery.tsx
  - apps/web/src/components/SafeModeBanner.tsx
  - apps/web/src/settings/CustomizationSettings.tsx
  - apps/desktop/src/menu.cjs
---

# 自定义

自定义是数据。一台 Host 有一份自定义文档，Host 校验后保存，连接它的每台设备（这台 Mac、浏览器、手机网页、其他电脑上连到它的窗口）拿到同一份并照它显示。文档里只有枚举和一个有界整数：没有 CSS、选择器、URL、字体文件，也没有任何一段文字会进入样式表或页面。安全界面不参与自定义。

本文说的是已经实现的部分：外观。布局、Agent 提议外观、插件页面的更多挂载点、原生 iPhone/iPad 的跟随：尚未实现。自定义样式表（自由 CSS）不提供：它可以盖住、藏起或仿造审批，这一条无法靠逐项封堵来保证。

## 文档

```json
{ "schema": 1, "appearance": { "accentHue": 305, "radius": "round", "textSize": "large" } }
```

类型、规则与展开都在 [`packages/protocol/src/customization.ts`](../packages/protocol/src/customization.ts)。每个字段都可省略，省略即产品默认；`{ "schema": 1, "appearance": {} }` 是默认外观。

| 字段 | 取值 | 作用 |
| --- | --- | --- |
| `accentHue` | 187–330 的整数（OKLCH 色相：青、蓝、紫到洋红） | 主色族换色相：按钮填充、焦点环、勾选、链接、运行中 |
| `radius` | `sharp`、`default`、`round` | 圆角沿产品自己的台阶（2、4、6、8、12、16）各挪一级，不产生台阶外的值 |
| `textSize` | `small`、`default`、`large` | 阅读用的字号角色各 ∓1px；`large` 的行高 +2px |

琥珀、红、绿没有字段。密度与动效由设备偏好管理。文档里也没有不透明度、显示与否、尺寸为零这一类能藏起或缩小界面的东西。

**校验（`customizationIssues`）：拒绝，不修正。** 未知字段、枚举外的值、非整数的色相都拒绝整份文档。已知字段带字段路径，未知键只报所属层级。主色另有三条：

- 色相离琥珀、红、绿（两个主题里各自的色相）至少 30°（`ACCENT_HUE_DISTANCE`）。太近时回答写出相差多少度。
- 色相在 187–330 之内（`ACCENT_HUE_RANGE`），比上一条更窄：琥珀与绿之间的黄绿在主色的亮度上读起来像琥珀，330 之后的粉红紧挨着红。
- 对比度下限（`CONTRAST_FLOORS`，与令牌测试里的产品下限相同），由同一条规则 `accentFamilyIssues` 逐项计算：主色与其悬停色上的白字 4.5:1，主色文字在每个底色上 4.5:1，主色作焦点环在每个底色上 3:1，「运行中」的主色在每个底色与工作台自己的底色上 4.5:1，正文在染了主色淡底的每个底色上 4.5:1，浅色主题里主按钮下染色的投影对画布 3:1。展开时每个角色保持产品原色的亮度（WCAG 相对亮度）与彩度（超出 sRGB 时只降彩度），所以通过色相规则的主色按构造不会低于下限；规则仍然逐项计算，并在不满足时带着算出的比值拒绝。

字号的下限写在展开表里而不是校验里：任何角色不小于 11px（`MIN_TEXT_PX`），手机输入框不小于 16px。

**展开（`resolveAppearance`）。** 文档展开成四张令牌表。两主题共用 `base` 的圆角与宽窗口字号，`phone` 是 768px 以下的字号。主色族分别写入 `light` 与 `dark`，两者的令牌名相同。深色主题主按钮下的投影是固定的黑色，也写进 `dark`，否则浅色的染色投影会留在根节点上。值只由数字拼出（`#rrggbb`、`<n>px`、`rgba(r, g, b, a)`），默认字段不产生任何令牌。`apps/web/test/customization.test.ts` 核对 `resolvableTokens` 与 `CUSTOM_TOKENS` 等值，并核对展开所用的产品原值与 [`tokens.css`](../packages/ui/src/tokens.css) 一致。

## Host

存储在数据目录的 `customization.json`（0600，原子写入；[`apps/host/src/customization.ts`](../apps/host/src/customization.ts)）：最近 20 个修订与最近 64 条回执。修订是 `{ revision, hash, at, source, by, doc }`：`revision` 从 1 递增，0 表示还没有修订（默认外观）；`hash` 是文档规范 JSON 的 SHA-256；`source` 是 `apply`、`restore` 或 `reset`；`by` 是 `device` 或 `cli`。文件的 schema 是 strict。打开时除了形状，当前生效的文档还要通过全部规则（含计算出来的：规则可能在它保存之后收紧过）。读不出或通不过的文件不阻止 Host 启动，也不会被悄悄覆盖：原文件改名为 `customization.json.unreadable-<时间>`（0600）留在数据目录，记一行日志（命令行把这一行打印出来），按默认外观启动。较早的修订通不过现在的规则时留在历史里，回退到它会被拒绝。

| 接口 | 权限 | 作用 |
| --- | --- | --- |
| `GET /link/api/customization` | `view`，或 `host.sock` 上的命令行 | 当前文档、修订号与保留的修订（新的在前） |
| `POST /link/api/customization` `{ requestId, baseRevision, doc }` | `admin` | 应用一份文档 |
| `POST /link/api/customization/restore` `{ requestId, baseRevision, revision }` | `admin` | 回退到保留的某个修订，写成新修订；那份文档按现在的规则重新校验 |
| `POST /link/api/customization/reset` `{ requestId, baseRevision }` | `admin`，或 `host.sock` 上的命令行 | 恢复默认，写成新修订；历史保留 |

- 快照带 `customization: { revision, doc }`，`catalog.features.customization` 为真。写入成功后 Host 发 `refresh`，各设备重读快照，不用刷新页面就跟上。
- **回执。** 所有写入带 `requestId` 和 `baseRevision`。Host 用设备和编号先找回执，再对照基版。同一请求得到原先应用的修订 `applied` 与当前文档，回放标记 `replayed: true`。同一编号用于另一份请求回 409 `request-id-reused`。无回执且基版过期回 409 `customization-conflict`，带当前修订号。与当前相同的文档只写回执。
- **提交。** Host 在入口、排队后及文件替换前复核权限。已完成文件替换而目录同步失败时，保留该请求与回执并返回结果未知。原请求补完同步才确认，其他新写暂不接纳。如果原设备无法继续，重启 Host 后从实际保存的文件恢复。
- **审计。** `customization.applied`（strict）：`revision`、`previous`、`hash`、`source`、`fields`（文档改动了外观的哪些字段）。先审计再保存，审计写不进去就不应用；恢复默认例外：照常进行，回答带 `x-latch-audit: failed`。
- **不触发本机确认。** 应用外观是校验过的数据，不新增设备、地址、程序或能力，不在 `PRESENCE_ACTIONS` 里。
- **限速。** 应用与回退按设备计入设置类操作的限速（`classC`），超过回 429 `rate-limited`；恢复默认不计，它是出路。
- 没有让会话或插件页面应用自定义的接口：路由只认设备凭据与 `admin`，页面的桥没有这项能力。Agent 提议外观：尚未实现。

## 页面

- **样式。** `custom` 层内只有一张构造样式表。`SHEET_SKELETON` 固定普通根、手机断点与两段深色的选择器。`CSSOM` 只向 `CUSTOM_TOKENS` 中的令牌写入颜色和数字值。浏览器不支持构造样式表时显示默认外观。[`customBoot.ts`](../apps/web/src/core/customBoot.ts)
- **启动。** `main.tsx` 在 React 渲染前调用 `bootCustomization`：先套上本机缓存的文档，页面连上之后不必再变一次样子。缓存按 Host 分开存（`localStorage` 的 `latch.customization.doc.<hostId>`，另有 `latch.customization.host` 记着上一次是哪台）：同一个地址可能先后是不同的 Host，一台的缓存不说明另一台的任何事。缓存只是猜测，套上前重新校验。
- **以 Host 为准。** 快照到达后，页面上的东西只有在「同一台 Host、同一个修订号、同一份文档」时才保留（`identityOf`：三者的规范 JSON）；只要有一项不同就换成 Host 的，并重写缓存。修订号单独不算身份：另一台 Host 也从 1 数起，缓存里也可能放着这个修订号从未有过的文档。安全模式忽略的对象与启动守卫的标记用的是同一个身份。
- **预览。** 设置里每改一项，当页立即按草稿显示（同一套校验与展开），不写 Host、不进缓存；「放弃」、离开该分区或刷新即还原。「应用」按首次编辑时的基版写入。另一设备先保存后，关闭或放弃旧预览即可从当前版本重新编辑。
- **设置。** 设置 › 通用 › 「自定义」向有「管理此 Host」权限的设备提供主色、圆角、字号、恢复默认、应用与修订历史。布局和应用的自定义入口尚未实现。
- **结果未知。** 设置和安全模式在同一页面内按 Host 与设备共用原请求，切换分区或撤回管理权限时仍保留。页面在 Host、设备或待确认状态变化时更新外观操作的共享值，正文增量不触发更新。可以等权限恢复后重试，或明确放弃等待。收到过期冲突后仍可放弃等待，Host 已经收到的请求不受影响。整页刷新或关闭页面会结束这次等待。

## 安全界面不参与自定义

三件事合起来保证这一条，前两件由测试守着：

1. **只能写名单里的令牌。** 自定义只写 `CUSTOM_TOKENS`（[`packages/ui/src/custom.ts`](../packages/ui/src/custom.ts)），只写在根节点上。
2. **名单在锁内。** `tokens.css` 末尾对 `[data-secure]` 与 `[data-lock]`（连同其中的一切）用第一层的 `!important` 钉住主题令牌，任何后面的层、祖先或元素自己的声明都改不了。`packages/ui/test/tokens.test.ts` 断言 `CUSTOM_TOKENS` 的每一项在浅色、两段深色与手机断点的锁里都有；往名单里加一个锁外的令牌，测试先红。另有一条规则（`base.css`，base 层）把这些界面继承来的字号与行高重设为产品值：字号随根节点继承，令牌锁挡不住继承，按钮还会经 `font: inherit` 接过来；任何后面的层给这个界面定了字号的照旧生效。
3. **文档改不了结构。** 没有选择器、`display`、`position`、`content`、不透明度，也没有琥珀、红、绿。

`data-secure` 是安全界面：样式在 security 层逐项钉住，背景层避开它，有它时插件页面 `inert`。`data-lock` 只取其中的令牌锁，给那些在任何自定义下都要长得一样、但不该变成安全界面的标记与页面（否则一个琥珀色的词就会让所有插件页面失效）。

**逐个核对过的界面**。原语与标记的行为在 `packages/ui/test/custom.test.tsx`；下表每一行在源码里带着锁，由 `apps/web/test/locked-marks.test.ts` 逐个核对，缺一个就失败；真实页面上的比对在 `e2e/customization.e2e.ts`。

| 界面 | 所在 | 方式 |
| --- | --- | --- |
| 审批卡 | `composer/ApprovalDrawer.tsx` | `data-secure` |
| 权限漂移与「权限没确认」的停止行 | `shell/ConversationView.tsx`（`.composer-stop`） | `data-secure` |
| 本机确认的行内进度与结果 | `components/InlineConfirm.tsx` | `data-secure` |
| 登记页、配对表单、等待连接的设备、连接新设备、被拦下的配对、连接横幅 | `components/EnrollmentPage.tsx`、`settings/devices/`、`settings/PairingBlocked.tsx`、`shell/ConnectionBanners.tsx` | `data-secure` |
| 设置里「恢复默认」「应用」的一行 | `settings/CustomizationSettings.tsx` | `data-secure` |
| 设置 › 设备整个分区（设备列表、一台设备的权限、手机上推入的页） | `settings/SettingsPage.tsx` | `data-lock`（其中的开关组仍是 `data-secure`） |
| 权限菜单（含不再询问的档位）与琥珀色的权限 chip | `composer/PermissionList.tsx`、`composer/PermissionChip.tsx` | `data-lock` |
| 提问卡 | `composer/QuestionDrawer.tsx` | `data-lock` |
| 只读输入框的原因（「权限没确认，修改默认选项后开新话题」等） | `composer/Composer.tsx`（`.composer-readonly`；这句话由 `shell/SessionComposers.tsx` 给出） | `data-lock` |
| 运行条的「结果未知」 | `composer/Composer.tsx`（`.run-bar-status`） | `data-lock` |
| 工具卡的「结果未知」「已中断 · 结果未知」 | `components/ToolCard.tsx` | `data-lock` |
| 分拣台的「决定结果未知」「回答结果未知」「执行结果尚未确认」 | `shell/WorkbenchDecision.tsx` | `StatusWord` 的 `warn`；结果行 `data-lock` |
| 会话概览里命令的「结果未知」 | `shell/SessionOverview.tsx` | `data-lock` |
| 本轮撤销与恢复的「结果未知」（文字与重试按钮） | `conversation/TurnCards.tsx` | `data-lock` |
| 提交、推送与 PR 的「结果未知」一行 | `panel/delivery/`（`Line` 的 `locked`） | `data-lock` |
| 手机审阅的「发送结果未知」 | `phone-review/PhoneReview.tsx` | `data-lock` |
| 「不先问你」「权限没确认」（名称旁、创建时的「做事前」） | `agents/parts.tsx` 的 `PermissionNote`、`BeforeActing` | `data-lock`（仅琥珀时） |
| 「不先问你」（创建 Agent 的能力标签）、「来自外部内容」（记忆、提议、定时提议）、写作 `StatusWord` 的「结果未知」「等你处理」「失败」 | `StatusWord` 的 `waiting`、`warn`、`failed` | 原语自动带 `data-lock` |
| 标题为「结果未知」等的警告与错误通知 | `InlineNotice` 的 `warn`、`error` | 原语自动带 `data-lock`（`secure` 的仍是 `data-secure`） |
| 安全模式横幅 | `components/SafeModeBanner.tsx` | `data-lock` |

**还不在锁内的**：模型与思考控件的值里的「· 结果未知」（它是控件的值文字，没有自己的元素）。它的颜色不在名单里，会跟着变的只有字号与圆角：尚未实现。

安全模式横幅是 `data-lock` 而不是 `data-secure`：有安全界面在场时插件页面会 `inert`，而安全模式下「应用」页仍要可用。


在默认外观下，`data-lock` 钉住的值就是主题自己的值，所以外观不变。例外是设备自己的「紧凑」：钉住的部分保持标准密度，和安全界面一向的行为相同。

## 安全模式

自定义是数据，正常情况下弄不坏页面；安全模式防的是展开或某个版本的缺陷。它只在这台设备上：不套 Host 的自定义，页面顶部多出一行「默认外观」。它不删除任何数据。这一行自己占一行，页面取其余的高度，所以不盖住也不推走任何东西，审批照常可见、可答。它是 `data-lock`，不是安全界面，「应用」页在它下面照常可用。

进入：

| 入口 | 说明 |
| --- | --- |
| 启动守卫 | 套上文档前写下本机标记（`latch.customization.applying`，内容是那份文档的身份），页面画出任意一屏并保持 2 秒后清掉；画出过的页面被关闭或刷新时也清掉。下次启动发现标记还在，说明上次套上后没画好，这台设备进入安全模式 |
| 文档不合规则 | 本机缓存的文档，或 Host 发来的文档，通不过页面的校验（比如更新的 `schema`）：不套，进入安全模式 |
| `⌘⌥⇧0`（其他系统 `Ctrl+Alt+Shift+0`） | 监听器在 React 之外、以捕获方式挂在窗口上；再按一次回到 Host 的外观 |
| `/link/#safe` | 片段在渲染前读取，并立刻从地址栏移除；片段不会发给服务器。页面已经打开时改片段同样生效 |
| 桌面端菜单「显示 › 用默认外观打开」 | 主进程给当前窗口的地址加上 `#safe`，等片段落到页面上后核对主框仍在同一所属来源及目标地址，再重新载入一次，不依赖页面自己的脚本（`apps/desktop/src/menu.cjs` 的 `openSafeMode` 与 `safeModeUrl`）。只对本应用的 Latch 页面：`latch://app/link/…`，或另一台电脑的 `latch://h-<52 位>/link/…` |

Host 的文档已经是默认外观时，按键与 `#safe` 不进入安全模式（没有可以退回的），只撤掉当页的预览。

离开：Host 的状态变了（换了修订、换了文档，或者换了一台 Host），或者回到了默认（这正是「恢复默认」写入的），或者再按一次那组键。因为文档不合规则而进入的，Host 发来一份合规则的就离开。

横幅的「恢复默认」按当前修订写入默认外观并保留历史。已有结果未知的请求时横幅提供恢复操作。没有「管理此 Host」的设备可放弃等待，空闲时显示「在 <电脑名> 上恢复」。

**命令行。** `pnpm latch customization reset --data-dir <目录>`：Host 运行时经 `host.sock` 读取基版并请求，已停止时持数据目录锁读取和写入。单次命令遇结果未知时补发同一请求，成功后写成一个新修订并审计。

安全模式保留这台设备的主题、布局、面板宽高与开关、密度和动效偏好。工作台面板的尺寸和开关仅保存在设备本地的界面偏好中。

## 尚未实现

- 底色、侧栏、文字的种子色，等宽字体与背景效果档位。
- 「这台设备用默认外观」的常驻开关（现在只有安全模式）；导出与导入。
- Host 外观文档中的布局字段、Agent 的外观提议、插件页面的更多挂载点，以及原生 iPhone/iPad 读取快照里的外观。
- 快照里由 Host 展开好的令牌值（现在各客户端用同一个展开函数自己算）。

## 测试

| 规则 | 用例 |
| --- | --- |
| `CUSTOM_TOKENS` 在锁内 | `packages/ui/test/tokens.test.ts` |
| 把名单里每个令牌设成恶意值，安全界面与钉住的标记计算样式不变 | `packages/ui/test/custom.test.tsx`；真实页面：`e2e/customization.e2e.ts` |
| 校验拒绝、主色的色相范围与对比度规则、展开只出数字、两个主题的投影、修订上限与回退（回退重新校验）、不可用的文件改名保留、回执、审计、权限、限速、命令行 | `apps/host/test/customization.test.ts` |
| 展开用的原值与 `tokens.css` 一致、只写名单内的令牌、以 Host 为准（同修订号不同文档、缓存里放进去的文档、同一地址上的两台 Host）、启动守卫与每个安全模式入口、横幅与设置 | `apps/web/test/customization.test.ts` |
| 每个用自己的话说安全的地方都带着锁 | `apps/web/test/locked-marks.test.ts` |
| 桌面端菜单项、同来源主框与精确目标、默认外观恢复 | `apps/desktop/test/safe-mode.test.ts`、`e2e/desktop.e2e.ts` |
