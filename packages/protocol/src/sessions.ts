import type { SessionOrigin } from './apps.ts'
import type { FileChange } from './files.ts'
import type { FileMention } from './file-refs.ts'
import type { AttachmentRef } from './attachments.ts'
import type { PromptQueueItem } from './features.ts'
import type { AgentQuestion } from './questions.ts'
import type { ScheduleResult } from './automations.ts'
import type { AgentBrief, SessionAgentRef } from './custom-agents.ts'
import type { GatewayLoss } from './gateway-translations.ts'
import type { TurnSpend } from './model-usage.ts'

export interface SessionCommand {
  name: string
  description?: string
  inputHint?: string
  /**
   * Latch runs it through the harness's own protocol rather than sending its text, and only while no turn runs: it is
   * neither queued nor added to a running turn.
   */
  idleOnly?: true
}

/** Public skill suggestions. Native paths and contents stay inside the owning wire. */
export interface SessionSkill {
  name: string
  description?: string
  invocation: string
  scope?: 'project' | 'user' | 'system' | 'admin' | 'temporary'
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
  /** A session on a model route: what the turn sent through Latch, as the gateway counted it. */
  routed?: RoutedTurn
  /** The built-in harness: what the turn's model requests cost, when known, and a budget that is nearly used. */
  spend?: TurnSpend
}

/**
 * A turn's model requests through Latch, counted by the gateway itself rather than reported by the harness. Absent when
 * none reached it.
 */
export interface RoutedTurn {
  /** Model requests that reached the gateway during the turn, refused ones included, reading the model list aside. */
  requests: number
  /** The model the session had chosen for the turn, as the service names it. */
  chosen?: string
  /** By the model the requests named, in the order they first came; at most 16. */
  models: RoutedModel[]
  /** Closed diagnostic names only; no request, response or tool contents. */
  dropped?: GatewayLoss[]
  /**
   * The built-in harness, which calls services without the gateway: only the steps a 「出错时改用」 service answered are
   * counted here, and nothing else of the turn.
   */
  direct?: true
  /** What the turn's requests cost, when known, and a budget that is nearly used. */
  spend?: TurnSpend
}

export interface RoutedModel {
  /** The model the requests named. */
  model: string
  /** The model the service's latest reply said answered them, when it named one. */
  used?: string
  requests: number
  /** Of `requests`, those with no complete reply: Latch refused it, the service failed, or the harness gave up waiting. */
  failed?: number
  /** Of `requests`, those whose reply reported tokens; `usage` sums those. */
  measured?: number
  /** Of `requests`, those still under way when the turn ended: their results are not counted. */
  open?: number
  usage?: TokenUsage
  /** With `fallback`: the 「出错时改用」 service whose reply came back last, by ID. Absent: the session's own service answered. */
  provider?: string
  /** Of `requests`, those a 「出错时改用」 service answered. */
  fallback?: number
}

/** What an agent reported about its context window and cost; never estimated by Latch. */
export interface UsageReport {
  contextUsed?: number
  contextSize?: number
  cost?: { amount: number; currency: string }
  /** When the agent last reported it. */
  at: string
}

