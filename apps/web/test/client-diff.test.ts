import { describe, expect, it } from 'vitest'
import { diffLines, previousState, splitLines } from '../src/diff.ts'

const numbered = (count: number, change?: (index: number) => string | undefined) =>
  Array.from({ length: count }, (_, index) => change?.(index + 1) ?? `line ${index + 1}`).join('\n') + '\n'

describe('line diff', () => {
  it('splits on newlines without inventing a trailing empty line', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\r\nb')).toEqual(['a', 'b'])
  })

  it('reports no hunks for identical text', () => {
    expect(diffLines('same\n', 'same\n')).toEqual({ added: 0, removed: 0, hunks: [] })
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
