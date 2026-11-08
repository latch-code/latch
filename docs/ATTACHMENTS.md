---
description: 附件的私有存储、设备授权、内容块与模型能力。
sources:
  - apps/host/src/attachments.ts
  - apps/host/src/attachment-routes.ts
  - apps/desktop/src/host.cjs
  - apps/web/src/core/api.ts
  - apps/web/src/hooks/useAttachments.ts
  - apps/web/src/hooks/useFileMentions.tsx
  - apps/host/src/file-mentions.ts
  - packages/protocol/src/file-refs.ts
  - packages/protocol/src/attachments.ts
---
# 附件

附件 v1 只支持内容块：不往项目文件夹写文件，不把私有存储路径给 Agent。`AttachmentRef` 只有 ID、名称、内容摘要、大小、嗅探后的 MIME 和图片尺寸；消息与持久历史只保留这些引用。Model Provider 收到的 `AttachmentContent` 是本轮调用前按引用读取的文字或 base64 图片，不进入任务快照、SSE、请求 URL 或 Host 日志。

`POST /attachments` 接收原始 Blob，`x-latch-attachment` 是至多 4 KiB 的 base64url JSON 元数据（requestId、名称、大小、所选 Harness/模型与可选会话）。同源 XHR 提供实际上传字节进度；续期后仍用同一 Blob 和 requestId。桌面代理只有这个精确路径可流式转发 25 MiB，普通 JSON 请求保留 1 MiB 限额；主进程按块检查设备，使用背压，不把文件整体缓冲或放宽其他路由。串流无法在主进程重放时，续期后以固定 `upload-retry` 让客户端重发原 Blob。

每文件本机最多 25 MiB、其他入口最多 10 MiB；PNG/JPEG/GIF/WebP 图片最多 5 MiB、4,000 万像素；每条消息最多八个附件。文件类型来自内容，完整文本必须能解码且没有 NUL。内置 Harness 只接收 256 KiB 内的文本；PDF 尚未实现 Host 解析，其他二进制与 Office 输入明确拒绝。ACP 文本作为 embedded resource，图片作为 image；实际 initialize 必须分别声明 embeddedContext 与 image，Probe 的旧记录缺少字段时不推测支持。ACP 单轮内容另有 60 MiB 编码预算。

草稿保存在 `<dataDir>/attachments/_drafts/`，绑定上传设备，一小时过期；合法提交重新持有一小时内存租约，避免启动或握手跨过原期限时被并发清理；发送后复制到会话目录，确保目标数据 fsync 和索引原子提交后才移除草稿副本。设备同时上传最多两个，全 Host 最多八个；每设备最多 32 个草稿、256 MiB，全 Host 草稿和正在接收的字节合计最多 1 GiB，索引最多 50,000 个。中断、超量、能力拒绝、审计失败均清理临时文件。索引写入失败停止接收新附件，保留原 blob 供重启后恢复；Host 启动先根据已持久化消息补齐中断的绑定，再清理一小时草稿，已提交消息不因清理顺序丢失附件；不会把损坏索引当成空记录。目录名不能命中父目录、草稿或索引保留名。

上传按设备和 requestId 幂等，内容或名称变了就冲突。首次创建消息的请求 ID 随绑定持久化，创建响应丢失后重试仍可找到同一附件和会话；换成新的创建请求不能复用已绑定附件。会话删除时删除其附件，草稿移除不影响已提交的会话文件。文件变化或摘要不一致时拒绝物化，不替换成别的文件。

附件预览经短期、绑定设备的句柄读取。

可能含密钥的文件名或文本需要明确确认。

模型能力由 Provider 的 `modelCapabilities[model].vision` 显式声明，未声明就不能发送图片；不按模型名称猜测。Host 托管服务把声明保存在配置，插件也可声明它。Harness 必须显式声明接收附件，第三方 Harness 没有声明时保持不可用。内置的四种协议各自生成图片块（Chat Completions 的 `image_url`、Responses 的 `input_image`、Anthropic 的 base64 `image`、Gemini 的 `inlineData`），仍只调用 Host 注入的出站 fetch，密钥绑定与出站策略不变。

