import type { MemoryProposal } from '@latch/protocol'
import { Button, Hint, StatusWord } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { WriteNotice } from './AgentForm.tsx'
import { originWords, proposalRowState } from './proposals.ts'
import { writeFor, type AgentWrites } from './useAgentWrites.ts'

/**
 * 想记住：… with 保存 and 不要. Nothing is saved until the person presses 保存 and the Host answers; a write whose result
 * is unknown keeps its request for 重试同一请求. Saved, it says when it takes effect (`effect`); its source is a short
 * label, with 来自外部内容 in amber when a tool that read outside content ran before it.
 */
export function ProposalRow({
  owner,
  proposal,
  writes,
  effect,
  disabled,
  compact = false,
}: {
  owner: string
  proposal: MemoryProposal
  writes: AgentWrites
  /** 已生效, or 从下一个话题起; absent where the Harness is not known here. */
  effect?: string | undefined
  /** This device cannot write now (offline, no scope). */
  disabled: boolean
  /** In the memory panel, where the lead is the section's own. */
  compact?: boolean
}) {
  const base = `custom-agents/${encodeURIComponent(owner)}/proposals/${encodeURIComponent(proposal.id)}`
  const own =
    [writeFor(writes.state, `proposal:${proposal.id}:save`), writeFor(writes.state, `proposal:${proposal.id}:dismiss`)].find(Boolean)
    ?? null
  const row = proposalRowState(proposal, own)
  const locked = disabled || writes.saving || writes.held
  const decide = (verb: 'save' | 'dismiss') => {
    void writes.run(`proposal:${proposal.id}:${verb}`, `${base}/${verb}`, 'POST', {})
  }
  const open = row.kind === 'pending' || row.kind === 'saving' || row.kind === 'dismissing' || row.kind === 'failed'
  return (
    <section
      className="memory-proposal"
      role="group"
      aria-label="记忆提议"
      data-state={row.kind}
      data-compact={compact ? '' : undefined}
      data-proposal-id={proposal.id}>
      <p className="memory-proposal-text">
        {!compact && <span className="memory-proposal-lead">想记住：</span>}
        <VisibleText text={proposal.content} />
      </p>
      <div className="memory-proposal-foot">
        <span className="memory-proposal-source">{originWords(proposal.origin)}</span>
        {proposal.external && <StatusWord tone="warn">来自外部内容</StatusWord>}
        {proposal.reason && (
          <Hint label="理由" className="memory-proposal-reason">
            <VisibleText text={proposal.reason} />
          </Hint>
        )}
        <span className="memory-proposal-spacer" />
        {row.kind === 'saved' ? (
          <span className="memory-proposal-outcome">
            <StatusWord tone="done">已保存</StatusWord>
            {effect && <span className="memory-proposal-effect">{effect}</span>}
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
                decide('dismiss')
              }}>
              不要
            </Button>
            <Button
              size="sm"
              // The panel's forms keep its one blue action; in a conversation this is it.
              variant={compact ? 'secondary' : 'primary'}
              disabled={locked || !open}
              loading={row.kind === 'saving'}
              onClick={() => {
                decide('save')
              }}>
              保存
            </Button>
          </span>
        )}
      </div>
      {(row.kind === 'unknown' || row.kind === 'failed') && <WriteNotice state={own} onRetry={() => void writes.retry()} />}
    </section>
  )
}
