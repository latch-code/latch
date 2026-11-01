import type { FileChange } from './files.ts'
import type { FileMention } from './file-refs.ts'
import type { AttachmentRef } from './attachments.ts'
import type { PromptQueueItem } from './features.ts'
import type { AgentQuestion } from './questions.ts'
import type { PersonalSessionOwner } from './personal.ts'

export interface SessionCommand {
  name: string
  description?: string
  inputHint?: string
}

/** Browser-safe product state, independent of a particular harness driver. */
export type TaskStatus = 'idle' | 'running' | 'waiting-approval' | 'cancelled' | 'failed' | 'interrupted'
export type TaskMode = 'chat' | 'agent'

/**
 * Tokens a model step used. `inputTokens` counts all input (cached input included) and `outputTokens` all output
 * (reasoning included), so older clients still compare them; the optional parts say how much of each was a cache read,
 * a cache write or reasoning, when the provider reported it.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** Part of `inputTokens` read from the provider's prompt cache. */
  cacheReadTokens?: number
  /** Part of `inputTokens` written to the provider's prompt cache. */
  cacheWriteTokens?: number
  /** Part of `outputTokens` spent on reasoning. */
  reasoningTokens?: number
}

/** What a turn took, recorded by the Host on the user message that opened it. Times are ISO strings. */
export interface TurnStats {
  /** When the turn settled; absent when it never did (a Host restart interrupted it). */
  endedAt?: string
  /** Working time: from the prompt to `endedAt`, without the time spent waiting for approvals. */
  activeMs?: number
  /** Time during the turn when at least one approval waited for a person. */
  waitMs?: number
}

/** What an agent reported about its context window and cost; never estimated by Latch. */
export interface UsageReport {
  contextUsed?: number
  contextSize?: number
  cost?: { amount: number; currency: string }
  /** When the agent last reported it. */
  at: string
}

export interface TaskSummary {
  /** Enabled capability owners selected by this personal assistant. */
  pluginIds?: string[]
  /** Host-owned personal context, independent of a saved project. Absent for ordinary project sessions. */
  personal?: PersonalSessionOwner
  /** Host-derived count only; question bodies remain in gated detail. Absent on older Hosts. */
  pendingQuestions?: number
  id: string
  title: string
  status: TaskStatus
  updatedAt: string
  /** When the session was created; absent on sessions created before the Host recorded it. */
  createdAt?: string
  cwd?: string
  model?: string
  /** Missing on historical tasks; those retain the original Agent behavior. */
  mode?: TaskMode
  /** Harness that owns the session. The Host fills it in for every driver. */
  harnessId?: string
  /** Provider of `model` when the harness runs on the Host's model providers. */
  providerId?: string
  /** Host-level session metadata; it applies to every harness. */
  pinned?: boolean
  archived?: boolean
  /** Accumulated model usage reported by the provider or agent. */
  usage?: TokenUsage
  /** L1: Latch asks before each risky tool call. L3: the harness runs unsandboxed (full access). */
  level?: 'L1' | 'L3'
  /** The harness changed its own permission mode; the session no longer accepts input. */
  permissionDrift?: true
  /** The project the session was started in (`default` for the start directory). Absent on sessions from before projects had several folders. */
  workspaceId?: string
  /** The session's folders, frozen when it was created; `[0]` is `cwd`. Absent: the session uses `cwd` only. */
  folders?: Array<{ id: string; path: string }>
  /** Whether the harness received every folder of the project or only the primary one. */
  folderAccess?: 'all' | 'primary'
  /** Host-read, display-only Git branch or detached HEAD label; omitted when metadata cannot be verified. */
  branch?: string
  /**
   * The Host made `cwd` for this session alone, inside its default start directory (`workspaceId` is `default`): an
   * Agent session outside a saved project. The desktop can save it as a project's primary folder.
   */
  sessionFolder?: true
  /**
   * The session's current or latest run: a new value each time `createTask` or a prompt starts one. A cancel names it,
   * so a cancel that arrives late cannot stop a run that began afterwards. Drivers that do not track runs omit it.
   */
  runId?: string
  /** Explicit driver settlement; absent for older or third-party drivers. Only completed permits automatic follow-ups. */
  runOutcome?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  /** Host-generated provenance; files remain shared with the chosen project. */
  forkOf?: { taskId: string; upToMessageId: string; title: string; turn: number; prefixLength: number; truncated?: true }
  /** Skills snapshotted for the current or latest Standard run. */
  skills?: string[]
  /** While a run is live: what it is really doing. Never stored; absent on older Hosts and from drivers that do not report it. */
  live?: RunLive
  /** How the latest run ended when that took more than a plain answer. Cleared when the next run starts. */
  runEnd?: RunEnd
}

