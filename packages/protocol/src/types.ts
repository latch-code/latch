import type { AgentPreset } from './agent-presets.ts'
import type { SkillInfo, UiPanelInfo } from './ui.ts'
import type { HostFeatures } from './features.ts'

export type { SkillInfo, UiPanelInfo, UiPanelBlock, UiPanelDocument } from './ui.ts'
export type { HostFeatures, SearchHit, SearchResults, SessionBatchResult } from './features.ts'

export interface SessionCommand {
  name: string
  description?: string
  inputHint?: string
}

/** Browser-safe product state, independent of a particular harness driver. */
export type TaskStatus = 'idle' | 'running' | 'waiting-approval' | 'cancelled' | 'failed' | 'interrupted'
export type TaskMode = 'chat' | 'agent'

/** A model offered by one of the Host's model providers. */
export interface ModelRef {
  providerId: string
  model: string
}
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
  /** Skills snapshotted for the current or latest Standard run. */
  skills?: string[]
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
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
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
  summary: TaskSummary
  messages: Message[]
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

/** Every listener class the Host accepts connections on; tests iterate it, so a class added here meets the locality rules. */
export const LISTENER_CLASSES = ['unix', 'loopback-tcp', 'lan-tls', 'tailnet-tls'] as const
export type ListenerClass = (typeof LISTENER_CLASSES)[number]
export type DeviceScope = 'view' | 'run' | 'approve:standard' | 'approve:elevated' | 'admin' | 'secrets'
export type DataScope = 'work' | 'all'
export type PermissionLevel = 'L0' | 'L1' | 'L2' | 'L3'
export type RiskLevel = 'R0' | 'R1' | 'R2'
export type DeviceStatus = 'active' | 'review' | 'revoked' | 'legacy-pending'

export interface Device {
  /** 'dev_' + 22 base64url chars. */
  id: string
  name: string
  status: DeviceStatus
  /** Where the credential was minted and the only place it is valid. */
  listener: ListenerClass
  scopes: DeviceScope[]
  dataScope: DataScope
  /** 'ABCD EFGH IJKL MNOP QRST'; empty for legacy-pending. */
  fingerprint: string
  createdAt: string
  lastSeenAt: string
  /** Absolute expiry, ISO. */
  credentialExpiresAt: string
  pairedBy: { method: 'lpc' | 'offline' | 'invitation' | 'migration'; deviceId?: string }
  revokedAt?: string
  revokedReason?: 'manual' | 'self' | 'replay' | 'cascade' | 'migration'
}

