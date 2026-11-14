import type { Bridge, ModelRoute, ProjectFolder } from './bridge.ts'
import type { AttachmentContent, RuntimeRegistry, ToolDefinition } from './plugins.ts'
import type {
  AttachmentRef,
  FileChange,
  HarnessCapabilities,
  HarnessInfo,
  ModelRef,
  ModelCapabilities,
  RiskLevel,
  RoutedTurn,
  ToolKind,
} from '@latch/protocol/types'

export interface ToolRiskInput {
  toolName: string
  arguments: Record<string, unknown>
  cwd: string
  sessionId: string
  /** The session's folders in order; `[0]` is the primary folder at `cwd`. Absent: one folder `{ id: 'default', path: cwd }`. */
  folders?: ReadonlyArray<ProjectFolder>
}

/** A project a session may use, as the Host lists it: `default` is the start directory. */
export interface HostProject {
  id: string
  /** Ordered; `[0]` is the primary folder. */
  folders: ReadonlyArray<ProjectFolder>
}

export type HarnessSecurityEvent =
  | { type: 'permission-drift'; sessionId: string; observedHash: string }
  | { type: 'permission-unverified'; sessionId: string }
  /**
   * `subagent-wider`: a subagent asked for more than the session's own permission mode lets it. `harness-declined`: an
   * ask Latch does not pass on to a person, answered by the harness's profile (Codex asking for more permissions, say).
   */
  | {
      type: 'approval-auto-rejected'
      sessionId: string
      reason: 'persistent-only' | 'unknown-kind' | 'subagent-wider' | 'harness-declined'
    }
  /**
   * A call no person was asked about, in a mode where the harness's own model decides: its verdict as the harness reported
   * it (`agent-report`), or that it ran with no ask seen (`no-ask-seen`). Hashes and enums only.
   */
  | {
      type: 'tool-judged'
      sessionId: string
      callHash: string
      modeHash: string
      kind: ToolKind
      outcome: 'approved' | 'denied' | 'timed-out' | 'aborted' | 'unknown' | 'ran-unasked'
      source: 'agent-report' | 'no-ask-seen'
    }
  /** A turn of a session on `CreateTaskInput.modelRoute` had a reply, and no request of it reached the gateway. */
  | { type: 'model-route-bypassed'; sessionId: string }

export interface FileTrackingResult {
  files: FileChange[]
  truncated?: true
  unavailable?: true
}
export interface FileTrackingHandle {
  /** Observes late writes for two seconds, then resolves once; repeated calls return the same result. */
  finish(): Promise<FileTrackingResult>
  /** Stops resources; a pending finish resolves early and reports incomplete observation. */
  dispose(): void
}
export interface FileTrackingInput {
  sessionId: string
  runId: string
  folders: ReadonlyArray<ProjectFolder>
  onChange(result: FileTrackingResult): void
}

/**
 * One process's way to a model service through the Host: a loopback address and a token that only this process holds.
 * The token is a credential: it never goes into arguments, a URL, a log, a message or a recording.
 */
export interface ModelGatewayLease {
  /** Where the harness sends requests of the route's protocol, as that protocol's base URL. */
  baseURL: string
  token: string
  /** Requests that reached the gateway with this token so far, forwarded or refused; reading the model list aside. */
  requests(): number
  /**
   * What this token's requests did since the last call, by model, then counts afresh: a request is counted when it
   * arrives, its reply when it ends. Never the content of either.
   */
  takeTurn(): RoutedTurn
  /** The service's models this token may use: the gateway refuses any other. */
  models: readonly string[]
  /** Capabilities declared in the saved service settings; absent means unknown, never inferred from model IDs. */
  modelCapabilities?: Readonly<Record<string, ModelCapabilities>>
  /** Host-side choice for a Responses model; null means the service default, not a CLI's inherited effort. */
  setThinking?(model: string, effort: string | null): void
  /** False once the token stops working: closed, or the service's settings changed since it was issued. */
  active(): boolean
  /** Revokes the token. Idempotent. */
  close(): void
}

