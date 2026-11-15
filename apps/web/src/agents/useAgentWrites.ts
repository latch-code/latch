import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSnapshot, CustomAgentCreate } from '@latch/protocol'
import {
  api,
  ApiError,
  ClientError,
  newRequestId,
  readPending,
  submissionRequest,
  writePending,
  type PendingSubmission,
} from '../core/api.ts'
import { AgentCreation, type AgentCreationToken } from '../core/agentCreation.ts'
import { abandonSubmission, unconfirmedReason } from '../core/sendingMessage.ts'
import { writeOutcome, type WriteOutcome } from './model.ts'

/** One write to 我的 Agent, as sent: a retry repeats it with the same requestId. */
export interface AgentWrite {
  /** What on the page it belongs to, such as `agent`, `memory:<id>` or `memory:new`. */
  key: string
  path: string
  method: 'POST' | 'PATCH' | 'DELETE'
  body: Record<string, unknown> & { requestId: string }
}

export type WriteState =
  | { write: AgentWrite; phase: 'saving' }
  | { write: AgentWrite; phase: 'done' }
  | ({ write: AgentWrite; unreplayable?: true; creationToken?: AgentCreationToken } & WriteOutcome)

function retainedCreation(store: AgentCreation): Extract<WriteState, { kind: 'unknown' }> | null {
  const pending = store.read()
  return pending
    ? {
        write: {
          key: 'agent:new',
          path: 'custom-agents',
          method: 'POST',
          body: pending.body ? { ...pending.body } : { requestId: pending.requestId },
        },
        kind: 'unknown',
        message: pending.unavailable
          ? '暂时读不到此设备保存的待确认记录，不能开始另一项创建。请恢复浏览器存储后再确认。'
          : pending.unread
            ? '此设备保存的待确认创建记录无法读取。请查看已有 Agent 后，再决定是否放弃等待。'
            : pending.body
              ? '上一次创建的结果尚未确认。'
              : '上一次创建的结果尚未确认。敏感内容只保留在原页面内存中，当前页面不能重发；请查看已有 Agent 后再决定是否放弃等待。',
        ...(!pending.body ? { unreplayable: true as const } : {}),
        ...(pending.token ? { creationToken: pending.token } : {}),
      }
    : null
}

/**
 * Writes to the Agent routes. Each carries a requestId; one whose result is unknown is kept, and retrying sends the
 * identical request, which the Host answers from its receipt. Nothing is shown as saved until the Host says so.
 */
export function useAgentWrites(onSettled: () => void, creation?: { origin: string; deviceId: string; allowed: boolean }) {
  const retained = useMemo(
    () => (creation ? new AgentCreation(creation.origin, creation.deviceId, creation.allowed) : undefined),
    [creation?.origin, creation?.deviceId, creation?.allowed],
  )
  const currentStore = useRef(retained)
  const stateStore = useRef(retained)
  currentStore.current = retained
  const [state, setState] = useState<WriteState | null>(() => (retained ? retainedCreation(retained) : null))
  const visibleState = retained && (stateStore.current !== retained || !retained.current()) ? retainedCreation(retained) : state
  const busy = useRef<symbol | undefined>(undefined)
  const busyStore = useRef(retained)
  if (busyStore.current !== retained) {
    busyStore.current = retained
    busy.current = undefined
  }
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!retained) return undefined
    const read = () => {
      if (currentStore.current === retained && (!busy.current || !retained.current())) {
        stateStore.current = retained
        setState(retainedCreation(retained))
      }
    }
    read()
    return retained.subscribe(read)
  }, [retained])
  const send = useCallback(
    async <T>(write: AgentWrite): Promise<T | undefined> => {
      if (busy.current) return undefined
      const attempt = Symbol()
      busy.current = attempt
      const store = write.key === 'agent:new' ? retained : undefined
      const current = () => !store || (currentStore.current === store && store.current())
      let dispatched = false
      let replaying = false
      try {
        if (!current() || (store && !mounted.current)) return undefined
        setState({ write, phase: 'saving' })
        const execute = async () => {
          if (!current() || (store && !mounted.current)) return undefined
          if (store) {
            if (write.path !== 'custom-agents' || write.method !== 'POST') throw new ClientError('创建请求无效。', 'agent-creation-invalid')
            replaying = store.read() !== null
            try {
              store.begin(write.body as unknown as CustomAgentCreate)
            } catch (error) {
              throw new ClientError(
                error instanceof Error ? error.message : '无法保留创建请求，这次没有发送。',
                'agent-creation-unavailable',
              )
            }
          }
          dispatched = true
          const result = await api<T>(write.path, { method: write.method, body: write.body })
          if (!current()) return undefined
          if (store) {
            try {
              if (!store.finish(write.body.requestId)) {
                setState(retainedCreation(store))
                return undefined
              }
            } catch {
              setState({
                ...retainedCreation(store),
                write,
                kind: 'unknown',
                message: 'Mac 已回复，但此设备无法清除待确认记录。请重试同一请求。',
              })
              return undefined
            }
          }
          if (store && !mounted.current) return undefined
          setState({ write, phase: 'done' })
          onSettled()
          return result
        }
        return store ? await store.exclusive(execute) : await execute()
      } catch (error) {
        if (!current() || (store && !mounted.current)) return undefined
        const outcome = writeOutcome(error)
        const pending = store?.read()
        if (store && !dispatched) {
          setState(
            pending
              ? retainedCreation(store)
              : {
                  write,
                  kind: 'refused',
                  message: error instanceof ClientError ? error.message : '浏览器无法安全保留创建请求，这次没有发送。',
                },
          )
        } else if (pending && (pending.requestId !== write.body.requestId || error instanceof ClientError)) {
          setState(retainedCreation(store!))
        } else if (store && replaying) {
          setState({
            write,
            kind: 'unknown',
            ...(pending?.token ? { creationToken: pending.token } : {}),
            message: error instanceof ApiError ? error.message : '仍未取得原创建请求的回执。',
          })
        } else {
          if (store && outcome.kind !== 'unknown') {
            try {
              store.finish(write.body.requestId)
            } catch {
              setState({ ...retainedCreation(store), write, kind: 'unknown', message: '此设备无法清除待确认记录，请重试同一请求。' })
              return undefined
            }
          }
          setState({ write, ...outcome, ...(outcome.kind === 'unknown' && pending?.token ? { creationToken: pending.token } : {}) })
          if (outcome.kind === 'conflict') onSettled()
        }
        return undefined
      } finally {
        if (busy.current === attempt) busy.current = undefined
      }
    },
    [onSettled, retained],
  )
  const run = useCallback(
    <T>(key: string, path: string, method: AgentWrite['method'], body: Record<string, unknown>) =>
      send<T>({ key, path, method, body: { ...body, requestId: newRequestId() } }),
    [send],
  )
  const retry = useCallback(
    <T>() =>
      visibleState && 'kind' in visibleState && visibleState.kind === 'unknown' && !visibleState.unreplayable
        ? send<T>(visibleState.write)
        : Promise.resolve(undefined),
    [send, visibleState],
  )
  const clear = useCallback(() => {
    setState(previous => (retained && previous && 'kind' in previous && previous.kind === 'unknown' ? previous : null))
  }, [retained])
  /** A write whose result is unknown holds every other change back, as the Host does. */
  const held = visibleState !== null && 'kind' in visibleState && visibleState.kind === 'unknown'
  return {
    state: visibleState,
    run,
    retry,
    clear,
    held,
    saving: visibleState !== null && 'phase' in visibleState && visibleState.phase === 'saving',
    ...(retained
      ? {
          creationAvailable: retained.current(),
          abandon: async (expected: AgentCreationToken) =>
            retained.exclusive(async () => {
              if (busy.current) return false
              const cleared = retained.abandon(expected)
              if (cleared && currentStore.current === retained) setState(null)
              return cleared
            }),
        }
      : {}),
  }
}

