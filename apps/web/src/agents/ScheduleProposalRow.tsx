import type { MemoryProposal } from '@latch/protocol'
import { Button, StatusWord } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { WriteNotice } from './AgentForm.tsx'
import { scheduleProposalLine } from './activity.ts'
import { proposalRowState } from './proposals.ts'
import { inputLine } from './scheduleModel.ts'
import { writeFor, type AgentWrites } from './useAgentWrites.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    scheduleProposal: '定时提议',
    proposedSchedule: '想定时：',
    inferred: '它推断的',
    external: '来自外部内容',
    saved: '已保存',
    dismissed: '不要了',
    dismiss: '不要',
    open: '打开',
  },
  {
    scheduleProposal: 'Schedule proposal',
    proposedSchedule: 'Proposed schedule',
    inferred: 'Inferred by the Agent',
    external: 'From external content',
    saved: 'Saved',
    dismissed: 'Dismissed',
    dismiss: 'Dismiss',
    open: 'Open',
  },
)

/**
 * 想定时：<name> · <when> with 打开 and 不要. 打开 opens the schedule editor filled in from it; nothing is created or runs
 * until the person saves it there. 不要 sets it aside through the Host, with every write state.
 */
export function ScheduleProposalRow({
  owner,
  proposal,
  writes,
  disabled,
  onOpen,
}: {
  owner: string
  proposal: MemoryProposal
  writes: AgentWrites
  /** This device cannot write now (offline, no scope). */
  disabled: boolean
  /** Absent where the schedule editor is not offered. */
  onOpen?: (() => void) | undefined
}) {
  const base = `custom-agents/${encodeURIComponent(owner)}/proposals/${encodeURIComponent(proposal.id)}`
  const own = writeFor(writes.state, `proposal:${proposal.id}:dismiss`)
  const row = proposalRowState(proposal, own)
  const locked = disabled || writes.saving || writes.held
  const open = row.kind === 'pending' || row.kind === 'dismissing' || row.kind === 'failed'
  return (
    <section
      className="memory-proposal"
      role="group"
      aria-label={COPY.scheduleProposal}
      data-state={row.kind}
      data-proposal-id={proposal.id}>
      <p className="memory-proposal-text">
        <span className="memory-proposal-lead">{COPY.proposedSchedule}</span>
        <VisibleText text={scheduleProposalLine(proposal)} />
      </p>
      <p className="memory-proposal-input">
        <VisibleText text={inputLine(proposal.content, 120)} />
      </p>
      <div className="memory-proposal-foot">
        <span className="memory-proposal-source">{COPY.inferred}</span>
        {proposal.external && <StatusWord tone="warn">{COPY.external}</StatusWord>}
        <span className="memory-proposal-spacer" />
        {row.kind === 'saved' ? (
          <span className="memory-proposal-outcome">
            <StatusWord tone="done">{COPY.saved}</StatusWord>
          </span>
        ) : row.kind === 'dismissed' ? (
          <span className="memory-proposal-outcome memory-proposal-muted">{COPY.dismissed}</span>
        ) : (
          <span className="memory-proposal-actions">
            <Button
              size="sm"
              variant="ghost"
              disabled={locked || !open}
              loading={row.kind === 'dismissing'}
              onClick={() => {
                void writes.run(`proposal:${proposal.id}:dismiss`, `${base}/dismiss`, 'POST', {})
              }}>
              {COPY.dismiss}
            </Button>
            {onOpen && (
              <Button size="sm" variant="primary" disabled={disabled || !open} onClick={onOpen}>
                {COPY.open}
              </Button>
            )}
          </span>
        )}
      </div>
      {(row.kind === 'unknown' || row.kind === 'failed') && <WriteNotice state={own} onRetry={() => void writes.retry()} />}
    </section>
  )
}
