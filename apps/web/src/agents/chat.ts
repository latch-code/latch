import { GENERAL_AGENT_ID, type CustomAgentSummary, type HarnessInfo, type TaskMode, type TaskSummary } from '@latch/protocol'
import type { PendingSubmission } from '../core/api.ts'
import { rowStatus } from '../sessions.ts'
import { personActivity, WAITS_ON_YOU } from './personWords.ts'
import type { MyAgentTab, MyAgentTarget, ShellRoute } from '../shell/routes.ts'

/**
 * Talking with an Agent: its sessions are its topics, and the current topic is the one most recently active that is not
 * archived. 通用 names no Agent, so its topics are the sessions the Host marked `generalChat`.
 */

/** The Agent a session belongs to in 我的 Agent: one of yours, 通用 for a conversation with it, or none (Code). */
export function topicOwner(task: Pick<TaskSummary, 'agent' | 'generalChat'> | undefined): string | undefined {
  return task?.agent?.customAgentId ?? (task?.generalChat ? GENERAL_AGENT_ID : undefined)
}

const newestFirst = (a: TaskSummary, b: TaskSummary) => b.updatedAt.localeCompare(a.updatedAt)

/** An Agent's topics, newest first: the open ones, then the archived ones apart. */
export function agentTopics(tasks: readonly TaskSummary[], id: string): { open: TaskSummary[]; archived: TaskSummary[] } {
  const own = tasks.filter(task => topicOwner(task) === id).toSorted(newestFirst)
  return { open: own.filter(task => !task.archived), archived: own.filter(task => task.archived) }
}

/**
 * The topic a message to the Agent continues: the newest that is not archived and is not a schedule's run (those stay in
 * 话题 ▾); none yet means the next message starts its first one.
 */
export function currentTopic(tasks: readonly TaskSummary[], id: string): TaskSummary | undefined {
  return agentTopics(tasks, id).open.find(task => !task.automationId)
}

/** Where the profile panel opens: its top, 记忆, 即将进行, or the settings form. */
export type ProfileSection = 'memory' | 'schedules' | 'settings'

/** The old tabs of an Agent's page, as the profile's sections; 委托 is the conversation itself. */
export function profileSection(tab: MyAgentTab | undefined): ProfileSection | undefined {
  return tab === 'memory' || tab === 'schedules' || tab === 'settings' ? tab : undefined
}

/** What opening 我的 Agent at a target shows: the Agent's current topic, or a page (the list, the form, a new topic). */
export type AgentOpening =
  | { kind: 'topic'; sessionId: string; owner: string; section?: ProfileSection }
  | { kind: 'page'; target?: MyAgentTarget; section?: ProfileSection }

/**
 * `agents/:id` opens the conversation: its current topic, or a new topic when it has none; `agents/:id/<tab>` does the
 * same with the profile at that section; the old 委托 tab opens the conversation. `topic: 'new'` asks for a new topic.
 */
export function openAgent(target: MyAgentTarget | undefined, tasks: readonly TaskSummary[]): AgentOpening {
  if (!target || target.id === 'new') return target ? { kind: 'page', target } : { kind: 'page' }
  const section = profileSection(target.tab)
  const current = target.topic === 'new' ? undefined : currentTopic(tasks, target.id)
  if (current) return { kind: 'topic', sessionId: current.id, owner: target.id, ...(section ? { section } : {}) }
  return { kind: 'page', target: { id: target.id, topic: 'new' }, ...(section ? { section } : {}) }
}

/** The mode of a conversation with 通用: only talk where the Harness has it, else its first mode. */
export function generalMode(harness: Pick<HarnessInfo, 'modes'> | undefined): TaskMode {
  return harness?.modes.includes('chat') ? 'chat' : (harness?.modes[0] ?? 'chat')
}

/** A new topic with 通用: no project, on the Harness and model picked for it, marked as 我的 Agent's by `general`. */
export function generalSubmission(input: {
  harness: Pick<HarnessInfo, 'id' | 'modes' | 'capabilities'>
  model: { providerId: string; model: string } | undefined
  prompt: string
}): Omit<PendingSubmission, 'requestId'> & { customAgentId: string } {
  return {
    customAgentId: GENERAL_AGENT_ID,
    prompt: input.prompt,
    mode: generalMode(input.harness),
    harnessId: input.harness.id,
    workspaceId: 'default',
    ...(input.harness.capabilities.models.owner === 'latch' && input.model
      ? { model: { providerId: input.model.providerId, model: input.model.model } }
      : {}),
  }
}

/** The name the frame and the lists show for an owner: 通用, the Agent's own, or 已删除的 Agent once it is gone. */
export function ownerName(agents: readonly Pick<CustomAgentSummary, 'id' | 'name'>[] | undefined, owner: string): string {
  if (owner === GENERAL_AGENT_ID) return '通用'
  if (agents === undefined) return 'Agent'
  return agents.find(agent => agent.id === owner)?.name ?? '已删除的 Agent'
}

/**
 * A topic's state as its helper says it (agents/personWords.ts): what it is doing, 等你点头, 正在停止, 失败 or how it
 * ended; a topic at rest says nothing.
 */
export function topicWords(task: TaskSummary, frozen: boolean): string | undefined {
  const status = rowStatus(task, { frozen })
  switch (status.kind) {
    case 'waiting':
      return WAITS_ON_YOU.words
    case 'silent':
      return '没有动静'
    case 'running':
      return personActivity(task.live)?.words ?? '运行中'
    case 'stopping':
      return '正在停止'
    case 'failed':
      return '失败'
    case 'ended':
      return status.word
    default:
      return undefined
  }
}

/**
 * Whether a start that has just been answered may open its new topic: only while this Agent's new topic is still what is
 * shown. A person who moved elsewhere before the answer stays there (docs/STREAMING.md); the topic is in 话题 ▾.
 */
export function newTopicShowing(route: Pick<ShellRoute, 'entry' | 'myAgent'>, owner: string): boolean {
  // 我的 Agent shows an Agent's id only as its new topic: a topic itself is a session.
  return route.entry === 'agents' && route.myAgent?.id === owner
}
