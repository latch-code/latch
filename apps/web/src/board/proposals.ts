import { useCallback, useEffect, useRef, useState } from 'react'
import {
  GENERAL_AGENT_ID,
  containsSecret,
  type AppSnapshot,
  type TaskSummary,
  type WorkProposalAnswer,
  type WorkProposalEntryEdit,
  type WorkProposalSummary,
} from '@latch/protocol'
import { AGENT_SPACE_COPY } from '../agents/spaceCopy.ts'
import { api, ApiError, errorMessage, newRequestId } from '../core/api.ts'
import { harnessName } from '../core/harnessName.ts'
import { defineCopy } from '../core/i18n.ts'
import { unconfirmedReason } from '../core/sendingMessage.ts'
import { readStorage } from '../core/storageKeys.ts'
import { storageDeviceCurrent } from '../core/deviceStorageScope.ts'
import { holdsExcerpt } from '../core/sessionDrafts.ts'

const COPY = defineCopy(
  { codeSession: 'Code 会话', unanswered: '没有收到电脑的答复' },
  { codeSession: 'Code session', unanswered: 'The computer did not reply' },
)

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

/** A person's Agent by name, or a Code proposal's visible Harness and project. The session is for details and navigation. */
export function proposerName(
  proposal: ProposalOrigin,
  snapshot: Pick<AppSnapshot, 'catalog' | 'customAgents' | 'tasks'>,
): { name: string; agent?: NonNullable<AppSnapshot['customAgents']>[number] | 'general'; session?: TaskSummary } {
  const session = snapshot.tasks.find(task => task.id === proposal.from.sessionId)
  const id = proposal.from.customAgentId
  if (id === GENERAL_AGENT_ID) return { name: AGENT_SPACE_COPY.general, agent: 'general', ...(session ? { session } : {}) }
  const agent = id ? snapshot.customAgents?.find(item => item.id === id) : undefined
  if (agent) return { name: agent.name, agent, ...(session ? { session } : {}) }
  if (id || proposal.from.sessionId === undefined) return { name: 'Agent', ...(session ? { session } : {}) }
  const harness = session && snapshot.catalog?.harnesses.find(harness => harness.id === session.harnessId)
  const project = session?.workspaceId && snapshot.catalog?.workspaces.find(project => project.id === session.workspaceId)
  const name = [harness ? harnessName(harness) : undefined, project ? project.name : undefined].filter(Boolean).join(' · ')
  return { name: name || COPY.codeSession, ...(session ? { session } : {}) }
}

/** A proposal's write as its card shows it: sending, or unknown (重试 sends the same request), or refused with why. */
export type ProposalWriteState =
  | { state: 'sending'; sessionId?: string }
  | { state: 'unknown'; reason: string; sessionId?: string }
  | { state: 'refused'; reason: string; code?: string }

interface ProposalRequest {
  action: 'accept' | 'dismiss'
  body: Record<string, unknown>
  sessionId?: string
  private?: true
}

type ProposalTarget = Pick<WorkProposalSummary, 'id' | 'revision'> & Partial<Pick<WorkProposalSummary, 'from' | 'private'>>
const PROPOSAL_ID = /^wpp_[A-Za-z0-9_-]{22}$/u
const MAX_STORED = 256_000

function readRequests(key: string, deviceId: string, all: boolean): Map<string, ProposalRequest> {
  const stored = new Map<string, ProposalRequest>()
  try {
    if (!storageDeviceCurrent(location.origin, deviceId)) return stored
    const raw = readStorage('sessionStorage', key)
    if (!raw || raw.length > MAX_STORED || containsSecret(raw)) return stored
    const rows = JSON.parse(raw) as Array<[string, ProposalRequest]>
    for (const [id, request] of rows) {
      if (
        PROPOSAL_ID.test(id)
        && (request.action === 'accept' || request.action === 'dismiss')
        && typeof request.body?.requestId === 'string'
        && typeof request.body?.baseRevision === 'number'
        && (request.sessionId === undefined || typeof request.sessionId === 'string')
        && (request.private === undefined || (all && request.private === true))
      )
        stored.set(id, request)
    }
  } catch {
    // A tab can come back without its previous storage.
  }
  return stored
}

export type ProposalWriteResult = { ok: true; itemIds?: string[] } | { ok: false; reason?: string; unknown?: true }

/**
 * 接受 and 不要 for proposals, one unsettled write per proposal, retried as it was sent (same requestId) and never
 * replaced by another meanwhile. Each names the revision the person saw.
 */