夹具、测试 Provider 与假 ACP Agent 用于协议和权限回归，不代表真实模型、真实 CLI 或真机验收。

## 输入与预览

输入框用紧凑的文件按钮统一选择附件，也接收图片粘贴和文件拖入。文件夹提示去项目设置添加；超过 2,000 字的文字粘贴折为文本附件，可展开编辑、保存为新内容或放回输入框。每个文件有实际上传进度、取消、独立重试与移除；编辑后的字节使用新的上传请求。点击发送时等待当前上传，取消等待不发送消息且保留草稿。失败和结果未知不清空内容；未知提交保留 attachmentIds、fileRefs 与原 requestId，确认后再清理。

新会话尚无 ID 时，只在输入框内预览用户选中的这份图片或有界纯文本，不伪造会话。已提交的用户附件和 Agent 图片都是消息卡，打开同一文件列；附件标签保留附件 ID，走独立 resolve/content 入口，不获得项目路径或原生文件动作。模型设置的图片开关持久化 vision 声明，旧 Host 缺少能力时不显示上传或设置开关。

## 显式文件引用

只有 dataScope=all 的设备在 Agent 模式下能使用 `@` 文件选择。普通邮件地址保持文字；光标前独立的 `@` 打开真实搜索。新会话必须先选已保存的项目，使用 `POST /workspaces/:id/files/search {q,harnessId,limit}`；已有会话使用其固定根的搜索。搜索沿用 50,000 项、32 层、两秒和 100 条响应上限，不用 git 子进程，不遍历符号链接，疑似密钥文件与 `.git` 永不列出。

列表先排序再截断：文件名开头、文件名包含、路径包含、子序列（路径上的子序列要足够紧凑），同档时带点的路径靠后，再比层数；什么都没输入时源码在前。`.gitignore`（含子目录、否定与 `**`，读取限 64 KiB 且不跟随符号链接）忽略的文件和目录、构建目录（`node_modules`、`dist` 等；没有 `.git` 的文件夹还包括 `target`、`vendor` 等）不进第一次遍历，不占预算。输入两个字符以上且匹配很少，或者项目没有别的文件时，再做一次更小的广度优先遍历（30,000 项、一秒），结果排在所有源码之后并标「已忽略」。`.git/info/exclude`、全局忽略文件和项目目录之外的 `.gitignore` 不读。截断时菜单提示继续输入。

选择返回有限的 `FileMention {root,path}`，文字中插入可编辑标记；发送时只保留草稿里仍有标记的选择。Host 在创建或提示前解析并核对这些选择。前端不传绝对目录；没有解析所有 `@` 字符串或从邮件地址推断选择。消息保留原文与 fileRefs，模型上下文另外追加核对过的完整文件路径。两种 Driver 的请求回执覆盖引用，持久化 schema 保留 metadata。只对话模式、未接入引用的插件 Harness、受限设备或脱离所选项目的引用明确拒绝。

文件引用的标记必须保持完整词项；将 `report.txt` 改成 `report.txt.backup` 会清除原选择，不能隐藏地继续附上旧文件。已发送引用按有限 metadata 渲染为文件标记，次要文件夹也保留原 root。会话引用索引扫描这些明确选择，`work` 设备可按消息中的标记打开它们，同时仍没有搜索入口。

未绑定草稿的消费由私有 strict `claim {requestId,sessionId?}` 固定，新建会话和现有会话提示共用同一原子门禁；不同提交不能覆盖身份，已绑定同一会话的引用可以再次使用。新建的 claim 只在检查全部通过、真正派发前写入，因此取消或拒绝确认不占住草稿。Driver 明确返回 4xx（408 除外）且尚未返回已接受结果时，按原请求与目标释放 claim；5xx、超时与绑定结果未知保留原身份供重试；已经派发且结果未知的 claim 不按未提交草稿的一小时 TTL 清除，避免 Driver 暂时未加载时丢掉已接受消息的字节。冲突会要求重试原提交，或移除后重新添加，不能静默换成新的创建请求。
