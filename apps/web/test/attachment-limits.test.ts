import { describe, expect, it } from 'vitest'
import { attachmentBlock } from '../src/composer/AttachmentDrafts.tsx'
import { ApiError } from '../src/core/api.ts'
import {
  animated,
  firstAttempt,
  IMAGE_PIXELS,
  nextAttempt,
  SHRINK_ATTEMPTS,
  SHRINK_INPUT_BYTES,
  shrinkType,
  shrunkName,
  type ShrinkAttempt,
} from '../src/hooks/imageShrink.ts'
import {
  addRefusal,
  attachmentDraftError,
  attachmentLimits,
  refusedUpload,
  shrinkLimit,
  type AttachmentDraftController,
} from '../src/hooks/useAttachments.ts'

const controller = (patch: Partial<AttachmentDraftController>) => ({ checking: false, ...patch }) as AttachmentDraftController

describe('what the attach button says before anything is uploaded', () => {
  it('states the limits of what the Harness takes over this connection', () => {
    expect(
      attachmentLimits({ images: true, text: true, textBytes: 256 * 1024, fileBytes: 10 * 1024 * 1024, imageBytes: 5 * 1024 * 1024 }),
    ).toBe('图片 5 MB 内 · 文字文件 256 KB 内 · 每条 8 个')
    expect(attachmentLimits({ images: false, text: true, textBytes: 25 * 1024 * 1024, fileBytes: 10 * 1024 * 1024 })).toBe(
      '文字文件 10 MB 内 · 每条 8 个',
    )
    expect(attachmentLimits({ images: false, text: false, textBytes: 0 })).toBe('')
    expect(attachmentLimits(undefined)).toBe('')
  })
  it('gives the Host’s reason at once, and never stays on checking once the answer came', () => {
    expect(attachmentBlock(controller({ caps: { images: true, text: false, textBytes: 0 } }))).toBeUndefined()
    expect(
      attachmentBlock(controller({ caps: { images: false, text: false, textBytes: 0, reason: '这个 Harness 不接收图片和文件。' } })),
    ).toBe('这个 Harness 不接收图片和文件。')
    expect(attachmentBlock(controller({ checking: true }))).toContain('正在确认')
    expect(attachmentBlock(controller({ checking: false }))).toBe('暂时不能添加文件。')
  })
  it('uses the connection notice for an unanswered capability read and keeps operation failures', () => {
    const unanswered = { text: '连不上这台电脑上的 Latch', noAnswer: true }
    const refused = { text: '这台设备没有会话的访问权限。', noAnswer: false }
    const uploadError = '没有收到上传确认，可以重试上传。'
    expect(attachmentDraftError('', unanswered, true)).toBe('')
    expect(attachmentDraftError('', unanswered, false)).toBe(unanswered.text)
    expect(attachmentDraftError('', refused, true)).toBe(refused.text)
    expect(attachmentDraftError(uploadError, unanswered, true)).toBe(uploadError)
  })
  it('says a Harness that takes no attachments takes none, not that a small file is too large', () => {
    const png = { name: 'a.png', size: 70 }
    expect(addRefusal(png, { images: false, text: false, textBytes: 0 })).toBe('这个 Harness 不接收附件。')
    expect(addRefusal(png, { images: false, text: false, textBytes: 0, reason: '这个 Harness 不接收图片和文件。' })).toBe(
      '这个 Harness 不接收图片和文件。',
    )
    expect(addRefusal(png, { images: true, text: false, textBytes: 0 })).toBeUndefined()
    expect(addRefusal({ name: 'big.txt', size: 2048 }, { images: false, text: true, textBytes: 1024 })).toBe(
      '「big.txt」超过 1 KB，没有添加。可以添加：文字文件 1 KB 内 · 每条 8 个。',
    )
    expect(addRefusal({ name: 'empty', size: 0 }, undefined)).toBe('空文件不能添加。')
  })
  it('offers a retry by the refusal’s code, not its status', () => {
    expect(refusedUpload(new ApiError(415, 'attachment-type-unsupported', ''))).toBe(true)
    expect(refusedUpload(new ApiError(400, 'attachment-invalid', ''))).toBe(true)
    expect(refusedUpload(new ApiError(400, 'attachment-incomplete', '附件上传中断，草稿仍保留，请重试。'))).toBe(false)
    expect(refusedUpload(new ApiError(503, 'attachments-unavailable', ''))).toBe(false)
    expect(refusedUpload(new TypeError('network'))).toBe(false)
  })
})

