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

**自定义是数据。** 一台 Host 有一份自定义文档，Host 校验后保存，连接它的每台设备拿到同一份并照它显示。

- 文档里只有枚举和一个有界整数：没有 CSS、选择器、URL、字体文件，没有任何一段文字会进入样式表或页面。
- 页面只把值写进名单内的令牌（`CUSTOM_TOKENS`）；安全界面的令牌被锁住，不参与自定义。
- 自由 CSS 不提供：它可以盖住、藏起或仿造审批，这一条无法靠逐项封堵来保证。

已实现的只有外观，其余见「尚未实现」。

## 文档

```json
{ "schema": 1, "appearance": { "accentHue": 305, "radius": "round", "textSize": "large" } }
```

类型、规则与展开都在 [`packages/protocol/src/customization.ts`](../packages/protocol/src/customization.ts)。每个字段都可省略，省略即产品默认。

| 字段 | 取值 | 作用 |
| --- | --- | --- |
| `accentHue` | 187–330 的整数（OKLCH 色相：青、蓝、紫到洋红） | 主色族换色相 |
| `radius` | `sharp`、`default`、`round` | 圆角沿产品自己的台阶（2、4、6、8、12、16）各挪一级，不产生台阶外的值 |
| `textSize` | `small`、`default`、`large` | 阅读用的字号角色各 ∓1px；`large` 的行高 +2px |

琥珀、红、绿没有字段。文档里也没有不透明度、显示与否、尺寸为零这类能藏起或缩小界面的东西。密度与动效是设备偏好，不在文档里。

**校验（`customizationIssues`）：拒绝，不修正。** 未知字段、枚举外的值、非整数的色相都拒绝整份文档（400 `customization-invalid`，带字段与算出的数字）。主色另有三条（`accentIssues`）：

- **离状态色至少 30°**（`ACCENT_HUE_DISTANCE`）：与琥珀、红、绿在两个主题里各自的色相比较。
- **在 187–330 之内**（`ACCENT_HUE_RANGE`），比上一条更窄：琥珀与绿之间的黄绿在主色的亮度上读起来像琥珀，330 之后的粉红紧挨着红。
- **对比度下限**（`CONTRAST_FLOORS`，由 `accentFamilyIssues` 在两个主题里逐项计算）：主色与其悬停色上的白字 4.5:1；主色文字、「运行中」的主色、染了主色淡底的底色上的正文 4.5:1；焦点环 3:1；浅色主题里主按钮下染色的投影对画布 3:1。

展开时每个角色保持产品原色的亮度与彩度（超出 sRGB 时只降彩度），所以通过色相规则的主色按构造不会低于下限；规则仍然逐项计算，不满足时带着比值拒绝。

**展开（`resolveAppearance`）。** 文档展开成四张令牌表：`base`（圆角与宽窗口字号）、`phone`（768px 以下的字号）、`light` 与 `dark`（主色族，令牌名相同）。

- 值只由数字拼出（`#rrggbb`、`<n>px`、`rgba(r, g, b, a)`）；默认字段不产生任何令牌。
- 字号的下限写在展开里：任何角色不小于 11px（`MIN_TEXT_PX`），手机输入框不小于 16px（`MIN_PHONE_INPUT_PX`）。
- 深色主题主按钮下的投影是固定的黑色，也写进 `dark`，否则浅色的染色投影会留在根节点上。

## Host

存储在数据目录的 `customization.json`（0600，原子写入，strict schema；[`apps/host/src/customization.ts`](../apps/host/src/customization.ts)）：最近 20 个修订与最近 64 条回执。

- 修订是 `{ revision, hash, at, source, by, doc }`。`revision` 从 1 递增，0 表示还没有修订（默认外观）；`hash` 是文档规范 JSON 的 SHA-256；`source` 是 `apply`、`restore` 或 `reset`；`by` 是 `device` 或 `cli`。
- **打开时**，当前生效的文档除了形状还要通过全部规则（规则可能在它保存之后收紧过）。读不出或通不过的文件不阻止 Host 启动，也不被悄悄覆盖：原文件改名为 `customization.json.unreadable-<时间>`（0600）留在数据目录，记一行日志，按默认外观启动。
- 较早的修订通不过现在的规则时留在历史里，回退到它会被拒绝。

| 接口 | 权限 | 作用 |
| --- | --- | --- |
| `GET /link/api/customization` | `view`，或 `host.sock` 上的命令行 | 当前文档、修订号与保留的修订（新的在前） |
| `POST /link/api/customization` `{ requestId, baseRevision, doc }` | `admin` | 应用一份文档 |
| `POST /link/api/customization/restore` `{ requestId, baseRevision, revision }` | `admin` | 回退到保留的某个修订，写成新修订；那份文档按现在的规则重新校验 |
| `POST /link/api/customization/reset` `{ requestId, baseRevision }` | `admin`，或 `host.sock` 上的命令行 | 恢复默认，写成新修订；历史保留 |

