import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import type { PendingSubmission } from './api.ts'
import { harnessLevel } from './permissions.ts'

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
  // A full-access start may still be awaiting local presence; only a confirmed Host message represents that input.
  if (view.submission.sessionId === undefined) {
    const harness = snapshot.catalog.harnesses.find(item => item.id === (view.submission.harnessId ?? snapshot.catalog?.defaults.harnessId))
    if (!harness || harnessLevel(harness) === 'L3') return null
  }
  const submission = view.submission
  const confirmed =
    detail?.summary.id === selectedId
    && detail.messages.some(message => {
      if (message.role !== 'user' || message.requestId !== submission.requestId) return false
      const text = message.forkContext ? message.text.slice(message.forkContext.prefixLength) : message.text
      return (
        text === submission.prompt
        && JSON.stringify(message.attachments?.map(ref => ref.id) ?? []) === JSON.stringify(submission.attachmentIds ?? [])
        && JSON.stringify(message.fileRefs ?? []) === JSON.stringify(submission.fileRefs ?? [])
      )
    })
  return confirmed ? null : view
}