/**
 * The live run as the Host reads it. The driver reports what the engine is doing and when it last did anything; the
 * Host adds `silenceThresholdMs` and `silent`. Silence only ever asks: nothing stops a run because of it.
 */
export interface RunLive {
  runId: string
  /**
   * `starting`: the engine's process and session are being prepared. `model`: waiting on the model. `command`: a command
   * runs. `tool`: another tool runs. `approval`: waiting on a person. `cancelling`: a stop waits for the engine to settle.
   */
  activity: 'starting' | 'model' | 'command' | 'tool' | 'approval' | 'cancelling'
  /** With `command` and `tool`, session detail only: the list can be read without opening a session's content. */
  commandName?: string
  /** When this activity began. */
  since: string
  /**
   * When the run began, with the time it has spent waiting on a person: `since` restarts with each activity, so a clock
   * for the whole run reads these. Absent from drivers that do not report them.
   */
  runStartedAt?: string
  runWaitMs?: number
  runWaitingSince?: string
  /** The engine's last sign of life for this run: any update, request or result, or the start of this activity. */
  lastEventAt: string
  /** The last change of visible output. */
  lastOutputAt?: string
  /** How long this activity may stay quiet before the Host says so; absent while waiting on a person or a stop. */
  silenceThresholdMs?: number
  /** `lastEventAt` is older than the threshold. The Host announces the crossing once, as an ordinary session change. */
  silent?: true
  /** The engine sent requests Latch does not recognise; each was answered as unsupported. Absent when none. */
  unrecognized?: UnrecognizedRequests
}

/**
 * Requests of this run Latch does not recognise. While `at` is not older than `RunLive.lastEventAt` the engine has done
 * nothing since the latest one and may have stopped on it; the list is read again the moment that changes.
 */
export interface UnrecognizedRequests {
  count: number
  /** When the latest arrived. */
  at: string
  /** Session detail only: the latest request's method. */
  method?: string
  /** Session detail only: the system message that records it and what it asked. */
  messageId?: string
}

/** A command or other tool whose result nobody can vouch for. */
export interface UnknownResult {
  /** The `Message.id` of its tool row. */
  messageId: string
  name: string
}

/**
 * `process-exited`: the engine's process ended by itself or broke its protocol limits. `forced-stop`: a stop did not
 * settle in time and Latch ended the process. `host-stopped`: the Host stopped or restarted during the run. `turn-ended`:
 * the engine ended its turn and left calls unfinished.
 */
export interface RunEnd {
  reason: 'process-exited' | 'forced-stop' | 'host-stopped' | 'turn-ended'
  at: string
  /** Session detail only: what was running when it ended. These may or may not have taken effect. */
  unknownResults?: UnknownResult[]
  /** In the list and a cancel receipt, which can be read without opening a session's content: how many `unknownResults` there are. */
  unknownResultCount?: number
  /** More than the Host keeps were unknown. */
  unknownResultsTruncated?: true
}

/** The Host's answer to `POST /tasks/:id/keep-waiting`. */
export interface KeepWaitingResult {
  /**
   * `extended`: the threshold the request saw was doubled. `unchanged`: it had already moved, by a retry or another device.
   * `not-silent`: the run is not silent now. `ended`: the named run is no longer live.
   */
  outcome: 'extended' | 'unchanged' | 'not-silent' | 'ended'
  /** The threshold now in force. */
  thresholdMs?: number
}

/**
 * What a cancel did. `stopped`: this request stopped the run it named, and the run has settled. `ended`: that run had
 * already ended (or a later run had begun), so nothing was stopped.
 */
export type CancelOutcome = 'stopped' | 'ended'