- **下发。** 快照带 `customization: { revision, doc }`，`catalog.features.customization` 为真。写入成功后 Host 发 `refresh`，各设备重读快照。
- **回执。** Host 用设备和 `requestId` 先找回执，再对照基版。同一请求得到原先应用的修订 `applied` 与当前文档，带 `replayed: true`；同一编号用于另一份请求回 409 `request-id-reused`。没有回执且基版过期回 409 `customization-conflict`，带当前修订号。与当前相同的文档只写回执，不产生修订。
- **权限复核。** Host 在入口、排队后与文件替换前各核对一次权限。
- **结果未知。** 文件已替换而目录同步失败时回 503 `customization-write-unknown`：Host 保留该请求与回执，原请求重试时补完同步才确认，其他新写暂不接纳（503 `customization-write-pending`）。原设备无法继续时，重启 Host 后从实际保存的文件恢复。
- **审计，不弹本机确认。** 应用外观是校验过的数据，不新增设备、地址、程序或能力，不在 `PRESENCE_ACTIONS` 里。每次产生修订写 `customization.applied`（strict）：`revision`、`previous`、`hash`、`source`、`fields`（改动了外观的哪些字段）。
- **先审计再保存**，审计写不进去就不应用。恢复默认例外：照常进行，回答带 `x-latch-audit: failed`。
- **限速。** 应用与回退按设备计入设置类操作的限速（`classC`，超过回 429 `rate-limited`）；恢复默认不计，它是出路。
- **会话与插件页面不能应用自定义**：路由只认设备凭据与 `admin`，页面的桥没有这项能力。

**命令行。** `pnpm latch customization reset --data-dir <目录>`：Host 运行时经 `host.sock` 读取基版并请求，已停止时持数据目录锁读取和写入。结果未知时补发同一请求。

## 页面

实现在 [`customBoot.ts`](../apps/web/src/core/customBoot.ts)。

- **样式。** `custom` 层内只有一张构造样式表。`SHEET_SKELETON` 固定四条规则的选择器（普通根、手机断点、两段深色）；值经 CSSOM 逐个写入，只写 `CUSTOM_TOKENS` 中的令牌，只写颜色和数字。浏览器不支持构造样式表时显示默认外观。
- **启动。** `main.tsx` 在 React 渲染前调用 `bootCustomization`，先套上本机缓存的文档。缓存按 Host 分开存（`localStorage` 的 `latch.customization.doc.<hostId>`，`latch.customization.host` 记上一次是哪台）：同一个地址可能先后是不同的 Host。缓存只是猜测，套上前重新校验。
- **以 Host 为准。** 快照到达后，页面上的东西只有在「同一台 Host、同一个修订号、同一份文档」时才保留（`identityOf`）；有一项不同就换成 Host 的，并重写缓存。修订号单独不算身份：另一台 Host 也从 1 数起。安全模式忽略的对象与启动守卫的标记用同一个身份。
- **预览。** 设置里每改一项，当页按草稿显示（同一套校验与展开），不写 Host、不进缓存；放弃、离开该分区或刷新即还原。「应用」按首次编辑时的基版写入。
- **结果未知。** 设置和安全模式在同一页面内按 Host 与设备共用原请求，切换分区或撤回管理权限时仍保留；可以等权限恢复后重试，或明确放弃等待。整页刷新或关闭页面结束这次等待；Host 已经收到的请求不受影响。

## 安全界面不参与自定义

三件事合起来保证这一条：

1. **只能写名单里的令牌。** 自定义只写 `CUSTOM_TOKENS`（[`packages/ui/src/custom.ts`](../packages/ui/src/custom.ts)），只写在根节点上。
2. **名单在锁内。** `tokens.css` 末尾对 `[data-secure]` 与 `[data-lock]`（连同其中的一切）用第一层的 `!important` 钉住主题令牌，后面的层、祖先或元素自己的声明都改不了。`CUSTOM_TOKENS` 的每一项必须在浅色、两段深色与手机断点的锁里都有（`packages/ui/test/tokens.test.ts`）。
3. **文档改不了结构。** 没有选择器、`display`、`position`、`content`、不透明度，也没有琥珀、红、绿。

字号另有一条规则（`base.css`）：把这些界面继承来的字号与行高重设为产品值。字号随根节点继承，令牌锁挡不住继承，按钮还会经 `font: inherit` 接过来。

**锁覆盖什么。**

