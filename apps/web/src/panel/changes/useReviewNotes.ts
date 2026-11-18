import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeScope, ReviewNote, ReviewNoteList, ReviewNoteSendResult, ReviewNoteSide } from '@latch/protocol'
import { api, errorMessage, isUncertain, newRequestId } from '../../core/api.ts'
import { CHANGE_WRITE_COPY } from './write.copy.ts'

interface NewNote {
  root: string
  path: string
  range: { start: number; end: number }
  side: ReviewNoteSide
  scope: ChangeScope
  turnId?: string
  lines: string[]
  text: string
}

/** A send the Host holds open without a queued item: its answer never came. Any device that may write retries or abandons it. */
export interface UnknownSend {
  id: string
  noteIds: string[]
}

export interface ReviewNoteActions {
  create(note: NewNote): Promise<boolean>
  edit(id: string, text: string): Promise<boolean>
  status(id: string, status: 'agent-claimed' | 'reviewed'): Promise<void>
  remove(id: string): Promise<void>
  /** `queue`: the session is running, so the message waits in its queue for the next turn. */
  send(noteIds: string[], queue?: boolean): Promise<void>
  /** Sends the open send's stored message again with the Host's own request ID; never a second message. */
  retrySend(): Promise<void>
  /** Returns the notes to pending once the Host confirms nothing of the send reached the session. */
  abandonSend(): Promise<void>
}

/**
 * The session's notes as the Host holds them, read again whenever the snapshot's count of them moves (any device's
 * write), when `poke` changes (a turn starting or ending sends a queued message), on reconnecting and after each write
 * here. Writes carry a request ID that a retry after an unknown answer reuses; nothing shows as done until the Host says so.
 */
export function useReviewNotes(sessionId: string, options: { enabled: boolean; revision: number; poke: string; offline: boolean }) {
  const { enabled, revision, poke, offline } = options
  const base = `tasks/${encodeURIComponent(sessionId)}/review-notes`
  const [notes, setNotes] = useState<ReviewNote[]>()
  const [open, setOpen] = useState<UnknownSend>()
  const [readError, setReadError] = useState<string>()
  const [failure, setError] = useState<{ cause: unknown }>()
  const error = failure && (isUncertain(failure.cause) ? CHANGE_WRITE_COPY.uncertain : errorMessage(failure.cause))
  const [busy, setBusy] = useState(false)
  const asked = useRef(0)
  /** Request IDs of writes whose answer never came, by what they did. */
  const unknown = useRef(new Map<string, string>())

  const load = useCallback(async () => {
    if (!enabled) return
    const mine = ++asked.current
    try {
      const list = await api<ReviewNoteList>(base)
      if (mine !== asked.current) return
      setNotes(list.notes)
      setReadError(undefined)
      const held = list.openSends?.find(send => !send.queueId)
      setOpen(held ? { id: held.id, noteIds: held.noteIds } : undefined)
    } catch (cause) {
      if (mine === asked.current) setReadError(errorMessage(cause))
    }
  }, [base, enabled])

  useEffect(() => {
    void load()
  }, [load, revision, poke])
  const wasOffline = useRef(offline)
  useEffect(() => {
    if (wasOffline.current && !offline) void load()
    wasOffline.current = offline
  }, [offline, load])
  const write = useCallback(
    async <T>(key: string, path: string, body: Record<string, unknown>): Promise<T | undefined> => {
      const requestId = unknown.current.get(key) ?? newRequestId()
      unknown.current.set(key, requestId)
      setBusy(true)
      setError(undefined)
      try {
        const answer = await api<T>(path, { method: 'POST', body: { ...body, requestId } })
        unknown.current.delete(key)
        return answer
      } catch (cause) {
        if (!isUncertain(cause)) unknown.current.delete(key)
        setError({ cause })
        return undefined
      } finally {
        await load()
        setBusy(false)
      }
    },
    [load],
  )

  /** One press of 发给 Agent or 重试: a new send keeps its request ID until the Host answers it. */
  const post = useCallback(
    async (path: string, body: Record<string, unknown>, key: string) => {
      await write<ReviewNoteSendResult>(key, path, body)
    },
    [write],
  )

  const actions: ReviewNoteActions = {
    async create(note) {
      const key = `create:${note.root}:${note.path}:${note.side}:${note.range.start}-${note.range.end}:${note.text}`
      return (await write<ReviewNote>(key, base, { ...note })) !== undefined
    },
    async edit(id, text) {
      return (await write<ReviewNote>(`edit:${id}:${text}`, `${base}/${id}/edit`, { text })) !== undefined
    },
    async status(id, status) {
      await write(`status:${id}:${status}`, `${base}/${id}/status`, { status })
    },
    async remove(id) {
      await write(`delete:${id}`, `${base}/${id}/delete`, {})
    },
    send: (noteIds, queue) =>
      post(`${base}/send`, { noteIds, ...(queue ? { queue: true } : {}) }, `send:${noteIds.join(',')}:${queue ? 'queue' : 'now'}`),
    async retrySend() {
      if (open) await post(`${base}/sends/${open.id}/retry`, {}, `retry:${open.id}`)
    },
    async abandonSend() {
      if (open) await post(`${base}/sends/${open.id}/abandon`, {}, `abandon:${open.id}`)
    },
  }

  return { notes, readError, error, busy, unknownSend: open, reload: load, actions }
}
