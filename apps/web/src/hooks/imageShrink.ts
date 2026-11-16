/** The Host's pixel cap for an image (docs/ATTACHMENTS.md); the capabilities report only bytes. */
export const IMAGE_PIXELS = 40_000_000
/** A sensible longest side for what a model reads; larger only costs bytes. */
const LONGEST_SIDE = 4096
/** Encodes tried before giving up. */
export const SHRINK_ATTEMPTS = 6
/** A file larger than this is not decoded on the device at all. */
export const SHRINK_INPUT_BYTES = 100 * 1024 * 1024

export type ShrinkType = 'image/jpeg' | 'image/webp' | 'image/png'

export interface ShrinkAttempt {
  width: number
  height: number
  type: ShrinkType
  /** For lossy types; PNG ignores it. */
  quality: number
}

const EXTENSIONS: Record<ShrinkType, string> = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }

/** Kinds the browser is expected to decode; anything else is tried and refused if it fails. */
export const looksLikeImage = (file: { name: string; type?: string }): boolean =>
  !!file.type?.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|heif|avif|bmp)$/iu.test(file.name)

/** Opaque pictures become JPEG; transparency keeps an alpha channel (WebP, else PNG). */
export const shrinkType = (alpha: boolean, webp: boolean): ShrinkType => (!alpha ? 'image/jpeg' : webp ? 'image/webp' : 'image/png')

/** The first encode: within the pixel cap and the longest side, never larger than the original. */
export function firstAttempt(width: number, height: number, type: ShrinkType): ShrinkAttempt {
  const scale = Math.min(1, Math.sqrt(IMAGE_PIXELS / (width * height)), LONGEST_SIDE / Math.max(width, height))
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), type, quality: 0.85 }
}

/**
 * The next encode after one that came out at `bytes`, or undefined once `attempt` (1-based) reaches the bound. Near the
 * limit a lossy encode first steps quality down to 0.65; otherwise both sides shrink by the square root of the overshoot
 * (with a margin), at least 10% and at most half per step.
 */
export function nextAttempt(previous: ShrinkAttempt, bytes: number, limit: number, attempt: number): ShrinkAttempt | undefined {
  if (attempt >= SHRINK_ATTEMPTS) return undefined
  if (previous.type !== 'image/png' && previous.quality > 0.7 && bytes <= limit * 1.4)
    return { ...previous, quality: Math.round((previous.quality - 0.1) * 100) / 100 }
  const scale = Math.min(0.9, Math.max(0.5, Math.sqrt(limit / bytes) * 0.92))
  return {
    ...previous,
    width: Math.max(1, Math.floor(previous.width * scale)),
    height: Math.max(1, Math.floor(previous.height * scale)),
  }
}

/** The original stem with the new type's extension. */
export function shrunkName(name: string, type: ShrinkType): string {
  const dot = name.lastIndexOf('.')
  return `${dot > 0 ? name.slice(0, dot) : name || 'image'}.${EXTENSIONS[type]}`
}

const ascii = (bytes: Uint8Array, at: number, text: string) => [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0))

/** Whether these bytes hold more than one frame: a GIF with several images, an APNG, or an animated WebP. */
export function animated(bytes: Uint8Array): boolean {
  if (ascii(bytes, 0, 'GIF8')) return gifFrames(bytes) > 1
  if (bytes[0] === 0x89 && ascii(bytes, 1, 'PNG')) {
    for (let at = 8; at + 8 <= bytes.length;) {
      const length = ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
      if (ascii(bytes, at + 4, 'acTL')) return true
      if (ascii(bytes, at + 4, 'IDAT')) return false
      at += 12 + length
    }
    return false
  }
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP') && ascii(bytes, 12, 'VP8X')) return ((bytes[20] ?? 0) & 0x02) !== 0
  return false
}

function gifFrames(bytes: Uint8Array): number {
  const skipBlocks = (at: number) => {
    while (at < bytes.length && bytes[at] !== 0) at += bytes[at]! + 1
    return at + 1
  }
  let at = 13
  if ((bytes[10] ?? 0) & 0x80) at += 3 * 2 ** ((bytes[10]! & 0x07) + 1)
  let frames = 0
  while (at < bytes.length) {
    const block = bytes[at]
    if (block === 0x2c) {
      if (++frames > 1) return frames
      const flags = bytes[at + 9] ?? 0
      at += 10
      if (flags & 0x80) at += 3 * 2 ** ((flags & 0x07) + 1)
      at = skipBlocks(at + 1)
    } else if (block === 0x21) at = skipBlocks(at + 2)
    else break
  }
  return frames
}

type Surface = {
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
  encode: (type: string, quality: number) => Promise<Blob | null>
}

function surface(width: number, height: number): Surface | undefined {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    return context ? { context, encode: (type, quality) => canvas.convertToBlob({ type, quality }) } : undefined
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  return context ? { context, encode: (type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality)) } : undefined
}

/** Whether any pixel is not fully opaque. */
function hasAlpha(context: Surface['context'], width: number, height: number): boolean {
  // Every pixel: a small transparent corner missed by sampling would turn black in a JPEG.
  const data = context.getImageData(0, 0, width, height).data
  for (let index = 3; index < data.length; index += 4) if (data[index]! < 255) return true
  return false
}

export class ShrinkRefusal extends Error {}

/**
 * Re-encodes an image until it is within `limit` bytes and the pixel cap, keeping orientation and transparency. Only the
 * result leaves the device; the Host still checks it as any upload. Throws `ShrinkRefusal` with the reason it cannot.
 */
export async function shrinkImage(file: File, limit: number, signal: AbortSignal, limitText: string): Promise<File> {
  const head = new Uint8Array(await file.arrayBuffer())
  signal.throwIfAborted()
  if (animated(head)) throw new ShrinkRefusal(`动图超过 ${limitText}，缩小会丢掉动画`)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new ShrinkRefusal(`超过 ${limitText}，这台设备读不了这种图片`)
  }
  try {
    signal.throwIfAborted()
    const opaqueSource = file.type === 'image/jpeg' || (head[0] === 0xff && head[1] === 0xd8)
    let attempt = firstAttempt(bitmap.width, bitmap.height, 'image/jpeg')
    let alpha: boolean | undefined
    for (let count = 1; ; count++) {
      const target = surface(attempt.width, attempt.height)
      if (!target) throw new ShrinkRefusal(`超过 ${limitText}，这台设备无法缩小图片`)
      target.context.drawImage(bitmap, 0, 0, attempt.width, attempt.height)
      if (alpha === undefined) {
        alpha = !opaqueSource && hasAlpha(target.context, attempt.width, attempt.height)
        attempt = { ...attempt, type: shrinkType(alpha, true) }
      }
      let blob = await target.encode(attempt.type, attempt.quality)
      signal.throwIfAborted()
      // A browser that cannot write WebP answers with PNG; keep the alpha that way.
      if (blob && attempt.type === 'image/webp' && blob.type !== 'image/webp') {
        attempt = { ...attempt, type: 'image/png' }
        blob = await target.encode('image/png', 1)
        signal.throwIfAborted()
      }
      if (!blob) throw new ShrinkRefusal(`超过 ${limitText}，这台设备无法缩小图片`)
      if (blob.size <= limit) return new File([blob], shrunkName(file.name, attempt.type), { type: attempt.type })
      const next = nextAttempt(attempt, blob.size, limit, count)
      if (!next) throw new ShrinkRefusal(`缩小后仍超过 ${limitText}`)
      attempt = next
    }
  } finally {
    bitmap.close()
  }
}
