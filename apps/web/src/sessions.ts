import {
  escapeSecurityText,
  type AppSnapshot,
  type BoardGroup,
  type RunLive,
  type TaskSummary,
  type TeamSummary,
  type WorkItemSummary,
  type WorkspaceInfo,
} from '@latch/protocol'
import { runClock, runElapsed } from './conversation.ts'
import { parseTime } from './core/hostClock.ts'
import { basename } from './format.ts'
import { storageGet, storageSet } from './preferences.ts'
import { defineCopy, plural } from './core/i18n.ts'

const COPY = defineCopy(
  {
    stopped: '已停止',
    forcedStop: '已强制停止',
    interrupted: '已中断',
    starting: '在启动',
    model: '在等模型',
    command: '在跑命令',
    tool: '在用工具',
    queuedFor: (reason: string) => `排队：${reason}`,
    queued: '排队',
    running: '运行中',
    quiet: '没有动静',
    minutes: (minutes: number) => `没有动静 ${minutes} 分钟`,
    hours: (hours: number) => `没有动静 ${hours} 小时`,
    unknown: (count: number) => `${count} 条结果未知`,
    approval: '审批',
    questions: (count: number) => `${count} 个问题`,
    unsupported: '不支持的请求',
    stopping: '正在停止',
    attention: '等你处理',
    last: (status: string) => `上次状态：${status}`,
    failedUnknown: (count: number) => `失败 · ${count} 条结果未知`,
    failed: '失败',
    fresh: '有新内容',
    completed: '本轮已结束',
    transcript: '会话记录',
    sessions: '会话',
    noProject: '无项目',
  },
  {
    stopped: 'Stopped',
    forcedStop: 'Force stopped',
    interrupted: 'Interrupted',
    starting: 'Starting',
    model: 'Waiting for model',
    command: 'Running a command',
    tool: 'Using a tool',
    queuedFor: (reason: string) => `Queued: ${reason}`,
    queued: 'Queued',
    running: 'Running',
    quiet: 'No activity',
    minutes: (minutes: number) => `No activity for ${minutes} min`,
    hours: (hours: number) => `No activity for ${hours} hr`,
    unknown: (count: number) => plural(count, { one: '{n} unknown outcome', other: '{n} unknown outcomes' }),
    approval: 'Approval',
    questions: (count: number) => plural(count, { one: '{n} question', other: '{n} questions' }),
    unsupported: 'Unsupported request',
    stopping: 'Stopping',
    attention: 'Needs you',
    last: (status: string) => `Last status: ${status}`,
    failedUnknown: (count: number) => plural(count, { one: 'Failed · {n} unknown outcome', other: 'Failed · {n} unknown outcomes' }),
    failed: 'Failed',
    fresh: 'New content',
    completed: 'Turn ended',
    transcript: 'Transcript',
    sessions: 'Sessions',
    noProject: 'No project',
  },
)

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
  /** Ended without an answer. `unknown` is how many results nobody can vouch for; `unread`: new to this device, or marked so. */
  | { kind: 'ended'; word: string; unknown: number; unread?: true }
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

/** The Host puts the session in 等你处理: something waits on the person, a failure not yet opened, or results not yet checked. */
export const inAttention = (task: Pick<TaskSummary, 'board'>): boolean => task.board?.group === 'attention'

/**
 * How many cards 看板 holds in each group: every session the Host makes a card (`board.card`) that belongs to no 待办,
 * and each 待办 that has started, by its own place. The start screen's count line and the 看板 segment of the switch
 * say these.
 */
export function boardCounts(
  tasks: readonly Pick<TaskSummary, 'id' | 'board'>[],
  items: readonly Pick<WorkItemSummary, 'sessionIds' | 'board'>[] = [],
): Record<BoardGroup, number> {
  const counts: Record<BoardGroup, number> = { attention: 0, running: 0, deliver: 0, done: 0 }
  const members = new Set(items.flatMap(item => item.sessionIds))
  for (const task of tasks) if (task.board?.card && !members.has(task.id)) counts[task.board.group] += 1
  for (const item of items) if (item.board.group !== 'todo') counts[item.board.group] += 1
  return counts
}

