import { describe, expect, it } from 'vitest'
import { diffLines, sideBySideLines } from '../src/diff.ts'

describe('code review side-by-side alignment', () => {
  it('aligns replacements and uneven edits while retaining real line numbers and blank lines', () => {
    const lines = diffLines('keep\nold one\nold two\n\nend\n', 'keep\nnew\n\nend\nextra\n').hunks.flatMap(hunk => hunk.lines)
    const rows = sideBySideLines(lines)
    expect(rows.map(row => [row.before?.text, row.after?.text])).toEqual([
      ['keep', 'keep'],
      ['old one', 'new'],
      ['old two', undefined],
      ['', ''],
      ['end', 'end'],
      [undefined, 'extra'],
    ])
    expect(rows[2]?.before?.oldLine).toBe(3)
    expect(rows[3]?.after?.newLine).toBe(3)
    expect(rows[5]?.after?.newLine).toBe(5)
  })
  it('preserves each original stream across insertions, deletions, empty files and reordered blocks', () => {
    const variants = ['', 'a\n', 'a\n\nb\n', 'b\na\n', 'x\ny\nz\n', 'a\nx\nb\ny\n']
    for (const before of variants)
      for (const after of variants) {
        for (const hunk of diffLines(before, after).hunks) {
          const rows = sideBySideLines(hunk.lines)
          expect(rows.flatMap(row => (row.before ? [row.before] : []))).toEqual(hunk.lines.filter(line => line.kind !== 'add'))
          expect(rows.flatMap(row => (row.after ? [row.after] : []))).toEqual(hunk.lines.filter(line => line.kind !== 'remove'))
        }
      }
  })
})
