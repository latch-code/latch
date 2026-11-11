import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSnapshot, TaskSummary, TurnChanges } from '@latch/protocol'
import { api } from '../core/api.ts'
import { reviewShortcut, shortcutCandidates } from './model.ts'

/** How long to wait before reading a session's records again while its last run is still being recorded. */
const SETTLE_RETRY = 1500
const SETTLE_RETRIES = 20

/**
 * 「复核 N 处改动」 for the rows of the phone's list. A session it might apply to (settled, and unread or with notes still
 * waiting) has its turn records read once per `updatedAt`, only when this device may read them (data scope `all`); the
 * others go by the snapshot's note counts alone.
 */
export function useReviewShortcuts(
  snapshot: AppSnapshot,
  isUnread: (task: TaskSummary) => boolean,
  enabled: boolean,
): ReadonlyMap<string, string> {
  const reads = enabled && snapshot.catalog?.features?.changes === true && snapshot.device.dataScope === 'all'
  const candidates = useMemo(
    () =>
      enabled && snapshot.catalog?.features?.changes === true
        ? shortcutCandidates(snapshot.tasks, { isUnread, notes: snapshot.reviewNotes })
        : [],
    [enabled, snapshot.catalog?.features?.changes, snapshot.tasks, snapshot.reviewNotes, isUnread],
  )
  /** Turn records by `id\nupdatedAt`: a session that moves on is read again. */
  const [records, setRecords] = useState<ReadonlyMap<string, TurnChanges[] | null>>(new Map())
  /** Asked or answered already: an entry is read once. */
  const asked = useRef(new Set<string>())
  const key = reads ? candidates.map(task => `${task.id}\n${task.updatedAt}`).join('\u0000') : ''
  // Reads outlive a change of the list (they are wanted again at once); only leaving the page drops them.
  const alive = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const seen = asked.current
    alive.current = controller
    return () => {
      controller.abort()
      seen.clear()
    }
  }, [])
  useEffect(() => {
    const signal = alive.current?.signal
    if (!signal) return
    const read = (entry: string, attempt = 0) => {
      const id = entry.slice(0, entry.indexOf('\n'))
      void api<{ turns: TurnChanges[] }>(`tasks/${encodeURIComponent(id)}/changes/turns`, { signal }).then(
        answer => {
          // A run just settled may not be recorded yet (the Host snapshots its folders first): the row waits for the
          // record and asks again shortly, a bounded number of times, then goes by what it has.
          if (answer.turns.at(-1)?.state === 'running' && attempt < SETTLE_RETRIES) {
            setTimeout(() => {
              if (!signal.aborted) read(entry, attempt + 1)
            }, SETTLE_RETRY)
            return
          }
          setRecords(previous => new Map(previous).set(entry, answer.turns))
        },
        () => {
          // Refused or failed: the row goes by its notes, and the next update of the session asks again.
          if (!signal.aborted) setRecords(previous => new Map(previous).set(entry, null))
        },
      )
    }
    for (const entry of key ? key.split('\u0000') : []) {
      if (asked.current.has(entry)) continue
      asked.current.add(entry)
      read(entry)
    }
  }, [key])

  return useMemo(() => {
    const counts = new Map((snapshot.reviewNotes ?? []).map(entry => [entry.sessionId, entry]))
    const out = new Map<string, string>()
    for (const task of candidates) {
      const entry = `${task.id}\n${task.updatedAt}`
      // Until its records are read the row offers nothing, so the words do not change under the finger.
      if (reads && !records.has(entry)) continue
      const turns = records.get(entry)
      const shortcut = reviewShortcut(task, { unread: isUnread(task), turns: turns ?? undefined, notes: counts.get(task.id) })
      if (shortcut) out.set(task.id, shortcut.label)
    }
    return out
  }, [candidates, records, reads, snapshot.reviewNotes, isUnread])
}
