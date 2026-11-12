import { escapeSecurityText, type AppSnapshot, type RunLive, type TaskSummary, type WorkspaceInfo } from '@latch/protocol'
import { DEFAULT_MODEL } from './composer/modelReasoning.ts'
import { runClock, runElapsed } from './conversation.ts'
import { parseTime } from './core/hostClock.ts'
import { basename } from './format.ts'
import { storageGet, storageSet } from './preferences.ts'

export type SessionFilter = 'all' | 'archived'

/**
 * The two places of a wide window's navigation: Code (the sessions you start) and 我的 Agent (the sessions delegated to
 * one of your Agents, and conversations with 通用). A session's place is fixed when it starts: only `TaskSummary.agent` and
 * `TaskSummary.generalChat` say it is 我的 Agent's.
 */
export type Space = 'code' | 'agents'

export const spaceOf = (task: Pick<TaskSummary, 'agent' | 'generalChat'>): Space => (task.agent || task.generalChat ? 'agents' : 'code')

/** The sessions of one place; every session when no place is given. */
export function inSpace<T extends Pick<TaskSummary, 'agent' | 'generalChat'>>(tasks: readonly T[], space: Space | undefined): T[] {
  return space === undefined ? [...tasks] : tasks.filter(task => spaceOf(task) === space)
}

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

/**
 * How many sessions wait on the person; what 等你处理 counts, here and on the Dock. An approval's session may be outside
 * the list; with a place given, only that place's listed sessions count, so its dot always has a row to point at.
 */
