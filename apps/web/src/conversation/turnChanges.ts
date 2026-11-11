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

/**
 * The watched files that may stand for what a turn changed. Watching goes on for moments after a run ends and sees every
 * writer in the folder, so once the Host has compared the turn's start and end and found nothing, they say nothing about it.
 */
export function changedOutputs(record: TurnChanges | undefined, outputs: readonly FileChange[]): readonly FileChange[] {
  return record?.state === 'settled' && record.files === 0 ? [] : outputs
}

const DOCUMENT_KINDS: ReadonlySet<string> = new Set(['pptx', 'pdf', 'docx', 'xlsx', 'csv', 'html', 'image', 'svg', 'audio', 'video'])

/** What the turn made for the person to open, as opposed to code it edited: new documents and media. */
export const producedFiles = (outputs: readonly FileChange[]) =>
  outputs.filter(file => file.change === 'created' && file.kind !== undefined && DOCUMENT_KINDS.has(file.kind))

/** Who may press 撤销本轮 or 恢复 on this device, as the Host will check it. */
export interface UndoRights {
  /** `run`: a device without it reads. */
  canRun: boolean
  /** The session opens only to be read, whatever this device may do: the Host refuses every change to it. */
  readOnly?: boolean
  /** The session runs or waits: the Host refuses every write, whatever a list read earlier says. */
  active: boolean
  /** No connection to the Host. */
  offline: boolean
}

/**
 * What a turn offers on its card and in the 改动 tab alike: 撤销本轮, 恢复, or the one sentence why neither. `someFiles`:
 * the turn as a whole cannot go back, but files still as it left them can.
 */
export type TurnUndo = { kind: 'undo' } | { kind: 'redo' } | { kind: 'why'; text: string; someFiles?: true } | { kind: 'none' }

/** The reasons the Host gives, said once for both actions; `no-changes` and `undone` leave nothing to say. */
const BLOCK_WHY: Partial<Record<UndoBlock, (word: string) => string>> = {
  running: word => `运行中不能${word}`,
  'not-settled': word => `这一轮没有正常结束，不能${word}`,
  'changed-since': word => `之后又改过这些文件，不能${word}`,
  'not-retained': word => `这些文件的内容没有留存，不能${word}`,
}

/**
 * The one judgement on taking a turn back, read by the card and the 改动 tab. It shows what the Host will check, and the
 * Host checks again: a device with `run` may undo from anywhere, so this computer is not a condition.
 */
export function turnUndo(list: ChangeList, turn: Pick<TurnChanges, 'state'> | undefined, rights: UndoRights): TurnUndo {
  const word = list.undone ? '恢复' : '撤销'
  const why = (text: string): TurnUndo => ({ kind: 'why', text })
  if (rights.offline) return why(`离线时不能${word}`)
  // The turn's state first, because `ChangeList.running` is also true of one that was interrupted.
  if (rights.active || turn?.state === 'running') return why(BLOCK_WHY.running!(word))
  if (turn?.state === 'interrupted') return why(BLOCK_WHY['not-settled']!(word))
  if (rights.readOnly) return why('这个会话只能查看')
  if (!rights.canRun) return why('这台设备只能查看')
  const availability = list.undone ? list.redo : list.undo
  if (availability?.available) return { kind: list.undone ? 'redo' : 'undo' }
  const text = availability ? BLOCK_WHY[availability.reason]?.(word) : undefined
  if (!availability || !text) return { kind: 'none' }
  return !list.undone && availability.reason === 'changed-since' ? { kind: 'why', text, someFiles: true } : why(text)
}

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

/** The file 打开改动 goes to: a deleted one has nothing to open. */
export const firstOpenable = (files: readonly SummaryFile[]): SummaryFile | undefined => files.find(file => !file.deleted)
