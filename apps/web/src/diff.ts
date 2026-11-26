import type { FileDiff } from '@latch/protocol'

/** Line-based unified diff for tool previews. Pure and bounded; no external dependency. */
export type DiffLineKind = 'context' | 'add' | 'remove'
export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldLine?: number
  newLine?: number
}
export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}
export interface SideBySideLine {
  before?: DiffLine
  after?: DiffLine
}

/** Pair each changed block without losing either side's order, line number or empty lines. */
export function sideBySideLines(lines: readonly DiffLine[]): SideBySideLine[] {
  const rows: SideBySideLine[] = []
  let removed: DiffLine[] = [],
    added: DiffLine[] = []
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) rows.push({ before: removed[index], after: added[index] })
    removed = []
    added = []
  }
  for (const line of lines) {
    if (line.kind === 'context') {
      flush()
      rows.push({ before: line, after: line })
    } else if (line.kind === 'remove') removed.push(line)
    else added.push(line)
  }
  flush()
  return rows
}
/** Unchanged lines outside the hunks: `before` is the hunk they lead to, or `hunks.length` for those after the last. */
export interface DiffGap {
  before: number
  lines: DiffLine[]
}
export interface LineDiff {
  added: number
  removed: number
  hunks: DiffHunk[]
  gaps: DiffGap[]
}

/**
 * What a diff says about the file before the change. `none`: the producer found no file, so it is new. `text`: the
 * previous text is included. `unavailable`: a file exists but its text is not shown (too large, binary, unreadable).
 * `unknown`: the producer did not say (older data, an agent that leaves it out), so a missing previous text never
 * proves the file is new.
 */
export type PreviousState = 'none' | 'text' | 'unavailable' | 'unknown'

export function previousState(diff: Pick<FileDiff, 'oldText' | 'previous'>): PreviousState {
  if (diff.oldText !== undefined) return diff.previous === 'none' && diff.oldText === '' ? 'none' : 'text'
  return diff.previous === 'none' || diff.previous === 'unavailable' ? diff.previous : 'unknown'
}

/** Whether the old side of the diff is known (included or known to be empty), so its line numbers mean something. */
export const knowsOldSide = (state: PreviousState) => state === 'text' || state === 'none'

/** Above this many LCS cells the changed middle is shown as a full replacement. */
const MAX_CELLS = 1_000_000

export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function compareMiddle(a: string[], b: string[]) {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const m = midA.length
  const n = midB.length
  const width = n + 1
  let table: Uint32Array | undefined
  if (m && n && m * n <= MAX_CELLS) {
    table = new Uint32Array((m + 1) * width)
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        table[i * width + j] =
          midA[i] === midB[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
      }
    }
  }
  return { start, midA, midB, table }
}

type DiffCounts = Pick<LineDiff, 'added' | 'removed'>
const countsByEdit = new WeakMap<FileDiff, DiffCounts>()

/** A folded tool row and its turn summary only need counts. Keep those with the immutable message and build hunks on opening. */
export function diffCounts(diff: FileDiff): DiffCounts {
  const known = countsByEdit.get(diff)
  if (known) return known
  const { midA, midB, table } = compareMiddle(splitLines(diff.oldText ?? ''), splitLines(diff.newText))
  const common = table?.[0] ?? 0
  const counts = { added: midB.length - common, removed: midA.length - common }
  countsByEdit.set(diff, counts)
  return counts
}

function operations(a: string[], b: string[]): Array<{ kind: DiffLineKind; text: string }> {
  const { start, midA, midB, table } = compareMiddle(a, b)
  const ops: Array<{ kind: DiffLineKind; text: string }> = []
  for (let index = 0; index < start; index++) ops.push({ kind: 'context', text: a[index]! })
  if (!table) {
    for (const text of midA) ops.push({ kind: 'remove', text })
    for (const text of midB) ops.push({ kind: 'add', text })
  } else {
    // Suffix LCS lengths; ties prefer removal first, as unified diffs conventionally do.
    const m = midA.length
    const n = midB.length
    const width = n + 1
    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        ops.push({ kind: 'context', text: midA[i]! })
        i++
        j++
      } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
        ops.push({ kind: 'remove', text: midA[i]! })
        i++
      } else {
        ops.push({ kind: 'add', text: midB[j]! })
        j++
      }
    }
    for (; i < m; i++) ops.push({ kind: 'remove', text: midA[i]! })
    for (; j < n; j++) ops.push({ kind: 'add', text: midB[j]! })
  }
  for (let index = start + midA.length; index < a.length; index++) ops.push({ kind: 'context', text: a[index]! })
  return ops
}