export function waitingCount(snapshot: Pick<AppSnapshot, 'tasks' | 'approvals'>, space?: Space): number {
  const stopping = new Set(snapshot.tasks.filter(task => liveNow(task)?.activity === 'cancelling').map(task => task.id))
  const placed = new Map(snapshot.tasks.map(task => [task.id, spaceOf(task)]))
  // A place counts only what its own lists can show: an approval of a session no list holds counts in the total alone.
  const here = (id: string) => space === undefined || placed.get(id) === space
  const asking = snapshot.approvals.map(approval => approval.sessionId).filter(id => !stopping.has(id) && here(id))
  return new Set([...asking, ...snapshot.tasks.filter(task => waitsOnYou(task) && here(task.id)).map(task => task.id)]).size
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

/** What a running row says the run is doing, from the summary's activity alone; 运行中 when the Host named none. */
const ACTIVITY_WORDS: Partial<Record<RunLive['activity'], string>> = {
  starting: '在启动',
  model: '在等模型',
  command: '在跑命令',
  tool: '在用工具',
}

export const activityWords = (live: RunLive | undefined): string => (live && ACTIVITY_WORDS[live.activity]) ?? '运行中'

/** 在跑命令 1:12, or the words alone when the Host did not say when the run began. */
export function runningWords(live: RunLive | undefined, hostNow: number): string {
  const ms = live && runElapsed(live, hostNow)
  const words = activityWords(live)
  return ms === undefined ? words : `${words} ${runClock(ms)}`
}

/** 没有动静 3 分钟, counted from the engine's last sign of life. */
export function silentWords(live: RunLive | undefined, hostNow: number): string {
  const last = parseTime(live?.lastEventAt)
  if (last === undefined) return '没有动静'
  const minutes = Math.max(1, Math.floor((hostNow - last) / 60_000))
  return minutes < 60 ? `没有动静 ${minutes} 分钟` : `没有动静 ${Math.floor(minutes / 60)} 小时`
}

/** Results nobody can vouch for after a run that ended without an answer: the one fact a row's second line adds. */
export function unknownNote(task: TaskSummary, status: RowStatus): string | undefined {
  if (status.kind === 'ended' && status.unknown > 0) return `${status.unknown} 条结果未知`
  const unknown = task.runEnd?.unknownResultCount ?? 0
  if (status.kind === 'failed' && unknown > 0) return `${unknown} 条结果未知`
  return undefined
}

/** What the phone row's second line adds after the Harness: its project in 等你处理, otherwise its branch; unknown results first. */
export function rowMeta(task: TaskSummary, status: RowStatus, project: string | undefined): string | undefined {
  return unknownNote(task, status) ?? project ?? task.branch
}

/**
 * The model a sidebar row names: the one chosen on the model service Latch forwards to, else the one the session or its
 * Harness reported, else 默认模型 (an external Harness may not have reported one yet). Escaped like any text from the Host.
 */
export function rowModel(task: Pick<TaskSummary, 'model' | 'modelRoute'>): string {
  const model = task.modelRoute?.model || task.model
  return model ? escapeSecurityText(model) : DEFAULT_MODEL
}

/**
 * What a row in 等你处理 waits on, from the summary alone: an approval, how many questions, a request Latch could not
 * read, or silence. Never what a request would do or where: the list holds no session content.
 */
export type WaitKind = { kind: 'asks'; words: string } | { kind: 'silent' }

export function waitKind(task: TaskSummary): WaitKind | undefined {
  const live = liveNow(task)
  if (live?.activity === 'cancelling') return undefined
  if (task.status !== 'running' && task.status !== 'waiting-approval') return undefined
  const asks = [
    ...(task.status === 'waiting-approval' ? ['审批'] : []),
    ...(task.pendingQuestions ? [`${task.pendingQuestions} 个问题`] : []),
  ]
  if (asks.length > 0) return { kind: 'asks', words: asks.join(' · ') }
  if (stuckOnRequest(live)) return { kind: 'asks', words: '看不懂的请求' }
  return live?.silent ? { kind: 'silent' } : undefined
}

/** Archived sessions appear only under their own filter; search matches titles; a place keeps only its own sessions. */
export function filterSessions(tasks: TaskSummary[], filter: SessionFilter, query: string, space?: Space): TaskSummary[] {
  const needle = query.trim().toLocaleLowerCase()
  return tasks.filter(task => {
    if (filter === 'archived' ? !task.archived : task.archived) return false
    if (space !== undefined && spaceOf(task) !== space) return false
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

/** The caller's snapshot is the only source; a session an assistant ran never becomes project navigation. */
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
  {
    filter,
    search,
    folded,
    space,
    expanded = false,
  }: {
    filter: SessionFilter
    search: string
    folded: ReadonlySet<string>
    space?: Space
    /** 我的 Agent: 最近委托 shows every delegation (全部). */
    expanded?: boolean
  },
): TaskSummary[] {
  if (space === 'agents') return delegationRows(tasks, { filter, expanded }).rows
  return groupSessions(
    filterSessions(tasks, filter, search, space),
    workspaces,
    filter !== 'archived' && !search ? { waitingFrom: inSpace(tasks, space) } : {},
  )
    .filter(group => !folded.has(group.id))
    .flatMap(group => group.tasks)
}

/** How many delegations 我的 Agent's list shows under 最近委托 before 全部. */
export const RECENT_DELEGATIONS = 6

/**
 * The delegations 我的 Agent's list draws, in its order. 最近委托 lifts what waits on you to the top (archived or not,
 * as Code's 等你处理 does), then the rest newest first without the archived, and cuts after `limit` unless expanded,
 * never before the last one that waits; under 已归档 it is the archived ones, newest first. `total` is how many 全部
 * would show; `archived` how many 已归档 holds.
 */
export function delegationRows(
  tasks: readonly TaskSummary[],
  { filter = 'all', expanded = false, limit = RECENT_DELEGATIONS }: { filter?: SessionFilter; expanded?: boolean; limit?: number } = {},
): { rows: TaskSummary[]; total: number; archived: number } {
  const own = inSpace(tasks, 'agents').toSorted(byRecency)
  const archived = own.filter(task => task.archived)
  if (filter === 'archived') return { rows: archived, total: archived.length, archived: archived.length }
  const waiting = own.filter(waitsOnYou)
  const lifted = new Set(waiting.map(task => task.id))
  const listed = [...waiting, ...own.filter(task => !task.archived && !lifted.has(task.id))]
  const cut = expanded ? listed.length : Math.max(limit, waiting.length)
  return { rows: listed.slice(0, cut), total: listed.length, archived: archived.length }
}

/** 最近委托 as it stands before 全部. */
export function recentDelegations(tasks: readonly TaskSummary[], limit = RECENT_DELEGATIONS): TaskSummary[] {
  return delegationRows(tasks, { limit }).rows
}

/** Where this device was last, kept per device; Code when nothing (or nothing readable) was kept. */
export const spaceKey = (deviceId: string) => `latch.space.${location.origin}.${deviceId}`

export function readSpace(key: string): Space {
  return storageGet(key) === 'agents' ? 'agents' : 'code'
}

export function writeSpace(key: string, space: Space): void {
  storageSet(key, space)
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
