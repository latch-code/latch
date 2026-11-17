import { useCallback, useRef, useState } from 'react'
import {
  GENERAL_AGENT_ID,
  type AppSnapshot,
  type TaskSummary,
  type WorkProposalAnswer,
  type WorkProposalEntryEdit,
  type WorkProposalSummary,
} from '@latch/protocol'
import { api, ApiError, errorMessage, newRequestId } from '../core/api.ts'
import { unconfirmedReason } from '../core/sendingMessage.ts'

/**
 * Agents' proposals for the board as this device was given them (`AppSnapshot.workProposals`): pending ones only, a
 * private one only on a device with the full data scope. A proposal is never a 待办 and is never counted as one.
 */

export type TodoProposal = WorkProposalSummary & { kind: 'todo'; entries: NonNullable<WorkProposalSummary['entries']> }
export type ChangeProposal = WorkProposalSummary & { kind: 'change'; change: NonNullable<WorkProposalSummary['change']> }

export const todoProposals = (proposals: readonly WorkProposalSummary[]): TodoProposal[] =>
  proposals.filter((row): row is TodoProposal => row.kind === 'todo' && row.entries !== undefined)

/** The pending change for a card: its session's, or its 待办's. */
export function changeFor(
  proposals: readonly WorkProposalSummary[],
  target: { sessionId: string } | { itemId: string },
): ChangeProposal | undefined {
  return proposals.find(
    (row): row is ChangeProposal =>
      row.kind === 'change'
      && row.change?.state === 'pending'
      && ('sessionId' in target
        ? 'sessionId' in row.change.target && row.change.target.sessionId === target.sessionId
        : 'itemId' in row.change.target && row.change.target.itemId === target.itemId),
  )
}

export const pendingEntries = (proposal: TodoProposal) => proposal.entries.filter(entry => entry.state === 'pending')

/** Where a proposal or an accepted 待办 came from; the session is absent where this device may not learn it. */
export interface ProposalOrigin {
  from: { sessionId?: string | undefined; customAgentId?: string | undefined }
}

/** Who proposed it, in words: one of 我的 Agent by name, 通用, or the session's own title; just 「Agent」 when withheld. */
export function proposerName(
  proposal: ProposalOrigin,
  snapshot: Pick<AppSnapshot, 'customAgents' | 'tasks'>,
): { name: string; agent?: NonNullable<AppSnapshot['customAgents']>[number] | 'general'; session?: TaskSummary } {
  const session = snapshot.tasks.find(task => task.id === proposal.from.sessionId)
  const id = proposal.from.customAgentId
  if (id === GENERAL_AGENT_ID) return { name: '通用', agent: 'general', ...(session ? { session } : {}) }
  const agent = id ? snapshot.customAgents?.find(item => item.id === id) : undefined
  if (agent) return { name: agent.name, agent, ...(session ? { session } : {}) }
  if (proposal.from.sessionId === undefined && id === undefined) return { name: 'Agent' }
  return { name: session?.title || 'Code 会话', ...(session ? { session } : {}) }
}

/** A proposal's write as its card shows it: sending, or unknown (重试 sends the same request), or refused with why. */
export type ProposalWriteState =
  | { state: 'sending' }
  | { state: 'unknown'; reason: string }
  | { state: 'refused'; reason: string; code?: string }

interface ProposalRequest {
  path: string
  body: Record<string, unknown>
}

export type ProposalWriteResult = { ok: true; itemIds?: string[] } | { ok: false; reason?: string; unknown?: true }

/**
 * 接受 and 不要 for proposals, one unsettled write per proposal, retried as it was sent (same requestId) and never
 * replaced by another meanwhile. Each names the revision the person saw.
 */
export function useProposalWrites(refresh: () => Promise<void>) {
  const [states, setStates] = useState<ReadonlyMap<string, ProposalWriteState>>(() => new Map())
  const requests = useRef(new Map<string, ProposalRequest>())
  const flights = useRef(new Set<string>())
  const set = (id: string, state: ProposalWriteState | undefined) => {
    setStates(previous => {
      const next = new Map(previous)
      if (state) next.set(id, state)
      else next.delete(id)
      return next
    })
  }
  const send = useCallback(
    async (id: string, request: ProposalRequest): Promise<ProposalWriteResult> => {
      if (flights.current.has(id)) return { ok: false }
      flights.current.add(id)
      requests.current.set(id, request)
      set(id, { state: 'sending' })
      try {
        const answer = await api<WorkProposalAnswer>(request.path, { method: 'POST', body: request.body })
        requests.current.delete(id)
        set(id, undefined)
        await refresh()
        return { ok: true, ...(answer.itemIds ? { itemIds: answer.itemIds } : {}) }
      } catch (cause) {
        const reason = unconfirmedReason(cause)
        if (reason !== null) {
          set(id, { state: 'unknown', reason })
          return { ok: false, reason, unknown: true }
        }
        requests.current.delete(id)
        const refused = errorMessage(cause)
        set(id, { state: 'refused', reason: refused, ...(cause instanceof ApiError ? { code: cause.code } : {}) })
        if (cause instanceof ApiError && (cause.code === 'proposal-changed' || cause.code === 'proposal-decided')) await refresh()
        return { ok: false, reason: refused }
      } finally {
        flights.current.delete(id)
      }
    },
    [refresh],
  )
  const accept = useCallback(
    (proposal: Pick<WorkProposalSummary, 'id' | 'revision'>, entries?: WorkProposalEntryEdit[]) =>
      send(proposal.id, {
        path: `work/proposals/${encodeURIComponent(proposal.id)}/accept`,
        body: { requestId: newRequestId(), baseRevision: proposal.revision, ...(entries?.length ? { entries } : {}) },
      }),
    [send],
  )
  const dismiss = useCallback(
    (proposal: Pick<WorkProposalSummary, 'id' | 'revision'>, entries?: number[]) =>
      send(proposal.id, {
        path: `work/proposals/${encodeURIComponent(proposal.id)}/dismiss`,
        body: { requestId: newRequestId(), baseRevision: proposal.revision, ...(entries?.length ? { entries } : {}) },
      }),
    [send],
  )
  const retry = useCallback(
    (id: string) => {
      const request = requests.current.get(id)
      return request ? send(id, request) : Promise.resolve<ProposalWriteResult>({ ok: false })
    },
    [send],
  )
  const forget = useCallback((id: string) => {
    if (flights.current.has(id)) return
    requests.current.delete(id)
    set(id, undefined)
  }, [])
  return { states, accept, dismiss, retry, forget }
}

export type ProposalWrites = ReturnType<typeof useProposalWrites>
