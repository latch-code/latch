---
description: 每轮冻结目录的有界变化观察、异步结算与产物引用。
sources:
  - apps/host/src/files/output-tracker.ts
  - apps/host/src/files/ignore.ts
  - apps/host/src/files/references.ts
  - apps/host/src/files/reference-store.ts
  - packages/core/src/file-tracking.ts
  - packages/core/src/runtime.ts
  - packages/harness-acp/src/bridge.ts
  - apps/web/src/components/FileOutputs.tsx
---
# 运行期间的文件变化

Latch 内置 Harness 与 ACP Harness 在 Agent 模式开始派发提示之前，通过 Host 注入的 `trackFiles` 固定本轮会话文件夹。该服务只观察文件，不执行 Git、shell 或项目中的代码。普通对话模式与未接入此可选能力的第三方 Harness 不产生观察记录。

macOS 与 Windows 使用递归文件监听；Linux、监听失败或目录事件不能直接定位文件时，在运行开始与结束各做一次有界扫描，比较文件身份、大小与时间。扫描只看冻结根内的普通文件，最多 50,000 个目录项、32 层、两秒。结果最多 1,000 个相对路径，路径总量最多 256 KiB；Host 同时最多保留 32 个观察器。秘密文件、Host 私有数据与生成目录不进入记录。

运行真实结算后继续观察两秒，以覆盖 Agent 刚结束时尚在落盘的文件。此阶段不延迟取消回执或下一轮输入。递归监听下，macOS 仅在可靠的出生时间晚于本轮开始时标为「新增」；扫描回退无法证明创建时间时标为「修改」。已知文件消失才标为「已删除」。扫描预算不足、关闭中断或路径不可读会明确报告部分记录；观察服务失败报告不可用。

忽略的名称与像密钥的路径定义在 `files/ignore.ts`，每轮改动快照（[CHANGES.md](CHANGES.md)）沿用同一套规则；快照另外保存内容，这里只观察元数据。

这是一段时间窗口中的文件变化，可能包含其他编辑器或会话的写入，不能证明由 Agent 生成。界面使用「运行期间有变化的文件」，保留路径、变化类型与可选格式，删除项只显示路径；现存文件沿用统一文件预览及原生操作的鉴权检查。

## 生命周期与持久化

`TaskDetail.fileChanges` 是仅供已授权会话详情与 SSE 的实时投影，包含 `runId`、`files` 与 `watching` / `settling` 状态。它不进入会话列表或未经验证的原生快照。每次回调核对当前 `runId`，旧运行的晚到事件不得替换新运行的投影。

本轮结束时，最后一条助手消息携带 `outputs` 与 `outputsPending`；没有助手消息时使用本轮最后一条已有消息，不添加虚构回复。两秒观察完成后，只更新捕获的消息 ID，移除 pending，并可带 `outputsTruncated` 或 `outputsUnavailable`。此更新递增详情版本，不改会话状态、运行 ID、排序时间或下一轮消息。两种 Harness 的持久化 schema 都显式保存这些可选字段；Host 重启时把残留 pending 改为部分记录，不宣称观察已完整完成。

输出路径按真实根 ID 追加到会话的持久引用集合，`work` 设备可查看这些已出现的文件，但不会因此获得目录浏览或项目搜索权限。变化本身不授予对已删除、秘密、私有或已移出项目路径的访问。关闭与删除会话释放观察资源；关闭时提前结束宽限窗口并标明观察不完整。

## 插件契约与验证

`HarnessHostOptions.trackFiles` 是可选的 Host 能力。Driver 传入会话 ID、运行 ID、冻结的 `{id,path}` 文件夹与变更回调，取得可幂等 `finish()` / `dispose()` 的句柄。`RunFileTracking` 共享生命周期控制，最终写入由各 Driver 自己的持久化队列负责；第三方返回的数据仍受有限字段与数量校验。未提供此能力时保持旧行为。

聚焦回归包括真实临时文件的改动、晚写、删除、秘密与链接排除、预算与监听失败、关闭；两种 Driver 的旧运行与新运行交错、原消息持久化与重启；会话引用的晚更新；浏览器中产物路径打开及手机、平板、桌面与深色渲染。用例只使用测试 Host、本地假 Provider 与假 ACP Agent。

列表显示已知文件大小；图片缩略仅在观察结算、对应行进入视口后，经会话与明确根 ID 解析授权元数据。秘密、预览不允许、未知或超上限像素、读取失败均保留路径入口，不请求图片内容。缩略使用绑定 ETag 的同源句柄，点击仍进入统一文件列；离开行、切换会话或卸载时中止请求。
