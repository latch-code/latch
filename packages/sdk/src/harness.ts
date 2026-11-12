import type { Bridge, ModelRoute, ProjectFolder } from './bridge.ts'
import type { AttachmentContent, RuntimeRegistry } from './plugins.ts'
import type {
  AttachmentRef,
  FileChange,
  HarnessCapabilities,
  HarnessInfo,
  ModelRef,
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
  /** `subagent-wider`: a subagent asked for more than the session's own permission mode lets it. */
  | { type: 'approval-auto-rejected'; sessionId: string; reason: 'persistent-only' | 'unknown-kind' | 'subagent-wider' }
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
  /** False once the token stops working: closed, or the service's settings changed since it was issued. */
  active(): boolean
  /** Revokes the token. Idempotent. */
  close(): void
}

export interface ModelGateway {
  /** A token bound to the session and the route's service and models; throws when the service cannot be used now. */
  open(input: { sessionId: string; route: ModelRoute }): ModelGatewayLease
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
  /**
   * A session whose context has `proposals` (one of 我的 Agent's, or a conversation with 通用): its agent proposed a
   * memory. The Host keeps it pending for the person and never saves it by itself; it finds the owner from its own
   * records of `sessionId`. Rejects with the reason when it is refused (a secret, too long, too many).
   */
  proposeMemory?(input: MemoryProposalInput): Promise<void>
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
  status?(): { status: HarnessInfo['status']; statusMessage?: string }
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
