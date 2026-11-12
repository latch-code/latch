import type { ModelRef } from './types.ts'

/** Every time reads in the Mac's own time zone; the Host follows it when it changes. */
export type AutomationSchedule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  /** `day`: 0 is Sunday, as in `Date.getDay`. */
  | { kind: 'weekly'; day: number; time: string }

export interface AutomationConfig {
  name: string
  /** One of 我的 Agent on the built-in engine. Absent: 通用. */
  customAgentId?: string
  /** Absent: the agent's model, or for 通用 the Host's default. */
  model?: ModelRef
  /** Absent: each run gets a folder of its own in the start directory. */
  projectId?: string
  /** 要做的事. */
  prompt: string
  schedule: AutomationSchedule
  /** 「结果出来时通知我」: asks clients to notify when a run settles. */
  notify: boolean
}

/** What stops a saved automation from running on its own. 等你处理 until the owner turns it on again. */
export type AutomationPauseReason =
  | 'definition-changed'
  | 'owner-unavailable'
  | 'agent-unavailable'
  | 'unknown-outcome'
  | 'audit-unavailable'

export type AutomationRunState =
  | 'running'
  /** The run stopped to ask for an approval. */
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown'
  /** The Mac or the Host was off or asleep at that time. Missed runs are not caught up, so nothing fires unexpectedly on waking. */
  | 'missed'
  /** The time came while this automation's previous run was still going. Not caught up either. */
  | 'skipped'

export interface AutomationRun {
  /** The scheduled time, or when 立即运行 was pressed. */
  at: string
  state: AutomationRunState
  trigger: 'schedule' | 'manual'
  /** Absent on a missed or skipped time, or when the start's result stayed unknown. */
  sessionId?: string
}

export interface Automation extends AutomationConfig {
  id: string
  revision: number
  /** Saved as on. A pause turns this off, and `pause` says why. */
  enabled: boolean
  state: 'off' | 'ready' | 'running' | 'paused'
  pause?: { reason: AutomationPauseReason; message: string }
  nextRunAt?: string
  lastRun?: AutomationRun
  createdAt: string
  updatedAt: string
}
/** Without the prompt: it stays in the detail route, behind the same gates as an agent's instructions. */
export type AutomationSummary = Omit<Automation, 'prompt' | 'createdAt' | 'updatedAt'>
export interface AutomationDetail {
  automation: Automation
  /** Newest first. */
  runs: AutomationRun[]
}
/** `proposalId`: saved from the Agent's schedule proposal, which the Host then marks saved. Never stored on the schedule. */
export type AutomationCreate = AutomationConfig & { requestId: string; proposalId?: string }
export type AutomationPatch = Partial<Omit<AutomationConfig, 'customAgentId' | 'model' | 'projectId'>> & {
  requestId: string
  baseRevision: number
  customAgentId?: string | null
  model?: ModelRef | null
  projectId?: string | null
}
export interface AutomationEnable {
  requestId: string
  baseRevision: number
  enabled: boolean
}
export interface AutomationRunRequest {
  requestId: string
}
export interface AutomationList {
  automations: Automation[]
}

/** How a run that settled ended, as its result card says. */
export type ScheduleResultOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'
export interface ScheduleResultFile {
  root: string
  path: string
  change: 'created' | 'modified' | 'deleted'
}
/**
 * A run's result card: recorded by the Host when a run of a schedule settles, in its Agent's conversation (通用's for a
 * schedule that names no Agent). Never a message: no Harness receives it, and it changes no topic's context.
 */
export interface ScheduleResult {
  /** Stable for one run: the same run settling again (a restart) records it once. */
  id: string
  automationId: string
  /** An Agent's ID, or `general`. */
  owner: string
  /** The schedule's name when the run settled. */
  name: string
  outcome: ScheduleResultOutcome
  trigger: 'schedule' | 'manual'
  /** When the run was due, or when 立即运行 was pressed. */
  runAt: string
  /** When it settled: where the card sits in the topic. */
  at: string
  /** The run's session; absent when it never started. */
  sessionId?: string
  /** The topic it was delivered in; absent while the Agent had no topic (shown on its new topic, then kept by the next). */
  topicId?: string
  /** The start of the run's last reply. */
  reply?: string
  replyTruncated?: true
  /** What the run changed or produced, from its changes and observed outputs. */
  files?: ScheduleResultFile[]
  /** Files beyond those listed. */
  filesMore?: number
  /** Why it did not complete, as the run's failure note says it, with that note's error code for the next step. */
  failure?: { reason: string; code?: string }
  /** The run's session was deleted: its reply and files went with it. */
  contentRemoved?: true
}
export interface ScheduleResultList {
  results: ScheduleResult[]
}
/** What the snapshot says of an owner's result cards: how many wait for a topic, and when any last changed. */
export interface AgentResultState {
  unbound: number
  at: string
}
