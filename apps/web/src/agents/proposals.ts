import type { HarnessInfo, MemoryOrigin, MemoryProposal, Message } from '@latch/protocol'
import type { WriteState } from './useAgentWrites.ts'

/** Who a proposal or a memory came from, as its row says it. */
export function originWords(origin: MemoryOrigin): string {
  return origin === 'user' ? '你说的' : '它推断的'
}

/**
 * When a saved memory reaches the Agent: the built-in Harness reads memories again each turn; an external one gets them
 * only with a topic's first turn. Nothing else is claimed.
 */
export function effectWords(harness: Pick<HarnessInfo, 'agentContext'> | undefined): string {
  return harness?.agentContext === 'private' ? '已生效' : '从下一个话题起'
}

/**
 * The turn of `messages` a proposal belongs to: its user message by ID, or the person's message by its request. Undefined
 * when it is not among them (the row then follows the last turn).
 */
export function proposalTurn(proposal: Pick<MemoryProposal, 'source'>, messages: readonly Pick<Message, 'id' | 'role' | 'requestId'>[]) {
  const { messageId, requestId } = proposal.source
  const found =
    (messageId ? messages.find(message => message.role === 'user' && message.id === messageId) : undefined)
    ?? (requestId ? messages.find(message => message.role === 'user' && message.requestId === requestId) : undefined)
  return found?.id
}

/**
 * Where turn keys go in the transcript: each proposal of this session after its turn, '' before every turn, and those
 * whose turn is not shown after the last one.
 */
export function placeProposals(
  proposals: readonly MemoryProposal[],
  sessionId: string,
  messages: readonly Pick<Message, 'id' | 'role' | 'requestId'>[],
  turns: ReadonlyArray<{ key: string }>,
): Map<string, MemoryProposal[]> {
  const keys = new Set(turns.map(turn => turn.key))
  const last = turns.at(-1)?.key ?? ''
  const placed = new Map<string, MemoryProposal[]>()
  for (const proposal of proposals) {
    if (proposal.source.sessionId !== sessionId) continue
    const turn = proposalTurn(proposal, messages)
    const key = turn !== undefined && keys.has(turn) ? turn : last
    placed.set(key, [...(placed.get(key) ?? []), proposal])
  }
  return placed
}

/** A proposal row's state: the Host's, or this device's write to it while that write is unsettled or refused. */
export type ProposalRowState =
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'dismissing' }
  | { kind: 'saved' }
  | { kind: 'dismissed' }
  /** The result is unknown: retry the same request. */
  | { kind: 'unknown'; message: string; requestId: string }
  | { kind: 'failed'; message: string }

export function proposalRowState(proposal: Pick<MemoryProposal, 'id' | 'state'>, write: WriteState | null): ProposalRowState {
  if (proposal.state === 'saved') return { kind: 'saved' }
  if (proposal.state === 'dismissed') return { kind: 'dismissed' }
  if (!write || !write.write.key.startsWith(`proposal:${proposal.id}:`)) return { kind: 'pending' }
  const saving = write.write.key.endsWith(':save')
  if ('phase' in write) return write.phase === 'saving' ? { kind: saving ? 'saving' : 'dismissing' } : { kind: 'pending' }
  if (write.kind === 'unknown') return { kind: 'unknown', message: write.message, requestId: write.write.body.requestId }
  return { kind: 'failed', message: write.message }
}