describe('shrinking an image over the image limit', () => {
  const caps = { images: true, text: true, textBytes: 256 * 1024, fileBytes: 10 * 1024 * 1024, imageBytes: 5 * 1024 * 1024 }
  it('shrinks an image over the image limit instead of refusing it, and leaves other files alone', () => {
    const photo = { name: 'photo.jpg', size: 12 * 1024 * 1024, type: 'image/jpeg' }
    expect(addRefusal(photo, caps)).toBeUndefined()
    expect(shrinkLimit(photo, caps)).toBe(5 * 1024 * 1024)
    expect(shrinkLimit({ ...photo, size: 4 * 1024 * 1024 }, caps)).toBeUndefined()
    expect(shrinkLimit(photo, { ...caps, images: false })).toBeUndefined()
    expect(shrinkLimit({ name: 'notes.txt', size: 12 * 1024 * 1024, type: 'text/plain' }, caps)).toBeUndefined()
    expect(shrinkLimit({ ...photo, size: SHRINK_INPUT_BYTES + 1 }, caps)).toBeUndefined()
    expect(addRefusal({ name: 'notes.txt', size: 12 * 1024 * 1024, type: 'text/plain' }, caps)).toContain('超过 5 MB')
  })
  it('fits the first encode to the pixel cap and the longest side, never enlarging', () => {
    expect(firstAttempt(12000, 9000, 'image/jpeg')).toEqual({ width: 4096, height: 3072, type: 'image/jpeg', quality: 0.85 })
    expect(firstAttempt(800, 600, 'image/png')).toEqual({ width: 800, height: 600, type: 'image/png', quality: 0.85 })
    const tall = firstAttempt(4000, 20000, 'image/webp')
    expect(tall.width * tall.height).toBeLessThanOrEqual(IMAGE_PIXELS)
    expect(Math.max(tall.width, tall.height)).toBeLessThanOrEqual(4096)
  })
  it('steps quality down near the limit, shrinks the sides otherwise, and stops after a bounded number of encodes', () => {
    const limit = 5 * 1024 * 1024
    const start = { width: 4096, height: 3072, type: 'image/jpeg' as const, quality: 0.85 }
    expect(nextAttempt(start, limit * 1.2, limit, 1)).toEqual({ ...start, quality: 0.75 })
    const smaller = nextAttempt(start, limit * 4, limit, 1)!
    expect(smaller.quality).toBe(0.85)
    expect(smaller.width).toBe(2048)
    expect(nextAttempt({ ...start, type: 'image/png' }, limit * 1.2, limit, 1)!.width).toBeLessThan(4096)
    expect(nextAttempt({ ...start, quality: 0.65 }, limit * 1.2, limit, 1)!.width).toBeLessThan(4096)
    let attempt: ShrinkAttempt | undefined = start
    let count = 1
    while ((attempt = nextAttempt(attempt, limit * 3, limit, count))) count++
    expect(count).toBe(SHRINK_ATTEMPTS)
  })
  it('keeps transparency and the name’s stem', () => {
    expect(shrinkType(false, true)).toBe('image/jpeg')
    expect(shrinkType(true, true)).toBe('image/webp')
    expect(shrinkType(true, false)).toBe('image/png')
    expect(shrunkName('IMG_0001.HEIC', 'image/jpeg')).toBe('IMG_0001.jpg')
    expect(shrunkName('a.b.png', 'image/webp')).toBe('a.b.webp')
  })
  it('tells an animation, which re-encoding would flatten, from a still image', () => {
    const gif = (frames: number) =>
      new Uint8Array([
        ...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0],
        ...Array.from({ length: frames }, () => [0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 1, 0]).flat(),
        0x3b,
      ])
    expect(animated(gif(1))).toBe(false)
    expect(animated(gif(3))).toBe(true)
    const chunk = (name: string) => [0, 0, 0, 0, ...[...name].map(char => char.charCodeAt(0)), 0, 0, 0, 0]
    const png = (...names: string[]) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, ...names.flatMap(chunk)])
    expect(animated(png('IHDR', 'acTL', 'IDAT'))).toBe(true)
    expect(animated(png('IHDR', 'IDAT'))).toBe(false)
    const webp = (flags: number) =>
      new Uint8Array(
        [...'RIFF']
          .map(c => c.charCodeAt(0))
          .concat(
            [0, 0, 0, 0],
            [...'WEBPVP8X'].map(c => c.charCodeAt(0)),
            [10, 0, 0, 0, flags],
          ),
      )
    expect(animated(webp(0x02))).toBe(true)
    expect(animated(webp(0x10))).toBe(false)
  })
})
