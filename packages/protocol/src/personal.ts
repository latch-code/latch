import type { ModelRef, TaskMode, TaskSummary, PluginInfo } from './types.ts'

export interface PersonalAssistantConfig {
  name: string
  role: string
  harnessId: string
  mode: TaskMode
  model?: ModelRef
  /** Selected, enabled Cordis package IDs. An empty selection grants no Host tools or skills. */
  pluginIds: string[]
}
export interface PersonalAssistant extends PersonalAssistantConfig {
  id: string
  revision: number
  createdAt: string
  updatedAt: string
}
export interface PersonalAssistantSummary extends PersonalAssistant {
  memoryCount: number
  sessionCount: number
  available: boolean
  unavailableReason?: string
  canSchedule: boolean
}
export type PersonalAssistantCreate = PersonalAssistantConfig & { requestId: string }
export type PersonalAssistantPatch = Omit<Partial<PersonalAssistantConfig>, 'model'> & {
  requestId: string
  baseRevision: number
  model?: ModelRef | null
}

/** Explicitly maintained by the user. Never automatically copied to another assistant or group. */
export interface PersonalMemory {
  id: string
  content: string
  revision: number
  createdAt: string
  updatedAt: string
}
export interface PersonalAssistantDetail {
  assistant: PersonalAssistantSummary
  memories: PersonalMemory[]
  sessions: TaskSummary[]
}
export interface PersonalMemoryCreate {
  requestId: string
  content: string
}
export interface PersonalMemoryPatch {
  requestId: string
  baseRevision: number
  content: string
}

export interface PersonalSessionOwner {
  assistantId: string
  groupId?: string
}
/** Host-to-driver context; never accepted as authority from an HTTP client or included in public messages. */
export interface PersonalExecutionContext {
  owner: PersonalSessionOwner
  /** Host-frozen capability revisions for delegated or scheduled execution. */
  expectedRevisions?: Record<string, string>
  instructions: string
  /** Explicit group history only, with its original roles. Transient and never inherited by another session. */
  sharedMessages?: Array<{ role: 'user' | 'assistant'; text: string }>
  pluginIds: string[]
  revision: string
}

export interface PersonalRoutineConfig {
  assistantId: string
  name: string
  prompt: string
  schedule: { kind: 'daily'; time: string; timeZone: string }
}
export type PersonalRoutinePauseReason =
  | 'definition-changed'
  | 'owner-unavailable'
  | 'harness-unavailable'
  | 'plugin-unavailable'
  | 'missed'
  | 'unknown-outcome'
  | 'audit-unavailable'
export interface PersonalRoutine extends PersonalRoutineConfig {
  id: string
  revision: number
  enabled: boolean
  state: 'disabled' | 'ready' | 'running' | 'paused'
  pauseReason?: PersonalRoutinePauseReason
  nextRunAt?: string
  lastRun?: { sessionId?: string; at: string; state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown' }
  createdAt: string
  updatedAt: string
}
export type PersonalRoutineCreate = PersonalRoutineConfig & { requestId: string }
export type PersonalRoutinePatch = Partial<PersonalRoutineConfig> & { requestId: string; baseRevision: number }
export interface PersonalRoutineEnable {
  requestId: string
  baseRevision: number
  enabled: boolean
}

export interface PersonalGroupConfig {
  name: string
  memberIds: string[]
  defaultAssistantId: string
  /** User-authored shared instructions; members' private roles and memories are not added. */
  instructions: string
  maxRelays: number
}
export interface PersonalGroup extends PersonalGroupConfig {
  id: string
  revision: number
  createdAt: string
  updatedAt: string
}
export type PersonalGroupCreate = PersonalGroupConfig & { requestId: string }
export type PersonalGroupPatch = Partial<PersonalGroupConfig> & { requestId: string; baseRevision: number }
export interface PersonalGroupInput {
  requestId: string
  prompt: string
  /** Explicit ordered participants for this turn; absent uses the default responder. */
  assistantIds?: string[]
}
export interface PersonalGroupMessage {
  id: string
  requestId?: string
  role: 'user' | 'assistant' | 'system'
  text: string
  assistantId?: string
  sessionId?: string
  createdAt: string
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
}
export interface PersonalGroupTurn {
  id: string
  reason?: 'definition-changed' | 'owner-unavailable' | 'unknown-outcome' | 'host-restarted' | 'storage-unavailable'
  state: 'running' | 'waiting-approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  assistantIds: string[]
  sessionIds: string[]
  currentAssistantId?: string
  createdAt: string
}
export interface PersonalGroupCancel {
  requestId: string
  turnId: string
}
export interface PersonalGroupDetail {
  group: PersonalGroup
  messages: PersonalGroupMessage[]
  turn?: PersonalGroupTurn
  sessions: TaskSummary[]
}
export interface PersonalOverview {
  plugins?: Array<Pick<PluginInfo, 'id' | 'name' | 'description' | 'capabilities'>>
  assistants: PersonalAssistantSummary[]
  groups: PersonalGroup[]
  routines: PersonalRoutine[]
}