/** A session as a driver reports it; the Host adds which harness owns it (`TaskSummary`). */
export interface DriverTaskSummary {
  /** Plugins whose tools the session's agent may use. */
  pluginIds?: string[]
  /** A session of an assistant or of a group chat, which Latch no longer runs: private, and it only opens to be read. */
  personal?: { assistantId: string; groupId?: string }
  /** One of 我的 Agent; absent: 通用. The session's agent is fixed once it starts. */
  agent?: SessionAgentRef
  /** It received private context with no agent named, such as 通用, an automation's run or a fork of a private session: reading it takes the same scope as an agent. */
  agentPrivate?: true
  /** The automation this session is a run of. */
  automationId?: string
  /**
   * A conversation with 通用 in 我的 Agent (started with `customAgentId: 'general'`): it names no Agent, so 通用 applies as
   * to any session, but it belongs to 我的 Agent rather than Code. Host metadata; a driver's claim is dropped.
   */
  generalChat?: true
  /** The plugin page that started this session (Host metadata; a driver's claim is dropped). */
  origin?: SessionOrigin
  /** Host-derived count only; question bodies remain in gated detail. Absent on older Hosts. */
  pendingQuestions?: number
  /** Opaque previous-command report version; ordinary message updates do not change it. Not a capability claim. */
  commandsVersion?: string
  id: string
  title: string
  status: TaskStatus
  updatedAt: string
  /** When the session was created; absent on sessions created before the Host recorded it. */
  createdAt?: string
  cwd?: string
  model?: string
  /** Built-in harness: the thinking level `model` runs with; absent, the model's own default. */
  effort?: string
  /** Missing on historical tasks; those retain the original Agent behavior. */
  mode?: TaskMode
  /** Provider of `model` when the harness runs on the Host's model providers. */
  providerId?: string
  /**
   * A harness with its own models whose requests Latch forwards to one of its model services, fixed when the session
   * started: the service and the model chosen then. `bypassed`: a turn had a reply without a request through Latch.
   * `name`: the service's name in 设置 › 模型, absent once it is deleted; `off`: it is turned off there. `fallbacks`: what
   * the chosen model falls back to, fixed with the route, each with its service's name while it exists.
   */
  modelRoute?: {
    providerId: string
    model: string
    bypassed?: true
    name?: string
    off?: true
    fallbacks?: Array<{ providerId: string; model: string; name?: string }>
  }
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
   * The Host made `cwd` for this session alone, inside its default start directory (`workspaceId` is `default`). The
   * desktop may save it as a project's primary folder. Shared private helper homes do not expose this flag.
   */
  sessionFolder?: true
  /**
   * The Host made `cwd` for this session as a Git worktree of the project's folder, on a branch of its own. Files are
   * separate from the project folder's; ports, processes and local permissions are not. `unfiltered`: tracked files left
   * as Git stores them because their filter (Git LFS, for one) was not run. `removed`: the worktree was removed; the
   * session stays readable, its files are gone.
   */
  worktree?: { branch: string; unfiltered?: number; removed?: true }
  /** The first start of this launch in this project, the one the system sheet asks about: the timeline says what it can do. */
  firstStart?: true
  /**
   * The session's current or latest run: a new value each time `createTask` or a prompt starts one. A cancel names it,
   * so a cancel that arrives late cannot stop a run that began afterwards. Drivers that do not track runs omit it.
   */
  runId?: string
  /** Explicit driver settlement; absent for older or third-party drivers. Only completed permits automatic follow-ups. */
  runOutcome?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  /** Host-generated provenance; files remain shared with the chosen project. */
  forkOf?: { taskId: string; upToMessageId: string; title: string; turn: number; prefixLength: number; truncated?: true }
  /**
   * Host-recorded: the session was brought in from a session the harness `from` had before Latch (docs/HARNESSES.md#接入已有会话).
   * `native`: bound to that session and continued by the same harness with its own record. `text`: rebuilt from the
   * message text only (按文字重建，不是原样恢复); `prefixLength` characters of its first prompt are that text. Always private.
   */
  imported?: {
    from: string
    mode: 'native' | 'text'
    prefixLength?: number
    truncated?: true
    /** A text rebuild of this Latch session, brought in as it was, after its harness lost it. */
    fromTaskId?: string
  }
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
  /** A model request of this run waits for a free place. Set by the Host, never a driver. */
  queued?: true
  /** With `queued`, when it waits for a place of one service: that service, by name. Absent while it waits for the Host's own limit. */
  queuedFor?: string
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
  reason: 'process-exited' | 'forced-stop' | 'host-stopped' | 'turn-ended' | 'login-required'
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
  /** `cancelled` because the subagent that asked was stopped alone, while the session went on. */
  subagentStopped?: true
}

/**
 * One thing a command does, as the Harness that ran it classified it (Codex's parsed command actions): reading a file,
 * listing a folder or searching. Latch never derives these from a command's text.
 */
export interface ToolAction {
  kind: 'read' | 'list' | 'search'
  path?: string
  query?: string
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
  /** Host-only producer result without file contents; empty means file-only output. Removed from every device response. */
  outputWithoutFiles?: string
  locations?: string[]
  /**
   * What the Harness says this command does, only when it classified every part of it as a read, a listing or a
   * search; absent otherwise, and from Harnesses that report no such thing.
   */
  actions?: ToolAction[]
  diffs?: FileDiff[]
  /** How the call's approval ended; absent for calls that needed none, from older Hosts and from plugin drivers. */
  decision?: ToolDecision
  /** Decided without asking the person, in a mode where the harness's own model decides. */
  judged?: ToolJudgement
  /** The harness refused the call itself before it ran, without asking the person. */
  blocked?: ToolBlock
}

