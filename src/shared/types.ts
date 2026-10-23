/** Browser-safe product state, independent of a particular harness driver. */
export type TaskStatus = 'idle' | 'running' | 'waiting-approval' | 'cancelled' | 'failed' | 'interrupted'
export type TaskMode = 'chat' | 'agent'

/** A model offered by one of the Host's model providers. */
export interface ModelRef {
  providerId: string
  model: string
}
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface TaskSummary {
  id: string
  title: string
  status: TaskStatus
  updatedAt: string
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
  /** Optional live projection; external HarnessDrivers may omit it. */
  activity?: { phase: 'model' | 'tool' | 'approval' | 'cancelling'; toolName?: string }
  /** Retained as the assistant message ID when this streamed reply settles. */
  liveMessageId?: string
  /** Reasoning streamed for the live reply; settles into `Message.reasoning`. */
  liveReasoning?: string
  /** Latest plan reported by the harness. */
  plan?: PlanEntry[]
  /** Options the harness lets the user change for this session. */
  config?: SessionConfigOption[]
  /** Transport version within one Host lifetime, not a durable replay cursor. */
  sync?: { instanceId: string; revision: number }
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
}

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

export interface WorkspaceInfo {
  id: string
  name: string
  path: string
  /** Chinese reason this saved workspace cannot be used on this run; it can still be removed. */
  unavailable?: string
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

/** Owner-only ACP agent definition as returned to the browser. Env values are never returned. */
export interface AgentSettings {
  id: string
  name: string
  presetId?: string
  command: string
  args: string[]
  envKeys: string[]
  enabled: boolean
  /** Result of resolving `command` on the Host's PATH. */
  detected: { found: boolean; path?: string }
  /** Matches a preset's command and arguments exactly. */
  verified: boolean
  /** Chinese reason the definition cannot run, e.g. a reserved env name. */
  problem?: string
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
