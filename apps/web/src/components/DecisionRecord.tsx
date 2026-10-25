import { CircleSlash, TimerOff } from 'lucide-react'
import type { ToolDecision } from '@latch/protocol'
import { Icon, type LucideIcon } from '@latch/ui'
import { decisionLine } from '../conversation.ts'
import { useTicker } from '../core/hostClock.ts'
import { DECISION_COPY } from '../core/securityCopy.ts'

/**
 * A decided approval in the state slot of the row it folded into: 「已拒绝 · 14:32」 for a person's choice (where they
 * decided is in the tooltip, never a device name), 「已过期」 or 「已取消（会话停止）」 for an approval nobody answered.
 * The time rolls over at midnight.
 */
export function DecisionWords({ decision }: { decision: ToolDecision }) {
  const now = useTicker('minute')
  const { text, title } = decisionLine(decision, now)
  return (
    <span className="tool-decision-words" title={title} data-outcome={decision.outcome}>
      {text}
    </span>
  )
}

const ICONS: Record<Exclude<ToolDecision['outcome'], 'allowed'>, LucideIcon> = {
  rejected: CircleSlash,
  expired: TimerOff,
  cancelled: CircleSlash,
}

/**
 * The one line under a row whose call an agent reports as run although its approval was not given (an agent's ask in
 * a full-access session is advisory): the record, then that the agent ran it anyway, in the icon ink and hint text.
 */
export function DecisionRecord({ decision }: { decision: ToolDecision }) {
  const now = useTicker('minute')
  if (decision.outcome === 'allowed') return null
  const { text, title } = decisionLine(decision, now)
  return (
    <p className="tool-decision" title={`${title}\n${DECISION_COPY.ranDespiteNote}`} data-outcome={decision.outcome}>
      <Icon icon={ICONS[decision.outcome]} size={14} />
      {`${text} · ${DECISION_COPY.ranDespite}`}
    </p>
  )
}
