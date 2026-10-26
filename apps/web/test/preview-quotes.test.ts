import { describe, expect, it } from 'vitest'
import { boundedQuoteText, quoteDraft, type FileQuote } from '../src/preview/quote.ts'
import { isFrameCommand, isFrameEvent } from '../src/preview/types.ts'
import { hasFileMention } from '../src/fileMentions.ts'

describe('explicit preview excerpts', () => {
  const file: FileQuote['file'] = {
    root: 'primary',
    path: 'notes.txt',
    name: 'notes.txt',
    size: 123,
    mtime: 1000,
    etag: '"internal-version"',
  }
  it('keeps excerpts editable and describes the parent-owned file stamp and structural location without showing a hash', () => {
    const value = quoteDraft({ contextKey: 'session:one', file, excerpt: { text: 'first\nsecond', page: 2 } }, '@primary:notes.txt')
    expect(value.text).toBe(
      '[引用 @primary:notes.txt · 第 3 页]\n> first\n> second\n（引用时文件：123 bytes，更新于 1970-01-01T00:00:01.000Z）\n',
    )
    expect(hasFileMention(value.text, { root: 'primary', path: 'notes.txt' })).toBe(true)
    expect(value.text).not.toContain('internal-version')
    expect(
      quoteDraft({ contextKey: 'one', file, excerpt: { text: 'value', cells: { sheet: '数据', start: [1, 0], end: [2, 27] } } }).marker,
    ).toBe('[引用 notes.txt · 数据!A2:AB3]')
  })
  it('bounds clipboard text, strips control characters, and never creates half of a Unicode character', () => {
    expect(boundedQuoteText(' \u0000hi\r\n\u0007there\t! ')).toBe('hi\nthere\t!')
    const clipped = boundedQuoteText('a'.repeat(1999) + '😀tail')
    expect(clipped.length).toBe(1999)
    expect(clipped).not.toMatch(/[\uD800-\uDFFF]/u)
    expect(boundedQuoteText('b'.repeat(6000))).toHaveLength(2000)
  })
  it('accepts only finite excerpt messages with an outstanding-request-shaped ID, never file paths or authority', () => {
    const id = 'a'.repeat(32)
    expect(isFrameCommand({ type: 'quote', id, source: 'selection' })).toBe(true)
    expect(isFrameEvent({ type: 'quote', id, text: 'text', page: 0 })).toBe(true)
    for (const value of [
      { type: 'quote', id, source: 'all-files' },
      { type: 'quote', id, source: 'page', path: '/private/file' },
      { type: 'quote', id: 'old', source: 'page' },
    ])
      expect(isFrameCommand(value)).toBe(false)
    for (const value of [
      { type: 'quote', id, text: 'x'.repeat(2001) },
      { type: 'quote', id, text: 'x', page: 10000 },
      { type: 'quote', id, text: 'x', page: NaN },
      { type: 'quote', id, text: 'x', handle: 'untrusted' },
      { type: 'quote', id, text: 'x', credential: 'untrusted' },
    ])
      expect(isFrameEvent(value)).toBe(false)
  })
})
