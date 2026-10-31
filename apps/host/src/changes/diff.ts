// Line diffs: Myers' O(ND) algorithm with a bound on the work, unified hunks, and the text of a patch. Pure; the web
// client draws word-level ranges itself.
import type { ChangeHunk, ChangeLine, ChangeLineKind } from '@latch/protocol'

/** Above this size on either side a file is shown as one line, not as text. */
export const TEXT_LIMIT = 1024 * 1024
/** Past this many edits, or this much work, the changed middle is shown as a full replacement. */
const EDIT_LIMIT = 2000
const WORK_LIMIT = 40_000_000

export interface Text {
  /** Lines without their `\n`; a line may still end with `\r`. */
  lines: string[]
  /** The text ends with a newline, or is empty. */
  newline: boolean
}

export const EMPTY_TEXT: Text = { lines: [], newline: true }

/** UTF-8 text without NUL bytes, or undefined for anything else (binary, UTF-16, invalid UTF-8). */
export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

export function splitText(text: string): Text {
  if (text === '') return { lines: [], newline: true }
  const lines = text.split('\n')
  const newline = lines.at(-1) === ''
  if (newline) lines.pop()
  return { lines, newline }
}

export interface DiffOp {
  kind: ChangeLineKind
  /** The raw line, `\r` included. */
  text: string
  oldLine?: number
  newLine?: number
}

const EQUAL = 0,
  REMOVE = 1,
  ADD = 2

/** What a line is compared by: a last line without a newline differs from the same text with one. */
function keys(text: Text): string[] {
  return text.newline ? text.lines : text.lines.map((line, index) => (index === text.lines.length - 1 ? `${line}\u0000` : line))
}

function backtrack(trace: Int32Array[], n: number, m: number): number[] {
  const ops: number[] = []
  let x = n,
    y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d]!
    const at = (k: number) => v[k + d + 1]!
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const previousK = down ? k + 1 : k - 1
    const previousX = at(previousK)
    const startX = down ? previousX : previousX + 1
    while (x > startX) {
      ops.push(EQUAL)
      x--
      y--
    }
    ops.push(down ? ADD : REMOVE)
    x = previousX
    y = previousX - previousK
  }
  while (x > 0) {
    ops.push(EQUAL)
    x--
  }
  return ops.reverse()
}

/** The shortest edit script from `a` to `b`, or undefined when it needs more than `limit` edits. */
function myers(a: Int32Array, b: Int32Array, limit: number): number[] | undefined {
  const n = a.length,
    m = b.length,
    max = n + m,
    offset = max + 1
  const v = new Int32Array(2 * max + 3)
  // The diagonals each step reads, saved before it writes; backtracking walks them in reverse.
  const trace: Int32Array[] = []
  for (let d = 0; d <= Math.min(max, limit); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, n, m)
    }
  }
  return undefined
}