/** The Host's answer to `POST /tasks/:id/cancel`, kept with the session so a retry gets the same answer. */
export interface CancelReceipt {
  sessionId: string
  /** Absent for a request sent without one; such a request has no stored receipt. */
  requestId?: string
  /** The run the request named. */
  runId?: string
  outcome: CancelOutcome
  /** The named run's final status, when the Host knows it: absent when a later run had begun. */
  status?: TaskStatus
  /** ISO time at which the Host settled the request. */
  at: string
  /** How the named run ended, when it took more than a plain answer: a forced stop names the results left unknown. */
  runEnd?: RunEnd
  /** A retry of a request the Host had already answered. */
  replay?: true
}

/** The Host's answer to `POST /approvals/:id`. */
export interface ApprovalReceipt {
  approvalId: string
  decision: 'allow' | 'reject'
  optionId?: string
  at: string
  replay?: true
}

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other'
export interface FileDiff {
  path: string
  oldText?: string
  newText: string
  /** Whether the file existed before: `none` is a new file; `unavailable` means it existed but its text is not shown (too large or binary). */
  previous?: 'none' | 'text' | 'unavailable'
}

/**
 * How the approval of a tool call ended, as the Host recorded it. `allowed` and `rejected` are a person's choice, made
 * on the Host computer's desktop app (`this-mac`) or on another device; `expired` and `cancelled` are answers nobody gave
 * (a time limit, the session stopping) and carry no `via`. Device names and ids stay in the audit.
 */
export interface ToolDecision {
  outcome: 'allowed' | 'rejected' | 'expired' | 'cancelled'
  /** When it was decided (ISO). */
  at: string
  via?: 'this-mac' | 'other-device'
}

/** Structured presentation of one tool call. `Message.text` keeps the plain-text form. */
export interface ToolDetail {
  kind?: ToolKind
  /** Short human summary, for example "读取 src/app.ts". */
  title?: string
  /**
   * The tool's own title from its definition (Latch 内置: 「读取文件」, 「写入文件」), escaped by the Host; rows and approval
   * cards show it with the call's object. Agents' tools have none and are described by `kind` and `title`.
   */
  toolTitle?: string
  /** Formatted call arguments. */
  input?: string
  /** Result text, when the call produced one. */
  output?: string
  locations?: string[]
  diffs?: FileDiff[]
  /** How the call's approval ended; absent for calls that needed none, from older Hosts and from plugin drivers. */
  decision?: ToolDecision
}

export interface Message {
  /** Changes observed during this run, including other writers; never attributed to the agent alone. */
  outputs?: FileChange[]
  outputsTruncated?: true
  outputsPending?: true
  outputsUnavailable?: true
  fileRefs?: FileMention[]
  attachments?: AttachmentRef[]
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  /** User input request identity, kept across retries and restarts. */
  requestId?: string
  /** When this input entered the Host queue, before it was actually sent. */
  queuedAt?: string
  /** Host-only provenance for the first user message. */
  forkContext?: NonNullable<TaskSummary['forkOf']>
  toolName?: string
  state?: 'queued' | 'awaiting-approval' | 'running' | 'completed' | 'failed' | 'cancelled'
  /** Assistant reasoning that the model or agent actually reported; never synthesized. */
  reasoning?: string
  tool?: ToolDetail
  usage?: TokenUsage
  /**
   * Host-recorded times, all optional (older Hosts, plugin drivers and history recorded before them have none). User:
   * when the prompt was accepted. Assistant: when the step began. Tool: when the call was recorded. System: when it was
   * written.
   */
  createdAt?: string
  /** Tool only: when it began to run, after any approval. */
  startedAt?: string
  /** Assistant: when the step finished. Tool: when it settled. */
  completedAt?: string
  /** Assistant: how long the model reasoned in this step, from its first reasoning to its first text or the step's end. */
  reasoningMs?: number
  /** Assistant: the model that answered this step, as the harness names it. */
  model?: string
  /** Assistant, built-in harness: the model service of `model`. */
  providerId?: string
  /** User: what the turn this message opened took. */
  turn?: TurnStats
  /** User: the turn it opened in the changes record (`TurnChanges.turnId`); absent when the run reached no folder, or from before this field. */
  turnId?: string
}

export type ApprovalOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
export interface ApprovalOption {
  id: string
  label: string
  kind: ApprovalOptionKind
}

