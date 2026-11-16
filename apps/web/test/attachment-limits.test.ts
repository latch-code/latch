import { describe, expect, it } from 'vitest'
import { attachmentBlock } from '../src/composer/AttachmentDrafts.tsx'
import { ApiError } from '../src/core/api.ts'
import { addRefusal, attachmentLimits, refusedUpload, type AttachmentDraftController } from '../src/hooks/useAttachments.ts'

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