/** The edit script from `before` to `after`, removals before additions in each changed block, with line numbers. */
export function diffLines(before: Text, after: Text): DiffOp[] {
  const a = keys(before),
    b = keys(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length,
    endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const ids = new Map<string, number>()
  const tokens = (lines: string[], from: number, to: number) =>
    Int32Array.from(lines.slice(from, to), line => {
      let id = ids.get(line)
      if (id === undefined) ids.set(line, (id = ids.size))
      return id
    })
  const midA = tokens(a, start, endA),
    midB = tokens(b, start, endB)
  const middle =
    midA.length && midB.length ? myers(midA, midB, Math.min(EDIT_LIMIT, Math.floor(WORK_LIMIT / (midA.length + midB.length)))) : undefined
  const script = [
    ...Array<number>(start).fill(EQUAL),
    ...(middle ?? [...Array<number>(midA.length).fill(REMOVE), ...Array<number>(midB.length).fill(ADD)]),
    ...Array<number>(a.length - endA).fill(EQUAL),
  ]
  const ops: DiffOp[] = []
  let oldLine = 0,
    newLine = 0,
    removed: DiffOp[] = [],
    added: DiffOp[] = []
  const flush = () => {
    ops.push(...removed, ...added)
    removed = []
    added = []
  }
  for (const op of script) {
    if (op === EQUAL) {
      flush()
      oldLine++
      newLine++
      ops.push({ kind: 'context', text: before.lines[oldLine - 1]!, oldLine, newLine })
    } else if (op === REMOVE) {
      oldLine++
      removed.push({ kind: 'remove', text: before.lines[oldLine - 1]!, oldLine })
    } else {
      newLine++
      added.push({ kind: 'add', text: after.lines[newLine - 1]!, newLine })
    }
  }
  flush()
  return ops
}

export function countChanges(ops: readonly DiffOp[]): { add: number; del: number } {
  let add = 0,
    del = 0
  for (const op of ops) {
    if (op.kind === 'add') add++
    else if (op.kind === 'remove') del++
  }
  return { add, del }
}

interface Range {
  from: number
  to: number
}

/** Index ranges of `ops` that make up the hunks: each change with `context` lines around it, close ones merged. */
function hunkRanges(ops: readonly DiffOp[], context: number): Range[] {
  const ranges: Range[] = []
  let last = -1
  ops.forEach((op, index) => {
    if (op.kind === 'context') return
    const current = ranges.at(-1)
    if (current && index - last - 1 <= context * 2) current.to = Math.min(ops.length, index + context + 1)
    else ranges.push({ from: Math.max(0, index - context), to: Math.min(ops.length, index + context + 1) })
    last = index
  })
  return ranges
}

function header(slice: readonly DiffOp[], ops: readonly DiffOp[], from: number) {
  const oldLines = slice.filter(op => op.kind !== 'add').length
  const newLines = slice.filter(op => op.kind !== 'remove').length
  // A side with no lines in the hunk starts at the line before it.
  let oldBefore = 0,
    newBefore = 0
  for (let index = from - 1; index >= 0 && (oldBefore === 0 || newBefore === 0); index--) {
    const op = ops[index]!
    if (oldBefore === 0 && op.oldLine !== undefined) oldBefore = op.oldLine
    if (newBefore === 0 && op.newLine !== undefined) newBefore = op.newLine
  }
  const oldStart = oldLines ? (slice.find(op => op.oldLine !== undefined)?.oldLine ?? 0) : oldBefore
  const newStart = newLines ? (slice.find(op => op.newLine !== undefined)?.newLine ?? 0) : newBefore
  return { oldStart, oldLines, newStart, newLines }
}

/** Unified hunks with `context` lines (Infinity: the whole file), `\r` removed from the shown text. */
export function toHunks(ops: readonly DiffOp[], context = 3): ChangeHunk[] {
  return hunkRanges(ops, context).map(({ from, to }) => {
    const slice = ops.slice(from, to)
    return {
      ...header(slice, ops, from),
      lines: slice.map((op): ChangeLine => ({
        kind: op.kind,
        text: op.text.endsWith('\r') ? op.text.slice(0, -1) : op.text,
        ...(op.oldLine !== undefined ? { oldLine: op.oldLine } : {}),
        ...(op.newLine !== undefined ? { newLine: op.newLine } : {}),
      })),
    }
  })
}

const NO_NEWLINE = '\\ No newline at end of file'

/** The hunks of a patch for one file, as `git diff` writes them. */
export function patchHunks(ops: readonly DiffOp[], before: Text, after: Text, context = 3): string {
  const out: string[] = []
  const span = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`)
  for (const { from, to } of hunkRanges(ops, context)) {
    const slice = ops.slice(from, to)
    const range = header(slice, ops, from)
    out.push(`@@ -${span(range.oldStart, range.oldLines)} +${span(range.newStart, range.newLines)} @@`)
    for (const op of slice) {
      out.push(`${op.kind === 'context' ? ' ' : op.kind === 'remove' ? '-' : '+'}${op.text}`)
      const lastOld = op.oldLine !== undefined && op.oldLine === before.lines.length && !before.newline
      const lastNew = op.newLine !== undefined && op.newLine === after.lines.length && !after.newline
      if ((op.kind === 'remove' && lastOld) || (op.kind === 'add' && lastNew) || (op.kind === 'context' && lastOld && lastNew))
        out.push(NO_NEWLINE)
    }
  }
  return out.length ? `${out.join('\n')}\n` : ''
}