| 标记 | 含义 | 用在哪里 |
| --- | --- | --- |
| `data-secure` | 安全界面：令牌锁，加 security 层逐项钉住的样式；背景层避开它；有它时插件页面 `inert` | 审批卡、权限漂移与「权限没确认」的停止行、本机确认的行内进度与结果、登记与配对、连接横幅、设备设置里的开关组、设置里「恢复默认」「应用」的一行、终端面板、分拣台里的审批；原语的 `secure` 变体。以源码的 `data-secure` 为准 |
| `data-lock` | 只取令牌锁：在任何自定义下都要长得一样、但不该变成安全界面的标记与页面（否则一个琥珀色的词就会让所有插件页面失效） | 设置 › 设备整个分区、权限菜单与琥珀色的权限 chip、提问卡、各处的「结果未知」、「不先问你」「权限没确认」、安全模式横幅；`StatusWord` 的 `waiting`、`warn`、`failed` 与 `InlineNotice` 的 `warn`、`error` 自动带 |

- 逐个位置以源码为准：`data-lock` 的位置列在 `apps/web/test/locked-marks.test.ts` 的 `LOCKED_SOURCES`，缺一个测试就失败。新增一处用自己的话说「结果未知」「等你处理」或权限警告的地方时，带上锁并加进 `LOCKED_SOURCES`。
- 安全模式横幅是 `data-lock` 而不是 `data-secure`：安全模式下「应用」页仍要可用。
- 默认外观下，钉住的值就是主题自己的值，外观不变。例外是设备自己的「紧凑」：钉住的部分保持标准密度。
- **还不在锁内的：** 模型与思考控件的值里的「· 结果未知」（它是控件的值文字，没有自己的元素）。它的颜色不在名单里，会跟着变的只有字号与圆角。

## 安全模式

自定义是数据，正常情况下弄不坏页面；安全模式防的是展开或某个版本的缺陷。

- 它只在这台设备上：不套 Host 的自定义，页面顶部多出一行「默认外观」。它不删除任何数据，也保留这台设备的主题、布局、面板、密度与动效偏好。
- 横幅自己占一行，页面取其余的高度，所以不盖住也不推走任何东西，审批照常可见、可答。

进入：

| 入口 | 说明 |
| --- | --- |
| 启动守卫 | 套上文档前写下本机标记（`latch.customization.applying`，内容是那份文档的身份），页面画出任意一屏并保持 2 秒后清掉；画出过的页面被关闭或刷新时也清掉。下次启动发现标记还在，说明上次套上后没画好 |
| 文档不合规则 | 本机缓存的或 Host 发来的文档通不过页面的校验（比如更新的 `schema`）：不套，进入安全模式 |
| `⌘⌥⇧0`（其他系统 `Ctrl+Alt+Shift+0`） | 监听器在 React 之外、以捕获方式挂在窗口上；再按一次回到 Host 的外观 |
| `/link/#safe` | 片段在渲染前读取，并立刻从地址栏移除；页面已经打开时改片段同样生效 |
| 桌面端菜单「显示 › 用默认外观打开」 | 主进程给当前窗口的地址加上 `#safe`，核对主框仍在同一所属来源及目标地址后重新载入一次，不依赖页面自己的脚本（`apps/desktop/src/menu.cjs` 的 `openSafeMode` 与 `safeModeUrl`）。只对本应用的 Latch 页面 |

Host 的文档已经是默认外观时，按键与 `#safe` 不进入安全模式（没有可以退回的），只撤掉当页的预览。

离开：

- Host 的状态变了（换了修订、换了文档，或换了一台 Host）；
- Host 回到了默认（这正是「恢复默认」写入的）；
- 再按一次那组键；
- 因为文档不合规则而进入的，Host 发来一份合规则的就离开。

横幅的「恢复默认」按当前修订写入默认外观并保留历史。没有 `admin` 的设备不能恢复，只能放弃等待；页面完全不能用时用命令行的 `customization reset`。

## 尚未实现

- 底色、侧栏、文字的种子色，等宽字体与背景效果档位。
- 「这台设备用默认外观」的常驻开关（现在只有安全模式）；导出与导入。
- 布局字段、Agent 的外观提议、插件页面的更多挂载点。
- 原生 iPhone/iPad 读取快照里的外观。
- 快照里由 Host 展开好的令牌值（现在各客户端用同一个展开函数自己算）。

## 测试

| 规则 | 用例 |
| --- | --- |
| `CUSTOM_TOKENS` 在锁内 | `packages/ui/test/tokens.test.ts` |
| 把名单里每个令牌设成恶意值，安全界面与钉住的标记计算样式不变 | `packages/ui/test/custom.test.tsx`；真实页面 `e2e/customization.e2e.ts` |
| 校验、修订、回执、审计、权限、限速、命令行 | `apps/host/test/customization.test.ts` |
| 展开用的原值与 `tokens.css` 一致、`resolvableTokens` 与 `CUSTOM_TOKENS` 等值、以 Host 为准、安全模式入口 | `apps/web/test/customization.test.ts` |
| 桌面端菜单项、同来源主框与精确目标 | `apps/desktop/test/safe-mode.test.ts`、`e2e/desktop.e2e.ts` |
