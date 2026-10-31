import { describe, expect, it } from 'vitest'
import { compactLines, diffLines, openedGap, previousState, splitLines, wordHighlights, wordRanges } from '../src/diff.ts'

const numbered = (count: number, change?: (index: number) => string | undefined) =>
  Array.from({ length: count }, (_, index) => change?.(index + 1) ?? `line ${index + 1}`).join('\n') + '\n'

describe('line diff', () => {
  it('splits on newlines without inventing a trailing empty line', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\r\nb')).toEqual(['a', 'b'])
  })

  it('reports no hunks for identical text', () => {
    expect(diffLines('same\n', 'same\n')).toEqual({ added: 0, removed: 0, hunks: [], gaps: [] })
  })

  it('shows a missing old text as unknown previous content, never as proof of a new file', () => {
    const diff = diffLines(undefined, 'one\ntwo\n')
    expect(diff).toMatchObject({ added: 2, removed: 0 })
    expect(diff).not.toHaveProperty('created')
    expect(diff.hunks).toEqual([
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
        lines: [
          { kind: 'add', text: 'one', newLine: 1 },
          { kind: 'add', text: 'two', newLine: 2 },
        ],
      },
    ])
  })

  it('calls a file new only when the producer reported it missing', () => {
    expect(previousState({ previous: 'none' })).toBe('none')
    expect(previousState({ previous: 'none', oldText: '' })).toBe('none')
    expect(previousState({ previous: 'unavailable' })).toBe('unavailable')
    expect(previousState({ previous: 'text', oldText: 'a' })).toBe('text')
    expect(previousState({ oldText: 'a' })).toBe('text')
    // Older data and agents that leave it out say nothing about the file.
    expect(previousState({})).toBe('unknown')
    // Contradictory reports never become a new file: shown text wins, and claimed text that is missing is unknown.
    expect(previousState({ previous: 'none', oldText: 'a' })).toBe('text')
    expect(previousState({ previous: 'unavailable', oldText: 'a' })).toBe('text')
    expect(previousState({ previous: 'text' })).toBe('unknown')
  })

  it('shows a middle edit with three lines of numbered context', () => {
    const diff = diffLines(
      numbered(20),
      numbered(20, index => (index === 10 ? 'changed 10' : undefined)),
    )
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(diff.hunks).toHaveLength(1)
    const [hunk] = diff.hunks
    expect(hunk).toMatchObject({ oldStart: 7, oldLines: 7, newStart: 7, newLines: 7 })
    expect(hunk!.lines.map(line => `${line.kind}:${line.text}`)).toEqual([
      'context:line 7',
      'context:line 8',
      'context:line 9',
      'remove:line 10',
      'add:changed 10',
      'context:line 11',
      'context:line 12',
      'context:line 13',
    ])
    expect(hunk!.lines[3]).toEqual({ kind: 'remove', text: 'line 10', oldLine: 10 })
    expect(hunk!.lines[4]).toEqual({ kind: 'add', text: 'changed 10', newLine: 10 })
  })

  it('merges nearby changes into one hunk and separates distant ones', () => {
    const near = diffLines(
      numbered(30),
      numbered(30, index => (index === 10 || index === 15 ? `x${index}` : undefined)),
    )
    expect(near.hunks).toHaveLength(1)
    const far = diffLines(
      numbered(40),
      numbered(40, index => (index === 5 || index === 30 ? `x${index}` : undefined)),
    )
    expect(far.hunks.map(hunk => [hunk.oldStart, hunk.newStart])).toEqual([
      [2, 2],
      [27, 27],
    ])
  })

  it('keeps line numbers aligned after insertions', () => {
    const diff = diffLines('a\nb\nc\n', 'a\ninserted\nb\nc\n')
    expect(diff.hunks[0]!.lines).toEqual([
      { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'add', text: 'inserted', newLine: 2 },
      { kind: 'context', text: 'b', oldLine: 2, newLine: 3 },
      { kind: 'context', text: 'c', oldLine: 3, newLine: 4 },
    ])
  })

  it('falls back to a full replacement for very large changed regions instead of an unbounded table', () => {
    const before = Array.from({ length: 1200 }, (_, index) => `a${index}`).join('\n')
    const after = Array.from({ length: 1200 }, (_, index) => `b${index}`).join('\n')
    const diff = diffLines(before, after)
    expect(diff).toMatchObject({ added: 1200, removed: 1200 })
    expect(diff.hunks).toHaveLength(1)
  })
})

