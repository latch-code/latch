import type { RunLive, TaskSummary } from './sessions.ts'

/**
 * Where the Host puts a session on the board. `attention`: it waits on the person. `running`: a run is live.
 * `deliver`: its folder holds work not yet delivered, or its pull request is open. `done`: everything else.
 */
export type BoardGroup = 'attention' | 'running' | 'deliver' | 'done'
/** Why a session waits on the person. Older Hosts could report `silent`. */
export type BoardReason = 'approval' | 'question' | 'unrecognized' | 'silent' | 'unknown' | 'failed'
/** Reasons a live run may report, including `silent` from older Hosts. */
export type WaitKind = Extract<BoardReason, 'approval' | 'question' | 'unrecognized' | 'silent'>

/** The Host's group for a session, derived from its own facts each time the summary is read; never set by a client. */
export interface BoardPlace {
  group: BoardGroup
  /** With `attention`: the first reason in the rule order. */
  reason?: BoardReason
  /** The settlement this place was judged on, what `POST /tasks/:id/attend` names; absent while it cannot be named. */
  settle?: string
  /** It is a card on the board. Absent: archived, a legacy assistant session, or a conversation of 我的 Agent that is not a scheduled run. */
  card?: true
}

/** Session priority as the person sets it; absent is 中. */
export type BoardPriority = 'high' | 'low'

/** `POST /link/api/tasks/:id/attend`: the person opened a failed run, or checked the results nobody could vouch for. */
export interface BoardAttendInput {
  settle: string
  opened?: true
  checked?: true
}

export const BOARD_TAG_LIMIT = 8
/** Code points per tag. */
export const BOARD_TAG_CHARS = 24
/** The longest `settle` the Host records. */
export const BOARD_SETTLE_CHARS = 160

const liveStatus = (task: Pick<TaskSummary, 'status'>) => task.status === 'running' || task.status === 'waiting-approval'

function time(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : undefined
}

/** The engine has done nothing since a request Latch could not answer: it may have stopped on it. */
function stuckOnRequest(live: RunLive | undefined): boolean {
  const asked = time(live?.unrecognized?.at)
  const last = time(live?.lastEventAt)
  return asked !== undefined && last !== undefined && asked >= last
}

/**
 * What a live session waits on the person for, or undefined. A stop already asked for answers all of them. `questions`
 * and `approval` are the Host's own counts when it has them; without them the summary's `pendingQuestions` is read.
 * The same rule as the web's `waitsOnYou` and the desktop's `attentionOf`; the shared wait vectors pin all three.
 */
export function waitKindOf(
  task: Pick<TaskSummary, 'status' | 'live' | 'pendingQuestions'>,
  facts: { questions?: number; approval?: boolean } = {},
): WaitKind | undefined {
  const live = liveStatus(task) ? task.live : undefined
  if (live?.activity === 'cancelling') return undefined
  const questions = facts.questions ?? task.pendingQuestions ?? 0
  // A question also holds a session at waiting-approval; a real request is listed with the approvals.
  if ((task.status === 'waiting-approval' && !(questions > 0)) || facts.approval) return 'approval'
  if (liveStatus(task) && questions > 0) return 'question'
  if (task.status === 'running' && stuckOnRequest(live)) return 'unrecognized'
  return undefined
}

/** The settlement a marker names: the run, else when it ended, else the session's last change. */
export function boardSettleOf(task: Pick<TaskSummary, 'runId' | 'runEnd' | 'updatedAt'>): string | undefined {
  const settle = task.runId ?? task.runEnd?.at ?? task.updatedAt
  return typeof settle === 'string' && settle.length > 0 && settle.length <= BOARD_SETTLE_CHARS ? settle : undefined
}
