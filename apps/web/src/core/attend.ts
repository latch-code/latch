import { useEffect, useRef, useState } from 'react'
import type { BoardAttendInput, TaskSummary } from '@latch/protocol'
import { api, ApiError } from './api.ts'

const live = (task: Pick<TaskSummary, 'status'>) => task.status === 'running' || task.status === 'waiting-approval'

/**
 * The settlement to mark opened when this session is shown: its run failed and the Host still holds it in 等你处理.
 * The run's failure decides, not the Host's reason: unknown results come first there, and once checked the session
 * would otherwise turn into 「失败」 while it is open.
 */
export function openedSettle(task: Pick<TaskSummary, 'status' | 'runOutcome' | 'board'>): string | undefined {
  if (live(task) || task.board?.group !== 'attention' || task.board.settle === undefined) return undefined
  const failed = task.status === 'failed' || (task.status === 'idle' && task.runOutcome === 'failed')
  return failed ? task.board.settle : undefined
}

/** The Host holds the session in 等你处理 for results nobody can vouch for: 已核对 can name this settlement. */
export function checkSettle(task: Pick<TaskSummary, 'status' | 'board'>): string | undefined {
  return !live(task) && task.board?.reason === 'unknown' ? task.board.settle : undefined
}

/**
 * Whether the Host no longer holds the session for its unknown results: it has a group for it, the run has ended with
 * some, and the reason is another. An older Host without groups never says so.
 */
export function unknownChecked(task: Pick<TaskSummary, 'status' | 'board' | 'runEnd'>): boolean {
  const count = task.runEnd?.unknownResultCount ?? task.runEnd?.unknownResults?.length ?? 0
  return task.board !== undefined && count > 0 && !live(task) && task.board.reason !== 'unknown'
}

/** `POST /tasks/:id/attend`. Repeating the same body is safe: the Host answers a marker already written as it is. */
export function attend(sessionId: string, input: BoardAttendInput): Promise<{ summary: TaskSummary }> {
  return api<{ summary: TaskSummary }>(`tasks/${encodeURIComponent(sessionId)}/attend`, { method: 'POST', body: input })
}

/**
 * 打开过: while `shown` (the conversation is the surface in view, in a visible tab) a failed run's settlement is marked
 * opened, so it leaves 等你处理 on every device. Once per settlement on this page; a failure is sent again on the next
 * open, show or reconnect, never queued offline. A stale settlement is left to the newer one already on its way.
 */
export function useOpenedMark(summary: TaskSummary | undefined, shown: boolean, online: boolean): void {
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const changed = () => {
      setPageVisible(document.visibilityState === 'visible')
    }
    document.addEventListener('visibilitychange', changed)
    return () => {
      document.removeEventListener('visibilitychange', changed)
    }
  }, [])
  const sent = useRef(new Set<string>())
  const id = summary?.id
  const settle = summary && shown && pageVisible && online ? openedSettle(summary) : undefined
  useEffect(() => {
    if (id === undefined || settle === undefined) return
    const key = `${id}\n${settle}`
    if (sent.current.has(key)) return
    sent.current.add(key)
    attend(id, { settle, opened: true }).catch((cause: unknown) => {
      if (!(cause instanceof ApiError && cause.code === 'attend-stale')) sent.current.delete(key)
    })
  }, [id, settle])
}
