import type { AppSnapshot, RunLive, TaskSummary, WorkspaceInfo } from '@latch/protocol'
import { runClock, runElapsed } from './conversation.ts'
import { parseTime } from './core/hostClock.ts'
import { basename } from './format.ts'
import { storageGet, storageSet } from './preferences.ts'

export type SessionFilter = 'all' | 'archived'

/**
 * What a session is doing, as far as the Host has said. Nothing here is guessed from elapsed time: silence is the Host's
 * own judgement, 正在停止 lasts until the run has really settled, and 已停止 is said only after that.
 */
export type RowStatus =
  | { kind: 'waiting' }
  /** The Host says the run has gone quiet past its threshold. It waits on the person too: 继续等 or 停止. */
  | { kind: 'silent' }
  | { kind: 'stopping' }
  | { kind: 'running' }
  | { kind: 'failed' }
  | { kind: 'unread' }
  /** Ended without an answer. `unknown` is how many results nobody can vouch for. */
  | { kind: 'ended'; word: string; unknown: number }
  /** The connection is down: what the row last knew may no longer be true, so nothing live is drawn. */
  | { kind: 'frozen' }
  | { kind: 'read' }

const liveNow = (task: TaskSummary) => (task.status === 'running' || task.status === 'waiting-approval' ? task.live : undefined)

/** The engine has done nothing since a request Latch could not answer: it may have stopped on it. */
function stuckOnRequest(live: RunLive | undefined): boolean {
  const asked = parseTime(live?.unrecognized?.at)
  const last = parseTime(live?.lastEventAt)
  return asked !== undefined && last !== undefined && asked >= last
}

/**
 * Waits on the person: an approval, a question, a request Latch did not recognise and nothing since, or a run the Host
 * calls silent. A stop already asked for answers all of these. A question leaves the status at running, so only its count says so.
 */
export function waitsOnYou(task: TaskSummary): boolean {
  const live = liveNow(task)
  if (live?.activity === 'cancelling') return false
  if (task.status === 'waiting-approval') return true
  return task.status === 'running' && (Boolean(task.pendingQuestions) || live?.silent === true || stuckOnRequest(live))
}

/** How many sessions wait on the person; what 等你处理 counts, here and on the Dock. An approval's session may be outside the list. */
export function waitingCount(snapshot: Pick<AppSnapshot, 'tasks' | 'approvals'>): number {
  const stopping = new Set(snapshot.tasks.filter(task => liveNow(task)?.activity === 'cancelling').map(task => task.id))
  const asking = snapshot.approvals.map(approval => approval.sessionId).filter(id => !stopping.has(id))
  return new Set([...asking, ...snapshot.tasks.filter(waitsOnYou).map(task => task.id)]).size
}

export function rowStatus(task: TaskSummary, { unread = false, stopping = false, frozen = false } = {}): RowStatus {
  const running = task.status === 'running' || task.status === 'waiting-approval'
  if (running && frozen) return { kind: 'frozen' }
  if (running && (stopping || liveNow(task)?.activity === 'cancelling')) return { kind: 'stopping' }
  if (task.status === 'waiting-approval') return { kind: 'waiting' }
  if (task.status === 'running') {
    const live = liveNow(task)
    if (task.pendingQuestions || stuckOnRequest(live)) return { kind: 'waiting' }
    return { kind: live?.silent ? 'silent' : 'running' }
  }
  const outcome = task.status === 'idle' ? task.runOutcome : undefined
  if (task.status === 'failed' || outcome === 'failed') return { kind: 'failed' }
  const unknown = task.runEnd?.unknownResultCount ?? 0
  if (task.status === 'cancelled' || outcome === 'cancelled') return { kind: 'ended', word: '已停止', unknown }
  if (task.status === 'interrupted' || outcome === 'interrupted')
    return { kind: 'ended', word: task.runEnd?.reason === 'forced-stop' ? '已强制停止' : '已中断', unknown }
  return { kind: unread ? 'unread' : 'read' }
}

/** A read session is one line: its title and one signal. Anything that still asks for attention gets the second line. */
export const isOneLine = (status: RowStatus) => status.kind === 'read' || (status.kind === 'ended' && status.unknown === 0)

/** 运行中 1:12, or 运行中 alone when the Host did not say when the run began. */
export function runningWords(live: RunLive | undefined, hostNow: number): string {
  const ms = live && runElapsed(live, hostNow)
  return ms === undefined ? '运行中' : `运行中 ${runClock(ms)}`
}

/** 没有动静 3 分钟, counted from the engine's last sign of life. */
export function silentWords(live: RunLive | undefined, hostNow: number): string {
  const last = parseTime(live?.lastEventAt)
  if (last === undefined) return '没有动静'
  const minutes = Math.max(1, Math.floor((hostNow - last) / 60_000))
  return minutes < 60 ? `没有动静 ${minutes} 分钟` : `没有动静 ${Math.floor(minutes / 60)} 小时`
}

/** What the row's second line adds after the Agent: its project in 等你处理, otherwise its branch; results nobody can vouch for come first. */
export function rowMeta(task: TaskSummary, status: RowStatus, project: string | undefined): string | undefined {
  if (status.kind === 'ended' && status.unknown > 0) return `${status.unknown} 条结果未知`
  const unknown = task.runEnd?.unknownResultCount ?? 0
  if (status.kind === 'failed' && unknown > 0) return `${unknown} 条结果未知`
  return project ?? task.branch
}

/** Archived sessions appear only under their own filter; search matches titles. */
export function filterSessions(tasks: TaskSummary[], filter: SessionFilter, query: string): TaskSummary[] {
  const needle = query.trim().toLocaleLowerCase()
  return tasks.filter(task => {
    if (filter === 'archived' ? !task.archived : task.archived) return false
    return !needle || task.title.toLocaleLowerCase().includes(needle)
  })
}

