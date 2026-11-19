import { useState, type ReactNode } from 'react'
import { escapeSecurityText, type TaskDetail, type WorkProposalSummary } from '@latch/protocol'
import { Button, Icon, StatusWord } from '@latch/ui'
import { Lightbulb, ListTodo } from 'lucide-react'
import { defineCopy, formatNumber } from '../core/i18n.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { CardSuggestion } from './CardSuggestion.tsx'
import { ProposalReview } from './ProposalReview.tsx'
import { pendingEntries, todoProposals, type ChangeProposal, type TodoProposal } from './proposals.ts'
import { ExternalMark } from './WorkBoardProposalCard.tsx'
import { ProposalRecovery } from './ProposalRecovery.tsx'
import { canStartTeam } from '../teams/model.ts'

const COPY = defineCopy(
  { single: '提议待办', many: (count: number) => `提议 ${formatNumber(count)} 条待办`, review: '审阅' },
  { single: 'Proposed task', many: (count: number) => `${formatNumber(count)} proposed tasks`, review: 'Review' },
)

/** A proposal this session made, after the turn it came from: what it proposed, and 审阅 or the suggestion's own buttons. */
function TodoRow({ proposal, canDecide, onReview }: { proposal: TodoProposal; canDecide: boolean; onReview: (row: TodoProposal) => void }) {
  const entries = pendingEntries(proposal)
  return (
    <div className="work-board-session-proposal" data-work-proposal={proposal.id}>
      <Icon icon={Lightbulb} size={14} className="work-board-proposal-glyph" />
      <StatusWord tone="neutral" className="work-board-proposal-word">
        {entries.length > 1 ? COPY.many(entries.length) : COPY.single}
      </StatusWord>
      <span className="work-board-session-proposal-title">{escapeSecurityText(proposal.goal ?? entries[0]?.title ?? '')}</span>
      {proposal.external && <ExternalMark />}
      {canDecide && (
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            onReview(proposal)
          }}>
          {COPY.review}
        </Button>
      )}
    </div>
  )
}

/**
 * What this session proposed for the board and nobody has decided yet, each after the turn it came from: the same
 * proposals the board shows, decided the same way. Undefined while there are none.
 */
export function useSessionBoardProposals(
  shell: ShellState,
  detail: TaskDetail | null,
): ((turns: ReadonlyArray<{ key: string }>) => ReadonlyMap<string, ReactNode>) | undefined {
  const writes = shell.proposalWrites
  const [reviewing, setReviewing] = useState<TodoProposal | null>(null)
  if (!detail) return undefined
  const sessionId = detail.summary.id
  const own = (shell.snapshot.workProposals ?? []).filter(row => row.from.sessionId === sessionId)
  const accepted = (shell.snapshot.items ?? []).filter(item => item.from?.sessionId === sessionId)
  const hasUnconfirmed = [...writes.states.values()].some(state => state.state !== 'refused' && state.sessionId === sessionId)
  if (!own.length && !accepted.length && !hasUnconfirmed && !reviewing) return undefined
  const canDecide = shell.catalog !== undefined && shell.access.scopes.has('run')
  const row = (proposal: WorkProposalSummary) =>
    proposal.kind === 'change' && proposal.change ? (
      <CardSuggestion
        key={proposal.id}
        proposal={proposal as ChangeProposal}
        shell={shell}
        write={writes.states.get(proposal.id)}
        canDecide={canDecide}
        onAccept={item => void writes.accept(item)}
        onDismiss={item => void writes.dismiss(item)}
        onRetry={id => void writes.retry(id)}
        onForget={writes.forget}
      />
    ) : null
  const todos = todoProposals(own)
  return turns => {
    const keys = new Set(turns.map(turn => turn.key))
    const last = turns.at(-1)?.key ?? ''
    const placed = new Map<string, WorkProposalSummary[]>()
    for (const proposal of own) {
      const key = proposal.from.messageId && keys.has(proposal.from.messageId) ? proposal.from.messageId : last
      placed.set(key, [...(placed.get(key) ?? []), proposal])
    }
    const nodes = new Map<string, ReactNode>()
    for (const [key, rows] of placed)
      nodes.set(
        key,
        <div key={`board-proposals:${key}`} className="work-board-session-proposals">
          {rows.map(proposal => {
            const todo = todos.find(item => item.id === proposal.id)
            return todo ? <TodoRow key={todo.id} proposal={todo} canDecide={canDecide} onReview={setReviewing} /> : row(proposal)
          })}
        </div>,
      )
    for (const item of accepted) {
      const key = item.from?.messageId && keys.has(item.from.messageId) ? item.from.messageId : last
      nodes.set(
        key,
        <>
          {nodes.get(key)}
          <div className="work-board-session-proposal" key={item.id}>
            <Button size="xs" variant="ghost" icon={ListTodo} onClick={() => shell.openWorkItem(item.id)}>
              {escapeSecurityText(item.title)}
            </Button>
          </div>
        </>,
      )
    }
    if (hasUnconfirmed)
      nodes.set(
        last,
        <>
          {nodes.get(last)}
          <ProposalRecovery
            snapshot={shell.snapshot}
            writes={writes}
            sessionId={sessionId}
            onAccepted={ids => {
              if (ids[0]) shell.openWorkItem(ids[0])
            }}
          />
        </>,
      )
    if (reviewing?.from.sessionId === sessionId && !shell.board)
      nodes.set(
        last,
        <>
          {nodes.get(last)}
          <ProposalReview
            proposal={reviewing}
            writes={writes}
            shell={shell}
            team={
              shell.catalog?.features?.teams && canDecide && canStartTeam(detail.summary, shell.snapshot.teams)
                ? {
                    lead: detail.summary,
                    catalog: shell.catalog,
                    deviceId: shell.snapshot.device.id,
                    access: shell.access,
                    refresh: shell.refresh,
                  }
                : undefined
            }
            onClose={() => {
              setReviewing(null)
            }}
          />
        </>,
      )
    return nodes
  }
}
