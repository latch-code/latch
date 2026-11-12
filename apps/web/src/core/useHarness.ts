import { useCallback, useEffect, useRef, useState } from 'react'
import { publishAppData, publishAppUpdated } from './appEvents.ts'
import type { AppSnapshot, ChangeEvent, TaskDetail } from '@latch/protocol'
import { api, ApiError, errorMessage, setAuthHooks } from './api.ts'
import { browserRenewal, RenewalScheduler } from './credentials.ts'
import type { EnrolledResult } from './enrollment.ts'
import { connectEventStream, type EventStreamConnection } from './eventStream.ts'
import { noticeOf, parseHostState, type HostNotice } from './hostState.ts'
import { hostView } from './permissions.ts'
import { observeHostTime } from './hostClock.ts'
import { mergeTaskSnapshot, parseTaskState, ProjectionGuard, type ProjectionTicket } from './projection.ts'
import type { EnrollmentReason } from './securityCopy.ts'
import { currentShell } from './shell.ts'
import { readStorage } from './storageKeys.ts'

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline'
type SyncMode = 'list' | 'all'

/** Why the page needs (re-)enrollment, plus the old device name for the legacy re-confirmation page. */
export interface AuthState {
  reason: EnrollmentReason
  legacyName?: string
}

/** The Host no longer has this session, e.g. another device deleted it; this is not a connection failure. */
export const isMissingTask = (cause: unknown) => cause instanceof ApiError && cause.status === 404 && cause.code === 'task-not-found'

const ENROLLMENT_CODES = new Set<string>(['unauthorized', 'device-revoked', 'credential-expired', 'listener-mismatch', 'legacy-reconfirm'])

export { renewalFailureOf } from './credentials.ts'

/** A 401 from the Host mapped to the enrollment page it leads to. Renewal failures map to their cause. */
export function authStateFor(error: ApiError, renewalFailure: EnrollmentReason | null): AuthState {
  if (error.code === 'legacy-reconfirm') {
    const name = typeof error.details.legacyName === 'string' ? error.details.legacyName : undefined
    return { reason: 'legacy-reconfirm', ...(name ? { legacyName: name } : {}) }
  }
  if (error.code === 'renewal-required') return { reason: renewalFailure ?? 'unauthorized' }
  return { reason: ENROLLMENT_CODES.has(error.code) ? (error.code as EnrollmentReason) : 'unauthorized' }
}

/**
 * HTTP establishes authority; streamed state replaces only the selected slice. A tab opens on the session it last showed
 * (a reload); a cold start opens on 新会话.
 */
