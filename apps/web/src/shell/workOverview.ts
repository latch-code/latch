import type { TaskSummary } from '@latch/protocol'
import { useEffect, type KeyboardEvent, type RefObject } from 'react'
import { sessionReadOnly } from '../core/permissions.ts'
import { activityWords, rowStatus, runningWords, silentWords, spaceOf, waitKind, waitsOnYou, type Space } from '../sessions.ts'

export type WorkGroupId = 'attention' | 'running' | 'delivery'

export interface WorkGroup {
  id: WorkGroupId
  label: string
  empty: string
  tasks: TaskSummary[]
}

function latestWorkFirst(a: TaskSummary, b: TaskSummary): number {
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.id.localeCompare(b.id)
}

/** Resume a session that is not already represented by a decision, a live run, or delivery evidence. */
export function recentCodeWork(tasks: readonly TaskSummary[], groups: readonly WorkGroup[]): TaskSummary[] {
  const listed = new Set(groups.flatMap(group => group.tasks.map(task => task.id)))
  return tasks
    .filter(task => task.status === 'idle' && !task.archived && !sessionReadOnly(task) && spaceOf(task) === 'code' && !listed.has(task.id))
    .toSorted(latestWorkFirst)
    .slice(0, 3)
}

/**
 * A navigation projection of the Host's summaries, never an assertion that a change is ready to deliver. `space` is the
 * place whose sessions are grouped: Code's, or the topics of 我的 Agent (which have no delivery).
 */
export function workGroups(
  tasks: readonly TaskSummary[],
  cancelling: ReadonlySet<string> = new Set(),
  delivery: ReadonlySet<string> = new Set(),
  space: Space = 'code',
): WorkGroup[] {
  const groups: Record<WorkGroupId, WorkGroup> = {
    attention: { id: 'attention', label: '等你处理', empty: '没有要你处理的', tasks: [] },
    running: { id: 'running', label: '进行中', empty: '没有进行中的', tasks: [] },
    delivery: { id: 'delivery', label: '可交付', empty: '没有可交付的', tasks: [] },
  }
  const visible = tasks.filter(task => !task.archived && spaceOf(task) === space).toSorted(latestWorkFirst)
  for (const task of visible) {
    const status = rowStatus(task, { stopping: cancelling.has(task.id) })
    const live = task.status === 'running' || task.status === 'waiting-approval'
    const attention = status.kind !== 'stopping' && waitsOnYou(task)
    const unsettled = !live && (status.kind === 'failed' || (task.runEnd?.unknownResultCount ?? 0) > 0)
    if (attention || unsettled) groups.attention.tasks.push(task)
    else if (live) groups.running.tasks.push(task)
    else if (delivery.has(task.id)) groups.delivery.tasks.push(task)
  }
  const priority = (task: TaskSummary) => (task.status === 'waiting-approval' && !task.pendingQuestions ? 0 : waitsOnYou(task) ? 1 : 2)
  groups.attention.tasks.sort((a, b) => priority(a) - priority(b))
  return [groups.attention, groups.running, groups.delivery]
}

export interface WorkStatus {
  tone: 'neutral' | 'waiting' | 'running' | 'failed' | 'warn'
  words: string
}

/** Keep the last known work visible while disconnected, without advancing a timer or drawing a live spinner. */
export function workStatus(
  task: TaskSummary,
  { connected, now, stopping = false, unread = false }: { connected: boolean; now: number; stopping?: boolean; unread?: boolean },
): WorkStatus {
  const status = rowStatus(task, { stopping, unread })
  const live = task.status === 'running' || task.status === 'waiting-approval'
  const unknown = live ? 0 : (task.runEnd?.unknownResultCount ?? 0)
  if (!connected && live) {
    const words = status.kind === 'stopping' ? '正在停止' : waitsOnYou(task) ? '等你处理' : activityWords(task.live)
    return { tone: 'neutral', words: `上次状态：${words}` }
  }
  if (status.kind === 'stopping') return { tone: 'running', words: '正在停止' }
  if (status.kind === 'waiting' || status.kind === 'silent') {
    const wait = waitKind(task)
    return {
      tone: 'waiting',
      words: wait?.kind === 'asks' ? wait.words : wait?.kind === 'silent' ? silentWords(task.live, now) : '等你处理',
    }
  }
  if (status.kind === 'running') return { tone: 'running', words: runningWords(task.live, now) }
  if (status.kind === 'failed') return { tone: 'failed', words: unknown > 0 ? `失败 · ${unknown} 条结果未知` : '失败' }
  if (unknown > 0) return { tone: 'warn', words: `${unknown} 条结果未知` }
  if (status.kind === 'ended') return { tone: 'neutral', words: status.word }
  if (status.kind === 'unread') return { tone: 'neutral', words: '有新内容' }
  return { tone: 'neutral', words: task.runOutcome === 'completed' ? '本轮已结束' : '会话记录' }
}

/** The row a key moves to among `count` rows from `index`; undefined for any other key. */
export function rowStep(key: string, index: number, count: number): number | undefined {
  if (count === 0) return undefined
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowDown') return Math.min(index + 1, count - 1)
  if (key === 'ArrowUp') return Math.max(index - 1, 0)
  return undefined
}

const OVERVIEW_ROWS = '.work-overview-review-row, .work-overview-row, .work-delivery-title'

/** Arrow keys, Home and End move the focus through every row shown under `container`, expanded rows included. */
export function stepRows(event: KeyboardEvent, container: HTMLElement): void {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !(event.target instanceof HTMLElement)) return
  if (!event.target.matches(OVERVIEW_ROWS)) return
  const rows = [...container.querySelectorAll<HTMLElement>(OVERVIEW_ROWS)].filter(row => row.checkVisibility())
  const next = rowStep(event.key, rows.indexOf(event.target), rows.length)
  if (next === undefined) return
  event.preventDefault()
  rows[next]!.focus({ preventScroll: true })
  rows[next]!.scrollIntoView({ block: 'nearest' })
}

/** Marks the home's queue once it scrolls, so rows pass under the top edge behind a hairline, not half cut. */
export function useQueueEdge(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const queue = root.current?.closest<HTMLElement>('.code-home-queue')
    if (!queue) return
    const read = () => queue.toggleAttribute('data-scrolled', queue.scrollTop > 0)
    read()
    queue.addEventListener('scroll', read, { passive: true })
    return () => {
      queue.removeEventListener('scroll', read)
      queue.removeAttribute('data-scrolled')
    }
  }, [root])
}
