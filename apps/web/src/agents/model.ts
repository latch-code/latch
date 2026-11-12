import {
  GENERAL_AGENT_ID,
  type AgentAvatar,
  type AutomationSummary,
  type AppSnapshot,
  type CustomAgentDetail,
  type CustomAgentPatch,
  type CustomAgentSummary,
  type HarnessInfo,
  type HostCatalog,
  type ModelRef,
  type TaskMode,
  type TaskSummary,
  type WorktreeStart,
} from '@latch/protocol'
import { ApiError, ApiTimeoutError, ClientError, isUncertain, type PendingSubmission } from '../core/api.ts'
import { findProvider, harnessName, type ComposerChoice } from '../composerChoice.ts'
import { projectName } from '../projects.tsx'
import { rowStatus, waitsOnYou } from '../sessions.ts'
import type { AvatarState } from './avatarFace.ts'
import { agentTopics, topicOwner } from './chat.ts'

/** One entry of 我的 Agent's list: 通用 first, then the Host's own order. */
export type AgentEntry =
  | { kind: 'general'; id: typeof GENERAL_AGENT_ID; name: string; memoryCount: number }
  | { kind: 'custom'; id: string; name: string; summary: CustomAgentSummary }

export const GENERAL_NAME = '通用'

export function agentEntries(list: { general: { memoryCount: number }; agents: readonly CustomAgentSummary[] } | undefined): AgentEntry[] {
  if (!list) return []
  return [
    { kind: 'general', id: GENERAL_AGENT_ID, name: GENERAL_NAME, memoryCount: list.general.memoryCount },
    ...list.agents.map(summary => ({ kind: 'custom' as const, id: summary.id, name: summary.name, summary })),
  ]
}

/** The Harnesses an Agent can run on now: ready, saved, and able to receive an Agent's instructions. */
export function agentHarnesses(catalog: HostCatalog | undefined): HarnessInfo[] {
  return (catalog?.harnesses ?? []).filter(harness => harness.status === 'ready' && harness.agentContext !== undefined && !harness.offer)
}

/** Whether the Harness runs on Latch's model services, so an Agent's model applies to it. */
export const usesHostModels = (harness: Pick<HarnessInfo, 'capabilities'> | undefined) => harness?.capabilities.models.owner === 'latch'

/** The duty in one line: the description, else the first line of the instructions. */
export function dutyLine(agent: { description?: string; instructions?: string }): string {
  const described = agent.description?.trim()
  if (described) return described.split('\n')[0]!.trim()
  return (
    agent.instructions
      ?.split('\n')
      .map(line => line.trim())
      .find(Boolean) ?? ''
  )
}

/** 「Harness · 模型」: how the Agent runs. A Harness no longer listed keeps its ID. */
export function runsWith(catalog: HostCatalog | undefined, agent: { harnessId: string; model?: ModelRef }): string {
  const harness = catalog?.harnesses.find(item => item.id === agent.harnessId)
  const name = harness ? harnessName(harness) : agent.harnessId
  if (harness && !usesHostModels(harness)) return name
  return `${name} · ${agent.model ? modelName(catalog, agent.model) : '默认模型'}`
}

export function modelName(catalog: HostCatalog | undefined, model: ModelRef): string {
  const provider = findProvider(catalog, model.providerId)
  return provider ? model.model : `${model.model}（服务已移除）`
}

/** Where a new session of the Agent works: its project, or each session's own folder. */
export function worksIn(catalog: HostCatalog | undefined, projectId: string | undefined): string {
  if (!projectId || projectId === 'default') return catalog?.sessionFolders ? '各自的文件夹' : '默认文件夹'
  const project = catalog?.workspaces.find(item => item.id === projectId)
  return project ? projectName(project) : '项目已移除'
}

/** This Agent's topics that are not archived, newest first; 通用's are the conversations marked as its. */
export function agentSessions(tasks: readonly TaskSummary[], id: string): TaskSummary[] {
  return agentTopics(tasks, id).open
}

/** The Agent a session belongs to in 我的 Agent, by its summary: one of yours, or 通用 for a conversation with it. */
export function sessionAgent(
  snapshot: Pick<AppSnapshot, 'customAgents'>,
  task: Pick<TaskSummary, 'agent' | 'generalChat'> | undefined,
): { id: string; name: string; avatar?: AgentAvatar } | undefined {
  const id = topicOwner(task)
  if (!id) return undefined
  if (id === GENERAL_AGENT_ID) return { id, name: GENERAL_NAME }
  const found = snapshot.customAgents?.find(agent => agent.id === id)
  return { id, name: found?.name ?? (snapshot.customAgents ? '已删除的 Agent' : 'Agent'), ...(found ? { avatar: found.avatar } : {}) }
}

/** Whether this device may read Agents at all: their contents are private to a device with the full data scope. */
export const readsAgents = (snapshot: Pick<AppSnapshot, 'device'>) => snapshot.device.dataScope === 'all'

/** Whether this device can delegate: the Host has 我的 Agent, and the device runs sessions and reads Agents. */
export const canDelegate = (snapshot: Pick<AppSnapshot, 'device' | 'catalog'>, access: { scopes: ReadonlySet<string> }) =>
  snapshot.catalog?.features?.customAgents === true && access.scopes.has('run') && readsAgents(snapshot)

