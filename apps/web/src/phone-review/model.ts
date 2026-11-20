// The phone's way from the session list to a turn's changes and back: which rows offer 「复核 N 处改动」, the taps that pick
// lines, and the one action the page's bottom bar holds.
import type { ChangedFile, ReviewNoteCounts, TaskSummary, TurnChanges } from '@latch/protocol'
import { contentHidden, fileId } from '../panel/changes/model.ts'
import type { DiffLine } from '../diff.ts'
import { numberOn, selectLine, sideOf, type LineSelection } from '../panel/changes/notes.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    reviewCount: (count: number) => `复核 ${formatNumber(count)} 处改动`,
    review: '复核改动',
    continueReview: '继续复核',
    line: (line: number) => `第 ${formatNumber(line)} 行`,
    lines: (first: number, last: number) => `第 ${formatNumber(first)}–${formatNumber(last)} 行`,
    nextTurn: '排到下一轮',
    afterTurn: '本轮结束后发',
    send: (count: number) => `发给 Agent (${formatNumber(count)})`,
    sending: (count: number) => `正在发送 ${formatNumber(count)} 条反馈`,
    revising: (count: number) => `Agent 在修订 ${formatNumber(count)} 条反馈`,
    queued: (count: number) => `${formatNumber(count)} 条反馈已排队`,
    reviewNeeded: (count: number) => `${formatNumber(count)} 条待你复核`,
  },
  {
    reviewCount: (count: number) => `Review ${plural(count, { one: '{n} change', other: '{n} changes' })}`,
    review: 'Review changes',
    continueReview: 'Continue review',
    line: (line: number) => `Line ${formatNumber(line)}`,
    lines: (first: number, last: number) => `Lines ${formatNumber(first)}–${formatNumber(last)}`,
    nextTurn: 'Queue for next turn',
    afterTurn: 'Send after this turn',
    send: (count: number) => `Send to agent (${formatNumber(count)})`,
    sending: (count: number) => `Sending ${plural(count, { one: '{n} feedback item', other: '{n} feedback items' })}`,
    revising: (count: number) => `Agent is addressing ${plural(count, { one: '{n} feedback item', other: '{n} feedback items' })}`,
    queued: (count: number) => `${plural(count, { one: '{n} feedback item', other: '{n} feedback items' })} queued`,
    reviewNeeded: (count: number) => `${plural(count, { one: '{n} feedback item needs', other: '{n} feedback items need' })} review`,
  },
)

const ACTIVE = new Set(['running', 'waiting-approval'])

/** The review page: its session, the scope its diff shows, and whether 提交 is pushed over it. */
export interface PhoneReviewTarget {
  sessionId: string
  scope: 'turn' | 'session' | 'uncommitted'
  level: 'changes' | 'delivery'
  /** A file to land on, from 提交's list. */
  file?: { root?: string; path: string }
}

/** The two sides of a settled turn come from the Host's retained snapshots. Live scopes have no such version. */
export const reviewVersion = (turn: TurnChanges | undefined): string | undefined =>
  turn?.state === 'settled' && !turn.undone && turn.settledAt ? JSON.stringify([turn.turnId, turn.settledAt]) : undefined

export interface ReviewProgress {
  version: string
  file?: string
  seen?: ReadonlySet<string>
  remaining?: number
}

/** File identity inside a settled turn. A file whose content is no longer available must be reviewed again. */
export const reviewFile = (file: ChangedFile): string => JSON.stringify([fileId(file), file.status, file.oldPath, file.modeChanged])

export function reconcileReview(
  progress: ReviewProgress | undefined,
  version: string,
  files: readonly ChangedFile[],
  current: string,
  toggle?: string,
): ReviewProgress {
  const previous = progress?.version === version ? progress : undefined
  const readable = files.filter(file => !contentHidden(file)).map(reviewFile)
  const seen = new Set(readable.filter(key => Boolean(previous?.seen?.has(key)) !== (key === toggle)))
  const remaining = readable.length - seen.size
  if (
    previous?.file === current
    && previous.remaining === remaining
    && previous.seen?.size === seen.size
    && [...seen].every(key => previous.seen?.has(key))
  )
    return previous
  return { version, file: current, seen, remaining }
}

/** A session whose files the review can show at all: an Agent session the Host still runs, not a chat. */
export const reviewable = (task: TaskSummary): boolean =>
  task.mode !== 'chat' && task.personal === undefined && !task.archived && !ACTIVE.has(task.status)

/** Notes the person still has to look at: written and not sent, or sent and back from the Agent. */
const notesWaiting = (counts: ReviewNoteCounts | undefined) =>
  counts ? { pending: counts.pending, toReview: counts.sent + counts.claimed } : { pending: 0, toReview: 0 }

/**
 * The sessions worth asking the Host about their turns: settled ones with something new for this device (unread) or
 * notes still waiting on the person. Most recent first, at most `limit`: each one is a read of the session's turn records.
 */
