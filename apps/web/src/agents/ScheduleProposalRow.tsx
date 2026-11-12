import type { MemoryProposal } from '@latch/protocol'
import { Button, StatusWord } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { WriteNotice } from './AgentForm.tsx'
import { scheduleProposalLine } from './activity.ts'
import { proposalRowState } from './proposals.ts'
import { inputLine } from './scheduleModel.ts'
import { writeFor, type AgentWrites } from './useAgentWrites.ts'

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
    <section className="memory-proposal" role="group" aria-label="定时提议" data-state={row.kind} data-proposal-id={proposal.id}>
      <p className="memory-proposal-text">
        <span className="memory-proposal-lead">想定时：</span>
        <VisibleText text={scheduleProposalLine(proposal)} />
      </p>
      <p className="memory-proposal-input">
        <VisibleText text={inputLine(proposal.content, 120)} />
      </p>
      <div className="memory-proposal-foot">
        <span className="memory-proposal-source">它推断的</span>
        {proposal.external && <StatusWord tone="warn">来自外部内容</StatusWord>}
        <span className="memory-proposal-spacer" />
        {row.kind === 'saved' ? (
          <span className="memory-proposal-outcome">
            <StatusWord tone="done">已保存</StatusWord>
          </span>
        ) : row.kind === 'dismissed' ? (
          <span className="memory-proposal-outcome memory-proposal-muted">不要了</span>
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
              不要
            </Button>
            {onOpen && (
              <Button size="sm" variant="primary" disabled={disabled || !open} onClick={onOpen}>
                打开
              </Button>
            )}
          </span>
        )}
      </div>
      {(row.kind === 'unknown' || row.kind === 'failed') && <WriteNotice state={own} onRetry={() => void writes.retry()} />}
    </section>
  )
}
