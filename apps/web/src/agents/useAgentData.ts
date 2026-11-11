import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSnapshot, CustomAgentDetail, CustomAgentList, GeneralAgentDetail } from '@latch/protocol'
import { GENERAL_AGENT_ID } from '@latch/protocol'
import { api, ApiError, errorMessage } from '../core/api.ts'
import { lockedRead, readsAgents } from './model.ts'

/** A read of the Agent routes: loading, what the Host returned, locked to this device, refused for now, or failed. */
export type AgentRead<T> =
  | { state: 'loading' }
  | { state: 'ready'; value: T }
  | { state: 'locked' }
  /** A write's result is still being confirmed; the Host refuses reads until then and retries by itself. */
  | { state: 'confirming'; value?: T }
  | { state: 'missing' }
  | { state: 'failed'; message: string; value?: T }

/**
 * Reads `path` and reads it again whenever `version` changes, keeping what it showed while it does. A device without the
 * full data scope is locked without asking: the Host would refuse.
 */
function useAgentRead<T>(snapshot: Pick<AppSnapshot, 'device'>, path: string | null, version: string) {
  const locked = !readsAgents(snapshot)
  const [read, setRead] = useState<AgentRead<T>>(() => (locked ? { state: 'locked' } : { state: 'loading' }))
  const shown = useRef<T | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (locked) {
      setRead({ state: 'locked' })
      return undefined
    }
    if (path === null) return undefined
    const controller = new AbortController()
    let retry: ReturnType<typeof setTimeout> | undefined
    api<T>(path, { signal: controller.signal })
      .then(value => {
        shown.current = value
        setRead({ state: 'ready', value })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        if (lockedRead(error)) setRead({ state: 'locked' })
        else if (error instanceof ApiError && error.code === 'agent-write-unknown') {
          setRead({ state: 'confirming', ...(shown.current ? { value: shown.current } : {}) })
          // The Host retries the write each second; reading again shortly after finds its answer.
          retry = setTimeout(() => {
            setAttempt(value => value + 1)
          }, 1500)
        } else if (error instanceof ApiError && (error.code === 'agent-not-found' || error.status === 404)) setRead({ state: 'missing' })
        else setRead({ state: 'failed', message: errorMessage(error), ...(shown.current ? { value: shown.current } : {}) })
      })
    return () => {
      controller.abort()
      clearTimeout(retry)
    }
  }, [locked, path, version, attempt])
  const reload = useCallback(() => {
    setAttempt(value => value + 1)
  }, [])
  return { read, reload }
}

/** What the snapshot says of the Agents, so the list is read again when any of them changes. */
export function agentsVersion(snapshot: Pick<AppSnapshot, 'customAgents' | 'tasks'>): string {
  const agents = snapshot.customAgents?.map(agent => `${agent.id}:${agent.revision}:${agent.memoryCount}:${agent.available}`).join() ?? '-'
  return `${agents}|${snapshot.customAgents === undefined ? 'absent' : 'present'}`
}

export function useAgentList(snapshot: Pick<AppSnapshot, 'device' | 'customAgents' | 'tasks'>) {
  return useAgentRead<CustomAgentList>(snapshot, 'custom-agents', agentsVersion(snapshot))
}

export type AgentDetailValue = { kind: 'custom'; detail: CustomAgentDetail } | { kind: 'general'; detail: GeneralAgentDetail }

export function useAgentDetail(snapshot: Pick<AppSnapshot, 'device' | 'customAgents' | 'tasks'>, id: string | null) {
  const path = id === null || id === 'new' ? null : `custom-agents/${encodeURIComponent(id)}`
  const { read, reload } = useAgentRead<CustomAgentDetail | GeneralAgentDetail>(snapshot, path, agentsVersion(snapshot))
  const value = 'value' in read && read.value ? wrap(read.value) : undefined
  // A detail read for another Agent than the one shown now is not shown.
  const current = value && value.kind === 'custom' ? value.detail.agent.id === id : id === GENERAL_AGENT_ID
  return { read, value: current ? value : undefined, reload }
}

function wrap(value: CustomAgentDetail | GeneralAgentDetail): AgentDetailValue {
  return 'general' in value ? { kind: 'general', detail: value } : { kind: 'custom', detail: value }
}
