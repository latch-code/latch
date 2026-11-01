import { useState } from 'react'
import type { Approval } from '@latch/protocol'
import { rejectionNoteFor } from '../core/approvalDecision.ts'
import { APPROVAL_COPY } from '../core/securityCopy.ts'

/**
 * While an approval waits, what is typed in the composer is what to do instead: 拒绝 becomes 拒绝并发送, and the rejection
 * carries the text. It stays an ordinary draft of the session until then, and comes back if the rejection did not go
 * through, so an approval settled elsewhere loses nothing. An agent's ask cannot carry text, and neither can an older
 * Host: there 拒绝 stays 拒绝 and the text goes with the next message. Text that cannot go never stands in the way of
 * refusing: the button stays 拒绝 and leaves it in the input, and only Enter, which sends the text, says why it cannot.
 * Nothing here decides anything the person did not press; the Host checks the note.
 */
export interface NoteContext {
  /** The open session. */
  selectedId: string | null
  /** This device may give the open session input now: a note is input to the model, as typing is. */
  mayType: boolean
  /** The Host hands a note to the built-in harness (`HostView.rejectionNote`). */
  hostTakesNote: boolean
}

/** What the composer does while an approval can take a note. */
export interface ComposerNote {
  placeholder: string
  /** The approval drawer's word for rejecting. */
  rejectLabel: string
  error: string
  submit: () => void
}

/** Whether a rejection of this approval can carry what was typed. */
export function takesNote(approval: Approval, context: NoteContext): boolean {
  return !approval.advisory && context.hostTakesNote && context.mayType && approval.sessionId === context.selectedId
}

/** The rejection to send, or why what was typed cannot go with it. */
export function rejectionFor(
  approval: Approval,
  optionId: string | undefined,
  text: string,
  context: NoteContext,
): { problem: string } | { optionId: string | undefined; note?: string } {
  if (!takesNote(approval, context) || !text.trim()) return { optionId }
  const checked = rejectionNoteFor(approval, text)
  if (checked.problem) return { problem: checked.problem }
  return { optionId, ...(checked.note ? { note: checked.note } : {}) }
}

export function useRejectionNote(
  context: NoteContext & {
    /** The approval the drawer shows. */
    approval: Approval | undefined
    draft: string
    clearDraft: () => void
    /** Puts back a note whose rejection did not go through, without overwriting what was written since. */
    restoreDraft: (sessionId: string, text: string) => void
    /** Resolves false when the rejection definitely did not take effect. */
    decide: (approval: Approval, optionId: string | undefined, note: string | undefined) => Promise<boolean>
    /** The option 拒绝 sends for this approval. */
    rejectOption: (approval: Approval) => string | undefined
  },
): { reject: (approval: Approval, optionId: string | undefined) => void; composer?: ComposerNote } {
  const [problem, setProblem] = useState<{ text: string; draft: string } | null>(null)
  const send = (approval: Approval, optionId: string | undefined, note: string | undefined) => {
    setProblem(null)
    const text = context.draft
    if (note) context.clearDraft()
    void context.decide(approval, optionId, note).then(taken => {
      if (note && !taken) context.restoreDraft(approval.sessionId, text)
    })
  }
  const reject = (approval: Approval, optionId: string | undefined) => {
    const rejection = rejectionFor(approval, optionId, context.draft, context)
    send(approval, optionId, 'problem' in rejection ? undefined : rejection.note)
  }
  const { approval } = context
  if (!approval || !takesNote(approval, context)) return { reject }
  const written = rejectionFor(approval, undefined, context.draft, context)
  return {
    reject,
    composer: {
      placeholder: APPROVAL_COPY.rejectPlaceholder,
      rejectLabel: 'note' in written && written.note ? APPROVAL_COPY.rejectAndSend : APPROVAL_COPY.reject,
      error: problem?.draft === context.draft ? problem.text : '',
      submit: () => {
        const option = context.rejectOption(approval)
        const rejection = rejectionFor(approval, option, context.draft, context)
        if ('problem' in rejection) setProblem({ text: rejection.problem, draft: context.draft })
        else send(approval, option, rejection.note)
      },
    },
  }
}
