import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitCommitResult, GitDeliveryState, GitPushResult, GitStageResult } from '@latch/protocol'
import { api, ApiError, errorMessage, isUncertain, newRequestId } from '../../core/api.ts'
import { failureDetails, unknownAfter, writeEnd, type FailureDetails, type WriteEnd } from './model.ts'

/** The Host gives a commit with its hooks 10 minutes, a push and a stage 2; the page waits a little longer than that. */
const WAIT_MS = { stage: 150_000, commit: 630_000, push: 150_000 } as const
/** Only while a write is under way and the tab is on screen: the hook Git is running changes without an event. */
const FOLLOW_MS = 1_500
const ACTIVE = new Set(['running', 'waiting-approval'])
/** 5xx answers that say the write never ran. */
const NOT_RUN = new Set(['git-receipt-unsaved', 'host-closing'])
const uncertainWrite = (cause: unknown) =>
  !(cause instanceof ApiError && NOT_RUN.has(cause.code))
  && (isUncertain(cause) || (cause instanceof ApiError && cause.code === 'git-result-unknown'))

export type DeliveryRead =
  | { kind: 'loading' }
  | { kind: 'ready'; state: GitDeliveryState }
  /** The device's data scope does not cover the session's files: the list is locked, a commit and a push are not. */
  | { kind: 'denied' }
  | { kind: 'failed'; code: string; text: string }

/** A refusal or failure of the last write, by its fixed reason. */
export interface DeliveryFailure extends FailureDetails {
  code: string
  text: string
  kind: 'stage' | 'unstage' | 'commit' | 'push'
}

/** A commit or push whose answer never came: the retry sends the same request, body and all. */
export interface UnknownWrite {
  kind: 'commit' | 'push'
  requestId: string
  body: Record<string, unknown>
}

/** `at`: when the answer came, so a later edit of a file can mark it 「需要复验」. */
export type DeliveryOutcome =
  | { kind: 'committed'; result: GitCommitResult; at: number }
  | { kind: 'pushed'; result: GitPushResult; at: number }

export interface DeliveryWrites {
  stage(paths: string[]): void
  unstage(paths: string[]): void
  commit(message: string, skipHooks: boolean): Promise<WriteEnd>
  push(): Promise<void>
  /** Undefined when nothing was pending. */
  retry(): Promise<WriteEnd | undefined>
  abandon(): void
}

interface Queued {
  kind: 'stage' | 'unstage'
  paths: string[]
  requestId: string
}

/**
 * The session repository's state and its writes. The state is read when the tab opens, after each write, when a turn
 * ends, when the window comes back and when the Host says the session changed; while a write is under way it is read
 * again every 1.5 s for the hook it runs. Nothing is read while the tab is hidden.
 */
