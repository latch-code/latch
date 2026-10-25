import type {
  Approval,
  ApprovalOption,
  AppSnapshot,
  CurrentDevice,
  DeviceScope,
  HarnessInfo,
  HostView,
  SessionPermission,
  TaskSummary,
} from '@latch/protocol'
import { APPROVAL_COPY } from './securityCopy.ts'
import type { LatchShell } from './shell.ts'

/**
 * What this device may do, for display only: the Host enforces every rule
 * again. Hiding a control here never grants or removes a permission.
 */

/** Snapshots from a Host of the previous build carry no `host`; that Host enforces its own older rules. */
export function hostView(snapshot: AppSnapshot): HostView | undefined {
  const host = (snapshot as Partial<AppSnapshot>).host
  return host !== undefined && host !== null && typeof host.hostId === 'string' ? host : undefined
}

export interface DeviceAccess {
  /** The Host predates device confirmation: no device API, plain approvals, the old owner role decides settings. */
  legacy: boolean
  /** This page runs in the desktop shell with a device minted on the Host's local socket. */
  local: boolean
  scopes: ReadonlySet<DeviceScope>
  admin: boolean
  device: CurrentDevice | null
}

const ALL_SCOPES: DeviceScope[] = ['view', 'run', 'approve:standard', 'approve:elevated', 'admin', 'secrets']

export function isLocalDevice(device: Pick<CurrentDevice, 'listener'> | null, shell: LatchShell | null): boolean {
  return device !== null && device.listener === 'unix' && shell !== null
}

export function deviceAccess(snapshot: AppSnapshot, shell: LatchShell | null): DeviceAccess {
  if (hostView(snapshot) === undefined) {
    const owner = (snapshot.device as unknown as { role?: string }).role === 'owner'
    return {
      legacy: true,
      local: false,
      scopes: new Set(owner ? ALL_SCOPES : ['view', 'run', 'approve:standard']),
      admin: owner,
      device: null,
    }
  }
  const device = snapshot.device
  const scopes = new Set(Array.isArray(device.scopes) ? device.scopes : [])
  return { legacy: false, local: isLocalDevice(device, shell), scopes, admin: scopes.has('admin'), device }
}

export const harnessLevel = (harness: Pick<HarnessInfo, 'level' | 'source'>): 'L1' | 'L3' =>
  harness.level ?? (harness.source === 'builtin' ? 'L1' : 'L3')

export const LEVEL_LABELS = { L1: '逐项询问（L1）', L3: '完全访问（L3）' } as const
export const LOCAL_ONLY_HARNESS = '仅本机桌面端'
export const L3_START_HINT = '开启完全访问会话需要本机确认。该会话可以读写 Latch 数据和 Host 身份私钥。'
export const L3_READ_ONLY = '完全访问会话只接受执行端电脑上 Latch 桌面端的输入。此设备可以查看、拒绝和取消。'
export const DEV_MODE_TEXT = '开发模式：Host 代码可被本机修改'
export const LEGACY_HOST_TEXT = '此 Host 仍是旧版本，重启 Host 后启用设备确认。'

/** New sessions on a full-access harness can only be started from the Host's own desktop. */
export function harnessGate(
  harness: Pick<HarnessInfo, 'level' | 'source'>,
  access: Pick<DeviceAccess, 'legacy' | 'local'>,
): { allowed: boolean; reason?: string } {
  if (access.legacy || access.local || harnessLevel(harness) !== 'L3') return { allowed: true }
  return { allowed: false, reason: LOCAL_ONLY_HARNESS }
}

export interface ApprovalGate {
  /**
   * The kind of request: an ordinary step of the built-in harness (R1), a high-risk one (R2, also a current Host that
   * sent no risk), a full-access agent's question (advisory, which the Host treats as R2), or any request from a Host
   * of the previous build (legacy: plain allow and reject).
   */
  kind: 'R1' | 'R2' | 'advisory' | 'legacy'
  /** The card's state pill: amber while it waits, red for a high-risk request. */
  badge?: { label: string; tone: 'warn' | 'err' }
  /** Explanation shown on advisory (L3) prompts. */
  note?: string
  /** Buttons to show; reject options are always present. */
  options: ApprovalOption[]
  /** Whether the chosen option id is sent (drivers without options take plain allow/reject). */
  explicit: boolean
  /** Why allowing is not offered on this device. */
  hint?: string
  /** Allowing opens the local confirmation (Touch ID or the login password on this computer). */
  confirms?: boolean
}