export interface ModelGateway {
  /** A token bound to the session and the route's service and models; throws when the service cannot be used now. */
  open(input: { sessionId: string; route: ModelRoute }): ModelGatewayLease
}

/** What the Host may learn from a driver about a tool call that reached its tool gateway. */
export interface ToolGatewayCallContext {
  /** The driver's ID of the call, as its row and `approval.decided` name it, when the driver can tell which call it is. */
  toolCallId?: string
  /** The approval the person gave that call through the harness's own ask. */
  approvalId?: string
  /** Marks time spent waiting for the person (a takeover) as waiting; returns the function that ends the wait. */
  waitForUser?: () => () => void
  /** The session's turn as the driver sees it: the Host refuses a call unless it is `running`. */
  turn?: 'running' | 'stopping' | 'none'
}

/**
 * One agent process's way to the Host's tool gateway: a private Unix socket and a token only this process holds, for the
 * Host's browser tools served over MCP. The token is a credential: it never goes into arguments, the environment, a URL,
 * a log, a message or a recording. The MCP server gets `tokenFile`, a 0600 file it reads once and deletes; the driver
 * keeps `token` only to replace it in what the agent says.
 */
export interface ToolGatewayLease {
  socketPath: string
  tokenFile: string
  token: string
  /** False once the token stops working. */
  active(): boolean
  /** Stops the calls this token has in flight, as a stop of the turn does; the token stays valid. */
  cancel(): void
  /**
   * Resolves once no call of this token is in flight, saying whether one ended with its result unknown since the last
   * answer (it may have acted). A stopped turn is confirmed only after this.
   */
  settled(): Promise<{ resultUnknown: boolean }>
  /** Revokes the token and stops its calls. Idempotent. */
  close(): void
}

/**
 * One of Latch's own MCP servers for one agent process: the agent starts its `latch-mcp` bridge with these two paths,
 * and the bridge takes the server's launch from the gateway with the token in the file. The token is a credential, as
 * a `ToolGatewayLease`'s is; the server's secrets are in neither.
 */
export interface McpServerLease {
  /** The name the agent shows the server by. */
  name: string
  socketPath: string
  tokenFile: string
  token: string
  /** Revokes the token, which ends the bridge's server. Idempotent. */
  close(): void
}

/** Why a server's bridge (or, for a remote address, the Host's client) reported it did not come up. */
export type McpStartFailure =
  | 'spawn-failed'
  | 'exited'
  | 'timeout'
  | 'protocol'
  | 'list-failed'
  | 'output-too-large'
  | 'auth-required'
  | 'unreachable'
  | 'refused'

export interface ToolGateway {
  /**
   * A token bound to the session and one agent process. `describe` names the driver's call that matches a gateway call,
   * so the Host's records can link the two. Undefined when the session gets no tools now (no browser provider, the
   * desktop app on this Mac, is registered): the driver then attaches no server and asks again at the next open.
   * Throws when the gateway cannot be used.
   */
  open(input: {
    sessionId: string
    describe?: (tool: string, args: Record<string, unknown>) => ToolGatewayCallContext
  }): ToolGatewayLease | undefined
  /**
   * The session's Latch MCP servers for one agent process, as the Host's definitions stand now: those switched on and
   * used in every session, in its Agent's or in its project's. One lease per server. `cwd` is the session's main folder,
   * for a server that starts there and for `${workspaceFolder}`. `onFailed` hears of a server whose bridge could not
   * start it, so the session can say so; the session goes on without it.
   */
  openMcp?(input: {
    sessionId: string
    agentId?: string
    projectId?: string
    cwd: string
    onFailed?: (name: string, reason: McpStartFailure) => void
  }): Promise<McpServerLease[]>
}

