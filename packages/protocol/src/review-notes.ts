// Review notes: line feedback on the 改动 tab, kept per session on the Host.
import type { ChangeScope } from './changes.ts'

/**
 * `pending`: in the to-send set. `sent`: went out in `messageId`. `agent-claimed`: the person marked that the Agent's reply
 * said it was fixed (never inferred). `reviewed`: the person ticked it after looking.
 */
export type ReviewNoteStatus = 'pending' | 'sent' | 'agent-claimed' | 'reviewed'
export const REVIEW_NOTE_STATUSES: readonly ReviewNoteStatus[] = ['pending', 'sent', 'agent-claimed', 'reviewed']

/** Which side of the diff the lines are on: `new` for added and unchanged lines, `old` for removed ones. */
export type ReviewNoteSide = 'old' | 'new'

export const REVIEW_NOTE_LIMITS = {
  /** Characters of a note's text. */
  textChars: 4000,
  /** Lines one note covers; its snippet keeps them all. */
  lines: 100,
  /** Characters of each snippet line kept; longer lines are cut, here and when they are compared. */
  lineChars: 1000,
  /** Notes kept per session. */
  perSession: 200,
  /** Notes sent in one message. */
  perSend: 50,
  /** Unchanged lines searched on either side when a note's lines moved. */
  window: 200,
  /** Snippet lines quoted in the message to the Agent. */
  quoted: 12,
} as const

/** The version the note was made against: the scope (and turn) of the diff, and the selected lines themselves. */
export interface ReviewNoteAnchor {
  scope: ChangeScope
  turnId?: string
  /** SHA-256 of the lines joined with `\n`, computed by the Host. */
  linesHash: string
  /** The selected lines as they were, each cut to `lineChars`: the original snippet, kept when the position goes stale. */
  lines: string[]
}

export interface ReviewNote {
  id: string
  root: string
  path: string
  /** 1-based, inclusive, on `side`. */
  range: { start: number; end: number }
  side: ReviewNoteSide
  anchor: ReviewNoteAnchor
  text: string
  status: ReviewNoteStatus
  /** The user message it went out in; set once the Host accepted the send and the message is in the session. */
  messageId?: string
  /** Pending, its message waiting in the session's queue as this item (「已排队」); it is sent once the message goes out. */
  queueId?: string
  /** A send is under way or its result is unknown: the note stays pending until it settles. */
  sending?: true
  createdBy: { deviceId: string; name: string }
  createdAt: string
  updatedAt: string
}

export interface ReviewNoteList {
  notes: ReviewNote[]
  /** Bumped by every write; the snapshot's counts carry the same number. */
  revision: number
  /** Sends whose result is still open; any device that may write can retry or abandon one (`sends/:id/retry`, `abandon`). */
  openSends?: Array<{ id: string; noteIds: string[]; queue?: true; queueId?: string }>
}

/** What every device that can read the session sees: counts only, never the notes' text or code. */
export interface ReviewNoteCounts {
  sessionId: string
  pending: number
  sent: number
  claimed: number
  reviewed: number
  revision: number
}

export interface ReviewNoteSendResult {
  noteIds: string[]
  /** Absent while the Host has accepted the message but not yet seen it in the session. */
  messageId?: string
  /** The message waits in the session's queue for the next turn. */
  queueId?: string
}

export type NoteLocation = { state: 'exact' | 'moved'; start: number; end: number } | { state: 'stale' }

const cut = (line: string) => (line.length > REVIEW_NOTE_LIMITS.lineChars ? line.slice(0, REVIEW_NOTE_LIMITS.lineChars) : line)

/**
 * Where a note's lines are in the file as it is now. At the same place: exact. Otherwise the nearest exact copy within
 * `window` lines: moved; two copies equally near, a snippet too thin to tell apart (under 8 characters besides blanks,
 * or under 20 for a single line, such as `return x` or a lone brace), or none:
 * stale. A note is never moved onto lines that are not exactly its own.
 */
export function locateNote(
  note: { range: { start: number; end: number }; anchor: Pick<ReviewNoteAnchor, 'lines'> },
  current: readonly string[],
  window: number = REVIEW_NOTE_LIMITS.window,
): NoteLocation {
  const lines = note.anchor.lines
  if (!lines.length) return { state: 'stale' }
  const span = note.range.end - note.range.start
  const at = (index: number) =>
    index >= 0 && index + lines.length <= current.length && lines.every((line, offset) => cut(current[index + offset]!) === line)
  const origin = note.range.start - 1
  if (at(origin)) return { state: 'exact', start: note.range.start, end: note.range.end }
  // Elsewhere only lines distinct enough to be the same code: one line must say more than a few words of syntax.
  if (lines.join('').replace(/\s/gu, '').length < (lines.length === 1 ? 20 : 8)) return { state: 'stale' }
  for (let distance = 1; distance <= window; distance++) {
    const before = at(origin - distance),
      after = at(origin + distance)
    if (before && after) return { state: 'stale' }
    if (before || after) {
      const start = (before ? origin - distance : origin + distance) + 1
      return { state: 'moved', start, end: start + span }
    }
  }
  return { state: 'stale' }
}

/** 「第 42–45 行」, or 「第 18 行」. */
export function noteLinesLabel(range: { start: number; end: number }): string {
  return range.start === range.end ? `第 ${range.start} 行` : `第 ${range.start}–${range.end} 行`
}

/** A fence longer than any run of backticks in the code, so the snippet cannot close it. */
function fenceFor(lines: readonly string[]): string {
  const longest = Math.max(0, ...lines.flatMap(line => (line.match(/`+/gu) ?? []).map(run => run.length)))
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * The one message a send makes: each note's place, its quoted lines and its text, in the order given. `folder` names
 * the session folder when the session has more than one.
 */
export function reviewNotesMessage(
  notes: ReadonlyArray<Pick<ReviewNote, 'path' | 'range' | 'side' | 'anchor' | 'text'> & { folder?: string }>,
): string {
  const parts = notes.map((note, index) => {
    const place = `${note.folder ? `${note.folder}/` : ''}${note.path} ${noteLinesLabel(note.range)}${note.side === 'old' ? '（修改前）' : ''}`
    const shown = note.anchor.lines.slice(0, REVIEW_NOTE_LIMITS.quoted)
    const rest = note.anchor.lines.length - shown.length
    const fence = fenceFor(shown)
    return [`${index + 1}. ${place}`, fence, ...shown, fence, ...(rest > 0 ? [`（另有 ${rest} 行未引用）`] : []), note.text].join('\n')
  })
  return [`请处理这 ${notes.length} 条代码反馈：`, ...parts].join('\n\n')
}
