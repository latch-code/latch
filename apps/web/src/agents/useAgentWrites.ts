import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSnapshot } from '@latch/protocol'
import { api, newRequestId, readPending, submissionRequest, writePending, type PendingSubmission } from '../core/api.ts'
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
  | ({ write: AgentWrite } & WriteOutcome)

/**
 * Writes to the Agent routes. Each carries a requestId; one whose result is unknown is kept, and retrying sends the
 * identical request, which the Host answers from its receipt. Nothing is shown as saved until the Host says so.
 */
export function useAgentWrites(onSettled: () => void) {
  const [state, setState] = useState<WriteState | null>(null)
  const busy = useRef(false)
  const send = useCallback(
    async <T>(write: AgentWrite): Promise<T | undefined> => {
      if (busy.current) return undefined
      busy.current = true
      setState({ write, phase: 'saving' })
      try {
        const result = await api<T>(write.path, { method: write.method, body: write.body })
        setState({ write, phase: 'done' })
        onSettled()
        return result
      } catch (error) {
        setState({ write, ...writeOutcome(error) })
        if (writeOutcome(error).kind === 'conflict') onSettled()
        return undefined
      } finally {
        busy.current = false
      }
    },
    [onSettled],
  )
  const run = useCallback(
    <T>(key: string, path: string, method: AgentWrite['method'], body: Record<string, unknown>) =>
      send<T>({ key, path, method, body: { ...body, requestId: newRequestId() } }),
    [send],
  )
  const retry = useCallback(
    <T>() => (state && 'kind' in state && state.kind === 'unknown' ? send<T>(state.write) : Promise.resolve(undefined)),
    [send, state],
  )
  const clear = useCallback(() => {
    setState(null)
  }, [])
  /** A write whose result is unknown holds every other change back, as the Host does. */
  const held = state !== null && 'kind' in state && state.kind === 'unknown'
  return { state, run, retry, clear, held, saving: state !== null && 'phase' in state && state.phase === 'saving' }
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
export function useDelegation(snapshot: Pick<AppSnapshot, 'device'>, refresh: () => Promise<void>) {
  const key = `latch.delegation.${location.origin}.${snapshot.device.id}`
  const [pending, setPending] = useState<PendingSubmission | null>(() => readPending(key))
  const [sending, setSending] = useState(false)
  const [refused, setRefused] = useState<{ customAgentId: string; message: string; code?: string } | null>(null)
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
    try {
      const { path, body } = submissionRequest(submission)
      const result = await api<{ sessionId?: string }>(path, { method: 'POST', body })
      writePending(key, null)
      setPending(null)
      await refresh()
      return result.sessionId
    } catch (error) {
      const outcome = writeOutcome(error)
      if (outcome.kind !== 'unknown') {
        writePending(key, null)
        setPending(null)
        setRefused({
          customAgentId: submission.customAgentId ?? '',
          message: outcome.message,
          ...(outcome.kind === 'refused' && outcome.code ? { code: outcome.code } : {}),
        })
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
  }
}

export type Delegation = ReturnType<typeof useDelegation>
