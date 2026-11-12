/** Public metadata only. Bytes, private paths and upload ownership never enter session snapshots. */
export interface AttachmentRef {
  id: string
  name: string
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'text/plain'
  kind: 'image' | 'text'
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
export interface AttachmentCapabilities {
  images: boolean
  text: boolean
  textBytes: number
  /** Per file over this connection and per image; absent on older Hosts. */
  fileBytes?: number
  imageBytes?: number
  reason?: string
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
      || (item.kind === 'image' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(item.mime))))
    && ['width', 'height'].every(
      key => item[key] === undefined || (Number.isSafeInteger(item[key]) && Number(item[key]) > 0 && Number(item[key]) <= 40_000),
    )
  )
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
