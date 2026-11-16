/** Every listener class the Host accepts connections on; tests iterate it, so a class added here meets the locality rules. */
export const LISTENER_CLASSES = ['unix', 'loopback-tcp', 'lan-tls', 'tailnet-tls', 'native-direct', 'native-relay'] as const
export type ListenerClass = (typeof LISTENER_CLASSES)[number]
export type DeviceScope = 'view' | 'run' | 'approve:standard' | 'approve:elevated' | 'admin' | 'secrets'
/**
 * What a device may read beyond the conversation: `work` only files a session mentioned, without diff bodies; `files`
 * also the files and changes of the sessions' project folders; `all` also private sessions and agents, the terminal and
 * other CLIs' sessions.
 */
export type DataScope = 'work' | 'files' | 'all'
export const DATA_SCOPES = ['work', 'files', 'all'] as const satisfies readonly DataScope[]

/** The scope as the Mac's confirmation of a new device or a wider one names it. */
export const DATA_SCOPE_LABELS: Readonly<Record<DataScope, string>> = { work: '工作', files: '会话与项目的文件', all: '全部' }

/** Whether a device with this scope reads the files and changes of the sessions' project folders. */
export function readsProjectFiles(scope: DataScope | undefined): boolean {
  return scope === 'files' || scope === 'all'
}

/** Whether `next` lets a device read more than `current` does. */
export function widensDataScope(current: DataScope, next: DataScope): boolean {
  return DATA_SCOPES.indexOf(next) > DATA_SCOPES.indexOf(current)
}
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
  native?: {
    lastVerifiedAt: string
    input: 'ready' | 'verification-required' | 'review' | 'revoked'
    bodyVerifiedUntil?: string
  }
}

export interface NativeLinkInfo {
  version: 1
  /** Phones can reach this Mac: its LAN listener is open, or a relay is configured. */
  enabled: boolean
  /** The Host's start options fix the LAN listener; it does not follow the phone-access lifecycle. */
  directManaged: boolean
  listening: { host: string; port: number } | null
  /** A saved address directory is in use. */
  directory: boolean
  /** Local administrators can retry or abandon a reserved addition; its private profile never comes back. */
  pendingRelay?: { requestId: string; url: string; canRetry: boolean }
  relays: Array<{ relayId: string; url: string; status: 'connecting' | 'connected' | 'waiting' | 'attention'; retryAt?: number }>
}
/** The local relay CLI exports this to a private file. The Host never sends it back to any client. */
export interface NativeRelayProfile {
  relayId: string
  url: string
  spkiHash: string
  registrationKey?: string
}
/** One QR on the Mac's pairing sheet. Its payload is the secret: the sheet renders it and closes it, nothing else. */
export interface NativePairingInvitation {
  id: string
  payload: string
  expiresAt: string
}
/**
 * What the sheet shows for one of its QRs (`GET /link/api/native/pairings/:id`). `device` is the phone's own word for
 * itself; `offNetwork` says a device on another network tried this QR and was refused.
 */
export interface NativePairingStatus {
  state: 'ready' | 'confirming' | 'approved' | 'done' | 'cancelled' | 'timeout' | 'contended' | 'expired'
  device?: string
  /** `done`: the device the sheet asks about, to remove if the phone in hand is not connected. */
  deviceId?: string
  offNetwork: boolean
}

/** The device making the request, as returned in the snapshot. */
export interface CurrentDevice extends Device {
  current: true
  /** After this time the client must renew (browser) or the shell renews (Electron). */
  renewAfter: string
}

export type PresenceAction =
  | 'plugin.package.apply'
  | 'device.enroll'
  | 'device.enroll-native'
  | 'device.grant'
  | 'policy.change'
  | 'provider.confirm-origin'
  | 'mcp.server.apply'
  | 'harness.command.apply'

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
  /** Its fixed form. Absent from older Hosts. */
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
  | 'device.enroll-named'
  | 'device.enroll-native'
  | 'device.grant'
  | 'origin.confirm'
  | 'policy.egress-many'
  | 'policy.several'
  | 'plugin.package.apply'
  | 'plugin.package.apply-pages'
  | 'mcp.server.apply'
  | 'mcp.server.apply-runner'
  | 'mcp.server.apply-remote'
  | 'harness.command.apply'

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
  /** Only on host.sock: this computer's name, which the desktop app takes as its own. */
  hostName?: string
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
  /** The confirmation's preview hash. The Host computer no longer shows it. */
  hashDisplay?: string
  /** The sentence the Host computer's system sheet shows, which names the device. Absent from older Hosts. */
  reason?: string
  /** `cancelled` because another device presented a QR of the same pairing sheet. */
  contended?: true
  /** What the device will hold once confirmed. Absent from older Hosts. */
  scopes?: DeviceScope[]
  dataScope?: DataScope
}

/** What an unspent invitation lets the page ask for, read before anything is asked (`POST /link/api/enrollment-invitation`). */
export interface EnrollmentInvitationOffer {
  admin: boolean
  /** Everything the invitation grants; asking for more is refused. */
  scopes: DeviceScope[]
}

/**
 * A device still waiting to be enrolled, for the desktop's pairing panel (`GET /link/api/enrollments`, desktop admins
 * only). The Host computer's system sheet names it by `name`, in `reason`.
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
  scopes?: DeviceScope[]
  dataScope?: DataScope
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
  'native-direct': '原生直连',
  'native-relay': '原生中继',
}

/**
 * 5xx answers that say, for certain, that the Host accepted nothing: it refused before recording the request (an audit
 * or confirmation it could not write, a Harness it could not start or reach). A client treats them as definite failures,
 * never as "result unknown", and the Host lets go of what it reserved for the request.
 */
export const NOT_ACCEPTED_5XX: ReadonlySet<string> = new Set([
  'audit-unavailable',
  'presence-unavailable',
  'agent-busy',
  'agent-start-failed',
  'agent-refused',
  'agent-paused',
  'agent-handshake-timeout',
  'model-gateway-unavailable',
])

/** A definite refusal: any 4xx but 408, or a 5xx whose code says nothing was accepted (`NOT_ACCEPTED_5XX`). */
export function refusedBeforeAccepting(status: number, code: string | undefined): boolean {
  if (status >= 400 && status < 500) return status !== 408
  return status >= 500 && code !== undefined && NOT_ACCEPTED_5XX.has(code)
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
  /** `file-changed` from a file edit: SHA-256 of the file as it is now. */
  currentHash?: string
  /** `history-already-imported`: the Latch session that session was brought in as. */
  taskId?: string
  /** A config change that certainly did not apply (`ConfigRefusal`): refused before it reached the agent, or by the agent. */
  configOutcome?: 'not-sent' | 'refused'
}
