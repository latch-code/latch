/** What a picture a model can see is encoded as. */
export const ATTACHMENT_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
/**
 * What any other file is, by its sniffed content: media a browser can show, documents, archives, else plain bytes. A
 * picture over the image limits, or one no model takes (HEIC, BMP, AVIF), is a file too.
 */
export const ATTACHMENT_FILE_MIMES = [
  ...ATTACHMENT_IMAGE_MIMES,
  'image/heic',
  'image/bmp',
  'image/avif',
  'image/x-icon',
  'application/pdf',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/mp4',
  'audio/ogg',
  'audio/flac',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/octet-stream',
] as const
export type AttachmentFileMime = (typeof ATTACHMENT_FILE_MIMES)[number]
/**
 * Public metadata only. Bytes, private paths and upload ownership never enter session snapshots. `image` is a picture
 * a model can be shown, `text` decodes as text in full, `file` is anything else, handed to an agent by its path.
 */
export interface AttachmentRef {
  id: string
  name: string
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'text/plain' | AttachmentFileMime
  kind: 'image' | 'text' | 'file'
  size: number
  sha256: string
  width?: number
  height?: number
}
export interface AttachmentSelection {
  harnessId: string
  workspaceId?: string
  model?: { providerId: string; model: string }
  mode?: 'chat' | 'agent'
}
export interface AttachmentUpload {
  requestId: string
  name: string
  size: number
  selection: AttachmentSelection
  sessionId?: string
  secretAcknowledged?: boolean
}
/**
 * One chunked upload (`POST /attachments/uploads`): parts of `partBytes` each, the last one shorter, sent in order from
 * `next`. `attachment` once it is complete; `next` is null when every part is in.
 */
export interface AttachmentUploadView {
  id: string
  requestId: string
  size: number
  partBytes: number
  parts: number
  received: number
  next: number | null
  expiresAt: number
  attachment?: AttachmentRef
}
/**
 * What the Harness and model take natively: `images` as pictures, `text` as embedded text up to `textBytes`. Anything
 * else (`files`) is saved in the session's attachment folder and the agent is given its path (`attachmentDelivery`).
 */
export interface AttachmentCapabilities {
  images: boolean
  text: boolean
  textBytes: number
  /** Every other file is taken by its path; absent on older Hosts, which take only `images` and `text`. */
  files?: boolean
  /** What the agent takes natively is not known until it first starts: each prompt is decided then. */
  pending?: true
  /** Per file over this connection and per image; absent on older Hosts. */
  fileBytes?: number
  imageBytes?: number
  /** Why nothing, or not everything, can be attached: a short label. */
  reason?: string
  /** What `reason` leaves out, behind its Hint. */
  reasonDetail?: string
}
export function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return (
    Object.keys(item).every(key => ['id', 'name', 'mime', 'kind', 'size', 'sha256', 'width', 'height'].includes(key))
    && typeof item.id === 'string'
    && /^[A-Za-z0-9_-]{22}$/u.test(item.id)
    && typeof item.name === 'string'
    && item.name.length > 0
    && item.name.length <= 200
    && typeof item.sha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(item.sha256)
    && Number.isSafeInteger(item.size)
    && Number(item.size) > 0
    && Number(item.size) <= 25 * 1024 * 1024
    && ((item.kind === 'text' && item.mime === 'text/plain')
      || (item.kind === 'image' && (ATTACHMENT_IMAGE_MIMES as readonly string[]).includes(String(item.mime)))
      || (item.kind === 'file' && (ATTACHMENT_FILE_MIMES as readonly string[]).includes(String(item.mime))))
    && ['width', 'height'].every(
      key => item[key] === undefined || (Number.isSafeInteger(item[key]) && Number(item[key]) > 0 && Number(item[key]) <= 40_000),
    )
  )
}

/** Text an agent is given embedded at most this long; a longer file goes by its path, which its tools read better. */
export const ATTACHMENT_EMBEDDED_TEXT_BYTES = 256 * 1024
/** How an attachment reaches the agent: as a picture, as embedded text, or saved as a file whose path it is given. */
export type AttachmentDelivery = 'image' | 'text' | 'path'
/**
 * The one rule for every Harness: a picture goes as a picture where the Harness and model take one, text as text where
 * the Harness embeds it and it fits; everything else, and those where they do not, goes by its path. Never a refusal.
 */
export function attachmentDelivery(
  ref: Pick<AttachmentRef, 'kind' | 'size'>,
  takes: { images: boolean; text: boolean; textBytes: number },
): AttachmentDelivery {
  if (ref.kind === 'image' && takes.images) return 'image'
  if (ref.kind === 'text' && takes.text && ref.size <= takes.textBytes) return 'text'
  return 'path'
}

const sizeText = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`
/**
 * What the model is told of the files that go by their path: name, type, size and absolute path of each, for the agent
 * to open with its own tools. Added to the model's context only; the message keeps the attachment references.
 */
export function attachmentPathText(
  files: ReadonlyArray<{ ref: Pick<AttachmentRef, 'name' | 'kind' | 'mime' | 'size'>; path: string }>,
): string {
  return [
    '用户附上了这些文件，已保存在本机，可用你的工具按路径读取：',
    ...files.map(({ ref, path }) => `- ${ref.name}（${ref.mime}，${sizeText(ref.size)}）：${path}`),
  ].join('\n')
}

/**
 * This device's uploads held for a submission it may have given up (放弃这次提交). They count against its draft quota
 * until the Host proves no saved message needs them; `releasable` are the ones it can prove that for now.
 */
export interface ReservedAttachments {
  count: number
  bytes: number
  releasable: number
  releasableBytes: number
  /** Each one, with the request it is held for; a page leaves out its own unconfirmed submission's. */
  items: Array<{ id: string; bytes: number; requestId: string; releasable: boolean }>
}