export function useDelivery(input: {
  sessionId: string
  status: string
  /** The Host's revision of the session: a write from another device moves it. */
  revision?: number | undefined
  open: boolean
  offline: boolean
}) {
  const { sessionId, status, revision, open, offline } = input
  const base = `tasks/${encodeURIComponent(sessionId)}/git`
  const [read, setRead] = useState<DeliveryRead>({ kind: 'loading' })
  const [queue, setQueue] = useState<Queued[]>([])
  const [writing, setWriting] = useState<'commit' | 'push' | undefined>()
  const [failure, setFailure] = useState<DeliveryFailure>()
  const [unknown, setUnknown] = useState<UnknownWrite>()
  const [outcome, setOutcome] = useState<DeliveryOutcome>()
  const asked = useRef(0)
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])

  const load = useCallback(async () => {
    const mine = ++asked.current
    try {
      const state = await api<GitDeliveryState>(base)
      if (mine === asked.current) setRead({ kind: 'ready', state })
    } catch (cause) {
      if (mine !== asked.current) return
      if (cause instanceof ApiError && cause.code === 'file-scope') setRead({ kind: 'denied' })
      // A refresh that failed keeps the state it was refreshing.
      else
        setRead(previous =>
          previous.kind === 'ready' || previous.kind === 'denied'
            ? previous
            : { kind: 'failed', code: cause instanceof ApiError ? cause.code : 'request-failed', text: errorMessage(cause) },
        )
    }
  }, [base])

  // Opening the tab reads it; so does coming back to it.
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const running = ACTIVE.has(status)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running && openRef.current) void load()
    wasRunning.current = running
  }, [running, load])

  const wasOffline = useRef(offline)
  useEffect(() => {
    if (wasOffline.current && !offline && openRef.current) void load()
    wasOffline.current = offline
  }, [offline, load])

  useEffect(() => {
    const back = () => {
      if (document.visibilityState === 'visible' && openRef.current) void load()
    }
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', back)
    return () => {
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', back)
    }
  }, [load])

  // The Host announces each delivery write's start and end as a change of the session; a turn's stream is left alone.
  const seen = useRef(revision)
  useEffect(() => {
    if (revision === seen.current) return
    seen.current = revision
    if (!open || running) return undefined
    const timer = setTimeout(() => void load(), 250)
    return () => {
      clearTimeout(timer)
    }
  }, [revision, open, running, load])

  const hostRunning = read.kind === 'ready' ? read.state.running : undefined
  const following = open && !offline && (hostRunning !== undefined || writing !== undefined || queue.length > 0)
  useEffect(() => {
    if (!following) return undefined
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, FOLLOW_MS)
    return () => {
      clearInterval(timer)
    }
  }, [following, load])

  // Stage and unstage run one at a time, in the order pressed, each with its own request ID: the Host takes one write per
  // repository at a time.
  const draining = useRef(false)
  useEffect(() => {
    const next = queue[0]
    if (!next || draining.current) return
    draining.current = true
    void (async () => {
      try {
        await api<GitStageResult>(`${base}/${next.kind}`, {
          method: 'POST',
          body: { requestId: next.requestId, paths: next.paths },
          timeoutMs: WAIT_MS.stage,
        })
      } catch (cause) {
        // Staging is safe to repeat and the state read next shows what took; a refusal says why.
        if (!uncertainWrite(cause)) setFailure(failureOf(next.kind, cause))
      }
      await load()
      draining.current = false
      setQueue(previous => previous.filter(item => item !== next))
    })()
  }, [queue, base, load])

  const send = useCallback(
    async (write: UnknownWrite, retry = false) => {
      setWriting(write.kind)
      setFailure(undefined)
      setOutcome(undefined)
      try {
        const result = await api<GitCommitResult | GitPushResult>(`${base}/${write.kind}`, {
          method: 'POST',
          body: { requestId: write.requestId, ...write.body },
          timeoutMs: WAIT_MS[write.kind],
        })
        setUnknown(previous => unknownAfter(previous, write, 'done'))
        setOutcome(
          write.kind === 'commit'
            ? { kind: 'committed', result: result as GitCommitResult, at: Date.now() }
            : { kind: 'pushed', result: result as GitPushResult, at: Date.now() },
        )
        return 'done' as const
      } catch (cause) {
        const uncertain = uncertainWrite(cause)
        const end = writeEnd({
          code: cause instanceof ApiError ? cause.code : undefined,
          uncertain,
          ...(retry
            ? {
                retry: {
                  kind: write.kind,
                  replay: cause instanceof ApiError && (cause.details as Record<string, unknown>).replay === true,
                },
              }
            : {}),
        })
        setUnknown(previous => unknownAfter(previous, write, end))
        // 「这台电脑正在安装更新」 reads as a neutral line; a retry's unknown stays on screen with it, as does the refusal
        // that kept a retry unknown, under it.
        if (end !== 'unknown' || !uncertain) setFailure(failureOf(write.kind, cause))
        return end
      } finally {
        setWriting(undefined)
        await load()
      }
    },
    [base, load],
  )

  const writes: DeliveryWrites = {
    stage(paths) {
      if (paths.length) setQueue(previous => [...previous, { kind: 'stage', paths, requestId: newRequestId() }])
    },
    unstage(paths) {
      if (paths.length) setQueue(previous => [...previous, { kind: 'unstage', paths, requestId: newRequestId() }])
    },
    commit: (message, skipHooks) =>
      send({ kind: 'commit', requestId: newRequestId(), body: { message, ...(skipHooks ? { skipHooks: true } : {}) } }),
    async push() {
      await send({ kind: 'push', requestId: newRequestId(), body: {} })
    },
    retry: async () => (unknown ? send(unknown, true) : undefined),
    /** Lets go of the unknown result on this page only, so a new request can be made; the Host's receipt stays unknown. */
    abandon: () => {
      setUnknown(undefined)
      setFailure(undefined)
    },
  }

  /** The paths waiting or under way, by what pressing their box asked for. */
  const pending = new Map<string, 'stage' | 'unstage'>()
  for (const item of queue) for (const path of item.paths) pending.set(path, item.kind)

  return {
    read,
    pending,
    writing,
    failure,
    unknown,
    outcome,
    writes,
    reload: load,
    dismiss: () => {
      setFailure(undefined)
    },
  }
}

function failureOf(kind: DeliveryFailure['kind'], cause: unknown): DeliveryFailure {
  if (cause instanceof ApiError)
    return { kind, code: cause.code, text: cause.message, ...failureDetails(cause.details as Record<string, unknown>) }
  return { kind, code: 'request-failed', text: errorMessage(cause) }
}
