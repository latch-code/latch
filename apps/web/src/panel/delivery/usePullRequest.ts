import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GitCheckLog, GitPrResult, GitPrState } from '@latch/protocol'
import { api, ApiError, errorMessage, isUncertain, newRequestId } from '../../core/api.ts'
import { unknownAfter, writeEnd, type WriteEnd } from './model.ts'

/** The Host gives `gh pr create` 60 s; its reads 30 s each, two of them for a pull request with its comments. */
const CREATE_WAIT_MS = 90_000
const READ_WAIT_MS = 75_000
/** Only while a check is still running and the tab is on screen. */
const PENDING_MS = 30_000
const NOT_RUN = new Set(['git-receipt-unsaved', 'host-closing'])
const uncertainWrite = (cause: unknown) =>
  !(cause instanceof ApiError && NOT_RUN.has(cause.code))
  && (isUncertain(cause) || (cause instanceof ApiError && cause.code === 'git-result-unknown'))

export type PrRead =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; state: GitPrState }
  | { kind: 'failed'; code: string; text: string }

export interface PrCreateInput {
  title: string
  body: string
  base: string
  draft: boolean
}

export interface PrFailure {
  code: string
  text: string
  tail?: string
}

/** A creation whose answer never came: the retry sends the same request with the same content. */
export interface PrUnknown {
  requestId: string
  body: PrCreateInput
}

export type LogRead = { kind: 'loading' } | { kind: 'ready'; log: GitCheckLog } | { kind: 'failed'; code: string; text: string }

function prMetadata({ pr, checks, draft }: GitPrState): GitPrState {
  return {
    ...(pr ? { pr } : {}),
    checks: checks.map(({ job: _job, ...check }) => check),
    ...(draft?.base ? { draft: { base: draft.base } } : {}),
  }
}

/**
 * The pull request step: read when the tab opens or comes back, after a push, on 刷新 and after a creation; every 30 s
 * only while a check is still running and the tab is on screen. No other background reads.
 */
