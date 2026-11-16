---
description: 首屏静态依赖图、可选设置与表单的按需加载边界、权限收回和浏览器验证范围。
sources:
  - apps/web/src/settings/SettingsPage.tsx
  - apps/web/src/settings/ProvidersSection.tsx
  - apps/web/src/settings/ModelUsagePage.tsx
  - apps/web/src/settings/modelSettingsReads.ts
  - apps/web/src/components/DeferredContent.tsx
  - apps/web/src/components/SetupPanels.tsx
  - apps/web/src/core/agentDetection.ts
  - apps/web/src/core/providerAbilities.ts
  - apps/web/src/settings/pairingQr.ts
  - apps/web/test/bundle-loading.test.ts
  - apps/web/test/deferred-settings.test.ts
  - e2e/settings-loading.e2e.ts
---
# 客户端的加载边界

## 什么在首屏，什么按需

| 首屏（初始静态依赖图） | 按需加载 |
| --- | --- |
| 会话、输入、Markdown 解析和安全控件 | KaTeX 的引擎与样式、PDF 引擎和 worker |
| 设置的覆盖面板、分类导航、关闭控件与权限说明 | Office 和 Mermaid（只进入固定的不透明文档框） |
| 「模型」的服务区和快照中已有的模型控件 | 语法高亮的语法表（由 worker 加载） |
| 「用量」的期间与分组控件 | 其他可选设置分类（选中后）、模型服务表单和详情（打开时） |
|  | 配对二维码的编码器（请求像素时） |

- 消息解析器留在初始图里：不在第一条回复出现后再下载。
- 新会话的 Agent 检测说明与模型服务能力计算是小型纯函数（`agentDetection.ts`、`providerAbilities.ts`），不通过导入整页设置来复用。
- 产物存在于构建目录，不等于浏览器首屏已经下载。

## `deferredComponent`

`deferredComponent`（`DeferredContent.tsx`）只延迟可选的内容体：

- 加载时保留已有壳层与焦点。
- 模块失败在原位置说明并允许重试，不重载页面或重建工作台；再次失败继续显示原因。
- 同一个内容体复用已经载入的模块，切回时不再经过加载状态。
- 输入、确认状态和既有表单草稿沿原有生命周期保留。

## 权限收回

权限变化先依据当前可见分类重新计算 `active` 和 `panel`。

- 正在加载或已经打开的管理分类一旦失去权限，正文立即卸载，记忆的选择也被清除。
- 即使模块稍后加载成功，也不会挂载旧分类或发起它的读取。
- 读取收到 401 或 403 时立即卸载受保护的内容，包括手机正在展示的服务详情。
- 已下载的 JavaScript 可以留在浏览器模块缓存中，这不表示旧表单或权限仍在。Host 仍独立复查每个请求。

## 设置数据的读回

- **只在内存。** 读回的数据只在当前设置实例的内存中保留。主机、Host 进程、设备、权限、数据范围或相应能力变化就丢弃此前的读回。
- **迟到的响应。** 分类或筛选切换后的迟到响应不会覆盖当前视图。写回执及写入前开始的读取都不能覆盖当前配置。
- **先显示再核对。** 切回「模型」或「用量」立即显示这次设置中已经读到的数据，并再次向 Host 核对；错误在对应区域可见，可重试。
- **旧列表不能改。** 用上次的服务列表绘制时，等待新读回后才允许修改服务地址、协议或密钥。发起更新时带上看到的目标，Host 检查匹配后才保存。
- 收到写入回执后，当前模型页重新读取 Host。
- 服务配置尚未到达时，服务区就地等待；本设备显示的模型不等它就可以改。

## 证据与范围

| 用例 | 验证 |
| --- | --- |
| `apps/web/test/bundle-loading.test.ts` | 用生产转换构建入口，遍历入口与静态 `imports` 的完整闭包并记录 `dynamicImports`；确认消息解析器在初始图，设置的可选分类、模型服务表单和详情、二维码及文档引擎不在初始静态 JavaScript 中 |
| `apps/web/test/deferred-settings.test.ts` | 延迟函数在正文渲染前不执行、模块复用、权限变化后的分类选择 |
| `e2e/settings-loading.e2e.ts` | 真实浏览器里的初始网络资源、阻塞可选设置块后撤回管理权限（没有旧分类的 API 读取、界面已卸载、会话草稿保留）、设置数据的读回与重试 |

构建图的报告写入被忽略的 `test-results/bundle-loading/report.json`。读它时注意：

- 初始体积按所有静态依赖求和，不能只报缩小后的 `index`。
- `renderedLength` 是构建器报告的压缩前转换长度，不是模块独立的 gzip 体积；gzip 是离线测算，不表示 Host 实际以 gzip 发送。
- 这份图不测网络时延、JavaScript 解析执行、首次绘制、输入响应或手机性能；分出文件不自动证明变快。
- 不通过改警告阈值掩盖体积。
- 纯 Node 的构建图通过不等于浏览器用例已通过。
