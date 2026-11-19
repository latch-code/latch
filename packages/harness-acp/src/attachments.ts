import {
  ATTACHMENT_EMBEDDED_TEXT_BYTES,
  attachmentDelivery,
  attachmentPathText,
  isAttachmentRef,
  type AttachmentRef,
} from '@latch/protocol'
import { AppError, type AttachmentContent } from '@latch/sdk'
export function checkedAttachments(value: AttachmentRef[] | undefined): AttachmentRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8 || !value.every(isAttachmentRef) || new Set(value.map(ref => ref.id)).size !== value.length)
    throw new AppError(400, 'attachment-invalid', '附件引用无效。')
  return structuredClone(value)
}

/**
 * The prompt's ACP content. Each attachment goes in the best form the running agent reported it takes
 * (`attachmentDelivery`): a picture as `image`, text as an embedded resource with a `latch-attachment:<id>` URI, and
 * everything else, or what the agent does not take natively, saved in the session's attachment folder and named by its
 * absolute path in one text block, for the agent to open with its own tools. A file is never refused for its type.
 */
export async function promptBlocks(
  prompt: string,
  refs: readonly AttachmentRef[],
  capabilities: { images: boolean; embeddedContext: boolean },
  read: ((ref: AttachmentRef) => Promise<AttachmentContent>) | undefined,
  pathOf?: (ref: AttachmentRef) => Promise<string>,
): Promise<unknown[]> {
  const blocks: unknown[] = prompt ? [{ type: 'text', text: prompt }] : []
  const files: Array<{ ref: AttachmentRef; path: string }> = []
  let bytes = Buffer.byteLength(prompt)
  for (const ref of refs) {
    const delivery = attachmentDelivery(ref, {
      images: capabilities.images,
      text: capabilities.embeddedContext,
      textBytes: ATTACHMENT_EMBEDDED_TEXT_BYTES,
    })
    if (delivery === 'path') {
      if (!pathOf) throw new AppError(415, 'attachments-unsupported', '当前 Harness 尚未接入附件读取。')
      files.push({ ref, path: await pathOf(ref) })
      continue
    }
    if (!read) throw new AppError(415, 'attachments-unsupported', '当前 Harness 尚未接入附件读取。')
    const content = await read(ref)
    if (content.type === 'image') {
      bytes += content.data.length
      blocks.push({ type: 'image', data: content.data, mimeType: content.mimeType })
    } else {
      bytes += Buffer.byteLength(content.text)
      blocks.push({ type: 'resource', resource: { uri: `latch-attachment:${ref.id}`, mimeType: 'text/plain', text: content.text } })
    }
    if (bytes > 60 * 1024 * 1024) throw new AppError(413, 'attachments-too-large', '附件合计超过 Agent 单轮输入限制，请减少附件。')
  }
  if (files.length) blocks.push({ type: 'text', text: attachmentPathText(files) })
  return blocks
}
