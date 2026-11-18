import { looksSecret, splitChangeNote, type AppSnapshot, type TaskDetail, type WorkItemStartAnswer } from '@latch/protocol'
import { errorMessage, inlineError, isUncertain, readPending, writePending, type PendingSubmission } from './api.ts'
import { CONNECTION_COPY } from './hostState.ts'

/** Client presentation only. The Host's messages and receipt remain the authority. */
export interface SendingMessage {
  submission: PendingSubmission
  sessionId: string | null
  state: 'sending' | 'unknown' | 'accepted'
  startedAt: number
  /** The Host started the session and reported that it could not join its task. */
  itemOutside?: WorkItemStartAnswer['outside']
}

export function sendingMessageFor(
  snapshot: AppSnapshot,
  view: SendingMessage | null,
  selectedId: string | null,
  detail: TaskDetail | null,
): SendingMessage | null {
  if (!view || !snapshot.catalog?.features?.messageIdentity || view.submission.queue || view.sessionId !== selectedId) return null
  const submission = view.submission
  const confirmed =
    detail?.summary.id === selectedId
    && detail.messages.some(message => {
      if (message.role !== 'user' || message.requestId !== submission.requestId) return false
      const text = message.text.slice(message.forkContext?.prefixLength ?? message.importContext?.prefixLength ?? 0)
      return (
        // The Host puts the note about an undo in front of what the person wrote.
        (text === submission.prompt || splitChangeNote(text).text === submission.prompt)
        && JSON.stringify(message.attachments?.map(ref => ref.id) ?? []) === JSON.stringify(submission.attachmentIds ?? [])
        && JSON.stringify(message.fileRefs ?? []) === JSON.stringify(submission.fileRefs ?? [])
      )
    })
  return confirmed ? null : view
}

/**
 * The Host already lists this submission as a user message of its session, so it was delivered whatever the last retry
 * heard. Only a submission to an existing session can be checked: a new session's ID comes with the answer.
 */
export function deliveredSubmission(pending: PendingSubmission | null, detail: TaskDetail | null): boolean {
  return (
    pending?.sessionId !== undefined
    && detail?.summary.id === pending.sessionId
    && detail.messages.some(message => message.role === 'user' && message.requestId === pending.requestId)
  )
}

/** Why a submission is still unconfirmed after a send or retry, or null when the Host answered and it is settled. */
export function unconfirmedReason(cause: unknown, online = typeof navigator === 'undefined' || navigator.onLine !== false): string | null {
  if (!isUncertain(cause)) return null
  // No answer while this device has no network says nothing about the computer.
  return online ? inlineError(cause) || errorMessage(cause) : CONNECTION_COPY.offline
}

/**
 * Gives up this device's unconfirmed submission: storage lets go of it (unless another window already replaced it), and
 * its text goes back to where it was written. The Host's record, if it got it, stays as it is.
 */
export function abandonSubmission(key: string, submission: PendingSubmission): { sessionId: string | null; text: string } {
  releaseStored(key, submission.requestId)
  return { sessionId: submission.sessionId ?? null, text: submission.prompt }
}

/** Removes the stored submission only while it is still this one: another window of this device may have stored a newer one. */
export function releaseStored(key: string, requestId: string): void {
  if (readPending(key)?.requestId === requestId) writePending(key, null)
  if (readPendingReason(key, requestId) !== '') writePendingReason(key, requestId, '')
}

const reasonKey = (key: string) => `${key}.reason`

/**
 * Why the stored submission is still unconfirmed, as its last try heard it, so a reload says the same and not the
 * fallback 没有收到电脑的答复. '' when none was kept, or it was kept for another request.
 */
export function readPendingReason(key: string, requestId: string): string {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(reasonKey(key)) ?? 'null')
    if (typeof value !== 'object' || value === null) return ''
    const item = value as Record<string, unknown>
    return item.requestId === requestId && typeof item.reason === 'string' ? item.reason.slice(0, 500) : ''
  } catch {
    return ''
  }
}

/** Keeps, or with '' drops, the reason; one that looks like a secret stays in memory only, as a draft would. */
export function writePendingReason(key: string, requestId: string, reason: string): void {
  try {
    if (!reason || looksSecret(reason)) localStorage.removeItem(reasonKey(key))
    else localStorage.setItem(reasonKey(key), JSON.stringify({ requestId, reason: reason.slice(0, 500) }))
  } catch {
    /* Storage unavailable: the reason lives in memory only. */
  }
}

/**
 * A queue item of the session with the same text as this queued submission: `waiting` goes out by itself when the turn
 * ends (`sending` is shown as waiting), `parked` only when someone sends it. The queue lists neither request IDs nor
 * devices, so the item may be another device's: this says only that the same text is there and never keeps 放弃 away.
 */
export function queuedTwin(pending: PendingSubmission | null, detail: TaskDetail | null): 'waiting' | 'parked' | null {
  if (!(pending?.queue === true || pending?.steer === true) || pending.sessionId === undefined || detail?.summary.id !== pending.sessionId)
    return null
  const items = (detail.queue ?? []).filter(item => item.text === pending.prompt)
  return items.some(item => item.state === 'waiting') ? 'waiting' : items.some(item => item.state === 'parked') ? 'parked' : null
}

/** How long a window's send or retry is taken to be in flight: past the 15 s request timeout, so a closed window holds nothing. */
export const FLIGHT_MS = 20_000
const flightKey = (key: string) => `${key}.sending`

/** A window of this device is sending or retrying this submission now; other windows do not offer 放弃 meanwhile. */
export function readFlight(key: string, now = Date.now()): { requestId: string; until: number } | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(flightKey(key)) ?? 'null')
    if (typeof value !== 'object' || value === null) return null
    const { requestId, until } = value as Record<string, unknown>
    return typeof requestId === 'string' && typeof until === 'number' && until > now && until <= now + FLIGHT_MS
      ? { requestId, until }
      : null
  } catch {
    return null
  }
}

export function markFlight(key: string, requestId: string, now = Date.now()): void {
  try {
    localStorage.setItem(flightKey(key), JSON.stringify({ requestId, until: now + FLIGHT_MS }))
  } catch {
    /* Without storage there is no other window to tell. */
  }
}

export function endFlight(key: string, requestId: string): void {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(flightKey(key)) ?? 'null')
    if (typeof value === 'object' && value !== null && (value as Record<string, unknown>).requestId === requestId)
      localStorage.removeItem(flightKey(key))
  } catch {
    /* Nothing was marked. */
  }
}

export const isFlightKey = (key: string | null, pendingKey: string) => key === flightKey(pendingKey)
