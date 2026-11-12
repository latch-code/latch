import { splitChangeNote, type AppSnapshot, type TaskDetail } from '@latch/protocol'
import type { PendingSubmission } from './api.ts'

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
