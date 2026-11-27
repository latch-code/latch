import { useEffect, useRef, useState } from 'react'
import type { TaskSummary } from '@latch/protocol'
import { isActive } from '../format.ts'

/**
 * Fallback for a Host without a start time. Only a run this page saw start gets a clock.
 * A null selection still records transitions so switching back can resume its elapsed time.
 */
export function useRunClock(tasks: TaskSummary[], selectedId: string | null): number | undefined {
  const activeBefore = useRef<Set<string> | null>(null)
  const [starts, setStarts] = useState(() => new Map<string, number>())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const previous = activeBefore.current
    const active = new Set<string>()
    const startedAt = Date.now()
    let changed: Map<string, number> | undefined
    for (const task of tasks) {
      if (isActive(task.status)) {
        active.add(task.id)
        if (previous !== null && !previous.has(task.id) && !starts.has(task.id)) (changed ??= new Map(starts)).set(task.id, startedAt)
      } else if (starts.has(task.id)) (changed ??= new Map(starts)).delete(task.id)
    }
    activeBefore.current = active
    if (changed) setStarts(changed)
  }, [tasks, starts])

  const start = selectedId === null ? undefined : starts.get(selectedId)
  useEffect(() => {
    if (start === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [start])
  return start === undefined ? undefined : Math.max(0, now - start)
}
