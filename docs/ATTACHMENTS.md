---
description: 附件的私有存储、设备授权、内容块与模型能力。
sources:
  - apps/host/src/attachments.ts
  - apps/host/src/attachment-routes.ts
  - apps/host/src/attachment-uploads.ts
  - apps/desktop/src/host.cjs
  - apps/web/src/core/api.ts
  - apps/web/src/hooks/useAttachments.ts
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

附件 v1 只支持内容块：不往项目文件夹写文件，不把私有存储路径给 Agent。`AttachmentRef` 只有 ID、名称、内容摘要、大小、嗅探后的 MIME 和图片尺寸；消息与持久历史只保留这些引用。Model Provider 收到的 `AttachmentContent` 是本轮调用前按引用读取的文字或 base64 图片，不进入任务快照、SSE、请求 URL 或 Host 日志。

`POST /attachments` 接收原始 Blob，`x-latch-attachment` 是至多 4 KiB 的 base64url JSON 元数据（requestId、名称、大小、所选 Harness/模型与可选会话）。同源 XHR 提供实际上传字节进度；续期后仍用同一 Blob 和 requestId。桌面代理只有这个精确路径可流式转发 25 MiB，普通 JSON 请求保留 1 MiB 限额；主进程按块检查设备，使用背压，不把文件整体缓冲或放宽其他路由。串流无法在主进程重放时，续期后以固定 `upload-retry` 让客户端重发原 Blob。

每文件本机最多 25 MiB、其他入口最多 10 MiB；PNG/JPEG/GIF/WebP 图片最多 5 MiB、4,000 万像素；每条消息最多八个附件。文件类型来自内容，完整文本必须能解码且没有 NUL。内置 Harness 只接收 256 KiB 内的文本；PDF 尚未实现 Host 解析，其他二进制与 Office 输入明确拒绝。ACP 文本作为 embedded resource，图片作为 image；实际 initialize 必须分别声明 embeddedContext 与 image，Probe 的旧记录缺少字段时不推测支持。ACP 单轮内容另有 60 MiB 编码预算。

草稿保存在 `<dataDir>/attachments/_drafts/`，绑定上传设备，一小时过期；合法提交重新持有一小时内存租约，避免启动或握手跨过原期限时被并发清理；发送后复制到会话目录，确保目标数据 fsync 和索引原子提交后才移除草稿副本。设备同时上传最多两个，全 Host 最多八个；每设备最多 32 个草稿、256 MiB，全 Host 草稿和正在接收的字节合计最多 1 GiB，索引最多 50,000 个。中断、超量、能力拒绝、审计失败均清理临时文件。索引写入失败停止接收新附件，保留原 blob 供重启后恢复；Host 启动先根据已持久化消息补齐中断的绑定，再清理一小时草稿，已提交消息不因清理顺序丢失附件；保留给某个请求的草稿（设备放弃了那个请求时会留下）占用设备的草稿额度，只在 Host 能证明没有消息需要它时释放：它所属的会话在这次启动时被列出并读过、其中没有消息按 ID 引用它，且上传已满 7 天；或者那个会话被删除。Harness 已停用、列出失败或会话未知时一律保留，新会话的请求不知道会话，也保留；运行中不删除，因为请求可能还在进行，或消息已写入而绑定失败；不会把损坏索引当成空记录。目录名不能命中父目录、草稿或索引保留名。

设备也可以自己释放这些保留的草稿：`GET /attachments/reserved` 返回这台设备保留的个数、字节、每一个（ID、大小、它保留给的请求、此刻能否释放），`POST /attachments/reserved/release {requestId, ids}` 只删除页面列出并经人确认的那些中 Host 现在能证明不再需要的（都需要 `run`，只涉及这台设备自己的草稿）；同一个 `requestId` 一次只处理一个：同时到达的副本等第一次的答复，换了 `ids` 则 409（同时到达也一样）。证明沿用启动清理的规则，但不等 7 天，因为是本人确认的：带那个请求编号的创建或提示在这次运行里没有在进行、也没有被接受过，任何会话的队列里也没有这台设备这个请求编号的记录；草稿是给已有会话的，那个会话要被列出、不在运行，且没有消息按 ID 引用它或由那个请求发出；给新会话的，要列表完整（与快照的 `tasksComplete` 同一规则：每个保存的 Agent、每个已启用插件的 Harness 都已挂载并列出，没有启动失败或正在启动的，没有停用、更新后暂停或加载失败的插件资产，内置插件没有停用），每个会话都读过，没有消息引用它或由那个请求发出，也没有会话在运行。证明不了的保留。读会话要时间，所以删除前在存储的同一次操作里再问一次那个请求是否在进行或已被接受：证明期间到达的重试保住它的草稿。释放写审计 `attachment.released`（请求编号、个数与字节）。释放的附件留下有限的墓碑（ID、所属设备、名称，最多 512 个，随索引保存）：之后带它的请求得到确定的 409 `attachment-released`，消息写出文件名。页面把它当作 Host 证明没有送达：文字回到原输入框（不在屏幕上时存为那个会话的草稿），附件行写「已在 设置 › 设备 里释放」，只能移除。页面在 设置 › 设备 › 这台设备 的「保留的附件」显示个数与大小，「释放…」先要确认，只发送它列出的；这台设备的未确认提交（存储里的，或存储不可用时内存里的）保留给的那些不列出。

