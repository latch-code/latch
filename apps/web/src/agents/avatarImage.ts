import { useEffect, useState } from 'react'
import { AGENT_AVATAR_IMAGE, imageDimensions } from '@latch/protocol'
import { api } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'

/** The largest file a person may choose; the page makes it a small square PNG before anything is sent. */
export const AVATAR_FILE_BYTES = 10 * 1024 * 1024
/** A picture wider or taller than this is not decoded on this device at all. */
const AVATAR_SOURCE_SIDE = 8192

/** Why a chosen picture cannot be used, as the picker says it. */
export type AvatarProblem = 'too-large' | 'wrong-type' | 'unreadable'
export const AVATAR_PROBLEM_WORDS = defineCopy<Record<AvatarProblem, string>>(
  { 'too-large': '图片太大', 'wrong-type': '只能用 PNG、JPEG 或 WebP', unreadable: '读不了这张图片' },
  { 'too-large': 'Image is too large', 'wrong-type': 'Use a PNG, JPEG or WebP image', unreadable: 'Couldn’t read this image' },
)

/** The kind of picture a file is, by its first bytes alone: never its name or the type the browser reports. */
export function sniffPicture(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | undefined {
  const at = (offset: number, values: readonly number[]) =>
    bytes.length >= offset + values.length && values.every((value, index) => bytes[offset + index] === value)
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (at(0, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'webp'
  return undefined
}

/** The centre square of a picture, as the source rectangle to draw. */
export function centreSquare(width: number, height: number): { x: number; y: number; side: number } {
  const side = Math.min(width, height)
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side }
}

/**
 * The chosen picture as what is uploaded: decoded by the browser, its centre square drawn at the Host's fixed size and
 * written as a PNG, so only pixels leave this device. The Host decodes that PNG again and keeps its own copy.
 */
export async function preparePicture(file: Blob): Promise<{ picture: Blob } | { problem: AvatarProblem }> {
  if (file.size > AVATAR_FILE_BYTES) return { problem: 'too-large' }
  if (file.size === 0) return { problem: 'unreadable' }
  let bytes: Uint8Array
  try {
    // JPEG can put its dimensions after metadata, so read up to the file limit before decoding.
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch {
    return { problem: 'unreadable' }
  }
  const kind = sniffPicture(bytes)
  if (!kind) return { problem: 'wrong-type' }
  const dimensions = imageDimensions(bytes, `image/${kind}`)
  if (!dimensions) return { problem: 'unreadable' }
  if (dimensions.width > AVATAR_SOURCE_SIDE || dimensions.height > AVATAR_SOURCE_SIDE) return { problem: 'too-large' }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return { problem: 'unreadable' }
  }
  try {
    if (bitmap.width < AGENT_AVATAR_IMAGE.minSide || bitmap.height < AGENT_AVATAR_IMAGE.minSide) return { problem: 'unreadable' }
    if (bitmap.width > AVATAR_SOURCE_SIDE || bitmap.height > AVATAR_SOURCE_SIDE) return { problem: 'too-large' }
    const canvas = document.createElement('canvas')
    canvas.width = AGENT_AVATAR_IMAGE.size
    canvas.height = AGENT_AVATAR_IMAGE.size
    const context = canvas.getContext('2d')
    if (!context) return { problem: 'unreadable' }
    const { x, y, side } = centreSquare(bitmap.width, bitmap.height)
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, x, y, side, side, 0, 0, AGENT_AVATAR_IMAGE.size, AGENT_AVATAR_IMAGE.size)
    const picture = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/png')
    })
    if (!picture) return { problem: 'unreadable' }
    return picture.size > AGENT_AVATAR_IMAGE.bytes ? { problem: 'too-large' } : { picture }
  } finally {
    bitmap.close()
  }
}

const loaded = new Map<string, Promise<string | undefined>>()

/**
 * A stored picture as this page can show it: read once through the authorised route and kept as an object URL for the
 * page's life. Undefined when it cannot be read (offline, a smaller scope, gone): the face is shown then.
 */
export function avatarImageUrl(hash: string): Promise<string | undefined> {
  if (!/^[a-f0-9]{64}$/u.test(hash)) return Promise.resolve(undefined)
  let url = loaded.get(hash)
  if (!url) {
    url = api<ArrayBuffer>(`custom-agents/avatar-images/${hash}`, { response: 'bytes', timeoutMs: 30_000 }).then(
      bytes => URL.createObjectURL(new Blob([bytes], { type: 'image/png' })),
      () => {
        // Asked again the next time something shows it.
        loaded.delete(hash)
        return undefined
      },
    )
    loaded.set(hash, url)
  }
  return url
}

/** The object URL of an Agent's picture once it is read; undefined before, and whenever it cannot be. */
export function useAvatarImage(hash: string | undefined): string | undefined {
  const [shown, setShown] = useState<{ hash: string; url: string }>()
  useEffect(() => {
    if (!hash) return undefined
    let live = true
    void avatarImageUrl(hash).then(url => {
      if (live && url) setShown({ hash, url })
    })
    return () => {
      live = false
    }
  }, [hash])
  return hash !== undefined && shown?.hash === hash ? shown.url : undefined
}
