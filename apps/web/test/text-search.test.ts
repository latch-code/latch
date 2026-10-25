import { describe, expect, it } from 'vitest'
import { textMatches } from '../src/textSearch.ts'
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
})