/** The device making the request, as returned in the snapshot. */
export interface CurrentDevice extends Device {
  current: true
  /** After this time the client must renew (browser) or the shell renews (Electron). */
  renewAfter: string
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

export type PresenceAction =
  | 'device.enroll'
  | 'device.grant'
  | 'task.start-l3'
  | 'task.mode-widen'
  | 'policy.change'
  | 'provider.set-key'
  | 'provider.confirm-origin'
  | 'approval.r2'

/** A full-access session, running or waiting for an answer, that holds back a confirmation (`presence-blocked`). */
export interface BlockingTask {
  id: string
  title: string
  harnessId: string
}

/** A local presence confirmation (Touch ID or login password on the Host computer). */
export interface ConfirmationTicket {
  /** 'cfm_' + 22 base64url chars. */
  id: string
  action: PresenceAction
  /** Fixed Chinese title per action. */
  title: string
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'consumed' | 'error'
  /** 'a1b2-c3d4-e5f6-0718'; no longer shown on the Host computer, which shows `reason` instead. */
  hashDisplay: string
  expiresAt: string
  /** The sentence the macOS system sheet shows (`PresencePreview.reason`). Absent from older Hosts. */
  reason?: string
  /** Its fixed form: a first or changed start opens the card's details at once. Absent from older Hosts. */
  form?: PresenceReasonForm
  /** The details behind the reason, for the card: the preview's lines and warnings. Absent from older Hosts. */
  lines?: Array<{ label: string; value: string }>
  warnings?: string[]
  /** Why an `error` ended it, when the person can do something about it: Touch ID locked after too many tries. */
  failure?: 'biometry-lockout'
}

/**
 * The fixed sentences a confirmation's reason is built from. The wording lives in the Host's `presenceReason` and in
 * the macOS helper, which rebuilds the reason from the subject and refuses any difference.
 */
export type PresenceReasonForm =
  | 'approval.write'
  | 'approval.tool'
  | 'key.save'
  | 'key.origin'
  | 'origin.confirm'
  | 'policy.egress'
  | 'policy.egress-many'
  | 'policy.local'
  | 'policy.remote'
  | 'policy.remote-start'
  | 'policy.remote-agents'
  | 'policy.remote-projects'
  | 'policy.several'
  | 'start.first'
  | 'start.first-custom'
  | 'start.changed'
  | 'start.changed-custom'
  | 'start.project-config'
  | 'start.first-plugin'
  | 'start.changed-plugin'
  | 'start.repeat'
  | 'mode.widen'
  | 'device.enroll'
  | 'device.grant'

/** The Host-derived facts a confirmation names: one fixed form and the text of each of its slots (escaped). */
export interface PresenceSubject {
  form: PresenceReasonForm
  slots: Record<string, string>
}

/**
 * What a local presence confirmation shows. Its canonicalJson's SHA-256 is the previewHash, which the Host and the macOS
 * confirmation helper both compute (the shared security vectors pin it), and which a test presence backend receives.
 */
export interface PresencePreview {
  v: 2
  hostId: string
  action: PresenceAction
  /** Fixed per action. */
  title: string
  /**
   * The one sentence the macOS system sheet shows, the step the person actually verifies: built from `subject` by
   * fixed wording per form, every slot escaped and cut to its own length in grapheme clusters.
   */
  reason: string
  subject: PresenceSubject
  requester: { deviceId?: string; deviceName?: string; listener: ListenerClass | 'cli'; remoteAddress: string }
  /** Values escaped, never truncated; shown in the client's card, not on the Host computer. */
  lines: Array<{ label: string; value: string }>
  warnings: string[]
  nonce: string
  /** ISO, creation + 120 s. */
  expiresAt: string
}

/** A presence backend's state and results, inside the Host; clients only get `presence: { status, message }`. */
export type PresenceAvailability =
  | { status: 'available'; backend: 'macos-helper' | 'test' }
  | { status: 'unavailable'; reason: 'platform' | 'helper-missing' | 'helper-signature' | 'cdhash-mismatch' | 'disabled'; message: string }

export type PresenceOutcome =
  | { result: 'approved'; method: 'biometric' | 'password'; nonce: string; previewHash: string }
  | { result: 'denied' | 'cancelled' | 'timeout'; message?: string }
  | { result: 'error'; message?: string; failure?: 'biometry-lockout' }

export interface EnrollmentInfo {
  hostId: string
  listener: ListenerClass
  presence: { status: 'available' | 'unavailable'; message?: string }
  /** Only on host.sock: no active device holds `admin`. */
  firstDevice?: boolean
  /** True on every listener but host.sock (see `isLocalListener`). */
  invitationRequired: boolean
  /** host.sock only, while at least one unexpired offline ticket exists. */
  offlineCodeAccepted: boolean
  /** loopback-tcp with a valid legacy harness_link cookie. */
  legacy?: { name: string }
}

export interface EnrollmentView {
  /** 'enr_' + 22 base64url chars. */
  id: string
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'completed' | 'cancelled'
  fingerprint: string
  /** Present only in the creation response. */
  nonce?: string
  expiresAt: string
  /** The confirmation's preview hash. The Host computer no longer shows it: the person compares `fingerprint`. */
  hashDisplay?: string
  /** The sentence the Host computer's system sheet shows, which names `fingerprint`. Absent from older Hosts. */
  reason?: string
}

/**
 * A device still waiting to be enrolled, for the desktop's pairing panel (`GET /link/api/enrollments`, desktop admins
 * only). Its fingerprint is the code the person compares: the new device shows it from its own key, and the Host
 * computer's system sheet names it in `reason`.
 */
export interface WaitingEnrollmentView {
  id: string
  /** Chosen by the device itself. */
  name: string
  fingerprint: string
  listener: ListenerClass
  method: 'lpc' | 'offline' | 'invitation'
  /** `pending`: the system sheet is up or about to be; `approved`: the device has yet to sign. */
  status: 'pending' | 'approved'
  expiresAt: string
  /** The invitation it used, so the panel that showed that invitation can find it. */
  invitationId?: string
  reason?: string
}

export interface InvitationView {
  /** 'inv_' + 22 base64url chars. */
  id: string
  /** 'lpi1-' + 26 base32 upper chars; returned once. */
  code: string
  /** `${origin}/link/#pair=${code}`: the TLS public origin, or the loopback origin for a browser on the Host computer. */
  url: string
  scopes: DeviceScope[]
  expiresAt: string
}

export interface HostView {
  hostId: string
  devMode: boolean
  /**
   * `reason` (absent from older Hosts) tells a system without local confirmation (`platform`, or `disabled` in the
   * policy) from a Mac whose confirmation component needs fixing; `message` says how.
   */
  presence: {
    status: 'available' | 'unavailable'
    message?: string
    reason?: Extract<PresenceAvailability, { status: 'unavailable' }>['reason']
  }
  tls: { origin: string } | null
  policy: { localMaxLevel: PermissionLevel; remoteMaxLevel: PermissionLevel; allowL3: boolean }
  /** The Host hands a rejection's note (「告诉 Agent 改做什么」) to the built-in harness; older Hosts drop it. */
  rejectionNote?: true
}

export const SCOPE_LABELS: Record<DeviceScope, string> = {
  view: '查看',
  run: '发起和继续会话',
  'approve:standard': '批准普通操作',
  'approve:elevated': '批准高风险操作',
  admin: '管理此 Host',
  secrets: '设置密钥',
}
/** Loopback is named by its port and never with 本机: a forwarded port delivers remote peers there too. */
export const LISTENER_LABELS: Record<ListenerClass, string> = {
  unix: '本机桌面端',
  'loopback-tcp': '回环端口',
  'lan-tls': '局域网 HTTPS',
  'tailnet-tls': 'Tailscale HTTPS',
}

export type HarnessSource = 'builtin' | 'acp' | 'plugin'
export interface HarnessInfo {
  id: string
  name: string
  description?: string
  source: HarnessSource
  /** `ready` can start sessions; `unavailable` explains why in `statusMessage`. */
  status: 'ready' | 'unavailable'
  statusMessage?: string
  /** Session modes the harness accepts. */
  modes: TaskMode[]
  /** `host`: uses the Host's model providers; `agent`: the agent manages its own models. */
  models: 'host' | 'agent'
  /** L1: builtin, Latch asks per risky call. L3: ACP or plugin harness, unsandboxed. */
  level?: 'L1' | 'L3'
  /**
   * Which folders of a project the harness receives. `all`: every folder (at most `max`); `primary`: the primary folder
   * only; `primary-asks`: the primary folder, and it asks before using others; `primary-unbounded`: the primary folder,
   * and it does not limit which directories it reads. Absent: an older Host, or `primary`.
   */
  projectFolders?: { access: ProjectFolderAccess; max?: number }
}

export type ProjectFolderAccess = 'all' | 'primary' | 'primary-asks' | 'primary-unbounded'

export type ProviderKind = 'openai-compatible' | 'anthropic'
/** Browser-safe provider listing. It never contains credentials. */
export interface ProviderSummary {
  id: string
  name: string
  /** `demo` and `plugin` providers are not editable in settings. */
  kind: ProviderKind | 'demo' | 'plugin'
  models: string[]
  defaultModel: string
}

/** Neutral project glyphs (Lucide names); a project never has a colour. */
export const PROJECT_GLYPHS = [
  'folder',
  'code',
  'globe',
  'server',
  'smartphone',
  'book-open',
  'database',
  'flask-conical',
  'pen-tool',
  'wrench',
] as const
export type ProjectGlyph = (typeof PROJECT_GLYPHS)[number]

/**
 * How a folder was added: the desktop's native picker, a Finder drop it confirmed natively, `pnpm latch project`, or a
 * session's own folder that the desktop saved as a project after a native confirmation.
 */
export type FolderVia = 'picker' | 'drop' | 'cli' | 'session'

export interface WorkspaceFolder {
  /** Stable within the project across reorders and re-selection; never shown. */
  id: string
  /** Realpath. */
  path: string
  /** Chinese reason this folder cannot be used now, e.g. 找不到这个文件夹. */
  unavailable?: string
}

/** A project: a name and 1–8 ordered folders. `id: 'default'` is the Host's start directory (启动目录). */
export interface WorkspaceInfo {
  id: string
  name: string
  /** The primary folder (`folders[0].path`), where new sessions start. */
  path: string
  /** Chinese reason the project cannot start sessions now (the first failing folder); it can still be edited and removed. */
  unavailable?: string
  /** Ordered; `[0]` is the primary folder. Absent from older Hosts. */
  folders?: WorkspaceFolder[]
  glyph?: ProjectGlyph
  /** Other devices may start sessions in this project under the current policy. */
  remoteStart?: boolean
  /** The project lies in Latch's program directory: every Latch 内置 write asks for local approval, and ACP agents cannot start there. */
  codeRoot?: true
}

export interface SessionDefaults {
  harnessId: string
  mode: TaskMode
  workspaceId: string
  model?: ModelRef
}

/**
 * An enabled model service the Host does not offer, and why: its address is not confirmed on the Host computer yet, or
 * it is at a preset provider's address, which always needs a key, and has none.
 */
export interface UnusableProvider {
  id: string
  name: string
  reason: 'origin-unconfirmed' | 'key-missing'
}

/** What a device may choose when it starts a session. */
export interface HostCatalog {
  promptTemplatesVersion?: string
  features?: HostFeatures
  harnesses: HarnessInfo[]
  providers: ProviderSummary[]
  /** Enabled services left out of `providers`, so a page can say why; absent from older Hosts. */
  unusableProviders?: UnusableProvider[]
  /** Session panels contributed by enabled plugins; absent from older Hosts. */
  uiPanels?: UiPanelInfo[]
  /** Enabled Standard skills. Contents remain on the Host. */
  skills?: SkillInfo[]
  workspaces: WorkspaceInfo[]
  defaults: SessionDefaults
  /** Present when the Host supports projects of several folders, added from the desktop only; `max` folders per project. */
  projectFolders?: { max: number }
  /** Agent sessions outside a saved project each get a new folder of their own inside the start directory. */
  sessionFolders?: true
}

export interface AppSnapshot {
  instanceId: string
  revision?: number
  device: CurrentDevice
  host: HostView
  tasks: TaskSummary[]
  approvals: Approval[]
  demo: boolean
  hostName: string
  /** Default harness for new sessions. */
  harness?: { id: string; name: string }
  /** Host-known prerequisites; external drivers own their backend configuration. */
  execution?: { ready: boolean; providerId?: string; modelConfigurationRequired?: boolean }
  catalog?: HostCatalog
  version?: string
  /** The Host's clock when it answered. */
  hostTime?: string
}

export interface ChangeEvent {
  type: 'refresh' | 'tasks-invalidated'
  instanceId: string
  revision: number
  sessionId?: string
}

export interface TaskStateEvent {
  type: 'task-state'
  instanceId: string
  revision: number
  sessionId: string
  detail: TaskDetail
  /** The Host's clock when it sent the event. */
  hostTime?: string
}

/** Why the Host is about to stop answering: restarting, updating, the computer going to sleep, or stopping. */
export type HostStateReason = 'restart' | 'update' | 'sleep' | 'shutdown'
export const HOST_STATE_REASONS: readonly HostStateReason[] = ['restart', 'update', 'sleep', 'shutdown']

/**
 * The Host's own announcement on the event stream. `stopping` and `sleeping` come just before the Host stops answering;
 * clients try again after `retryAfter` seconds instead of their usual backoff. `awake` follows the computer waking up.
 */
export interface HostStateEvent {
  type: 'host-state'
  instanceId: string
  state: 'stopping' | 'sleeping' | 'awake'
  /** With `stopping` and `sleeping` (always `sleep` there). */
  reason?: HostStateReason
  /** Seconds; with `stopping` and `sleeping`. */
  retryAfter?: number
  /** ISO time at which the state began. */
  at: string
}

export type ProviderDestination = 'preset' | 'confirmed' | 'unconfirmed'

/** Owner-only provider configuration as returned to the browser. */
export interface ProviderSettings {
  id: string
  name: string
  kind: ProviderKind
  presetId?: string
  baseURL: string
  hasKey: boolean
  /** `scheme://host:port` the saved key may be sent to; present only with a usable key. */
  keyOrigin?: string
  /** The base URL path the saved key is bound to ('' at the root), with `keyOrigin`; absent from older Hosts. */
  keyPath?: string
  /**
   * Whether the Host sends requests to this address: a preset provider's HTTPS origin, an origin confirmed once on the
   * Host computer, or one not confirmed yet (saved, but never used until it is). Absent from older Hosts.
   */
  destination?: ProviderDestination
  enabled: boolean
  models: string[]
  defaultModel: string
}

/**
 * An ACP agent definition as the Host stores it in settings.json. Host-only: `env` holds values that never leave the
 * Host; browsers receive `AgentSettings` instead.
 */
export interface AgentRecord {
  id: string
  name: string
  presetId?: string
  command: string
  args: string[]
  env: Record<string, string>
  enabled: boolean
  /**
   * The definition's hash when a full-access session last started with it; null once saved and not started since.
   * Absent on definitions saved before the Host recorded starts, which were confirmed when they were saved.
   */
  startedHash?: string | null
}

/**
 * Result of resolving a command on the Host's PATH and install directories; with a preset that names a companion (the
 * agent an adapter connects to), whether that was found too. Older Hosts send no `companion`.
 */
export interface CommandDetection {
  found: boolean
  path?: string
  companion?: { command: string; found: boolean }
}

/** A preset as the agent settings list it: with what the Host found of its commands. Older Hosts send no `detected`. */
export interface AgentPresetSettings extends AgentPreset {
  detected?: CommandDetection
}

/** Owner-only ACP agent definition as returned to the browser. Env values are never returned. */
export interface AgentSettings {
  id: string
  name: string
  presetId?: string
  command: string
  args: string[]
  envKeys: string[]
  enabled: boolean
  detected: CommandDetection
  /** Matches a preset's command and arguments exactly. */
  verified: boolean
  /** Chinese reason the definition cannot run, e.g. a reserved env name. */
  problem?: string
  /**
   * False until a full-access session has started with this exact definition (saving it asks for no confirmation; that
   * first start does). Absent on older Hosts and for definitions saved before the Host recorded starts.
   */
  started?: boolean
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  activeRuns: number
  capabilities: string[]
  package?: { formatVersion: 1 }
  /** Set when the Host manages the plugin from settings (model providers, agents). */
  managed?: 'provider' | 'agent' | 'core'
}

export interface ApiFailure {
  error: string
  message: string
  required?: DeviceScope
  allowed?: PermissionLevel[]
  confirmation?: ConfirmationTicket
  stepup?: { where: 'this-device' | 'host-desktop' }
  retryAfter?: number
  target?: string
  legacyName?: string
  /** A model service's own HTTP status, when a listing or check failed there (`http-error`). */
  upstreamStatus?: number
  /** The system's code for a failed connection to a model service (`network-error`), such as `ECONNREFUSED`. */
  networkCode?: string
  /** `presence-blocked`: the confirmation that was asked for. */
  action?: PresenceAction
  /** `presence-blocked`: the sessions holding it back, only for a requester that may view sessions. Older Hosts omit both. */
  blockingTasks?: BlockingTask[]
}
