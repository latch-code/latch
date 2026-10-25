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
}

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other'
export interface FileDiff {
  path: string
  oldText?: string
  newText: string
  /** Whether the file existed before: `none` is a new file; `unavailable` means it existed but its text is not shown (too large or binary). */
  previous?: 'none' | 'text' | 'unavailable'
}

/** Structured presentation of one tool call. `Message.text` keeps the plain-text form. */
export interface ToolDetail {
  kind?: ToolKind
  /** Short human summary, for example "读取 src/app.ts". */
  title?: string
  /** Formatted call arguments. */
  input?: string
  /** Result text, when the call produced one. */
  output?: string
  locations?: string[]
  diffs?: FileDiff[]
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

export type ListenerClass = 'unix' | 'loopback-tcp' | 'lan-tls' | 'tailnet-tls'
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
  | 'agent.define'
  | 'policy.change'
  | 'provider.set-key'
  | 'approval.r2'

/** A local presence confirmation (Touch ID or login password on the Host computer). */
export interface ConfirmationTicket {
  /** 'cfm_' + 22 base64url chars. */
  id: string
  action: PresenceAction
  /** Fixed Chinese title per action. */
  title: string
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'consumed' | 'error'
  /** 'a1b2-c3d4-e5f6-0718' */
  hashDisplay: string
  expiresAt: string
}

/**
 * What a local presence confirmation shows. Its canonicalJson's SHA-256 is the previewHash, which the Host and the macOS
 * confirmation helper both compute (the shared security vectors pin it), and which a test presence backend receives.
 */
export interface PresencePreview {
  v: 1
  hostId: string
  action: PresenceAction
  /** Fixed per action. */
  title: string
  requester: { deviceId?: string; deviceName?: string; listener: ListenerClass | 'cli'; remoteAddress: string }
  /** Values escaped, never truncated. */
  lines: Array<{ label: string; value: string }>
  warnings: string[]
  nonce: string
  /** ISO, creation + 60 s. */
  expiresAt: string
}

/** A presence backend's state and results, inside the Host; clients only get `presence: { status, message }`. */
export type PresenceAvailability =
  | { status: 'available'; backend: 'macos-helper' | 'test' }
  | { status: 'unavailable'; reason: 'platform' | 'helper-missing' | 'helper-signature' | 'cdhash-mismatch' | 'disabled'; message: string }

export type PresenceOutcome =
  | { result: 'approved'; method: 'biometric' | 'password'; nonce: string; previewHash: string }
  | { result: 'denied' | 'cancelled' | 'timeout' | 'error'; message?: string }

export interface EnrollmentInfo {
  hostId: string
  listener: ListenerClass
  presence: { status: 'available' | 'unavailable'; message?: string }
  /** Only on unix and loopback-tcp: no active device holds `admin`. */
  firstDevice?: boolean
  /** True on TLS listeners. */
  invitationRequired: boolean
  /** unix/loopback-tcp and at least one unexpired offline ticket exists. */
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
  /** The preview hash shown in the Host's confirmation window. */
  hashDisplay?: string
}

export interface InvitationView {
  /** 'inv_' + 22 base64url chars. */
  id: string
  /** 'lpi1-' + 26 base32 upper chars; returned once. */
  code: string
  /** `${tlsOrigin}/link/#pair=${code}` */
  url: string
  scopes: DeviceScope[]
  expiresAt: string
}

export interface HostView {
  hostId: string
  devMode: boolean
  presence: { status: 'available' | 'unavailable'; message?: string }
  tls: { origin: string } | null
  policy: { localMaxLevel: PermissionLevel; remoteMaxLevel: PermissionLevel; allowL3: boolean }
}

export const SCOPE_LABELS: Record<DeviceScope, string> = {
  view: '查看',
  run: '发起和继续会话',
  'approve:standard': '批准普通操作',
  'approve:elevated': '批准高风险操作',
  admin: '管理此 Host',
  secrets: '设置密钥',
}
export const LISTENER_LABELS: Record<ListenerClass, string> = {
  unix: '本机桌面端',
  'loopback-tcp': '本机浏览器',
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

/** What a device may choose when it starts a session. */
export interface HostCatalog {
  harnesses: HarnessInfo[]
  providers: ProviderSummary[]
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
  /**
   * Result of resolving `command` on the Host's PATH and install directories; with a preset that names a companion
   * (the agent an adapter connects to), whether that was found too. Older Hosts send no `companion`.
   */
  detected: { found: boolean; path?: string; companion?: { command: string; found: boolean } }
  /** Matches a preset's command and arguments exactly. */
  verified: boolean
  /** Chinese reason the definition cannot run, e.g. a reserved env name. */
  problem?: string
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  activeRuns: number
  capabilities: string[]
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
}
