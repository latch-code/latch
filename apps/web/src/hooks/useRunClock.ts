import { useEffect, useState } from 'react'
import type { TaskStatus, TaskSummary } from '@latch/protocol'
import { isActive } from '../format.ts'

/**
 * Elapsed time of the selected run, only when this page saw the run start. The
 * Host does not report start times, so a run already active on first load shows
 * no clock rather than a misleading one.
 */
export function useRunClock(tasks: TaskSummary[], selectedId: string | null): number | undefined {
  const [state, setState] = useState<{ statuses: Map<string, TaskStatus> | null; starts: Map<string, number> }>({
    statuses: null,
    starts: new Map(),
  })
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setState(previous => {
      const starts = new Map(previous.starts)
      for (const task of tasks) {
        const before = previous.statuses?.get(task.id)
        if (!isActive(task.status)) starts.delete(task.id)
        else if (previous.statuses !== null && !isActive(before) && !starts.has(task.id)) starts.set(task.id, Date.now())
      }
      return { statuses: new Map(tasks.map(task => [task.id, task.status])), starts }
    })
  }, [tasks])

  const start = selectedId === null ? undefined : state.starts.get(selectedId)
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