/**
 * How many sessions are in 等你处理, by the Host's group; what the window title, the title row and the place dots count.
 * An approval's session may be outside the list; with a place given, only that place's listed sessions count, so its dot
 * always has a row to point at. The desktop app's Dock badge counts only live waits (`attentionOf`).
 */
export function waitingCount(snapshot: Pick<AppSnapshot, 'tasks' | 'approvals'>, space?: Space): number {
  const stopping = new Set(snapshot.tasks.filter(task => liveNow(task)?.activity === 'cancelling').map(task => task.id))
  const placed = new Map(snapshot.tasks.map(task => [task.id, spaceOf(task)]))
  // A place counts only what its own lists can show: an approval of a session no list holds counts in the total alone.
  const here = (id: string) => space === undefined || placed.get(id) === space
  const asking = snapshot.approvals.map(approval => approval.sessionId).filter(id => !stopping.has(id) && here(id))
  return new Set([...asking, ...snapshot.tasks.filter(task => inAttention(task) && here(task.id)).map(task => task.id)]).size
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
  const marked = unread ? { unread: true as const } : {}
  if (task.status === 'cancelled' || outcome === 'cancelled') return { kind: 'ended', word: COPY.stopped, unknown, ...marked }
  if (task.status === 'interrupted' || outcome === 'interrupted')
    return { kind: 'ended', word: task.runEnd?.reason === 'forced-stop' ? COPY.forcedStop : COPY.interrupted, unknown, ...marked }
  return { kind: unread ? 'unread' : 'read' }
}

/**
 * The state mark on a sidebar row's Harness icon: running work spins, what waits on the person is amber (an approval or
 * a question, silence, results nobody can vouch for), a failure is red, a new answer is a quiet check. Nothing at rest,
 * after a stop, or while the connection is down, where the row's words still say it.
 */
type RowMark = 'running' | 'waiting' | 'silent' | 'unknown' | 'failed' | 'unread'
export function rowMark(status: RowStatus): RowMark | undefined {
  switch (status.kind) {
    case 'running':
    case 'stopping':
      return 'running'
    case 'waiting':
      return 'waiting'
    case 'silent':
      return 'silent'
    case 'failed':
      return 'failed'
    case 'ended':
      return status.unknown > 0 ? 'unknown' : status.unread ? 'unread' : undefined
    case 'unread':
      return 'unread'
    default:
      return undefined
  }
}

/** A row drawn as unread: an answered one, or one that ended without an answer and still says how (已停止). */
export const showsUnread = (status: RowStatus): boolean => status.kind === 'unread' || (status.kind === 'ended' && status.unread === true)

/** What a running row says the run is doing, from the summary's activity alone; 运行中 when the Host named none. */
const ACTIVITY_WORDS: Partial<Record<RunLive['activity'], string>> = {
  get starting() {
    return COPY.starting
  },
  get model() {
    return COPY.model
  },
  get command() {
    return COPY.command
  },
  get tool() {
    return COPY.tool
  },
}

export const activityWords = (live: RunLive | undefined): string =>
  // A model request waiting for a free place says which service it waits for, whatever the run was doing before.
  // The service is named only while its own place is what the request waits for.
  live?.queuedFor ? COPY.queuedFor(live.queuedFor) : live?.queued ? COPY.queued : ((live && ACTIVITY_WORDS[live.activity]) ?? COPY.running)

/** 在跑命令 1:12, or the words alone when the Host did not say when the run began. */
export function runningWords(live: RunLive | undefined, hostNow: number): string {
  const ms = live && runElapsed(live, hostNow)
  const words = activityWords(live)
  return ms === undefined ? words : `${words} ${runClock(ms)}`
}

/** 没有动静 3 分钟, counted from the engine's last sign of life. */
export function silentWords(live: RunLive | undefined, hostNow: number): string {
  const last = parseTime(live?.lastEventAt)
  if (last === undefined) return COPY.quiet
  const minutes = Math.max(1, Math.floor((hostNow - last) / 60_000))
  return minutes < 60 ? COPY.minutes(minutes) : COPY.hours(Math.floor(minutes / 60))
}

/** Results nobody can vouch for after a run that ended without an answer: the one fact a row's second line adds. */
export function unknownNote(task: TaskSummary, status: RowStatus): string | undefined {
  if (status.kind === 'ended' && status.unknown > 0) return COPY.unknown(status.unknown)
  const unknown = task.runEnd?.unknownResultCount ?? 0
  if (status.kind === 'failed' && unknown > 0) return COPY.unknown(unknown)
  return undefined
}

