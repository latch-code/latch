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
export interface AttachmentCapabilities {
  images: boolean
  text: boolean
  textBytes: number
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
