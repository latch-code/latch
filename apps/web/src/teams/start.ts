import { useCallback, useEffect, useRef, useState } from 'react'
import type { TeamAnswer, TeamStartInput, TeamSummary } from '@latch/protocol'
import { api, ApiError, errorMessage, newRequestId } from '../core/api.ts'
import { unconfirmedReason } from '../core/sendingMessage.ts'
import type { TeamMode, TeamRow } from './model.ts'

/**
 * What a person wrote for a session's team and has not started, and a start whose answer never came. Kept in this
 * page's memory only, by device and session (or proposal): closing the panel or opening another session keeps it, a
 * reload does not, and nothing of it is written to the browser's storage.
 */
const drafts = new Map<string, TeamRow[]>()
const unanswered = new Map<string, TeamStartInput>()
/** The way the person last split a session's work, while that session offers more than one. */
const modes = new Map<string, TeamMode>()
const KEPT = 64

function keep<T>(store: Map<string, T>, key: string, value: T | undefined): void {
  store.delete(key)
  if (value === undefined) return
  store.set(key, value)
  // The oldest go first.
  for (const old of store.keys()) {
    if (store.size <= KEPT) break
    store.delete(old)
  }
}

export const draftKey = (deviceId: string, sessionId: string) => `${deviceId}\n${sessionId}`

/** The rows of a session's list; `initial` fills a list nobody wrote yet. */
export function useTeamDraft(key: string, initial: () => TeamRow[]): [TeamRow[], (rows: TeamRow[] | undefined) => void] {
  const [rows, setRows] = useState<TeamRow[]>(() => drafts.get(key) ?? initial())
  const fill = useRef(initial)
  fill.current = initial
  const write = useCallback(
    (next: TeamRow[] | undefined) => {
      keep(drafts, key, next)
      setRows(next ?? fill.current())
    },
    [key],
  )
  return [rows, write]
}

/** How the list of a session is worked; `sessions` until the person picks otherwise in this page. */
export function useTeamMode(key: string): [TeamMode, (mode: TeamMode) => void] {
  const [mode, setMode] = useState<TeamMode>(() => modes.get(key) ?? 'sessions')
  const write = useCallback(
    (next: TeamMode) => {
      keep(modes, key, next)
      setMode(next)
    },
    [key],
  )
  return [mode, write]
}

export type TeamStartState =
  | { state: 'idle' }
  | { state: 'sending' }
  /** No answer came: the same request is what 重试 sends, so the Host starts nothing twice. */
  | { state: 'unknown'; reason: string }
  | { state: 'refused'; reason: string; code?: string }

/**
 * Starts a team of `sessionId`. A start that got no answer is kept as it was sent and sent again unchanged (same
 * `requestId`, same content: the Host answers the same team); only a refusal lets a new request be made.
 */
export function useTeamStart(key: string, sessionId: string, refresh: () => Promise<void>) {
  const [status, setStatus] = useState<TeamStartState>(() => (unanswered.has(key) ? { state: 'unknown', reason: '' } : { state: 'idle' }))
  const flying = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const set = (next: TeamStartState) => {
    if (alive.current) setStatus(next)
  }
  const start = useCallback(
    async (body: Omit<TeamStartInput, 'requestId'>): Promise<TeamSummary | undefined> => {
      if (flying.current) return undefined
      const request = unanswered.get(key) ?? { requestId: newRequestId(), ...body }
      flying.current = true
      keep(unanswered, key, request)
      set({ state: 'sending' })
      try {
        const { team } = await api<TeamAnswer>(`tasks/${encodeURIComponent(sessionId)}/team`, { method: 'POST', body: request })
        keep(unanswered, key, undefined)
        await refresh().catch(() => {})
        set({ state: 'idle' })
        return team
      } catch (cause) {
        const reason = unconfirmedReason(cause)
        if (reason !== null) {
          set({ state: 'unknown', reason })
          return undefined
        }
        keep(unanswered, key, undefined)
        const code = cause instanceof ApiError ? cause.code : undefined
        set({ state: 'refused', reason: errorMessage(cause), ...(code ? { code } : {}) })
        // What the person read is no longer what the Host holds, or the session's state moved on: read it again.
        if (code === 'proposal-changed' || code === 'proposal-decided' || code === 'team-open' || code === 'team-lead')
          await refresh().catch(() => {})
        return undefined
      } finally {
        flying.current = false
      }
    },
    [key, sessionId, refresh],
  )
  /** Gives up a start that got no answer: the list can be edited again, and the next start is a new request. */
  const forget = useCallback(() => {
    if (flying.current) return
    keep(unanswered, key, undefined)
    set({ state: 'idle' })
  }, [key])
  return { status, start, forget }
}

/** Stops a team: in flight until the Host answers; a failure comes back in words, for the page to say. */
export function useTeamStop(teamId: string, refresh: () => Promise<void>) {
  const [status, setStatus] = useState<{ state: 'idle' | 'sending' }>({ state: 'idle' })
  const request = useRef<string | undefined>(undefined)
  const flying = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const stop = useCallback(async (): Promise<string | undefined> => {
    if (flying.current) return undefined
    flying.current = true
    setStatus({ state: 'sending' })
    request.current ??= newRequestId()
    try {
      await api<TeamAnswer>(`teams/${encodeURIComponent(teamId)}/stop`, { method: 'POST', body: { requestId: request.current } })
      request.current = undefined
      await refresh().catch(() => {})
      return undefined
    } catch (cause) {
      // Unanswered: pressing again sends the same request.
      if (unconfirmedReason(cause) === null) request.current = undefined
      if (cause instanceof ApiError && (cause.code === 'team-ended' || cause.code === 'team-not-found')) await refresh().catch(() => {})
      return errorMessage(cause)
    } finally {
      flying.current = false
      if (alive.current) setStatus({ state: 'idle' })
    }
  }, [teamId, refresh])
  return { status, stop }
}
