import { splitChangeNote, type AppSnapshot, type TaskDetail } from '@latch/protocol'
import { errorMessage, inlineError, isUncertain, readPending, writePending, type PendingSubmission } from './api.ts'

/** Client presentation only. The Host's messages and receipt remain the authority. */
export interface SendingMessage {
  submission: PendingSubmission
  sessionId: string | null
  state: 'sending' | 'unknown' | 'accepted'
  startedAt: number
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
export function unconfirmedReason(cause: unknown): string | null {
  return isUncertain(cause) ? inlineError(cause) || errorMessage(cause) : null
}

/**
 * Gives up this device's unconfirmed submission: storage lets go of it (unless another window already replaced it), and
 * its text goes back to where it was written. The Host's record, if it got it, stays as it is.
 */
export function abandonSubmission(key: string, submission: PendingSubmission): { sessionId: string | null; text: string } {
  if (readPending(key)?.requestId === submission.requestId) writePending(key, null)
  return { sessionId: submission.sessionId ?? null, text: submission.prompt }
}
