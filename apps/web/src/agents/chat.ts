import {
  GENERAL_AGENT_ID,
  type AppSnapshot,
  type CustomAgentSummary,
  type ModelRef,
  type TaskMode,
  type TaskSummary,
} from '@latch/protocol'
import type { PendingSubmission } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'
import { rowStatus } from '../sessions.ts'
import { personActivity, WAITS_ON_YOU } from './personWords.ts'
import type { MyAgentTab, MyAgentTarget, ShellRoute } from '../shell/routes.ts'
import { AGENT_SPACE_COPY } from './spaceCopy.ts'

const COPY = defineCopy(
  { running: '运行中', stopping: '正在停止', failed: '失败' },
  { running: 'Running', stopping: 'Stopping', failed: 'Failed' },
)

/**
 * 通用's explicit chat belongs here too. Other sessions with its private context do not acquire that ownership.
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

export function personalChat(snapshot: Pick<AppSnapshot, 'agentChats' | 'catalog'>, owner: string) {
  return snapshot.catalog?.features?.singleAgentChat === true ? snapshot.agentChats?.[owner] : undefined
}

export function isPersonalChat(snapshot: Pick<AppSnapshot, 'agentChats' | 'catalog'>, task: TaskSummary): boolean {
  const owner = topicOwner(task)
  const chat = owner ? personalChat(snapshot, owner) : undefined
  return chat?.state === 'ready' && chat.sessionId === task.id
}

export function personalChatModel(snapshot: AppSnapshot, task: TaskSummary | undefined): ModelRef | undefined {
  if (!task?.agent || task.harnessId !== 'standard' || !isPersonalChat(snapshot, task)) return undefined
  const agent = snapshot.customAgents?.find(item => item.id === task.agent?.customAgentId)
  return agent?.harnessId === task.harnessId ? agent.model : undefined
}

/** Where the profile panel opens: its top, 记忆, 即将进行, or the settings form. */
export type ProfileSection = 'memory' | 'schedules' | 'settings'

/** The old tabs of an Agent's page, as the profile's sections; 委托 is the conversation itself. */
export function profileSection(tab: MyAgentTab | undefined): ProfileSection | undefined {
  return tab === 'memory' || tab === 'schedules' || tab === 'settings' ? tab : undefined
}

/** What opening 我的 Agent at a target shows: the Host's chat, or a page (the list, form or first-message input). */
export type AgentOpening =
  | { kind: 'topic'; sessionId: string; owner: string; section?: ProfileSection }
  | { kind: 'page'; target?: MyAgentTarget; section?: ProfileSection }

/**
 * The Host's ID is authoritative across reconnects and other devices. Old links requesting a new topic open that same
 * chat. When the Host has no confirmed slot, no task is inferred from its history.
 */
export function openAgent(target: MyAgentTarget | undefined, snapshot: Pick<AppSnapshot, 'agentChats' | 'catalog'>): AgentOpening {
  if (!target || target.id === 'new') return target ? { kind: 'page', target } : { kind: 'page' }
  const section = profileSection(target.tab)
  const chat = personalChat(snapshot, target.id)
  if (chat?.state === 'ready') return { kind: 'topic', sessionId: chat.sessionId, owner: target.id, ...(section ? { section } : {}) }
  return { kind: 'page', target: { id: target.id }, ...(section ? { section } : {}) }
}

/** The mode of a new 通用 topic; existing topics retain their recorded mode. */
export function generalMode(): TaskMode {
  return 'agent'
}

/** A new 通用 topic: Standard Agent and a Host model, with the Host choosing its private home. */
export function generalSubmission(input: {
  model: ModelRef | undefined
  prompt: string
}): Omit<PendingSubmission, 'requestId'> & { customAgentId: string } {
  return {
    customAgentId: GENERAL_AGENT_ID,
    prompt: input.prompt,
    mode: generalMode(),
    harnessId: 'standard',
    workspaceId: 'default',
    ...(input.model ? { model: input.model } : {}),
  }
}

/** The name the frame and the lists show for an owner: 通用, the Agent's own, or 已删除的 Agent once it is gone. */
export function ownerName(agents: readonly Pick<CustomAgentSummary, 'id' | 'name'>[] | undefined, owner: string): string {
  if (owner === GENERAL_AGENT_ID) return AGENT_SPACE_COPY.general
  if (agents === undefined) return 'Agent'
  return agents.find(agent => agent.id === owner)?.name ?? AGENT_SPACE_COPY.deleted
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
    case 'running':
      return personActivity(task.live)?.words ?? COPY.running
    case 'stopping':
      return COPY.stopping
    case 'failed':
      return COPY.failed
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
