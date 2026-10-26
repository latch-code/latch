import { describe, expect, it } from 'vitest'
import { textMatches } from '../src/textSearch.ts'
import type { Message } from '@latch/protocol'
import { lazyOutputMatches } from '../src/components/transcriptFind.ts'
describe('message find offsets', () => {
  it('uses case-insensitive literal text, non-overlapping UTF-16 offsets, Chinese and bounded results', () => {
    expect(textMatches('你好 A.a a.a', 'a.A')).toEqual([
      { start: 3, end: 6 },
      { start: 7, end: 10 },
    ])
    expect(textMatches('😀中文中文', '中文')).toEqual([
      { start: 2, end: 4 },
      { start: 4, end: 6 },
    ])
    expect(textMatches('a'.repeat(600), 'a')).toHaveLength(500)
    expect(textMatches('abc', '')).toEqual([])
  })
  it('searches never-mounted tool output with the displayed escaping and excludes queued or unapproved work', () => {
    const messages: Message[] = [
      { id: 'prose', role: 'assistant', text: 'needle' },
      { id: 'queued', role: 'tool', state: 'queued', text: 'needle' },
      { id: 'approval', role: 'tool', state: 'awaiting-approval', text: 'needle' },
      { id: 'done', role: 'tool', state: 'completed', text: '', tool: { output: 'needle needle\u202E' } },
      { id: 'error', role: 'tool', state: 'failed', text: 'needle' },
    ]
    expect(lazyOutputMatches(messages, 'needle')).toEqual([
      { messageId: 'done', outputIndex: 0 },
      { messageId: 'done', outputIndex: 1 },
      { messageId: 'error', outputIndex: 0 },
    ])
    expect(lazyOutputMatches(messages, '\\u{202E}')).toEqual([{ messageId: 'done', outputIndex: 0 }])
    expect(lazyOutputMatches(messages, 'needle', 1)).toEqual([{ messageId: 'done', outputIndex: 0 }])
    expect(lazyOutputMatches(messages, '')).toEqual([])
  })
})