/**
 * What an Agent's face shows, from the Host's own data: its sessions by `agent.customAgentId`, 等你处理 before 运行中,
 * then 休息 while it cannot start, then a failure of its latest session, else nothing.
 */
export function agentActivity(
  snapshot: Pick<AppSnapshot, 'tasks' | 'approvals'>,
  agent: Pick<CustomAgentSummary, 'id' | 'available'>,
): AvatarState {
  const own = snapshot.tasks.filter(task => topicOwner(task) === agent.id)
  const asking = new Set(snapshot.approvals.map(approval => approval.sessionId))
  if (own.some(task => waitsOnYou(task) || (asking.has(task.id) && task.status === 'running'))) return 'waiting'
  if (own.some(task => task.status === 'running' || task.status === 'waiting-approval')) return 'running'
  if (!agent.available) return 'resting'
  const latest = own
    .filter(task => !task.archived)
    .reduce<TaskSummary | undefined>((found, task) => (!found || task.updatedAt > found.updatedAt ? task : found), undefined)
  return latest && rowStatus(latest).kind === 'failed' ? 'failed' : 'idle'
}

/** The words beside a face for the states that have one; 休息 says 不可用 through the Agent's availability. */
export const ACTIVITY_WORDS: Partial<Record<AvatarState, { words: string; tone: 'running' | 'waiting' | 'failed' }>> = {
  running: { words: '运行中', tone: 'running' },
  waiting: { words: '等你处理', tone: 'waiting' },
  failed: { words: '失败', tone: 'failed' },
}

/** What the form edits. */
export interface AgentDraft {
  name: string
  description: string
  instructions: string
  harnessId: string
  mode: TaskMode
  model?: ModelRef
  defaultProjectId?: string
  skills: string[]
  /** Absent: every enabled plugin (no extra limit). */
  tools?: string[]
}

export function emptyDraft(catalog: HostCatalog | undefined): AgentDraft {
  const harness = agentHarnesses(catalog).find(item => item.id === catalog?.defaults.harnessId) ?? agentHarnesses(catalog)[0]
  return {
    name: '',
    description: '',
    instructions: '',
    harnessId: harness?.id ?? '',
    mode: harness && !harness.modes.includes('agent') ? (harness.modes[0] ?? 'agent') : 'agent',
    skills: [],
  }
}

export function draftOf(agent: CustomAgentDetail['agent']): AgentDraft {
  return {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    harnessId: agent.harnessId,
    mode: agent.mode,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.defaultProjectId ? { defaultProjectId: agent.defaultProjectId } : {}),
    skills: agent.skills,
    ...(agent.tools ? { tools: agent.tools } : {}),
  }
}

/** A draft as the Host takes it: a model only for a Harness on Latch's models, a mode the Harness has. */
export function normalizedDraft(catalog: HostCatalog | undefined, draft: AgentDraft): AgentDraft {
  const harness = catalog?.harnesses.find(item => item.id === draft.harnessId)
  const { model, ...rest } = draft
  const mode = harness && !harness.modes.includes(draft.mode) ? (harness.modes[0] ?? draft.mode) : draft.mode
  return {
    ...rest,
    name: draft.name.trim(),
    description: draft.description.trim(),
    mode,
    ...(model && (!harness || usesHostModels(harness)) ? { model } : {}),
  }
}

