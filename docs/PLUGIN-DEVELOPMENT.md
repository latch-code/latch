---
description: 插件开发：类型源、插件对象与生命周期、注册工具（预览、风险分级与审批）、注册模型 Provider、注册 HarnessDriver 与 Bridge 契约、验证与调试。
sources:
  - packages/sdk/src
  - packages/core/src/registry.ts
  - packages/protocol/src/plugin-packages.ts
  - apps/host/src/plugin-assets.ts
  - apps/host/src/plugin-package-bundle.ts
  - apps/host/src/plugin-package-routes.ts
  - apps/host/src/plugin-packages.ts
  - apps/host/scripts/cleanup-plugin-generations.ts
  - apps/host/src/plugins
  - apps/host/src/risk.ts
  - apps/host/src/egress.ts
  - apps/host/src/providers.ts
  - src
  - examples
---
# Latch 插件开发

**插件**由用户围绕一项工作设计、创建和启停。一个自定义插件可以同时提供技能、工具、React 界面、模型 Provider 与完整 Harness，也可以只包含其中几项。文件放在一个插件包目录中，Host 内部以一个 Cordis fiber 管理它的贡献与资源。功能由这些贡献和 Host 模块共同实现，不需要为每项功能发明一个注册类别。

Host 用 [Cordis](https://github.com/cordiverse/cordis) 的 `Context.plugin`、fiber 与 effect 管理生命周期；作者通过 `PluginContext` 注册能力。`LatchPlugin` 是插件对象的类型，`HarnessPlugin` 保留为兼容名称。原有默认导出插件对象的 `.mjs` 文件继续可用。

自定义插件是可信代码：Host 模块具有 Host 进程权限，客户端模块具有当前页面的权限。只加载自己信任的插件；工具审批、路径检查、出站策略与界面挂载位置都不是对插件代码的隔离。客户端文件会发送给已登记、拥有查看权限的设备，不能包含密钥、命令环境变量值或其他只应留在 Host 的资料。执行语义与会话级别见 [ARCHITECTURE.md](./ARCHITECTURE.md)，状态与渲染见 [STREAMING.md](./STREAMING.md)。

类型源：包 `@latch/sdk`（[packages/sdk](../packages/sdk/)）的 [plugins.ts](../packages/sdk/src/plugins.ts)（插件、`PluginContext`、Provider、Tool）、[harness.ts](../packages/sdk/src/harness.ts)（`HarnessDriver` 与 Host 传给它的选项）、[bridge.ts](../packages/sdk/src/bridge.ts)（Bridge 契约）与 [errors.ts](../packages/sdk/src/errors.ts)（`AppError`），都从入口 `@latch/sdk` 导出；它们引用的浏览器 DTO 在包 `@latch/protocol` 的 [types.ts](../packages/protocol/src/types.ts)（`@latch/protocol/types`）。根包 `latch` 的兼容入口 `latch/plugin-sdk` 与 `latch/harness-sdk`（[src/plugin-sdk.ts](../src/plugin-sdk.ts)、[src/harness-sdk.ts](../src/harness-sdk.ts)）再导出只含类型的子路径 `@latch/sdk/plugins` 与 `@latch/sdk/harness`，即前两个文件，不含 `AppError`；以改名前的包名 `harness-link` 安装本包的插件写 `harness-link/plugin-sdk`，同样可以编译。两个包都只在本仓库的 workspace 中使用，尚未发布带版本承诺的独立 SDK 包；用 TypeScript 开发时以这些文件为准，发布本地插件时编译为 ESM `.mjs`。内置模型协议使用的 `FetchLike` 等 HTTP 辅助在 Host 的 [providers/http.ts](../apps/host/src/plugins/providers/http.ts)，不属于 SDK。

## 启动第一个插件

```sh
pnpm install
pnpm build
pnpm desktop -- --plugin ./examples/text-statistics.mjs
```

在桌面端完成设备登记（见 [README](../README.md)）并配置一个模型服务，然后在 Agent 模式中要求统计一段文字。示例 [text-statistics.mjs](../examples/text-statistics.mjs) 注册 `text_statistics`，不访问磁盘或网络；和所有第三方工具一样，它是 R2：每次执行前都需要审批，并且只能在执行端电脑的桌面端经本机确认后允许（见下文的风险分级）。`pnpm start -- --plugin …` 启动的 Host 同样加载插件；之后运行 `pnpm desktop` 会复用这个 Host 打开桌面端（新的启动参数不生效）。

`--plugin` 可重复，路径相对启动目录解析，可指向插件包目录或默认导出插件对象的模块。`--harness <driver-id>` 让该 Harness 成为新会话的默认值并要求它启动成功；`--provider <provider-id>` 选择 Standard 的默认模型服务。两者都是能力 ID，不是插件 ID。演示模式必须显式使用 `--demo`。

通过 `--plugin` 加载的插件，其启停保存在 `settings.json`；修改原目录源码仍需重启 Host。应用内管理的自定义插件把草稿、已应用版本和批准摘要保存在私有 `plugin-packages/assets.json`，应用后立即发布新代，重启恢复已应用快照；保存草稿不改变正在运行的版本。设置页管理的模型服务与 ACP Agent 也使用插件生命周期（`managed` 为 `provider` / `agent`），应在对应设置页中修改；内置插件（`managed: 'core'`）不能停用。

内置插件与第三方插件用同一组接口：它们在 `apps/host/src/plugins/<种类>/<id>/`，每个插件一个目录（`providers/openai-compatible`、`providers/openai-responses`、`providers/anthropic`、`providers/gemini`、`providers/demo`、`tools/workspace-files`、`tools/safe-tools`、`standard`），ACP Driver 是单独的包 `@latch/harness-acp`。插件目录只导入 `@latch/sdk`、`@latch/protocol`、已安装的包、本目录的文件与同一种类共用的文件（如 `providers/http.ts`），不导入 Host 或其他插件目录；Host 需要提供的能力（出站 `fetch`、受保护路径）经插件参数传入。`pnpm lint` 检查这些边界（见 [ARCHITECTURE.md](./ARCHITECTURE.md)「Workspace 项目」）。

## 组合一个自定义插件

[发布检查示例](../examples/release-review/) 包含 Markdown 技能、一个汇总工具、一个返回发布条件的数据面板，以及可编辑清单的 React 面板。勾选与说明在界面中整理，点击「写入对话」生成草稿，由用户通过当前会话正常发送；工具执行继续走 Host 的分级、审批与取消。

```text
release-review/
  latch-plugin.json   名称、版本、配置与各入口
  host.mjs            工具、数据面板或自定义 Harness
  SKILL.md            模型使用的操作方法
  panel.mjs           已构建的 React 界面
```

```json
{
  "formatVersion": 1,
  "id": "release-review",
  "name": "发布检查",
  "version": "1.0.0",
  "description": "按证据核对发布准备情况。",
  "host": ["./host.mjs"],
  "config": { "checks": ["测试结果", "兼容性", "回退步骤"] },
  "skills": [{ "id": "review", "name": "发布检查", "description": "逐项核对证据", "file": "./SKILL.md" }],
  "panels": [{ "id": "checklist", "title": "发布清单", "harnessIds": ["standard"], "entry": "./panel.mjs" }]
}
```

`--plugin <目录>` 加载其中的 `latch-plugin.json`；也可使用 `loadPluginPackage(path)`（`@latch/host`）后传给 `startServer({ plugins })`。多次传入 `--plugin` 可加载多个包。只读取显式提供的本地路径，不安装依赖、不下载代码；所有清单入口必须在包目录内，逃逸路径与指向目录外的符号链接被拒绝。清单不超过 64 KiB，单个技能文件不超过 32 KB，单个界面模块不超过 1 MB。作者负责预先构建 ESM 和准备 Host 模块所需的本地依赖。

`host` 是有序的模块列表。每个模块默认导出 `{ activate(context, config) }`；`config` 是清单配置的独立副本，模块负责校验自己的字段。模块可以使用下文的全部注册能力，包括 `registerHarness`，因此一个包可以替换整个 Agent 执行循环。多个模块共用这个包的注册归属与清理栈；后一个激活失败时，已经登记的技能、界面、工具与资源一并回滚。顶层 import 发生在加载时：副作用放在 `activate` 中，并用 `onDispose` 登记清理。

## 应用内的自定义插件资产

Host 声明可选能力 `catalog.features.pluginPackages`。管理接口只给 host.sock 上已登记的管理设备，且数据范围必须是 `all`；浏览器和原生远端即使有管理权也不能读取源码或修改插件。源码不进入审计或 SSE。`createPluginPackageTemplate('skill' | 'tool' | 'react-ui', id?, name?)`（`@latch/protocol`）提供可直接应用的技能／静态说明、真实大写转换工具和 React 笔记模板；模板不下载代码，也不伪造 Harness 能力。

资产是 `{manifest,files:[{path,content}]}`。名称、说明、版本、技能、模块与面板都可编辑，原 `latch-plugin.json` 格式标识继续兼容。每个资产最多 128 文件，单文件最多 1 MB、技能最多 32 KB、清单最多 64 KiB，合计 JSON 不超过 8 MiB。只收包内相对路径，不接受绝对路径、遍历、保留清单名、大小写冲突或文件／目录冲突，所有入口必须存在。可执行入口必须是自包含或已经打包好依赖的 `.mjs`，不在线安装依赖，不编译 JSX 或 TypeScript。

| 请求 | 输入与行为 |
| --- | --- |
| `GET /plugin-packages` | 返回有限摘要列表，不复制所有插件源码 |
| `POST /plugin-packages` | `{requestId,bundle}` 创建草稿，标识不能覆盖内置或启动参数中的插件 |
| `GET /plugin-packages/:id` | 摘要与当前草稿 bundle |
| `PUT /plugin-packages/:id` | `{requestId,baseRevision,bundle}` 保存草稿，标识不变，过期版本返回 409 |
| `GET /plugin-packages/:id/export` | 返回可再次导入的 `{bundle}` JSON，不包含运行数据 |
| `POST /plugin-packages/:id/apply` | `{requestId,revision}` 显式应用这个精确草稿；有 `.ts`/`.tsx` 页面入口时要求该修订构建成功 |
| `POST /plugin-packages/import` | `{requestId,sessionId}` 把会话文件夹的 `latch-app/` 读成页面草稿（[APP-PAGES.md](APP-PAGES.md#草稿构建与预览)） |
| `GET /plugin-packages/session-draft?sessionId=` | 会话文件夹里有没有页面草稿，以及从它导入的插件 |
| `POST /plugin-packages/:id/build`、`GET …/build?revision=` | `{requestId,revision}` 用 Host 的固定工具构建草稿修订；读回构建记录与诊断 |
| `GET /plugin-packages/:id/builds/:bundleHash.js` | 预览用的产物字节 |
| `POST /plugin-packages/:id/dev` | `{requestId,dev}` 开发中：来源会话每轮结束后重新导入并构建 |
| `POST /plugin-packages/:id/enabled` | `{requestId,enabled}` 启停已应用快照，不自动应用草稿 |
| `POST /plugin-packages/:id/rollback` | `{requestId,revision}` 重新应用最近 5 个之前应用过的快照之一，草稿不变 |
| `DELETE /plugin-packages/:id` | `{requestId,baseRevision,deleteData?}` 撤下并移除插件资产；`deleteData: true` 才删除它的页面数据 |

摘要的 `revision` 是规范完整资产的 SHA-256，`appliedRevision` 才是实际发布内容。状态为 `draft`、`applied` 或 `update-available`；`enabled`、`trusted` 与真实 `capabilities` 分别描述当前运行、当前草稿的执行信任和实际注册项。请求超时保持结果未知并复用原 requestId。写入使用 0600 临时文件、文件同步、原子替换和目录同步；替换后的结果未知时，普通读取拒绝，只有同设备原请求能结算。应用重试必须再次激活候选，不能把已回滚的候选误报为发布成功。

应用内资产在启动、应用与重新启用时把完整 `appliedRevision` 交给注册表作为持久修订；未应用草稿不会改变正在使用的修订。技能文字变更虽无需新的代码批准，显式应用后仍改变此修订，已有执行授权据此暂停并要求复核。停用保留已应用修订，重新启用相同快照不会退回临时 activation 标识；审批去重用的 `executionHash` 不代替执行授权中的完整修订。

纯技能和有限数据面板没有可执行摘要，首装和文字编辑无需系统确认。Host／React 源码或执行配置首次改变时，`plugin.package.apply` 经 PresenceService 显示一次系统确认，绑定完整草稿与可执行摘要；相同已批准摘要跨重启复用。名称、说明、技能正文和静态数据不制造新的代码批准。批准只说明用户信任这些本机／页面代码，不提供隔离。L3 运行期间不接受这项新的长期代码信任。

应用在独立的不可变 generation 中加载，候选注册、持久化与发布复用注册表替换事务。模块激活失败保留旧版和草稿，旧运行继续使用旧租约。Harness 在发布后由 Host 启动，启动失败仍保留已应用快照，并在摘要的 `unavailableReason` 中明确说明；不会把声明的能力误报为已可用。停用或删除先禁止新的注册表租约，旧租约真实释放后才清理 effect 与源代；审计失败不拦收紧，并以 `x-latch-audit: failed` 告知。运行中的 Harness 无法安全卸载时返回清楚的 409：先停止正在使用的会话再重试。

Node ESM 模块本身会缓存到 Host 退出，清理 effect 不等于卸载 JavaScript 缓存。一次 Host 运行最多物化 64 MiB 含 Host 模块的版本，达到后需正常重启再继续；不删除仍在使用的版本假装回收。磁盘资产总计最多 64 MiB、64 个插件、10,000 个修改回执，每个插件最多 128 个已批准执行摘要。HTTP 管理请求全局最多四个、每设备两个，不排队，并受现有管理操作速率限制；桌面大正文例外只用于创建与保存草稿。

标准 Host 启动入口在取得数据目录锁、拒绝仍存活的旧 Host 后，清理私有 `generations` 中符合内部命名的遗留源码目录，再从已应用资产重建。它拒绝链接目录、保留不属于内部命名的条目，也不改草稿、批准和回执。通用存储打开与运行时应用不执行这种清理，避免破坏仍持有租约的代次；嵌入式 Host 的调用方需要自行保证其启动互斥和清理时机。

应用内 bundle 的技能入口只接受 `.md` 或 `.txt`；执行入口与依赖模块单独保存，不能把模块同时标为技能来省略执行摘要。所有 `.mjs` 文件均进入批准摘要。技能正文仍是可信模块可读取的数据；模块若自行把文本解释为代码，属于其可信执行行为，Host 不提供源码分析或 OS 沙箱。

`dataPanels` 提供无需模块代码的静态界面：`[{id,title,description?,harnessIds?,document}]`，`document` 使用现有有限 `UiPanelDocument`。它与动态 `registerUiPanel` 使用同一验证和显示协议，不接受 HTML、脚本或任意函数。

桌面端「插件」页的「添加插件」可以新建一个工具，或导入 `.latch-plugin.json`（技能与 React 界面经文件导入）。表单写明每部分在哪里运行、会发到哪些设备。常用表单编辑名称、说明和技能正文；文件页编辑与添加源码，高级声明组合入口、配置和静态面板。保存草稿不激活，保存并应用先保存完整资产再应用返回的精确修订。超时保留不可变请求体与请求 ID，使用同一请求重试；未确认结果前不允许继续更改该草稿。导出读取已保存草稿，启停沿用已应用内容；未保存编辑时须先保存。客户端保留未知贡献字段，不用简单表单覆盖高级贡献。远程设备显示已应用插件，不提供资产编辑入口。


桌面端安装的新版本若不再加载某个插件包的 `formatVersion`，新版首次启动时这个插件不启用，资产与记录保留，插件列表写明原因；重新启用或删除即解除（[UPDATES.md](./UPDATES.md#插件兼容)）。

### 页面（formatVersion 2）

`formatVersion: 2` 的包可以带 `apps`：最多 4 个页面，每个声明入口、`dataVersion` 与能力（`tasks.read`、`tasks.start`、`tasks.continue`、`tasks.readOwn`、`storage`），可选 `requires.appSdk`（`^1`）。格式 1 原样加载，格式 2 也可以带其他贡献。页面不在 Host 进程里运行，没有可执行摘要；它的信任绑定能力集合：第一次应用或能力变宽时经 `plugin.package.apply` 确认，确认里逐条列出每个页面的能力；相同或更窄的应用只审计（`plugin.package.app-trust`）。页面经 `via` 开始与继续会话、读写插件数据、上报诊断，规则、接口与数据目录见 [APP-PAGES.md](APP-PAGES.md)。页面在不透明隔离框里运行（侧栏「应用」，手机网页底部栏「应用」），用 `@latch/app-sdk` 的 `defineApp({ page })` 导出，`page` 收到桥 `latch` 与原语 `ui`，见 [APP-PAGES.md](APP-PAGES.md#桥)。入口是 `.ts`/`.tsx` 时由 Host 用固定的 esbuild 与 TypeScript 构建（子进程、空环境、60 秒、只允许包内相对导入与 `react`、`react/jsx-runtime`、`@latch/app-sdk`），应用要求该修订构建成功；也可以用预先构建的 `.js` 模块，它导入的 `react` 与 `@latch/app-sdk` 取自 `globalThis.__latchModules`。页面草稿可以由 Agent 在会话里写（设置 › 插件 › 新应用 › 让 Agent 做，或改动页签的「作为应用草稿」），只收页面，不收 `host`、`panels` 与 `.mjs`；导入、构建、无凭据预览与开发中自动重建见 [APP-PAGES.md](APP-PAGES.md#草稿构建与预览)。

写一个页面从 [`examples/release-check/`](../examples/release-check/) 开始：它是 `latch-app/` 的样子（`latch-app.json`、`src/index.tsx`），只用 `ui` 原语，用到 `tasks.subscribe`、`tasks.start`（先把 requestId 存进 `view` 与 `plugin` 数据）、`tasks.lookup`、`tasks.readReply`、带 `ifVersion` 的 `storage.put` 与 `storage.onChange`；各个写法见 [APP-PAGES.md](APP-PAGES.md#示例发布检查)。

## 连接载体

连接载体可用 `context.registerTransport(driver)` 组合进插件，公开描述、平台无关通道、真实原生消费者与租约见 [连接插件](TRANSPORT-PLUGINS.md)。它不把消息平台身份当作设备授权；真实飞书与手机 connector 尚未实现。

## 技能

```ts
context.registerSkill({ id: 'review', name: '发布检查', description: '逐项核对证据', content: markdown })
```

技能 ID 在包内唯一，发布为 `<包 ID>:<技能 ID>`。目录包的 `skills` 等价于读取文件后调用此接口。技能的正文是模型可见的指令，不是可执行脚本；说明文件可以采用 Markdown 与 YAML frontmatter，内容按原文读取。

Standard 每轮开始时固定当时启用的技能，连同输入原子持久化 `skillContext` 与摘要上的技能 ID；这一轮的每个模型请求使用同一份指令。技能包和 Provider、工具一样持有运行租约，替换不会改变已经开始的一轮。下一轮重新取启用集合；停用后不会继续携带旧正文。对话模式同样使用技能，但不携带工具。每个技能最多 32,000 字符，合计超过 256,000 字符时拒绝开始，不能静默截断。

`catalog.skills` 只返回名称、来源与描述；正文不下发给客户端。Host 技能目前由 Standard 消费；ACP Agent 使用自己的技能机制，不会自动读取这份注册表。自定义 Driver 可以从 `HarnessHostOptions.registry.acquire()` 的租约读取 `skills`，并自行实现会话内的使用与记录。

## 界面与数据面板

插件包的 `panels` 声明或 `registerClientPanel({ id, title, description?, harnessIds?, source })` 提供完整的 React 组件。`source` 是预先构建的 ESM，默认导出一个函数组件；不运行 JSX/TypeScript 编译器，也不使用 `eval`。模块使用工作台传入的 React 实例与控件，避免携带第二份 React。作者可以在组件里设计自己的编辑、筛选、图表和多步骤交互。当前挂载位置是会话信息栏的页签；窄屏沿用同一套会话信息页面。

组件 props 的类型是 `PluginPanelProps<TaskSummary>`（`@latch/ui`）：

| 字段 | 行为 |
| --- | --- |
| `session` | 当前会话摘要的副本 |
| `react` | 工作台的 React 实例，含 hooks 与 `createElement` |
| `ui` | Button、Checkbox、TextField、TextAreaField、InlineNotice、StatusPill、Loading |
| `canCompose` | 当前设备和会话是否可填写新的输入 |
| `compose(text)` | 把文本追加到当前会话草稿；用户检查后用原输入框发送，不直接执行、不覆盖已有草稿 |
| `readData(id, signal?)` | 读取同一包内的一个数据面板，返回 `{ panel }`；绑定当前会话与查看权限 |

组件的订阅、计时器与连接放在 `useEffect` 中并返回清理函数。切换会话、离开页签或停用包会卸载组件。不要在模块顶层建立资源：ESM 的模块缓存会保留到页面关闭。React 渲染失败由包的错误边界显示重新加载入口，不使整个工作台崩溃；运行代码本身仍是可信页面代码，错误边界不提供隔离。

Host 只在认证的 `GET /link/api/ui-modules/:panelId/:sha256.mjs` 返回当前启用版本，设置 `no-store`；旧摘要与停用版本返回 404。客户端只从 Host 的同源 URL 加载，不放宽 CSP。`harnessIds` 省略表示所有 Harness，空列表表示没有适用会话。`catalog.uiPanels` 是可选字段，旧 Host 缺少时仍使用原会话信息。

轻量的只读内容可以用 `registerUiPanel({ id, title, description?, harnessIds?, render })`：`render({ session, signal })` 在 Host 返回 `UiPanelDocument`。支持 `text`、`code`、`list`、`facts` 和 `table`，最多 32 块、总计 65,536 字符；只渲染文本，不接受 HTML、事件处理器或样式对象。数据面板也能作为 React 面板的数据来源；`listed: false` 只保留认证的数据入口，不再出现在会话页签中，这不是访问权限限制。读取 API 为 `GET /link/api/tasks/:id/ui-panels/:panelId`，先核对设备与会话，再运行回调，返回前重新核对权限。取消是协作式的，插件必须遵守 signal；回调真实结算后才释放租约。插件异常只向页面返回通用错误。

本地插件资产、技能、有限数据面板、React 面板与 Host 模块均有实际消费路径。在线下载与自动更新、插件市场、按项目选择插件、通用跨插件服务依赖、独立工作区页面与时间线渲染扩展尚未实现；这些能力需要独立的生命周期与消费方契约，不能仅靠增加一个注册方法宣称支持。

## 插件对象与生命周期

```ts
interface LatchPlugin {
  id: string
  name: string
  version: string
  description: string
  activate(context: PluginContext): void | Promise<void>
}

interface PluginContext {
  registerProvider(provider: ModelProvider): void
  registerTool(tool: ToolDefinition): void
  registerHarness(driver: HarnessDriver): void
  registerTransport(driver: TransportDriver): void
  registerSkill(skill: SkillDefinition): void
  registerUiPanel(panel: UiPanelDefinition): void
  registerClientPanel(panel: ClientPanelDefinition): void
  onDispose(dispose: () => void | Promise<void>): void
}
```

在 `activate` 中完成注册与初始化；创建定时器、订阅、连接等资源后立即登记 `onDispose`。初始化失败也会清理已登记的资源。`onDispose` 按登记的逆序逐个等待；一个失败不会跳过其余清理，错误最终以 `AggregateError` 报告。

Provider ID、工具名和 Harness ID 在所有已注册能力中不能重复；技能与两种面板的 ID 在各自包内不能重复。工具名与 Harness ID 必须匹配 `^[a-zA-Z0-9_-]{1,64}$`。

旧插件接口停用要求没有租约，使用中返回 `409 plugin-in-use`。应用内自定义插件通过 `registry.retire()` 立即撤下贡献，旧运行租约真实释放后才清理；运行中的 Harness 仍要求先停止会话。Standard 的一次运行固定一个 Provider 与当时的工具集合（对话模式固定 Provider 与技能，不固定工具）；挂载中的 Harness 一直持有租约，直到被卸载或 Host 关闭。注册表把两种租约分开计数：两种都会阻止旧接口停用与删除，但 `registry.list()` 的 `activeRuns` 只数运行租约，挂载不算。设置里的插件列表（`GET /link/api/plugins`）再加上该插件注册的 Harness 中正在运行或等待批准的会话数，所以 `activeRuns` 是正在用这个插件的会话数：只加载了 Harness、没有会话在跑时为 0，界面不显示「使用中」；开关锁住时写「有 N 个会话正在使用，结束后才能停用」。

`registry.replace(plugin, beforeCommit?, options?)` 先激活候选版本，再执行可选的持久化回调，成功后发布。旧版本仍被运行使用时不会阻止替换：它会保留到最后一个租约释放后再清理，清理失败只记录日志。`preserveEnabled: true` 让已停用的插件保持停用。

## 注册工具

```js
export default {
  id: 'uppercase', name: '转为大写', version: '1.0.0', description: '将输入文本转换为大写。',
  activate(ctx) {
    ctx.registerTool({
      name: 'uppercase',
      description: 'Convert supplied text to uppercase.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      requiresApproval: false,
      title: '转为大写',
      kind: 'other',
      async execute(args, { signal }) {
        signal.throwIfAborted()
        if (typeof args.text !== 'string' || args.text.length > 65536 || Object.keys(args).some(key => key !== 'text')) {
          throw new Error('Expected only text, up to 65536 characters')
        }
        return { text: args.text.toUpperCase() }
      },
    })
  },
}
```

- `execute` 收到 `sessionId`、`callId`、`workspaceRoot`（会话项目的主文件夹，即会话的工作目录）、`workspaceFolders`（会话的全部文件夹 `{ id, path, primary }`，主文件夹在前；Standard 总是提供，旧的 Driver 可能省略，此时 `workspaceRoot` 是唯一的文件夹）与 `signal`，返回 `{ text }`；抛错会作为错误结果交回模型。Standard 不会替工具执行完整的 JSON Schema 校验，工具必须自行校验输入。
- 项目可以有多个文件夹。让模型用文件夹的 `id` 选择文件夹，路径相对于所选文件夹；不要把绝对路径交给模型。内置 [workspace-files](../apps/host/src/plugins/tools/workspace-files/index.ts) 的做法：`list_folders` 只返回 `{ folder, name, primary }`（标识、文件夹名、是否为主文件夹），其他工具带可选参数 `folder`，缺省为主文件夹，不是会话的文件夹时拒绝。
- `kind`（`read | edit | delete | move | search | execute | think | fetch | other`）决定工具卡片的图标。
- 可选的 `title` 是工具做什么的简短说法，用产品的语言写（「读取文件」「写入文件」）。过程行与审批卡写它加这次调用的对象（路径、命令、搜索词或地址，从参数 `path`、`command`、`query`、`url` 等读出）：「写入文件 notes/plan.md」，运行中是「正在写入文件 notes/plan.md」。标题只用于显示：Host 截到 40 个字符、把不可见与改变方向的字符显示为 `\u{…}`，它不参与风险分级，审批卡仍写出工具名。没有 `title` 时过程行按 `kind` 写动词与对象，读不出对象时写工具名（等宽），不猜。
- 把 `signal` 传给网络与子进程；在不可逆写入前再次检查；取消清理完成后才结束 Promise。`callId` 可作为外部系统的幂等键，但本身不提供幂等性。
- 工具 SDK 返回一次最终结果，没有 stdout 分片或百分比进度。
- 等待用户输入的协作式工具可设 `waitsForUser: true`：Standard 将等待排除在工作用时之外；这不改变 Host 的风险分级。可选的 `resultCommitted({sessionId, callId, state})` 在工具结果落盘后、模型继续前调用，`state` 为 `completed | failed | cancelled`。回调必须真实结算，不能确认尚未落盘的结果。内置问答使用这一回调确认回答。

内置 `ask_user` 接受 `{prompt, questions:[{id,label,multiple?,options:[{id,label,description?}]}]}`，每题必答，单选或多选均提供「其他」。最多十题、每题二十个选项，完整题包最多 32000 字符；只在 Agent 模式提供，不索取密钥。回答作为 `latch.question-result` 工具结果交回当前模型。ACP 尚未接入这项功能：只有 Agent 声明支持且对应方法进入稳定 schema 后才会实现。

### 预览

可选的 `preview(args, { workspaceRoot, workspaceFolders, signal })` 必须无副作用，返回 `{ title?, diffs? }`。Standard 在需要审批的调用（风险不是 R0，或工具声明了 `requiresApproval`）执行前调用它，结果显示在审批与工具卡片上；抛错或返回无效值时忽略，不阻止调用。

每个 diff 是 `{ path, oldText?, newText, previous? }`，`previous` 说明目标文件原来的状态：

| `previous` | 含义 | 界面 |
| --- | --- | --- |
| `'none'` | 确认文件不存在，这是新文件；只在确认不存在时使用 | 直接显示新增内容，不另加标记 |
| `'text'` | `oldText` 是原内容 | 按行显示差异 |
| `'unavailable'` | 文件存在，但原内容没有显示（过大、二进制或无法读取） | 「原内容未显示」，提示写入会覆盖它 |
| 省略且没有 `oldText` | 没有说明 | 「原内容未知」，不当作新文件 |

标题截到 200 字符；最多保留 20 个 diff，`previous` 取值无效的 diff 被丢弃；全部 diff 的路径与文本合计超过 1,000,000 字符时不显示 diff。内置 `write_file` 的预览（[workspace-files](../apps/host/src/plugins/tools/workspace-files/index.ts)）是参考实现：读不到原文时用 `lstat` 区分 `none` 与 `unavailable`，无法判断时按 `unavailable` 处理。

### 风险分级与审批

Standard 在每次工具调用执行前请 Host 分级（`HarnessHostOptions.classifyToolCall`，规则在 [risk.ts](../apps/host/src/risk.ts)），由分级决定是否审批，而不是由工具自己声明：

| 等级 | 哪些调用 | 审批 |
| --- | --- | --- |
| R0 | 内置 `workspace-files` 的 `list_folders`，以及会话任一文件夹中的 `list_files`、`read_file`；`--demo` 时的演示工具 `long_task` | 直接执行 |
| R1 | 内置 `write_file` 写入会话任一文件夹内的普通路径；`--demo` 时的演示工具 `write_report` | 每次询问，可选"本会话始终允许" |
| R2 | 其他所有工具，包括所有第三方插件注册的工具；内置文件工具的 `folder` 不是会话的文件夹；`write_file` 写入受保护路径（如 `.git/`、`.env*`、`package.json`、锁文件、`.github/workflows/`、`node_modules`、`.codex`、`.opencode`、`AGENTS.md` 等 Agent 配置，按所选文件夹判断，完整列表见 [paths.ts](../apps/host/src/paths.ts)）、越出所选文件夹的路径，或所选文件夹与 Latch 程序目录重叠（或无法解析）时的任何写入 | 每次询问，没有"始终允许"，即使同一工具此前在本会话被"始终允许" |

- 分级表只列出内置工具。第三方工具的 `requiresApproval: false` 会被忽略，它们一律是 R2，只读工具同样每次询问。`requiresApproval` 只在没有分级器的场合（例如直接用 `createRuntime` 写的测试）决定是否询问。
- 分级器抛错或返回未知值时按 R2 处理。审批的 `risk` 字段由 Host 按当前分级重新计算（不低于运行时记录的值，至少为 R1），并与待处理审批一起持久化；Host 重启后旧审批失效，不会被重新批准。Host 的分级为 R2 时，审批另带原因 `riskReason`（第三方工具为 `unlisted-tool`），审批卡写成「高风险 · Latch 不认识的工具」。工具的 `title` 与 `kind` 不参与分级：把自己叫作「读取文件」的插件工具仍是 R2。
- R2 每次询问，不提供「始终允许」；持有 `approve:elevated` 的设备都能允许，其他设备只能拒绝或取消。每次决定都有审计。

## 注册模型 Provider

设置页可以直接添加用 Chat Completions、Responses、Anthropic Messages 或 Gemini 协议的模型服务。只有接入其他协议时才需要编写 Provider 插件：

```ts
interface ModelProvider {
  id: string
  name: string
  model: string            // 默认模型
  models?: string[]        // 可选模型；缺省时只有 model
  stream(request: { messages: ModelMessage[]; tools: ToolDefinition[]; signal: AbortSignal; model?: string; effort?: string }): AsyncIterable<ModelDelta>
}
```

请求带 `model` 时必须使用该模型，不能静默替换；不支持时抛错。`ModelDelta`：

| 事件 | 约定 |
| --- | --- |
| `{ type: 'text', text }` | 本次新增文字，不是累计全文 |
| `{ type: 'reasoning', text }` | 模型报告的思考片段；展示给用户，不进入后续请求的历史 |
| `{ type: 'tool-call', call }` | 已完整解析的 `{ id, name, arguments }`；arguments 必须是对象 |
| `{ type: 'usage', inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }` | 计入消息与会话用量。`inputTokens` 是全部输入（含缓存），`outputTokens` 是全部输出（含推理）；三个可选部分只在模型服务报告时填写，没报告就省略，不要填 0（合计时某一部分只有每一步都报告了才保留） |
| `{ type: 'finish', reason: 'stop' \| 'tool-calls' }` | 必须是最后一个事件；之后仍有内容或流直接断开都视为协议失败 |

把 `signal` 交给底层请求，并在退出时释放读取器。调用 ID 在同一会话历史中须唯一；处理 `ModelMessage.isError`，不要把拒绝或工具错误变成成功信息。`tools: []` 表示对话模式，不能发送工具声明。日志与错误不要包含密钥。

内置的四种协议是完整参考：每种协议一个文件（[chat-wire.ts](../apps/host/src/plugins/providers/chat-wire.ts)、[responses-wire.ts](../apps/host/src/plugins/providers/responses-wire.ts)、[anthropic-wire.ts](../apps/host/src/plugins/providers/anthropic-wire.ts)、[gemini-wire.ts](../apps/host/src/plugins/providers/gemini-wire.ts)）负责地址、请求体、分片组装、完整参数解析、终止校验与大小限制，插件工厂 [service.ts](../apps/host/src/plugins/providers/service.ts) 负责模型与思考深度的选择、取消与密钥脱敏；共用的 SSE 分帧、错误响应读取、密钥脱敏与参数解析在 [http.ts](../apps/host/src/plugins/providers/http.ts)。服务给工具调用附带、之后必须原样带回的数据（Gemini 的 `thoughtSignature`；Anthropic 与 Responses 一次回复里签过名或加密的推理，放在这次回复的第一个调用上）放在 `ToolCall.signature` 的 `value`，至多 1 MiB，`by` 写协议、服务与模型；会话历史保存它，界面、审批、审计与日志看不到，Provider 只把 `by` 是自己的发回。只在产生它的这一轮里带回的写 `scope: 'turn'`，下一条用户输入开始新的一轮时 Host 从历史里删掉它；Anthropic 与 Responses 就是这样，见 [MODEL-CONFIGURATION.md](MODEL-CONFIGURATION.md#latch-内置的思考深度)。

### 出站请求与密钥

- 模型请求经 Host 出站策略；密钥只发往保存时的地址。
- 插件上下文不提供 Host 的出站 `fetch`。第三方插件自己的网络访问不受出站策略约束——插件是可信本机代码。

## 注册完整 Harness Driver

需要自己的 Agent 循环、存储或外部进程时实现 Driver，而不是塞进 Provider。通用的外部 Agent 优先通过 [ACP](./HARNESSES.md) 接入，无需编写插件。

```js
import { createMyHarness } from './my-harness.mjs'

export default {
  id: 'my-harness-plugin', name: '自定义 Harness', version: '1.0.0', description: '连接自有执行系统。',
  activate(ctx) {
    ctx.registerHarness({
      id: 'my-harness', name: 'My Harness', version: '1.0.0',
      capabilities: { modes: ['agent'], permission: { enforcement: 'harness' } },
      status: () => ({ status: 'ready' }),
      create: options => createMyHarness(options),
    })
  },
}
```

- 所有已启用的 Harness 都会被挂载并出现在新会话的选择器中；`--harness my-harness` 让它成为默认值。
- `capabilities` 写这个 Harness 实际做什么，客户端只读这些事实，不判断它是哪种 Driver；不知道的项不写，Host 按最弱处理。`modes` 列出接受的模式。`models.owner: 'latch'` 表示使用 Host 的模型服务（客户端会显示模型选择器并传入 `model`），`'harness'`（默认）表示自行管理模型；不支持的模式或模型请求由 Host 以 400 拒绝。`models.catalogue` 说明开始前能否知道可选项（`none` 为默认），`models.wires` 列出 Latch 能把它的请求转发过去的模型协议（空表示不能经 Latch 转发），`models.experimental` 表示这种转发还没有经过真实使用，`models.knownOnly` 表示经 Latch 时它只用服务里它自己认识的模型（草稿只提供它自己列表里有的）；声明了协议的 Driver 收到 `CreateTaskInput.modelRoute` 与 `options.modelGateway`，按进程 `open` 一个网关凭据交给 Harness，进程结束时 `close`，`active()` 为假后换进程；一轮发出时调用一次 `takeTurn()` 清掉两轮之间的计数，结束时再调用一次，把网关自己数的请求、模型与令牌记进 `TurnStats.routed`。`permission.enforcement` 写谁决定工具调用能否运行（`harness` 或 `none`，默认 `none`），`permission.rejectionNote` 表示拒绝说明能送到模型（默认 `false`）。`tools.fileMentions` 表示消息里提到的项目文件能送到它（默认 `false`，这时 Host 拒绝带文件引用的输入）。`display.label` 是显示的名字（默认 `name`），`display.mark` 是客户端固定图标集的键（预设 ID 或 `plugin`），不是地址或图片。`fork: 'native'` 表示它能分叉自己会话的记录：分叉到它自己的会话时 `CreateTaskInput.fork` 给出来源会话、分叉的那一轮的最后一条消息与 prompt 开头种子的长度，Driver 让 Harness 分叉并在首条用户消息记 `nativeFork`、不发种子，做不到时照常发送种子并写明原因（默认不声明，只用种子；见 [ARCHITECTURE.md](ARCHITECTURE.md#会话分叉)）。
- 这些事实是对用户的陈述，描述的一方说了不算，由 Host 钳制：只有内置 Harness 能得到 `enforcement: 'latch'`（其他写了也算 `harness`，会话仍是 L3，也收不到分级器）；只有内置 Harness 能说 `tools.shell: false`；其他 Harness 的名字与内置的相同或只差大小写、宽度、空白与不可见字符时显示为「…（非内置）」，也不能用内置的图标。
- `status()` 可选，返回 `ready` 或 `unavailable` 与说明，例如依赖的程序未安装。
- `create(options)` 同步返回尚未启动的 Bridge，异步初始化放进 `start()`。`options`（`HarnessHostOptions`）包括私有 `dataDir`（`<数据目录>/harnesses/<driver-id>`，不要写入用户工作区）、默认 `workspaceRoot`、允许的 `workspaces()`（各项目的主文件夹）、`registry`、`providerId`、`defaultModel()` 与可选 `maxSteps`。
- `projectFolders: 'all'`（可选）：Driver 能使用项目的全部文件夹。Host 因此在新建会话时传入 `workspaceId` 与 `folders`（`{ id, path }` 的有序列表，`[0]` 就是 `cwd`），并在 `options.projects()` 中列出当前可用的项目及其文件夹（`default` 是启动目录）；Driver 应据此核对 `folders`，在会话中保存它们，并在每次输入前确认它们仍属于该项目（否则 409 `workspace-changed`）。会话应把它们记在 `TaskSummary.workspaceId` 与 `folders` 中。没有声明的 Driver 只收到主文件夹作为 `cwd`，`HarnessInfo.projectFolders` 也不声称它能使用其他文件夹。L3 Driver 同样收到这些字段，`launchPreview` 也收到 `workspaceId` 与 `folders`，并在返回的 `folders` 中列出 Agent 除 `cwd` 之外还会收到的文件夹，启动审计记下文件夹的数量。使用 Registry 时在运行开始时取得 `acquire(providerId, { tools })` 租约，并持有到运行真正结束。
- `folderAccess`（可选）：告诉客户端 Harness 怎样对待项目的其他文件夹，成为 `HarnessInfo.projectFolders`。声明了 `projectFolders: 'all'` 时写 `{ access: 'all', max? }`，`max` 是能在其中新建会话的项目最多有几个文件夹（Host 超出时返回 409 `harness-folder-limit`）；没有声明时可写 `{ access: 'primary' }`（只用主文件夹，默认）、`'primary-asks'`（使用其他文件夹前会询问）或 `'primary-unbounded'`（只收到主文件夹，但不限制能访问的目录）。没有声明 `projectFolders: 'all'` 的 Driver 写 `all` 会被忽略。
- `options.tmpRoot`：Host 运行目录下私有的 0700 目录（`<运行目录>/tmp`），所有 Driver 共用。在其下为每个会话建立自己的 0700 子目录（ACP 用会话标识的 sha256 前 16 位命名），删除会话时清理；Host 关闭时整个目录被删除，不要在其中保存需要保留的数据。
- `options.securityEvent(event)`：上报 `permission-drift`（带模式值的哈希 `observedHash`）、`permission-unverified`、`model-route-bypassed`（经网关的会话有一轮没有经过网关；Host 写 `task.model.bypassed`）、`approval-auto-rejected`（原因 `persistent-only`、`unknown-kind`，或子 Agent 的请求比会话的权限宽时的 `subagent-wider`）或 `tool-judged`（在 Harness 自己的模型代人决定的模式里没有问人的一次调用：`callHash`、`modeHash`、`kind`、`outcome` 与 `source`，只有哈希与枚举）。Host 把漂移、自动拒绝与 `tool-judged` 写入审计（`task.permission-drift`、`task.approval-auto-rejected`、`task.tool.judged`），`permission-unverified` 只写入 Host 日志，然后刷新该会话；调用不会抛错。只有 `tool-judged` 返回一个 Promise，审计写不进去时它被拒绝，Driver 应当取消这一轮。
- `options.proposeMemory(input)`：会话的执行上下文带 `proposals`（我的 Agent 的会话或「和通用的对话」）时，把 Agent 提议的一条记忆交给 Host：`{ sessionId, messageId?, content, reason?, external, key }`，只有 `content` 与 `reason` 来自 Agent；`key` 在会话的通道内唯一，重复交一次只建一条；`external` 表示这一轮在它之前可能读过外部内容，拿不准时为真。Host 只建一条待人确认的提议，从不直接保存；被拒绝（像密钥、过长、过多）时以原因拒绝，原因从不复述内容。内置 Harness 的运行循环与 ACP 驱动用它，见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#记忆提议)。
- `options.clock()`：Host 的时钟（毫秒），默认就是 `Date.now`。消息与运行的时间（`createdAt`、`startedAt`、`completedAt`、`runStartedAt` 等，见 [STREAMING.md](./STREAMING.md)「时间与用量」）用它记录，客户端按 Host 发出的 `hostTime` 校准，所以 Driver 记录时间时用它，不要直接读 `Date.now`；没有提供时（旧 Host）退回 `Date.now`。
- `options.classifyToolCall(input)`：Host 的工具分级器（`{ toolName, arguments, cwd, sessionId, folders? }` → `R0 | R1 | R2`，语义见上文；`folders` 是会话的文件夹，缺省时只有 `{ id: 'default', path: cwd }`），只传给内置 Standard；第三方 Driver 收不到它。

### 第三方 Harness 的会话是 L3

Host 把第三方 Harness 插件的会话标为完全访问（L3）：Latch 无法核实它的执行范围。规则与 ACP 会话相同（见 [HARNESSES.md](./HARNESSES.md)）：

- 任何持有 `run` 的设备都能新建会话、发送输入、修改设置与允许询问，不弹确认，每次启动都有审计；只有 `view` 的设备只能查看、拒绝和取消。

### Bridge 契约

签名以 [bridge.ts](../packages/sdk/src/bridge.ts) 为准：

| 方法 | Host 期待的行为 |
| --- | --- |
| `start / close` | 初始化；关闭时等待执行、取消与资源清理 |
| `listTasks / detail` | 返回产品 DTO：稳定的消息 ID 与真实状态，不把 Harness 私有类型传给客户端 |
| `createTask / prompt` | 接收 `requestId` 并持久化去重；不支持的模式必须报错，不能把 chat 当 agent；`cwd` 必须属于 `workspaces()`；声明 `projectFolders: 'all'` 的 Driver 还会收到 `workspaceId` 与 `folders`；L3 Driver 的 `createTask` 还会收到确认过的 `expectedLaunchHash` |
| `cancel` | 等待实际执行结算；后端只回复"已收到"不够。带 `options.runId` 时只在它仍是当前运行时取消，并在开始取消的同一步核对（之间不能有 `await`），这样迟到的取消不会停止之后开始的运行；没有可取消的运行或 `runId` 不符时返回 `false`，取消并结算后返回 `true`；不区分的旧 Driver 可以不返回值 |
| `cancelSubagent?` | 可选，配合 `Subagent.stoppable`。按那一行的消息 ID 停止一个子 Agent 当前的工作，并把它挂起的请求答复为取消，会话的这一轮继续；发出停止就返回 `true`，那一行写 `stopping` 直到它报告结果；这一行现在不能停止时返回 `false` |
| `approvals / decide` | 返回当前有效审批；并发决定只有一个成功；`optionId` 必须属于该审批，旧审批或重复决定返回 false。`options.via` 说明人在哪里决定（`this-mac` 或 `other-device`），用于工具行的决定记录；`options.note` 只随拒绝出现，是「告诉 Harness 改做什么」的说明，权限回复不能带文字的 Driver 忽略它 |
| `subscribe` | 状态变化时通知，带 sessionId 时 Host 会合并通知并推送该会话状态 |
| `liveRuns?` | 可选。同步返回内存中活动的运行 `{ sessionId, live }`，开销只随活动运行数增长：Host 每次变化与阈值到期时都调用，据此发现沉默；不提供时没有沉默通知 |
| `remove?` | 可选。删除已结束会话的数据；运行中返回 409 `task-running` |
| `setConfig?` | 可选。修改 `TaskDetail.config` 中的选项，从下一轮生效。Host 提供的 `options.authorize?: () => void` 须在异步准备后、实际外部修改前同步调用；抛错则停止，不能吞掉拒绝继续执行。只在修改还没发给 Agent 时用 409 `task-running` 拒绝（如会话的这一轮还在启动）：Host 把它记为明确失败，其他错误在回执之后都记为结果未知 |
| `classifyConfigChange?` | 可选。返回修改与会话预期权限模式的关系：`neutral`、`stricter` 或 `wider`。Host 只用它决定是否写放宽模式的审计 |
| `launchPreview?` | 可选，L3 Driver。描述在某个目录（`{ cwd, workspaceId?, folders? }`）新建会话将启动什么，用于启动指纹与审计；Agent 还会收到的其他文件夹写在返回的 `folders` 中 |
| `listExternalSessions?`、`loadExternalSession?`、`closeExternalSession?`、`adoptExternalSession?`、`agentSessionIds?` | 可选，与 `HarnessDriver.historyImport` 一起。接入这个 Harness 在 Latch 之前的会话：只列元数据、一次保留重放的加载、以 Host 选定的会话 ID 绑定原会话（删除时不删原会话），以及 Driver 自己的会话用过的 Harness 会话 ID（不列出供接入）；见 [HARNESSES.md](HARNESSES.md#接入已有会话) |

会话 ID 与审批 ID 必须全局唯一（建议 UUID 或带前缀的 UUID），不超过 256 字符；Host 按 ID 把请求路由到对应 Driver，冲突时先挂载者胜出。

`detail()` 必须返回可独立渲染的当前状态，而不是增量。以下字段可选，旧 Driver 可以省略：

| 字段 | 约定 |
| --- | --- |
| `liveMessageId` / `liveReasoning` | 最终助手消息沿用该 ID，思考结算到 `reasoning`，界面保留同一行 |
| `activity` | `starting / model / tool / approval / cancelling`、可选 toolName 与这个阶段开始的 `since`；不要捏造进度 |
| `TaskSummary.live` | 运行在做什么、最后的动静（[STREAMING.md](./STREAMING.md#运行的真实状态)），只在运行期间、不持久化；`silenceThresholdMs` 与 `silent` 由 Host 计算，Driver 写了也会被丢弃 |
| `TaskSummary.runEnd` | 运行不是以普通回答结束时的原因与结果未知的调用，随会话持久化，新运行开始时清除 |
| `plan`、`config` | 最新计划；可修改的会话选项 |
| `Message.tool`、`Message.usage` | 工具卡片的结构化信息（diff 的 `previous` 见「预览」）；用量 |
| `Message.createdAt`、`startedAt`、`completedAt`、`reasoningMs`、`model`、`turn`；`TaskSummary.createdAt`；`TaskDetail.runStartedAt`、`runWaitMs`、`runWaitingSince`、`lastOutputAt`、`liveReasoningStartedAt`、`liveReasoningMs`、`usageReport` | Host 记录的时间、模型与 Agent 的上下文报告（见 [STREAMING.md](./STREAMING.md)「时间与用量」）；没有可靠来源时省略，界面就不显示对应部分 |
| `Approval.toolCallId`、`options`、`tool` | 对应 `tool:<toolCallId>` 的工具行；选项；预览 |
| `Approval.risk`、`advisory`、`riskReason` | Standard 填写 `risk`；外部 Driver 的审批由 Host 标为 `advisory` 与 `R2`，不由 Driver 声明；`riskReason` 只由 Host 填写 |
| `ToolDetail.decision` | 审批结束后写在那次调用上：`{ outcome: 'allowed' \| 'rejected' \| 'expired' \| 'cancelled', at, via? }`。人的选择带 `via`；没有人回答（停止、超时）时写 `expired` 或 `cancelled`，不带 `via`，不要写成 `rejected`。不写设备名 |
| `ToolDetail.toolTitle` | Standard 从工具定义的 `title` 填写；外部 Driver 不填 |
| `TaskSummary.usage` | 会话累计用量 |
| `TaskSummary.runId` | 当前或最近一次运行的标识：每次 `createTask` 或 `prompt` 开始运行时换成新值并持久化，同一 `requestId` 的重试不换；最多 128 个字符，由字母、数字与 `_.:@+-` 组成，以字母或数字开头，其他形式的值 Host 不转给客户端（停止时不指名运行）。客户端取消时带上它 |
| `TaskSummary.level`、`TaskDetail.permission` | 由 Host 生成，Driver 不要填写 |
| `sync`、`AppSnapshot.revision` | 由 Host 生成，Driver 不要伪造 |

`Message.state` 支持 `queued`、`awaiting-approval`、`running`、`completed`、`failed`、`cancelled`；工具过程应在同一消息 ID 上推进。外部 Driver 必须说明崩溃后的恢复方式、未知副作用的处理与无法取消的操作；Host 不会替它提供 Standard 的原子回执与崩溃修复。

## 验证与调试

```sh
pnpm typecheck
pnpm exec vitest run --config vitest.config.ts tests/registry.test.ts tests/runtime.test.ts apps/host/test/hub.test.ts apps/host/test/risk.test.ts apps/host/test/providers.test.ts apps/host/test/egress.test.ts
pnpm build
pnpm test:e2e
```

新增 Provider 或工具时优先写聚焦的 Vitest 用例：参数异常、信号取消、流截断、清理失败与真实副作用。Provider 测试注入假的 `FetchLike`，或用 `createEgressFetch({ allow: () => ['127.0.0.1:<端口>'] })` 放行本地假服务，不访问回环以外的网络。改变连接、审批或取消行为时运行真实 Host 的浏览器 e2e。

插件启用失败先看激活错误，检查重复能力名与资源清理；停用返回 `plugin-in-use` 时先等待或取消任务。发生持久化中断时先核对工具的真实副作用，不要靠重复点击"允许"或复用旧 requestId 强制重跑。

`PromptOptions.queuedAt?: string` 是 Host 记录的排队 ISO 时间，Driver 应在实际接纳的用户消息上保留它，并把请求的 requestId 原样写入用户消息。可选 TaskSummary.runOutcome 为 completed/failed/cancelled/interrupted，新运行开始清除，在执行端真实结算后写入；Host 只把 completed 作为自动派发依据，缺失时暂停。

### 附件声明与读取

`HarnessDriver.capabilities.attachments?: { images?: boolean; text?: boolean; textBytes?: number }` 声明接收能力，缺少即不展示；能力要等 Harness 启动后才知道的 Driver 另实现可选的 `Bridge.promptCapabilities()`，返回它最近一次为当前定义启动时报告的 `{ images, text }`，之前返回 `undefined`；返回了就以它为准（使用 Latch 模型服务的 Harness 也一样，图片仍要模型声明视觉），没返回时用声明。`CreateTaskInput.attachments?` 与 `PromptOptions.attachments?` 是 `AttachmentRef[]`；`HarnessHostOptions.readAttachment?(ref, signal?)` 返回本轮的 `AttachmentContent`（`{type:'image',mimeType,data}` 或 `{type:'text',name,text}`），`saveAttachment?({sessionId,mime,data})` 保存 Agent 输出图片。持久化只保存引用，不保存物化内容，不把附件复制到项目目录。Host 仍验证设备、会话、文件类型和限额。

`ModelProvider.modelCapabilities?: Readonly<Record<string,{vision?:boolean;thinking?:string[]}>>` 按模型显式声明视觉输入与可接受的思考深度（上线值，由弱到强）；`stream()` 的 `effort` 只会是该模型声明过的一项，未声明的必须拒绝（`effort-unavailable`），不发 `effort` 时用模型自己的默认值。`ModelMessage.attachments?` 承载执行前物化的内容块。没有声明视觉能力的模型收到图片时应拒绝，不能忽略或偷偷换模型。内置适配器保持原出站 fetch 与密钥边界。完整协议与限额见 [ATTACHMENTS.md](ATTACHMENTS.md)。

`CreateTaskInput.fileRefs` / `PromptOptions.fileRefs` 是经 Host 验证的 `{root,path}` 列表，最多 32 条；Standard 与 ACP 保存为 `Message.fileRefs`，保留用户原文，只在模型上下文追加目录映射。插件 Harness 尚未接入该引用实现时，Host 明确拒绝；不能仅凭支持项目目录就宣称支持文件选择。

文件变化的范围、运行结算、可选插件契约与验证见 [运行期间的文件变化](FILE-OUTPUTS.md)。

### 清空上下文

`PromptOptions.freshContext?: true` 要求这一轮在新的上下文里开始：Harness 看不到会话之前的消息，消息留在记录里，这一轮的用户消息带 `freshContext`。只有在详情里声明 `clearContext: true` 的 Driver 会收到它（Standard 与 ACP 已实现），它要计入请求的幂等哈希。Driver 在这一轮被接纳前就放下了旧的上下文、这一轮却被拒绝时，在详情里带 `contextCleared: true`，直到下一条用户消息记下，页面据此不再提供撤销。助手消息可以带 `thinking`（这一步的思考深度），与 `model` 一样用 Harness 的叫法。

### Agent 上下文

`CreateTaskInput.agentContext?` / `PromptOptions.agentContext?` 是 Host 构造的 `AgentExecutionContext`，不是可由 HTTP 客户端授予的权限。`agent` 持久化为会话归属。Driver 用 `agentContext` 声明接收方式：`private` 必须保证 `instructions` 只对当前运行可见、不进入公开消息或可分叉历史，并对每轮输入校验原归属，Standard 已实现；`first-turn` 把 `brief` 随第一轮发给 Harness，并记录到那条用户消息的 `agentBrief`，ACP 已实现。未声明的 Driver 收不到 Agent 上下文。

`registry.acquire(providerId, {tools, pluginIds})` 的可选 `pluginIds` 固定本轮工具和技能的归属插件。缺省保持旧行为；显式空列表不租用工具或技能；选择的插件已停用或移除时报错。Provider 独立租用，不能通过 Provider 所属关系额外提供未选中的工具。Agent 的说明、记忆与数据范围规则见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md)。


### 执行修订

Host 可在 `register(plugin,{revision})` 或 `replace(plugin,beforeCommit,{revision})` 传入已实际应用的完整来源与配置 SHA-256。`revisionSnapshot(ids)` 返回各插件的摘要与 `persistent`；没有完整摘要的旧模块使用当前 activation 的随机指纹，重启、替换或重新启用后改变，不把相同 semver 当作旧授权仍然有效。替换未提供新摘要时也不继承旧摘要。

已保存的执行授权可通过 `registry.acquire(providerId,{pluginIds,expectedRevisions})` 同步复核，必须包含实际 Provider 归属和每个选中的插件。变更中、已停用、缺少修订或摘要变化都拒绝新租约。旧租约仍保留原代，直到真实运行结束再清理。`AgentExecutionContext.expectedRevisions` 仅由 Host 构造，Standard 在持久化新运行之前复核，指纹不包含私有记忆正文，也不进入公开消息。内容摘要描述已批准的来源，不构成 OS 隔离或第三方外部依赖完整性的保证。