/**
 * A call the harness stopped on its own before it ran: its model reviewed the call (`model`; in a mode where that model
 * decides, `judged` says `denied` too) or its own rules and modes refused it (`rule`). `reason` is the harness's own
 * untrusted text, cut by the Host. Never a person's decision.
 */
export interface ToolBlock {
  /** The harness, as its definition names it. */
  by: string
  source: 'model' | 'rule'
  reason?: string
}

/**
 * A call no person was asked about, in a mode where the harness's own model decides. `approved`, `denied` and `none`:
 * this row is that model reviewing a request, with its verdict (`none`: it reached none, it timed out or stopped), or,
 * with `ToolDetail.blocked`, the call it denied.
 * `unasked`: the call ran without an ask, and the harness does not say whether a rule or its model let it through.
 * Never a person's approval, and never a decision record.
 */
export interface ToolJudgement {
  /** The harness, as its definition names it. */
  by: string
  outcome: 'approved' | 'denied' | 'none' | 'unasked'
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
  /**
   * User: the local `latch-mcp` bridge was allowed to fetch an MCP prompt during this turn. The message says
   * 来自 MCP 提示, and the context's proposals are marked external until it starts over.
   */
  origin?: 'mcp-prompt'
  /** When this input entered the Host queue, before it was actually sent. */
  queuedAt?: string
  /**
   * User: added to a turn that was already running. The agent took it into that turn; whether it read it before the turn
   * ended is not known. It opens no turn of its own.
   */
  steered?: true
  /** User: this turn began a new context. The agent saw none of the messages before it; they stay in the history. */
  freshContext?: true
  /**
   * User, the first message of a fork (`forkContext`): the harness forked its own record of the source session at that
   * turn, so the agent has that history and the text record before the person's words was not sent to it.
   */
  nativeFork?: true
  /** Host-only provenance for the first user message. */
  forkContext?: NonNullable<TaskSummary['forkOf']>
  /** Replayed from the harness's own record when the session was brought in (`TaskSummary.imported`), not run in Latch. */
  imported?: true
  /**
   * Host-only, on the first user message of a session rebuilt as text (`TaskSummary.imported.mode` `text`): its first
   * `prefixLength` characters are the rebuilt conversation of the harness `from`, not the person's words.
   */
  importContext?: { from: string; prefixLength: number; truncated?: true }
  toolName?: string
  state?: 'queued' | 'awaiting-approval' | 'running' | 'completed' | 'failed' | 'cancelled'
  /**
   * The Host stopped or restarted while this turn ran. Tool: it had not reported a result; with `failed` it had started and
   * nobody can say what it did, with `cancelled` it never started. Assistant: the reply stopped there. System: the note
   * that says so.
   */
  interrupted?: true
  /**
   * System, on the note that says why a turn failed: the Host's or the harness's error code (`model-unavailable`,
   * `agent-start-failed`, `http-401`…), so a client can offer the one next step that fits. The note's text is the reason.
   */
  errorCode?: string
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
  /** Assistant: the thinking level of this step, as the harness names it; the built-in harness gives its effort ID. */
  thinking?: string
  /** Assistant, built-in harness: the model service of `model`. */
  providerId?: string
  /** User: what the turn this message opened took. */
  turn?: TurnStats
  /** User, external engines: the agent context sent with this first turn, shown as 「Agent 指令」. */
  agentBrief?: AgentBrief
  /** User: the turn it opened in the changes record (`TurnChanges.turnId`); absent when the run reached no folder, or from before this field. */
  turnId?: string
  /** Tool row: a subagent the harness started for this turn, as it reported it. */
  subagent?: Subagent
}

/**
 * A session the harness started and runs on its own, shown where it began. It takes no messages; its requests for
 * approval come to the session that started it.
 */
