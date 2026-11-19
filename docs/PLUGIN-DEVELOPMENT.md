---
description: 插件开发：类型源、加载与插件包、应用内的插件资产、插件对象与生命周期、技能与面板、注册工具（预览、风险分级与审批）、注册模型 Provider、注册 HarnessDriver 与 Bridge 契约、验证与调试。
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
  - packages/core/src/permission-modes.ts
  - apps/host/src/egress.ts
  - apps/host/src/providers.ts
  - src
  - examples
---
# Latch 插件开发

一个插件是一个包：可以同时提供技能、工具、面板、页面、模型 Provider、连接载体与完整 Harness，也可以只有其中几项。作者只经 `PluginContext` 注册能力；Host 用 [Cordis](https://github.com/cordiverse/cordis) 的 fiber 管理每个插件的贡献与清理，只有 `packages/core/src/registry.ts` 导入 `cordis`。

**插件是可信本机代码。** Host 模块有 Host 进程的权限，客户端模块有当前页面的权限。工具审批、路径检查、出站策略、错误边界与挂载位置都不隔离插件代码，批准与内容摘要也不是 OS 沙箱。客户端文件会发给所有已登记、能查看的设备，不能含密钥、环境变量值或只应留在 Host 的资料。只有[页面](APP-PAGES.md)在隔离框里运行。

**类型源。**

| 入口 | 内容 |
| --- | --- |
| `@latch/sdk`（[packages/sdk](../packages/sdk/)） | [plugins.ts](../packages/sdk/src/plugins.ts)（插件、`PluginContext`、Provider、Tool）、[harness.ts](../packages/sdk/src/harness.ts)（`HarnessDriver`、`HarnessHostOptions`）、[bridge.ts](../packages/sdk/src/bridge.ts)（Bridge）、[errors.ts](../packages/sdk/src/errors.ts)（`AppError`） |
| `@latch/sdk/plugins`、`@latch/sdk/harness` | 只含类型的子路径，即前两个文件，不含 `AppError` |
| `latch/plugin-sdk`、`latch/harness-sdk`（[src/](../src/)） | 根包的兼容入口，再导出上面两个子路径；以旧包名安装的插件写 `harness-link/plugin-sdk` 同样可以编译 |
| `@latch/protocol/types` | 它们引用的浏览器 DTO |
| `@latch/ui` | 客户端面板的 props 类型 `PluginPanelProps` |

签名以这些文件为准，本文只写签名说不出的规则。两个包只在本仓库的 workspace 中使用，带版本承诺的独立 SDK 包尚未发布；本地插件编译为 ESM `.mjs`。内置模型协议的 HTTP 辅助（[providers/http.ts](../apps/host/src/plugins/providers/http.ts)）不属于 SDK。

「设置 › 扩展」把只有技能与数据面板的插件列为「Latch 提供」的数据；含 Host 模块、工具、面板模块、Provider、Harness 或连接载体的插件只列在折叠的「这台 Mac 上的开发者」里，标「可信的本地代码」，不隔离（[HARNESSES.md](HARNESSES.md#扩展)）。

## 加载插件

```sh
pnpm start -- --data-dir <数据目录> --workspace <项目目录> --port 0 --plugin ./examples/text-statistics.mjs
```

- `--plugin` 可重复，路径相对启动目录，指向插件包目录或默认导出插件对象的 `.mjs`。嵌入时用 `loadPluginPackage(path)`（`@latch/host`）再传给 `startServer({ plugins })`。
- 只读取显式给出的本地路径，不安装依赖、不下载代码。
- `--harness <driver-id>` 让该 Harness 成为新会话的默认值并要求它启动成功；`--provider <provider-id>` 选择内置 Harness 的默认模型服务。两者是能力 ID，不是插件 ID。演示模型必须显式用 `--demo`。
- 经 `--plugin` 加载的插件，启停保存在 `settings.json` 的 `plugins.disabled`；改源码要重启 Host。
- 设置页管理的模型服务与 ACP Agent 也是插件（`managed` 为 `provider` / `agent`），在各自的设置页修改；内置插件（`managed: 'core'`）不能停用。

内置插件用同一组接口，在 `apps/host/src/plugins/<种类>/<id>/`；ACP Driver 是单独的包 `@latch/harness-acp`。插件目录只导入 `@latch/sdk`、`@latch/protocol`、已安装的包、本目录与同一种类共用的文件，不导入 Host 或其他插件目录；Host 的能力（出站 `fetch`、受保护路径）经插件参数传入，`pnpm lint` 检查（[ARCHITECTURE.md](./ARCHITECTURE.md#workspace-项目)）。

示例：[text-statistics.mjs](../examples/text-statistics.mjs)（一个工具）、[session-overview.mjs](../examples/session-overview.mjs)（数据面板）、[release-review/](../examples/release-review/)（技能、工具、数据面板与 React 面板的包）、[release-check/](../examples/release-check/)（页面）、[message-port/](../examples/message-port/)（连接载体）。

## 插件包

目录里的 `latch-plugin.json` 声明各入口（`formatVersion`、`id`、`name`、`version`、`description`、`host`、`config`、`skills`、`panels`、`dataPanels`），样子见 [release-review/latch-plugin.json](../examples/release-review/latch-plugin.json)。

- 清单是 strict 的（`pluginManifestSchema`）。`host`、`skills`、`panels`、`dataPanels` 各最多 32 项。
- 所有入口必须在包目录内；绝对路径、逃逸路径与指向目录外的符号链接被拒绝（400 `plugin-package-invalid`）。
- 清单不超过 64 KiB，技能文件不超过 32,000 字节，面板模块不超过 1 MB。
- `host` 是有序的模块列表，每个默认导出 `{ activate(context, config) }`。`config` 是清单配置的独立副本，模块自己校验。模块可用全部注册能力，包括 `registerHarness`。
- 一个包的模块共用注册归属与清理栈：后一个激活失败时，已登记的技能、面板、工具与资源一并回滚。顶层 import 在加载时执行，副作用放进 `activate` 并用 `onDispose` 登记清理。
- `skills` 等价于读文件后 `registerSkill`，`panels` 等价于 `registerClientPanel`，`dataPanels`（`[{ id, title, description?, harnessIds?, document }]`）等价于返回固定 `UiPanelDocument` 的 `registerUiPanel`，不需要模块代码。
- 作者预先构建 ESM 并备好 Host 模块的本地依赖。

`formatVersion: 2` 另可带 `apps`（页面，最多 4 个）与 `requires.appSdk`；格式 1 原样加载。页面的清单、能力、信任、构建与桥见 [APP-PAGES.md](APP-PAGES.md)。

## 应用内的自定义插件资产

Host 声明可选能力 `catalog.features.pluginPackages`。资产是 `{ manifest, files: [{ path, content }] }`，保存在私有的 `plugin-packages/assets.json`：草稿、已应用快照、已批准的执行摘要与设备绑定的修改回执。

**谁能管理。** 只有 `host.sock` 上已登记、有 `admin` 且数据范围为 `all` 的设备（数据范围不符时 403 `plugin-package-scope`）；浏览器与原生远端有 `admin` 也不能读源码或改插件，它们只看到已应用的插件。源码不进审计与 SSE。等待之后、写入之前复查权限。

**限额。**

| 对象 | 上限 |
| --- | --- |
| 一个资产 | 128 个文件，单文件 1 MB，技能 32,000 字节，清单 64 KiB，整体 JSON 8 MiB |
| 磁盘 | 合计 64 MiB、64 个插件、10,000 个修改回执；每个插件 128 个已批准的执行摘要 |
| 一次 Host 运行 | 物化 64 MiB 含 Host 模块的版本，之后要正常重启（Node 的 ESM 缓存留到进程退出，不删仍在用的版本假装回收） |
| 管理请求 | 全局同时 4 个、每设备 2 个，不排队（429 `plugin-package-busy`），另受管理操作的速率限制 |

**文件规则。** 只收包内相对路径；绝对路径、遍历、保留清单名、大小写冲突、文件与目录冲突被拒绝，所有入口必须存在。可执行入口必须是自包含的 `.mjs`：不在线安装依赖，不编译 Host 模块或面板的 JSX/TypeScript。技能入口只收 `.md` 或 `.txt`，模块不能标成技能来绕开执行摘要；所有 `.mjs` 都进入执行摘要。

| 请求（`/link/api` 下） | 行为 |
| --- | --- |
| `GET /plugin-packages` | 摘要列表，不含源码 |
| `POST /plugin-packages` | `{ requestId, bundle }` 创建草稿；标识不能与内置或启动参数的插件相同（409 `plugin-package-id-in-use`） |
| `GET /plugin-packages/:id` | 摘要与当前草稿 |
| `PUT /plugin-packages/:id` | `{ requestId, baseRevision, bundle }` 保存草稿，标识不变；版本过期 409 `plugin-package-changed` |
| `GET /plugin-packages/:id/export` | 可再次导入的 `{ bundle }`，不含运行数据 |
| `POST /plugin-packages/:id/apply` | `{ requestId, revision }` 应用这个精确草稿；有 `.ts`/`.tsx` 页面入口时要求该修订构建成功 |
| `POST /plugin-packages/:id/enabled` | `{ requestId, enabled }` 启停已应用快照，不应用草稿 |
| `POST /plugin-packages/:id/rollback` | `{ requestId, revision }` 重新应用最近 5 个应用过的快照之一，草稿不变 |
| `DELETE /plugin-packages/:id` | `{ requestId, baseRevision, deleteData? }` 撤下并移除；`deleteData: true` 才删页面数据 |
| `POST /plugin-packages/import`、`GET …/session-draft`、`POST`/`GET …/:id/build`、`GET …/:id/builds/:bundleHash.js`、`POST …/:id/dev` | 页面草稿的导入、构建、预览产物与开发中，见 [APP-PAGES.md](APP-PAGES.md#草稿构建与预览) |

`createPluginPackageTemplate('skill' | 'tool' | 'react-ui', id?, name?)`（`@latch/protocol`）给出可直接应用的起点，不下载代码。

**修订与状态。**

- `revision` 是规范化完整资产的 SHA-256；`appliedRevision` 才是实际发布的内容。状态为 `draft`、`applied` 或 `update-available`；保存草稿不改变正在运行的版本。
- `enabled`、`trusted` 与 `capabilities` 分别是当前是否运行、当前草稿的执行内容是否已批准、实际注册的能力。
- 启动、应用与重新启用时，完整的 `appliedRevision` 交给注册表作为持久修订（见「执行修订」）。只改技能文字不需要新的代码批准，但应用后修订改变，已保存的执行授权要重新确认。
- 审批去重用的 `executionHash` 不代替执行授权里的完整修订。

**写入与结果未知。** 写入用 0600 临时文件、文件同步、原子替换与目录同步。请求超时是结果未知，客户端复用原 `requestId`；替换后结果未知时普通读取被拒绝（503 `plugin-package-write-unknown`），只有同设备的原请求能结算。同一 `requestId` 用于不同修改返回 409 `request-conflict`。重试应用必须再次激活候选，不把已回滚的候选报成发布成功。

**信任。**

- 没有可执行摘要的包（只有技能与数据面板）首装与编辑都不需要系统确认。页面也没有可执行摘要，它的信任绑定能力集合，另行确认（[APP-PAGES.md](APP-PAGES.md#信任)）。
- Host 模块、React 面板源码或执行配置改变时，`plugin.package.apply` 经 `PresenceService` 确认一次，绑定完整草稿与执行摘要；已批准的摘要跨重启复用。名称、说明、技能正文与静态数据不产生新的批准。
- L3 会话运行或等待时不接受这项确认。
- 批准只表示人信任这些代码，不提供隔离。技能正文是可信模块可以读取的数据；模块把文本当代码执行属于它自己的行为。

**应用与撤下。**

- 应用在独立的不可变代（generation）里加载，候选的注册、持久化与发布用注册表的替换事务。激活失败保留旧版与草稿（502 `plugin-package-activation-failed`），旧运行继续用旧租约。
- Harness 在发布后由 Host 启动；启动失败仍保留已应用快照，摘要的 `unavailableReason` 写明，不把声明的能力报成可用。
- 停用或删除先禁止新租约，旧租约真实释放后才清理 effect 与源代。运行中的 Harness 不能卸载：409 `plugin-in-use`，先停止使用它的会话。
- 收紧（停用、删除）时审计失败不阻拦，以 `x-latch-audit: failed` 告知。
- 标准启动入口在取得数据目录锁、确认没有存活的旧 Host 后，清理私有 `generations` 中符合内部命名的遗留目录，再从已应用资产重建；它拒绝链接目录，保留其他条目，不动草稿、批准与回执。运行时应用与通用的存储打开不做这种清理；嵌入式 Host 的调用方自己保证启动互斥。
- 新版桌面端不再加载某个 `formatVersion` 时，该插件不启用，资产保留（[UPDATES.md](./UPDATES.md#插件兼容)）。

## 插件对象与生命周期

```ts
interface LatchPlugin {
  id: string
  name: string
  version: string
  description: string
  package?: { formatVersion: 1 | 2 } // 目录插件包才有
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

`HarnessPlugin` 是 `LatchPlugin` 的兼容名称。

- **激活。** 在 `activate` 中注册与初始化；建立定时器、订阅、连接后立即 `onDispose`。激活失败也清理已登记的资源。
- **清理。** `onDispose` 按登记的逆序逐个等待；一个失败不跳过其余，错误最后以 `AggregateError` 报告。
- **唯一性。** Provider ID、工具名、Harness ID 与连接载体 ID 在所有插件间唯一（409 `provider-exists`、`tool-exists`、`harness-exists`、`transport-exists`）；技能与两种面板的 ID 在包内唯一。工具名与 Harness ID 须匹配 `^[a-zA-Z0-9_-]{1,64}$`。
- **租约。** 内置 Harness 的一次运行固定一个 Provider 与当时的工具、技能（对话模式不租工具）；挂载中的 Harness 持有租约直到卸载或 Host 关闭。两种租约分开计数，都阻止停用与删除。
- **`activeRuns`。** `registry.list()` 只数运行租约，挂载不算；`GET /link/api/plugins` 再加上该插件的 Harness 中运行或等待批准的会话数。只加载了 Harness、没有会话在跑时为 0。
- **`disable` / `unregister`**（启动参数与设置页管理的插件）：有租约时 409 `plugin-in-use`，更新进行中 409 `plugin-busy`。
- **`retire(id)`**（应用内自定义插件的收紧）：立即撤下贡献、禁止新租约；旧代等最后一个租约真实释放后清理。
- **`replace(plugin, beforeCommit?, options?)`**：先激活候选，再执行持久化回调，成功后不再等待地发布。旧代仍被运行使用时不阻止替换，保留到最后一个租约释放再清理，清理失败只记日志。`preserveEnabled: true` 让已停用的插件保持停用。

### 执行修订

- Host 在 `register(plugin, { revision })` 或 `replace(plugin, beforeCommit, { revision })` 传入已实际应用的完整来源与配置的 SHA-256。
- `revisionSnapshot(ids)` 返回各插件的摘要与 `persistent`。没有完整摘要的模块用本次激活的随机指纹：重启、替换或重新启用后改变，相同 semver 不算旧授权仍然有效。替换时没给新摘要也不继承旧的。
- 已保存的执行授权用 `registry.acquire(providerId, { pluginIds, expectedRevisions })` 同步复核，必须包含 Provider 的归属与每个实际贡献的插件。更新中、已停用、缺少修订（409 `plugin-revision-missing`）或摘要变化（409 `plugin-revision-changed`）都拒绝新租约；旧租约保留原代到运行真实结束。
- `pluginIds` 固定本轮工具与技能的归属插件：缺省是全部已启用插件，空列表不租工具与技能，所选插件已停用或移除时报错（409 `agent-plugin-unavailable`）。Provider 独立租用，不因归属带来未选中的工具。
- `AgentExecutionContext.expectedRevisions` 只由 Host 构造，内置 Harness 在持久化新运行前复核；指纹不含私有记忆正文，不进入公开消息。摘要描述已批准的来源，不保证第三方外部依赖的完整性。

## 技能

```ts
context.registerSkill({ id: 'review', name: '发布检查', description: '逐项核对证据', content: markdown })
```

- 技能 ID 在包内唯一，发布为 `<包 ID>:<技能 ID>`。正文是模型可见的指令，不是脚本，按原文读取。
- 内置 Harness 每轮开始时固定当时启用的技能，连同输入原子持久化 `skillContext`；这一轮的每个模型请求用同一份。替换不改变已开始的一轮，下一轮重新取启用集合。对话模式同样带技能，不带工具。
- 每个技能最多 32,000 字符；一轮合计超过 256,000 字符时拒绝开始（409 `skills-too-large`），不静默截断。
- `catalog.skills` 只返回名称、来源与描述，正文不下发给客户端。
- 我的 Agent 选定的技能按 `HarnessDriver.skills` 送达：`native` 收技能 ID，`server` 经技能服务收正文，未声明的收不到（[CUSTOM-AGENTS.md](CUSTOM-AGENTS.md)）。自定义 Driver 也可从 `HarnessHostOptions.registry.acquire()` 的租约读 `skills`。

## 界面与数据面板

两种面板都挂在会话信息栏的页签。`harnessIds` 省略表示所有 Harness，空列表表示没有适用的会话。

**React 面板。** 包的 `panels` 或 `registerClientPanel({ id, title, description?, harnessIds?, source })`：

- `source` 是预先构建的 ESM（不超过 1 MB），默认导出函数组件。Host 不运行 JSX/TypeScript 编译器，不用 `eval`。
- 组件收到 `PluginPanelProps<TaskSummary>`：用工作台传入的 `react` 与 `ui` 控件，不带第二份 React。
- `compose(text)` 只把文本追加到当前会话草稿，由人检查后用原输入框发送；面板不直接执行，不覆盖已有草稿。`readData(id, signal?)` 读同一包的数据面板，绑定当前会话与查看权限。
- 订阅、计时器与连接放在 `useEffect` 并返回清理函数；切换会话、离开页签或停用包会卸载组件。不在模块顶层建立资源：模块缓存留到页面关闭。
- Host 只在认证的 `GET /link/api/ui-modules/:panelId/:sha256.mjs` 返回当前启用的版本（`no-store`）；旧摘要与停用的版本 404。客户端只从 Host 同源加载，不放宽 CSP。

**数据面板。** `registerUiPanel({ id, title, description?, harnessIds?, listed?, render })`：

- `render({ session, signal })` 在 Host 上返回 `UiPanelDocument`：`text`、`code`、`list`、`facts`、`table`，最多 32 块、序列化后 65,536 字符；只渲染文本，不收 HTML、事件处理器或样式。
- `listed: false` 不出现在页签里，只作数据入口；这不是访问限制。
- 读取 `GET /link/api/tasks/:id/ui-panels/:panelId`：先核对设备与会话，再运行回调，返回前重新核对权限。取消是协作式的，回调真实结算后才释放租约。插件异常只向页面返回通用错误（502 `ui-panel-failed`）。

**尚未实现：** 在线下载与自动更新、插件市场、按项目选择插件、通用的跨插件服务依赖、时间线渲染扩展。它们需要各自的生命周期与消费方契约。

## 连接载体

`context.registerTransport(driver)` 把连接载体组合进插件；描述、通道、消费者与租约见 [TRANSPORT-PLUGINS.md](TRANSPORT-PLUGINS.md)。

## 注册工具

`context.registerTool(tool)` 注册一个 `ToolDefinition`；最小的例子是 [text-statistics.mjs](../examples/text-statistics.mjs)。

**输入与取消。**

- 内置 Harness 不替工具做完整的 JSON Schema 校验，工具自己校验输入。抛错作为错误结果交回模型。
- 把 `signal` 传给网络与子进程，在不可逆写入前再检查一次；取消的清理完成后才结束 Promise。
- `callId` 可作外部系统的幂等键，本身不提供幂等。人批准过的调用另带 `approvalId`。
- 工具返回一次最终结果，没有输出分片或进度。

**文件夹。** 项目可以有多个文件夹：`workspaceRoot` 是主文件夹，`workspaceFolders` 是全部（主文件夹在前；旧 Driver 可能省略）。让模型用文件夹的 `id` 选择、路径相对所选文件夹，不把绝对路径交给模型；内置 [workspace-files](../apps/host/src/plugins/tools/workspace-files/index.ts) 是参考实现。

**显示。**

- `title` 是工具做什么的短说法，过程行与审批卡写它加这次调用的对象。Host 截到 40 个字符，把不可见与改变方向的字符转义显示；审批卡仍写出工具名。
- `kind` 决定工具行的图标与动词。两者都不参与风险分级。

**结果。**

- `textWithoutFiles` 是不含文件正文的结果说明，只给数据范围受限的设备看（`ToolDetail.outputWithoutFiles`），不替换发给模型的 `text`；空字符串表示没有可显示的文字。不得把差异或文件内容放进去。没有它的编辑结果在受限设备上省略内容段。这依赖可信插件如实声明。
- `images`：`image/png | jpeg | gif | webp` 的 base64，每张不超过 5 MB，每个结果最多 4 张。存进 Host 的私有附件存储，历史只存引用；存不下的丢掉并在结果文字里说明。
- 模型没有 `vision` 的运行不提供声明 `returnsImages: true` 的工具，其他工具返回的图片被丢掉。每次请求只再发最近 3 张工具图片（`TOOL_IMAGES_SENT`），更早的结果只带文字。
- 协议能在工具结果里带图的（Anthropic Messages）放在结果里；不能的（Chat Completions、Responses）放在这一步全部结果之后的一条用户消息里，并写明是工具返回的、不是用户发送的。

**等人。**

- `waitsForUser: true` 或上下文的 `waitForUser()`（调用开始等待，调用它返回的函数结束）把等人的时间排除在工作用时之外；不改变风险分级。
- `resultCommitted({ sessionId, callId, state })` 在工具结果落盘后、模型继续前调用；它必须真实结算，不确认尚未落盘的结果。
- 内置 `ask_user` 只在 Agent 模式提供，不索取密钥：最多 10 题、每题 20 个选项、整包 32,000 字符，回答作为 `latch.question-result` 结果交回模型。外部 Harness 的提问见 [HARNESSES.md](HARNESSES.md#agent-的提问)。

### 预览

可选的 `preview(args, { workspaceRoot, workspaceFolders, signal })` 必须无副作用，返回 `{ title?, summary?, diffs? }`。内置 Harness 在需要审批的调用执行前调用它；抛错或返回无效值时忽略，不阻止调用。`summary` 是这一次调用做什么的短标签，只用于显示，不改变分级。

每个 diff 是 `{ path, oldText?, newText, previous? }`：

| `previous` | 含义 |
| --- | --- |
| `'none'` | 确认文件不存在，是新文件；只在确认时使用 |
| `'text'` | `oldText` 是原内容 |
| `'unavailable'` | 文件存在，原内容没有显示（过大、二进制或读不到）；界面提示写入会覆盖它 |
| 省略且没有 `oldText` | 没有说明；界面写「原内容未知」，不当作新文件 |

`title` 与 `summary` 截到 200 字符；最多 20 个 diff，`previous` 无效的 diff 被丢弃；全部 diff 的路径与文本合计超过 1,000,000 字符时不显示 diff。无法判断文件是否存在时按 `unavailable`。

### 风险分级与审批

**是否审批由 Host 的分级决定，不由工具声明。** 内置 Harness 在每次工具调用前请 Host 分级（`HarnessHostOptions.classifyToolCall`，规则在 [risk.ts](../apps/host/src/risk.ts) 的 `classifyStandardCall`）。只有列出的内置工具低于 R2。

| 等级 | 哪些调用 | 审批 |
| --- | --- | --- |
| R0 | 内置 `list_folders`，会话任一文件夹中的 `list_files`、`read_file`；内置 `ask_user`；内置浏览器工具里只看不动的（`BROWSER_READS`）与关闭 Agent 自己开的标签；`--demo` 时的 `long_task` | 直接执行 |
| R1 | 内置 `write_file` 写会话任一文件夹内的普通路径；内置浏览器工具的其余操作，关闭人开的标签；`--demo` 时的 `write_report` | 每次询问，可选「本会话始终允许」；会话的[权限档位](#权限档位)可以不问 |
| R2 | 其余全部，见下 | 每次询问，没有「始终允许」，即使同一工具此前在本会话被始终允许 |

R2 的情形与原因（`riskReason`）：

| 原因 | 情形 |
| --- | --- |
| `unlisted-tool` | 所有第三方插件注册的工具，只读的也一样 |
| `mcp-tool` | 远程 MCP 服务器的工具（`mcp__` 开头、不属于任何插件）；服务器对工具的自述（只读之类的提示）不降低分级，同名的插件工具按插件工具分级（[MCP.md](MCP.md#远程地址)） |
| `outside-workspace` | 内置文件工具的 `folder` 不是会话的文件夹，或写入路径越出所选文件夹 |
| `unresolved-path` | 写入路径为空、是绝对路径或无法解析 |
| `protected-path` | `write_file` 写受保护路径（`.git/`、`.env*`、锁文件、CI 工作流、Agent 配置等，按所选文件夹判断，列表在 [paths.ts](../apps/host/src/paths.ts)） |
| `code-root` | 所选文件夹与 Latch 程序目录重叠，或无法解析 |
| `unparsable-arguments` | 调用的参数无法解析 |
| `sensitive-field` | 浏览器工具往密码、一次性验证码、卡号或隐藏字段输入，或往从没读到过的元素输入 |

- 第三方工具的 `requiresApproval: false` 被忽略。它只在没有分级器的场合（直接用 `createRuntime` 的测试）决定是否询问。
- 分级器抛错或返回未知值按 R2。分级器返回等级，或 `{ risk, reason }`（`ToolRisk`）：R2 带 Host 的原因，供权限档位判断。
- 审批的 `risk` 由 Host 按当前分级重算：不低于运行时记录的值，至少 R1；Driver 自报的 `riskReason` 被丢弃。Host 重启后旧审批失效，不会被重新批准。
- 允许 R2 要 `approve:elevated`，允许 R1 要 `approve:standard`；拒绝与取消只要 `view`。都不弹本机确认，每次决定有审计。
- 浏览器工具的分级不看标签现在在哪（它可以在分级与执行之间变）：标签不在这台 Mac 的本机地址上时，除列标签与关标签外 broker 一律拒绝，不论批准与否，所以「本会话始终允许」带不到别的地址。外部 Harness 经工具网关用同一组工具时 R0 与 R1 直接执行并审计，R2 一律拒绝（`elevated-refused`）。见 [PREVIEW-BROWSER.md](PREVIEW-BROWSER.md#agent-的工具)。

#### 权限档位

Latch 内置的会话有五档（`BUILTIN_MODES`，[permission-modes.ts](../packages/core/src/permission-modes.ts) 的 `modeAnswer`）。档位只决定谁回答，分级与 `riskReason` 不变；每次调用时读当前档位，改了从下一个调用起生效。

| 档位 | R1 | R2 |
| --- | --- | --- |
| 只看不改（`plan`） | 不运行、不问，模型收到「只看不改」的拒绝 | 同左 |
| 先问你（`ask`，默认） | 问，可「本会话始终允许」 | 每次问 |
| 按规则放行（`rule`） | 直接运行 | 每次问 |
| 由模型判断（`model`） | 直接运行 | 先由模型判断，「放行」就运行，其余问 |
| 不再询问（`never`） | 直接运行 | 直接运行 |

- **始终问。** `code-root` 与 `sensitive-field` 在问人的各档都问（`ALWAYS_ASK_REASONS`）；Host 没给原因或原因不认得的 R2（分级器出错）也问，不交给模型判断。
- **模型的判断。** 用会话这一轮的模型，不带工具，系统提示固定（`JUDGE_PROMPT`）；用户消息只有工具名、R2 原因、参数与人最近一条消息，后两者标为外部内容。回答必须恰好是 `{"decision":"allow"|"ask","reason":"…"}`；别的回答、出错、30 秒超时都问人，取消这一轮就是取消。结论记在这一行（`ToolDetail.judged`，`own: true`，理由脱敏后限 300 字），它的 tokens 计入会话与这一轮的用量。
- **记录。** 每个模型结论（`source: 'latch-model'`，`approved`、`referred`、`timed-out`、`unknown`）与每个没问人就运行的 R2（`source: 'mode'`、`ran-unasked`）在调用运行前写 `task.tool.judged`；写不进去时这一轮停止，调用不运行。没问人就运行的 R1 不另记，与「本会话始终允许」相同。
- **无人值守。** 定时运行与团队派的一轮（`unattended`）最多按「先问你」回答，「只看不改」照样拒绝；更宽的档位到不了它们，所以 Standard 仍按 L1 对照 `unattended.maxLevel`。
- **持久化。** 档位存在会话里（`permissionMode`，读不懂按「先问你」）；`TaskDetail.config` 的 `mode` 项与 `TaskDetail.permission`（`expectedMode`、`defaultMode`、`modeTiers`）报告它。开始请求可以带一项 `{ configId: 'mode' 或 '~mode', value }`，只对 Agent 会话；插件页面、我的 Agent、通用与团队成员的开始不带。
- **谁能改。** 与其他 Harness 同一接口（`POST /tasks/:id/config`）：`run`，加上该档代答的批准权限（`modeScopes`：「按规则放行」`approve:standard`，「由模型判断」「不再询问」再加 `approve:elevated`）。放宽写 `task.mode.widened`；从更宽的一档开始时，Driver 在会话建立之前经 `HarnessHostOptions.modeWidened` 让 Host 写这一条，写不进去就不建会话，之后开始失败则记 `action.failed`。

## 注册模型 Provider

设置页可以直接添加 Chat Completions、Responses 或 Anthropic Messages 协议的模型服务；只有接入其他协议时才写 Provider 插件（`ModelProvider`，见 [plugins.ts](../packages/sdk/src/plugins.ts)）。

- 请求带 `model` 时必须用该模型，不静默替换；不支持时抛错。
- `modelCapabilities` 按模型显式声明 `vision` 与可接受的思考深度（由弱到强）。`effort` 只会是该模型声明过的一项，未声明的必须拒绝（`effort-unavailable`）；不带 `effort` 时用模型自己的默认。
- 没有声明 `vision` 的模型收到图片（`ModelMessage.attachments`）时拒绝，不忽略、不换模型。
- `tools: []` 表示对话模式，不发工具声明。
- 把 `signal` 交给底层请求，退出时释放读取器。调用 ID 在同一会话历史中唯一。处理 `ModelMessage.isError`，不把拒绝或工具错误变成成功信息。
- 日志与错误不含密钥。
- `run`（会话与本轮 ID）供 Host 自己的服务按轮调度，不是凭据，插件 Provider 可以忽略。

`stream()` 产出的 `ModelDelta`：

| 事件 | 约定 |
| --- | --- |
| `text` | 本次新增的文字，不是累计全文 |
| `reasoning` | 模型报告的思考片段；展示给人，不进入后续请求的历史 |
| `tool-call` | 已完整解析的 `{ id, name, arguments }`，`arguments` 必须是对象 |
| `usage` | `inputTokens` 是全部输入（含缓存），`outputTokens` 是全部输出（含推理）。缓存与推理部分只在服务报告时填写，没报告就省略、不填 0。`cost` 只在服务自己在回复里报告花费时填写，Provider 不估算 |
| `finish` | 必须是最后一个事件；之后仍有内容或流直接断开都算协议失败 |
| `route`、`spend` | 只由 Host 的调度层发出，插件 Provider 不发（[MODEL-GATEWAY.md](MODEL-GATEWAY.md#调度)） |

**随调用带回的数据。** 服务给工具调用附带、之后必须原样带回的数据（签名或加密的推理）放在 `ToolCall.signature`：`value` 至多 1 MiB，`by` 写协议、服务与模型。会话历史保存它，界面、审批、审计与日志看不到；Provider 只把 `by` 是自己的发回。`scope: 'turn'` 的只在产生它的这一轮带回，下一条用户输入开始时 Host 从历史里删掉（[MODEL-CONFIGURATION.md](MODEL-CONFIGURATION.md#latch-内置的思考深度)）。

**出站与密钥。** 内置模型服务的请求经 Host 出站策略，密钥只发往保存时的地址。插件上下文不提供 Host 的出站 `fetch`；第三方插件自己的网络访问不受出站策略约束。

内置三种协议是参考实现：`apps/host/src/plugins/providers/` 的 `chat-wire.ts`、`responses-wire.ts`、`anthropic-wire.ts`（地址、请求体、分片组装、终止校验、大小限制）、`service.ts`（模型与思考深度的选择、取消）与 `http.ts`（SSE 分帧、错误读取、密钥脱敏）。

## 注册完整 Harness Driver

需要自己的 Agent 循环、存储或外部进程时实现 Driver，不塞进 Provider。通用的外部 Agent 优先经 [ACP](./HARNESSES.md) 接入，不用写插件。

```js
ctx.registerHarness({
  id: 'my-harness', name: 'My Harness', version: '1.0.0',
  capabilities: { modes: ['agent'], permission: { enforcement: 'harness' } },
  status: () => ({ status: 'ready' }),
  create: options => createMyHarness(options),
})
```

- 所有已启用的 Harness 都被挂载并出现在新会话的选择器里。
- `create(options)` 同步返回尚未启动的 Bridge，异步初始化放进 `start()`。
- `status()` 返回 `ready` 或 `unavailable` 与说明；命令已知太旧时带 `statusReason: 'outdated'`。

### 第三方 Harness 的会话是 L3

Host 把第三方 Harness 的会话标为完全访问（L3）：Latch 无法核实它的执行范围。规则与 ACP 会话相同（[HARNESSES.md](./HARNESSES.md#权限级别完全访问l3)）：有 `run` 的设备能新建、输入、改设置与允许询问，不弹确认，每次启动有审计；只有 `view` 的设备只能查看、拒绝与取消。它的审批由 Host 标为 `advisory` 与 `R2`，不由 Driver 声明。

### 能力声明

`capabilities`（`HarnessDeclaration`）写这个 Harness 实际做什么；客户端只读这些事实，不判断它是哪种 Driver。**不知道的不写，Host 按最弱处理。**

| 字段 | 含义与默认 |
| --- | --- |
| `modes` | 接受的模式；不支持的模式由 Host 以 400 拒绝 |
| `models.owner` | `latch`：用 Host 的模型服务，客户端显示模型选择器并传入 `model`；`harness`（默认）：自己管理模型 |
| `models.catalogue` | 开始前能否知道可选项，默认 `none` |
| `models.wires` | Latch 能把它的请求转发过去的模型协议；空表示不能经 Latch 转发 |
| `models.experimental`、`knownOnly` | 转发尚未经过真实使用；经 Latch 时只用服务里它自己认识的模型 |
| `models.thinkingPerModel`、`thinkingInModel` | 原生列表完整报告各模型的思考能力；思考变体在模型 ID 里选。没有证据不得声明 |
| `permission.enforcement` | 谁决定工具调用能否运行：`harness` 或 `none`（默认） |
| `permission.rejectionNote` | 拒绝的说明能送到模型，默认 `false` |
| `tools.fileMentions` | 消息里提到的项目文件能送到它；默认 `false`，这时 Host 拒绝带文件引用（`fileRefs`，最多 32 条）的输入 |
| `display.label`、`display.mark` | 显示的名字（默认 `name`）；客户端固定图标集的键，不是地址或图片 |
| `fork` | `native`：能分叉自己会话的记录（[ARCHITECTURE.md](ARCHITECTURE.md#会话分叉)）；默认只用 Host 的文字种子 |
| `attachments` | `{ images?, text?, textBytes? }`，缺少即不展示（[ATTACHMENTS.md](ATTACHMENTS.md)） |

**这些是对人的陈述，被描述的一方说了不算**（`harnessFacts`）：

- 只有内置 Harness 能得到 `enforcement: 'latch'`；其他写了也算 `harness`，会话仍是 L3，也收不到分级器。
- 只有内置 Harness 能说 `tools.shell: false`。
- 名字与内置的相同或只差大小写、宽度、空白与不可见字符时显示为「…（非内置）」，也不能用内置的图标。

Driver 上的其他声明：

- `projectFolders: 'all'`：Driver 能用项目的全部文件夹。Host 新建会话时传 `workspaceId` 与 `folders`（有序，`[0]` 即 `cwd`），并在 `options.projects()` 列出可用项目。Driver 据此核对 `folders`、随会话保存，并在每次输入前确认它们仍属于该项目。没有声明的只收到主文件夹作为 `cwd`。
- `folderAccess`：告诉客户端它怎样对待其他文件夹。声明了 `projectFolders: 'all'` 时写 `{ access: 'all', max? }`，项目文件夹数超过 `max` 时 Host 返回 409 `harness-folder-limit`；否则写 `primary`（默认）、`primary-asks` 或 `primary-unbounded`。没有声明 `projectFolders: 'all'` 的写 `all` 被忽略。
- `agentContext`：见「Agent 上下文」。`historyImport`、`historyDelete`：见 [HARNESSES.md](HARNESSES.md#接入已有会话) 与 [持久化与恢复](HARNESSES.md#持久化与恢复)。

### Host 给 Driver 的选项

`HarnessHostOptions` 的字段见 [harness.ts](../packages/sdk/src/harness.ts)。签名之外的规则：

| 选项 | 规则 |
| --- | --- |
| `dataDir` | 私有的 `<数据目录>/harnesses/<driver-id>`；不写入用户的工作区 |
| `tmpRoot` | Host 运行目录下私有的 0700 目录，所有 Driver 共用。每个会话建自己的 0700 子目录，删除会话时清理；Host 关闭时整个目录被删，不放要保留的数据 |
| `workspaces()`、`projects()` | 会话的 `cwd` 必须属于 `workspaces()` |
| `registry` | 运行开始时 `acquire(providerId, { tools })`，租约持有到运行真正结束 |
| `clock()` | 消息与运行的时间用它记录，不直接读 `Date.now`：客户端按 Host 的 `hostTime` 校准（[STREAMING.md](./STREAMING.md#时间与用量)） |
| `classifyToolCall` | 只传给内置 Harness |
| `securityEvent(event)` | 上报 `permission-drift`、`permission-unverified`、`model-route-bypassed`、`approval-auto-rejected`、`tool-judged`，只带哈希与枚举。Host 写审计（`task.permission-drift`、`task.model.bypassed`、`task.approval-auto-rejected`、`task.tool.judged`；`permission-unverified` 只写日志）并刷新会话，不向 Driver 抛错。只有 `tool-judged` 返回 Promise：审计写不进去时它被拒绝，Driver 应取消这一轮 |
| `modelGateway` | 给声明了 `models.wires` 的 Driver：按进程 `open` 一个凭据，进程结束时 `close`，`active()` 为假后换进程；一轮发出时与结束时各调用一次 `takeTurn()`，把结果记进 `TurnStats.routed`。凭据不进参数、URL、日志与消息。路线、`upstream`、`setThinking` 与损耗见 [MODEL-GATEWAY.md](MODEL-GATEWAY.md) |
| `turnEnded(turn)` | 每轮结束时调用一次：ACP Driver 只在不走模型路由时调用，带与 `TurnStats.usage` 相同的用量、步数、用时与 Harness 报告的花费差值；内置 Harness 带这一轮的 `providerId` 与各步用量之和，Host 只留插件服务的轮次。Host 只追加到自己登录轮次的记录（[MODEL-GATEWAY.md](MODEL-GATEWAY.md#网关以外的轮次)），不向 Driver 抛错 |
| `askUser`、`questionSettled` | 给内置以外的 Driver：把 Harness 的提问放进会话行 `tool:<callId>`，回答落进会话后得到 `latch.question-result` 的 JSON；提问结束或 `signal` 中止时拒绝。Driver 把结果写进那一行并落盘后调用 `questionSettled`，回答的设备才拿到回执 |
| `teamRoster`、`dispatchTeam` | 同样的会话：带队会话的 Agent 在人打开开关时读团队名单、给已有成员派一轮（[TEAMS.md](TEAMS.md#agent-派活)）；名单变了 Host 调 `Bridge.teamChanged`。拒绝用英文原因 |
| `proposeWork` | 建会话时 `CreateTaskInput.workProposals` 为真时可用：Agent 为看板提议待办或自己卡上的改动，Host 只建一条待人接受的提议（[ARCHITECTURE.md](ARCHITECTURE.md#agent-的提议)）；只交 `todo` 或 `card`，不交优先级 |
| `proposeMemory`、`proposeSchedule` | 会话的执行上下文带 `proposals` 时可用。Host 只建一条待人确认的提议，从不直接保存或运行；`key` 在会话的通道内唯一，重复只建一条；`external` 拿不准时为真；拒绝的原因不复述内容（[CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#记忆提议)） |
| `recallMemory` | 只给内置 Harness；只读，只回该归属已确认的记忆（[CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#查记忆)） |
| `readAttachment`、`attachmentPath`、`saveAttachment` | 取本轮附件的内容；把不原生交的附件存成会话附件目录里的文件并给出路径（[ATTACHMENTS.md](ATTACHMENTS.md#按路径交给-agent)）；保存 Agent 输出的图片。持久化只存引用，不把附件复制到项目目录；Host 仍验证设备、会话、类型与限额 |
| `trackFiles` | 见 [FILE-OUTPUTS.md](FILE-OUTPUTS.md) |
| `extensionReportProject` | Host 已登记且当前仍为普通会话时返回项目 ID。新会话可等 `CreateTaskInput.extensionReportReady` 结算后核对归属 |

ACP 的 `ToolGatewayCallContext.runId` 由 Driver 在收到工具调用时取自实际运行。Host 用它核对模拟器工具仍属于同一轮。设备身份留在 Host 内部。签名见 [harness.ts](../packages/sdk/src/harness.ts)。

### Bridge 契约

签名以 [bridge.ts](../packages/sdk/src/bridge.ts) 为准，可选方法旧 Driver 可以不实现。

**拒绝与「结果未知」。** 客户端把 5xx 当作结果未知并保留原 `requestId` 重试。例外是 `NOT_ACCEPTED_5XX`（`@latch/protocol`）里的码：`agent-start-failed`、`agent-refused`、`agent-paused`、`agent-handshake-timeout`、`model-gateway-unavailable`、`agent-busy`、`audit-unavailable`、`presence-unavailable`。它们表示什么都没有记下：客户端丢弃 `requestId` 让人重发，Host 放下为这个请求保留的附件。

- `createTask`、`prompt` 只能在这一轮还没有任何记录（没有用户消息、回执、可能之后发出的排队项）时抛这些码。
- 记下任何东西之后失败，用不在清单里的 5xx（如 `storage-unavailable`），让客户端用同一 `requestId` 重试。
- 4xx（408 除外）同样表示没有接收。

| 方法 | Host 期待的行为 |
| --- | --- |
| `start` / `close` | 关闭时等待执行、取消与资源清理 |
| `listTasks` / `detail` | 返回产品 DTO：稳定的消息 ID 与真实状态，不把 Harness 私有类型传给客户端。`detail()` 是可独立渲染的当前状态，不是增量 |
| `createTask` / `prompt` | 按 `requestId` 持久化去重，并把它原样写入用户消息；不支持的模式报错，不把 chat 当 agent。L3 Driver 的 `createTask` 另收到 `expectedLaunchHash`。`PromptOptions.queuedAt` 保留在实际接纳的用户消息上 |
| `cancel` | 等实际执行结算才返回，后端只回「已收到」不够。带 `runId` 时只在它仍是当前运行时取消，并在开始取消的同一步核对（之间没有 `await`）；没有可取消的运行或 `runId` 不符返回 `false` |
| `cancelSubagent?` | 配合 `Subagent.stoppable`：停止一个子 Agent 当前的工作，会话的这一轮继续；发出停止就返回 `true`，那一行写 `stopping` 直到它报告结果 |
| `approvals` / `decide` | 只返回当前有效的审批；并发决定只有一个成功，`optionId` 必须属于该审批，旧审批或重复决定返回 `false`。`via` 记人在哪里决定；`note` 只随拒绝出现，权限回复不能带文字的 Driver 忽略它 |
| `subscribe` | 状态变化时通知；带 `sessionId` 时 Host 合并通知并推送该会话 |
| `liveRuns?` | 同步返回内存中活动的运行，开销只随活动运行数增长；Host 据此发现沉默，不提供就没有沉默通知 |
| `remove?` | 删除已结束会话的数据；运行中 409 `task-running`。`{ original: true }`：人为这一次删除选了连接入会话的原会话一起删（Driver 声明 `historyDelete`），Host 已先写审计 |
| `warm?` | 在下一轮之前启动已结束会话的进程，像那一轮的绑定一样，不发提示。只在进程数低于自己的上限时做，从不为它停掉别的会话；会话忙时不做。`false` 表示什么都没启动（含失败） |
| `setConfig?` | 从下一轮生效。`options.authorize()` 须在异步准备之后、实际外部修改之前同步调用，抛错即停。只在确定没改时用 409 `task-running` 或 `details.configOutcome`（`not-sent`、`refused`）拒绝；其他错误在回执之后都记为结果未知。模型选项的 `serviceChoice`／`ownChoice` 值让会话换路线，服务的路线由 Host 经 `options.route` 给出（[会话中换路线](MODEL-GATEWAY.md#会话中换路线)） |
| `readConfig?` | 从 Agent 本身读一项的当前值，不用 Driver 记下的值，只在会话空闲时读，不改任何设置；读取期间拒绝这个会话的发送、追加与修改，并先结束收到未回答修改的进程。`source: 'launch'` 的选项是 Host 管理的启动设置，不能拿持久化值当读回 |
| `readCatalogue?` | 不发提示读取开始前的选项，同时只有一次读取。是否自动读取由 `catalogueRead()` 决定，不在需人请求的 Harness 上自动运行 |
| `classifyConfigChange?` | 修改相对会话预期权限模式是 `neutral`、`stricter` 还是 `wider`；Host 只用它决定是否写放宽模式的审计 |
| `commandCatalogue?` | 只读上次真实会话报告的命令，不启动或探测程序。`sourceSessionId` 只供 Host 复查来源与草稿授权，不交给设备；目录不授予能力或执行权限（[HARNESSES.md](HARNESSES.md#会话命令)） |
| `latestCommandReport?(accept?, verifySource?)` | 从普通会话缓存选最新有效报告，附 `workspaceId`。`accept` 同步核对来源，`verifySource` 异步核对项目。项目不可用时继续查下一份。只有 `current()` 能在发送前同步确认报告、定义和真实目录，Host 才发布该 Harness 的报告。声明 `extensionSupport.plugins: 'command-sources'` 时可附 `plugins`（短名和可选截断标记），供「设置 › 扩展」显示。见 [HARNESSES.md](HARNESSES.md#扩展) |
| `launchPreview?` | L3 Driver：描述新建会话将启动什么，用于启动指纹与审计；环境变量只给名字 |
| `promptCapabilities?` | 能力要启动后才知道的 Driver 返回最近一次为当前定义启动时报告的 `{ images, text }`；返回了就以它为准，之前返回 `undefined` 时用声明 |
| `listExternalSessions?` 等 | 与 `historyImport` 一起，见 [HARNESSES.md](HARNESSES.md#接入已有会话) |

**标识。** 会话 ID 与审批 ID 全局唯一（建议带前缀的 UUID），不超过 256 字符；Host 按 ID 路由到 Driver，冲突时先挂载者胜出。

**`detail()` 的字段。** 没有可靠来源的可选字段省略，界面就不显示对应部分。

| 字段 | 约定 |
| --- | --- |
| `Message.state` | `queued`、`awaiting-approval`、`running`、`completed`、`failed`、`cancelled`；工具过程在同一消息 ID 上推进 |
| `liveMessageId` / `liveReasoning` | 最终助手消息沿用该 ID，思考结算到 `reasoning`，界面保留同一行 |
| `activity` | `starting / model / tool / approval / cancelling` 与阶段开始的 `since`；不捏造进度 |
| `TaskSummary.runId` | 每次 `createTask` 或 `prompt` 开始运行时换新值并持久化，同一 `requestId` 的重试不换。最多 128 字符，字母、数字与 `_.:@+-`，以字母或数字开头；其他形式 Host 不转给客户端 |
| `TaskSummary.runOutcome` | `completed / failed / cancelled / interrupted`，执行端真实结算后写入，新运行开始时清除。Host 只把 `completed` 当作自动派发排队项的依据，缺失时暂停 |
| `TaskSummary.runEnd`、`Message.interrupted`、`Message.errorCode` | 运行不是以普通回答结束时的原因；Host 停止时中断的一轮记 `host-stopped`（[STREAMING.md](STREAMING.md#运行的真实状态)） |
| `TaskSummary.live` | 只在运行期间、不持久化；`silenceThresholdMs` 与 `silent` 由 Host 计算，Driver 写了也被丢弃 |
| `ToolDetail.decision` | `{ outcome: 'allowed' \| 'rejected' \| 'expired' \| 'cancelled', at, via? }`。人的选择带 `via`；没有人回答（停止、超时）写 `expired` 或 `cancelled`、不带 `via`，不写成 `rejected`。不写设备名 |
| `Approval.toolCallId` | 对应 `tool:<toolCallId>` 的工具行 |
| `TaskSummary.level`、`TaskDetail.permission`、`sync`、`AppSnapshot.revision`、`Approval.advisory` / `riskReason` | 由 Host 生成，Driver 不填 |
| `Approval.risk` | 只有内置 Harness 的运行时记录它，Host 再按当前分级重算；外部 Driver 的审批一律由 Host 标为 `R2` |

外部 Driver 必须说明崩溃后的恢复方式、未知副作用的处理与无法取消的操作；Host 不替它提供内置 Harness 的原子回执与崩溃修复。

### 清空上下文

`PromptOptions.freshContext: true` 要求这一轮在新的上下文里开始：Harness 看不到之前的消息，消息留在记录里，这一轮的用户消息带 `freshContext`。

- 只有在详情里声明 `clearContext: true` 的 Driver 收到它；它计入请求的幂等哈希。
- Driver 在这一轮被接纳前就放下了旧上下文、这一轮却被拒绝时，详情带 `contextCleared: true`，直到下一条用户消息记下。

### Agent 上下文

`CreateTaskInput.agentContext` / `PromptOptions.agentContext` 是 Host 构造的 `AgentExecutionContext`，不是 HTTP 客户端能授予的权限。Driver 用 `HarnessDriver.agentContext` 声明接收方式，未声明的收不到：

- `private`：`instructions` 只对当前运行可见，不进入公开消息或可分叉的历史，并对每轮输入校验原归属。
- `first-turn`：`brief` 随第一轮发给 Harness，并记在那条用户消息的 `agentBrief`。

说明、记忆与数据范围的规则见 [CUSTOM-AGENTS.md](CUSTOM-AGENTS.md)。

## 验证与调试

```sh
pnpm typecheck
pnpm exec vitest run --config vitest.config.ts tests/registry.test.ts tests/runtime.test.ts apps/host/test/hub.test.ts apps/host/test/risk.test.ts apps/host/test/providers.test.ts apps/host/test/egress.test.ts
pnpm build
pnpm test:e2e
```

- 新增 Provider 或工具时写聚焦的 Vitest 用例：参数异常、信号取消、流截断、清理失败与真实副作用。
- Provider 测试注入假的 `FetchLike`，或用 `createEgressFetch({ allow: () => ['127.0.0.1:<端口>'] })` 放行本地假服务，不访问回环以外的网络。
- 启用失败先看激活错误，检查重复的能力名与资源清理；`plugin-in-use` 时先等待或取消会话。
- 持久化中断后先核对工具的真实副作用，不靠重复点「允许」或复用旧 `requestId` 强制重跑。
