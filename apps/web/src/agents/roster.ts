import { GENERAL_AGENT_ID, type AgentAvatar, type AppSnapshot, type CustomAgentSummary, type TaskSummary } from '@latch/protocol'
import { rowStatus, waitsOnYou } from '../sessions.ts'
import { workGroups } from '../shell/workOverview.ts'
import { topicOwner } from './chat.ts'
import { dutyLine, GENERAL_NAME } from './model.ts'
import { personActivity, WAITS_ON_YOU, type PersonWord } from './personWords.ts'

/**
 * 我的 Agent as people: the roster the 侧栏 layout draws (one row per Agent, its topics on tree lines under the one in
 * view), the queue the 顶栏 layout draws (who waits for you first, then who works, then by recency) and the space's own
 * 总览. All of it is a projection of the snapshot's summaries; nothing here is kept or invented.
 */

/** What a person or one of its topics is doing: it waits for you, it works, its latest run failed, or nothing. */
export type RosterState = 'waiting' | 'running' | 'failed' | 'idle'

export interface RosterRow {
  /** The Agent's ID, or `general` for 通用. */
  id: string
  name: string
  avatar: AgentAvatar | 'general'
  /** Its role in one line; empty when it has none. */
  duty: string
  state: RosterState
  /** 等你点头, or what it is doing, from its topic's own events; absent at rest. */
  word?: PersonWord
  /** Why a new topic cannot start on it now (its Harness is missing or too old); its topics stay readable. */
  unavailable?: string
  /** Deleted, and kept only because topics of it remain. */
  gone: boolean
  /**
   * The Host is withholding the list of Agents (a write is being confirmed), so whose these topics are is not known yet:
   * they stay in sight under a neutral row, never called deleted.
   */
  confirming?: true
  /** When its newest open topic last changed. */
  updatedAt?: string
  /** Its open topics, newest first. */
  topics: TaskSummary[]
}

const newestFirst = (a: TaskSummary, b: TaskSummary) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)

/** A topic's state from its own summary; an approval listed for it counts as waiting, as on the Agent's face. */
export function topicState(task: TaskSummary, asking: ReadonlySet<string> = new Set()): RosterState {
  if (waitsOnYou(task) || (asking.has(task.id) && task.status === 'running')) return 'waiting'
  if (task.status === 'running' || task.status === 'waiting-approval') return 'running'
  return rowStatus(task).kind === 'failed' ? 'failed' : 'idle'
}

const askingOf = (snapshot: Pick<AppSnapshot, 'approvals'>) => new Set(snapshot.approvals.map(approval => approval.sessionId))

function rowOf(
  who: Pick<RosterRow, 'id' | 'name' | 'avatar' | 'duty' | 'gone'> & { unavailable?: string | undefined },
  topics: TaskSummary[],
  asking: ReadonlySet<string>,
): RosterRow {
  const states = topics.map(task => topicState(task, asking))
  const waiting = states.includes('waiting')
  const runningAt = states.indexOf('running')
  // A failure is said only of the newest topic: an older one that failed has been moved on from.
  const state: RosterState = waiting ? 'waiting' : runningAt >= 0 ? 'running' : states[0] === 'failed' ? 'failed' : 'idle'
  const word =
    state === 'waiting'
      ? WAITS_ON_YOU
      : state === 'running'
        ? (personActivity(topics[runningAt].live) ?? { words: '运行中', tone: 'running' as const })
        : undefined
  const { unavailable, ...rest } = who
  return {
    ...rest,
    state,
    ...(word ? { word } : {}),
    ...(unavailable ? { unavailable } : {}),
    ...(topics[0] ? { updatedAt: topics[0].updatedAt } : {}),
    topics,
  }
}

/**
 * The roster in the Host's order: your Agents, then 通用 (built in, on a device that may read Agents), then one row for
 * each deleted Agent whose topics remain, so every open topic hangs under exactly one row. `generalBlocked` is why 通用
 * cannot start a topic now.
 */
