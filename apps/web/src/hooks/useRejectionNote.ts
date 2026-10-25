import { useEffect, useState } from 'react'
import type { Approval } from '@latch/protocol'
import { rejectionNoteFor } from '../core/approvalDecision.ts'
import { DECISION_COPY } from '../core/securityCopy.ts'

/**
 * 「告诉 Agent 改做什么」 after 拒绝. The built-in harness takes a note with the rejection as
 * the tool result, so its rejection waits: the composer takes focus with 「告诉 Agent 改做什么…」, and the next 拒绝
 * (the composer's button, Enter, or the card's button again) sends the rejection with whatever was written, or without
 * a note when nothing was. An agent's ask cannot carry text: its rejection goes at once, and the composer says the text
 * waits for the turn to end. Nothing here decides anything the person did not press; the Host checks the note again.
 */
export type RejectionNote =
  | { kind: 'note'; approval: Approval; optionId: string | undefined; text: string; problem?: string }
  | { kind: 'after'; sessionId: string }

/** What the composer shows while a note is being written, or after an agent's ask was rejected. */
export type ComposerNote =
  | {
      kind: 'note'
      draft: string
      onDraft: (text: string) => void
      placeholder: string
      hint: string
      error: string
      submit: () => void
      cancel: () => void
    }
  | { kind: 'after'; placeholder: string; hint: string }

export interface NoteContext {
  /** The open session. */
  selectedId: string | null
  /** Every approval the Host lists. */
  open: readonly Approval[]
  /** The open session's turn has not settled. */
  active: boolean
  /** This device may give the open session input now: a note is input to the model, as typing is. */
  mayType: boolean
  /** The Host hands a note to the built-in harness (`HostView.rejectionNote`); an older Host drops it. */
  hostTakesNote: boolean
}

/** Whether a rejection of this approval waits for a note, or goes at once. */
export function holdsForNote(approval: Approval, context: NoteContext): boolean {
  return !approval.advisory && context.hostTakesNote && context.mayType && approval.sessionId === context.selectedId
}

/** The state after 拒绝, and the rejection to send now (`problem`: the note cannot go, so nothing is sent). */
export function afterReject(
  state: RejectionNote | null,
  approval: Approval,
  optionId: string | undefined,
  context: NoteContext,
): { next: RejectionNote | null; send?: { optionId: string | undefined; note?: string } | 'problem' } {
  if (state?.kind === 'note' && state.approval.id === approval.id) {
    const checked = rejectionNoteFor(approval, state.text)
    if (checked.problem) return { next: { ...state, problem: checked.problem }, send: 'problem' }
    return { next: null, send: { optionId: state.optionId, ...(checked.note ? { note: checked.note } : {}) } }
  }
  if (holdsForNote(approval, context)) return { next: { kind: 'note', approval, optionId, text: '' } }
  if (approval.advisory && context.mayType && approval.sessionId === context.selectedId)
    return { next: { kind: 'after', sessionId: approval.sessionId }, send: { optionId } }
  return { next: state, send: { optionId } }
}

/** Whether the state still applies: its approval is open in the open session, or its session's turn still runs. */
export function stillApplies(state: RejectionNote, context: NoteContext): boolean {
  if (state.kind === 'after') return state.sessionId === context.selectedId && context.active
  return state.approval.sessionId === context.selectedId && context.open.some(approval => approval.id === state.approval.id)
}

export function useRejectionNote(
  context: NoteContext & {
    decide: (approval: Approval, optionId: string | undefined, note: string | undefined) => void
    focusComposer: () => void
    /** Where a note goes when its approval was settled elsewhere before it was sent: the session's draft. */
    keepText: (text: string) => void
  },
): { reject: (approval: Approval, optionId: string | undefined) => void; composer?: ComposerNote; noting?: string } {
  const [state, setState] = useState<RejectionNote | null>(null)
  const applies = state === null || stillApplies(state, context)
  useEffect(() => {
    if (state === null || applies) return
    // Settled elsewhere: what was written is kept as an ordinary draft of the same session, never sent.
    if (state.kind === 'note' && state.text.trim() && state.approval.sessionId === context.selectedId) context.keepText(state.text)
    setState(null)
  }, [state, applies])

  const reject = (approval: Approval, optionId: string | undefined) => {
    const { next, send } = afterReject(state, approval, optionId, context)
    setState(next)
    if (send !== undefined && send !== 'problem') context.decide(approval, send.optionId, send.note)
    if (next !== null && next.kind !== state?.kind) requestAnimationFrame(context.focusComposer)
  }
  if (state === null || !applies) return { reject }
  if (state.kind === 'after') {
    return { reject, composer: { kind: 'after', placeholder: DECISION_COPY.notePlaceholder, hint: DECISION_COPY.noteAfterTurn } }
  }
  const current = state
  return {
    reject,
    noting: current.approval.id,
    composer: {
      kind: 'note',
      draft: current.text,
      onDraft: text => {
        setState(previous =>
          previous?.kind === 'note' ? { kind: 'note', approval: previous.approval, optionId: previous.optionId, text } : previous,
        )
      },
      placeholder: DECISION_COPY.notePlaceholder,
      hint: DECISION_COPY.noteHint,
      error: current.problem ?? '',
      submit: () => {
        reject(current.approval, current.optionId)
      },
      cancel: () => {
        setState(null)
      },
    },
  }
}