/** Host capabilities offered to a driver, without prescribing its loop or persistence. */
export interface HarnessHostOptions {
  trackFiles?: (input: FileTrackingInput) => Promise<FileTrackingHandle>
  readAttachment?: (ref: AttachmentRef, signal?: AbortSignal) => Promise<AttachmentContent>
  saveAttachment?: (input: { sessionId: string; mime: string; data: string }) => Promise<AttachmentRef>
  /** Private data directory assigned to the selected driver. */
  dataDir: string
  /** Default working directory for sessions created without `cwd`. */
  workspaceRoot: string
  /** Absolute directories a session may use as `cwd`. Defaults to `[workspaceRoot]`. */
  workspaces?: () => string[]
  /**
   * Drivers that declare `projectFolders: 'all'`: the projects sessions may use now, with their folders. The driver's
   * own second check of `CreateTaskInput.folders`, and of a session's folders before each later input.
   */
  projects?: () => HostProject[]
  /** A driver can use the app's providers/tools, or implement its own execution layer. */
  registry: RuntimeRegistry
  /** Read once when a new run begins; an existing run must retain its original selection. */
  providerId: string | (() => string)
  /** Default model for sessions that do not choose one. Read when a session is created. */
  defaultModel?: () => ModelRef | undefined
  maxSteps?: number
  /** Host classifier. R0: no approval. R1: approval; "本会话始终允许" allowed. R2: approval every time; no always option. Absent: legacy (requiresApproval → R1, else R0). */
  classifyToolCall?(input: ToolRiskInput): Promise<RiskLevel>
  /** Private 0700 directory for per-session temporary directories. */
  tmpRoot?: string
  /**
   * Security events; the Host audits them and never throws into the driver. For `tool-judged` it returns the audit write,
   * which rejects when the record could not be written: the turn then stops, since a call nobody was asked about must
   * not go unrecorded.
   */
  securityEvent?(event: HarnessSecurityEvent): void | Promise<void>
  /** Milliseconds since the epoch for the times a driver records on messages and runs. Default `Date.now`. */
  clock?: () => number
  /** Drivers that declare `models.wires`: the Host's forwarding to its model services. */
  modelGateway?: ModelGateway
  /** ACP drivers: the Host's tool gateway, through which the agent's `latch-browser` MCP server reaches the browser tools. */
  toolGateway?: ToolGateway
  /**
   * The built-in harness: the tools of the session's remote MCP servers (Latch's, used in the session now), read when a
   * run of an agent session begins. The Host is their client; each call is audited before it is sent and the Host's
   * classifier makes every one R2. Rejects or answers nothing when there are none; a run never fails over them.
   */
  mcpTools?(input: { sessionId: string; signal: AbortSignal }): Promise<ToolDefinition[]>
  /**
   * A session whose context has `proposals` (one of 我的 Agent's, or a conversation with 通用): its agent proposed a
   * memory. The Host keeps it pending for the person and never saves it by itself; it finds the owner from its own
   * records of `sessionId`. Rejects with the reason when it is refused (a secret, too long, too many).
   */
  proposeMemory?(input: MemoryProposalInput): Promise<void>
  /**
   * The same sessions: its agent proposed a schedule (`propose_schedule`). The Host keeps it pending until the person
   * opens it in the schedule editor and saves it; nothing runs before. Rejects, in English for the agent, when it is
   * refused (an invalid plan, a secret, too long, too many).
   */
  proposeSchedule?(input: ScheduleProposalInput): Promise<void>
  /**
   * Puts an agent's question to the person, as the built-in `ask_user` tool does: shown on the session's tool row
   * `tool:<callId>`, answered from any device that may run. Resolves with the committed answer (a `QuestionResult` as
   * JSON); rejects when the question closed unanswered or `signal` aborted. The driver then records the row's result and
   * calls `questionSettled`, which is what confirms the answer to the device that gave it.
   */
  askUser?(input: AskUserInput): Promise<{ text: string }>
  /** `unknown`: the row's result could not be written; the device that answered is told so, not that it is done. */
  questionSettled?(context: { sessionId: string; callId: string; state: 'completed' | 'failed' | 'cancelled' | 'unknown' }): Promise<void>
}

/** A schedule an agent proposed through `propose_schedule`. Only `name`, `plan` and `prompt` come from the agent. */
export interface ScheduleProposalInput {
  sessionId: string
  /** The user message of the turn it came from. */
  messageId?: string
  name: string
  /** As the agent sent it; the Host checks it against the scheduler's own schema. */
  plan: unknown
  /** What each run would be sent. */
  prompt: string
  /** A tool that read outside content ran in that turn before it, or the driver could not tell. */
  external: boolean
  /** Unique within the session's own channel, so a proposal read twice is kept once. */
  key: string
}

