import { rejectionNote, type Approval, type ApprovalOptionKind } from '@latch/protocol'
import { ApiError, isUncertain, newRequestId } from './api.ts'
import { DECISION_COPY, safeDeviceName } from './securityCopy.ts'

/**
 * One user decision on one approval keeps one `requestId` until the Host has
 * answered definitively, so a retry after a timeout or a dropped connection is
 * recognized as the same decision instead of a second one.
 */
export class DecisionRequests {
  private readonly pending = new Map<string, { choice: string; requestId: string }>()
  constructor(private readonly makeId: () => string = newRequestId) {}

  /** The id for this choice (a rejection's note is part of it): reused while the same choice is being retried. */
  idFor(approvalId: string, decision: 'allow' | 'reject', optionId: string | undefined, note?: string): string {
    const choice = JSON.stringify([decision, optionId ?? '', note ?? ''])
    const previous = this.pending.get(approvalId)
    if (previous?.choice === choice) return previous.requestId
    const requestId = this.makeId()
    this.pending.set(approvalId, { choice, requestId })
    return requestId
  }

  /** Keep the id only when the outcome is unknown (network error, timeout, 408, ≥ 500). */
  settle(approvalId: string, error?: unknown): void {
    if (error === undefined || !isUncertain(error)) this.pending.delete(approvalId)
  }
}

/**
 * 「告诉 Agent 改做什么」 after 拒绝 (`useRejectionNote`): the note to send with the rejection, why it cannot go, or
 * neither. Only the built-in harness takes a note; an agent's ask (`advisory`) has no room for text, so the composer
 * keeps it for the next message once the turn ends. The Host applies the same rule, and, since a note is input to the
 * model, also requires 「发起和继续会话」 and the session ceiling, as typing does.
 */
export function rejectionNoteFor(approval: Pick<Approval, 'advisory'>, text: string): { note?: string; problem?: string } {
  if (approval.advisory) return {}
  const note = rejectionNote(text)
  return note === null ? { problem: DECISION_COPY.noteInvalid } : note === undefined ? {} : { note }
}

/** `conflict`: this device had already chosen differently, so the choice just made did not take effect. */
export type SettledOutcome = { applied: true } | { applied: false; message: string; conflict: boolean }

const DECISION_LABELS = { allow: '允许', reject: '拒绝' } as const
const ONCE_KIND = { allow: 'allow_once', reject: 'reject_once' } as const
const KIND_LABELS: Record<ApprovalOptionKind, string> = {
  allow_once: '允许一次',
  allow_always: '始终允许',
  reject_once: '拒绝',
  reject_always: '始终拒绝',
}
const kindLabel = (kind: unknown) =>
  typeof kind === 'string' && Object.hasOwn(KIND_LABELS, kind) ? KIND_LABELS[kind as ApprovalOptionKind] : undefined

/**
 * The option kind the Host records for a choice: the chosen option's kind, or the once-kind of a plain allow/reject
 * sent without an option. Undefined when the chosen option is not among the approval's own.
 */
export function choiceKind(
  approval: Pick<Approval, 'options'>,
  decision: 'allow' | 'reject',
  optionId: string | undefined,
): ApprovalOptionKind | undefined {
  if (optionId === undefined) return ONCE_KIND[decision]
  return approval.options?.find(option => option.id === optionId)?.kind
}

/**
 * Reading `409 approval-settled`. A changed choice is sent with a new requestId, so the Host answers with the decision
 * it recorded first; the attempt counts as applied only when that record is this device's and matches it: the same
 * decision, and the same option kind when the Host names it. A Host that does not name it confirms only a plain
 * once-choice.
 */
export function settledOutcome(
  error: unknown,
  attempted: { decision: 'allow' | 'reject'; optionKind?: ApprovalOptionKind },
): SettledOutcome | undefined {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'approval-settled') return
  const decidedBy = (error.details as { decidedBy?: unknown }).decidedBy
  if (typeof decidedBy === 'object' && decidedBy !== null) {
    const record = decidedBy as { kind?: unknown; self?: unknown; deviceName?: unknown; decision?: unknown; optionKind?: unknown }
    if (record.kind === 'device' && record.self === true) {
      if (record.decision !== 'allow' && record.decision !== 'reject') return { applied: false, message: '该审批已结束', conflict: true }
      const recorded = DECISION_LABELS[record.decision]
      if (record.decision !== attempted.decision) {
        return {
          applied: false,
          message: `此设备此前已选择「${recorded}」，本次「${DECISION_LABELS[attempted.decision]}」未生效。`,
          conflict: true,
        }
      }
      const kind = attempted.optionKind
      if (kind === undefined) return { applied: false, message: `此设备此前已选择「${recorded}」。`, conflict: false }
      if (record.optionKind === undefined) {
        return kind === ONCE_KIND[attempted.decision]
          ? { applied: true }
          : { applied: false, message: `此设备此前已选择「${recorded}」。`, conflict: false }
      }
      if (record.optionKind === kind) return { applied: true }
      return {
        applied: false,
        message: `此设备此前已选择「${kindLabel(record.optionKind) ?? recorded}」，本次「${KIND_LABELS[kind]}」未生效。`,
        conflict: true,
      }
    }
    if (record.kind === 'device') {
      const name = safeDeviceName(record.deviceName)
      if (name !== undefined) return { applied: false, message: `已由「${name}」处理`, conflict: false }
    }
  }
  return { applied: false, message: '该审批已结束', conflict: false }
}
