import type { Approval, ModelRef, TaskDetail, TaskMode, TaskSummary } from '@latch/protocol/types'

export interface CreateTaskInput {
  prompt: string
  requestId: string
  mode?: TaskMode
  /** Model for drivers that run on the Host's providers. Others may ignore it. */
  model?: ModelRef
  /** Absolute working directory chosen from the Host's workspaces. Absent means the driver default. */
  cwd?: string
  /** L3 drivers: the launch fingerprint the owner confirmed. ACP refuses when absent (409 l3-confirmation-missing) or different (409 agent-definition-changed). */
  expectedLaunchHash?: string
}

export interface PromptOptions {
  /** Switch the session to this model from this turn on. */
  model?: ModelRef
}

export interface DecideOptions {
  /** One of `Approval.options[].id`. */
  optionId?: string
}

export interface SetConfigOptions {
  /** The owner confirmed widening a mode-category option through local presence confirmation. */
  allowWiden?: boolean
}

export type ConfigChangeClass = 'neutral' | 'stricter' | 'wider' | 'forbidden'

/** What an L3 session would launch, shown in the local confirmation before it starts. */
export interface LaunchPreview {
  launchHash: string
  /** Absolute path. */
  command: string
  args: string[]
  /** Names only, sorted; values never leave the Host. */
  envNames: string[]
  cwd: string
  presetId?: string
  verified: boolean
  approvals: 'prompts' | 'none'
  readback: 'mode' | 'none'
  notes: string[]
}

export interface Bridge {
  start(): Promise<void>
  close(): Promise<void>
  listTasks(): Promise<TaskSummary[]>
  detail(sessionId: string): Promise<TaskDetail>
  createTask(input: CreateTaskInput): Promise<{ sessionId: string }>
  prompt(sessionId: string, prompt: string, requestId: string, options?: PromptOptions): Promise<void>
  cancel(sessionId: string): Promise<void>
  approvals(): Approval[]
  decide(approvalId: string, decision: 'allow' | 'reject', options?: DecideOptions): Promise<boolean>
  subscribe(listener: (sessionId?: string) => void): () => void
  /** Optional. Delete a settled session's data; reject with 409 `task-running` while it runs. */
  remove?(sessionId: string): Promise<void>
  /** Optional. Change one of `TaskDetail.config` for later turns. */
  setConfig?(sessionId: string, configId: string, value: string, options?: SetConfigOptions): Promise<void>
  /** Optional. How a config change relates to the session's expected permission mode. */
  classifyConfigChange?(sessionId: string, configId: string, value: string): Promise<ConfigChangeClass>
  /** Optional, L3 drivers. What a new session in `cwd` would launch. */
  launchPreview?(input: { cwd: string }): Promise<LaunchPreview>
}
