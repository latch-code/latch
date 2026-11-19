import { describe, expect, it } from 'vitest'
import type { AttachmentCapabilities } from '@latch/protocol'
import { durationText, nameParts, tileType } from '../src/components/AttachmentTile.tsx'
import { addRefusal, attachmentLimits, deliveryHint } from '../src/hooks/useAttachments.ts'

const MB = 1024 * 1024
/** Codex and pi, once started: pictures natively, everything else by its path. */
const codex: AttachmentCapabilities = {
  images: true,
  text: false,
  textBytes: 256 * 1024,
  files: true,
  fileBytes: 10 * MB,
  imageBytes: 5 * MB,
}

describe('every file goes, and the composer says how only when it is not native', () => {
  it('adds any type and refuses only what is too large for this connection', () => {
    for (const name of ['a.pdf', 'a.mp4', 'a.mov', 'a.mp3', 'a.zip', 'a.docx', 'a.HEIC', 'a.bin'])
      expect(addRefusal({ name, size: 2048 }, codex)).toBeUndefined()
    expect(addRefusal({ name: 'big.bin', size: 20 * MB }, codex)).toBe(
      '「big.bin」超过 10 MB，没有添加。可以添加：每个文件 10 MB 内 · 每条 8 个。',
    )
    expect(attachmentLimits(codex)).toBe('每个文件 10 MB 内 · 每条 8 个')
    // An agent not started yet takes files too.
    expect(
      addRefusal({ name: 'a.png', size: 70 }, { images: false, text: false, textBytes: 0, files: true, pending: true }),
    ).toBeUndefined()
  })
  it('hints “as a file” on hover only for what goes by its path', () => {
    expect(deliveryHint({ kind: 'image', size: 10 }, codex)).toBeUndefined()
    expect(deliveryHint({ kind: 'text', size: 10 }, codex)).toBe('以文件交给 Agent')
    expect(deliveryHint({ kind: 'file', size: 10 }, codex)).toBe('以文件交给 Agent')
    expect(deliveryHint({ kind: 'image', size: 10 }, { ...codex, images: false })).toBe('以文件交给 Agent')
    expect(deliveryHint({ kind: 'text', size: 300 * 1024 }, { ...codex, text: true })).toBe('以文件交给 Agent')
    expect(deliveryHint({ kind: 'text', size: 10 }, { ...codex, text: true })).toBeUndefined()
    // An agent lets a client upload larger text; past 256 KiB it is still read from the file.
    expect(deliveryHint({ kind: 'text', size: 300 * 1024 }, { ...codex, text: true, textBytes: 25 * MB })).toBe('以文件交给 Agent')
    // Not known before the agent starts, nor on an older Host: nothing said.
    expect(deliveryHint({ kind: 'file', size: 10 }, { ...codex, pending: true })).toBeUndefined()
    expect(deliveryHint({ kind: 'file', size: 10 }, { images: true, text: true, textBytes: 1 })).toBeUndefined()
    expect(deliveryHint(undefined, codex)).toBeUndefined()
  })
})

describe('what a tile shows', () => {
  it('draws media a browser decodes and types the rest, by the Host’s kind before the name', () => {
    expect(tileType({ name: 'a.png', kind: 'image', mime: 'image/png' })).toBe('image')
    expect(tileType({ name: 'a.heic', kind: 'file', mime: 'image/heic' })).toBe('file')
    expect(tileType({ name: 'a.mov', kind: 'file', mime: 'video/quicktime' })).toBe('video')
    expect(tileType({ name: 'a.m4a', kind: 'file', mime: 'audio/mp4' })).toBe('audio')
    expect(tileType({ name: 'a.pdf', kind: 'file', mime: 'application/pdf' })).toBe('pdf')
    expect(tileType({ name: 'a.zip', kind: 'file', mime: 'application/zip' })).toBe('archive')
    expect(tileType({ name: 'a.xlsx', kind: 'file', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).toBe(
      'sheet',
    )
    expect(tileType({ name: 'a.csv', kind: 'text', mime: 'text/plain' })).toBe('sheet')
    expect(tileType({ name: 'notes.md', kind: 'text', mime: 'text/plain' })).toBe('text')
    // A browser calls .ts MPEG-TS video: it is source.
    expect(tileType({ name: 'main.ts', mime: 'video/mp2t' })).toBe('code')
    expect(tileType({ name: 'a.bin', kind: 'file', mime: 'application/octet-stream' })).toBe('file')
  })
  it('cuts a long name in its middle and keeps its end, and says a length as a clock', () => {
    expect(nameParts('季度报告-2026 年第三季度经营分析（最终版本）.pdf')).toEqual({
      head: '季度报告-2026 年第三季度经营分析（最终版',
      tail: '本）.pdf',
    })
    expect(nameParts('a.png')).toEqual({ head: 'a.png', tail: '' })
    expect(durationText(2.4)).toBe('0:02')
    expect(durationText(3723)).toBe('1:02:03')
  })
})
