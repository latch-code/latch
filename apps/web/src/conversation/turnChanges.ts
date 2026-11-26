import type { ChangedFile, ChangeList, ChangeReceipt, FileChange, Message, TurnChanges, UndoBlock } from '@latch/protocol'
import { parseTime } from '../core/hostClock.ts'
import { appliedDiffs, type Turn } from '../conversation.ts'
import { diffCounts } from '../diff.ts'
import { BLOCKED_COPY, TURN_CHANGES_COPY } from './turnChanges.copy.ts'

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

/** The edits this turn's tools reported, counted together for each path. */
function editedFiles(replies: readonly Message[]): SummaryFile[] {
  const byPath = new Map<string, { path: string; add: number; del: number }>()
  for (const message of replies) {
    if (message.role !== 'tool') continue
    for (const diff of appliedDiffs(message)) {
      const file = byPath.get(diff.path) ?? { path: diff.path, add: 0, del: 0 }
      const counts = diffCounts(diff)
      file.add += counts.added
      file.del += counts.removed
      byPath.set(diff.path, file)
    }
  }
  return [...byPath.values()]
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

/** The reasons the Host gives, said for each action; `no-changes` and `undone` leave nothing to say. */
const BLOCK_WHY: Partial<Record<UndoBlock, 'running' | 'notSettled' | 'changedSince' | 'notRetained'>> = {
  running: 'running',
  'not-settled': 'notSettled',
  'changed-since': 'changedSince',
  'not-retained': 'notRetained',
}

/**
 * The one judgement on taking a turn back, read by the card and the 改动 tab. It shows what the Host will check, and the
 * Host checks again: a device with `run` may undo from anywhere, so this computer is not a condition.
 */
export function turnUndo(list: ChangeList, turn: Pick<TurnChanges, 'state'> | undefined, rights: UndoRights): TurnUndo {
  const words = list.undone ? BLOCKED_COPY.redo : BLOCKED_COPY.undo
  const why = (text: string): TurnUndo => ({ kind: 'why', text })
  if (rights.offline) return why(words.offline)
  // The turn's state first, because `ChangeList.running` is also true of one that was interrupted.
  if (rights.active || turn?.state === 'running') return why(words.running)
  if (turn?.state === 'interrupted') return why(words.notSettled)
  if (rights.readOnly) return why(TURN_CHANGES_COPY.sessionReadOnly)
  if (!rights.canRun) return why(TURN_CHANGES_COPY.deviceReadOnly)
  const availability = list.undone ? list.redo : list.undo
  if (availability?.available) return { kind: list.undone ? 'redo' : 'undo' }
  const reason = availability ? BLOCK_WHY[availability.reason] : undefined
  if (!availability || !reason) return { kind: 'none' }
  const text = words[reason]
  return !list.undone && availability.reason === 'changed-since' ? { kind: 'why', text, someFiles: true } : why(text)
}

/** Files 撤销本轮 would leave alone, said before it runs: without them the undo runs at once. */
export function undoExceptions(list: ChangeList): string[] {
  return [
    ...list.files.filter(file => file.notRetained).map(file => TURN_CHANGES_COPY.notRetainedFile(file.path)),
    ...list.files.filter(file => file.secret).map(file => TURN_CHANGES_COPY.secretFile(file.path)),
    ...(list.notCovered ?? []).map(path => TURN_CHANGES_COPY.notCoveredFile(path)),
  ]
}

/** How many files a receipt left as they were; it names only the first of them. */
export function notRestoredLine(receipt: Pick<ChangeReceipt, 'skipped' | 'notRestored'>): string | undefined {
  if (receipt.skipped === 0) return undefined
  const named = receipt.notRestored.length
  return named > 0 && named < receipt.skipped
    ? TURN_CHANGES_COPY.notRestoredNamed(receipt.skipped, named)
    : TURN_CHANGES_COPY.notRestored(receipt.skipped)
}

/** The file 打开改动 goes to: a deleted one has nothing to open. */
export const firstOpenable = (files: readonly SummaryFile[]): SummaryFile | undefined => files.find(file => !file.deleted)
