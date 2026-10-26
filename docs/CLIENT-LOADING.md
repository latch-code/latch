---
description: 首屏静态依赖图、可选设置与表单的按需加载边界、权限收回和浏览器验证范围。
sources:
  - apps/web/src/settings/SettingsPage.tsx
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

设置的模态壳层、分类导航、返回、权限说明与旧 Host 单模型服务表单保持同步可用。具体设置分类仅在选中后加载；新增模型服务表单在用户真正选择预设后加载。新会话的 Agent 检测说明与模型服务能力计算是小型纯函数，不再通过导入整页设置来复用它们。

`deferredComponent` 只延迟可选的内容体：加载时保留已有壳层与焦点，模块失败在原位置说明并允许重试，不重载页面或重建工作台。重试受浏览器模块加载行为约束；再次失败继续显示原因，不声称一定能恢复。组件已经挂载后的普通更新不重新创建 lazy 类型，因此输入、确认状态和既有表单草稿沿原有生命周期保留。旧 Host 的单模型服务表单没有改成必须支持新 API。

权限变化先依据当前可见分类重新计算 `active` 和 `panel`。正在加载或已经打开的管理分类一旦失去权限，正文立即卸载，记忆的选择也被清除。即使模块稍后加载成功，也不会挂载旧分类或发起它的读取。已下载的 JavaScript 可以留在浏览器模块缓存中；这不表示旧表单或权限仍在。Host 仍独立复查每个请求。

`pairingQr` 只在请求像素时动态加载编码器。

## 证据与范围

`apps/web/test/bundle-loading.test.ts` 用实际生产转换构建入口，遍历入口和静态 `imports` 的完整闭包，同时记录 `dynamicImports`。输出在忽略目录 `test-results/bundle-loading/report.json`：初始 JavaScript 原始字节与逐文件 gzip 之和、所有块及其导入边、每块的模块清单。`renderedLength` 是构建器报告的压缩前转换长度，不能当成模块独立 gzip 体积。测试还确认消息解析器仍在初始图，而整页 Agent/模型服务/插件/设备设置、二维码及文档引擎不在初始静态 JavaScript 中。

这份图不测网络时延、JavaScript 解析执行、首次绘制、输入响应或手机性能；分出文件也不自动证明变快。gzip 是离线压缩测算，不表示 Host 实际以 gzip 发送了响应。初始体积按所有静态依赖求和，不能只报缩小后的 `index`。生产构建保留原有警告设置；没有通过改警告阈值掩盖体积。

`deferred-settings.test.ts` 验证延迟函数在正文渲染前不执行、实际 props 传递、权限变化的分类选择和真实 QR PNG 编码。`e2e/settings-loading.e2e.ts` 在三种宽度下记录实际初始 Network 资源、阻塞插件设置块、撤回管理权限后再释放块，检查未发生旧分类的 API 读取、界面已卸载以及会话草稿保留。浏览器用例与文档大文件性能用例需要串行、独占测试窗口；纯 Node 的构建图通过不等于这些运行时检查已通过。