export type AgentWrites = ReturnType<typeof useAgentWrites>

/** What a write's state says on the page about one key. */
export function writeFor(state: WriteState | null, key: string): WriteState | null {
  return state?.write.key === key ? state : null
}

/**
 * The delegation this device sent and has no answer for: stored before it is sent and cleared only on the Host's
 * definitive answer, apart from the new session's draft, so one never holds the other back.
 */
export function useDelegation(
  snapshot: Pick<AppSnapshot, 'device'>,
  refresh: () => Promise<void>,
  /** The start went through but its 「记住…」 was not kept: the Host's reason, never the text. */
  onMemoryRefused?: (reason: string) => void,
) {
  const key = `latch.delegation.${location.origin}.${snapshot.device.id}`
  const [pending, setPending] = useState<PendingSubmission | null>(() => readPending(key))
  const [sending, setSending] = useState(false)
  const [refused, setRefused] = useState<{ customAgentId: string; message: string; code?: string } | null>(null)
  /** Why the pending start is still unconfirmed after this page's last try; '' before one. */
  const [reason, setReason] = useState('')
  const busy = useRef(false)
  useEffect(() => {
    setPending(readPending(key))
  }, [key])
  const send = async (submission: PendingSubmission): Promise<string | undefined> => {
    if (busy.current) return undefined
    busy.current = true
    try {
      writePending(key, submission)
    } catch {
      busy.current = false
      setRefused({ customAgentId: submission.customAgentId ?? '', message: '无法保存待发送内容。请允许浏览器存储后重试。' })
      return undefined
    }
    setPending(submission)
    setSending(true)
    setRefused(null)
    setReason('')
    try {
      const { path, body } = submissionRequest(submission)
      const result = await api<{ sessionId?: string; memoryRefused?: string }>(path, { method: 'POST', body })
      writePending(key, null)
      setPending(null)
      if (result.memoryRefused) onMemoryRefused?.(result.memoryRefused)
      await refresh()
      return result.sessionId
    } catch (error) {
      const outcome = writeOutcome(error)
      setReason(unconfirmedReason(error) ?? (outcome.kind === 'unknown' ? outcome.message : ''))
      if (outcome.kind !== 'unknown') {
        writePending(key, null)
        setPending(null)
        setRefused({
          customAgentId: submission.customAgentId ?? '',
          message: outcome.message,
          ...(outcome.kind === 'refused' && outcome.code ? { code: outcome.code } : {}),
        })
        if (outcome.kind === 'refused' && (outcome.code === 'agent-chat-exists' || outcome.code === 'agent-chat-starting')) void refresh()
      }
      return undefined
    } finally {
      busy.current = false
      setSending(false)
    }
  }
  return {
    pending,
    sending,
    refused,
    dismissRefused: () => {
      setRefused(null)
    },
    start: (submission: Omit<PendingSubmission, 'requestId'> & { customAgentId: string }) =>
      send({ ...submission, requestId: newRequestId() }),
    retry: () => (pending ? send(pending) : Promise.resolve(undefined)),
    reason,
    /**
     * 放弃这次提交: this device stops waiting for the start's answer and gets its text back. A start the Host did get
     * appears as the Agent's chat. Its draft remains separate until the person opens that chat.
     */
    abandon: (): { customAgentId: string | undefined; text: string } | null => {
      if (busy.current || pending === null) return null
      const home = abandonSubmission(key, pending)
      setPending(null)
      setReason('')
      return { customAgentId: pending.customAgentId, text: home.text }
    },
  }
}

export type Delegation = ReturnType<typeof useDelegation>