上传按设备和 requestId 幂等，内容或名称变了就冲突。`DELETE /attachments/:id` 只删除这台设备未发送的草稿；草稿保留给的创建或提示请求正在进行、已在这次运行中被接受或在队列里等着时（与释放同一条 `reservationBusy` 规则），以 409 `attachment-in-use` 拒绝，网页与手机都不能借移除删掉一条消息还要的字节。首次创建消息的请求 ID 随绑定持久化，创建响应丢失后重试仍可找到同一附件和会话；换成新的创建请求不能复用已绑定附件。会话删除时删除其附件，草稿移除不影响已提交的会话文件。文件变化或摘要不一致时拒绝物化，不替换成别的文件。

附件预览经短期、绑定设备的句柄读取。

可能含密钥的文件名或文本需要明确确认。

模型能力由 Provider 的 `modelCapabilities[model].vision` 显式声明，未声明就不能发送图片；不按模型名称猜测。Host 托管服务把声明保存在配置，插件也可声明它。Harness 必须显式声明接收附件，第三方 Harness 没有声明时保持不可用；插件 Harness 实现了 `Bridge.promptCapabilities` 时，以它报告的为准。ACP Agent 以它最近一次为当前定义启动时 `initialize` 报告的能力为准：会话启动、新会话选中时读取可选项、「测试启动」都算（`Bridge.promptCapabilities`，随驱动状态持久化，定义改了就作废）；`HarnessInfo.attachmentsReported` 把它带给页面，页面在它或 Harness 状态变化时重读能力，不必刷新。没启动过时 `reason` 是一个短标签「发出第一条消息后可添加文件」，`reasonDetail` 是放在 ⓘ 后的说明（还不知道它接收哪些文件，也可以先测试启动）；都不接收、或只收一种时也说明。能力同时给出这条连接每个文件与每张图片的上限（`fileBytes`、`imageBytes`）。内置的三种协议各自生成图片块（Chat Completions 的 `image_url`、Responses 的 `input_image`、Anthropic 的 base64 `image`），仍只调用 Host 注入的出站 fetch，密钥绑定与出站策略不变。

夹具、测试 Provider 与假 ACP Agent 用于协议和权限回归，不代表真实模型、真实 CLI 或真机验收。

## 分段上传

单个请求装不下一个文件的客户端（手机：一条原生流至多 1 MiB）分段上传同一个附件，规则与上面的单请求上传相同，Host 检查的也相同：

- `POST /attachments/uploads {requestId, name, kind, size, sha256, selection, sessionId?}` 开始：按入口查每文件上限、`kind` 为 `image` 时查 5 MiB、按所选 Harness 与模型查能力（文本另查 `textBytes`），回答 `{upload}`：上传 ID、`partBytes`（1 MiB）、段数、已收段数、`next`（下一段，齐了为 null）与 `expiresAt`。
- `PUT /attachments/uploads/:id/parts/:n` 写第 `n` 段（从 0 起，`application/octet-stream`）：除最后一段外每段正好 1 MiB，最后一段是余下的字节，多一字节就 413，少了是 400 `attachment-incomplete`。只收下一段：更后面的段不读正文就以 409 `upload-part-order` 回答并带 `next`；已收的段字节相同就给同样的回答，不同则 409 `upload-part-conflict`。每块前后复查设备与 scope，段先写盘、fsync，记录随后原子写入。
- `GET /attachments/uploads/:id` 读进度；`POST /attachments/uploads/:id/complete {secretAcknowledged?}` 核对总大小与 `sha256`，再做与单请求相同的内容检查（按内容嗅探类型且必须是开始时声明的 `kind`、图片像素上限、整份文本解码、密钥确认、按开始时的选择重查能力），通过后成为这台设备的普通草稿，ID、幂等、保留与释放都与单请求上传的草稿相同。审计只在完成时写一条 `attachment.add`（本机 `host.sock` 之外的入口），不按段写。`attachment-secret` 保留各段，「仍然添加」以 `secretAcknowledged` 再完成一次，不重发字节。只有内容本身被拒时删除各段并记住这个回答：`attachment-invalid`（含摘要或声明类型不符）、`attachment-too-large`、`attachment-type-unsupported`、`attachment-image-unsupported`、`attachment-image-invalid`、`attachment-text-invalid` 与 `request-conflict`；完成时重查能力得到的拒绝（Harness 不可用、缺密钥、项目正在变化、模型不收这一类）都不记住，各段保留，之后可以再完成。记录先写入，再归还占用的额度，写入失败时什么都不变。
- `DELETE /attachments/uploads/:id` 中止并删除各段，正在读的段随之停止；已完成的只忘掉记录，附件本身用 `DELETE /attachments/:id` 删除。

