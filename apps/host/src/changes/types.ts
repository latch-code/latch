// The changes engine's answers, as the routes will send them. They move to @latch/protocol when the routes are wired.
import type { FileMention } from '@latch/protocol'

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
  /** Files whose content on that side was not kept (too large, or may hold a secret): left as they are. */
  skipped: number
  at: string
  replay?: true
}

export interface DiscardResult {
  restored: number
  removed: number
  skipped: number
}

/** What a discard covers: a turn's files (撤销此文件), or uncommitted changes (撤销全部改动…, or 撤销此文件 there). */
export type DiscardTarget = { scope: 'turn'; turnId: string; files: FileMention[] } | { scope: 'uncommitted'; files?: FileMention[] }

/**
 * An undo, redo or discard the engine is about to write. The caller records it in the audit log before any file
 * changes, and the engine writes nothing when that throws. Only ids, counts and a hash: never paths or content.
 */
export interface ChangeWritePlan {
  action: 'undo' | 'redo' | 'discard'
  sessionId: string
  turnId?: string
  scope?: 'turn' | 'uncommitted'
  restore: number
  remove: number
  skipped: number
  /** SHA-256 over the folders, paths and target contents. */
  planHash: string
}