/** What the phone row's second line adds after the Harness: its project in 等你处理, otherwise its branch; unknown results first. */
export function rowMeta(task: TaskSummary, status: RowStatus, project: string | undefined): string | undefined {
  return unknownNote(task, status) ?? project ?? task.branch
}

/**
 * The model a session row names: the one the session runs on now as the Host reports it (an in-session switch moves
 * both fields), the model of the service Latch forwards to first, else the one the session or its Harness reported.
 * Undefined while neither reported one: a row names no model it cannot know. Escaped like any text from the Host.
 */
export function rowModel(task: Pick<TaskSummary, 'model' | 'modelRoute'>): string | undefined {
  const model = task.modelRoute?.model || task.model
  return model ? escapeSecurityText(model) : undefined
}

/** Whether the row's model goes through Latch's gateway: a route the Host holds, with no turn seen bypassing it. */
export const rowGateway = (task: Pick<TaskSummary, 'modelRoute'>): boolean =>
  task.modelRoute !== undefined && task.modelRoute.bypassed !== true

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
    // A question also holds the session at waiting-approval: that alone is no approval.
    ...(task.status === 'waiting-approval' && !task.pendingQuestions ? [COPY.approval] : []),
    ...(task.pendingQuestions ? [COPY.questions(task.pendingQuestions)] : []),
  ]
  if (asks.length > 0) return { kind: 'asks', words: asks.join(' · ') }
  if (stuckOnRequest(live)) return { kind: 'asks', words: COPY.unsupported }
  return live?.silent ? { kind: 'silent' } : undefined
}

export interface WorkStatus {
  tone: 'neutral' | 'waiting' | 'running' | 'failed' | 'warn'
  words: string
}

/**
 * A session's state in words and a tone, as a card or a decision says it. While disconnected the last known work stays
 * in sight, without advancing a timer or drawing a live spinner.
 */
export function workStatus(
  task: TaskSummary,
  { connected, now, stopping = false, unread = false }: { connected: boolean; now: number; stopping?: boolean; unread?: boolean },
): WorkStatus {
  const status = rowStatus(task, { stopping, unread })
  const live = task.status === 'running' || task.status === 'waiting-approval'
  const unknown = live ? 0 : (task.runEnd?.unknownResultCount ?? 0)
  if (!connected && live) {
    const words = status.kind === 'stopping' ? COPY.stopping : waitsOnYou(task) ? COPY.attention : activityWords(task.live)
    return { tone: 'neutral', words: COPY.last(words) }
  }
  if (status.kind === 'stopping') return { tone: 'running', words: COPY.stopping }
  if (status.kind === 'waiting' || status.kind === 'silent') {
    const wait = waitKind(task)
    return {
      tone: 'waiting',
      words: wait?.kind === 'asks' ? wait.words : wait?.kind === 'silent' ? silentWords(task.live, now) : COPY.attention,
    }
  }
  if (status.kind === 'running') return { tone: 'running', words: runningWords(task.live, now) }
  if (status.kind === 'failed') return { tone: 'failed', words: unknown > 0 ? COPY.failedUnknown(unknown) : COPY.failed }
  if (unknown > 0) return { tone: 'warn', words: COPY.unknown(unknown) }
  if (status.kind === 'ended') return { tone: 'neutral', words: status.word }
  if (status.kind === 'unread') return { tone: 'neutral', words: COPY.fresh }
  return { tone: 'neutral', words: task.runOutcome === 'completed' ? COPY.completed : COPY.transcript }
}

/** The sessions a conversation left for another Harness: each is shown inside the one it went on in, not on its own. */
export function movedFrom(tasks: readonly Pick<TaskSummary, 'forkOf'>[]): ReadonlySet<string> {
  return new Set(tasks.flatMap(task => (task.forkOf?.moved ? [task.forkOf.taskId] : [])))
}

/**
 * Archived sessions appear only under their own filter; search matches titles; a place keeps only its own sessions. A
 * session the conversation left for another Harness is listed as the one it went on in, which shows its record.
 */
