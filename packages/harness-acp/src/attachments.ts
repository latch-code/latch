import { isAttachmentRef, type AttachmentRef } from '@latch/protocol'
import { AppError, type AttachmentContent } from '@latch/sdk'
export function checkedAttachments(value: AttachmentRef[] | undefined): AttachmentRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8 || !value.every(isAttachmentRef) || new Set(value.map(ref => ref.id)).size !== value.length)
    throw new AppError(400, 'attachment-invalid', '附件引用无效。')
  return structuredClone(value)
}
/** Content is embedded, never written into the Agent's project or exposed as a local filesystem URI. */
export async function promptBlocks(
  prompt: string,
  refs: readonly AttachmentRef[],
  capabilities: { images: boolean; embeddedContext: boolean },
  read: ((ref: AttachmentRef) => Promise<AttachmentContent>) | undefined,
): Promise<unknown[]> {
  const blocks: unknown[] = prompt ? [{ type: 'text', text: prompt }] : []
  let bytes = Buffer.byteLength(prompt)
  for (const ref of refs) {
    if (!read) throw new AppError(415, 'attachments-unsupported', '当前 Harness 尚未接入附件读取。')
    if (ref.kind === 'image' && !capabilities.images) throw new AppError(415, 'agent-image-unsupported', '当前 Agent 不接受图片附件。')
    if (ref.kind === 'text' && !capabilities.embeddedContext)
      throw new AppError(415, 'agent-text-unsupported', '当前 Agent 不接受嵌入文本附件。')
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
  return blocks
}