/** Why the form cannot be saved yet, in a few words; undefined when it can. */
export function draftProblem(catalog: HostCatalog | undefined, draft: AgentDraft): string | undefined {
  if (!draft.name.trim()) return '先填名称'
  if (!draft.harnessId) return '先选 Harness'
  if (!agentHarnesses(catalog).some(harness => harness.id === draft.harnessId)) return '这个 Harness 现在不能运行 Agent'
  return undefined
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Only what changed, with `null` for what was cleared, against the revision the form was opened on. */
export function patchOf(base: AgentDraft, next: AgentDraft): Omit<CustomAgentPatch, 'requestId' | 'baseRevision'> {
  const patch: Omit<CustomAgentPatch, 'requestId' | 'baseRevision'> = {}
  if (base.name !== next.name) patch.name = next.name
  if (base.description !== next.description) patch.description = next.description
  if (base.instructions !== next.instructions) patch.instructions = next.instructions
  if (base.harnessId !== next.harnessId) patch.harnessId = next.harnessId
  if (base.mode !== next.mode) patch.mode = next.mode
  if (!same(base.model, next.model)) patch.model = next.model ?? null
  if (!same(base.defaultProjectId, next.defaultProjectId)) patch.defaultProjectId = next.defaultProjectId ?? null
  if (!same(base.skills, next.skills)) patch.skills = next.skills
  if (!same(base.tools, next.tools)) patch.tools = next.tools ?? null
  return patch
}

const DRAFT_FIELDS = ['name', 'description', 'instructions', 'harnessId', 'mode', 'model', 'defaultProjectId', 'skills', 'tools'] as const

/**
 * A new revision from the Host under a form being edited: the person's edits stay, laid over the new definition. A field
 * both the person and the Host changed, to different values, is a conflict; the form then keeps the person's value,
 * says it was changed elsewhere and does not save until the person loads the latest. An untouched form simply takes the new definition.
 */
export function rebaseDraft(
  previous: AgentDraft,
  next: AgentDraft,
  draft: AgentDraft,
): { draft: AgentDraft; conflicts: Array<keyof AgentDraft> } {
  const result: Record<string, unknown> = { ...next }
  const conflicts: Array<keyof AgentDraft> = []
  for (const field of DRAFT_FIELDS) {
    if (same(draft[field], previous[field])) continue
    if (!same(previous[field], next[field]) && !same(draft[field], next[field])) conflicts.push(field)
    result[field] = draft[field]
  }
  for (const field of DRAFT_FIELDS) if (result[field] === undefined) delete result[field]
  return { draft: result as unknown as AgentDraft, conflicts }
}

/**
 * Whether 保存 waits: a field changed both here and elsewhere stays shown so the person can copy it, but saving it would
 * write over the other edit, so 保存 waits for 载入最新.
 */
export const saveWaits = (conflicts: ReadonlyArray<keyof AgentDraft>) => conflicts.length > 0

/** What became of a write: the Host refused it, it changed under us, or nobody knows yet (retry the same request). */
export type WriteOutcome =
  | { kind: 'conflict'; message: string }
  | { kind: 'unknown'; message: string }
  | { kind: 'refused'; message: string; code?: string }

export function writeOutcome(error: unknown): WriteOutcome {
  if (
    error instanceof ApiError
    && (error.code === 'agent-changed' || error.code === 'agent-memory-deleted' || error.code === 'automation-changed')
  )
    return { kind: 'conflict', message: error.message }
  if (error instanceof ApiError && error.code === 'agent-write-unknown') return { kind: 'unknown', message: error.message }
  if (isUncertain(error))
    return {
      kind: 'unknown',
      message: error instanceof ApiTimeoutError || error instanceof ApiError ? error.message : '连接中断，Mac 可能已经保存。',
    }
  if (error instanceof ApiError) return { kind: 'refused', message: error.message, code: error.code }
  if (error instanceof ClientError) return { kind: 'refused', message: error.message }
  return { kind: 'refused', message: '没有保存，请重试。' }
}

/** A read that a smaller data scope cannot make, as opposed to one that failed. */
export const lockedRead = (error: unknown) => error instanceof ApiError && error.code === 'agent-scope-required'

/** The mode a delegation asks for: the Agent's own, where the chosen Harness has it. */
export function delegationMode(harness: Pick<HarnessInfo, 'modes'> | undefined, mode: TaskMode): TaskMode {
  return !harness || harness.modes.includes(mode) ? mode : (harness.modes[0] ?? mode)
}

/**
 * The delegation's picks start from the Agent's defaults. Without a default project the folder is the Host's start
 * ('default'), sent as picked: it also stands for 起始文件夹 chosen over the Agent's project for one session.
 */
export function delegationChoice(agent: Pick<CustomAgentSummary, 'mode' | 'harnessId' | 'defaultProjectId' | 'model'>): ComposerChoice {
  return {
    mode: agent.mode,
    harnessId: agent.harnessId,
    workspaceId: agent.defaultProjectId ?? 'default',
    ...(agent.model ? { model: agent.model } : {}),
  }
}

/** 委托's start request: the Agent, the picks, and the worktree start point as picked (only for a project that has one). */
export function delegationSubmission(input: {
  agent: Pick<CustomAgentSummary, 'id' | 'mode'>
  harness: Pick<HarnessInfo, 'id' | 'modes' | 'capabilities'>
  choice: ComposerChoice
  prompt: string
  worktree: WorktreeStart | undefined
  inProject: boolean
}): Omit<PendingSubmission, 'requestId'> & { customAgentId: string } {
  const { agent, harness, choice, worktree } = input
  return {
    customAgentId: agent.id,
    prompt: input.prompt,
    mode: delegationMode(harness, agent.mode),
    harnessId: harness.id,
    ...(choice.workspaceId ? { workspaceId: choice.workspaceId } : {}),
    ...(usesHostModels(harness) && choice.model ? { model: { providerId: choice.model.providerId, model: choice.model.model } } : {}),
    ...(worktree && input.inProject ? { worktree } : {}),
  }
}

const DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
/** 定时任务's schedule in words: 每天 09:00, 工作日 09:00, 每周一 09:00. */
export function scheduleWords(schedule: AutomationSummary['schedule']): string {
  if (schedule.kind === 'daily') return `每天 ${schedule.time}`
  if (schedule.kind === 'weekdays') return `工作日 ${schedule.time}`
  return `每${DAYS[schedule.day] ?? ''} ${schedule.time}`
}

/** A run's state in the words the session list uses. */
export const RUN_WORDS: Record<NonNullable<AutomationSummary['lastRun']>['state'], string> = {
  running: '运行中',
  waiting: '等你处理',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  unknown: '结果未知',
  missed: '错过',
  skipped: '跳过',
}
