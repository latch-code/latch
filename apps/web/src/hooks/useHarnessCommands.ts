import { useEffect, useState } from 'react'
import type { HarnessCommandCatalogue, ModelRef, TaskMode } from '@latch/protocol'
import { api } from '../core/api.ts'

interface DraftCommands {
  harnessId: string
  workspaceId?: string
  mode: TaskMode
  model?: ModelRef
  config?: Array<{ configId: string; value: string }>
}

/** Previous-session suggestions live only in memory, scoped to this Host, device authority and exact draft selection. */
export function useHarnessCommands(input: DraftCommands | undefined, scope: string): HarnessCommandCatalogue | undefined {
  const path = input ? `agents/${encodeURIComponent(input.harnessId)}/commands` : undefined
  const body = input
    ? JSON.stringify({ workspaceId: input.workspaceId, mode: input.mode, model: input.model, config: input.config })
    : undefined
  const key = path && body ? JSON.stringify([scope, path, body]) : undefined
  const [result, setResult] = useState<{ key: string; catalogue: HarnessCommandCatalogue | null }>()
  useEffect(() => {
    setResult(undefined)
    if (!path || !body || !key) return
    let pending: AbortController | undefined
    const read = () => {
      if (document.hidden) return
      pending?.abort()
      const controller = new AbortController()
      pending = controller
      void api<{ catalogue: HarnessCommandCatalogue | null }>(path, {
        method: 'POST',
        body: JSON.parse(body),
        signal: controller.signal,
      })
        .then(reply => {
          if (!controller.signal.aborted) setResult({ key, catalogue: reply.catalogue })
        })
        .catch(() => {
          if (!controller.signal.aborted) setResult({ key, catalogue: null })
        })
    }
    const visibility = () => {
      if (document.hidden) pending?.abort()
      else read()
    }
    read()
    // Filesystem changes need not produce a snapshot. Refresh the hint, without disturbing the draft or menu while waiting.
    const timer = window.setInterval(read, 30_000)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      pending?.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [path, body, key])
  // Effect cleanup follows rendering: an old selection must already be hidden in the first render of its successor.
  return key && result?.key === key ? (result.catalogue ?? undefined) : undefined
}
