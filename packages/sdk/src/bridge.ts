import type {
  AttachmentRef,
  FileMention,
  Approval,
  ModelRef,
  AgentExecutionContext,
  RunLive,
  TaskDetail,
  TaskMode,
  TaskSummary,
} from '@latch/protocol/types'

/** One folder of a project: its ID inside the project (stable across reorders) and its absolute path. */
export interface ProjectFolder {
  id: string
  path: string
}

export interface CreateTaskInput {
  /** Authoritative Host-only agent context, transient for this run. */
  agentContext?: AgentExecutionContext
  fileRefs?: FileMention[]
  attachments?: AttachmentRef[]
  prompt: string
  requestId: string
  mode?: TaskMode
  /** Model for drivers that run on the Host's providers. Others may ignore it. */
  model?: ModelRef
  /** Absolute working directory chosen from the Host's workspaces. Absent means the driver default. */
  cwd?: string
  /**
   * Drivers that declare `projectFolders: 'all'`, with `cwd`: the project the session starts in (`default` for the
   * start directory). Others never receive it.
   */
  workspaceId?: string
  /**
   * Drivers that declare `projectFolders: 'all'`, with `cwd` and `workspaceId`: every folder of that project in order;
   * `[0].path` is `cwd` (the primary folder). The driver checks them against `projects()` and keeps them for the
   * session's lifetime. Others never receive it and use `cwd` alone.
   */
  folders?: ReadonlyArray<ProjectFolder>
  /** L3 drivers: the launch fingerprint the owner confirmed. ACP refuses when absent (409 l3-confirmation-missing) or different (409 agent-definition-changed). */
  expectedLaunchHash?: string
}

export interface PromptOptions {
  /** The agent's context as it stands for this turn; never accepted from an HTTP body. */
  agentContext?: AgentExecutionContext
  /** Host queue time, for the accepted user message. */
  queuedAt?: string
  fileRefs?: FileMention[]
  attachments?: AttachmentRef[]
  /** Switch the session to this model from this turn on. */
  model?: ModelRef
}

export interface DecideOptions {
  /** One of `Approval.options[].id`. */
  optionId?: string
  /** Where the person decided, for the call's decision record: the Host computer's desktop app or another device. */
  via?: 'this-mac' | 'other-device'
  /**
   * With a rejection: what the person wants done instead, printable and at most 500 characters. The built-in harness
   * hands it to the model with the rejection; drivers whose permission answer carries no text ignore it.
   */
  note?: string
}

export interface CancelOptions {
  /**
   * Cancel only while this is the session's current run (`TaskSummary.runId`). A driver that tracks runs checks it in
   * the same step that starts the cancel, so a run that began afterwards keeps running.
   */
  runId?: string
}

export interface SetConfigOptions {
  /** Host authority, checked after async preparation and immediately before an external configuration request. */
  authorize?: () => void
  /** The owner confirmed widening a mode-category option through local presence confirmation. */
  allowWiden?: boolean
}

export type ConfigChangeClass = 'neutral' | 'stricter' | 'wider' | 'forbidden'

/** What an L3 session would launch, shown in the local confirmation before it starts. */
export interface LaunchPreview {
  launchHash: string
  /**
   * The fingerprint without the project's configuration (command, arguments, variables, preset), so the Host can tell a
   * changed project configuration from a changed command; absent from drivers that do not say.
   */
  definitionHash?: string
  /** Absolute path. */
  command: string
  args: string[]
  /** Names only, sorted; values never leave the Host. */
  envNames: string[]
  /** The names the definition itself sets, sorted, for the system sheet's reason; absent from drivers that do not say. */
  definitionEnvNames?: string[]
  cwd: string
  /** Folders besides `cwd` the agent receives, as ordered absolute paths. Absent or empty: `cwd` only. */
  folders?: string[]
  presetId?: string
  /** The command is the preset's own, at the location the Host finds it, with the preset's arguments. */
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
  /**
   * Resolves once the cancelled run has settled. `false`: nothing was cancelled, because no run was active or `runId`
   * named a run that is no longer current. Drivers that cannot tell resolve without a value.
   */
  cancel(sessionId: string, options?: CancelOptions): Promise<boolean | void>
  approvals(): Approval[]
  decide(approvalId: string, decision: 'allow' | 'reject', options?: DecideOptions): Promise<boolean>
  subscribe(listener: (sessionId?: string) => void): () => void
  /**
   * Optional. The runs live now, from memory and without awaiting: the Host calls it on each change and when a silence
   * threshold falls due, so it must cost no more than the number of live runs. `TaskSummary.live` carries the same facts.
   */
  liveRuns?(): Array<{ sessionId: string; live: RunLive }>
  /** Optional. Delete a settled session's data; reject with 409 `task-running` while it runs. */
  remove?(sessionId: string): Promise<void>
  /** Optional. Change one of `TaskDetail.config` for later turns. */
  setConfig?(sessionId: string, configId: string, value: string, options?: SetConfigOptions): Promise<void>
  /** Optional. How a config change relates to the session's expected permission mode. */
  classifyConfigChange?(sessionId: string, configId: string, value: string): Promise<ConfigChangeClass>
  /** Optional, L3 drivers. What a new session in `cwd` would launch; `workspaceId` and `folders` as in `CreateTaskInput`. */
  launchPreview?(input: { cwd: string; workspaceId?: string; folders?: ReadonlyArray<ProjectFolder> }): Promise<LaunchPreview>
}