export function diffLines(oldText: string | undefined, newText: string, context = 3): LineDiff {
  const ops = operations(splitLines(oldText ?? ''), splitLines(newText))
  const lines: DiffLine[] = []
  const before: Array<{ old: number; new: number }> = []
  let oldLine = 0
  let newLine = 0
  let added = 0
  let removed = 0
  for (const op of ops) {
    before.push({ old: oldLine, new: newLine })
    if (op.kind === 'context') {
      oldLine++
      newLine++
      lines.push({ kind: 'context', text: op.text, oldLine, newLine })
    } else if (op.kind === 'remove') {
      oldLine++
      removed++
      lines.push({ kind: 'remove', text: op.text, oldLine })
    } else {
      newLine++
      added++
      lines.push({ kind: 'add', text: op.text, newLine })
    }
  }
  const ranges: Array<[number, number]> = []
  lines.forEach((line, index) => {
    if (line.kind === 'context') return
    const last = ranges.at(-1)
    if (last && index - last[1] - 1 <= context * 2) last[1] = index
    else ranges.push([index, index])
  })
  const hunks = ranges.map(([first, last]): DiffHunk => {
    const from = Math.max(0, first - context)
    const to = Math.min(lines.length, last + context + 1)
    const slice = lines.slice(from, to)
    const oldLines = slice.filter(line => line.kind !== 'add').length
    const newLines = slice.filter(line => line.kind !== 'remove').length
    const origin = before[from]!
    return {
      oldStart: oldLines === 0 ? origin.old : origin.old + 1,
      oldLines,
      newStart: newLines === 0 ? origin.new : origin.new + 1,
      newLines,
      lines: slice,
    }
  })
  const gaps: DiffGap[] = []
  let at = 0
  ranges.forEach(([first, last], index) => {
    const from = Math.max(0, first - context)
    if (from > at) gaps.push({ before: index, lines: lines.slice(at, from) })
    at = Math.min(lines.length, last + context + 1)
  })
  if (ranges.length > 0 && at < lines.length) gaps.push({ before: ranges.length, lines: lines.slice(at) })
  return { added, removed, hunks, gaps }
}

/**
 * What a band of unchanged lines has opened: `opened` lines next to the change it borders (the end of a gap that leads
 * to a hunk, the start of the one after the last), and how many are still folded.
 */
export function openedGap(gap: DiffGap, hunks: number, opened: number): { lines: DiffLine[]; hidden: number } {
  const count = Math.min(opened, gap.lines.length)
  return {
    lines: gap.before === hunks ? gap.lines.slice(0, count) : gap.lines.slice(gap.lines.length - count),
    hidden: gap.lines.length - count,
  }
}

/** A half-open range of UTF-16 units in a line. */
export type TextRange = [start: number, end: number]

/** Words, one CJK character at a time, runs of space, and any other code point, each with the marks that follow it. */
const WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]\p{M}*|[\p{L}\p{N}_\p{M}]+|\s+|\P{M}\p{M}*|\p{M}+/gu
/** Above this many cells a pair of lines is not worth comparing word by word. */
const MAX_WORD_CELLS = 40_000
/** Lines that share less than this are a rewrite: the whole line's tint says so, and scattered marks would only add noise. */
const MIN_SHARED = 0.4

/** The parts of two versions of a line that differ, or undefined when the lines are too long or too different to tell. */
export function wordRanges(before: string, after: string): { before: TextRange[]; after: TextRange[] } | undefined {
  const a = before.match(WORD) ?? []
  const b = after.match(WORD) ?? []
  if (a.length * b.length > MAX_WORD_CELLS) return undefined
  const width = b.length + 1
  const table = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  const out: { before: TextRange[]; after: TextRange[] } = { before: [], after: [] }
  const push = (ranges: TextRange[], start: number, end: number) => {
    const last = ranges.at(-1)
    if (last && last[1] === start) last[1] = end
    else ranges.push([start, end])
  }
  let [i, j, atA, atB, shared] = [0, 0, 0, 0, 0]
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      atA += a[i]!.length
      atB += b[j]!.length
      shared += a[i]!.length
      i++
      j++
    } else if (j >= b.length || (i < a.length && table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) {
      push(out.before, atA, atA + a[i]!.length)
      atA += a[i]!.length
      i++
    } else {
      push(out.after, atB, atB + b[j]!.length)
      atB += b[j]!.length
      j++
    }
  }
  return shared / Math.max(before.length, after.length, 1) < MIN_SHARED ? undefined : out
}

/** The changed words of each paired line in `lines`: a removed line with the added line across from it in its block. */
export function wordHighlights(lines: readonly DiffLine[]): Map<DiffLine, TextRange[]> {
  const found = new Map<DiffLine, TextRange[]>()
  for (const { before, after } of sideBySideLines(lines)) {
    if (!before || !after || before.kind !== 'remove' || after.kind !== 'add') continue
    const ranges = wordRanges(before.text, after.text)
    if (!ranges) continue
    found.set(before, ranges.before)
    found.set(after, ranges.after)
  }
  return found
}

/** A modified file's preview shows this many changed lines, a new file's this many lines. */
export const COMPACT_CHANGED = 12
export const COMPACT_NEW_FILE = 8

/** The short preview of a change, without hunk headers, and how many changed lines it leaves out. */
export function compactLines(view: LineDiff, isNewFile: boolean): { lines: DiffLine[]; remaining: number } {
  const all = view.hunks.flatMap(hunk => hunk.lines)
  if (isNewFile) return { lines: all.slice(0, COMPACT_NEW_FILE), remaining: Math.max(0, all.length - COMPACT_NEW_FILE) }
  const lines: DiffLine[] = []
  let changed = 0
  for (const line of all) {
    if (line.kind !== 'context') {
      if (changed === COMPACT_CHANGED) break
      changed++
    }
    lines.push(line)
  }
  return { lines, remaining: view.added + view.removed - changed }
}
