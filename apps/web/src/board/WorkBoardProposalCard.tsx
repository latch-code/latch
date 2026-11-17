import { memo } from 'react'
import { escapeSecurityText } from '@latch/protocol'
import { Button, Hint, Icon, StatusWord } from '@latch/ui'
import { Lightbulb } from 'lucide-react'
import { AgentAvatar } from '../agents/AgentAvatar.tsx'
import { hostNow } from '../core/hostClock.ts'
import { relativeTime } from '../format.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { cardUpdatedAt, type BoardCard } from './model.ts'
import { pendingEntries, proposerName, type ProposalOrigin, type ProposalWriteState } from './proposals.ts'
import { TagChips } from './WorkBoardCard.tsx'
import { ItemWriteLine } from './WriteLine.tsx'

export type ProposalCard = Extract<BoardCard, { kind: 'proposal' }>

/** Who proposed it: the Agent's face and name, or the proposing session's title. Opens that session. */
export function ProposedBy({
  proposal,
  shell,
  onOpenSession,
}: {
  proposal: ProposalOrigin
  shell: ShellState
  onOpenSession?: ((id: string) => void) | undefined
}) {
  const who = proposerName(proposal, shell.snapshot)
  const face = who.agent ? <AgentAvatar avatar={who.agent === 'general' ? 'general' : who.agent.avatar} size={14} still /> : null
  const words = (
    <>
      {face}
      <span className="work-board-proposed-name">{escapeSecurityText(who.name)}</span>
    </>
  )
  return who.session && onOpenSession ? (
    <button
      type="button"
      className="work-board-proposed-by"
      aria-label={`提议自 ${escapeSecurityText(who.name)}`}
      onClick={event => {
        event.stopPropagation()
        onOpenSession(who.session!.id)
      }}>
      {words}
    </button>
  ) : (
    <span className="work-board-proposed-by" aria-label={`提议自 ${escapeSecurityText(who.name)}`}>
      {words}
    </span>
  )
}

/** 来自外部内容: the proposing turn may have read outside content, so its words are not the person's. */
export function ExternalMark() {
  return (
    <Hint label="来自外部内容" className="work-board-external" lead={false}>
      提议的那一轮读过网页、文件或命令输出，内容可能不是你的意思。开始前请读完要求。
    </Hint>
  )
}

/**
 * An agent's proposal in 未开始: never a 待办 and never drawn like one. Dashed, marked 提议 with who proposed it, the
 * 来自外部内容 mark when its turn read outside content; its 待办 (one, or a group under its goal). 审阅 opens them to
 * read, edit, pick and accept; 不要 dismisses what is still pending. Nothing starts from here.
 */
export const WorkBoardProposalCard = memo(function WorkBoardProposalCard({
  card,
  shell,
  write,
  canDecide,
  onReview,
  onDismiss,
  onRetry,
  onForget,
  onOpenSession,
}: {
  card: ProposalCard
  shell: ShellState
  write: ProposalWriteState | undefined
  /** This device may accept or dismiss (`run`). */
  canDecide: boolean
  onReview: (proposal: ProposalCard['proposal']) => void
  onDismiss: (proposal: ProposalCard['proposal']) => void
  onRetry: (id: string) => void
  onForget: (id: string) => void
  onOpenSession: (id: string) => void
}) {
  const { proposal } = card
  const entries = pendingEntries(proposal)
  const group = proposal.goal !== undefined
  const title = escapeSecurityText(group ? proposal.goal! : (entries[0]?.title ?? ''))
  const updatedAt = cardUpdatedAt(card)
  const busy = write?.state === 'sending'
  const blocked = write !== undefined && write.state !== 'refused'
  const tags = [...new Set(entries.flatMap(entry => entry.tags ?? []))]
  return (
    <article
      className="work-board-card"
      data-kind="proposal"
      data-work-proposal={proposal.id}
      data-external={proposal.external ? '' : undefined}
      data-busy={busy ? '' : undefined}
      aria-label={`提议：${title}`}>
      <button
        type="button"
        className="work-board-card-main"
        disabled={!canDecide}
        onClick={() => {
          onReview(proposal)
        }}>
        <span className="work-board-card-head">
          <Icon icon={Lightbulb} size={14} className="work-board-proposal-glyph" />
          <span className="work-board-card-title">{title}</span>
          <time dateTime={updatedAt}>{relativeTime(updatedAt, new Date(hostNow()))}</time>
        </span>
        {group && (
          <ol className="work-board-proposal-entries">
            {entries.map(entry => (
              <li key={entry.index}>{escapeSecurityText(entry.title)}</li>
            ))}
          </ol>
        )}
        {tags.length ? <TagChips tags={tags} /> : null}
      </button>
      <div className="work-board-proposal-line">
        <StatusWord tone="neutral" className="work-board-proposal-word">
          {group ? `提议 ${entries.length} 条` : '提议'}
        </StatusWord>
        <ProposedBy proposal={proposal} shell={shell} onOpenSession={onOpenSession} />
        {proposal.external && <ExternalMark />}
      </div>
      {(canDecide || write) && (
        <div className="work-board-item-foot">
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
                  onReview(proposal)
                }}>
                审阅
              </Button>
            </>
          )}
        </div>
      )}
    </article>
  )
})
