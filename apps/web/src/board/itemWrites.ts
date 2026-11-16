import { useCallback, useRef, useState } from 'react'
import type { WorkItemPatchInput, WorkItemStartAnswer, WorkItemSummary } from '@latch/protocol'
import { api, ApiError, errorMessage, newRequestId } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import { unconfirmedReason } from '../core/sendingMessage.ts'

/** A write to one 待办 from its card, kept as sent until the Host answers it for certain. */
interface ItemRequest {
  kind: 'start' | 'patch' | 'delete'
  path: string
  method: 'POST' | 'PATCH' | 'DELETE'
  body: Record<string, unknown>
}

/**
 * What a card shows of its own write: `sending`; `unknown`, the Host's answer did not arrive (重试 sends the same request,
 * a start with the same requestId); `refused`, the Host said no, with its reason.
 */
export type ItemWriteState =
  | { state: 'sending'; kind: ItemRequest['kind'] }
  | { state: 'unknown'; kind: ItemRequest['kind']; reason: string }
  | { state: 'refused'; kind: ItemRequest['kind']; reason: string; code?: string }

export type ItemWriteResult = { ok: true; sessionId?: string } | { ok: false; reason?: string; unknown?: true }

/** The Host already holds what an uncertain edit or delete asked for, or moved on: the snapshot says which. */
const settledOnRetry = (cause: unknown) => cause instanceof ApiError && (cause.code === 'item-changed' || cause.code === 'item-not-found')

/**
 * The board's writes to 待办 outside 新建: 开始 with its stored choices, 全部开始, 完成, priority, tags, edits and
 * delete. One unconfirmed write per 待办; it is retried as it was sent and never replaced by a new one meanwhile.
 */
export function useItemWrites(refresh: () => Promise<void>) {
  const [states, setStates] = useState<ReadonlyMap<string, ItemWriteState>>(() => new Map())
  const requests = useRef(new Map<string, ItemRequest>())
  const flights = useRef(new Set<string>())
  const set = (id: string, state: ItemWriteState | undefined) => {
    setStates(previous => {
      const next = new Map(previous)
      if (state) next.set(id, state)
      else next.delete(id)
      return next
    })
  }

  const send = useCallback(
    async (id: string, request: ItemRequest, retry = false): Promise<ItemWriteResult> => {
      if (flights.current.has(id)) return { ok: false }
      flights.current.add(id)
      requests.current.set(id, request)
      set(id, { state: 'sending', kind: request.kind })
      try {
        // Starting binds a Harness saved before confirmations on this Mac: the same request goes again once confirmed.
        const answer = await withConfirmation(confirmation =>
          api<Partial<WorkItemStartAnswer>>(request.path, {
            method: request.method,
            body: request.body,
            ...(confirmation ? { confirmation } : {}),
          }),
        )
        requests.current.delete(id)
        set(id, undefined)
        await refresh()
        return { ok: true, ...(answer.sessionId ? { sessionId: answer.sessionId } : {}) }
      } catch (cause) {
        if (retry && request.kind !== 'start' && settledOnRetry(cause)) {
          requests.current.delete(id)
          set(id, undefined)
          await refresh()
          return { ok: true }
        }
        const reason = unconfirmedReason(cause)
        if (reason !== null) {
          set(id, { state: 'unknown', kind: request.kind, reason })
          return { ok: false, reason, unknown: true }
        }
        requests.current.delete(id)
        const refused = errorMessage(cause)
        set(id, { state: 'refused', kind: request.kind, reason: refused, ...(cause instanceof ApiError ? { code: cause.code } : {}) })
        // A refusal for a 待办 changed elsewhere: the card shows it as it now is.
        if (settledOnRetry(cause)) await refresh()
        return { ok: false, reason: refused }
      } finally {
        flights.current.delete(id)
      }
    },
    [refresh],
  )

  /**
   * Starts a session from the 待办 with what it holds: its prompt, project, Harness, model and worktree, at the revision
   * this page shows. A 待办 changed since is refused (409 `item-changed`) and nothing starts; its card reads it again.
   */
  const start = useCallback(
    (item: Pick<WorkItemSummary, 'id' | 'revision'>) =>
      send(item.id, {
        kind: 'start',
        path: `work/items/${encodeURIComponent(item.id)}/start`,
        method: 'POST',
        body: { requestId: newRequestId(), baseRevision: item.revision },
      }),
    [send],
  )

  const patch = useCallback(
    (item: Pick<WorkItemSummary, 'id' | 'revision'>, change: Omit<WorkItemPatchInput, 'baseRevision'>) =>
      send(item.id, {
        kind: 'patch',
        path: `work/items/${encodeURIComponent(item.id)}`,
        method: 'PATCH',
        body: { baseRevision: item.revision, ...change },
      }),
    [send],
  )

  const remove = useCallback(
    (item: Pick<WorkItemSummary, 'id' | 'revision'>) =>
      send(item.id, {
        kind: 'delete',
        path: `work/items/${encodeURIComponent(item.id)}`,
        method: 'DELETE',
        body: { baseRevision: item.revision },
      }),
    [send],
  )

  /** 重试: the request as it was sent, a start with its own requestId. */
  const retry = useCallback(
    (id: string) => {
      const request = requests.current.get(id)
      return request ? send(id, request, true) : Promise.resolve<ItemWriteResult>({ ok: false })
    },
    [send],
  )

  /** 放弃 an unknown write, or put a refusal away: this device stops waiting; the Host keeps what it did. */
  const dismiss = useCallback((id: string) => {
    if (flights.current.has(id)) return
    requests.current.delete(id)
    set(id, undefined)
  }, [])

  const [startingAll, setStartingAll] = useState(false)
  /**
   * 全部开始: one start after another, in the column's order, each with what its 待办 holds. The first that is refused or
   * not answered stops the rest; its card says why.
   */
  const startAll = useCallback(
    async (items: readonly Pick<WorkItemSummary, 'id' | 'revision'>[], onStarted?: (itemId: string, sessionId: string) => void) => {
      if (startingAll) return
      setStartingAll(true)
      try {
        for (const item of items) {
          if (requests.current.has(item.id)) break
          const result = await start(item)
          if (!result.ok) break
          if (result.sessionId) onStarted?.(item.id, result.sessionId)
        }
      } finally {
        setStartingAll(false)
      }
    },
    [start, startingAll],
  )

  return { states, start, startAll, startingAll, patch, remove, retry, dismiss }
}

export type ItemWrites = ReturnType<typeof useItemWrites>