describe('word ranges', () => {
  const cut = (text: string, ranges: Array<[number, number]>) => ranges.map(([start, end]) => text.slice(start, end))

  it('marks only what changed between two versions of a line', () => {
    const before = 'const value = loadKey(name)'
    const after = 'const value = loadApiKey(name, options)'
    const ranges = wordRanges(before, after)!
    expect(cut(before, ranges.before)).toEqual(['loadKey'])
    expect(cut(after, ranges.after)).toEqual(['loadApiKey', ', options'])
  })

  it('compares Chinese a character at a time and keeps a mark with its base', () => {
    const ranges = wordRanges('用户输入密钥', '用户保存密钥')!
    expect(cut('用户保存密钥', ranges.after)).toEqual(['保存'])
    const decomposed = 'the cafe\u0301 is open today'
    expect(cut(decomposed, wordRanges(decomposed, 'the café is open today')!.before)).toEqual(['cafe\u0301'])
  })

  it('gives up on a rewrite and on lines too long to compare', () => {
    expect(wordRanges('alpha beta gamma', 'one two three four')).toBeUndefined()
    expect(wordRanges('a '.repeat(500), 'b '.repeat(500))).toBeUndefined()
  })

  it('pairs removed and added lines across a block', () => {
    const { hunks } = diffLines('one two\nkeep\n', 'one three\nkeep\nnew line\n')
    const lines = hunks.flatMap(hunk => hunk.lines)
    const found = wordHighlights(lines)
    expect(found.size).toBe(2)
    const added = lines.find(line => line.text === 'one three')!
    expect(cut(added.text, found.get(added)!)).toEqual(['three'])
    expect(found.has(lines.find(line => line.text === 'new line')!)).toBe(false)
  })
})

describe('hunk gaps', () => {
  const base = numbered(60)
  const view = diffLines(
    base,
    numbered(60, index => (index === 30 ? 'changed' : undefined)),
  )

  it('accounts for every unchanged line outside the hunks', () => {
    expect(view.gaps.map(gap => [gap.before, gap.lines.length])).toEqual([
      [0, 26],
      [1, 27],
    ])
    const shown = view.hunks[0]!.lines.filter(line => line.kind !== 'add').length
    expect(view.gaps.reduce((sum, gap) => sum + gap.lines.length, 0) + shown).toBe(60)
    expect(view.gaps[0]!.lines[0]).toMatchObject({ kind: 'context', oldLine: 1, newLine: 1 })
  })

  it('opens from the side next to the change', () => {
    const [lead, tail] = view.gaps
    expect(openedGap(lead!, 1, 0)).toMatchObject({ lines: [], hidden: 26 })
    const opened = openedGap(lead!, 1, 20)
    expect([opened.lines[0]!.oldLine, opened.lines.at(-1)!.oldLine, opened.hidden]).toEqual([7, 26, 6])
    const after = openedGap(tail!, 1, 20)
    expect([after.lines[0]!.oldLine, after.lines.at(-1)!.oldLine, after.hidden]).toEqual([34, 53, 7])
    expect(openedGap(tail!, 1, 40).hidden).toBe(0)
  })
})

describe('the compact preview', () => {
  it('stops after 12 changed lines and counts the rest', () => {
    const view = diffLines(
      numbered(40),
      numbered(40, index => `changed ${index}`),
    )
    const { lines, remaining } = compactLines(view, false)
    expect(lines.filter(line => line.kind !== 'context').length).toBe(12)
    expect(remaining).toBe(80 - 12)
  })

  it('shows the first 8 lines of a new file', () => {
    const view = diffLines('', numbered(20))
    const { lines, remaining } = compactLines(view, true)
    expect(lines.map(line => line.newLine)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(remaining).toBe(12)
  })

  it('has nothing left when the change is small', () => {
    expect(compactLines(diffLines('a\n', 'b\n'), false)).toMatchObject({ remaining: 0 })
  })
})