const byRecency = (a: TaskSummary, b: TaskSummary) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)

export interface SessionGroup {
  /** `waiting`, `project:<workspace id>`, `dir:<path>` (a Host that does not list its projects), or `other`. */
  id: string
  label: string
  tasks: TaskSummary[]
  /** The saved project the group stands for, where a new session can start. */
  workspaceId?: string
  project?: WorkspaceInfo
}

const trimPath = (path: string) => path.replace(/[\\/]+$/u, '') || path
const within = (path: string, root: string) => {
  const [inner, outer] = [trimPath(path), trimPath(root)]
  return inner === outer || inner.startsWith(`${outer}/`) || inner.startsWith(`${outer}\\`)
}

/** Recorded project identity wins over overlapping paths; legacy sessions use the deepest primary. */
export function projectOf(task: TaskSummary, workspaces: readonly WorkspaceInfo[]): WorkspaceInfo | undefined {
  if (task.mode === 'chat') return undefined
  if (task.workspaceId !== undefined && task.workspaceId !== 'default') return workspaces.find(project => project.id === task.workspaceId)
  const saved = workspaces.filter(project => project.id !== 'default')
  if (task.workspaceId === 'default') {
    return task.cwd === undefined
      ? undefined
      : saved.find(project => (project.folders ?? [{ path: project.path }]).some(folder => trimPath(folder.path) === trimPath(task.cwd!)))
  }
  if (task.cwd === undefined) return undefined
  return saved.filter(project => within(task.cwd!, project.path)).toSorted((a, b) => trimPath(b.path).length - trimPath(a.path).length)[0]
}

/** The caller's snapshot is the only source; Personal sessions never become project navigation. */
export function recentProjectSessions(
  projectId: string,
  tasks: readonly TaskSummary[],
  workspaces: readonly WorkspaceInfo[],
): TaskSummary[] {
  return tasks
    .filter(task => task.personal === undefined && projectOf(task, workspaces)?.id === projectId)
    .toSorted(byRecency)
    .slice(0, 3)
}

/**
 * 等你处理 while something waits, saved projects by their latest session, then conversations outside a project. Pinned
 * sessions lead their own shelf. Only `waitingFrom` moves a session to 等你处理: a search or the archive keeps it in place.
 */
export function groupSessions(
  tasks: TaskSummary[],
  workspaces: readonly WorkspaceInfo[] | undefined,
  options: { includeEmpty?: boolean; waitingFrom?: readonly TaskSummary[] } = {},
): SessionGroup[] {
  const waiting: SessionGroup = {
    id: 'waiting',
    label: '等你处理',
    tasks: (options.waitingFrom ?? []).filter(waitsOnYou).toSorted(byRecency),
  }
  const shelved = new Set(waiting.tasks.map(task => task.id))
  const other: SessionGroup = { id: 'other', label: workspaces === undefined ? '会话' : '无项目', tasks: [] }
  const projects = new Map<string, SessionGroup>()
  const makeProject = (project: WorkspaceInfo): SessionGroup => ({
    id: `project:${project.id}`,
    label: project.name || basename(project.path),
    tasks: [],
    project,
    ...(project.unavailable === undefined ? { workspaceId: project.id } : {}),
  })
  for (const task of tasks.toSorted(byRecency)) {
    if (shelved.has(task.id)) continue
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
    const group = projects.get(id) ?? makeProject(project)
    group.tasks.push(task)
    projects.set(id, group)
  }
  if (options.includeEmpty)
    for (const project of workspaces ?? []) {
      if (project.id !== 'default' && !projects.has(`project:${project.id}`)) projects.set(`project:${project.id}`, makeProject(project))
    }
  const shelves = [waiting, ...projects.values(), other].filter(
    group => group.tasks.length > 0 || (options.includeEmpty && group.project !== undefined),
  )
  // A stable sort, so pinned rows keep their own recency order at the head of the shelf.
  return shelves.map(group => ({ ...group, tasks: group.tasks.toSorted((a, b) => Number(b.pinned === true) - Number(a.pinned === true)) }))
}

/**
 * The rows as the list draws them, top to bottom, for stepping through it: 等你处理 first and nothing from a folded shelf.
 * Only browsing moves a session to 等你处理, as in the list itself.
 */
export function listedSessions(
  tasks: TaskSummary[],
  workspaces: readonly WorkspaceInfo[] | undefined,
  { filter, search, folded }: { filter: SessionFilter; search: string; folded: ReadonlySet<string> },
): TaskSummary[] {
  return groupSessions(filterSessions(tasks, filter, search), workspaces, filter !== 'archived' && !search ? { waitingFrom: tasks } : {})
    .filter(group => !folded.has(group.id))
    .flatMap(group => group.tasks)
}

/** The row one step from `selectedId`, wrapping; from outside the list, the first or the last. */
export function steppedSession(ordered: readonly TaskSummary[], selectedId: string | null, step: 1 | -1): TaskSummary | undefined {
  const index = ordered.findIndex(task => task.id === selectedId)
  if (index < 0) return step === 1 ? ordered[0] : ordered.at(-1)
  return ordered[(index + step + ordered.length) % ordered.length]
}

export const shelvesKey = (deviceId: string) => `latch.shelves.${location.origin}.${deviceId}`

/** The shelves this device has folded. */
export function readFolded(key: string): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(storageGet(key) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

export function writeFolded(key: string, folded: ReadonlySet<string>): void {
  storageSet(key, JSON.stringify([...folded]))
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