/** Allow once and reject for drivers that offer no explicit options; these send no optionId. */
export const FALLBACK_OPTIONS: ApprovalOption[] = [
  { id: 'reject_once', label: '拒绝', kind: 'reject_once' },
  { id: 'allow_once', label: '允许一次', kind: 'allow_once' },
]

const isAllow = (option: ApprovalOption) => option.kind.startsWith('allow')

/**
 * Which approval buttons this device gets. `device` is null for a Host of the
 * previous build, which keeps plain allow/reject. A missing `risk` on a current
 * Host is treated as R2, the strictest class.
 */
export function approvalActions(approval: Approval, device: CurrentDevice | null, shell: LatchShell | null): ApprovalGate {
  const explicit = approval.options !== undefined && approval.options.length > 0
  const offered = explicit ? approval.options! : FALLBACK_OPTIONS
  if (device === null) return { kind: 'legacy', badge: { label: APPROVAL_COPY.waiting, tone: 'warn' }, options: offered, explicit }
  const scopes = new Set(device.scopes)
  const local = isLocalDevice(device, shell)
  const rejects = offered.filter(option => !isAllow(option))
  const allowOnce = offered.filter(option => option.kind === 'allow_once')
  if (approval.advisory) {
    const allowed = local && scopes.has('run')
    return {
      kind: 'advisory',
      badge: { label: APPROVAL_COPY.advisory, tone: 'warn' },
      note: APPROVAL_COPY.advisoryNote,
      explicit,
      options: allowed ? [...rejects, ...allowOnce] : rejects,
      ...(allowed ? {} : { hint: APPROVAL_COPY.advisoryRemote }),
    }
  }
  if (approval.risk === 'R1') {
    const allowed = scopes.has('approve:standard')
    return {
      kind: 'R1',
      badge: { label: APPROVAL_COPY.waiting, tone: 'warn' },
      explicit,
      options: allowed ? offered : rejects,
      ...(allowed ? {} : { hint: APPROVAL_COPY.noStandard }),
    }
  }
  const badge = { label: APPROVAL_COPY.highRisk, tone: 'err' as const }
  if (!local) return { kind: 'R2', badge, explicit, options: rejects, hint: APPROVAL_COPY.hostDesktop }
  if (!scopes.has('approve:elevated')) return { kind: 'R2', badge, explicit, options: rejects, hint: APPROVAL_COPY.noElevated }
  return {
    kind: 'R2',
    badge,
    explicit,
    options: [...rejects, ...allowOnce.map(option => ({ ...option, label: APPROVAL_COPY.allowLocal }))],
    confirms: true,
  }
}

export type ComposerGate = { kind: 'open' } | { kind: 'read-only'; text: string } | { kind: 'stopped' }

/** Whether this device may type into a session; a stopped session shows its own banner. */
export function composerGate(input: {
  summary?: Pick<TaskSummary, 'level' | 'permissionDrift'>
  permission?: SessionPermission
  access: Pick<DeviceAccess, 'legacy' | 'local' | 'scopes'>
  stopped?: boolean
}): ComposerGate {
  if (input.access.legacy) return { kind: 'open' }
  if (input.stopped || input.summary?.permissionDrift || input.permission?.drift) return { kind: 'stopped' }
  const level = input.permission?.level ?? input.summary?.level
  if (level === 'L3' && !input.access.local) return { kind: 'read-only', text: L3_READ_ONLY }
  if (!input.access.scopes.has('run')) return { kind: 'read-only', text: '此设备没有「发起和继续会话」权限' }
  return { kind: 'open' }
}
