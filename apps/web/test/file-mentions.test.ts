import { describe, expect, it } from 'vitest'
import { hasFileMention, mentionRange } from '../src/fileMentions.ts'
import { activeFileMention } from '../src/hooks/useFileMentions.tsx'
describe('explicit file markers', () => {
  const ref = { root: 'web', path: 'report.txt' }
  it('drops edited prefixes and recognizes a complete selected marker at whitespace boundaries', () => {
    expect(hasFileMention('please @web:report.txt now', ref)).toBe(true)
    expect(hasFileMention('@web:report.txt.backup', ref)).toBe(false)
    expect(hasFileMention('user@web:report.txt', ref)).toBe(false)
    expect(mentionRange('  @web:report.txt\n', ref)).toEqual({ start: 2, end: 17 })
  })
  it('keeps spaces in selected paths, and never opens the file chooser for an email', () => {
    expect(hasFileMention('@web:meeting notes.txt ', { root: 'web', path: 'meeting notes.txt' })).toBe(true)
    expect(activeFileMention('user@example.com', 16)).toBeUndefined()
    expect(activeFileMention('look @rep later', 9)).toEqual({ start: 5, end: 9, query: 'rep' })
  })
})
