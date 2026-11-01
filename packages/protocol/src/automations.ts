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
export type AutomationCreate = AutomationConfig & { requestId: string }
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
