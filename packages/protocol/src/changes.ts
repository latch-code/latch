// The changes routes' answers: what 变更 draws, and what 撤销本轮, 恢复 and the discards report. See docs/CHANGES.md.
import type { FileMention } from './file-refs.ts'

/**
 * `turn`: one turn's start against its end, or against now while it runs. `session`: the oldest retained turn's start
 * against now. `uncommitted`: the work tree against HEAD. `base`: the work tree against where the branch left main.
 */
export type ChangeScope = 'turn' | 'session' | 'uncommitted' | 'base'
export const CHANGE_SCOPES: readonly ChangeScope[] = ['turn', 'session', 'uncommitted', 'base']

/** Added, modified, deleted, or renamed (the same content at a new path). */
export type ChangeStatus = 'A' | 'M' | 'D' | 'R'

export interface ChangedFile {
  /** The session folder's ID. */
  root: string
  /** Relative to the folder, `/`-separated. */
  path: string
  /** R only: the path before. */
  oldPath?: string
  status: ChangeStatus
  /** Changed lines; absent when the content is not shown (binary, large, secret, not retained) or was not counted. */
  add?: number
  del?: number
  /** Turn and session scopes: part of the change came from a command, not from the agent's own edits (「由命令修改」). */
  byCommand?: true
  /** Session scope: changed between turns, by the person or another program. */
  byUser?: true
  binary?: true
  /** Over 1 MB on a side: shown as one line with 打开文件. */
  large?: true
  /** May hold a secret: listed by path only, never its content. */
  secret?: true
  /** Turn and session scopes: a side was not kept (too large, or not readable in time), so it cannot be shown or restored. */
  notRetained?: true
  /** The executable bit changed. */
  modeChanged?: true
}

export interface ChangeTotals {
  files: number
  add: number
  del: number
}

/** Why 撤销本轮 or 恢复 cannot run now. */
export type UndoBlock =
  /** A turn of the session is running. */
  | 'running'
  /** The turn has not settled (it was interrupted and is not recorded yet). */
  | 'not-settled'
  /** One of its files changed after the turn ended: 「之后又改过这些文件」. */
  | 'changed-since'
  /** The turn changed no file. */
  | 'no-changes'
  /** Undo: already undone. Redo: not undone. */
  | 'undone'
  | 'not-undone'
  /** No file of the turn can go back: each has a side that was not kept. */
  | 'not-retained'
export type Availability = { available: true } | { available: false; reason: UndoBlock }

export interface ChangeList {
  scope: ChangeScope
  /** Turn scope: the turn shown. */
  turnId?: string
  files: ChangedFile[]
  totals: ChangeTotals
  /** Turn scope: the turn is still running (or was interrupted), so its start is compared with now. */
  running?: true
  /** The record does not cover every file: a folder was too large to walk in time, or the list reached its limit. */
  partial?: true
  /** Turn scope: the turn's changes were undone (「已撤销本轮改动 · 恢复」). */
  undone?: true
  /** Turn scope: whether 撤销本轮 and 恢复 can run now. */
  undo?: Availability
  redo?: Availability
  /** Turn scope: files the turn's own edits name that no snapshot covers, so no undo reaches them. */
  notCovered?: string[]
  /** Base scope: the branch compared against. */
  base?: string
  /** Git scopes: folders that are not the top of a Git work tree, so they have no such changes. */
  notGit?: string[]
  /** Why the scope has nothing to show. */
  unavailable?: ChangeUnavailable
}
export type ChangeUnavailable =
  /** Turn and session scopes: no turn of this session was recorded. */
  | 'no-turns'
  /** No session folder is the top of a Git work tree. */
  | 'not-git'
  /** Git is not installed where the Host looks for it. */
  | 'git-missing'
  /** Git did not answer in time or reported an error. */
  | 'git-failed'
  /** The repository has no commit yet. */
  | 'no-head'
  /** Base scope: HEAD is not on a branch, is on main itself, or there is no main to compare with. */
  | 'no-base'

export type ChangeLineKind = 'context' | 'add' | 'remove'
export interface ChangeLine {
  kind: ChangeLineKind
  text: string
  oldLine?: number
  newLine?: number
  /** Turn scope: this added or removed line came from a command, not from the agent's own edits. */
  byCommand?: true
}
export interface ChangeHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: ChangeLine[]
}

export interface FileChangeDetail {
  scope: ChangeScope
  turnId?: string
  file: ChangedFile
  /** Absent when the content is not shown: binary, large, secret or not retained. */
  hunks?: ChangeHunk[]
}

export interface ChangePatch {
  scope: ChangeScope
  turnId?: string
  /** A unified diff `git apply` accepts; paths carry the folder ID first when the session has several folders. */
  text: string
  files: number
  /** Files left out: binary, large, secret or not retained. */
  omitted: number
  /** The patch reached its size limit; later files are missing. */
  truncated?: true
}

export interface TurnChanges {
  turnId: string
  startedAt: string
  settledAt?: string
  state: 'running' | 'settled' | 'interrupted'
  /** Files the turn changed; unknown until it settles. */
  files?: number
  undone?: true
  /** An undo or redo of this turn is still to be told to the engine, with the next message. */
  notePending?: true
}

/** A file an undo, redo or discard left as it was, and why. */
export interface NotRestoredFile extends FileMention {
  /** `not-retained`: its content was not kept. `secret`: it may hold a secret, so it is neither written nor removed. `folder-missing`: its folder is gone. */
  reason: 'not-retained' | 'secret' | 'folder-missing'
}

/** What 撤销本轮 or 恢复 did; a retry with the same `requestId` gets the same receipt with `replay`. */
export interface ChangeReceipt {
  sessionId: string
  turnId: string
  requestId: string
  action: 'undo' | 'redo'
  /** Files written back. */
  restored: number
  /** Files removed because the other side had none. */
  removed: number
  /** Files left as they are; `notRestored` names the first of them. */
  skipped: number
  notRestored: NotRestoredFile[]
  /** Files the turn's own edits name that no snapshot covers (outside the session's folders, or ignored): never restored. */
  notCovered: string[]
  /** The next message tells the engine, whose memory of the turn is not undone (「下一条消息会告诉 Codex」). */
  noteNextTurn: boolean
  at: string
  replay?: true
}

export interface DiscardResult {
  restored: number
  removed: number
  skipped: number
  notRestored: NotRestoredFile[]
  noteNextTurn: boolean
}

/**
 * What discarding uncommitted changes would do, for the confirmation it needs: nothing brings the files back. The
 * confirmed request carries `planHash`, and is refused once the files no longer match it.
 */
export interface DiscardPreview {
  restore: number
  remove: number
  skipped: number
  planHash: string
  /** The files it would delete, the first of them. */
  removes: FileMention[]
  notRestored: NotRestoredFile[]
  /** The sentence the confirmation shows: it says what is deleted, and that this cannot be undone. */
  warning: string
}

/** Opens the note a message carries after an undo, so the conversation and the engine read the same words. */
export const CHANGE_NOTE_PREFIX = '[Latch] '

/** Splits the note an undo added from what the person wrote. */
export function splitChangeNote(text: string): { note?: string; text: string } {
  if (!text.startsWith(CHANGE_NOTE_PREFIX)) return { text }
  const end = text.indexOf('\n\n')
  return end < 0 ? { note: text, text: '' } : { note: text.slice(0, end), text: text.slice(end + 2) }
}
