import type { TaskSummary } from '@latch/protocol'
import { storageGet, storageSet } from './preferences.ts'

export type SessionFilter = 'all' | 'chat' | 'agent' | 'archived'
export const sessionFilterLabels: Record<SessionFilter, string> = { all: '全部会话', chat: '对话', agent: 'Agent', archived: '已归档' }

export interface SessionGroup {
  id: 'pinned' | 'today' | 'yesterday' | 'week' | 'earlier'
  label: string
  tasks: TaskSummary[]
}

/** Archived sessions appear only under their own filter; search matches titles. */
export function filterSessions(tasks: TaskSummary[], filter: SessionFilter, query: string): TaskSummary[] {
  const needle = query.trim().toLocaleLowerCase()
  return tasks.filter(task => {
    if (filter === 'archived' ? !task.archived : task.archived) return false
    if ((filter === 'chat' || filter === 'agent') && (task.mode ?? 'agent') !== filter) return false
    return !needle || task.title.toLocaleLowerCase().includes(needle)
  })
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
const byRecency = (a: TaskSummary, b: TaskSummary) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)

/** Pinned first, then 今天 / 昨天 / 过去 7 天 / 更早 in local time, each newest first. */
export function groupSessions(tasks: TaskSummary[], now = new Date()): SessionGroup[] {
  const today = startOfDay(now)
  const yesterday = today - 86_400_000
  const week = today - 6 * 86_400_000
  const groups: SessionGroup[] = [
    { id: 'pinned', label: '置顶', tasks: [] },
    { id: 'today', label: '今天', tasks: [] },
    { id: 'yesterday', label: '昨天', tasks: [] },
    { id: 'week', label: '过去 7 天', tasks: [] },
    { id: 'earlier', label: '更早', tasks: [] },
  ]
  const [pinned, todayGroup, yesterdayGroup, weekGroup, earlier] = groups as [
    SessionGroup,
    SessionGroup,
    SessionGroup,
    SessionGroup,
    SessionGroup,
  ]
  for (const task of [...tasks].sort(byRecency)) {
    const time = Date.parse(task.updatedAt) || 0
    const group = task.pinned
      ? pinned
      : time >= today
        ? todayGroup
        : time >= yesterday
          ? yesterdayGroup
          : time >= week
            ? weekGroup
            : earlier
    group.tasks.push(task)
  }
  return groups.filter(group => group.tasks.length > 0)
}

/**
 * Per-device read markers. Sessions updated after the device last opened them get
 * an unread dot; the baseline keeps a first visit from marking all history unread.
 */
export interface SeenState {
  baseline: string
  seen: Record<string, string>
}

export function emptySeen(now = new Date()): SeenState {
  return { baseline: now.toISOString(), seen: {} }
}

export function isUnread(task: TaskSummary, state: SeenState): boolean {
  const updated = Date.parse(task.updatedAt)
  const seen = Date.parse(state.seen[task.id] ?? state.baseline)
  return !Number.isNaN(updated) && !Number.isNaN(seen) && updated > seen
}

export function markSeen(state: SeenState, id: string, updatedAt: string): SeenState {
  const previous = state.seen[id]
  if (previous !== undefined && Date.parse(previous) >= Date.parse(updatedAt)) return state
  return { ...state, seen: { ...state.seen, [id]: updatedAt } }
}

/** Forget markers of deleted sessions so storage stays bounded by the Host's list. */
export function pruneSeen(state: SeenState, tasks: TaskSummary[]): SeenState {
  const ids = new Set(tasks.map(task => task.id))
  const kept = Object.entries(state.seen).filter(([id]) => ids.has(id))
  return kept.length === Object.keys(state.seen).length ? state : { ...state, seen: Object.fromEntries(kept) }
}

export function readSeen(key: string): SeenState | null {
  try {
    const value: unknown = JSON.parse(storageGet(key) ?? 'null')
    if (typeof value !== 'object' || value === null) return null
    const item = value as Record<string, unknown>
    if (typeof item.baseline !== 'string' || typeof item.seen !== 'object' || item.seen === null) return null
    const seen = Object.fromEntries(Object.entries(item.seen).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    return { baseline: item.baseline, seen }
  } catch {
    return null
  }
}

export function writeSeen(key: string, state: SeenState): void {
  storageSet(key, JSON.stringify(state))
}