export function shortcutCandidates(
  tasks: readonly TaskSummary[],
  input: { isUnread: (task: TaskSummary) => boolean; notes?: readonly ReviewNoteCounts[] | undefined; limit?: number },
): TaskSummary[] {
  const counts = new Map((input.notes ?? []).map(entry => [entry.sessionId, entry]))
  return tasks
    .filter(task => {
      const waiting = notesWaiting(counts.get(task.id))
      return reviewable(task) && (input.isUnread(task) || waiting.pending > 0 || waiting.toReview > 0)
    })
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, input.limit ?? 8)
}

/**
 * What a row of the phone list offers: 「复核 N 处改动」 when the latest turn changed N files the device has not looked at
 * yet, or when notes wait on the person (written and not sent, or sent and not yet marked reviewed). `turns`: the Host's records, absent when this device cannot read them (data
 * scope `work`) or has not yet; then only the notes speak, without a count.
 */
export function reviewShortcut(
  task: TaskSummary,
  input: {
    unread: boolean
    turns?: readonly TurnChanges[] | undefined
    notes?: ReviewNoteCounts | undefined
    progress?: ReviewProgress | undefined
  },
): { label: string; files?: number } | undefined {
  if (!reviewable(task)) return undefined
  const latest = input.turns?.at(-1)
  const files = latest && latest.state !== 'running' && !latest.undone ? (latest.files ?? 0) : 0
  const progress = input.progress?.version === reviewVersion(latest) ? input.progress : undefined
  if (progress && progress.remaining !== 0) return { label: COPY.continueReview }
  const { pending, toReview } = notesWaiting(input.notes)
  // Notes sent and back from the Agent wait until the person marks them reviewed, read or not.
  if (!(input.unread && !progress && files > 0) && pending === 0 && toReview === 0) return undefined
  return files > 0 ? { label: COPY.reviewCount(files), files } : { label: COPY.review }
}

/**
 * A tap on a line of the phone's diff: the first picks that line, the next stretches the pick from where it started to
 * the line tapped (on its side, at most the Host's limit). Tapping the only picked line again lets it go.
 */
export function tapLine(current: LineSelection | undefined, line: DiffLine): LineSelection | undefined {
  if (current && current.start === current.end) {
    const number = numberOn(line, current.side)
    if (number === current.start && sideOf(line) === current.side) return undefined
  }
  return selectLine(current, line, current !== undefined)
}

/** The file one step from `index`, or none past either end. */
export function stepFile(index: number, count: number, by: 1 | -1): number | undefined {
  const next = index + by
  return next >= 0 && next < count ? next : undefined
}

/** The tally the bottom bar reads (`noteTally` of the changes tab). */
export interface FootTally {
  ready: number
  sending: number
  queued: number
  sent: number
  toReview: number
}

/** The bottom bar: the one thing to do next, and the words beside it. */
export type FootAction =
  /** Lines are picked: 写反馈 opens the sheet. */
  | { kind: 'note'; label: string }
  /** A send whose answer never came: retry the same request, or give it up once the Host confirms nothing went out. */
  | { kind: 'unknown'; sending: number }
  /** Pending notes go out as one message, now or with the next turn; `wait`: the Host cannot queue, so after the turn. */
  | { kind: 'send'; label: string; count: number; disabled: boolean }
  /** Nothing pending: on to 提交, with what the notes are doing meanwhile. */
  | { kind: 'deliver'; status?: FootStatus }
  /** Nothing to do from here. */
  | { kind: 'none'; status?: FootStatus }

/** What the notes are doing; `running` while something is under way. */
export interface FootStatus {
  text: string
  running: boolean
}

export function footAction(input: {
  tally: FootTally
  selection?: { start: number; end: number } | undefined
  running: boolean
  canQueue: boolean
  offline: boolean
  unknownSend: boolean
  canWrite: boolean
  canDeliver: boolean
}): FootAction {
  const { tally, running, canQueue, offline } = input
  if (input.selection && input.canWrite)
    return {
      kind: 'note',
      label:
        input.selection.start === input.selection.end
          ? COPY.line(input.selection.start)
          : COPY.lines(input.selection.start, input.selection.end),
    }
  if (input.unknownSend && input.canWrite) return { kind: 'unknown', sending: tally.sending }
  if (tally.ready > 0 && input.canWrite) {
    const label = running ? (canQueue ? COPY.nextTurn : COPY.afterTurn) : COPY.send(tally.ready)
    return { kind: 'send', label, count: tally.ready, disabled: offline || (running && !canQueue) }
  }
  const status: FootStatus | undefined =
    tally.sending > 0
      ? { text: COPY.sending(tally.sending), running: true }
      : running && tally.sent > 0
        ? { text: COPY.revising(tally.sent), running: true }
        : tally.queued > 0
          ? { text: COPY.queued(tally.queued), running: false }
          : tally.toReview > 0
            ? { text: COPY.reviewNeeded(tally.toReview), running: false }
            : undefined
  if (input.canDeliver) return { kind: 'deliver', ...(status ? { status } : {}) }
  return { kind: 'none', ...(status ? { status } : {}) }
}
