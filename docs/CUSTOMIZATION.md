---
description: 自定义：一台 Host 一份外观文档（数据，不是代码），校验与展开、修订与回执、只写名单内令牌的样式表、安全界面的令牌锁与钉住的标记、安全模式与恢复默认；每台设备自己的快捷键文档。
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
  - packages/protocol/src/shortcuts.ts
  - apps/host/src/shortcuts.ts
  - apps/host/src/routes/shortcuts.ts
  - apps/web/src/core/shortcutBindings.ts
  - apps/web/src/workbenchShortcuts.ts
  - apps/web/src/settings/ShortcutsSettings.tsx
  - apps/desktop/src/main.cjs
  - apps/desktop/src/preload.cjs
---

# 自定义

**自定义是数据。** 一台 Host 有一份自定义文档，Host 校验后保存，连接它的每台设备拿到同一份并照它显示。

- 文档里只有枚举和一个有界整数：没有 CSS、选择器、URL、字体文件，没有任何一段文字会进入样式表或页面。
- 页面只把值写进名单内的令牌（`CUSTOM_TOKENS`）；安全界面的令牌被锁住，不参与自定义。
- 自由 CSS 不提供：它可以盖住、藏起或仿造审批，这一条无法靠逐项封堵来保证。

已实现的是外观与每台设备自己的[快捷键](#快捷键)，其余见「尚未实现」。

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

**命令行。** 应用包使用 `latch customization reset --data-dir <目录>`，源码运行使用 `pnpm latch`。Host 运行时经 `host.sock` 读取基版并请求，已停止时持数据目录锁读取和写入。结果未知时补发同一请求。

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

## 快捷键

快捷键是每台设备自己的：同一台 Host 上，桌面端和每个浏览器各有一份，互不影响。

**文档。** 类型、规则与默认键都在 [`packages/protocol/src/shortcuts.ts`](../packages/protocol/src/shortcuts.ts)。

```json
{ "schema": 1, "client": "desktop", "bindings": { "new": "Mod+Shift+KeyY" } }
```

- `client`：`desktop` 或 `browser`。两种客户端的默认键不同，只有与页面自己的种类相同的文档才生效。
- `bindings`：只写改过的操作。省略的就是默认键（`DEFAULT_SHORTCUTS`）；写成默认键会被拒绝。
- 一个键是可选的 `Mod`、`Alt`、`Shift`（按这个顺序）加一个 `KeyboardEvent.code`，例如 `Mod+Alt+KeyB`。`Mod` 在 Mac 上是 ⌘，在其他系统上是 Ctrl，按下 ⌘ 或 Ctrl 都算。
- 至少要有 `Mod` 或 `Alt`。单独一个键或只加 Shift 是在打字，不收。

**能改的操作**（`SHORTCUT_ACTIONS`）：设置、新会话、Code、我的 Agent、搜索、侧栏、侧边面板、在侧边面板打开…、切换对话与看板、改动、终端、浏览器、选取元素、在会话中查找、搜索文件、浏览文件、关闭当前文件、上一个和下一个会话、下一个等你处理的请求、聚焦输入框、额度与用量、快捷键。

**固定的**（`FIXED_SHORTCUTS`），设置里标「固定」：

- 成组的键：第 N 个会话、输入框的四个控件。
- 终端的分屏与窗格。
- 允许或拒绝选中的请求。改键不能让「允许」更容易按到。
- 撤销归档，以及 `⌘⌥⇧0` 安全模式。
- 输入框里的按键：Esc Esc、↑、Space、回车。

**拒绝，不修正。** Host 与页面用同一个 `shortcutRefusal`。下面这些键都拒绝，提示里说明原因：

| 原因 | 提示 |
| --- | --- |
| 已被另一个操作（含改过的）或固定的键使用 | 「已用于「搜索」」 |
| 系统保留：`SYSTEM_RESERVED`，如 ⌘Space、⌘Tab、⌘Q、⌘H、⌘M、⇧⌘3/4/5 | 「系统保留」 |
| 浏览器保留，只对浏览器：`BROWSER_RESERVED`，即标签页、窗口、历史、地址栏、编辑、缩放、开发者工具、打印与保存 | 「浏览器保留」 |
| 菜单占用，只对桌面端：`MENU_RESERVED`，即 `menu.cjs` 里各角色的键 | 「菜单占用」 |

操作自己的默认键总是接受。⌘W 在桌面端是关闭当前文件，而菜单的「关闭窗口」也用 ⌘W：这个默认键先于规则存在，改回默认就是恢复。

文档里有未知字段、未知操作或语法外的键时，整份文档以 400 `shortcuts-invalid` 拒绝，消息里带上操作名和原因。

**Host。** 存储在数据目录的 `shortcuts.json`（0600，原子写入，strict schema；[`apps/host/src/shortcuts.ts`](../apps/host/src/shortcuts.ts)），按设备 ID 分开：

- 每台设备一项：`{ revision, at, doc, receipts }`，最多保留 16 条回执。
- 最多 256 台设备；超出时先删最久没写的。
- 打开时删去 Host 已不登记的设备。读不出或通不过规则的文件改名为 `shortcuts.json.unreadable-<时间>` 留着，各设备按默认键启动。

| 接口 | 权限 | 作用 |
| --- | --- | --- |
| `GET /link/api/shortcuts` | `view` | 这台设备自己的 `{ revision, doc }`；没有保存过时是 `{ revision: 0, doc: null }` |
| `POST /link/api/shortcuts` `{ requestId, baseRevision, doc }` | `view` | 保存这台设备的文档 |
| `POST /link/api/shortcuts/reset` `{ requestId, baseRevision }` | `view` | 全部恢复默认 |

- **只读写自己的。** 设备取自凭据，不取自请求；设备读不到、也写不了别的设备的快捷键。
- **回执与冲突。** 回执和基版的规则与外观相同：同一请求得到原先的回答（`replayed: true`），同一编号用于另一次修改回 409 `request-id-reused`，基版过期回 409 `shortcuts-conflict`。
- **结果未知。** 文件已替换而目录同步失败时回 503 `shortcuts-write-unknown`，原请求重试时补完。在这之前同一台设备的其他写入回 503 `shortcuts-write-pending`；别的设备照常写入，以已替换的文件为准，它自己的同步一并补完。
- **没有变化不写。** 与当前相同的文档（包括已是默认时的恢复默认）不写文件，回当前修订号。
- **权限复核。** 入口、排队后与文件替换前各核对一次设备。
- **限速。** 保存与恢复默认都计入 `classC`。拒绝的原因最多点名 4 个未知字段或操作，每个截到 40 字。
- **不审计，不弹本机确认。** 改键只改变这台设备自己的页面响应哪些键，不授予任何能力。快照的 `catalog.features.shortcuts` 为真时，页面才提供改键。

**页面。**

- **状态。** [`shortcutBindings.ts`](../apps/web/src/core/shortcutBindings.ts) 在每次连上一台 Host、换一台设备时重新读取，读到之前用默认键。
- **生效范围。** 改键同时作用于按键的匹配（`workbenchShortcut`、`shortcutMatches`）和所有显示快捷键的地方：按钮与提示、`⌘/` 一览、搜索面板、设置。
- **结果未知。** 原请求按 Host 与设备保留在页面内，可以重试同一请求或放弃等待；在它之前不接受新的修改。
- **改键。** 设置 › 快捷键里点按键开始记录：按下新的组合键，Esc 取消。被拒绝时在行内写出原因并继续记录。改过的行旁边有「恢复默认」，页尾有「全部恢复默认」。

**桌面端菜单。**

- 「显示 › Code」「显示 › 我的 Agent」是菜单项，用聚焦窗口自己的键。页面经 `latchShell.spaces.setKeys` 把两个键交给主进程。
- 主进程用 `menu.cjs` 的 `spaceAccelerator` 再核对一次语法与保留键，然后重建菜单。没通过的项不给键，不会沿用页面没要的键。
- 其他窗口或新载入的页面回到默认键。保留键与页面同源，由 `apps/desktop/test/menu-shortcuts.test.ts` 核对。


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
| 快捷键的规则、默认键各自通过、按设备存储与路由、只读写自己的 | `apps/host/test/shortcuts.test.ts` |
| 改键后的匹配与显示、默认键不变、记录、结果未知后重试同一请求 | `apps/web/test/shortcut-bindings.test.ts`、`apps/web/test/workbench-shortcuts.test.ts` |
| 菜单的 Code 与我的 Agent 用聚焦窗口的键，保留键与页面一致 | `apps/desktop/test/menu-shortcuts.test.ts` |
| 浏览器与桌面端里改键、使用、刷新后仍在、恢复默认 | `e2e/shortcuts-rebind.e2e.ts`、`e2e/desktop-shortcuts.e2e.ts` |