每一步重放都得到同样的回答：同一设备同一 `requestId` 再开始，得到同一个上传与它现在的进度（已完成的带上 `attachment`；记录过期后由附件索引回答 `{attachment}`），名称、大小、类型或摘要变了是 409；完成再发一次得到同一个附件；中止再发一次仍是 `{aborted: true}`。客户端因此不需要记住上传 ID：结果未知后以同一 `requestId` 再开始，从 `next` 续传。

上传按设备隔离，别的设备的上传一律 404 `upload-missing`，需要 `run`。状态在 `<dataDir>/attachments/_uploads/<id>/`：`meta.json` 由 strict schema 校验（多余字段、坏记录都不采用，按过期处理整份删除），`data` 是 0600 的段文件；启动时把段文件截到记录为准的长度。未完成的上传自最后一步起一小时过期，完成或被拒的记录同样保留一小时供重放，每设备最多 32 条、全 Host 256 条，超出时先删最旧的（重新开始仍由附件索引回答）。上限：每设备最多 8 个未完成上传（一条消息的附件数，丢了一个仍能放下一整条），全 Host 64 个；从开始就按声明的大小占用这台设备的草稿额度（每个算一个草稿，与草稿和正在接收的字节合计每设备 256 MiB、全 Host 1 GiB），所以落盘的段永远不会超过额度；同时在读的段每设备 2 个、全 Host 8 个，每段最多在内存里 1 MiB。开始只占额度，不占单请求上传的并发名额（每设备 2 条、全 Host 8 条正在接收的流）。网页与桌面仍用单请求上传：同源 XHR 与桌面代理的有界串流本来就能一次送完 25 MiB。

## 输入与预览

输入框用紧凑的文件按钮统一选择附件，也接收图片粘贴和文件拖入。按钮的提示写出上限（图片、文字文件各多大、每条 8 个）；不能添加时按钮不停用，按下在输入框里说明原因，触屏没有悬停也看得到。超过上限的文件不上传，直接说明。Host 按错误码拒绝的文件（类型、大小、能力：`attachment-invalid`、`attachment-too-large`、`attachment-*-unsupported`、`attachment-image-invalid`、`attachment-text-invalid`、`attachment-text-too-large`、`attachments-unsupported`）标为被拒绝，只能移除，不提供「重试上传」；其余（含 400 `attachment-incomplete`、网络、超时与 5xx）可重试。会话运行中，排队或追加的消息只带文字（Host 以 400 `queue-attachments-unsupported` 拒绝带附件或文件引用的），输入框里有附件或文件引用时先用琥珀色说明，发送前就看得到。文件夹提示去项目设置添加；超过 2,000 字的文字粘贴折为文本附件，可展开编辑、保存为新内容或放回输入框。每个文件有实际上传进度、取消、独立重试与移除；编辑后的字节使用新的上传请求。点击发送时等待当前上传，取消等待不发送消息且保留草稿。失败和结果未知不清空内容；未知提交保留 attachmentIds、fileRefs 与原 requestId，确认后再清理。

新会话尚无 ID 时，只在输入框内预览用户选中的这份图片或有界纯文本，不伪造会话。Host 确认是图片后，草稿显示可点击缩略图；其他文件是带名称、大小和实际上传状态的紧凑卡片。附件横向排列，窄屏内部滚动，移除按钮独立；本地图片 URL 在移除、文件变化或组件卸载时释放，不持久化。失败重试、敏感内容确认与提交锁定仍使用原上传请求。

