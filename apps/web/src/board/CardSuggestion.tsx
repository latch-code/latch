import { escapeSecurityText } from '@latch/protocol'
import { Button, Icon } from '@latch/ui'
import { Lightbulb } from 'lucide-react'
import type { ShellState } from '../shell/useShellLayout.tsx'
import type { ChangeProposal, ProposalWriteState } from './proposals.ts'
import { ExternalMark, ProposedBy } from './WorkBoardProposalCard.tsx'
import { CardNote, TagChips } from './WorkBoardCard.tsx'
import { ItemWriteLine } from './WriteLine.tsx'

/**
 * An agent's suggestion for this card, waiting for the person: the title, tags or note it would set, who suggested it,
 * 来自外部内容 when so; 接受 makes the change, 不要 drops it. Never applied by itself; priority is never among them.
 */
export function CardSuggestion({
  proposal,
  shell,
  write,
  canDecide,
  onAccept,
  onDismiss,
  onRetry,
  onForget,
}: {
  proposal: ChangeProposal
  shell: ShellState
  write: ProposalWriteState | undefined
  canDecide: boolean
  onAccept: (proposal: ChangeProposal) => void
  onDismiss: (proposal: ChangeProposal) => void
  onRetry: (id: string) => void
  onForget: (id: string) => void
}) {
  const { change } = proposal
  const busy = write?.state === 'sending'
  const blocked = write !== undefined && write.state !== 'refused'
  return (
    <div className="work-board-suggestion" data-work-proposal={proposal.id} data-external={proposal.external ? '' : undefined}>
      <span className="work-board-suggestion-head">
        <Icon icon={Lightbulb} size={12} className="work-board-proposal-glyph" />
        <span className="work-board-proposal-word">建议</span>
        {/* On the proposing session's own card, it is that session: no need to name it. */}
        {!('sessionId' in change.target && change.target.sessionId === proposal.from.sessionId) && (
          <ProposedBy proposal={proposal} shell={shell} />
        )}
        {proposal.external && <ExternalMark />}
      </span>
      {change.title && <span className="work-board-suggestion-title">{escapeSecurityText(change.title)}</span>}
      {change.tags?.length ? <TagChips tags={change.tags} /> : null}
      {change.note && <CardNote note={change.note} />}
      {(canDecide || write) && (
        <span className="work-board-suggestion-actions">
          <ItemWriteLine
            state={write}
            onRetry={() => {
              onRetry(proposal.id)
            }}
            onDismiss={() => {
              onForget(proposal.id)
            }}
          />
          {canDecide && (busy || !blocked) && (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  onDismiss(proposal)
                }}>
                不要
              </Button>
              <Button
                size="xs"
                variant="outline"
                loading={busy}
                onClick={() => {
                  onAccept(proposal)
                }}>
                接受
              </Button>
            </>
          )}
        </span>
      )}
    </div>
  )
}
