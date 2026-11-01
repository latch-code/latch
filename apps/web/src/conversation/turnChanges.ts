import type { ChangedFile, ChangeList, ChangeReceipt, FileChange, FileDiff, Message, TurnChanges, UndoBlock } from '@latch/protocol'
import { parseTime } from '../core/hostClock.ts'
import { appliedDiffs, type Turn } from '../conversation.ts'
import { diffLines } from '../diff.ts'

/*
 * A turn's summary card and its way to the Host's per-turn record. The record's turn is a run, and a message does not
 * name its run, so they are matched by time; a turn only gets a record when the match is unambiguous, because 撤销本轮
 * acts on what it is matched to.
 */

/** How far a run's recorded start may precede the prompt that opened it: both clocks are the Host's, and it writes them in turn. */
const START_SKEW = 2000

/** A turn's record by turn key. A turn matching no record, or several, has none. */
export function matchTurnChanges(turns: readonly Turn[], records: readonly TurnChanges[], latestRunId?: string): Map<string, TurnChanges> {
  const starts = turns.flatMap(turn => {
    const at = parseTime(turn.user?.createdAt)
    return at === undefined ? [] : [{ key: turn.key, at }]
  })
  const found = new Map<string, TurnChanges[]>()
  for (const record of records) {
    const at = parseTime(record.startedAt)
    if (at === undefined) continue
    const opened = starts.findLast(start => start.at <= at + START_SKEW)
    if (opened) found.set(opened.key, [...(found.get(opened.key) ?? []), record])
  }
  const matched = new Map<string, TurnChanges>()
  for (const [key, list] of found) if (list.length === 1) matched.set(key, list[0]!)
  // The latest turn is named outright, which settles it whatever the times say.
  const latestRecord = latestRunId === undefined ? undefined : records.find(record => record.turnId === latestRunId)
  const latestTurn = turns.at(-1)
  if (latestRecord && latestTurn) {
    for (const [key, record] of matched) if (record === latestRecord && key !== latestTurn.key) matched.delete(key)
    matched.set(latestTurn.key, latestRecord)
  }
  return matched
}

/** A file on the card: what the Host recorded, or what the turn's own edits and the watched folders say without a record. */
export interface SummaryFile {
  root?: string
  path: string
  add?: number
  del?: number
  byCommand?: boolean
  /** Gone from the folder, so there is nothing to open. */
  deleted?: boolean
}

export interface TurnSummary {
  files: SummaryFile[]
  add?: number
  del?: number
}

const fromList = (list: ChangeList): TurnSummary => ({
  files: list.files.map((file: ChangedFile) => ({
    root: file.root,
    path: file.path,
    ...(file.add !== undefined ? { add: file.add } : {}),
    ...(file.del !== undefined ? { del: file.del } : {}),
    ...(file.byCommand ? { byCommand: true } : {}),
    ...(file.status === 'D' ? { deleted: true } : {}),
  })),
  add: list.totals.add,
  del: list.totals.del,
})

/** A turn's latest word on each file it edited, as the tools recorded it; a later edit of a file replaces an earlier one. */
function editedFiles(replies: readonly Message[]): SummaryFile[] {
  const byPath = new Map<string, FileDiff[]>()
  for (const message of replies) {
    if (message.role !== 'tool') continue
    for (const diff of appliedDiffs(message)) byPath.set(diff.path, [...(byPath.get(diff.path) ?? []), diff])
  }
  return [...byPath].map(([path, diffs]) => {
    let add = 0
    let del = 0
    for (const diff of diffs) {
      const view = diffLines(diff.oldText, diff.newText)
      add += view.added
      del += view.removed
    }
    return { path, add, del }
  })
}

/** Files the turn changed: from the Host's record when there is one, else its tools' edits and the watched changes. */
export function turnSummary(turn: Turn, list: ChangeList | undefined, outputs: readonly FileChange[]): TurnSummary {
  if (list) return fromList(list)
  const edited = editedFiles(turn.replies)
  const known = new Set(edited.map(file => file.path))
  const files: SummaryFile[] = [
    ...edited,
    ...outputs
      .filter(file => !known.has(file.path))
      .map(file => ({ root: file.root, path: file.path, ...(file.change === 'deleted' ? { deleted: true } : {}) })),
  ]
  const counted = files.every(file => file.add !== undefined)
  return {
    files,
    ...(counted
      ? { add: files.reduce((sum, file) => sum + (file.add ?? 0), 0), del: files.reduce((sum, file) => sum + (file.del ?? 0), 0) }
      : {}),
  }
}

const DOCUMENT_KINDS: ReadonlySet<string> = new Set(['pptx', 'pdf', 'docx', 'xlsx', 'csv', 'html', 'image', 'svg', 'audio', 'video'])

/** What the turn made for the person to open, as opposed to code it edited: new documents and media. */
export const producedFiles = (outputs: readonly FileChange[]) =>
  outputs.filter(file => file.change === 'created' && file.kind !== undefined && DOCUMENT_KINDS.has(file.kind))

/** Why 撤销本轮 cannot run, in words; `no-changes` and `undone` draw no words because there is no card or a record line. */
const BLOCK_WORDS: Partial<Record<UndoBlock, string>> = {
  running: '运行中不能撤销',
  'not-settled': '没有结算，不能撤销',
  'changed-since': '之后又改过这些文件，不能撤销',
  'not-retained': '内容没有留存，不能撤销',
}

export const undoBlockWords = (reason: UndoBlock): string | undefined => BLOCK_WORDS[reason]

/** Files 撤销本轮 would leave alone, said before it runs: without them the undo runs at once. */
export function undoExceptions(list: ChangeList): string[] {
  return [
    ...list.files.filter(file => file.notRetained).map(file => `${file.path} · 内容没有留存`),
    ...list.files.filter(file => file.secret).map(file => `${file.path} · 可能含密钥，不写也不删`),
    ...(list.notCovered ?? []).map(path => `${path} · 在文件夹之外或被忽略`),
  ]
}

/** How many files a receipt left as they were; it names only the first of them. */
export function notRestoredLine(receipt: Pick<ChangeReceipt, 'skipped' | 'notRestored'>): string | undefined {
  if (receipt.skipped === 0) return undefined
  const named = receipt.notRestored.length
  return `这 ${receipt.skipped} 个文件没有恢复${named > 0 && named < receipt.skipped ? `（列出前 ${named} 个）` : ''}`
}

/** The file 打开变更 goes to: a deleted one has nothing to open. */
export const firstOpenable = (files: readonly SummaryFile[]): SummaryFile | undefined => files.find(file => !file.deleted)