已提交的用户附件和 Agent 图片都是消息卡，打开同一文件列；附件标签保留附件 ID，走独立 resolve/content 入口，不获得项目路径或原生文件动作。图片卡进入视野后才申请当前设备的预览句柄，核对附件身份、类型、可预览性和敏感标记，再读取缩略图；离开会话取消待定解析，迟到响应不能回填其他会话。不能预览时保留可点击的文件卡，不自动取得项目文件权限。模型设置的图片开关持久化 vision 声明，旧 Host 缺少能力时不显示上传或设置开关。

## iPhone 与 iPad

会话的输入框、新会话面板与我的 Agent 的新话题有同一个「＋」，规则与网页相同，判断写在核心的 `PhoneAttachments`（夹具测试）。能力来自 `POST /attachments/capabilities`；快照里这个 Harness 的状态或 `attachmentsReported` 变了就重读，Host 还没回答而快照已报告它什么都不收时，按「＋」直接说明原因。能添加时「＋」是菜单，标题写上限：图片、文字文件各多大与每条 8 个；「照片」（PHPicker，不要求相册权限，只拿到选中的那几张）与「拍照」（只在设备有相机时出现，模拟器通常没有）只在能收图片时出现，「文件」用系统文件选择器取一份拷贝，读一次进内存后立刻删除，不保留对原文件的访问；选择器的回调没来时留下的拷贝（`tmp/<bundle>-Inbox`）在下次启动时清掉。不能添加时「＋」不停用，按下在输入框上方说明原因。选择器没有交回任何文件时（包括它先自行关闭、回调丢失）也写一句原因，只有人取消时不说。

手机上每个文件的上限就是 Host 对这条连接的上限：每文件 10 MiB、图片 5 MiB，文字再受 Harness 的 `textBytes` 约束（内置 Harness 256 KiB），上限行写出的就是这些数。1 MiB 以内的文件走一条原生流；更大的走上面的分段上传，每段一条流、至多 1 MiB，同样逐块复查。超过 4000 万像素的图片与 Host 一样拒绝，只解码缩小后的像素、从不解码整张原图。图片在上传前按像素重新编码为 JPEG（有透明时为 PNG），长边从 2048 起逐级缩小、降低质量直到放得下；只写像素，原图的位置、相机、EXIF 等元数据都不离开手机。这一批没有保留原图或关闭重新编码的开关。文字文件按原字节上传，读之前先按大小拒绝，读后必须是不含 NUL 的 UTF-8。超过上限、类型不收（PDF、Office 等）、超过 8 个与 50 MB 以上的原图都在上传前拒绝，并说明可以添加什么。

上传经当前连接的一条 HTTP/2 流：`x-latch-attachment` 元数据同网页，正文按 64 KiB 一块写，每块之前都复查正文窗口与这条连接；一次只上传一个，其余排队。取消关闭这条流并等它结束，行变为「上传已取消，可以重试」。超时、断线或路径切换得不到回答时行写「结果未知」，「重试」用同一 `requestId` 与同一份字节，Host 按设备与请求编号认出同一个附件；不会自己重发。分段上传的重试先以同一 `requestId` 重新开始，Host 回答已收到哪几段，只发缺的段，已收的不重发；上传在 Host 上过期了就从第一段重来一次。取消先关闭正在写的那段流并等它结束，再请 Host 中止这次上传、删掉已收的段，重试从第一段开始；开始请求本身不会被取消打断，Host 回答后再中止它开始的上传。行记住 Host 上未完成的上传，结果未知、待确认密钥或可重试的失败之后移除这一行（或关闭面板丢下它）时一并中止。附件被 Host 收下后，手机内存里只留行上的小缩略图，不再保留字节；所有输入框等待上传的字节合计最多 48 MB，超出时说明原因、不添加。Host 在正文写完前就回答（大小、权限、能力的拒绝）时，以它的回答为准，不算结果未知。排在后面的行也能立即取消。Host 按错误码永久拒绝的（与网页同一组）只能移除；`attachment-incomplete`、网络与 5xx 可以重试；`attachment-secret` 写 Host 的原话并给「仍然添加」。消息发出时先等仍在上传的附件，发往的会话与等待的那几行在按下时就定下：等待中换了会话，或那几行被撤下（锁屏、窗口关闭、面板关闭），这条消息不发出，文字与附件留在原处并说明原因；发送中与结果未知时附件行锁定，不能添加、重试或移除；带附件的消息是手机唯一的那条待确认写入，结果未知时保留原 `requestId` 与 `attachmentIds`，确认送达后才清空附件行。重试得到 409 `attachment-released` 时按 Host 证明没有送达处理：附件行写「已在 设置 › 设备 里释放，请移除后重新添加」，文字回到原输入框。「放弃这次提交」清空附件行并提示重新添加，原因同网页。会话运行中要排队或追加时，输入框里有附件就先用琥珀色说明，发送按钮不可用。