export function usePullRequest(input: {
  sessionId: string
  /** The branch is on its remote (or a pull request may be bound): only then is there anything to read. */
  enabled: boolean
  open: boolean
  offline: boolean
  canReadFiles: boolean
  /** Changes after each push that went through: the pull request's checks start over. */
  pushed?: string | undefined
}) {
  const { sessionId, enabled, open, offline, canReadFiles, pushed } = input
  const base = `tasks/${encodeURIComponent(sessionId)}/git/pr`
  const [read, setRead] = useState<PrRead>({ kind: 'idle' })
  const [creating, setCreating] = useState(false)
  const [failure, setFailure] = useState<PrFailure>()
  const [unknown, setUnknown] = useState<PrUnknown>()
  const [created, setCreated] = useState<GitPrResult>()
  const [logReads, setLogReads] = useState<{ version: string; entries: Record<string, LogRead> }>()
  const checked = read.kind === 'ready' ? read.state.pr : undefined
  const version = checked && canReadFiles ? `${sessionId}:${checked.number}:${checked.headSha ?? ''}` : undefined
  const logVersion = useRef(version)
  const logRequests = useRef(new Map<string, AbortController>())
  const asked = useRef(0)
  const filesAllowed = useRef(canReadFiles)
  useLayoutEffect(() => {
    if (filesAllowed.current === canReadFiles) return
    filesAllowed.current = canReadFiles
    ++asked.current
    if (!canReadFiles) setRead(previous => (previous.kind === 'ready' ? { kind: 'ready', state: prMetadata(previous.state) } : previous))
  }, [canReadFiles])
  useLayoutEffect(() => {
    const requests = logRequests.current
    logVersion.current = version
    setLogReads(undefined)
    return () => {
      logVersion.current = undefined
      for (const request of requests.values()) request.abort()
      requests.clear()
    }
  }, [version])
  const openRef = useRef(open && enabled)
  useEffect(() => {
    openRef.current = open && enabled
  }, [open, enabled])

  const load = useCallback(async () => {
    const mine = ++asked.current
    setRead(previous => (previous.kind === 'ready' ? previous : { kind: 'loading' }))
    try {
      const state = await api<GitPrState>(base, { timeoutMs: READ_WAIT_MS })
      if (mine === asked.current) setRead({ kind: 'ready', state: filesAllowed.current ? state : prMetadata(state) })
    } catch (cause) {
      if (mine !== asked.current) return
      const code = cause instanceof ApiError ? cause.code : 'request-failed'
      // gh going away or logging out replaces what was shown; a network hiccup keeps it.
      setRead(previous =>
        previous.kind === 'ready' && !(cause instanceof ApiError && cause.code.startsWith('gh-') && cause.code !== 'gh-unreachable')
          ? previous
          : { kind: 'failed', code, text: errorMessage(cause) },
      )
    }
  }, [base])

  useEffect(() => {
    if (open && enabled && !offline) void load()
  }, [open, enabled, offline, canReadFiles, load])

  const seenPush = useRef(pushed)
  useEffect(() => {
    if (pushed === seenPush.current) return
    seenPush.current = pushed
    if (openRef.current) void load()
  }, [pushed, load])

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

  const pending = read.kind === 'ready' && read.state.checks.some(check => check.state === 'pending')
  useEffect(() => {
    if (!pending || !open || !enabled || offline) return undefined
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, PENDING_MS)
    return () => {
      clearInterval(timer)
    }
  }, [pending, open, enabled, offline, load])

  const send = useCallback(
    async (write: PrUnknown, retry = false): Promise<WriteEnd> => {
      setCreating(true)
      setFailure(undefined)
      try {
        const result = await api<GitPrResult>(base, {
          method: 'POST',
          body: { requestId: write.requestId, ...write.body },
          timeoutMs: CREATE_WAIT_MS,
        })
        setUnknown(previous => unknownAfter(previous, write, 'done'))
        setCreated(result)
        return 'done'
      } catch (cause) {
        const uncertain = uncertainWrite(cause)
        const end = writeEnd({
          code: cause instanceof ApiError ? cause.code : undefined,
          uncertain,
          ...(retry
            ? {
                retry: {
                  kind: 'pr' as const,
                  replay: cause instanceof ApiError && (cause.details as Record<string, unknown>).replay === true,
                },
              }
            : {}),
        })
        setUnknown(previous => unknownAfter(previous, write, end))
        // A refusal that kept a retry unknown shows under it.
        if (end !== 'unknown' || !uncertain)
          setFailure(
            cause instanceof ApiError
              ? {
                  code: cause.code,
                  text: cause.message,
                  ...(typeof (cause.details as { tail?: unknown }).tail === 'string'
                    ? { tail: (cause.details as { tail: string }).tail }
                    : {}),
                }
              : { code: 'request-failed', text: errorMessage(cause) },
          )
        return end
      } finally {
        setCreating(false)
        await load()
      }
    },
    [base, load],
  )

  const readLog = useCallback(
    async (job: string) => {
      if (!version || logVersion.current !== version) return
      logRequests.current.get(job)?.abort()
      const request = new AbortController()
      logRequests.current.set(job, request)
      const show = (entry: LogRead) => {
        if (request.signal.aborted || logVersion.current !== version || logRequests.current.get(job) !== request) return
        setLogReads(previous => ({ version, entries: { ...(previous?.version === version ? previous.entries : {}), [job]: entry } }))
      }
      show({ kind: 'loading' })
      try {
        const log = await api<GitCheckLog>(`${base}/checks/${encodeURIComponent(job)}/log`, {
          timeoutMs: READ_WAIT_MS,
          signal: request.signal,
        })
        show({ kind: 'ready', log })
      } catch (cause) {
        show({ kind: 'failed', code: cause instanceof ApiError ? cause.code : 'request-failed', text: errorMessage(cause) })
      } finally {
        if (logRequests.current.get(job) === request) logRequests.current.delete(job)
      }
    },
    [base, version],
  )

  return {
    read: !canReadFiles && read.kind === 'ready' ? ({ kind: 'ready', state: prMetadata(read.state) } as const) : read,
    creating,
    failure,
    unknown,
    created,
    logs: logReads?.version === version ? (logReads?.entries ?? {}) : {},
    reload: load,
    readLog,
    closeLog: (job: string) => {
      logRequests.current.get(job)?.abort()
      logRequests.current.delete(job)
      setLogReads(previous => {
        if (!previous) return previous
        const entries = { ...previous.entries }
        delete entries[job]
        return { ...previous, entries }
      })
    },
    create: (body: PrCreateInput) => send({ requestId: newRequestId(), body }),
    retry: async () => (unknown ? send(unknown, true) : undefined),
    /** Lets go of the unknown result on this page only; the Host's receipt stays unknown, and 创建 PR binds what it finds. */
    abandon: () => {
      setUnknown(undefined)
      setFailure(undefined)
    },
    dismiss: () => {
      setFailure(undefined)
    },
  }
}
