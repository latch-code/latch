/**
 * Pictures Codex's image tool made (`imageGeneration` thread items). Everything here is the Harness's word: the bytes
 * are only passed on when they are canonical base64 of a PNG, JPEG, GIF or WebP within the Host's picture-attachment limit.
 * Codex 0.170 makes PNG and GIF (`GeneratedImageFormat`), the Host keeps all four as picture attachments.
 */

/**
 * The Host keeps an Agent's picture as a picture attachment, which is at most 5 MiB (`ATTACHMENT_IMAGE_LIMIT` in
 * `apps/host/src/attachments.ts`): one any device draws and any model that sees images can be shown again. Codex's
 * generated images (at most 1536 px on the long side) are a few MiB.
 */
export const GENERATED_IMAGE_BYTES = 5 * 1024 * 1024
/** Pictures one turn passes on, as the runtime keeps at most 8 Agent pictures a turn. */
export const GENERATED_IMAGES_PER_TURN = 8

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u

type PictureType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
export type GeneratedImage = { data: string; mimeType: PictureType } | { refused: 'too-large' | 'invalid' }

function sniff(bytes: Buffer): PictureType | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))) return 'image/gif'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

/** A picture from base64 the Harness sent, with its type taken from its bytes, or why it is not passed on. */
export function generatedImage(base64: string): GeneratedImage {
  // Checked before decoding: a string this long cannot decode to a picture within the limit.
  if (base64.length > Math.ceil(GENERATED_IMAGE_BYTES / 3) * 4) return { refused: 'too-large' }
  if (!base64 || base64.length % 4 !== 0 || !BASE64.test(base64)) return { refused: 'invalid' }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > GENERATED_IMAGE_BYTES) return { refused: 'too-large' }
  const mimeType = sniff(bytes)
  if (!mimeType || bytes.toString('base64') !== base64) return { refused: 'invalid' }
  return { data: base64, mimeType }
}

/** Where Codex says it saved the picture: an absolute path to a PNG, JPEG, GIF or WebP file, else nothing to ask for. */
export function savedImagePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/')) return undefined
  if ([...value].some(character => character.charCodeAt(0) < 0x20)) return undefined
  return /\.(?:png|jpe?g|gif|webp)$/iu.test(value) ? value : undefined
}

/** The short line under the image tool's row when no picture is shown. */
export function generatedImageNote(reason: 'failed' | 'usage-limit' | 'too-large' | 'invalid' | 'unread' | 'count'): string {
  switch (reason) {
    case 'usage-limit':
      return '图片生成失败：已达用量上限'
    case 'failed':
      return '图片生成失败'
    case 'too-large':
      return '图片超过 5 MB，未显示'
    case 'count':
      return `本轮图片超过 ${GENERATED_IMAGES_PER_TURN} 张，未显示`
    case 'unread':
      return '未能取得生成的图片'
    case 'invalid':
      return '生成的图片格式无效，未显示'
  }
}
