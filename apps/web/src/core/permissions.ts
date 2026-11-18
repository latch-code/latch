import {
  isLocalListener,
  type Approval,
  type ApprovalOption,
  type AppSnapshot,
  type CurrentDevice,
  type DeviceScope,
  type HarnessInfo,
  type HostView,
  type SessionConfigOption,
  type SessionPermission,
  type TaskSummary,
} from '@latch/protocol'
import { APPROVAL_COPY, highRiskLabel, type Brief } from './securityCopy.ts'
import type { LatchShell } from './shell.ts'
import { defineCopy } from './i18n.ts'

const COPY = defineCopy(
  {
    reject: '拒绝',
    allowOnce: '允许一次',
    oldAgent: '这个会话来自已移除的 Agent，只能查看',
    readOnly: '只能查看',
    removedWorktree: '工作树已移除：会话不能再运行、撤销本轮或添加文件。分支还在，可以在新会话里接着用它。',
    cannotSend: '这台设备不能发送消息',
  },
  {
    reject: 'Reject',
    allowOnce: 'Allow once',
    oldAgent: 'This session belongs to a removed Agent and is read-only',
    readOnly: 'Read-only',
    removedWorktree:
      'The worktree was removed. This session can’t run, undo the current turn, or add files. You can continue from the branch in a new session.',
    cannotSend: 'This device can’t send messages',
  },
)

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

function isLocalDevice(device: Pick<CurrentDevice, 'listener'> | null, shell: LatchShell | null): boolean {
  return device !== null && isLocalListener(device.listener) && shell !== null
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

export const DEVICE_PERMISSION_COPY = defineCopy(
  { devMode: '开发模式：这台 Mac 上的程序可以修改 Latch 的代码', legacyHost: '这台 Mac 上的 Latch 还是旧版本，重新启动后才能确认设备。' },
  {
    devMode: 'Development mode: programs on this Mac can modify Latch code',
    legacyHost: 'Latch on this Mac is out of date. Restart Latch to confirm devices.',
  },
)
export const LEGACY_HOST_TEXT = DEVICE_PERMISSION_COPY.legacyHost

export interface ApprovalGate {
  /**
   * The kind of request: an ordinary step of the built-in harness (R1), a high-risk one (R2, also a current Host that
   * sent no risk), a full-access agent's question (advisory, which the Host treats as R2), or any request from a Host
   * of the previous build (legacy: plain allow and reject).
   */
  kind: 'R1' | 'R2' | 'advisory' | 'legacy'
  /** The card's state pill: amber while it waits, red for a high-risk request. */
  badge?: { label: string; tone: 'warn' | 'err' }
  /** On advisory (L3) prompts: that rejecting cannot stop the agent, with the sentence behind ⓘ. */
  note?: Brief
  /** Buttons to show; reject options are always present. */
  options: ApprovalOption[]
  /** Whether the chosen option id is sent (drivers without options take plain allow/reject). */
  explicit: boolean
  /** Why allowing is not offered on this device. */
  hint?: string
}

/** Allow once and reject for drivers that offer no explicit options; these send no optionId. */
const FALLBACK_OPTIONS: ApprovalOption[] = [
  {
    id: 'reject_once',
    get label() {
      return COPY.reject
    },
    kind: 'reject_once',
  },
  {
    id: 'allow_once',
    get label() {
      return COPY.allowOnce
    },
    kind: 'allow_once',
  },
]

const isAllow = (option: ApprovalOption) => option.kind.startsWith('allow')

/**
 * Which approval buttons this device gets. `device` is null for a Host of the
 * previous build, which keeps plain allow/reject. A missing `risk` on a current
 * Host is treated as R2, the strictest class.
 */
export function approvalActions(approval: Approval, device: CurrentDevice | null): ApprovalGate {
  const explicit = approval.options !== undefined && approval.options.length > 0
  const offered = explicit ? approval.options! : FALLBACK_OPTIONS
  if (device === null) return { kind: 'legacy', badge: { label: APPROVAL_COPY.waiting, tone: 'warn' }, options: offered, explicit }
  const scopes = new Set(device.scopes)
  const rejects = offered.filter(option => !isAllow(option))
  const allowOnce = offered.filter(option => option.kind === 'allow_once')
  if (approval.advisory) {
    const allowed = scopes.has('run')
    return {
      kind: 'advisory',
      badge: { label: APPROVAL_COPY.advisory, tone: 'warn' },
      note: APPROVAL_COPY.advisoryNote,
      explicit,
      options: allowed ? [...rejects, ...allowOnce] : rejects,
      ...(allowed ? {} : { hint: APPROVAL_COPY.noRun }),
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
  const badge = { label: highRiskLabel(approval.riskReason), tone: 'err' as const }
  if (!scopes.has('approve:elevated')) return { kind: 'R2', badge, explicit, options: rejects, hint: APPROVAL_COPY.noElevated }
  return {
    kind: 'R2',
    badge,
    explicit,
    options: [...rejects, ...allowOnce],
  }
}

/** `reason`: why it only reads, behind the label's Hint. */
export type ComposerGate = { kind: 'open' } | { kind: 'read-only'; text: string; reason?: string } | { kind: 'stopped' }

/**
 * Why a session itself can only be read, whatever the device may do: its Agent was removed, or its worktree was. Nothing
 * runs, is undone or is added in it; undefined while it can go on.
 */
export function sessionReadOnly(
  summary: Pick<TaskSummary, 'personal' | 'worktree'> | undefined,
): { text: string; reason?: string } | undefined {
  // Latch no longer runs an assistant's private context, so nothing can continue its session.
  if (summary?.personal) return { text: COPY.oldAgent }
  if (summary?.worktree?.removed) return { text: COPY.readOnly, reason: COPY.removedWorktree }
  return undefined
}

/** Whether this device may type into a session; a stopped session shows its own banner. */
export function composerGate(input: {
  summary?: Pick<TaskSummary, 'permissionDrift' | 'personal' | 'worktree'>
  permission?: SessionPermission
  access: Pick<DeviceAccess, 'legacy' | 'scopes'>
  stopped?: boolean
}): ComposerGate {
  const readOnly = sessionReadOnly(input.summary)
  if (readOnly) return { kind: 'read-only', ...readOnly }
  if (input.access.legacy) return { kind: 'open' }
  if (input.stopped || input.summary?.permissionDrift || input.permission?.drift) return { kind: 'stopped' }
  if (!input.access.scopes.has('run')) return { kind: 'read-only', text: COPY.cannotSend }
  return { kind: 'open' }
}

/** One row of the 权限 chip's list. */
export interface ModeRow {
  value: string
  name: string
  description?: string
  current: boolean
  /** Why this device cannot choose it. */
  disabledReason?: string
}

/**
 * The agent's permission modes as rows, strictest first (the order the agent's profile lists them). Any row applies at
 * once on any device. A device that may not touch this session at all (`locked`) gets every other row disabled with that
 * reason.
 */
export function modeRows(option: Pick<SessionConfigOption, 'currentValue' | 'options'>, locked?: string): ModeRow[] {
  return option.options.map(row => {
    const current = row.value === option.currentValue
    return {
      value: row.value,
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      current,
      ...(!current && locked ? { disabledReason: locked } : {}),
    }
  })
}