export function rosterRows(
  snapshot: Pick<AppSnapshot, 'tasks' | 'approvals' | 'customAgents'>,
  { general = true, generalBlocked }: { general?: boolean; generalBlocked?: string | undefined } = {},
): RosterRow[] {
  const asking = askingOf(snapshot)
  const byOwner = new Map<string, TaskSummary[]>()
  for (const task of snapshot.tasks) {
    const owner = topicOwner(task)
    if (!owner || task.archived) continue
    const list = byOwner.get(owner)
    if (list) list.push(task)
    else byOwner.set(owner, [task])
  }
  const topicsOf = (id: string) => (byOwner.get(id) ?? []).toSorted(newestFirst)
  const agents: readonly CustomAgentSummary[] = snapshot.customAgents ?? []
  const known = new Set<string>([GENERAL_AGENT_ID, ...agents.map(agent => agent.id)])
  const rows = agents.map(agent =>
    rowOf(
      {
        id: agent.id,
        name: agent.name,
        avatar: agent.avatar,
        duty: dutyLine(agent),
        gone: false,
        unavailable: agent.available ? undefined : (agent.unavailableReason ?? '现在不能开始'),
      },
      topicsOf(agent.id),
      asking,
    ),
  )
  if (general)
    rows.push(
      rowOf(
        { id: GENERAL_AGENT_ID, name: GENERAL_NAME, avatar: 'general', duty: '', gone: false, unavailable: generalBlocked },
        topicsOf(GENERAL_AGENT_ID),
        asking,
      ),
    )
  // While the Host withholds the list nobody is known to be deleted: the topics keep a neutral row each, so one that
  // waits for you is still drawn and still reachable.
  const listed = snapshot.customAgents !== undefined
  for (const [owner, topics] of byOwner)
    if (!known.has(owner))
      rows.push({
        ...rowOf(
          { id: owner, name: listed ? '已删除的 Agent' : 'Agent', avatar: 'general', duty: '', gone: listed },
          topics.toSorted(newestFirst),
          asking,
        ),
        ...(listed ? {} : { confirming: true as const }),
      })
  return rows
}

const RANK: Record<RosterState, number> = { waiting: 0, running: 1, failed: 2, idle: 2 }

/** The queue: who waits for you first, then who is working, then whoever was last heard from; ties keep the roster's order. */
export function queueOrder(rows: readonly RosterRow[]): RosterRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .toSorted(
      (a, b) => RANK[a.row.state] - RANK[b.row.state] || (b.row.updatedAt ?? '').localeCompare(a.row.updatedAt ?? '') || a.index - b.index,
    )
    .map(item => item.row)
}

/** The rows the keys step through in 我的 Agent, as the roster draws them: each Agent's topics in turn. */
export function rosterTopics(rows: readonly RosterRow[]): TaskSummary[] {
  return rows.flatMap(row => row.topics)
}

/** How many rows of a group of the space's 总览 show before 「还有 N 件」. */
export const OVERVIEW_ROWS = 5

export interface AgentsOverview {
  /** Topics that wait for you (an approval, a question, silence) or ended in a failure or an unknown result. */
  attention: TaskSummary[]
  /** Topics that are working. */
  running: TaskSummary[]
  /** Topics whose latest run completed, newest first. */
  results: TaskSummary[]
}

/**
 * The space's own 总览, grouped as Code's is (the same rule decides what waits and what runs), with 最近结果 in the place
 * of 可交付: a topic has no delivery, and what the Host does report is that its latest run completed.
 */
export function agentsOverview(tasks: readonly TaskSummary[], cancelling: ReadonlySet<string> = new Set()): AgentsOverview {
  const [attention, running] = workGroups(tasks, cancelling, new Set(), 'agents')
  const taken = new Set([...attention.tasks, ...running.tasks].map(task => task.id))
  const results = tasks
    .filter(task => topicOwner(task) && !task.archived && !taken.has(task.id) && task.status === 'idle' && task.runOutcome === 'completed')
    .toSorted(newestFirst)
  return { attention: attention.tasks, running: running.tasks, results }
}

/**
 * Who the 总览's input addresses before the person picks: the Agent last spoken with that still exists, else 通用 (or
 * the first of yours on a device that 通用 is not offered to).
 */
export function defaultAddressee(rows: readonly RosterRow[]): string {
  const open = rows.filter(addressable)
  const last = open.filter(row => row.updatedAt).toSorted((a, b) => b.updatedAt!.localeCompare(a.updatedAt!))[0]
  return (last ?? open.find(row => row.id === GENERAL_AGENT_ID) ?? open[0])?.id ?? GENERAL_AGENT_ID
}

/** A row a new topic can be addressed to: an Agent that exists and is known. */
export const addressable = (row: RosterRow) => !row.gone && !row.confirming

/**
 * Who the 总览's input addresses: the one picked (the default is picked once, when the 总览 opens), for as long as it can
 * be addressed. Activity elsewhere never moves it; only when the picked Agent is gone does it fall back to 通用, or the
 * first that can be addressed.
 */
export function addressee(rows: readonly RosterRow[], picked: string): RosterRow | undefined {
  const open = rows.filter(addressable)
  return open.find(row => row.id === picked) ?? open.find(row => row.id === GENERAL_AGENT_ID) ?? open[0]
}

/**
 * The topic a flagged row opens: among its topics that wait for you, the same order as the 总览's 等你处理 (approvals
 * first, then questions and silence, newest first within each).
 */
export function waitingTopic(row: Pick<RosterRow, 'topics'>, cancelling: ReadonlySet<string> = new Set()): TaskSummary | undefined {
  return workGroups(row.topics, cancelling, new Set(), 'agents')[0].tasks.find(task => waitsOnYou(task))
}

/** The Agent a topic's row is signed with: its roster row, found by the topic's owner. */
export function rowFor(rows: readonly RosterRow[], task: Pick<TaskSummary, 'agent' | 'generalChat'>): RosterRow | undefined {
  const owner = topicOwner(task)
  return rows.find(row => row.id === owner)
}
