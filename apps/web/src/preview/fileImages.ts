import { isFileMetadata, type FileContext } from '@latch/protocol'
import { api, fileBytes } from '../core/api.ts'
import { fileContextBody, fileRoute } from './fileContext.ts'

export type MediaKind = 'image' | 'video' | 'audio'

/** A picture, video or sound drawn from an authorized, same-origin handle. */
export interface ResolvedMedia {
  kind: MediaKind
  url: string
  width?: number
  height?: number
  /** The file's own name, for a download. */
  name?: string
  /** The Host lets this device download the file. */
  download?: boolean
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'oga', 'opus'])

/**
 * What a reference's extension suggests it is, only to decide whether asking the Host is worth it: the Host's answer,
 * from the file's own bytes, decides what is drawn.
 */
export function mediaTypeOf(reference: string): MediaKind | undefined {
  const name = reference.split(/[\\/]/u).at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return IMAGE_EXTENSIONS.has(ext) ? 'image' : VIDEO_EXTENSIONS.has(ext) ? 'video' : AUDIO_EXTENSIONS.has(ext) ? 'audio' : undefined
}

/**
 * A media URL the page may draw: a blob of this page, or a file handle of this Host (`/link/api/files/<22>`, optionally
 * bound to a version with `?v=`), or an attachment's content handle. Nothing else, whatever a resolver answers.
 */
export function trustedMediaUrl(value: string, here: string): boolean {
  if (value.length > 4096) return false
  let url: URL, page: URL
  try {
    url = new URL(value, here)
    page = new URL(here)
  } catch {
    return false
  }
  if (url.protocol === 'blob:') return url.origin === page.origin
  return (
    url.protocol === page.protocol
    && url.host === page.host
    && !url.hash
    && ((/^\/link\/api\/files\/[A-Za-z0-9_-]{22}$/u.test(url.pathname) && (!url.search || /^\?v=[a-f0-9]{32}$/u.test(url.search)))
      || (/^\/link\/api\/attachments\/[A-Za-z0-9_-]{22}\/content$/u.test(url.pathname) && !url.search))
  )
}

const dimension = (value: number | undefined) => value === undefined || (Number.isFinite(value) && value > 0 && value <= 40_000)

/** Whether a resolver's answer may be drawn: a trusted URL and sane dimensions. */
export function drawableMedia(value: ResolvedMedia, here: string): boolean {
  return (
    ['image', 'video', 'audio'].includes(value.kind)
    && trustedMediaUrl(value.url, here)
    && dimension(value.width)
    && dimension(value.height)
    && (value.kind !== 'image' || (value.width !== undefined && value.height !== undefined))
  )
}

/**
 * The Host's answer for one reference as media to draw, or why not. Only a regular file the Host would preview, that
 * may not hold a secret, whose bytes say picture, video or sound and are served with that type; a picture needs its
 * size from its header and a bounded pixel count. Anything else stays a path chip.
 */
export function mediaFromAnswer(answer: { status?: string; file?: unknown } | undefined): ResolvedMedia | undefined {
  const file = answer?.file
  if (answer?.status !== 'ok' || !isFileMetadata(file) || file.secret || !file.actions.preview || file.size > file.limit) return undefined
  const url = `/link/api/files/${file.handle}?v=${file.etag.slice(1, -1)}`
  if (file.kind === 'image') {
    if (
      !file.mime.startsWith('image/')
      || !file.width
      || !file.height
      || file.width > 40_000
      || file.height > 40_000
      || file.width * file.height > 50_000_000
    )
      return undefined
    return { kind: 'image', url, width: file.width, height: file.height, name: file.name, download: file.actions.download }
  }
  if (file.kind === 'video' && file.mime.startsWith('video/')) return { kind: 'video', url }
  if (file.kind === 'audio' && file.mime.startsWith('audio/')) return { kind: 'audio', url }
  return undefined
}

/**
 * The bytes behind a media URL the page may draw, read through the same authorized handle (a file handle bound to its
 * version, or an attachment's content handle), for a download. Anything else is refused before a request is made.
 */
export function mediaBytes(url: string, here: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (!trustedMediaUrl(url, here)) return Promise.reject(new Error('media-unavailable'))
  const { pathname, search } = new URL(url, here)
  const attachment = /^\/link\/api\/attachments\/([A-Za-z0-9_-]{22})\/content$/u.exec(pathname)
  if (attachment) return fileBytes(attachment[1]!, undefined, undefined, signal, undefined, 'attachment')
  const file = /^\/link\/api\/files\/([A-Za-z0-9_-]{22})$/u.exec(pathname)
  if (!file) return Promise.reject(new Error('media-unavailable'))
  const version = /^\?v=([a-f0-9]{32})$/u.exec(search)?.[1]
  return fileBytes(file[1]!, undefined, undefined, signal, version ? `"${version}"` : undefined)
}

/**
 * A picture's bytes, for copying or saving: a blob this page made (a draft) is read as it is; anything else only through
 * the authorized handle it is drawn from (`mediaBytes`).
 */
export async function pictureBlob(url: string, here: string, signal?: AbortSignal): Promise<Blob> {
  if (!trustedMediaUrl(url, here)) throw new Error('media-unavailable')
  if (new URL(url, here).protocol === 'blob:') return (await fetch(url, signal ? { signal } : {})).blob()
  return new Blob([await mediaBytes(url, here, signal)])
}

/** The picture as PNG, the one picture type every clipboard takes. */
export async function pngBlob(picture: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(picture)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('picture-unavailable')
    context.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('picture-unavailable'))), 'image/png')
    })
  } finally {
    bitmap.close()
  }
}

/** Resolve a reference as media through the same session authorization as a clicked file reference. */
export async function resolveFileMedia(
  scope: string | FileContext,
  reference: string,
  rootId: string | undefined,
  signal: AbortSignal,
): Promise<ResolvedMedia> {
  const context: FileContext = typeof scope === 'string' ? { kind: 'session', sessionId: scope } : scope
  const result = await api<{ files?: Array<{ status?: string; file?: unknown }> }>(fileRoute(context, 'resolve'), {
    method: 'POST',
    body: { ...fileContextBody(context), paths: [reference], ...(rootId ? { rootId } : {}) },
    signal,
  })
  const media = mediaFromAnswer(result.files?.[0])
  if (!media) throw new Error('media-unavailable')
  return media
}

/** Resolve an image through the same session authorization as a clicked file reference. */
export async function resolveFileImage(scope: string | FileContext, reference: string, rootId: string | undefined, signal: AbortSignal) {
  const media = await resolveFileMedia(scope, reference, rootId, signal)
  if (media.kind !== 'image') throw new Error('image-unavailable')
  return { url: media.url, width: media.width!, height: media.height! }
}
