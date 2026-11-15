// Staging by line in the 改动 tab: which changed lines are picked, how a press and the keyboard move the pick, what a
// request carries, and the few words a file or a refusal is given. The Host decides everything else.
import type {
  ChangedFile,
  ChangeHunk,
  GitCommitEntry,
  GitDeliveryState,
  GitHistory,
  GitHistoryFile,
  GitLineRange,
  GitStagingView,
  GitWholeReason,
} from '@latch/protocol'
import type { DiffLine } from '../../diff.ts'

/** A changed line of a staging diff: `old:<n>` for a removed line, `new:<n>` for an added one. */
export type LineKey = `old:${number}` | `new:${number}`

export interface ChangedLine {
  key: LineKey
  /** Which run of changed lines it belongs to: lines with nothing unchanged between them are one block. */
  block: number
}

export const keyOf = (line: Pick<DiffLine, 'kind' | 'oldLine' | 'newLine'>): LineKey | undefined =>
  line.kind === 'remove' && line.oldLine !== undefined
    ? `old:${line.oldLine}`
    : line.kind === 'add' && line.newLine !== undefined
      ? `new:${line.newLine}`
      : undefined

/** Every changed line in reading order, with its block. */
export function changedLines(hunks: readonly ChangeHunk[]): ChangedLine[] {
  const out: ChangedLine[] = []
  let block = -1,
    inBlock = false
  for (const line of hunks.flatMap(hunk => hunk.lines)) {
    const key = keyOf(line)
    if (!key) {
      inBlock = false
      continue
    }
    if (!inBlock) block++
    inBlock = true
    out.push({ key, block })
  }
  return out
}

export interface LinePick {
  lines: ReadonlySet<LineKey>
  /** The line a Shift press or Shift arrow extends from. */
  anchor?: LineKey
  /** Where the far end of the last extension is: Shift arrows move it. */
  head?: LineKey
}

export const EMPTY_PICK: LinePick = { lines: new Set() }

/** A press, or Space: the line flips, and becomes where an extension starts. */
export function toggleLine(pick: LinePick, key: LineKey): LinePick {
  const lines = new Set(pick.lines)
  if (lines.has(key)) lines.delete(key)
  else lines.add(key)
  return { lines, anchor: key, head: key }
}

/**
 * Shift with a press: every changed line from the anchor to this one joins the pick (context between them is not a
 * change and is skipped). Without an anchor it is a plain press.
 */
export function extendTo(pick: LinePick, order: readonly ChangedLine[], key: LineKey): LinePick {
  const from = order.findIndex(line => line.key === pick.anchor),
    to = order.findIndex(line => line.key === key)
  if (from < 0 || to < 0) return toggleLine(pick, key)
  const lines = new Set(pick.lines)
  // The stretch of an earlier extension from the same anchor is replaced, so Shift ↑ after Shift ↓ takes a line back.
  const before = order.findIndex(line => line.key === pick.head)
  if (before >= 0) for (const line of order.slice(Math.min(from, before), Math.max(from, before) + 1)) lines.delete(line.key)
  for (const line of order.slice(Math.min(from, to), Math.max(from, to) + 1)) lines.add(line.key)
  return { lines, anchor: pick.anchor!, head: key }
}

/** The changed line one step from `key`, for the arrow keys; itself at either end. */
function neighbour(order: readonly ChangedLine[], key: LineKey, by: 1 | -1): LineKey {
  const at = order.findIndex(line => line.key === key)
  return order[Math.max(0, Math.min(order.length - 1, at + by))]?.key ?? key
}

