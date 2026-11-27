import { useCallback, useEffect, useRef, useState } from 'react'
import { publishAppData, publishAppUpdated } from './appEvents.ts'
import type { AppSnapshot, ChangeEvent, TaskDetail } from '@latch/protocol'
import { api, ApiError, errorMessage, setAuthHooks } from './api.ts'
import { browserRenewal, RenewalScheduler } from './credentials.ts'
import type { EnrolledResult } from './enrollment.ts'
import { connectEventStream, type EventStreamConnection } from './eventStream.ts'
import { frameGate } from './frameGate.ts'
import { connectionFailure, noticeOf, parseHostState, type ConnectionFailure, type HostNotice } from './hostState.ts'
import { hostView } from './permissions.ts'
import { observeHostTime } from './hostClock.ts'
import { mergeTaskSnapshot, ProjectionGuard, type ProjectionTicket } from './projection.ts'
import { TaskStreamProjection } from './taskStream.ts'
import type { EnrollmentReason } from './securityCopy.ts'
import { currentShell } from './shell.ts'
import { readStorage } from './storageKeys.ts'
import { forgetStoredDrafts } from './sessionDrafts.ts'

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline'
type SyncMode = 'list' | 'all'
const streamAuthority = (snapshot: AppSnapshot) =>
  JSON.stringify([
    snapshot.instanceId,
    snapshot.host?.hostId,
    snapshot.device.id,
    snapshot.device.status,
    snapshot.device.listener,
    snapshot.device.dataScope,
    snapshot.device.scopes.toSorted(),
  ])

type DetailView = { detail: TaskDetail | null; cached: boolean }
const EMPTY_DETAIL: DetailView = { detail: null, cached: false }

/** Why the page needs (re-)enrollment, plus the old device name for the legacy re-confirmation page. */
export interface AuthState {
  reason: EnrollmentReason
  legacyName?: string
}

/** The Host no longer has this session, e.g. another device deleted it; this is not a connection failure. */
/** A session the Host answers 404 for is gone only when the same answer's listing was whole (`tasksComplete`). */
export const missingMeansDeleted = (snapshot: Pick<AppSnapshot, 'tasksComplete'>): boolean => snapshot.tasksComplete === true
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

/** How often, at most, text-only frames redraw the session list (its times are all they change there). */
const BODY_LIST_PACE_MS = 1000

/**
 * HTTP establishes authority; streamed state replaces only the selected slice. A tab opens on the session it last showed
 * (a reload); a cold start opens on 新会话.
 */
