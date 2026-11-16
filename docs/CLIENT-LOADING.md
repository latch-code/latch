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

首屏保留会话、输入、Markdown 解析和安全控件的代码，不等待打开设置，也不在第一条回复出现后再下载一个通用消息解析器。KaTeX 的引擎与样式、PDF 引擎和 worker 已有独立加载路径；Office 和 Mermaid 仅进入固定的不透明文档框，语法高亮语法表由 worker 按需加载。这些产物存在于构建目录，不等于浏览器首屏已经下载。

设置的覆盖面板、分类导航、关闭控件、权限说明与旧 Host 单模型服务表单保持同步可用。「模型」的服务区和快照中已有的模型控件，以及「用量」的期间与分组控件随设置同步可用。其他可选设置在选中后加载；模型服务表单和详情在打开时加载。新会话的 Agent 检测说明与模型服务能力计算是小型纯函数，不再通过导入整页设置来复用它们。

`deferredComponent` 只延迟可选的内容体：加载时保留已有壳层与焦点，模块失败在原位置说明并允许重试，不重载页面或重建工作台。重试受浏览器模块加载行为约束；再次失败继续显示原因，不声称一定能恢复。同一个可选内容体复用已经载入的模块，切回时无需再经过模块加载状态。输入、确认状态和既有表单草稿沿原有生命周期保留。旧 Host 的单模型服务表单没有改成必须支持新 API。

权限变化先依据当前可见分类重新计算 `active` 和 `panel`。正在加载或已经打开的管理分类一旦失去权限，正文立即卸载，记忆的选择也被清除。即使模块稍后加载成功，也不会挂载旧分类或发起它的读取。已下载的 JavaScript 可以留在浏览器模块缓存中；这不表示旧表单或权限仍在。Host 仍独立复查每个请求。

「模型」首开即可更改本设备显示的模型。服务配置尚未到达时，服务区就地等待，添加操作在配置到达后可用。本页的旧用量摘要与「用量」页的请求统计、预算各自读回。切回「模型」或「用量」立即显示这次设置中已经读到的配置或所选期间与分组的数据，并再次向 Host 核对。返回的错误在对应区域可见，可重试。用上次的服务列表绘制时，等待新读回后才允许修改服务地址、协议或密钥。发起更新时带上看到的目标，Host 检查匹配后才保存。收到写入回执后，当前模型页会重新读取 Host。写回执及写入前开始的读取均不能覆盖当前配置。编辑、添加、删除、默认模型变化与确认地址按原有操作读取权威结果。

读回数据只在当前设置实例的内存中保留。主机、Host 进程、设备、权限、数据范围或相应能力变化就丢弃此前的读回。分类或筛选切换后的迟到响应不会覆盖当前视图，读取收到 401 或 403 时立即卸载受保护的内容，包括手机正在展示的服务详情。配对二维码仍在请求像素时动态加载编码器。

## 证据与范围

`apps/web/test/bundle-loading.test.ts` 用实际生产转换构建入口，遍历入口和静态 `imports` 的完整闭包，同时记录 `dynamicImports`。输出在忽略目录 `test-results/bundle-loading/report.json`：初始 JavaScript 原始字节与逐文件 gzip 之和、所有块及其导入边、每块的模块清单。`renderedLength` 是构建器报告的压缩前转换长度，不能当成模块独立 gzip 体积。测试还确认消息解析器仍在初始图，而Agent/插件/设备设置与模型服务表单和详情、二维码及文档引擎不在初始静态 JavaScript 中。

这份图不测网络时延、JavaScript 解析执行、首次绘制、输入响应或手机性能；分出文件也不自动证明变快。gzip 是离线压缩测算，不表示 Host 实际以 gzip 发送了响应。初始体积按所有静态依赖求和，不能只报缩小后的 `index`。生产构建保留原有警告设置；没有通过改警告阈值掩盖体积。

`deferred-settings.test.ts` 验证延迟函数在正文渲染前不执行、模块复用和实际 props 传递、权限变化的分类选择和真实 QR PNG 编码。`e2e/settings-loading.e2e.ts` 在三种宽度下记录实际初始 Network 资源、阻塞插件设置块、撤回管理权限后再释放块，检查未发生旧分类的 API 读取、界面已卸载以及会话草稿保留。浏览器用例与文档大文件性能用例需要串行、独占测试窗口；纯 Node 的构建图通过不等于这些运行时检查已通过。

同一浏览器用例把设置数据的真实 Host 回答暂留在网络层，检查两页可用控件、再次打开时的可信结果、快速改分组、出错重试和收回再恢复管理权限。截图涵盖三宽深浅。
