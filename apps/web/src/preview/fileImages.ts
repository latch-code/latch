import { isFileMetadata } from '@latch/protocol'
import { api } from '../core/api.ts'

/** Resolve an image through the same session authorization as a clicked file reference. */
export async function resolveFileImage(sessionId: string, reference: string, rootId: string | undefined, signal: AbortSignal) {
  const result = await api<{ files?: Array<{ status?: string; file?: unknown }> }>(`tasks/${encodeURIComponent(sessionId)}/files/resolve`, {
    method: 'POST',
    body: { paths: [reference], ...(rootId ? { rootId } : {}) },
    signal,
  })
  const answer = result.files?.[0]
  const file = answer?.file
  if (
    answer?.status !== 'ok'
    || !isFileMetadata(file)
    || file.secret
    || file.kind !== 'image'
    || !file.actions.preview
    || !file.width
    || !file.height
    || file.width > 40_000
    || file.height > 40_000
    || file.width * file.height > 50_000_000
  )
    throw new Error('image-unavailable')
  return { url: `/link/api/files/${file.handle}?v=${file.etag.slice(1, -1)}`, width: file.width, height: file.height }
}
