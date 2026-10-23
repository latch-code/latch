import type { FileDiff } from '../shared/types.ts'

/** Line-based unified diff for tool previews. Pure and bounded; no external dependency. */
export type DiffLineKind = 'context' | 'add' | 'remove'
export interface DiffLine { kind: DiffLineKind; text: string; oldLine?: number; newLine?: number }
export interface DiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] }
export interface LineDiff { added: number; removed: number; hunks: DiffHunk[] }

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

function operations(a: string[], b: string[]): Array<{ kind: DiffLineKind; text: string }> {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const ops: Array<{ kind: DiffLineKind; text: string }> = []
  for (let index = 0; index < start; index++) ops.push({ kind: 'context', text: a[index]! })
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const m = midA.length
  const n = midB.length
  if (m * n > MAX_CELLS) {
    for (const text of midA) ops.push({ kind: 'remove', text })
    for (const text of midB) ops.push({ kind: 'add', text })
  } else {
    // Suffix LCS lengths; ties prefer removal first, as unified diffs conventionally do.
    const width = n + 1
    const table = new Uint32Array((m + 1) * width)
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        table[i * width + j] = midA[i] === midB[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (midA[i] === midB[j]) { ops.push({ kind: 'context', text: midA[i]! }); i++; j++ }
      else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) { ops.push({ kind: 'remove', text: midA[i]! }); i++ }
      else { ops.push({ kind: 'add', text: midB[j]! }); j++ }
    }
    for (; i < m; i++) ops.push({ kind: 'remove', text: midA[i]! })
    for (; j < n; j++) ops.push({ kind: 'add', text: midB[j]! })
  }
  for (let index = endA; index < a.length; index++) ops.push({ kind: 'context', text: a[index]! })
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
    if (op.kind === 'context') { oldLine++; newLine++; lines.push({ kind: 'context', text: op.text, oldLine, newLine }) }
    else if (op.kind === 'remove') { oldLine++; removed++; lines.push({ kind: 'remove', text: op.text, oldLine }) }
    else { newLine++; added++; lines.push({ kind: 'add', text: op.text, newLine }) }
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
    return { oldStart: oldLines === 0 ? origin.old : origin.old + 1, oldLines, newStart: newLines === 0 ? origin.new : origin.new + 1, newLines, lines: slice }
  })
  return { added, removed, hunks }
}
