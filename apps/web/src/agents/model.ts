import {
  GENERAL_AGENT_ID,
  consultationScope,
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
import { defineCopy } from '../core/i18n.ts'
import { findProvider, servicePick, withServicePick, type ComposerChoice } from '../composerChoice.ts'
import { projectName } from '../projects.tsx'
import { rowStatus, waitsOnYou } from '../sessions.ts'
import type { AvatarState } from './avatarFace.ts'
import { agentTopics, topicOwner } from './chat.ts'
import { personActivity, WAITS_ON_YOU } from './personWords.ts'
import { AGENT_SPACE_COPY } from './spaceCopy.ts'

/** One entry of 我的 Agent's list: 通用 first, then the Host's own order. */
export type AgentEntry =
  | { kind: 'general'; id: typeof GENERAL_AGENT_ID; name: string; memoryCount: number }
  | { kind: 'custom'; id: string; name: string; summary: CustomAgentSummary }

const COPY = defineCopy(
  {
    removedService: (model: string) => `${model}（服务已移除）`,
    home: '家',
    removedProject: '项目已移除',
    failed: '失败',
    interrupted: '连接中断，Mac 可能已经保存。',
    refused: '没有保存，请重试。',
    days: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
    daily: (time: string) => `每天 ${time}`,
    weekdays: (time: string) => `工作日 ${time}`,
    weekly: (day: string, time: string) => `每${day} ${time}`,
  },
  {
    removedService: (model: string) => `${model} (service removed)`,
    home: 'Home',
    removedProject: 'Project removed',
    failed: 'Failed',
    interrupted: 'The connection dropped. Your Mac may have saved the changes.',
    refused: 'Changes weren’t saved. Try again.',
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    daily: (time: string) => `Every day at ${time}`,
    weekdays: (time: string) => `Weekdays at ${time}`,
    weekly: (day: string, time: string) => `Every ${day} at ${time}`,
  },
)

export function agentEntries(list: { general: { memoryCount: number }; agents: readonly CustomAgentSummary[] } | undefined): AgentEntry[] {
  if (!list) return []
  return [
    { kind: 'general', id: GENERAL_AGENT_ID, name: AGENT_SPACE_COPY.general, memoryCount: list.general.memoryCount },
    ...list.agents.map(summary => ({ kind: 'custom' as const, id: summary.id, name: summary.name, summary })),
  ]
}

/** The Harnesses an Agent can run on now: ready, saved, and able to receive an Agent's instructions. */
export function agentHarnesses(catalog: HostCatalog | undefined): HarnessInfo[] {
  return (catalog?.harnesses ?? []).filter(harness => harness.status === 'ready' && harness.agentContext !== undefined && !harness.offer)
}

/**
 * New 通用 topics use Standard Agent in their fixed home, independently of Code's current default Harness.
 */
export function generalChoice(catalog: HostCatalog | undefined): ComposerChoice {
  return {
    mode: 'agent',
    workspaceId: 'default',
    harnessId: 'standard',
    ...(catalog?.defaults.model ? { model: catalog.defaults.model } : {}),
  }
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

export function modelName(catalog: HostCatalog | undefined, model: ModelRef): string {
  const provider = findProvider(catalog, model.providerId)
  return provider ? model.model : COPY.removedService(model.model)
}

/** Where a new topic works: the selected project, or the Agent's fixed home. */
export function worksIn(catalog: HostCatalog | undefined, projectId: string | undefined): string {
  if (!projectId || projectId === 'default') return COPY.home
  const project = catalog?.workspaces.find(item => item.id === projectId)
  return project ? projectName(project) : COPY.removedProject
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
  if (id === GENERAL_AGENT_ID) return { id, name: AGENT_SPACE_COPY.general }
  const found = snapshot.customAgents?.find(agent => agent.id === id)
  return {
    id,
    name: found?.name ?? (snapshot.customAgents ? AGENT_SPACE_COPY.deletedAgent : 'Agent'),
    ...(found ? { avatar: found.avatar } : {}),
  }
}

/**
 * Who answers in a session of 我的 Agent: the helper's face and name (通用's own; a deleted one's neutral face). Code's
 * sessions have none, so their author line keeps the Harness and the model.
 */
export function speakerOf(
  snapshot: Pick<AppSnapshot, 'customAgents'>,
  task: Pick<TaskSummary, 'agent' | 'generalChat'> | undefined,
): { name: string; avatar: AgentAvatar | 'general' } | undefined {
  const named = sessionAgent(snapshot, task)
  return named ? { name: named.name, avatar: named.avatar ?? 'general' } : undefined
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
  agent: Pick<CustomAgentSummary, 'id' | 'available' | 'workComputer'>,
): AvatarState {
  const own = snapshot.tasks.filter(task => topicOwner(task) === agent.id)
  const asking = new Set(snapshot.approvals.map(approval => approval.sessionId))
  if (own.some(task => waitsOnYou(task) || (asking.has(task.id) && task.status === 'running'))) return 'waiting'
  if (own.some(task => task.status === 'running' || task.status === 'waiting-approval')) return 'running'
  if (!agent.available && !agent.workComputer) return 'resting'
  const latest = own
    .filter(task => !task.archived)
    .reduce<TaskSummary | undefined>((found, task) => (!found || task.updatedAt > found.updatedAt ? task : found), undefined)
  return latest && rowStatus(latest).kind === 'failed' ? 'failed' : 'idle'
}

/**
 * The words beside a face for the states that have one, as a person says them (agents/personWords.ts); 休息 says 不可用
 * through the Agent's availability. 运行中 stands in only while no topic says what it does.
 */
export const ACTIVITY_WORDS: Partial<Record<AvatarState, { words: string; tone: 'running' | 'waiting' | 'failed' }>> = {
  running: {
    get words() {
      return AGENT_SPACE_COPY.running
    },
    tone: 'running',
  },
  waiting: WAITS_ON_YOU,
  failed: {
    get words() {
      return COPY.failed
    },
    tone: 'failed',
  },
}

/**
 * What a running helper is doing, from its running topic's `RunLive.activity` (the one in view first): 在想, 在跑命令…
 * Undefined while none of its topics runs or says.
 */
export function agentLiveWord(
  snapshot: Pick<AppSnapshot, 'tasks'>,
  id: string,
  prefer?: string | null,
): { words: string; tone: 'running' | 'waiting' } | undefined {
  const running = snapshot.tasks.filter(task => topicOwner(task) === id && task.status === 'running' && task.live)
  const task = running.find(item => item.id === prefer) ?? running[0]
  return personActivity(task?.live)
}

export type ConsultationScope = ReturnType<typeof consultationScope>

/** The current settings screen grants local peers. Older, narrower scopes survive unrelated edits. */
export function consultationPatch(scope: ConsultationScope) {
  if (scope === 'off') return { canConsultAgents: false }
  if (scope === 'local') return { canConsultAgents: true, canConsultLocalAgents: true }
  return { canConsultAgents: true, canConsultLocalAgents: false, canConsultDeepSeek: scope === 'legacy-dsh' }
}

/** What the form edits. */
export interface AgentDraft {
  name: string
  description: string
  instructions: string
  harnessId: string
  mode: TaskMode
  model?: ModelRef
  engineOptions?: Record<string, string>
  defaultProjectId?: string
  skills: string[]
  consultation?: ConsultationScope
  useOwnPermissionsForConsultations?: boolean
  /** Absent: every enabled plugin (no extra limit). */
  tools?: string[]
}

export function draftOf(agent: CustomAgentDetail['agent']): AgentDraft {
  return {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    harnessId: agent.harnessId,
    mode: agent.mode,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.engineOptions ? { engineOptions: { ...agent.engineOptions } } : {}),
    ...(agent.defaultProjectId ? { defaultProjectId: agent.defaultProjectId } : {}),
    skills: agent.skills,
    consultation: consultationScope(agent),
    useOwnPermissionsForConsultations: !!agent.useOwnPermissionsForConsultations,
    ...(agent.tools ? { tools: agent.tools } : {}),
  }
}

/** A draft as the Host takes it: explicit model intent stays for route validation, with a mode the Harness has. */
export function normalizedDraft(catalog: HostCatalog | undefined, draft: AgentDraft): AgentDraft {
  const harness = catalog?.harnesses.find(item => item.id === draft.harnessId)
  const { model, ...rest } = draft
  const mode = harness && !harness.modes.includes(draft.mode) ? (harness.modes[0] ?? draft.mode) : draft.mode
  return {
    ...rest,
    name: draft.name.trim(),
    description: draft.description.trim(),
    mode,
    ...(model ? { model } : {}),
  }
}

/** The existing start controls edit an Agent's defaults; synthetic service selection stays only in the view. */
export function agentDefaultChoice(catalog: HostCatalog, draft: AgentDraft): ComposerChoice {
  const harness = catalog.harnesses.find(item => item.id === draft.harnessId)
  return {
    harnessId: draft.harnessId,
    workspaceId: draft.defaultProjectId ?? 'default',
    mode: draft.mode,
    ...(usesHostModels(harness)
      ? { model: draft.model ?? catalog.defaults.model }
      : {
          config: withServicePick(
            draft.engineOptions,
            draft.model,
            harness?.catalogue?.options.find(option => option.category === 'model')?.id,
          ),
        }),
  }
}

export function withAgentDefaultChoice(catalog: HostCatalog, draft: AgentDraft, patch: Partial<ComposerChoice>): AgentDraft {
  const harness = catalog.harnesses.find(item => item.id === draft.harnessId)
  const choice = { ...agentDefaultChoice(catalog, draft), ...patch }
  if (usesHostModels(harness)) return { ...draft, model: choice.model }
  const prior = draft.model && withServicePick(undefined, draft.model)
  const retained = prior && Object.entries(prior).every(([key, value]) => choice.config?.[key] === value)
  return {
    ...draft,
    model: servicePick(catalog, harness, choice.config) ?? (retained ? draft.model : undefined),
    engineOptions: withServicePick(choice.config, undefined),
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Only what changed, with `null` for what was cleared, against the revision the form was opened on. */
export function patchOf(base: AgentDraft, next: AgentDraft): Omit<CustomAgentPatch, 'requestId' | 'baseRevision'> {
  const patch: Omit<CustomAgentPatch, 'requestId' | 'baseRevision'> = {}
  if (base.name !== next.name) patch.name = next.name
  if (base.description !== next.description) patch.description = next.description
  if (base.instructions !== next.instructions) patch.instructions = next.instructions
  if (base.harnessId !== next.harnessId) patch.harnessId = next.harnessId
  if (base.consultation !== next.consultation) Object.assign(patch, consultationPatch(next.consultation ?? 'off'))
  if (!!base.useOwnPermissionsForConsultations !== !!next.useOwnPermissionsForConsultations)
    patch.useOwnPermissionsForConsultations = !!next.useOwnPermissionsForConsultations
  if (base.mode !== next.mode) patch.mode = next.mode
  if (!same(base.model, next.model)) patch.model = next.model ?? null
  if (!same(base.engineOptions, next.engineOptions)) patch.engineOptions = next.engineOptions ?? null
  if (!same(base.defaultProjectId, next.defaultProjectId)) patch.defaultProjectId = next.defaultProjectId ?? null
  if (!same(base.skills, next.skills)) patch.skills = next.skills
  if (!same(base.tools, next.tools)) patch.tools = next.tools ?? null
  return patch
}

const DRAFT_FIELDS = [
  'name',
  'description',
  'instructions',
  'harnessId',
  'mode',
  'model',
  'engineOptions',
  'defaultProjectId',
  'consultation',
  'useOwnPermissionsForConsultations',
  'skills',
  'tools',
] as const

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
      message: error instanceof ApiTimeoutError || error instanceof ApiError ? error.message : COPY.interrupted,
    }
  if (error instanceof ApiError) return { kind: 'refused', message: error.message, code: error.code }
  if (error instanceof ClientError) return { kind: 'refused', message: error.message }
  return { kind: 'refused', message: COPY.refused }
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

/** 定时任务's schedule in words: 每天 09:00, 工作日 09:00, 每周一 09:00. */
export function scheduleWords(schedule: AutomationSummary['schedule']): string {
  if (schedule.kind === 'daily') return COPY.daily(schedule.time)
  if (schedule.kind === 'weekdays') return COPY.weekdays(schedule.time)
  return COPY.weekly(COPY.days[schedule.day] ?? '', schedule.time)
}

/** A run's state in the words the session list uses. */
export const RUN_WORDS = defineCopy(
  {
    running: '运行中',
    waiting: '等你处理',
    completed: '完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断',
    unknown: '结果未知',
    missed: '错过',
    skipped: '跳过',
  } satisfies Record<NonNullable<AutomationSummary['lastRun']>['state'], string>,
  {
    running: 'Running',
    waiting: 'Needs you',
    completed: 'Complete',
    failed: 'Failed',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted',
    unknown: 'Outcome unknown',
    missed: 'Missed',
    skipped: 'Skipped',
  },
)