export function useProposalWrites(refresh: () => Promise<void>, { device, tasks }: Pick<AppSnapshot, 'device' | 'tasks'>) {
  const key = `latch.board.proposals.${location.origin}.${device.id}`
  const all = device.dataScope === 'all'
  const [saved] = useState(() => readRequests(key, device.id, all))
  const [states, setStates] = useState<ReadonlyMap<string, ProposalWriteState>>(
    () =>
      new Map(
        [...saved].map(([id, request]) => [
          id,
          {
            state: 'unknown',
            reason: COPY.unanswered,
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          } satisfies ProposalWriteState,
        ]),
      ),
  )
  const requests = useRef(saved)
  const flights = useRef(new Set<string>())
  const authority = useRef({ all, tasks })
  authority.current = { all, tasks }
  const allowed = (request: ProposalRequest) =>
    authority.current.all
    || (!request.private && (!request.sessionId || authority.current.tasks.some(task => task.id === request.sessionId)))
  const save = useCallback(() => {
    try {
      if (!storageDeviceCurrent(location.origin, device.id)) return
      const rows = [...requests.current].filter(([, request]) => {
        const encoded = JSON.stringify(request)
        const edits = request.action === 'accept' ? (request.body.entries as WorkProposalEntryEdit[] | undefined) : undefined
        return allowed(request) && !containsSecret(encoded) && !edits?.some(edit => edit.prompt && holdsExcerpt(edit.prompt))
      })
      const raw = JSON.stringify(rows)
      if (rows.length && raw.length <= MAX_STORED) sessionStorage.setItem(key, raw)
      else sessionStorage.removeItem(key)
    } catch {
      // The current tab still has the requests if storage is unavailable.
    }
  }, [device.id, key])
  useEffect(() => {
    if (!all)
      for (const [id, request] of requests.current) {
        if (allowed(request)) continue
        requests.current.delete(id)
        set(id, undefined)
      }
    save()
  }, [all, tasks, save])
  const set = (id: string, state: ProposalWriteState | undefined) => {
    setStates(previous => {
      const next = new Map(previous)
      if (state) next.set(id, state)
      else next.delete(id)
      return next
    })
  }
  const send = useCallback(
    async (id: string, request: ProposalRequest, retry = false): Promise<ProposalWriteResult> => {
      const original = requests.current.get(id)
      if (flights.current.has(id) || (original !== undefined && original !== request))
        return { ok: false, ...(original ? { unknown: true } : {}) }
      if (!allowed(request)) return { ok: false }
      flights.current.add(id)
      requests.current.set(id, request)
      save()
      const source = request.sessionId ? { sessionId: request.sessionId } : {}
      set(id, { state: 'sending', ...source })
      try {
        const answer = await api<WorkProposalAnswer>(`work/proposals/${encodeURIComponent(id)}/${request.action}`, {
          method: 'POST',
          body: request.body,
        })
        requests.current.delete(id)
        save()
        set(id, undefined)
        await refresh().catch(() => {})
        if (!allowed(request)) return { ok: false }
        return { ok: true, ...(answer.itemIds ? { itemIds: answer.itemIds } : {}) }
      } catch (cause) {
        if (!allowed(request)) return { ok: false }
        const reason = unconfirmedReason(cause)
        if (reason !== null || retry) {
          const explanation = reason ?? errorMessage(cause)
          set(id, { state: 'unknown', reason: explanation, ...source })
          return { ok: false, reason: explanation, unknown: true }
        }
        requests.current.delete(id)
        save()
        const refused = errorMessage(cause)
        set(id, { state: 'refused', reason: refused, ...(cause instanceof ApiError ? { code: cause.code } : {}) })
        if (cause instanceof ApiError && (cause.code === 'proposal-changed' || cause.code === 'proposal-decided'))
          await refresh().catch(() => {})
        return { ok: false, reason: refused }
      } finally {
        flights.current.delete(id)
      }
    },
    [refresh, save],
  )
  const accept = useCallback(
    (proposal: ProposalTarget, entries?: WorkProposalEntryEdit[]) =>
      send(proposal.id, {
        action: 'accept',
        ...(proposal.from ? { sessionId: proposal.from.sessionId } : {}),
        ...(proposal.private ? { private: true } : {}),
        body: { requestId: newRequestId(), baseRevision: proposal.revision, ...(entries?.length ? { entries } : {}) },
      }),
    [send],
  )
  const dismiss = useCallback(
    (proposal: ProposalTarget, entries?: number[]) =>
      send(proposal.id, {
        action: 'dismiss',
        ...(proposal.from ? { sessionId: proposal.from.sessionId } : {}),
        ...(proposal.private ? { private: true } : {}),
        body: { requestId: newRequestId(), baseRevision: proposal.revision, ...(entries?.length ? { entries } : {}) },
      }),
    [send],
  )
  const retry = useCallback(
    (id: string) => {
      const request = requests.current.get(id)
      return request ? send(id, request, true) : Promise.resolve<ProposalWriteResult>({ ok: false })
    },
    [send],
  )
  const forget = useCallback(
    (id: string) => {
      if (flights.current.has(id)) return
      requests.current.delete(id)
      save()
      set(id, undefined)
    },
    [save],
  )
  return { states, accept, dismiss, retry, forget }
}

export type ProposalWrites = ReturnType<typeof useProposalWrites>
