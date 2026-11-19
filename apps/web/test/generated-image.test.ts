import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AttachmentRef, Message } from '@latch/protocol'
import { GeneratedImage } from '../src/components/GeneratedImage.tsx'

const row = (extra: Partial<Message> = {}): Message => ({
  id: 'tool:1:ig_1',
  role: 'tool',
  text: '生成图片',
  state: 'running',
  createdAt: new Date(Date.now() - 12_000).toISOString(),
  startedAt: new Date(Date.now() - 12_000).toISOString(),
  ...extra,
  tool: { kind: 'other', title: '生成图片', imageGeneration: true, ...extra.tool },
})
const picture: AttachmentRef = {
  id: 'abcdefghijklmnopqrstuv',
  name: 'Agent-image.png',
  mime: 'image/png',
  kind: 'image',
  size: 2048,
  sha256: 'b'.repeat(64),
  width: 1536,
  height: 1024,
}
const html = (message: Message, frozen = false) => renderToStaticMarkup(createElement(GeneratedImage, { message, frozen }))

describe('the image tool where its picture goes', () => {
  it('is a quiet square canvas with the particles, its label and the time taken while the picture is made', () => {
    const shown = html(row())
    expect(shown).toContain('class="generated-image"')
    expect(shown).toContain('data-state="making"')
    expect(shown).toContain('class="generated-image-canvas"')
    expect(shown).toContain('role="status"')
    expect(shown).toContain('max-width:min(100%, 480px)')
    expect(shown).toContain('aspect-ratio:1024 / 1024')
    // The page's own particle layer, gathered in the canvas and never read out.
    expect(shown).toMatch(/<canvas class="ui-backdrop" data-kind="field" aria-hidden="true">/u)
    expect(shown).toContain('生成图片')
    expect(shown).toContain('ui-shimmer')
    // The time is shown, but kept out of the live region so it is not announced every second.
    expect(shown).toContain('<span class="process-time" aria-hidden="true">12 秒</span>')
    expect(shown).not.toContain('<img')
  })

  it('stands still while the connection is down: its label is plain words', () => {
    const shown = html(row(), true)
    expect(shown).toContain('class="generated-image-canvas"')
    expect(shown).not.toContain('ui-shimmer')
  })

  it('is the picture, with no canvas and no row, when it is read after the picture came', () => {
    const shown = html(row({ state: 'completed', completedAt: new Date().toISOString(), attachments: [picture] }))
    expect(shown).toContain('data-state="drawn"')
    expect(shown).toContain('class="message-attachments"')
    expect(shown).not.toContain('generated-image-canvas')
    expect(shown).not.toContain('data-covered')
  })

  it('is one failed line with the Harness’s words when the picture was not made, and no empty box', () => {
    const failed = html(row({ state: 'failed', tool: { output: '图片生成失败：已达用量上限' } }))
    expect(failed).toMatch(/^<p class="generated-image-line is-failed"/u)
    expect(failed).toContain('图片生成失败：已达用量上限')
    expect(failed).not.toContain('generated-image-canvas')
    const refused = html(row({ state: 'completed', tool: { output: '图片超过 5 MB，未显示' } }))
    expect(refused).toMatch(/^<p class="generated-image-line is-failed"/u)
    expect(refused).toContain('图片超过 5 MB，未显示')
    expect(html(row({ state: 'failed', tool: {} }))).toContain('图片生成失败')
  })

  it('ends quietly when its turn stopped first, or when it was read back with no picture', () => {
    const stopped = html(row({ state: 'cancelled', tool: { output: '图片未生成' } }))
    expect(stopped).toMatch(/^<p class="generated-image-line"/u)
    expect(stopped).toContain('图片未生成')
    const bare = html(row({ state: 'completed' }))
    expect(bare).toMatch(/^<p class="generated-image-line"/u)
    expect(bare).toContain('生成图片')
  })
})
