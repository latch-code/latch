import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { TurnChanges } from '@latch/protocol'
import { sameData, type Turn } from '../conversation.ts'
import { api } from '../core/api.ts'
import { matchTurnChanges } from './turnChanges.ts'

const NONE: ReadonlyMap<string, TurnChanges> = new Map()
/** A run just settled may take a while to be recorded: the Host snapshots its folders first, up to its own time limit per folder. */
const SETTLE_RETRY = 1500
const SETTLE_RETRIES = 40
/** Coming back to the page re-reads the records, for what another device did; flicking between windows should not. */
const RETURN_INTERVAL = 30_000

type ChangesWriter = 'conversation' | 'panel'
const writeListeners = new Set<(sessionId: string, from: ChangesWriter) => void>()

/** An undo pressed in one place: the other place that can press it shows the same turn and must not go on offering it. */
export function announceChangesWrite(sessionId: string, from: ChangesWriter): void {
  for (const listener of writeListeners) listener(sessionId, from)
}

export function onChangesWrite(listener: (sessionId: string, from: ChangesWriter) => void): () => void {
  writeListeners.add(listener)
  return () => {
    writeListeners.delete(listener)
  }
}

/**
 * What the records were last read against. An undo moves neither the session's time nor its status, so this device says
 * when it did one, and returning to the page stands in for what another device may have done.
 */
export function useChangesRevision({
  sessionId,
  enabled,
  active,
  updatedAt,
}: {
  sessionId: string
  enabled: boolean
  active: boolean
  updatedAt: string
}) {
  const [reads, refresh] = useReducer((count: number) => count + 1, 0)
  useEffect(
    () =>
      onChangesWrite((written, from) => {
        if (written === sessionId && from === 'panel') refresh()
      }),
    [sessionId],
  )
  useEffect(() => {
    if (!enabled) return undefined
    let last = Date.now()
    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < RETURN_INTERVAL) return
      last = Date.now()
      refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled])
  return { revision: active ? 'active' : `${updatedAt}\n${reads}`, refresh: useCallback(() => refresh(), []) }
}

/**
 * The Host's per-turn records of a session, matched to its turns. It reads them when the session is opened and whenever a
 * run ends or something else about the session moves on (`revision`), and never while a run streams, because nothing is
 * settled then.
 */
export function useTurnChanges(
  sessionId: string,
  turns: readonly Turn[],
  { enabled, revision, active, latestRunId }: { enabled: boolean; revision: string; active: boolean; latestRunId?: string },
): ReadonlyMap<string, TurnChanges> {
  const [records, setRecords] = useState<{ sessionId: string; turns: TurnChanges[] } | null>(null)
  const retries = useRef(0)
  useEffect(() => {
    if (!enabled || active) return undefined
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = () => {
      void api<{ turns: TurnChanges[] }>(`tasks/${encodeURIComponent(sessionId)}/changes/turns`, { signal: controller.signal })
        .then(answer => {
          if (controller.signal.aborted) return
          setRecords(current =>
            current?.sessionId === sessionId && sameData(current.turns, answer.turns) ? current : { sessionId, turns: answer.turns },
          )
          if (answer.turns.at(-1)?.state === 'running' && retries.current < SETTLE_RETRIES) {
            retries.current++
            timer = setTimeout(read, SETTLE_RETRY)
          }
        })
        .catch(() => undefined)
    }
    retries.current = 0
    read()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [enabled, active, sessionId, revision])
  const list = records?.sessionId === sessionId ? records.turns : undefined
  const turnKeys = turns.map(turn => `${turn.key}:${turn.user?.createdAt ?? ''}`).join('\n')
  const stable = useRef(turns)
  stable.current = turns
  return useMemo(
    () => (list ? matchTurnChanges(stable.current, list, latestRunId) : NONE),
    // The match reads the keys and start times of the turns, not their content.
    [list, turnKeys, latestRunId],
  )
}
