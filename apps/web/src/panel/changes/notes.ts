// Line feedback in the 改动 tab: selecting lines of a diff, and where each kept note sits in the file as it is now.
import {
  locateNote,
  REVIEW_NOTE_LIMITS,
  type NoteLocation,
  type ReviewNote,
  type ReviewNoteSide,
  type ReviewNoteStatus,
} from '@latch/protocol'
import type { DiffLine } from '../../diff.ts'

export const NOTE_STATUS_LABEL: Record<ReviewNoteStatus, string> = {
  pending: '待发',
  sent: '已发送',
  'agent-claimed': 'Agent 称已修',
  reviewed: '你已复核',
}

/** Lines picked in one file's diff: on one side, `anchor` the line the selection started from. */
export interface LineSelection {
  side: ReviewNoteSide
  start: number
  end: number
  anchor: number
}

/** A removed line is on the old side; added and unchanged lines are read on the new side. */
export const sideOf = (line: DiffLine): ReviewNoteSide => (line.kind === 'remove' ? 'old' : 'new')

/** The line's number on `side`; none when the line does not exist there. */
export function numberOn(line: DiffLine, side: ReviewNoteSide): number | undefined {
  if (side === 'new') return line.kind === 'remove' ? undefined : line.newLine
  return line.kind === 'add' ? undefined : line.oldLine
}

/**
 * A press on a line: a fresh selection of that line, or with `extend` (Shift, or a second tap on a touch screen) the
 * stretch from where the selection started, on its side, at most `REVIEW_NOTE_LIMITS.lines` long.
 */
export function selectLine(current: LineSelection | undefined, line: DiffLine, extend: boolean): LineSelection | undefined {
  const fresh = () => {
    const side = sideOf(line),
      number = numberOn(line, side)
    return number === undefined ? undefined : { side, start: number, end: number, anchor: number }
  }
  if (!extend || !current) return fresh()
  const number = numberOn(line, current.side)
  if (number === undefined) return fresh()
  const reach = REVIEW_NOTE_LIMITS.lines - 1
  const to = Math.max(current.anchor - reach, Math.min(current.anchor + reach, number))
  return { ...current, start: Math.min(current.anchor, to), end: Math.max(current.anchor, to) }
}

/** One step of Shift ↑ / Shift ↓: the end away from the anchor moves by one line. */
export function stepSelection(current: LineSelection, by: 1 | -1, lineCount: number): LineSelection {
  const moving = current.end !== current.anchor ? current.end : current.start !== current.anchor ? current.start : current.anchor
  const next = Math.min(lineCount, Math.max(1, moving + by))
  const reach = REVIEW_NOTE_LIMITS.lines - 1
  const to = Math.max(current.anchor - reach, Math.min(current.anchor + reach, next))
  return { ...current, start: Math.min(current.anchor, to), end: Math.max(current.anchor, to) }
}

export function inSelection(selection: LineSelection | undefined, line: DiffLine): boolean {
  if (!selection) return false
  const number = numberOn(line, selection.side)
  return number !== undefined && number >= selection.start && number <= selection.end
}

/** A side's text as lines, without the empty one after a final line break. */
export function textLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

const cut = (line: string) => (line.length > REVIEW_NOTE_LIMITS.lineChars ? line.slice(0, REVIEW_NOTE_LIMITS.lineChars) : line)

/** The selected lines as the note keeps them. */
export function snippetOf(lines: readonly string[], selection: Pick<LineSelection, 'start' | 'end'>): string[] {
  return lines.slice(selection.start - 1, selection.end).map(cut)
}

const keyOf = (side: ReviewNoteSide, line: number) => `${side}:${line}`

/** Where the notes of one file go in its diff: under the last line of their place, or apart as stale. */
export interface PlacedNotes {
  /** By `side:line` of the line each note sits under. */
  under: Map<string, ReviewNote[]>
  stale: ReviewNote[]
  located: Map<string, Extract<NoteLocation, { start: number }>>
}

export function placeNotes(notes: readonly ReviewNote[], oldText: string, newText: string): PlacedNotes {
  const sides = { old: textLines(oldText), new: textLines(newText) }
  const placed: PlacedNotes = { under: new Map(), stale: [], located: new Map() }
  for (const note of notes) {
    const location = locateNote(note, sides[note.side])
    if (location.state === 'stale') {
      placed.stale.push(note)
      continue
    }
    placed.located.set(note.id, location)
    const key = keyOf(note.side, location.end)
    placed.under.set(key, [...(placed.under.get(key) ?? []), note])
  }
  return placed
}

/** The notes under a line of the diff: those on its new side and, for a line on both sides, on its old side too. */
export function notesUnder(placed: PlacedNotes, line: DiffLine): ReviewNote[] {
  const out: ReviewNote[] = []
  const fresh = numberOn(line, 'new'),
    old = numberOn(line, 'old')
  if (fresh !== undefined) out.push(...(placed.under.get(keyOf('new', fresh)) ?? []))
  if (old !== undefined) out.push(...(placed.under.get(keyOf('old', old)) ?? []))
  return out
}

/** Whether a line is covered by a note placed on it, for its mark in the margin. */
export function noted(placed: PlacedNotes, notes: readonly ReviewNote[], line: DiffLine): boolean {
  return notes.some(note => {
    const at = placed.located.get(note.id)
    const number = numberOn(line, note.side)
    return at !== undefined && number !== undefined && number >= at.start && number <= at.end
  })
}

export const sameFile = (note: Pick<ReviewNote, 'root' | 'path'>, file: { root: string; path: string }) =>
  note.root === file.root && note.path === file.path

/** The foot of the tab, from the notes the Host holds. */
export function noteTally(notes: readonly ReviewNote[]) {
  const pending = notes.filter(note => note.status === 'pending')
  return {
    pending,
    ready: pending.filter(note => !note.sending),
    /** On their way, or their answer unknown. */
    sending: pending.filter(note => note.sending && !note.queueId),
    /** Their message waits in the session's queue (「已排队」). */
    queued: pending.filter(note => note.queueId !== undefined).length,
    sent: notes.filter(note => note.status === 'sent').length,
    toReview: notes.filter(note => note.status === 'sent' || note.status === 'agent-claimed').length,
  }
}