附件的字节只在内存里，不写文件；锁屏、撤销、换电脑、正文窗口关闭或权限变化时随正文一起撤下，正在进行的上传一并取消；真正关闭新会话面板或离开新话题时删除它在 Host 上未发送的草稿；正在开始、正在打开正文窗口、开始结果未知或「接入已有会话」盖在上面时不删。已发送的附件在消息里显示为文件条，点开经 `resolve` 取得短期句柄，再按文件预览的规则分段读取：只预览纯文字与重绘后的 PNG/JPEG，GIF、WebP 等只显示名称与大小。真机相机、照片权限提示与 Face ID 下的行为由所有者人工验收。

## 显式文件引用

只有 dataScope=all 的设备在 Agent 模式下能使用 `@` 文件选择。范围不够时占位文字写「这台设备看不到项目文件」，输入 `@` 时菜单也这样写，ⓘ 说明到 Mac 的 设置 › 设备 为这台设备开启「可以看项目文件」；设备页显示这一项开没开，只有 Mac 能改。普通邮件地址保持文字；光标前独立的 `@` 打开真实搜索。Web 使用和 Slash 相同的 Suggest 浮层。每次打开裸 `@` 时等方向键选行，输入查询后结果的首行默认选中，Tab 与 Enter 插入选中的引用。Escape 关闭，删掉 `@` 再输入会重新查询。新会话必须先选已保存的项目，使用 `POST /workspaces/:id/files/search {q,harnessId,limit}`；已有会话使用其固定根的搜索。搜索沿用 50,000 项、32 层、两秒和 100 条响应上限，不用 git 子进程，不遍历符号链接，疑似密钥文件与 `.git` 永不列出。

列表先排序再截断：文件名开头、文件名包含、路径包含、子序列（路径上的子序列要足够紧凑），同档时带点的路径靠后，再比层数；什么都没输入时源码在前。`.gitignore`（含子目录、否定与 `**`，读取限 64 KiB 且不跟随符号链接）忽略的文件和目录、构建目录（`node_modules`、`dist` 等；没有 `.git` 的文件夹还包括 `target`、`vendor` 等）不进第一次遍历，不占预算。输入两个字符以上且匹配很少，或者项目没有别的文件时，再做一次更小的广度优先遍历（30,000 项、一秒），结果排在所有源码之后并标「已忽略」。`.git/info/exclude`、全局忽略文件和项目目录之外的 `.gitignore` 不读。截断时菜单提示继续输入。

选择返回有限的 `FileMention {root,path}`，文字中插入可编辑标记；发送时只保留草稿里仍有标记的选择。Host 在创建或提示前解析并核对这些选择。前端不传绝对目录；没有解析所有 `@` 字符串或从邮件地址推断选择。消息保留原文与 fileRefs，模型上下文另外追加核对过的完整文件路径。两种 Driver 的请求回执覆盖引用，持久化 schema 保留 metadata。只对话模式、未接入引用的插件 Harness、受限设备或脱离所选项目的引用明确拒绝。

文件引用的标记必须保持完整词项；将 `report.txt` 改成 `report.txt.backup` 会清除原选择，不能隐藏地继续附上旧文件。已发送引用按有限 metadata 渲染为文件标记，次要文件夹也保留原 root。会话引用索引扫描这些明确选择，`work` 设备可按消息中的标记打开它们，同时仍没有搜索入口。

未绑定草稿的消费由私有 strict `claim {requestId,sessionId?}` 固定，新建会话和现有会话提示共用同一原子门禁；不同提交不能覆盖身份，已绑定同一会话的引用可以再次使用。新建的 claim 只在检查全部通过、真正派发前写入，因此取消或拒绝确认不占住草稿。Driver 明确拒绝且尚未返回已接受结果时（4xx 但 408 除外，或错误码在 `NOT_ACCEPTED_5XX` 里的 5xx，例如 503 `agent-start-failed`，见 [STREAMING.md](STREAMING.md) 的「确定的拒绝」），按原请求与目标释放 claim；其他 5xx、超时与绑定结果未知保留原身份供重试；已经派发且结果未知的 claim 不按未提交草稿的一小时 TTL 清除，避免 Driver 暂时未加载时丢掉已接受消息的字节。冲突会要求重试原提交，或移除后重新添加，不能静默换成新的创建请求。