export interface Subagent {
  title: string
  description?: string
  /** Evidence from an actual Codex delegation. Both IDs belong to the enclosing Latch conversation. */
  team?: {
    id: string
    memberId: string
    userMessageId?: string
    result?: string
    failure?: string
  }
  /**
   * What it last said of itself. `unknown`: it said it cannot tell, or the turn that started it ended without its saying
   * it stopped. Absent: it has not said.
   */
  status?: 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'unknown'
  /** What it said and did, in order, without its reasoning. */
  steps: Message[]
  /** It did more than the steps kept. */
  truncated?: true
  /** It is working and its harness says it can be stopped alone, without stopping the session's turn. */
  stoppable?: true
  /** A stop was sent and it has not yet said it stopped: never shown as stopped before it does. */
  stopping?: true
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
 * path the Host can judge (absolute, empty or not text), the tool is not one the Host lists, the arguments do not
 * parse, the browser would type into a password, one-time-code, card or hidden field (or one never read), or the tool is
 * a remote MCP server's (`mcp-tool`). An enum only: it never carries a path. Its words are `RISK_REASON_TEXT`.
 */
export type ApprovalRiskReason =
  | 'code-root'
  | 'protected-path'
  | 'outside-workspace'
  | 'unresolved-path'
  | 'unlisted-tool'
  | 'unparsable-arguments'
  | 'sensitive-field'
  | 'mcp-tool'

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
  /** Asked by a subagent of the session (`Message.subagent`), by its name. */
  subagent?: string
  /** The member row of this Latch session, when linked to Codex team evidence. */
  subagentId?: string
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
  /** A Host-owned startup setting, not an independent effective-value report from the Harness. */
  source?: 'launch'
  currentValue: string
  options: Array<{ value: string; name: string; description?: string }>
}

/** A session as clients read it. Every one has a harness: the Host fills it in for every driver. */
export interface TaskSummary extends DriverTaskSummary {
  harnessId: string
}

export interface DriverTaskDetail extends Omit<TaskDetail, 'summary'> {
  summary: DriverTaskSummary
}

export interface TaskDetail {
  /** Actual availability on this conversation's local Codex process, when known. */
  codexTeam?: 'available' | 'disabled'
  /** Authorized detail projection only, never an unverified list/status snapshot. */
  fileChanges?: { runId: string; files: FileChange[]; state: 'watching' | 'settling'; truncated?: true; unavailable?: true }
  summary: TaskSummary
  messages: Message[]
  queue?: PromptQueueItem[]
  questions?: AgentQuestion[]
  /** The person's 「记住…」 in this session that the Host did not keep, by the message's request, with why; never the text. */
  memoryRefusals?: Array<{ requestId: string; reason: string }>
  /** A topic of 我的 Agent: the schedule results delivered into it, oldest first. Host records, never messages. */
  results?: ScheduleResult[]
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
  /** The session's current native skill catalogue; distinct from legacy slash commands. */
  skills?: SessionSkill[]
  /** The public skill catalogue omitted entries; explicit native lookup still belongs to the current wire. */
  skillsTruncated?: true
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
  /** The running turn takes more text now (`steer` on a prompt). Absent: what is sent meanwhile waits in the queue. */
  steer?: true
  /** The next prompt may start a new context (`freshContext`). Absent: the driver cannot. */
  clearContext?: true
  /**
   * The agent's earlier context is already gone, because a prompt that asked for a new one was refused or did not
   * start: the next prompt starts a new context whether or not it asks.
   */
  contextCleared?: true
}

/**
 * How much a mode lets a harness do without asking the person, strictest first: only reading (`plan`), asking first
 * (`ask`), letting what its own rules allow through (`rule`), leaving the decision to its own model (`model`), or never
 * asking (`never`).
 */
export type PermissionTier = 'plan' | 'ask' | 'rule' | 'model' | 'never'

/** One of a harness's own modes as Latch states it: its tier and one Chinese line on what the harness really does there. */
export interface ModeTier {
  tier: PermissionTier
  line: string
  /** A documented mode whose own name distinguishes it from another mode in the same tier. */
  name?: string
}

export interface SessionPermission {
  level: 'L1' | 'L3'
  enforcer: 'LATCH' | 'NONE'
  readback?: 'mode' | 'none'
  verifiedDefinition?: boolean
  approvals?: 'prompts' | 'none'
  expectedMode?: string
  /** The mode a session of this harness starts in; `expectedMode` follows later changes. */
  defaultMode?: string
  /** Latch's word for each of the harness's own modes it knows; a mode left out shows under the harness's own name. */
  modeTiers?: Record<string, ModeTier>
  drift?: { at: string; observed: string }
  /** Display-only Chinese notes on how far the harness's own permissions go. */
  notes: string[]
}
