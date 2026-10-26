import { isFileMetadata, type FileContext } from '@latch/protocol'
import { api } from '../core/api.ts'
import { fileContextBody, fileRoute } from './fileContext.ts'

/** Resolve an image through the same session authorization as a clicked file reference. */
export async function resolveFileImage(scope: string | FileContext, reference: string, rootId: string | undefined, signal: AbortSignal) {
  const context: FileContext = typeof scope === 'string' ? { kind: 'session', sessionId: scope } : scope
  const result = await api<{ files?: Array<{ status?: string; file?: unknown }> }>(fileRoute(context, 'resolve'), {
    method: 'POST',
    body: { ...fileContextBody(context), paths: [reference], ...(rootId ? { rootId } : {}) },
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