/**
 * Why the Host classed a built-in harness's request as high risk (R2): the session's folder overlaps Latch's program
 * folder, the target is a protected path, the target leaves the session's folder (`..`), the target is not a relative
 * path the Host can judge (absolute, empty or not text), the tool is not one the Host lists, or the arguments do not
 * parse. An enum only: it never carries a path. Its words are `RISK_REASON_TEXT`.
 */
export type ApprovalRiskReason =
  | 'code-root'
  | 'protected-path'
  | 'outside-workspace'
  | 'unresolved-path'
  | 'unlisted-tool'
  | 'unparsable-arguments'

export interface Approval {
  id: string
  sessionId: string
  toolName: string
  toolCallId?: string
  reason: string
  arguments?: string
  requestedAt: string
  /** Choices beyond plain allow/reject. Absent means allow once or reject once. */
  options?: ApprovalOption[]
  /** Preview of the operation, such as the diff a write would apply. */
  tool?: ToolDetail
  /** Host classification. R2 can only be allowed on the Host's own desktop with local confirmation. */
  risk?: 'R1' | 'R2'
  /** Set by the Host on an R2 request of the built-in harness when its classifier names the reason. */
  riskReason?: ApprovalRiskReason
  /** Asked by an L3 harness: a prompt, not a security boundary. */
  advisory?: true
}

export interface PlanEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority?: 'high' | 'medium' | 'low'
}

/** A per-session option that the harness exposes, such as an agent's model or mode. */
export interface SessionConfigOption {
  id: string
  name: string
  category?: string
  description?: string
  currentValue: string
  options: Array<{ value: string; name: string; description?: string }>
}

export interface TaskDetail {
  /** Authorized detail projection only, never an unverified list/status snapshot. */
  fileChanges?: { runId: string; files: FileChange[]; state: 'watching' | 'settling'; truncated?: true; unavailable?: true }
  summary: TaskSummary
  messages: Message[]
  queue?: PromptQueueItem[]
  questions?: AgentQuestion[]
  approvals: Approval[]
  liveText: string
  cursor: number
  /**
   * Optional live projection; external HarnessDrivers may omit it. `starting`: an agent's process and session are being
   * prepared and nothing has been sent yet. `since`: when this phase began.
   */
  activity?: { phase: 'starting' | 'model' | 'tool' | 'approval' | 'cancelling'; toolName?: string; since?: string }
  /** Retained as the assistant message ID when this streamed reply settles. */
  liveMessageId?: string
  /** Reasoning streamed for the live reply; settles into `Message.reasoning`. */
  liveReasoning?: string
  /** When the live reply's reasoning began; with `liveReasoningMs` once its text has started. */
  liveReasoningStartedAt?: string
  liveReasoningMs?: number
  /** While a run is live: when it began and the approval wait it has accumulated; `runWaitingSince` while one is open. */
  runStartedAt?: string
  runWaitMs?: number
  runWaitingSince?: string
  /** While a run is live: the last change of visible output (text, reasoning, a tool, the plan, a new message). */
  lastOutputAt?: string
  /** The agent's latest report of its context window and cost. */
  usageReport?: UsageReport
  /** Commands currently advertised by this session; selecting one only edits the draft. */
  commands?: SessionCommand[]
  /** Latest plan reported by the harness. */
  plan?: PlanEntry[]
  /** Options the harness lets the user change for this session. */
  config?: SessionConfigOption[]
  /**
   * Transport version within one Host lifetime, not a durable replay cursor. `hostTime`: the Host's clock when it sent
   * a streamed state, which the client uses to measure live times on the Host's clock.
   */
  sync?: { instanceId: string; revision: number; hostTime?: string }
  /** Who enforces this session's permissions and what Latch could verify. */
  permission?: SessionPermission
}

export interface SessionPermission {
  level: 'L1' | 'L3'
  enforcer: 'LATCH' | 'NONE'
  readback?: 'mode' | 'none'
  verifiedDefinition?: boolean
  approvals?: 'prompts' | 'none'
  expectedMode?: string
  drift?: { at: string; observed: string }
  /** Display-only Chinese notes, e.g. 'pi 执行工具前不请求审批'. */
  notes: string[]
}