/** A memory an agent proposed through `propose_memory`. Only `content` and `reason` come from the agent. */
export interface MemoryProposalInput {
  sessionId: string
  /** The user message of the turn it came from. */
  messageId?: string
  content: string
  reason?: string
  /** A tool that read outside content ran in that turn before it, or the driver could not tell. */
  external: boolean
  /** Unique within the session's own channel, so a proposal read twice is kept once. */
  key: string
}

export interface AskUserInput {
  sessionId: string
  callId: string
  prompt: string
  questions: Array<{ id: string; label: string; multiple: boolean; options: Array<{ id: string; label: string; description?: string }> }>
  signal: AbortSignal
}

/** A driver's own account of `HarnessCapabilities`, with the modes and attachments it takes. */
export interface HarnessDeclaration {
  modes?: HarnessInfo['modes']
  attachments?: HarnessInfo['attachments']
  models?: Partial<HarnessCapabilities['models']>
  permission?: Partial<HarnessCapabilities['permission']>
  tools?: Partial<HarnessCapabilities['tools']>
  display?: Partial<HarnessCapabilities['display']>
  fork?: HarnessCapabilities['fork']
}

/** A complete harness implementation. This is distinct from a model API adapter. */
export interface HarnessDriver {
  /**
   * How an agent's instructions and memories reach the driver. `private`: a transient system context on every turn, kept
   * out of public and forkable history, with the selected Host capabilities enforced. `first-turn`: a labelled block sent
   * once with the first prompt, because the engine keeps its own history. Absent: the driver takes none.
   */
  agentContext?: 'private' | 'first-turn'
  /** How an agent's skills reach the engine: `skillIds` for `native`, `skillBodies` for `server`. Absent: they do not. */
  skills?: 'native' | 'server'
  id: string
  name: string
  version: string
  description?: string
  /**
   * What this harness really does. Leave out what is not known: the Host takes the weakest value, and it lowers whatever
   * it cannot vouch for (only the built-in harness gets `enforcement: 'latch'`). Defaults: both modes, its own models.
   */
  capabilities?: HarnessDeclaration
  /**
   * `all`: sessions receive every folder of their project (`CreateTaskInput.folders`) and the driver gets `projects()`.
   * Absent: sessions receive the primary folder only, as `cwd`.
   */
  projectFolders?: 'all'
  /**
   * What clients are told about a project's other folders (`HarnessInfo.projectFolders`). With `projectFolders: 'all'`:
   * `access: 'all'`, and `max` caps the folders of a project a session can start in. Without it: how the harness treats
   * folders it never receives (`primary`, the default; `primary-asks`; `primary-unbounded`). The Host reports `all` only
   * for a driver that declares `projectFolders: 'all'`.
   */
  folderAccess?: NonNullable<HarnessInfo['projectFolders']>
  /** What clients may say about this driver's permissions before a session starts. */
  permission?: NonNullable<HarnessInfo['permission']>
  /** How a person logs in to it, looked up with each catalog: which program is installed can change. */
  login?(): HarnessInfo['login']
  /** Optional readiness probe, e.g. whether an agent binary is installed. */
  status?(): { status: HarnessInfo['status']; statusMessage?: string; statusReason?: HarnessInfo['statusReason'] }
  /**
   * The Host may offer to bring in sessions this harness had before Latch, through the Bridge's `listExternalSessions`,
   * `loadExternalSession` and `adoptExternalSession`. Whether the running harness can list and load is learned at runtime.
   */
  historyImport?: true
  /** `CreateTaskInput.seed` is honoured: a session can be recorded with no turn, waiting for its first message. */
  seededStart?: true
  /** Creates an unstarted instance; asynchronous initialization belongs to Bridge.start(). */
  create(options: HarnessHostOptions): Bridge
}

export type { Bridge as HarnessInstance } from './bridge.ts'