export function useHarness() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [detailView, setDetailView] = useState(EMPTY_DETAIL)
  const [confirmedDetailRead, setConfirmedDetailRead] = useState<{ sessionId: string; pass: number } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [pageError, setPageError] = useState<{ cause: unknown } | null>(null)
  const [failure, setFailure] = useState<ConnectionFailure | null>(null)
  const [loading, setLoading] = useState(true)
  const [connection, setConnection] = useState<ConnectionStatus>('connecting')
  /** The Host said it is stopping or the computer is going to sleep; cleared once the Host answers again. */
  const [hostNotice, setHostNotice] = useState<HostNotice | null>(null)
  const noticeRef = useRef<HostNotice | null>(null)
  const publishNotice = useCallback((next: HostNotice | null) => {
    noticeRef.current = next
    setHostNotice(next)
  }, [])
  /** Set when the selected session disappears from this device's projection. */
  const [removed, setRemoved] = useState<{ sessionId: string; deleted: boolean } | null>(null)
  /**
   * Counts the snapshots that replaced the state wholesale (the first load, a reconnect, a tab shown again) rather than
   * bringing a change as it happened. The page plays its one-shot indicators only for changes made in neither.
   */
  const [resyncs, setResyncs] = useState(0)
  const [refreshHints, setRefreshHints] = useState(0)
  const guard = useRef(new ProjectionGuard())
  const latestSnapshot = useRef<AppSnapshot | null>(null)
  const latestDetail = useRef(EMPTY_DETAIL)
  const restoredDevice = useRef<string | null>(null)
  const alive = useRef(true)
  const running = useRef<Promise<boolean> | null>(null)
  const syncPass = useRef(0)
  const currentSyncPass = useCallback(() => syncPass.current, [])
  const pending = useRef<SyncMode | null>(null)
  /** Whether a queued synchronization re-establishes state instead of following a change; merged requests keep it. */
  const pendingResync = useRef(false)
  const request = useRef<AbortController | null>(null)
  const detailRequest = useRef<AbortController | null>(null)
  const globalInvalidations = useRef(0)
  const activeStream = useRef<{ stream: EventStreamConnection; ticket: ProjectionTicket; clear: () => void } | null>(null)
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

  const publishDetail = useCallback((next: TaskDetail | null, cached = false) => {
    latestDetail.current = next === null ? EMPTY_DETAIL : { detail: next, cached }
    setDetailView(latestDetail.current)
  }, [])
  const publishSnapshot = useCallback((next: AppSnapshot | null, resync: boolean) => {
    latestSnapshot.current = next
    setSnapshot(next)
    if (resync) setResyncs(count => count + 1)
  }, [])
  /**
   * A frame in which only the reply's text grew is accepted at once and drawn at most once per animation frame: several
   * that arrive within one frame draw as the last of them, and a hidden page draws none until it is shown again. What is
   * drawn is always the newest accepted state, so a drawing can never bring an older one back. Such a frame changes the
   * session's entry in the list only in its times, so the list's copy is drawn at most once a second while they come.
   * Every other frame (a status, a tool, an approval, a settled turn) is published at once, list and all: notices and
   * counts depend on it while hidden.
   */
  const listTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [drawBody] = useState(() =>
    frameGate(() => {
      if (!alive.current) return
      setDetailView(latestDetail.current)
      if (listTimer.current !== null) return
      setSnapshot(latestSnapshot.current)
      listTimer.current = setTimeout(() => {
        listTimer.current = null
        if (alive.current) setSnapshot(latestSnapshot.current)
      }, BODY_LIST_PACE_MS)
    }),
  )
  const publishBody = useCallback(
    (next: TaskDetail, merged: AppSnapshot | null) => {
      latestDetail.current = { detail: next, cached: false }
      if (merged) latestSnapshot.current = merged
      drawBody()
    },
    [drawBody],
  )
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
  const publishRemoval = useCallback(
    (sessionId: string, deleted: boolean) => {
      activeStream.current?.clear()
      activeStream.current?.stream.close()
      publishDetail(null)
      setSelectedId(null)
      storeSelection(null)
      setRemoved({ sessionId, deleted })
    },
    [publishDetail, storeSelection],
  )

  const signOut = useCallback(
    (state: AuthState) => {
      // A retry left over from before must not replace the reason shown on the enrollment page.
      signedOut.current = true
      // Signed out, removed or no longer accepted: what this origin's devices were writing goes now.
      forgetStoredDrafts(location.origin)
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
          const pass = ++syncPass.current
          const invalidationsAtStart = globalInvalidations.current
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
            if (latestSnapshot.current && streamAuthority(latestSnapshot.current) !== streamAuthority(next)) {
              // Revoke the old reader/shadow before React commits the new permission projection and runs effect cleanup.
              guard.current.invalidate()
              activeStream.current?.clear()
              activeStream.current?.stream.close()
              publishDetail(null)
            }
            signedOut.current = false
            setAuth(null)
            setPageError(null)
            setFailure(null)
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
            const unlisted = guard.current.retain(next)
            if (unlisted !== null) publishRemoval(unlisted, next.device.dataScope === 'all')
            publishSnapshot(mergeTaskSnapshot(next, latestDetail.current.cached ? null : latestDetail.current.detail), currentResync)
            // An incomplete or older listing still leaves the detail to confirm the selection.
            if (currentMode === 'list' && guard.current.sessionId !== null && !next.tasks.some(task => task.id === guard.current.sessionId))
              pending.current = 'all'
            if (currentMode === 'all') {
              const detailTicket = guard.current.capture()
              if (detailTicket.sessionId !== null) {
                // The queued full sync will read this detail after rechecking that the device can still see it.
                if (invalidationsAtStart !== globalInvalidations.current) continue
                detailRequest.current = controller
                const nextDetail = await api<TaskDetail>(`tasks/${encodeURIComponent(detailTicket.sessionId)}`, {
                  signal: controller.signal,
                }).catch((cause: unknown) => {
                  if (isMissingTask(cause)) return null
                  throw cause
                })
                if (!alive.current || !guard.current.current(detailTicket)) continue
                // Missing while a Harness is off, starting or failed to list is not a deletion: only a whole listing
                // proves the session is gone. Until then it stays selected with what was last read.
                if (nextDetail === null) {
                  if (missingMeansDeleted(next)) {
                    guard.current.forget(detailTicket.sessionId)
                    guard.current.select(null)
                    publishRemoval(detailTicket.sessionId, true)
                  }
                } else if (guard.current.accept(detailTicket, nextDetail)) {
                  publishDetail(nextDetail)
                  setConfirmedDetailRead({ sessionId: detailTicket.sessionId, pass })
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
              setPageError({ cause })
              setFailure(connectionFailure(cause))
              setConnection(navigator.onLine ? 'reconnecting' : 'offline')
            }
          } finally {
            if (detailRequest.current === controller) detailRequest.current = null
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
    [publishDetail, publishRemoval, publishSnapshot, signOut, renewal],
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
    return {
      status: 'failed',
      get message() {
        return errorMessage(cause)
      },
    }
  }, [synchronize, signOut])
  const select = useCallback(
    (id: string | null) => {
      if (id !== guard.current.sessionId) {
        const listed = id !== null && latestSnapshot.current?.tasks.some(task => task.id === id) === true
        const cached = guard.current.select(id, listed)
        request.current?.abort()
        publishDetail(cached, cached !== null)
        setSelectedId(id)
      }
      storeSelection(id)
      void synchronize('all')
    },
    [synchronize, publishDetail, storeSelection],
  )
  const forgetSession = useCallback(
    (id: string) => {
      guard.current.forget(id)
      if (guard.current.sessionId === id) publishDetail(null)
    },
    [publishDetail],
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

  const identity = snapshot === null ? null : streamAuthority(snapshot)
  useEffect(() => {
    if (identity === null) return
    let disposed = false
    let repairing = false
    let openGeneration = 0
    const ticket = guard.current.capture()
    const shadow = ticket.sessionId === null ? null : new TaskStreamProjection(guard.current.instanceId!, ticket.sessionId)
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
        // A global refresh can withdraw private content. A stalled detail cannot delay its newer listing.
        if (event.type === 'refresh') {
          globalInvalidations.current++
          detailRequest.current?.abort()
        }
        void synchronize(event.type === 'tasks-invalidated' ? 'list' : 'all')
      } catch {
        /* Malformed events cannot replace browser state. */
      }
    }
    const stream = connectEventStream(
      `/link/api/events${query}`,
      {
        onOpen: () => {
          shadow?.reset()
          repairing = false
          syncConnection()
        },
        onEvent: message => {
          if (disposed || repairing || !guard.current.current(ticket)) return
          if (message.event === 'task-state' || message.event === 'task-delta') {
            const result = shadow?.receive(message)
            if (result?.kind === 'repair') {
              if (stream.repair()) {
                repairing = true
                shadow?.reset()
              }
              return
            }
            if (result?.kind !== 'detail') return
            observeHostTime(result.detail.sync?.hostTime)
            if (!guard.current.accept(ticket, result.detail, 'stream')) return
            const merged = latestSnapshot.current ? mergeTaskSnapshot(latestSnapshot.current, result.detail) : null
            if (message.event === 'task-delta') publishBody(result.detail, merged)
            else {
              publishDetail(result.detail)
              if (merged) publishSnapshot(merged, false)
            }
          } else if (message.event === 'refresh' || message.event === 'tasks-invalidated') invalidate(message.data)
          else if (message.event === 'host-state') hostState(message.data)
          else if (message.event === 'app.data') publishAppData(message.data, guard.current.instanceId ?? undefined)
          // A plugin's pages changed: the snapshot names the new revision and bundle, and open frames rebuild from it.
          else if (message.event === 'app.updated' && publishAppUpdated(message.data, guard.current.instanceId ?? undefined))
            void synchronize('all')
        },
        onError: () => {
          if (disposed) return
          shadow?.reset()
          openGeneration++
          setConnection(navigator.onLine ? 'reconnecting' : 'offline')
          // After an announced stop the Host is known to be away; the next attempt comes when it said to try again. Only a
          // connection that failed waits like this: onUnauthorized clears the notice once the Host answers with a 401.
          if (!repairing && navigator.onLine && noticeRef.current === null) void synchronize('all', true)
        },
        // Otherwise onError's snapshot decides between re-enrollment and a transient failure, after the backoff. A 401
        // means the Host is answering again, so an announcement it made before no longer holds that snapshot back.
        onUnauthorized: async code => {
          if (disposed) return 'stop'
          if (code === 'renewal-required' && (await renew())) return 'renewed'
          if (!disposed && noticeRef.current !== null) publishNotice(null)
          return 'retry'
        },
      },
      { taskDelta: ticket.sessionId !== null && currentShell()?.remote !== true },
    )
    activeStream.current = { stream, ticket, clear: () => shadow?.reset() }
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
      shadow?.reset()
      clearInterval(metadataTimer)
      openGeneration++
      stream.close()
      if (activeStream.current?.stream === stream) activeStream.current = null
      window.removeEventListener('offline', offline)
      window.removeEventListener('online', online)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [identity, selectedId, synchronize, publishDetail, publishSnapshot, publishBody, publishNotice, renew])

  return {
    snapshot,
    detail: detailView.detail,
    cachedDetail: detailView.cached,
    confirmedDetailRead,
    currentSyncPass,
    selectedId,
    select,
    forgetSession,
    refresh,
    resync,
    confirmEnrollment,
    auth,
    loading,
    connection,
    hostNotice,
    error: pageError ? errorMessage(pageError.cause) : '',
    failure,
    removed,
    resyncs,
    refreshHints,
  }
}
