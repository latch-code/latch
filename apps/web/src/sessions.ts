import type { TaskSummary, WorkspaceInfo } from '@latch/protocol'
import { basename } from './format.ts'
import type { SlotStatus } from '@latch/ui'
import { storageGet, storageSet } from './preferences.ts'

export type SessionFilter = 'all' | 'chat' | 'agent' | 'archived'
export const sessionFilterLabels: Record<SessionFilter, string> = { all: '全部', chat: '对话', agent: 'Agent', archived: '已归档' }

/**
 * The one thing a session row's status slot shows, by priority: waiting for the person, failed (a session whose
 * permission mode changed is drawn as failed too, with its own words), running, unread, then the time. A cancelled or
 * interrupted session shows its time; the top bar names that state when it is open. The open session's row leaves out
 * the comet, since its run bar says it is running.
 */
export function sessionSlot(task: TaskSummary, selected: boolean, unread: boolean): SlotStatus {
  if (task.status === 'waiting-approval') return 'waiting'
  if (task.status === 'failed' || task.permissionDrift) return 'failed'
  if (task.status === 'running') return selected ? 'none' : 'running'
  if (unread) return 'unread'
  return 'time'
}

/**
 * What a phone's row says on its second line after the harness: the one fact its status slot does not already say. A
 * running session says so in words (the slot only turns); a cancelled or interrupted one names that state (its slot
 * shows the time); one that waits, failed or has something new keeps its time there (its slot shows that instead); a
 * finished one says nothing more. Never a preview of the conversation: the Host sends none.
 */
export function sessionFact(task: TaskSummary, slot: SlotStatus, cancelling: boolean, time: string): string | undefined {
  if (cancelling) return '正在取消'
  if (slot === 'running') return '正在运行'
  if (slot === 'time') return task.status === 'cancelled' ? '已取消' : task.status === 'interrupted' ? '已中断' : undefined
  if (slot === 'none') return undefined
  return time || undefined
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

const byRecency = (a: TaskSummary, b: TaskSummary) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)

export interface SessionGroup {
  /** `pinned`, `project:<workspace id>`, `dir:<path>` (a Host that does not list its projects), or `other`. */
  id: string
  label: string
  tasks: TaskSummary[]
  /** The saved project the group stands for, where a new session can start. */
  workspaceId?: string
}

const trimPath = (path: string) => path.replace(/[\\/]+$/u, '') || path
const within = (path: string, root: string) => {
  const [inner, outer] = [trimPath(path), trimPath(root)]
  return inner === outer || inner.startsWith(`${outer}/`) || inner.startsWith(`${outer}\\`)
}

/**
 * The saved project a session ran in: the deepest one holding its working directory. A session that does not record
 * its directory ran in the start directory (the `default` project) where the Host has one.
 */
export function projectOf(task: TaskSummary, workspaces: readonly WorkspaceInfo[]): WorkspaceInfo | undefined {
  if (task.cwd === undefined) return workspaces.find(workspace => workspace.id === 'default')
  const cwd = task.cwd
  return workspaces
    .filter(workspace => within(cwd, workspace.path))
    .toSorted((a, b) => trimPath(b.path).length - trimPath(a.path).length)[0]
}

/**
 * Pinned first, then a group per project, each newest first; the groups follow their latest session, and sessions
 * outside every saved project come last under 其他目录. A Host that does not list its projects (`workspaces`
 * undefined) groups by working directory instead.
 */
export function groupSessions(tasks: TaskSummary[], workspaces: readonly WorkspaceInfo[] | undefined): SessionGroup[] {
  const pinned: SessionGroup = { id: 'pinned', label: '置顶', tasks: [] }
  const other: SessionGroup = { id: 'other', label: workspaces === undefined ? '会话' : '其他目录', tasks: [] }
  const projects = new Map<string, SessionGroup>()
  for (const task of tasks.toSorted(byRecency)) {
    if (task.pinned) {
      pinned.tasks.push(task)
      continue
    }
    if (workspaces === undefined) {
      if (task.cwd === undefined) other.tasks.push(task)
      else {
        const id = `dir:${trimPath(task.cwd)}`
        const group = projects.get(id) ?? { id, label: basename(task.cwd), tasks: [] }
        group.tasks.push(task)
        projects.set(id, group)
      }
      continue
    }
    const project = projectOf(task, workspaces)
    if (project === undefined) {
      other.tasks.push(task)
      continue
    }
    const id = `project:${project.id}`
    const group = projects.get(id) ?? {
      id,
      // The start directory's own name (默认工作区) says less than its folder's.
      label: project.id === 'default' ? basename(project.path) : project.name || basename(project.path),
      tasks: [],
      ...(project.unavailable === undefined ? { workspaceId: project.id } : {}),
    }
    group.tasks.push(task)
    projects.set(id, group)
  }
  // Tasks were added newest first, so each group's first task is its latest and the map keeps that order.
  return [pinned, ...projects.values(), other].filter(group => group.tasks.length > 0)
}

/**
 * Per-device read markers. Sessions updated after the device last opened them get
 * an unread dot; the baseline keeps a first visit from marking all history unread.
 */
export interface SeenState {
  baseline: string
  seen: Record<string, string>
  unread?: Record<string, true>
}

export function emptySeen(now = new Date()): SeenState {
  return { baseline: now.toISOString(), seen: {} }
}

export function isUnread(task: TaskSummary, state: SeenState): boolean {
  if (state.unread?.[task.id]) return true
  const updated = Date.parse(task.updatedAt)
  const seen = Date.parse(state.seen[task.id] ?? state.baseline)
  return !Number.isNaN(updated) && !Number.isNaN(seen) && updated > seen
}

export function markSeen(state: SeenState, id: string, updatedAt: string): SeenState {
  const previous = state.seen[id]
  if (previous !== undefined && Date.parse(previous) >= Date.parse(updatedAt) && !state.unread?.[id]) return state
  const unread = { ...state.unread }
  delete unread[id]
  return { ...state, unread, seen: { ...state.seen, [id]: updatedAt } }
}

export function markUnread(state: SeenState, id: string): SeenState {
  return { ...state, unread: { ...state.unread, [id]: true } }
}

/** Forget markers of deleted sessions so storage stays bounded by the Host's list. */
export function pruneSeen(state: SeenState, tasks: TaskSummary[]): SeenState {
  const ids = new Set(tasks.map(task => task.id))
  const kept = Object.entries(state.seen).filter(([id]) => ids.has(id))
  const unread = Object.fromEntries(Object.entries(state.unread ?? {}).filter(([id]) => ids.has(id)))
  return kept.length === Object.keys(state.seen).length && Object.keys(unread).length === Object.keys(state.unread ?? {}).length
    ? state
    : { ...state, unread, seen: Object.fromEntries(kept) }
}

export function readSeen(key: string): SeenState | null {
  try {
    const value: unknown = JSON.parse(storageGet(key) ?? 'null')
    if (typeof value !== 'object' || value === null) return null
    const item = value as Record<string, unknown>
    if (typeof item.baseline !== 'string' || typeof item.seen !== 'object' || item.seen === null) return null
    const seen = Object.fromEntries(Object.entries(item.seen).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    const unread =
      typeof item.unread === 'object' && item.unread !== null
        ? (Object.fromEntries(Object.entries(item.unread).filter(([, flag]) => flag === true)) as Record<string, true>)
        : {}
    return { baseline: item.baseline, seen, unread }
  } catch {
    return null
  }
}

export function writeSeen(key: string, state: SeenState): void {
  storageSet(key, JSON.stringify(state))
}
