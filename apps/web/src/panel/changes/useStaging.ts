import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  readsProjectFiles,
  type AppSnapshot,
  type GitDeliveryState,
  type GitHunkBase,
  type GitHunkDiff,
  type GitStageLinesResult,
  type GitStagingView,
  type TaskSummary,
} from '@latch/protocol'
import { api, ApiError, errorMessage, isUncertain, newRequestId } from '../../core/api.ts'
import { lineRefusal, retryEnds, selectionOf, STALE_CODES, type LinePick } from './staging.ts'

/** The Host gives a staging write two minutes; the page waits a little longer. */
const WAIT_MS = 150_000
/** 5xx answers that say the write never ran. */
const NOT_RUN = new Set(['git-receipt-unsaved', 'host-closing'])

export type StagingRead =
  | { kind: 'loading' }
  | { kind: 'ready'; state: GitDeliveryState }
  | { kind: 'denied' }
  | { kind: 'failed'; text: string }

/** A write whose answer never came: the retry sends the same request, body and all. */
export interface UnknownStaging {
  path: string
  url: string
  body: Record<string, unknown>
}

export interface StagingNote {
  path: string
  text: string
  tone: 'muted' | 'amber'
}

export type StagingEnd = 'done' | 'stale' | 'refused' | 'unknown'

interface StagingWriteState {
  busy?: string
  unknown?: UnknownStaging
  note?: StagingNote
}

/** The signed-in shell owns unanswered writes, so closing a panel cannot discard the request. */
export function useStagingWrites(summary: TaskSummary | undefined, { host, device }: Pick<AppSnapshot, 'host' | 'device'>) {
  const [sessions, setSessions] = useState<ReadonlyMap<string, StagingWriteState>>(new Map())
  const owner = JSON.stringify([host?.hostId, device.id])
  const authority = useRef({ owner })
  useLayoutEffect(() => {
    if (authority.current.owner === owner) return
    authority.current = { owner }
    setSessions(new Map())
  }, [owner])

  const sessionId = summary?.id
  const root = summary?.folders?.[0]?.path ?? summary?.cwd
  const key = readsProjectFiles(device.dataScope) && sessionId && root ? JSON.stringify([owner, sessionId, root]) : undefined
  const state = key ? sessions.get(key) : undefined
  const { busy, unknown, note } = state ?? {}
  const base = `tasks/${encodeURIComponent(sessionId ?? '')}/git`
  const remember = (id: string, write: StagingWriteState) => {
    setSessions(previous => {
      const next = new Map(previous)
      if (write.busy || write.unknown || write.note) next.set(id, write)
      else next.delete(id)
      return next
    })
  }

  const send = async (write: UnknownStaging, retrying = false): Promise<StagingEnd> => {
    if (!key || busy || (unknown && !retrying)) return 'refused'
    const originalAuthority = authority.current
    const finish = (state: StagingWriteState) => {
      if (authority.current === originalAuthority) remember(key, state)
    }
    remember(key, { busy: write.path, ...(retrying ? { unknown: write } : {}) })
    try {
      await api<GitStageLinesResult | { files: number }>(write.url, { method: 'POST', body: write.body, timeoutMs: WAIT_MS })
      finish({})
      return 'done'
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : ''
      if (!NOT_RUN.has(code) && (isUncertain(cause) || code === 'git-result-unknown')) {
        finish({ unknown: write })
        return 'unknown'
      }
      const details = cause instanceof ApiError ? cause.details : {}
      const stale = STALE_CODES.has(code)
      const keep = retrying && !retryEnds(code, details)
      finish({
        ...(keep ? { unknown: write } : {}),
        note: { path: write.path, text: lineRefusal(code, details) ?? errorMessage(cause), tone: stale ? 'muted' : 'amber' },
      })
      return stale ? 'stale' : 'refused'
    }
  }

  return {
    busy,
    unknown,
    note,
    writeLines: (kind: 'stage' | 'unstage', path: string, hunkBase: GitHunkBase, pick: LinePick) =>
      send({ path, url: `${base}/${kind}-lines`, body: { requestId: newRequestId(), path, base: hunkBase, ...selectionOf(pick) } }),
    writeWhole: (kind: 'stage' | 'unstage', path: string) =>
      send({ path, url: `${base}/${kind}`, body: { requestId: newRequestId(), paths: [path] } }),
    retry: () => (unknown ? send(unknown, true) : Promise.resolve<StagingEnd>('done')),
    abandon: () => {
      if (key && unknown && !busy) remember(key, {})
    },
  }
}

/** Read limits and open diffs only while a staging view is active. */
export function useStaging(
  sessionId: string,
  poke: string,
  offline: boolean,
  active: boolean,
  writes: ReturnType<typeof useStagingWrites>,
) {
  const base = `tasks/${encodeURIComponent(sessionId)}/git`
  const [read, setRead] = useState<StagingRead>({ kind: 'loading' })
  const [revision, setRevision] = useState(0)
  const reading = useRef(0)
  const reload = useCallback(async () => {
    const mine = ++reading.current
    try {
      const state = await api<GitDeliveryState>(base)
      if (mine !== reading.current) return
      setRead({ kind: 'ready', state })
    } catch (cause) {
      if (mine !== reading.current) return
      if (cause instanceof ApiError && cause.code === 'file-scope') setRead({ kind: 'denied' })
      else
        setRead(current =>
          current.kind === 'ready' || current.kind === 'denied' ? current : { kind: 'failed', text: errorMessage(cause) },
        )
    } finally {
      if (mine === reading.current) setRevision(value => value + 1)
    }
  }, [base])

  useEffect(() => {
    if (!active || offline || writes.busy) return undefined
    const back = () => {
      if (document.visibilityState === 'visible') void reload()
    }
    void reload()
    document.addEventListener('visibilitychange', back)
    window.addEventListener('focus', back)
    return () => {
      reading.current++
      document.removeEventListener('visibilitychange', back)
      window.removeEventListener('focus', back)
    }
  }, [reload, poke, offline, active, writes.busy])

  const diff = useCallback(
    (view: GitStagingView, path: string, signal: AbortSignal) =>
      api<GitHunkDiff>(`${base}/diff?${new URLSearchParams({ view, path }).toString()}`, { signal }),
    [base],
  )
  return {
    ...writes,
    read,
    revision,
    reload,
    diff,
    abandon: () => {
      writes.abandon()
      if (active && !offline && !writes.busy) void reload()
    },
  }
}