export function useHarness() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [connection, setConnection] = useState<ConnectionStatus>('connecting')
  /** The Host said it is stopping or the computer is going to sleep; cleared once the Host answers again. */
  const [hostNotice, setHostNotice] = useState<HostNotice | null>(null)
  const noticeRef = useRef<HostNotice | null>(null)
  const publishNotice = useCallback((next: HostNotice | null) => {
    noticeRef.current = next
    setHostNotice(next)
  }, [])
  /** Set each time the selected session disappears from the Host. */
  const [removed, setRemoved] = useState<{ sessionId: string } | null>(null)
  /**
   * Counts the snapshots that replaced the state wholesale (the first load, a reconnect, a tab shown again) rather than
   * bringing a change as it happened. The page plays its one-shot indicators only for changes made in neither.
   */
  const [resyncs, setResyncs] = useState(0)
  const [refreshHints, setRefreshHints] = useState(0)
  const guard = useRef(new ProjectionGuard())
  const latestSnapshot = useRef<AppSnapshot | null>(null)
  const latestDetail = useRef<TaskDetail | null>(null)
  const restoredDevice = useRef<string | null>(null)
  const alive = useRef(true)
  const running = useRef<Promise<boolean> | null>(null)
  const pending = useRef<SyncMode | null>(null)
  /** Whether a queued synchronization re-establishes state instead of following a change; merged requests keep it. */
  const pendingResync = useRef(false)
  const request = useRef<AbortController | null>(null)
  const activeStream = useRef<{ stream: EventStreamConnection; ticket: ProjectionTicket } | null>(null)
  /** Renews and then reloads state; set once synchronize exists. */
  const retryRenewal = useRef<() => void>(() => {})
  /** `failure`: why the latest renewal attempt failed, when only re-enrollment fixes it; every snapshot clears it. */
  const [renewal] = useState(
    () =>
      new RenewalScheduler({
        renew: identity => browserRenewal().renew(identity),
        retry: () => {
          retryRenewal.current()
        },
      }),
  )
  const signedOut = useRef(false)
  const lastSyncFailure = useRef<unknown>(null)

  const publishDetail = useCallback((next: TaskDetail | null) => {
    latestDetail.current = next
    setDetail(next)
  }, [])
  const publishSnapshot = useCallback((next: AppSnapshot | null, resync: boolean) => {
    latestSnapshot.current = next
    setSnapshot(next)
    if (resync) setResyncs(count => count + 1)
  }, [])
  const storeSelection = useCallback((id: string | null) => {
    if (restoredDevice.current === null) return
    const key = `latch.selected.${location.origin}.${restoredDevice.current}`
    try {
      if (id === null) sessionStorage.removeItem(key)
      else sessionStorage.setItem(key, id)
    } catch {
      /* Selection stays functional when storage is unavailable. */
    }
  }, [])

  const signOut = useCallback(
    (state: AuthState) => {
      // A retry left over from before must not replace the reason shown on the enrollment page.
      signedOut.current = true
      renewal.stop()
      setAuth(state)
      publishSnapshot(null, true)
      publishDetail(null)
      restoredDevice.current = null
      guard.current.invalidate()
      guard.current.bind(null)
      guard.current.select(null)
      setSelectedId(null)
    },
    [publishDetail, publishSnapshot, renewal],
  )

  /**
   * Browsers rotate their own credential; the desktop shell renews in its main process. True when the page should
   * reload state: renewed here, by another tab, or no longer due. Concurrent triggers share one attempt, and during the
   * wait after a transient failure they leave the renewal to the scheduled retry.
   */
  const renew = useCallback(async (): Promise<boolean> => {
    if (currentShell()) return false
    const current = latestSnapshot.current
    const host = current ? hostView(current) : undefined
    if (current && !host) return false
    return renewal.renew(host ? { hostId: host.hostId, deviceId: current!.device.id } : {})
  }, [renewal])

  /** `resync`: the request re-establishes state (first load, reconnect) rather than following a change. */
  const synchronize = useCallback(
    (mode: SyncMode, resync = false): Promise<boolean> => {
      pendingResync.current = (pending.current !== null && pendingResync.current) || resync
      pending.current = pending.current === 'all' || mode === 'all' ? 'all' : 'list'
      if (running.current) return running.current
      const task = async () => {
        let synchronized = false
        while (pending.current && alive.current) {
          const currentMode = pending.current
          const currentResync = pendingResync.current
          pending.current = null
          pendingResync.current = false
          const ticket = guard.current.capture()
          const controller = new AbortController()
          request.current = controller
          try {
            const next = await api<AppSnapshot>('snapshot', { signal: controller.signal })
            observeHostTime(next.hostTime)
            if (!alive.current || !guard.current.current(ticket)) continue
            guard.current.bind(next.instanceId)
            signedOut.current = false
            setAuth(null)
            setError('')
            renewal.failure = null
            lastSyncFailure.current = null
            if (restoredDevice.current !== next.device.id) {
              guard.current.invalidate()
              restoredDevice.current = next.device.id
              // Selection still works without browser storage, which reads as nothing selected.
              const restored = readStorage('sessionStorage', `latch.selected.${location.origin}.${next.device.id}`)
              const initial = restored !== null && next.tasks.some(task => task.id === restored) ? restored : null
              guard.current.select(initial)
              setSelectedId(initial)
              publishDetail(null)
            }
            publishSnapshot(mergeTaskSnapshot(next, latestDetail.current), currentResync)
            // A list-only change that drops the selection is confirmed by the detail request below.
            if (currentMode === 'list' && guard.current.sessionId !== null && !next.tasks.some(task => task.id === guard.current.sessionId))
              pending.current = 'all'
            if (currentMode === 'all') {
              const detailTicket = guard.current.capture()
              if (detailTicket.sessionId !== null) {
                const nextDetail = await api<TaskDetail>(`tasks/${encodeURIComponent(detailTicket.sessionId)}`, {
                  signal: controller.signal,
                }).catch((cause: unknown) => {
                  if (isMissingTask(cause)) return null
                  throw cause
                })
                if (!alive.current || !guard.current.current(detailTicket)) continue
                if (nextDetail === null) {
                  guard.current.select(null)
                  publishDetail(null)
                  setSelectedId(null)
                  storeSelection(null)
                  setRemoved({ sessionId: detailTicket.sessionId })
                } else if (guard.current.accept(detailTicket, nextDetail)) {
                  publishDetail(nextDetail)
                  if (latestSnapshot.current) publishSnapshot(mergeTaskSnapshot(latestSnapshot.current, nextDetail), currentResync)
                }
              } else publishDetail(null)
              synchronized = true
              const active = activeStream.current
              if (active && guard.current.current(active.ticket) && active.stream.open && navigator.onLine) setConnection('connected')
            }
          } catch (cause) {
            if (!alive.current || controller.signal.aborted) continue
            synchronized = false
            lastSyncFailure.current = cause
            const renewalPending = cause instanceof ApiError && cause.code === 'renewal-required' && renewal.failure === null
            if (cause instanceof ApiError && cause.status === 401 && !renewalPending) signOut(authStateFor(cause, renewal.failure))
            else {
              // Includes a renewal that failed for a transient reason: retry with the connection, not re-enrollment.
              setError(errorMessage(cause))
              setConnection(navigator.onLine ? 'reconnecting' : 'offline')
            }
          } finally {
            if (request.current === controller) request.current = null
            if (alive.current) setLoading(false)
          }
        }
        return synchronized
      }
      running.current = task().finally(() => {
        running.current = null
      })
      return running.current
    },
    [publishDetail, publishSnapshot, storeSelection, signOut, renewal],
  )

  /** Reloads state after something this page did, as a change it follows. */
  const refresh = useCallback(async (): Promise<void> => {
    await synchronize('all')
  }, [synchronize])
  /** Reloads state when the person asks to sync the latest state: a resynchronization. */
  const resync = useCallback(async (): Promise<void> => {
    await synchronize('all', true)
  }, [synchronize])
  // A cause that needs re-enrollment is acted on by the snapshot, which then signs out.
  useEffect(() => {
    retryRenewal.current = () => {
      if (signedOut.current) return
      void renew().then(ok => {
        if (!signedOut.current && (ok || renewal.failure !== null)) void synchronize('all', true)
      })
    }
  }, [renew, synchronize, renewal])
  /** The first snapshot after `complete`: a 401 then means the browser did not keep the new cookie. */
  const confirmEnrollment = useCallback(async (): Promise<EnrolledResult> => {
    if (await synchronize('all', true)) return { status: 'connected' }
    const cause = lastSyncFailure.current
    if (cause instanceof ApiError && cause.status === 401 && cause.code === 'unauthorized') {
      signOut({ reason: 'credential-not-stored' })
      return { status: 'credential-not-stored' }
    }
    return { status: 'failed', message: errorMessage(cause) }
  }, [synchronize, signOut])
  const select = useCallback(
    (id: string | null) => {
      if (id !== guard.current.sessionId) {
        guard.current.select(id)
        request.current?.abort()
        publishDetail(null)
        setSelectedId(id)
      }
      storeSelection(id)
      void synchronize('all')
    },
    [synchronize, publishDetail, storeSelection],
  )

  useEffect(
    () =>
      setAuthHooks({
        renew,
        // Any request can learn that this device lost its credential; the snapshot decides where the page goes.
        unauthorized: () => {
          if (latestSnapshot.current !== null) void synchronize('all', true)
        },
      }),
    [renew, synchronize],
  )

  useEffect(() => {
    alive.current = true
    void synchronize('all', true)
    const recoverInitialConnection = () => {
      if (latestSnapshot.current === null) {
        setConnection('connecting')
        void synchronize('all', true)
      }
    }
    window.addEventListener('online', recoverInitialConnection)
    return () => {
      alive.current = false
      guard.current.invalidate()
      request.current?.abort()
      renewal.stop()
      window.removeEventListener('online', recoverInitialConnection)
    }
  }, [synchronize, renewal])

  // Browsers renew at `renewAfter` (and on any 401 renewal-required); a hidden tab catches up when shown.
  const renewAfter = snapshot && hostView(snapshot) && !currentShell() ? snapshot.device.renewAfter : null
  useEffect(() => {
    if (renewAfter === null) return
    const due = Date.parse(renewAfter)
    if (!Number.isFinite(due)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = () => {
      retryRenewal.current()
    }
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(run, Math.min(Math.max(0, due - Date.now()), 2 ** 31 - 1))
    }
    const visible = () => {
      if (document.visibilityState === 'visible' && Date.now() >= due) run()
    }
    schedule()
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [renewAfter])

  const identity = snapshot === null ? null : `${snapshot.instanceId}:${snapshot.device.id}`
  useEffect(() => {
    if (identity === null) return
    let disposed = false
    let openGeneration = 0
    const ticket = guard.current.capture()
    const query = ticket.sessionId === null ? '' : `?sessionId=${encodeURIComponent(ticket.sessionId)}`
    setConnection(navigator.onLine ? 'connecting' : 'offline')
    const syncConnection = () => {
      const attempt = ++openGeneration
      void synchronize('all', true).then(ok => {
        if (!disposed && attempt === openGeneration && guard.current.current(ticket) && ok && stream.open && navigator.onLine) {
          setConnection('connected')
          publishNotice(null)
        }
      })
    }
    /** The Host's own word on why it stops answering decides when to try again and what the page says meanwhile. */
    const hostState = (data: string) => {
      const event = parseHostState(data)
      if (!event || event.instanceId !== guard.current.instanceId) return
      const notice = noticeOf(event)
      if (notice === null) {
        publishNotice(null)
        syncConnection()
        return
      }
      openGeneration++
      publishNotice(notice)
      setConnection(navigator.onLine ? 'reconnecting' : 'offline')
      stream.deferReconnect(notice.retryAfter * 1000)
    }
    const invalidate = (data: string) => {
      if (disposed || !guard.current.current(ticket)) return
      try {
        const event = JSON.parse(data) as ChangeEvent
        if (event.instanceId !== guard.current.instanceId) {
          syncConnection()
          return
        }
        if (!Number.isSafeInteger(event.revision)) return
        if (event.type === 'refresh') setRefreshHints(value => value + 1)
        if (event.revision <= (latestSnapshot.current?.revision ?? -1)) return
        void synchronize(event.type === 'tasks-invalidated' ? 'list' : 'all')
      } catch {
        /* Malformed events cannot replace browser state. */
      }
    }
    const stream = connectEventStream(`/link/api/events${query}`, {
      onOpen: syncConnection,
      onEvent: message => {
        if (disposed) return
        if (message.event === 'task-state') {
          const event = parseTaskState(message.data)
          observeHostTime(event?.detail.sync?.hostTime)
          if (!event || !guard.current.accept(ticket, event.detail, 'stream')) return
          publishDetail(event.detail)
          if (latestSnapshot.current) publishSnapshot(mergeTaskSnapshot(latestSnapshot.current, event.detail), false)
        } else if (message.event === 'refresh' || message.event === 'tasks-invalidated') invalidate(message.data)
        else if (message.event === 'host-state') hostState(message.data)
        else if (message.event === 'app.data') publishAppData(message.data, guard.current.instanceId ?? undefined)
        // A plugin's pages changed: the snapshot names the new revision and bundle, and open frames rebuild from it.
        else if (message.event === 'app.updated' && publishAppUpdated(message.data, guard.current.instanceId ?? undefined))
          void synchronize('all')
      },
      onError: () => {
        if (disposed) return
        openGeneration++
        setConnection(navigator.onLine ? 'reconnecting' : 'offline')
        // After an announced stop the Host is known to be away; the next attempt comes when it said to try again. Only a
        // connection that failed waits like this: onUnauthorized clears the notice once the Host answers with a 401.
        if (navigator.onLine && noticeRef.current === null) void synchronize('all', true)
      },
      // Otherwise onError's snapshot decides between re-enrollment and a transient failure, after the backoff. A 401
      // means the Host is answering again, so an announcement it made before no longer holds that snapshot back.
      onUnauthorized: async code => {
        if (disposed) return 'stop'
        if (code === 'renewal-required' && (await renew())) return 'renewed'
        if (!disposed && noticeRef.current !== null) publishNotice(null)
        return 'retry'
      },
    })
    activeStream.current = { stream, ticket }
    // Offline emulation and some networks keep an open response streaming; the authority is fetched again on reconnect.
    const offline = () => {
      openGeneration++
      setConnection('offline')
      request.current?.abort()
      stream.suspend()
    }
    const online = () => {
      setConnection('reconnecting')
      stream.reconnect()
      syncConnection()
    }
    const visible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        stream.reconnect()
        syncConnection()
      }
    }
    const metadataTimer = setInterval(() => {
      if (!document.hidden && navigator.onLine) void synchronize('all')
    }, 30_000)
    window.addEventListener('offline', offline)
    window.addEventListener('online', online)
    document.addEventListener('visibilitychange', visible)
    return () => {
      disposed = true
      clearInterval(metadataTimer)
      openGeneration++
      stream.close()
      if (activeStream.current?.stream === stream) activeStream.current = null
      window.removeEventListener('offline', offline)
      window.removeEventListener('online', online)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [identity, selectedId, synchronize, publishDetail, publishSnapshot, publishNotice, renew])

  return {
    snapshot,
    detail,
    selectedId,
    select,
    refresh,
    resync,
    confirmEnrollment,
    auth,
    loading,
    connection,
    hostNotice,
    error,
    removed,
    resyncs,
    refreshHints,
  }
}