/** What a key does on a changed line: Space flips it, Shift with an arrow extends, an arrow alone moves. */
export function keyStep(
  pick: LinePick,
  order: readonly ChangedLine[],
  focused: LineKey,
  event: { key: string; shiftKey: boolean },
): { pick: LinePick; focus: LineKey } | undefined {
  if (event.key === ' ' || event.key === 'Spacebar') {
    return { pick: event.shiftKey && pick.anchor ? extendTo(pick, order, focused) : toggleLine(pick, focused), focus: focused }
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return undefined
  const next = neighbour(order, focused, event.key === 'ArrowDown' ? 1 : -1)
  if (!event.shiftKey) return { pick, focus: next }
  const started: LinePick = pick.anchor ? pick : { lines: new Set(pick.lines).add(focused), anchor: focused, head: focused }
  return { pick: extendTo(started, order, next), focus: next }
}

/** The whole block of a line joins the pick, or leaves it when all of it was picked. */
export function toggleBlock(pick: LinePick, order: readonly ChangedLine[], key: LineKey): LinePick {
  const block = order.find(line => line.key === key)?.block
  const keys = order.filter(line => line.block === block).map(line => line.key)
  const lines = new Set(pick.lines)
  const all = keys.every(item => lines.has(item))
  for (const item of keys) {
    if (all) lines.delete(item)
    else lines.add(item)
  }
  return { lines, anchor: key, head: key }
}

export const pickAll = (order: readonly ChangedLine[]): LinePick => ({ lines: new Set(order.map(line => line.key)) })

/** A pick against a diff read again: lines that are no longer changes drop out. */
export function keepPick(pick: LinePick, order: readonly ChangedLine[]): LinePick {
  const known = new Set(order.map(line => line.key))
  const lines = new Set([...pick.lines].filter(key => known.has(key)))
  return lines.size === pick.lines.size ? pick : { lines }
}

function ranges(numbers: number[]): GitLineRange[] {
  const out: GitLineRange[] = []
  for (const number of numbers.toSorted((a, b) => a - b)) {
    const last = out.at(-1)
    if (last && number <= last[1] + 1) last[1] = Math.max(last[1], number)
    else out.push([number, number])
  }
  return out
}

/** The pick as a request names it: line numbers only, as ranges on each side. */
export function selectionOf(pick: LinePick): { old?: GitLineRange[]; new?: GitLineRange[] } {
  const side = (name: 'old' | 'new') =>
    ranges([...pick.lines].flatMap(key => (key.startsWith(`${name}:`) ? [Number(key.slice(name.length + 1))] : [])))
  const old = side('old'),
    fresh = side('new')
  return { ...(old.length ? { old } : {}), ...(fresh.length ? { new: fresh } : {}) }
}

/** Why a file's lines cannot be picked, in a few words. */
const WHOLE_WORD: Record<GitWholeReason, string> = {
  binary: '二进制',
  large: '文件太大',
  new: '新文件',
  deleted: '已删除',
  mode: '执行位变化',
  link: '链接',
  submodule: '子模块',
  conflicted: '有冲突',
  filtered: '经过滤器',
  converted: '换行会转换',
  secret: '可能含密钥',
  unchanged: '内容相同',
}

/** What the row says for a whole file: the reason, then that it goes whole. A conflict is resolved in the terminal. */
export function wholeNote(reason: GitWholeReason, view: GitStagingView): string {
  if (reason === 'conflicted') return '有冲突 · 在终端里解决'
  return `${WHOLE_WORD[reason]} · 只能整个${view === 'unstaged' ? '暂存' : '取消暂存'}`
}

/** A refusal of a line write, in a few words; undefined for one the caller shows as it came. */
export function lineRefusal(code: string, details: Readonly<Record<string, unknown>> = {}): string | undefined {
  switch (code) {
    case 'git-file-changed':
      return details.changed === 'index'
        ? '暂存区已变 · 已重新读取'
        : details.changed === 'head'
          ? '有了新提交 · 已重新读取'
          : '文件已变 · 已重新读取'
    case 'git-selection-invalid':
      return '所选的行已变 · 已重新读取'
    case 'git-file-whole': {
      const reason = details.whole
      return typeof reason === 'string' && reason in WHOLE_WORD ? `${WHOLE_WORD[reason as GitWholeReason]} · 只能整个文件` : '只能整个文件'
    }
    case 'git-turn-running':
      return 'Agent 正在改这个文件夹'
    case 'git-busy':
      return '另一个交付操作正在进行'
    case 'git-operation-in-progress':
      return '合并进行中，在终端里完成'
    case 'host-updating':
      return '这台电脑正在安装更新'
    case 'file-scope':
      return '这台设备看不到会话文件'
    default:
      return undefined
  }
}

/** Refusals after which the diff on screen is no longer what the Host has: it is read again and the pick dropped. */
export const STALE_CODES: ReadonlySet<string> = new Set(['git-file-changed', 'git-selection-invalid', 'git-file-whole'])

/**
 * Whether a refusal of a retried request settles 「结果未知」: only one the Host gives knowing what the first attempt
 * did. It answers from that attempt's receipt (`replay`), or refuses after looking at the file and the index, which it
 * does only when no attempt of this request is open (while one is and the index cannot tell, it answers
 * `git-result-unknown`). Busy, a running turn, an update, a lost scope or a limit say nothing about the first attempt.
 */
export function retryEnds(code: string, details: Readonly<Record<string, unknown>> = {}): boolean {
  return details.replay === true || STALE_CODES.has(code)
}

export interface StagingRow {
  path: string
  status: 'A' | 'M' | 'D' | 'T'
  untracked?: true
  conflicted?: true
}

/** The files of one view, by path: 未暂存 holds modified, untracked and conflicted files; 已暂存 the index against HEAD. */
export function stagingRows(
  state: Pick<GitDeliveryState, 'staged' | 'unstaged' | 'untracked' | 'conflicted'>,
  view: GitStagingView,
): StagingRow[] {
  const rows: StagingRow[] =
    view === 'staged'
      ? state.staged.map(file => ({ path: file.path, status: file.status }))
      : [
          ...state.conflicted.map(path => ({ path, status: 'M' as const, conflicted: true as const })),
          ...state.unstaged.map(file => ({ path: file.path, status: file.status })),
          ...state.untracked.map(path => ({ path, status: 'A' as const, untracked: true as const })),
        ]
  return rows.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export const viewCounts = (state: Pick<GitDeliveryState, 'staged' | 'unstaged' | 'untracked' | 'conflicted'>) => ({
  unstaged: state.unstaged.length + state.untracked.length + state.conflicted.length,
  staged: state.staged.length,
})

// ---- history ---------------------------------------------------------------------------------------------------------

/** A history file as the diff list draws it. */
export function historyFile(root: string, file: GitHistoryFile): ChangedFile {
  return {
    root,
    path: file.path,
    status: file.status === 'T' ? 'M' : file.status,
    ...(file.add !== undefined ? { add: file.add } : {}),
    ...(file.del !== undefined ? { del: file.del } : {}),
    ...(file.binary ? { binary: true as const } : {}),
  }
}

/** What a commit list is of. */
export function historyTitle(history: Pick<GitHistory, 'range' | 'base'>): string {
  switch (history.range) {
    case 'base':
      return `离开 ${history.base ?? '主分支'} 之后的提交`
    case 'upstream':
      return '还没推送的提交'
    case 'file':
      return '改过这个文件的提交'
    default:
      return '最近的提交'
  }
}

const pad = (value: number) => String(value).padStart(2, '0')

/** A commit's row: its subject (or its short ID for a device that gets no subject), and when. */
export function commitRow(commit: GitCommitEntry): { label: string; meta: string } {
  const at = new Date(commit.at)
  const when = Number.isNaN(at.getTime()) ? '' : `${at.getMonth() + 1}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  const short = commit.sha.slice(0, 7)
  return {
    label: commit.subject ?? short,
    meta: [commit.subject ? short : '', commit.author ?? '', when, commit.merge ? '合并' : ''].filter(Boolean).join(' · '),
  }
}
