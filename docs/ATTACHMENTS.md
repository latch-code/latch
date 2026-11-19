---
description: 附件的私有存储、设备授权、内容块与模型能力。
sources:
  - apps/host/src/attachments.ts
  - apps/host/src/attachment-routes.ts
  - apps/host/src/attachment-uploads.ts
  - apps/desktop/src/host.cjs
  - apps/web/src/core/api.ts
  - apps/web/src/hooks/useAttachments.ts
  - apps/web/src/components/AttachmentTile.tsx
  - packages/harness-acp/src/attachments.ts
  - apps/web/src/hooks/imageShrink.ts
  - apps/web/src/hooks/useFileMentions.tsx
  - apps/web/src/settings/devices/ReservedAttachments.tsx
  - apps/host/src/file-mentions.ts
  - packages/protocol/src/file-refs.ts
  - packages/protocol/src/attachments.ts
  - native/ios/Sources/LatchNativeCore/PhoneAttachments.swift
  - native/ios/Sources/LatchNativeCore/HTTP2.swift
  - native/ios/App/Conversation/PhoneModel+Attachments.swift
  - native/ios/App/Conversation/AttachmentViews.swift
---
# 附件

人附上的每个文件都交给 Agent，不因类型被拒：Harness 与模型原生收的作为图片或文本，其余保存成文件、把路径交给 Agent（[按路径交给 Agent](#按路径交给-agent)）。不往项目文件夹写文件。

- `AttachmentRef` 只有 ID、名称、内容摘要、大小、嗅探后的种类与 MIME 和图片尺寸；消息与持久历史只保留这些引用。种类 `image` 是模型能看的图片（PNG、JPEG、GIF、WebP，5 MiB、4,000 万像素以内），`text` 是能整份解码的文本，`file` 是其余一切（MIME 取自内容：HEIC、BMP、AVIF、PDF、MP4、MOV、WebM、MP3、WAV、M4A、OGG、FLAC、ZIP、docx、xlsx、pptx，否则 `application/octet-stream`）。
- Model Provider 收到的 `AttachmentContent` 是本轮调用前按引用读取的文字或 base64 图片，不进入任务快照、SSE、请求 URL 或 Host 日志。
- 附件预览经短期、绑定设备的句柄读取，不获得项目路径或原生文件动作（[DOCUMENT-PREVIEWS.md](DOCUMENT-PREVIEWS.md)）。
- 可能含密钥的文件名或文本需要明确确认（`attachment-secret`）。
- 文件变化或摘要不一致时拒绝物化，不替换成别的文件。

## 上限

| 项 | 上限 |
| --- | --- |
| 每个文件 | 本机（`host.sock`）25 MiB，其他入口 10 MiB |
| 图片（PNG、JPEG、GIF、WebP） | 作为图片 5 MiB、4,000 万像素；页面先把超出的缩小，缩不了的作为文件按路径交出 |
| 每条消息 | 8 个附件 |
| 作为文本嵌入 | 256 KiB；更长的按路径交出 |
| ACP 单轮内容 | 编码后 60 MiB（`attachments-too-large`） |
| 同时上传 | 每设备 2 个，全 Host 8 个；页面一次只发 2 个，其余排队 |
| 草稿 | 每设备 32 个、256 MiB；全 Host 草稿与正在接收的字节合计 1 GiB |
| 索引 | 50,000 个（`attachment-quota`） |

- 文件种类来自内容，不看扩展名（只用扩展名区分同一容器：ZIP 里的 docx、xlsx、pptx，ISO 媒体里的 m4a，带 ID3 的 FLAC，没有 `ftyp` 的 MOV）。完整文本必须能解码且没有 NUL，否则是 `file`。
- **添加时缩小。** 超过这条连接 `imageBytes`（不超过 `fileBytes`）的图片由页面在本机解码、按方向转正后重新编码，直到同时在字节与像素上限内（首次按像素上限与 4096 长边，再降质量或按超出比例缩边，至多 6 次）；不透明的编码为 JPEG，有透明的为 WebP 或 PNG。只上传缩小后的文件，Host 照常嗅探与检查。动图、本机无法解码或仍超限的拒绝并写明原因；附件和提示标「已缩小」，原大小在悬停。
- 附件按钮的提示只写「添加文件」；上限只在文件真的超出时说出。
- 运行中排队或追加的消息只带文字：带附件或文件引用的以 400 `queue-attachments-unsupported` 拒绝。

## 模型与 Harness 能力

**一条规则**（`@latch/protocol` 的 `attachmentDelivery`）：图片在 Harness 与模型都收图片时作为图片；文本在 Harness 收嵌入文本且不超过 256 KiB 时作为文本；其余都按路径。在发送时按运行中的 Harness 决定，不在上传时；上传只拒绝真正的失败（太大、读不完、摘要不符、额度）。

- **内置 Harness**：图片只给声明 `vision` 的模型；文本总是嵌入（256 KiB 内）；其余按路径追加到这条消息的模型输入。只对话模式没有工具，Agent 只能看到文件名、类型与路径。
- **ACP Agent**：按它本轮 `initialize` 报告的 `image` 与 `embeddedContext`（[HARNESSES.md](HARNESSES.md)）；经网关路由到一个声明不看图（`vision: false`）的模型时，图片也按路径。Codex 直连与 pi 只报告图片，文本也按路径；Claude 直连与 OpenCode 直连两者都报告。
- **插件 Harness**（不经内置运行时也不是 ACP）仍按它声明或报告的 `images`、`text`，不声明 `files`，其余种类以 415 `attachment-type-unsupported` 拒绝。

- **图片要显式声明。** 模型能力由 Provider 的 `modelCapabilities[model].vision` 声明，未声明就不能发送图片，不按模型名称猜测。Host 托管的服务把声明保存在配置，插件也可声明。
- **Harness 必须显式声明接收附件。** 第三方 Harness 没有声明时不可用；插件 Harness 实现了 `Bridge.promptCapabilities` 时以它报告的为准。
- **ACP Agent** 以它最近一次为当前定义启动时 `initialize` 报告的能力为准（会话启动、新会话读取可选项、「测试启动」都算）；随驱动状态持久化，定义改了就作废。文本作为 embedded resource，图片作为 image，两者要分别声明 `embeddedContext` 与 `image`；旧记录缺少字段时不推测支持。
- 页面只在 Host 声明 `catalog.features.attachments` 时显示上传与模型设置里的图片开关。
- `HarnessInfo.attachmentsReported` 把「报告过没有」带给页面，页面在它或 Harness 状态变化时重读能力。没启动过的 ACP Agent 也收文件（`pending`）：页面不提示按路径，第一条消息按它启动时报告的决定。
- `POST /attachments/capabilities` 给出原生收的 `images`、`text`（`textBytes`）、其余是否按路径收（`files`），以及这条连接每个文件与每张图片的上限（`fileBytes`、`imageBytes`）。
- 网页会话与起始页的附件能力读取随连接横幅暂停和恢复。能力请求无应答由横幅提示。Host 明确回答的读取错误、上传与发送的操作回执各自保留。
- 内置的三种协议各自生成图片块（Chat Completions 的 `image_url`、Responses 的 `input_image`、Anthropic 的 base64 `image`），仍只调用 Host 注入的出站 fetch，密钥绑定与出站策略不变。

## 按路径交给 Agent

不原生交的附件在发送时由 Host 写成文件（`AttachmentStore.materialize`）：

- 位置：`<dataDir>/attachments/<会话>/files/<附件 ID>/<名称>`。名称是附件自己的，去掉分隔符与控制字符，开头的点换成 `_`。目录 0700、文件 0600；目录是链接或不是目录时拒绝（409 `attachment-changed`），文件先写在旁边再改名覆盖，留着的副本只在是普通文件且字节相同时沿用，所以 Agent 改了或换成链接都会被换回。
- 字节取自私有存储并核对 SHA-256；草稿尚未绑定时写进本轮会话的目录，已绑定到别的会话的拒绝。会话删除时一起删除；启动或清理时，没有任何附件绑定、只有 `files/` 且超过一小时的会话目录被删除（开始失败留下的）。
- 模型输入在提示之后多一段：「用户附上了这些文件，已保存在本机，可用你的工具按路径读取：」，每个一行 `- 名称（MIME，大小）：绝对路径`。ACP 是最后一个 text 块；内置 Harness 追加在这条用户消息的内容后。路径只进本轮模型输入，不进消息、快照、SSE 或日志。
- 这是交给可信本机 Agent 的一份副本，不是隔离。真实的 Codex、Claude、OpenCode 与 pi 经网关各自用自己的 shell 工具读到了它（`attachment-path.live.test.ts`），在默认权限下按各自的规则询问一次，Latch 显示为普通审批。内置 Harness 的 `read_file` 只读项目文件夹，读不到它：它只得到名称、类型与路径。

## 单请求上传

`POST /attachments` 接收原始 Blob。`x-latch-attachment` 是至多 4 KiB 的 base64url JSON 元数据：requestId、名称、大小、所选 Harness/模型与可选会话。

- **幂等。** 上传按设备和 requestId 幂等，内容或名称变了就冲突（`request-conflict`）。
- **桌面代理**只有这个精确路径可流式转发 25 MiB，普通 JSON 请求保留 1 MiB 限额。主进程按块检查设备，使用背压，不把文件整体缓冲。串流无法在主进程重放，所以凭据续期后以固定的 `upload-retry` 让客户端重发原 Blob（同一 requestId）。
- 中断、超量、能力拒绝、审计失败都清理临时文件。

## 存储与草稿

草稿保存在 `<dataDir>/attachments/_drafts/`，绑定上传设备，一小时过期。

- **发送。** 发送后复制到会话目录，目标数据 `fsync` 且索引原子提交后才移除草稿副本。合法提交重新持有一小时的内存租约，避免启动或握手跨过原期限时被并发清理。
- **删除。** `DELETE /attachments/:id` 只删除这台设备未发送的草稿。草稿保留给的创建或提示请求正在进行、已在这次运行中被接受或在队列里等着时，以 409 `attachment-in-use` 拒绝（与释放同一条 `reservationBusy` 规则）。会话删除时删除其附件。
- **绑定。** 首次创建消息的请求 ID 随绑定持久化：创建响应丢失后重试仍找到同一附件和会话；换成新的创建请求不能复用已绑定的附件。
- **索引写入失败**时停止接收新附件，保留原 blob 供重启后恢复；不把损坏的索引当成空记录。
- 目录名不能命中父目录、草稿或索引的保留名。

**启动时的清理**先根据已持久化的消息补齐中断的绑定，再清理过期草稿，已提交的消息不因清理顺序丢失附件。保留给某个请求的草稿（设备放弃了那个请求时会留下）占用设备的草稿额度，只在 Host 能证明没有消息需要它时释放：

- 它所属的会话在这次启动时被列出并读过，其中没有消息按 ID 引用它，且上传已满 7 天；或者那个会话被删除。
- Harness 已停用、列出失败或会话未知时一律保留；新会话的请求不知道会话，也保留。
- 运行中不删除，因为请求可能还在进行，或消息已写入而绑定失败。

**claim。** 未绑定草稿的消费由私有的 strict `claim {requestId,sessionId?}` 固定，新建会话和现有会话的提示共用同一原子门禁：

- 不同提交不能覆盖身份；已绑定同一会话的引用可以再次使用。
- 新建的 claim 只在检查全部通过、真正派发前写入，所以取消或拒绝确认不占住草稿。
- Driver 明确拒绝且尚未返回已接受结果时（4xx 但 408 除外，或错误码在 `NOT_ACCEPTED_5XX` 里的 5xx，见 [STREAMING.md](STREAMING.md) 的「确定的拒绝」），按原请求与目标释放 claim。
- 其他 5xx、超时与绑定结果未知保留原身份供重试；已经派发且结果未知的 claim 不按一小时 TTL 清除。
- 冲突时要求重试原提交，或移除后重新添加，不能静默换成新的创建请求。

## 再次使用已发送的附件

「从这里编辑」把一条消息的附件放回输入框（[STREAMING.md](STREAMING.md#从这里编辑)）：`POST /attachments/:id/reuse { requestId, selection, sessionId?, secretAcknowledged? }`（`run`）。

- 只接受已绑定到会话的附件，并按读附件内容的同一条规则核对：这台设备此刻能读那个会话，且那个会话里有消息引用它。未发送的草稿只属于上传它的设备。
- 它是一次上传：占这台设备与 Host 的上传名额和字节额度（每台同时 2 个、Host 共 8 个），并计入每台设备的写入速率（class C）；超出时 429，一个字节也不读。
- 按所选 Harness 与模型核对能力，再把存好的字节逐段复制成这台设备的新草稿（按大小与 SHA-256 核对），经过与上传相同的检查与审计（`attachment.add`）；可能含密钥时同样要确认。原附件仍绑定原会话。
- 同一 `requestId` 重试得到同一份草稿；之后它是普通草稿，随新的请求认领与绑定。

## 释放保留的草稿

设备可以自己释放保留给已放弃请求的草稿（都需要 `run`，只涉及这台设备自己的草稿）：

- `GET /attachments/reserved` 返回这台设备保留的个数、字节与每一个（ID、大小、它保留给的请求、此刻能否释放）。
- `POST /attachments/reserved/release {requestId, ids}` 只删除页面列出并经人确认的那些中、Host 现在能证明不再需要的。同一个 `requestId` 一次只处理一个：同时到达的副本等第一次的答复，换了 `ids` 则 409。

证明沿用启动清理的规则，但不等 7 天，因为是本人确认的：

- 带那个请求编号的创建或提示在这次运行里没有在进行，也没有被接受过；任何会话的队列里也没有这台设备这个请求编号的记录。
- **给已有会话的草稿：** 那个会话要被列出、不在运行，且没有消息按 ID 引用它或由那个请求发出。
- **给新会话的草稿：** 列表要完整（与快照的 `tasksComplete` 同一规则），每个会话都读过，没有消息引用它或由那个请求发出，也没有会话在运行。
- 证明不了的保留。读会话要时间，所以删除前在存储的同一次操作里再问一次那个请求是否在进行或已被接受：证明期间到达的重试保住它的草稿。

释放之后：

- 写审计 `attachment.released`（请求编号、个数与字节）。
- 释放的附件留下有限的墓碑（ID、所属设备、名称，最多 512 个，随索引保存）。之后带它的请求得到确定的 409 `attachment-released`，消息写出文件名。
- 页面把 `attachment-released` 当作 Host 证明没有送达：文字回到原输入框，附件行只能移除。
- 页面在「设置 › 设备」这台设备的「保留的附件」里列出并释放；这台设备的未确认提交保留给的那些不列出。

## 分段上传

单个请求装不下一个文件的客户端（手机：一条原生流至多 1 MiB）分段上传同一个附件。规则和 Host 的检查与单请求上传相同。网页与桌面端仍用单请求上传。

| 请求 | 作用 |
| --- | --- |
| `POST /attachments/uploads {requestId, name, kind, size, sha256, selection, sessionId?}` | 开始。按入口查每文件上限、`kind` 为 `image` 时查 5 MiB、按所选 Harness 与模型查能力。回答 `{upload}`：上传 ID、`partBytes`（1 MiB）、段数、已收段数、`next`（下一段，齐了为 null）与 `expiresAt` |
| `PUT /attachments/uploads/:id/parts/:n` | 写第 `n` 段（从 0 起，`application/octet-stream`） |
| `GET /attachments/uploads/:id` | 读进度 |
| `POST /attachments/uploads/:id/complete {secretAcknowledged?}` | 核对并成为这台设备的普通草稿 |
| `DELETE /attachments/uploads/:id` | 中止并删除各段，正在读的段随之停止；已完成的只忘掉记录，附件本身用 `DELETE /attachments/:id` 删除 |

**写段：**

- 除最后一段外每段正好 1 MiB，最后一段是余下的字节；多一字节 413，少了是 400 `attachment-incomplete`。
- 只收下一段：更后面的段不读正文就以 409 `upload-part-order` 回答并带 `next`。已收的段字节相同就给同样的回答，不同则 409 `upload-part-conflict`。
- 每块前后复查设备与 scope；段先写盘、`fsync`，记录随后原子写入。

**完成：**

- 核对总大小与 `sha256`，再做与单请求相同的内容检查：按内容嗅探种类且必须是开始时声明的 `kind`（`image`、`text` 或 `file`）、整份文本解码、密钥确认、按开始时的选择重查能力。
- 通过后的草稿在 ID、幂等、保留与释放上都与单请求上传的相同。审计只在完成时写一条 `attachment.add`（本机 `host.sock` 之外的入口），不按段写。
- `attachment-secret` 保留各段，以 `secretAcknowledged` 再完成一次，不重发字节。
- **只有内容本身被拒时删除各段并记住这个回答**：`attachment-invalid`（含摘要或声明类型不符）、`attachment-too-large`、`attachment-type-unsupported`、`attachment-image-unsupported`、`attachment-image-invalid`、`attachment-text-invalid` 与 `request-conflict`。
- 完成时重查能力得到的拒绝（Harness 不可用、缺密钥、项目正在变化、模型不收这一类）都不记住，各段保留，之后可以再完成。
- 记录先写入，再归还占用的额度；写入失败时什么都不变。

**重放。** 每一步重放都得到同样的回答，客户端因此不需要记住上传 ID：结果未知后以同一 `requestId` 再开始，从 `next` 续传。

- 同一设备同一 `requestId` 再开始，得到同一个上传与它现在的进度（已完成的带上 `attachment`；记录过期后由附件索引回答 `{attachment}`）；名称、大小、类型或摘要变了是 409。
- 完成再发一次得到同一个附件；中止再发一次仍是 `{aborted: true}`。

**隔离、状态与上限：**

- 上传按设备隔离，别的设备的上传一律 404 `upload-missing`；需要 `run`。
- 状态在 `<dataDir>/attachments/_uploads/<id>/`：`meta.json` 由 strict schema 校验（多余字段、坏记录都不采用，按过期处理整份删除），`data` 是 0600 的段文件。启动时把段文件截到记录为准的长度。
- 未完成的上传自最后一步起一小时过期。完成或被拒的记录同样保留一小时供重放，每设备最多 32 条、全 Host 256 条，超出时先删最旧的。
- 未完成的上传每设备最多 8 个（一条消息的附件数），全 Host 64 个。
- 从开始就按声明的大小占用这台设备的草稿额度（每个算一个草稿），所以落盘的段永远不会超过额度。
- 同时在读的段每设备 2 个、全 Host 8 个，每段最多在内存里 1 MiB。开始只占额度，不占单请求上传的并发名额。

## 输入与预览

- **添加。** 输入框接收文件选择、图片粘贴和文件拖入。超过这条连接每文件上限的不上传，直接说明上限；不能添加时按钮不停用，按下说明原因。超过 2,000 字的文字粘贴折为文本附件。
- **显示。** 草稿与消息里的附件都是方块（`AttachmentTile`）：图片与视频首帧（带播放标与时长）、音频时长，其余是类型图标与扩展名；名字从中间截断。消息里的图片、视频、音频进入视野后才申请预览句柄，可能含密钥的不画。点开：草稿在输入框自己的预览里看图片、视频、音频与文本；已发送的打开文件列（视频与音频以真实类型服务，文档按字节下载）。悬停写大小，按路径交出的另写「以文件交给 Agent」。
- **永久拒绝。** Host 按这些错误码拒绝的文件只能移除，不提供重试：`attachment-invalid`、`attachment-too-large`、`attachment-type-unsupported`、`attachment-image-unsupported`、`attachment-text-unsupported`、`attachment-image-invalid`、`attachment-text-invalid`、`attachment-text-too-large`、`attachments-unsupported`。收 `files` 的 Harness 只会因太大、内容与声明不符或 Harness 没有接入读取而给出其中几个。网页（`useAttachments.ts` 的 `REFUSED`）与手机（`PhoneAttachments` 的 `refused`）是同一组。
- **可重试。** 其余的可以重试，包括 400 `attachment-incomplete`、网络、超时与 5xx。每个文件独立重试与移除；编辑后的字节用新的上传请求。
- **发送。** 点击发送时等待当前上传；取消等待不发送消息且保留草稿。失败和结果未知不清空内容：未知提交保留 `attachmentIds`、`fileRefs` 与原 `requestId`，确认后再清理。
- **新会话**尚无 ID 时，只在输入框内预览用户选中的这份图片或有界纯文本，不伪造会话。本地图片 URL 在移除、文件变化或组件卸载时释放，不持久化。
- **已提交的附件**是消息卡，打开同一文件列。图片卡进入视野后才申请当前设备的预览句柄，核对附件身份、类型、可预览性和敏感标记，再读取缩略图；离开会话取消待定解析，迟到的响应不能回填其他会话。不能预览时保留文件卡，不自动取得项目文件权限。

## iPhone 与 iPad

规则与网页相同，判断写在核心的 `PhoneAttachments`。能力来自 `POST /attachments/capabilities`；快照里这个 Harness 的状态或 `attachmentsReported` 变了就重读。

**选取：**

- 「照片」用 PHPicker，不要求相册权限，只拿到选中的那几张。「文件」用系统文件选择器取一份拷贝，读一次进内存后立刻删除，不保留对原文件的访问；选择器回调没来时留下的拷贝在下次启动时清掉。
- 上限就是 Host 对这条连接的上限：每文件 10 MiB、图片 5 MiB，文字再受 Harness 的 `textBytes` 约束。
- 超过 4,000 万像素的图片与 Host 一样拒绝；只解码缩小后的像素，从不解码整张原图。50 MB 以上的原图在上传前拒绝。
- **图片重新编码。** 上传前按像素重新编码为 JPEG（有透明时为 PNG），长边从 2048 起逐级缩小、降低质量直到放得下。只写像素：原图的位置、相机、EXIF 等元数据都不离开手机。没有保留原图的开关。
- 文字文件按原字节上传，读之前先按大小拒绝，读后必须是不含 NUL 的 UTF-8。
- 所有输入框等待上传的字节合计最多 48 MB，超出时说明原因、不添加。

**上传：**

- 1 MiB 以内的文件走一条原生 HTTP/2 流；更大的走分段上传，每段一条流。正文按 64 KiB 一块写，每块之前都复查正文窗口与这条连接。一次只上传一个，其余排队。
- **结果未知不自己重发。** 超时、断线或路径切换得不到回答时，由人「重试」，用同一 `requestId` 与同一份字节。分段上传的重试先以同一 `requestId` 重新开始，只发缺的段；上传在 Host 上过期了就从第一段重来一次。
- Host 在正文写完前就回答（大小、权限、能力的拒绝）时以它的回答为准，不算结果未知。
- **取消**先关闭正在写的那段流并等它结束，再请 Host 中止这次上传、删掉已收的段。开始请求本身不会被取消打断：Host 回答后再中止它开始的上传。移除一行或关闭面板时，它在 Host 上未完成的上传一并中止。
- `attachment-secret` 写 Host 的原话并给「仍然添加」。

**内存与撤下：**

- 附件的字节只在内存里，不写文件；被 Host 收下后只留行上的小缩略图。
- 锁屏、撤销、换电脑、正文窗口关闭或权限变化时随正文一起撤下，正在进行的上传一并取消。
- 真正关闭新会话面板或离开新话题时删除它在 Host 上未发送的草稿；正在开始、正在打开正文窗口、开始结果未知或「接入已有会话」盖在上面时不删。

**发送：**

- 发往的会话与等待的那几行在按下时就定下。等待中换了会话，或那几行被撤下，这条消息不发出，文字与附件留在原处并说明原因。
- 发送中与结果未知时附件行锁定。带附件的消息是手机唯一的那条待确认写入：结果未知时保留原 `requestId` 与 `attachmentIds`，确认送达后才清空附件行。
- 重试得到 409 `attachment-released` 时按 Host 证明没有送达处理：文字回到原输入框，附件行只能移除后重新添加。

**预览。** 已发送的附件经 `resolve` 取得短期句柄，再按文件预览的规则分段读取：只预览纯文字与重绘后的 PNG/JPEG，GIF、WebP 等只显示名称与大小；`file` 种类的附件（PDF、音视频等）只列名称，不能打开。手机仍只选取并上传图片与文字文件。

真机相机、照片权限提示与 Face ID 下的行为由所有者人工验收。

## 显式文件引用

只有 `dataScope` 为 `files` 或 `all` 的设备在 Agent 模式下能使用 `@` 文件选择；范围不够时界面说明，由 Mac 上的设备页开启。只对话模式、未接入引用的插件 Harness、受限设备或脱离所选项目的引用明确拒绝。

**搜索：**

- 新会话必须先选已保存的项目，使用 `POST /workspaces/:id/files/search {q,harnessId,limit}`；已有会话使用其固定根的搜索。
- 上限 50,000 项、32 层、两秒和 100 条响应。不用 git 子进程，不遍历符号链接；疑似密钥文件与 `.git` 永不列出。
- `.gitignore`（含子目录、否定与 `**`，读取限 64 KiB 且不跟随符号链接）忽略的文件和目录、构建目录（`node_modules`、`dist` 等；没有 `.git` 的文件夹还包括 `target`、`vendor` 等）不进第一次遍历，不占预算。
- 输入两个字符以上且匹配很少，或者项目没有别的文件时，再做一次更小的广度优先遍历（30,000 项、一秒），结果排在所有源码之后并标「已忽略」。
- `.git/info/exclude`、全局忽略文件和项目目录之外的 `.gitignore` 不读。
- 排序先于截断：文件名开头、文件名包含、路径包含、子序列（路径上的子序列要足够紧凑）；同档时带点的路径靠后，再比层数；什么都没输入时源码在前。

**选择：**

- 普通邮件地址保持文字；只有光标前独立的 `@` 打开搜索。裸 `@` 打开时没有预选行，输入查询后首行默认选中。
- 选择返回有限的 `FileMention {root,path}`，文字中插入可编辑标记；发送时只保留草稿里仍有标记的选择。前端不传绝对目录，也不从文字里的 `@` 字符串或邮件地址推断选择。
- 标记必须保持完整词项：把 `report.txt` 改成 `report.txt.backup` 会清除原选择，不能隐藏地继续附上旧文件。
- Host 在创建或提示前解析并核对这些选择。消息保留原文与 `fileRefs`，模型上下文另外追加核对过的完整文件路径。两种 Driver 的请求回执覆盖引用，持久化 schema 保留 metadata。
- 已发送的引用按有限 metadata 渲染为文件标记，次要文件夹也保留原 root。`work` 设备可按消息中的标记打开它们，同时仍没有搜索入口。

## 验证范围

夹具、测试 Provider 与假 ACP Agent 用于协议和权限回归，不代表真实模型、真实 CLI 或真机验收。