export function filterSessions(tasks: TaskSummary[], filter: SessionFilter, query: string, space?: Space): TaskSummary[] {
  const needle = query.trim().toLocaleLowerCase()
  const left = movedFrom(tasks)
  return tasks.filter(task => {
    if (left.has(task.id)) return false
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
  /** The rows drawn one step in, under the session whose team they are members of (the row before them, or before their fellow members). */
  members?: ReadonlySet<string>
}

/**
 * A shelf's rows with the members of a team right under the session that started it, in the team's order (the order
 * they were listed in where this device was not given the team). Only a member whose session is on the same shelf
 * moves: one lifted to 等你处理, filtered apart from it or found alone by a search stays where it was.
 */
export function nestMembers(
  tasks: readonly TaskSummary[],
  teams: readonly Pick<TeamSummary, 'id' | 'members'>[] | undefined,
): { tasks: TaskSummary[]; members: ReadonlySet<string> } {
  const here = new Set(tasks.map(task => task.id))
  const under = new Map<string, TaskSummary[]>()
  for (const task of tasks) {
    const lead = task.teamOf?.leadSessionId
    if (!lead || lead === task.id || !here.has(lead)) continue
    under.set(lead, [...(under.get(lead) ?? []), task])
  }
  if (!under.size) return { tasks: [...tasks], members: new Set() }
  const place = (task: TaskSummary) => {
    const team = teams?.find(row => row.id === task.teamOf?.teamId)
    const at = team?.members.findIndex(member => member.sessionId === task.id) ?? -1
    return at < 0 ? Number.MAX_SAFE_INTEGER : at
  }
  // One team's members together, in the team's order; a session's teams in the order the list had them.
  const ordered = (rows: TaskSummary[]) => {
    const teamIds = [...new Set(rows.map(task => task.teamOf!.teamId))]
    return teamIds.flatMap(id => rows.filter(task => task.teamOf!.teamId === id).toSorted((a, b) => place(a) - place(b)))
  }
  const members = new Set([...under.values()].flatMap(rows => rows.map(task => task.id)))
  return {
    tasks: tasks.filter(task => !members.has(task.id)).flatMap(task => [task, ...ordered(under.get(task.id) ?? [])]),
    members,
  }
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
 * 等你处理 while the Host puts something there (`board`), saved projects by their latest session, then conversations outside a project. Pinned
 * sessions lead their own shelf. Only `waitingFrom` moves a session to 等你处理: a search or the archive keeps it in place.
 */
export function groupSessions(
  tasks: TaskSummary[],
  workspaces: readonly WorkspaceInfo[] | undefined,
  options: { includeEmpty?: boolean; waitingFrom?: readonly TaskSummary[]; teams?: readonly TeamSummary[] | undefined } = {},
): SessionGroup[] {
  const waiting: SessionGroup = {
    id: 'waiting',
    label: COPY.attention,
    tasks: (options.waitingFrom ?? []).filter(inAttention).toSorted(byRecency),
  }
  const shelved = new Set(waiting.tasks.map(task => task.id))
  const other: SessionGroup = { id: 'other', label: workspaces === undefined ? COPY.sessions : COPY.noProject, tasks: [] }
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
  return shelves.map(group => {
    const pinnedFirst = group.tasks.toSorted((a, b) => Number(b.pinned === true) - Number(a.pinned === true))
    // 等你处理 is a flat list of what waits: a member there is shown like any other session.
    if (group === waiting) return { ...group, tasks: pinnedFirst }
    const nested = nestMembers(pinnedFirst, options.teams)
    return { ...group, tasks: nested.tasks, ...(nested.members.size ? { members: nested.members } : {}) }
  })
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
    projectTree = false,
    teams,
  }: {
    teams?: readonly TeamSummary[] | undefined
    filter: SessionFilter
    search: string
    folded: ReadonlySet<string>
    space?: Space
    /** 我的 Agent: 最近委托 shows every delegation (全部). */
    expanded?: boolean
    projectTree?: boolean
  },
): TaskSummary[] {
  if (space === 'agents') return delegationRows(tasks, { filter, expanded }).rows
  return groupSessions(filterSessions(tasks, filter, search, space), workspaces, {
    ...(filter !== 'archived' && !search && !projectTree ? { waitingFrom: inSpace(tasks, space) } : {}),
    teams,
  })
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
  const waiting = own.filter(inAttention)
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
