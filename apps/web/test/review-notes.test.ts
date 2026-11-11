import { describe, expect, it } from 'vitest'
import type { ChangeHunk, ReviewNote } from '@latch/protocol'
import type { DiffLine } from '../src/diff.ts'
import { reviewOf } from '../src/panel/changes/model.ts'
import {
  inSelection,
  noted,
  noteTally,
  notesUnder,
  placeNotes,
  selectLine,
  snippetOf,
  stepSelection,
  textLines,
} from '../src/panel/changes/notes.ts'

const add = (newLine: number, text = `line ${newLine}`): DiffLine => ({ kind: 'add', text, newLine })
const remove = (oldLine: number, text = `old ${oldLine}`): DiffLine => ({ kind: 'remove', text, oldLine })
const same = (oldLine: number, newLine: number, text = `same ${newLine}`): DiffLine => ({ kind: 'context', text, oldLine, newLine })

const note = (id: string, extra: Partial<ReviewNote> = {}): ReviewNote => ({
  id,
  root: 'default',
  path: 'a.ts',
  range: { start: 2, end: 3 },
  side: 'new',
  anchor: { scope: 'turn', linesHash: '0'.repeat(64), lines: ['const total = sum(rows)', 'return total'] },
  text: '改这里',
  status: 'pending',
  createdBy: { deviceId: 'd', name: 'Mac' },
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
  ...extra,
})

describe('selecting lines', () => {
  it('starts on the side of the line pressed and extends from where it started', () => {
    const first = selectLine(undefined, add(42), false)
    expect(first).toEqual({ side: 'new', start: 42, end: 42, anchor: 42 })
    expect(selectLine(first, add(45), true)).toEqual({ side: 'new', start: 42, end: 45, anchor: 42 })
    expect(selectLine(first, same(30, 40), true)).toEqual({ side: 'new', start: 40, end: 42, anchor: 42 })
    // A removed line is not on the new side: the press starts over on its own side.
    expect(selectLine(first, remove(7), true)).toEqual({ side: 'old', start: 7, end: 7, anchor: 7 })
    expect(selectLine(first, add(50), false)).toEqual({ side: 'new', start: 50, end: 50, anchor: 50 })
  })

  it('never spans more lines than a note keeps', () => {
    const first = selectLine(undefined, add(1), false)
    expect(selectLine(first, add(500), true)).toEqual({ side: 'new', start: 1, end: 100, anchor: 1 })
  })

  it('moves the free end one line per Shift arrow, within the file', () => {
    const one = { side: 'new' as const, start: 5, end: 5, anchor: 5 }
    expect(stepSelection(one, 1, 10)).toEqual({ ...one, end: 6 })
    expect(stepSelection(stepSelection(one, 1, 10), -1, 10)).toEqual(one)
    expect(stepSelection(one, -1, 10)).toEqual({ ...one, start: 4 })
    expect(stepSelection({ ...one, start: 10, end: 10, anchor: 10 }, 1, 10)).toEqual({ ...one, start: 10, end: 10, anchor: 10 })
  })

  it('marks the lines inside, on its side only', () => {
    const selection = { side: 'new' as const, start: 2, end: 3, anchor: 2 }
    expect(inSelection(selection, add(2))).toBe(true)
    expect(inSelection(selection, same(9, 3))).toBe(true)
    expect(inSelection(selection, remove(2))).toBe(false)
    expect(inSelection(selection, add(4))).toBe(false)
  })

  it('keeps the selected lines, cut like the Host cuts them', () => {
    expect(snippetOf(textLines('a\nb\nc\n'), { start: 2, end: 3 })).toEqual(['b', 'c'])
    expect(snippetOf(['x'.repeat(1200)], { start: 1, end: 1 })[0]).toHaveLength(1000)
    expect(textLines('')).toEqual([])
  })
})

describe('placing notes', () => {
  const newText = 'import a\nconst total = sum(rows)\nreturn total\n'

  it('puts a note under the last line of its place, and keeps the lines it covers marked', () => {
    const placed = placeNotes([note('n1')], '', newText)
    expect(notesUnder(placed, add(3, 'return total')).map(item => item.id)).toEqual(['n1'])
    expect(notesUnder(placed, add(2))).toEqual([])
    expect(noted(placed, [note('n1')], add(2))).toBe(true)
    expect(noted(placed, [note('n1')], add(1))).toBe(false)
  })

  it('follows moved lines and sets apart a note whose lines are gone', () => {
    const moved = placeNotes([note('n1')], '', `// new header\n${newText}`)
    expect(moved.located.get('n1')).toEqual({ state: 'moved', start: 3, end: 4 })
    const gone = placeNotes([note('n1')], '', 'import a\nconst total = add(rows)\nreturn total\n')
    expect(gone.stale.map(item => item.id)).toEqual(['n1'])
    expect(gone.under.size).toBe(0)
  })

  it('reads an old-side note on the old text', () => {
    const old = note('n2', {
      side: 'old',
      range: { start: 1, end: 1 },
      anchor: { scope: 'turn', linesHash: '', lines: ['removed line here'] },
    })
    const placed = placeNotes([old], 'removed line here\n', 'kept\n')
    expect(notesUnder(placed, remove(1, 'removed line here')).map(item => item.id)).toEqual(['n2'])
  })
})

describe('the review around notes', () => {
  it('keeps a noted unchanged line in view instead of folding it into a band', () => {
    const lines: ChangeHunk['lines'] = Array.from({ length: 20 }, (_, index) => ({
      kind: 'context' as const,
      text: `l${index + 1}`,
      oldLine: index + 1,
      newLine: index + 1,
    }))
    lines.push({ kind: 'add', text: 'new', newLine: 21 })
    const hunks: ChangeHunk[] = [{ oldStart: 1, oldLines: 20, newStart: 1, newLines: 21, lines }]
    const shown = (keep?: (line: DiffLine) => boolean) =>
      reviewOf(hunks, keep).view.hunks.flatMap(hunk => hunk.lines.map(line => line.newLine))
    expect(shown()).not.toContain(5)
    expect(shown(line => line.newLine === 5)).toContain(5)
  })
})

describe('the foot', () => {
  it('counts what waits to be sent apart from what is on its way and what is left to review', () => {
    const tally = noteTally([
      note('a'),
      note('b', { sending: true }),
      note('c', { status: 'sent', messageId: 'm' }),
      note('d', { status: 'agent-claimed', messageId: 'm' }),
      note('e', { status: 'reviewed', messageId: 'm' }),
    ])
    expect(tally.ready.map(item => item.id)).toEqual(['a'])
    expect(tally.sending.map(item => item.id)).toEqual(['b'])
    expect(tally.sent).toBe(1)
    expect(tally.toReview).toBe(2)
    expect(tally.queued).toBe(0)
  })

  it('counts a note in the queue apart until its message goes out', () => {
    const queued = note('q', { sending: true, queueId: 'queue-1' })
    expect(noteTally([queued])).toMatchObject({ ready: [], sending: [], queued: 1, sent: 0, toReview: 0 })
    expect(noteTally([note('q', { status: 'sent', messageId: 'm' })])).toMatchObject({ sent: 1, queued: 0 })
  })
})
