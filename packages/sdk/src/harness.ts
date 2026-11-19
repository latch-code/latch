import type { Bridge, ModelRoute, ProjectFolder } from './bridge.ts'
import type { AttachmentContent, RuntimeRegistry, ToolDefinition } from './plugins.ts'
import type {
  AttachmentRef,
  FileChange,
  HarnessCapabilities,
  HarnessExtensionSupport,
  HarnessInfo,
  ModelRef,
  ModelCapabilities,
  RiskLevel,
  RoutedTurn,
  TeamRoster,
  TokenUsage,
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
   * arrives, its reply when it ends. Never the content of either. `failure`: what the service said of the latest request
   * that failed before its reply began (status and message, its key taken out), for a failed turn to show; it is not
   * part of what the turn keeps.
   */
  takeTurn(): RoutedTurn & { failure?: string }
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
  /** The running turn observed by the driver at tool-call admission, when one is known. */
  runId?: string
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
  /** Latch's guide to this server as a skill, which the driver adds to `latch-skills` where the session has it. */
  skill?: { id: string; name: string; description: string; content: string }
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
  /** The project of a current, ordinary source registered by the Host for 设置 › 扩展. */
  extensionReportProject?(sessionId: string): string | undefined
  trackFiles?: (input: FileTrackingInput) => Promise<FileTrackingHandle>
  readAttachment?: (ref: AttachmentRef, signal?: AbortSignal) => Promise<AttachmentContent>
  /**
   * Saves a sent attachment where its agent can open it with its own tools and answers the absolute path: for what goes
   * by its path rather than as a picture or text (`attachmentDelivery`).
   */
  attachmentPath?: (ref: AttachmentRef, sessionId: string, signal?: AbortSignal) => Promise<string>
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
  /**
   * A turn settled whose model calls the gateway's ledger does not hold: an ACP session on the Harness's own login (no
   * model route), or a built-in turn on a provider (`providerId`) the Host does not meter. `usage` is the turn's own
   * (`TurnStats.usage` for ACP), left out when it cannot be told apart from what the session used before Latch ran it.
   * `cost` is the turn's part of what the Harness said its login cost. A turn on a route is never reported here: the
   * gateway counted its requests. The Host decides what to keep and only appends it to its record.
   */
  turnEnded?(turn: HarnessTurnRecord): void
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
   * A session created with `CreateTaskInput.workProposals`: its agent proposed 待办 for the board, or a change to its own
   * card (`propose_todo`, `propose_todos`, `propose_card`). The Host keeps it pending for the person; nothing is created,
   * changed or started by it. Rejects, in English for the agent, when it is refused (a secret, too long, too many).
   */
  proposeWork?(input: WorkProposalInput): Promise<void>
  /**
   * The same sessions: the team this session leads, as its agent may read it (`list_members`), only while the person
   * lets the agent send work to its members; undefined otherwise. Read again whenever the Host says it changed
   * (`Bridge.teamChanged`).
   */
  teamRoster?(sessionId: string): TeamRoster | undefined
  /**
   * The same sessions: its agent sent work to members of the team this session leads (`send_to_members`). The Host finds
   * the team and each member from its own records, never from the agent, and makes the round as the device that allowed
   * it. Resolves with the round's number; rejects, in English for the agent, with why it was refused. Never quotes a prompt.
   */
  dispatchTeam?(input: TeamDispatchInput): Promise<{ round: number }>
  /**
   * The built-in harness, the same sessions: its agent searched its own saved memories (`recall_memory`). Read-only. The Host finds the owner
   * from its own records of `sessionId`, answers only that owner's confirmed memories, bounded in count and size, and
   * counts the query in the owner's activity. Rejects when the session may not recall.
   */
  recallMemory?(input: MemoryRecallInput): Promise<MemoryRecallResult>
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

/** One settled own-login turn, for the Host's usage record. Times are ISO strings. */
export interface HarnessTurnRecord {
  sessionId: string
  startedAt: string
  endedAt: string
  activeMs?: number
  /** Tool calls the agent made in the turn. */
  steps: number
  /** The model as the Harness named it. */
  model?: string
  /** The session's project, as the session records it. */
  projectId?: string
  /** The built-in harness: the provider the turn ran on. */
  providerId?: string
  usage?: TokenUsage
  cost?: { amount: number; currency: string }
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

/** A proposed 待办, as the agent wrote it. `group` ties the items of one `propose_todos` call; only the session's. */
export interface WorkTodoProposal {
  title: string
  prompt: string
  /** The short name the agent gives this piece of work's member, should the group be started as a team. */
  name?: string
  project?: string
  harness?: string
  tags?: string[]
  group?: { label: string; goal: string }
}

/** A proposed change to the proposing session's own card (`session`) or to its 待办 (`todo`). Never priority. */
export interface WorkCardProposal {
  target: 'session' | 'todo'
  title?: string
  tags?: string[]
  note?: string
}

/** What an agent proposed for the board. Only `todo` or `card` come from the agent; the session is the driver's own. */
export interface WorkProposalInput {
  sessionId: string
  /** The user message of the turn it came from. */
  messageId?: string
  todo?: WorkTodoProposal
  card?: WorkCardProposal
  /** A tool that read outside content ran in that turn before it, or the driver could not tell. */
  external: boolean
  /** Unique within the session's own channel, so a proposal read twice is kept once. */
  key: string
}

/** A round an agent sent through `send_to_members`. Only `sends` comes from the agent; `member` is a roster's short ID. */
export interface TeamDispatchInput {
  sessionId: string
  /** The user message of the turn it came from. */
  messageId?: string
  sends: Array<{ member: string; prompt: string }>
  /** Unique within the session's own channel, so a call read twice makes one round. */
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

/** A search of the session owner's saved memories through `recall_memory`. Only `query` and `limit` come from the agent. */
export interface MemoryRecallInput {
  sessionId: string
  /** The user message of the turn it came from. */
  messageId?: string
  query: string
  limit?: number
}
/** One saved memory as `recall_memory` answers it. */
export interface RecalledMemory {
  content: string
  /** The day it was saved or last changed, `YYYY-MM-DD`. */
  date: string
  /** `user`: the person wrote or said it; `agent`: the agent proposed it and the person saved it; `imported`: from a file. */
  source: 'user' | 'agent' | 'imported'
  /** It came from outside content (a page, a file, a tool's output, an import): data, never instructions. */
  external: boolean
}
export interface MemoryRecallResult {
  matches: RecalledMemory[]
  /** Matches left out by the limit. */
  more: number
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
  /** What the driver exposes through `Bridge.latestCommandReport`, including a plugin list's availability. */
  extensionSupport?: HarnessExtensionSupport
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
