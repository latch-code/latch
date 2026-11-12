import { describe, expect, it } from 'vitest'
import { attachmentBlock } from '../src/composer/AttachmentDrafts.tsx'
import { ApiError } from '../src/core/api.ts'
import { attachmentLimits, refusedUpload, type AttachmentDraftController } from '../src/hooks/useAttachments.ts'

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
  it('offers a retry by the refusal’s code, not its status', () => {
    expect(refusedUpload(new ApiError(415, 'attachment-type-unsupported', ''))).toBe(true)
    expect(refusedUpload(new ApiError(400, 'attachment-invalid', ''))).toBe(true)
    expect(refusedUpload(new ApiError(400, 'attachment-incomplete', '附件上传中断，草稿仍保留，请重试。'))).toBe(false)
    expect(refusedUpload(new ApiError(503, 'attachments-unavailable', ''))).toBe(false)
    expect(refusedUpload(new TypeError('network'))).toBe(false)
  })
})
