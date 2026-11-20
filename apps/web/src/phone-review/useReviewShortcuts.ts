import { useEffect, useMemo, useRef, useState } from 'react'
import { readsProjectFiles, type AppSnapshot, type TaskSummary, type TurnChanges } from '@latch/protocol'
import { api } from '../core/api.ts'
import { reviewable, reviewShortcut, shortcutCandidates, type ReviewProgress } from './model.ts'

/** How long to wait before reading a session's records again while its last run is still being recorded. */
const SETTLE_RETRY = 1500
const SETTLE_RETRIES = 20

const EMPTY_RECORDS = new Map<string, TurnChanges[] | null>()

/** Look up the latest recorded turn for new and unfinished reviews, or go by feedback counts alone. */
export function useReviewShortcuts(
  snapshot: AppSnapshot,
  isUnread: (task: TaskSummary) => boolean,
  enabled: boolean,
  authority: string,
  progress: ReadonlyMap<string, ReviewProgress>,
): ReadonlyMap<string, { label: string; turn?: TurnChanges }> {
  const changesEnabled = enabled && snapshot.catalog?.features?.changes === true
  const reads = changesEnabled && readsProjectFiles(snapshot.device.dataScope)
  const candidates = useMemo(() => {
    if (!changesEnabled) return []
    const fresh = shortcutCandidates(snapshot.tasks, { isUnread, notes: snapshot.reviewNotes })
    if (!reads || !progress.size) return fresh
    const selected = new Map(fresh.map(task => [task.id, task]))
    for (const task of snapshot.tasks) {
      const saved = progress.get(task.id)
      if (saved && saved.remaining !== 0 && reviewable(task)) selected.set(task.id, task)
    }
    return [...selected.values()]
  }, [changesEnabled, reads, snapshot.tasks, snapshot.reviewNotes, isUnread, progress])
  /** A session that moves on is read again. */
  const [answers, setAnswers] = useState<{ authority: string; records: ReadonlyMap<string, TurnChanges[] | null> }>()
  const records = answers?.authority === authority ? answers.records : EMPTY_RECORDS
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
  }, [authority])
  useEffect(() => {
    const signal = alive.current?.signal
    if (!signal) return
    const remember = (entry: string, turns: TurnChanges[] | null) => {
      if (signal.aborted) return
      setAnswers(previous => ({
        authority,
        records: new Map(previous?.authority === authority ? previous.records : undefined).set(entry, turns),
      }))
    }
    const read = (entry: string, attempt = 0) => {
      const id = entry.slice(0, entry.indexOf('\n'))
      void api<{ turns: TurnChanges[] }>(`tasks/${encodeURIComponent(id)}/changes/turns`, { signal }).then(
        answer => {
          // A run just settled may not be recorded yet (the Host snapshots its folders first): the row waits for the
          // record and asks again shortly, a bounded number of times, then goes by what it has.
          if (signal.aborted) return
          if (answer.turns.at(-1)?.state === 'running' && attempt < SETTLE_RETRIES) {
            setTimeout(() => {
              if (!signal.aborted) read(entry, attempt + 1)
            }, SETTLE_RETRY)
            return
          }
          remember(entry, answer.turns)
        },
        () => {
          // Refused or failed: the row goes by its notes, and the next update of the session asks again.
          remember(entry, null)
        },
      )
    }
    for (const entry of key ? key.split('\u0000') : []) {
      if (asked.current.has(entry)) continue
      asked.current.add(entry)
      read(entry)
    }
  }, [authority, key])

  return useMemo(() => {
    const counts = new Map((snapshot.reviewNotes ?? []).map(entry => [entry.sessionId, entry]))
    const out = new Map<string, { label: string; turn?: TurnChanges }>()
    for (const task of candidates) {
      const entry = `${task.id}\n${task.updatedAt}`
      // Until its records are read the row offers nothing, so the words do not change under the finger.
      if (reads && !records.has(entry)) continue
      const turns = reads ? records.get(entry) : undefined
      const shortcut = reviewShortcut(task, {
        unread: isUnread(task),
        turns: turns ?? undefined,
        notes: counts.get(task.id),
        progress: reads ? progress.get(task.id) : undefined,
      })
      const turn = turns?.at(-1)
      if (shortcut) out.set(task.id, { label: shortcut.label, ...(turn ? { turn } : {}) })
    }
    return out
  }, [candidates, records, reads, snapshot.reviewNotes, isUnread, progress])
}
