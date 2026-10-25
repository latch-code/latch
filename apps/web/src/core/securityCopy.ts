import {
  isAcceptableDeviceName,
  SCOPE_LABELS,
  type ApiFailure,
  type ApprovalOptionKind,
  type DeviceScope,
  type PresenceAction,
} from '@latch/protocol'

/**
 * Security-related text comes from this catalog, chosen by the Host's error
 * code; the Host's free-text `message` is never shown for these codes. The only
 * values substituted in are a scope label, a wait time and a validated
 * `host:port` target. Codes outside the catalog keep the Host's message, which
 * React renders as plain text.
 */

/** Why this browser is on the enrollment page: the Host's 401 code or a local cause. */
export type EnrollmentReason =
  | 'unauthorized'
  | 'device-revoked'
  | 'credential-expired'
  | 'listener-mismatch'
  | 'legacy-reconfirm'
  | 'key-missing'
  | 'credential-not-stored'
  | 'renewal-not-stored'

export const ENROLLMENT_REASON_TEXT: Partial<Record<EnrollmentReason, string>> = {
  'device-revoked': '此设备已被撤销。如需继续使用，请重新登记。',
  'credential-expired': '此设备的登记已满 30 天，请重新在本机确认。',
  'listener-mismatch': '此设备的凭据属于另一个访问地址，请重新登记。',
  'key-missing': '此浏览器已丢失设备密钥，请重新在本机确认。',
  'credential-not-stored': '登记已完成，但此浏览器没有保存设备凭据（可能禁止了 Cookie）。请允许此网站保存 Cookie 后重新登记。',
  'renewal-not-stored':
    '设备凭据已续期，但此浏览器没有保存新的凭据（可能禁止了 Cookie）。请允许此网站保存 Cookie 后重新加载页面；仍无法连接时再重新登记。',
}

export const HOST_DESKTOP_TEXT = '此操作需要在执行端电脑上用 Latch 桌面端确认。'
/** A change that reduced permissions applied while the Host could not write its audit log (`x-latch-audit: failed`). */
export const AUDIT_NOT_RECORDED_TEXT = '修改已生效，但执行端没有写入审计记录。请检查执行端数据目录所在磁盘的空间与权限。'
export const LOCAL_ONLY_TEXT = '此操作只能在执行端电脑上用 Latch 桌面端进行'

/**
 * Approval cards: the state pill of each kind of request, the notes under the title, the footnotes that say what
 * allowing does, and the reasons that replace an allow button this device does not get.
 */
export const APPROVAL_COPY = {
  waiting: '待批准',
  highRisk: '高风险',
  advisory: '仅提示',
  check: '需要核对',
  advisoryNote: '完全访问会话中，Agent 的询问只是提示：拒绝会转达给它，但不能阻止它执行其他操作。',
  hiddenCharacters: '内容包含不可见或改变显示方向的字符，已用 \\u{…} 标出。请仔细核对后再决定。',
  onceNote: '只允许这一次，之后的同类操作仍会询问。',
  localNote: '允许后要在这台电脑上用 Touch ID 或登录密码确认。',
  /** While the local confirmation is open, in place of the footnote: the button keeps its words and its width. */
  waitingLocal: '等待本机确认：在弹出的确认窗口中核对内容，再用 Touch ID 或登录密码确认。',
  confirmedLocal: '已在本机确认，正在执行…',
  allowLocal: '在本机允许',
  allowLocalTooltip: '需要在这台电脑上用 Touch ID 或登录密码确认',
  more: '更多批准选项',
  moreSheet: '更多选项',
  alwaysNote: '只在这个会话里有效',
  moreBusy: '正在提交另一个选择',
  noStandard: '此设备没有「批准普通操作」权限',
  noElevated: '此设备没有「批准高风险操作」权限',
  hostDesktop: '高风险操作只能在执行端电脑上用 Latch 桌面端批准',
  advisoryRemote: '只有执行端电脑上的 Latch 桌面端可以回应完全访问会话的询问',
  /** The choice whose outcome is unknown, by the label of its button. */
  uncertainTitle: (choice: string) => `「${choice}」的结果未知`,
  uncertain: '可重试同一选择，不会重复提交。',
  retry: '重试',
} as const

/**
 * The words of an agent's options, by their kind: an agent names its options in its own language (「Reject」), and
 * the card shows the product's words, with the agent's own in the tooltip. 本会话始终允许 only reaches a card from
 * the built-in harness.
 */
export const APPROVAL_OPTION_LABELS: Record<ApprovalOptionKind, string> = {
  reject_once: '拒绝',
  allow_once: '允许一次',
  reject_always: '始终拒绝',
  allow_always: '本会话始终允许',
}

/**
 * The local confirmation dock, the fallback for actions that do not show the confirmation in place yet. The check
 * code is shown only in a browser, where the person compares it with the window on another computer; in the desktop
 * app the confirmation window on this computer is the one to read.
 */
export const CONFIRMATION_COPY = {
  label: '本机确认',
  waiting: '已打开确认窗口。核对窗口里的内容，然后用 Touch ID 或登录密码确认。',
  browser: '请到运行 Latch 的电脑上，核对确认窗口里的内容和下面的核对码。',
  code: '核对码',
  confirmed: '已在本机确认，正在',
  cooldownTitle: '本机确认已暂停',
  cooldown: '连续拒绝了 3 次。为防止误触批准，暂时不再弹出确认窗口。',
  /** How long the pause still lasts, 「4:05 后可以重试。」. */
  cooldownWait: (wait: string) => `${wait} 后可以重试。`,
  cooldownOver: '现在可以重试。',
  busyTitle: '另一个确认还没完成',
  busy: '先在已经打开的确认窗口中完成或取消它。',
  blockedTitle: '暂时不能确认',
  blocked: '完全访问会话正在运行。为防止 Agent 冒用你的确认，停止它或等它结束后再试。',
  cancel: '取消',
  close: '关闭',
  ok: '好',
} as const

/** What the request does once the local confirmation passes, for 「已在本机确认，正在…」. */
export const CONFIRMATION_VERBS: Record<PresenceAction, string> = {
  'device.enroll': '登记设备',
  'device.grant': '更新权限',
  'task.start-l3': '开启会话',
  'task.mode-widen': '切换模式',
  'agent.define': '保存 Agent',
  'policy.change': '更新策略',
  'provider.set-key': '保存密钥',
  'approval.r2': '执行',
}

/**
 * Why a local confirmation ended without the request running; the card or the dock shows it and the caller gets it as
 * the error. A denial covers every way the confirmation did not pass: 不允许 in the window, a failed or cancelled
 * Touch ID or password prompt, or the system cancelling it.
 */
export const CONFIRMATION_RESULT_TEXT = {
  denied: '操作没有执行。本机确认没有通过。',
  expired: '操作没有执行。60 秒内没有完成确认。',
  cancelled: '操作没有执行。确认已取消。',
  error: '操作没有执行。本机确认没有完成。',
} as const

/** Whole minutes and seconds of a wait, 「4:05」. */
export function waitText(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** The enrollment page. */
export const ENROLLMENT_COPY = {
  title: '连接到 Latch',
  local: '这台设备会生成自己的密钥。提交后，请在运行 Latch 的电脑上核对指纹，并用 Touch ID 或登录密码确认。',
  /** The intro while local confirmation is unavailable: the offline code is the way in. */
  offline: '这台设备会生成自己的密钥，再用离线登记码完成登记。',
  /** Why only the offline code is accepted, with the Host's reason (trailing full stops removed). */
  unavailable: (reason: string) =>
    `本机确认不可用：${reason || '未知原因'}。停止 Host 后，在运行 Latch 的电脑上运行 pnpm latch device enroll --offline，把生成的离线登记码填在下面。`,
  invited: '已收到配对邀请。提交后，请在运行 Latch 的电脑上核对指纹并确认。',
  invitationRequired:
    '手机或其他电脑需要配对邀请。请在电脑上的 Latch 桌面端「设备」页生成配对二维码，或在电脑上运行 pnpm latch device invite。',
  name: '设备名称',
  namePlaceholder: '例如：我的手机',
  scopes: '此设备的权限',
  submit: '请求本机确认',
  waiting: '等待本机确认',
  /** The seconds left on the enrollment request. */
  remaining: (seconds: number) => `剩余 ${seconds} 秒`,
  cancel: '取消',
  retry: '重试',
  fingerprint: '设备指纹',
  compare: '请确认电脑上显示的指纹与下面完全一致：',
  hash: '核对码',
  completing: '正在完成登记…',
  connecting: '正在连接执行端…',
  confirmFailed: '登记已完成，但还没能读取执行端状态。',
  denied: '本机拒绝了此设备。',
  expired: '本机确认已超时，请重新提交。',
  offlineField: '离线登记码',
  offlineSubmit: '使用离线登记码',
  unsupported: '此浏览器无法在当前地址安全地保存设备密钥。请使用最新版 Chrome、Edge、Firefox 或 Safari，或使用 Latch 桌面端。',
  mismatch: '服务器返回的指纹与本机计算的不一致，已停止登记。',
  legacyTitle: '此设备需要在本机重新确认',
  legacyBody: 'Latch 已升级设备凭据，旧的登录状态不再有效。请提交确认请求，并在运行 Latch 的电脑上核对指纹。',
  legacySubmit: '在本机重新确认',
  oldHost: '此 Host 版本过旧，请在电脑上重启 Latch。',
  admin: '管理此 Host（模型服务、插件、项目和设备）',
} as const

/** The scopes as the enrollment page lists them: the device scopes, with what viewing and managing cover. */
const ENROLLMENT_SCOPE_LABELS: Record<DeviceScope, string> = {
  ...SCOPE_LABELS,
  view: '查看会话',
  admin: ENROLLMENT_COPY.admin,
}
/** What a browser always gets; 管理此 Host is its one choice. */
export const BROWSER_SCOPES: readonly string[] = (['view', 'run', 'approve:standard'] as const).map(scope => ENROLLMENT_SCOPE_LABELS[scope])
/** The desktop app enrolls on the Host's own socket and receives every scope. */
export const DESKTOP_SCOPES: readonly string[] = (['view', 'run', 'approve:standard', 'approve:elevated', 'admin', 'secrets'] as const).map(
  scope => ENROLLMENT_SCOPE_LABELS[scope],
)

/** Pairing a phone from 设置 › 设备. */
export const PAIRING_COPY = {
  intro: '生成一次性配对二维码，在手机上扫描后提交登记。二维码 10 分钟内有效，只能使用一次；对方提交后，仍需在这台电脑上核对指纹并确认。',
  expired: '上一个二维码已过期。',
  create: '生成配对二维码',
  steps: [
    '在手机上扫描二维码，或打开配对链接。',
    '在手机上提交登记请求。',
    '在这台电脑上核对两边显示的指纹，并用 Touch ID 或登录密码确认。',
  ],
  qrFailed: '二维码生成失败，可复制配对链接。',
  copyBlocked: '当前浏览器不允许复制。请在手机上扫描二维码。',
  needsTls: '手机接入需要 HTTPS。请用 --tls-cert、--tls-key 和 --public-origin 启动 Host（例如用 tailscale cert 生成的证书）。',
  needsDesktop: '配对二维码只能在执行端电脑上的 Latch 桌面端生成，或运行 pnpm latch device invite。',
  needsAdmin: '此设备没有「管理此 Host」权限',
  /** The time an invitation has left, then that it works once: 「剩余 9:41 · 仅可使用一次」. */
  remaining: (time: string) => `剩余 ${time} · 仅可使用一次`,
  qrAlt: '手机配对二维码',
  shareTitle: 'Latch 配对链接',
  share: '分享链接',
  copy: '复制链接',
  copied: '已复制',
  regenerate: '重新生成',
} as const

/** Session banners for a session that no longer accepts input. */
export const SESSION_STOP_TEXT = {
  'permission-drift': '检测到权限模式变化，本轮已取消，挂起的询问已拒绝。该会话不再接受输入，请新建会话。',
  'agent-definition-changed': 'Agent 定义已变化，该会话不能继续。请新建会话。',
  'project-config-changed': '项目中的 Agent 配置在确认后发生了变化，该会话不能继续。请新建会话。',
  'l3-confirmation-missing': '此会话创建于安全升级之前，不能继续。请新建会话。',
  'permission-unverified': '无法确认 Harness 已进入预期的权限模式，未发送本轮输入。',
} as const
export type SessionStopCode = keyof typeof SESSION_STOP_TEXT
export const isSessionStopCode = (code: string): code is SessionStopCode => code in SESSION_STOP_TEXT

const FIXED: Record<string, string> = {
  unauthorized: '请先在本机确认这台设备',
  'renewal-required': '设备凭据需要续期',
  'credential-expired': ENROLLMENT_REASON_TEXT['credential-expired']!,
  'device-revoked': ENROLLMENT_REASON_TEXT['device-revoked']!,
  'listener-mismatch': ENROLLMENT_REASON_TEXT['listener-mismatch']!,
  'legacy-reconfirm': '此设备需要在本机重新确认',
  'local-only': LOCAL_ONLY_TEXT,
  'ceiling-exceeded': '超出此设备可用的权限上限',
  'policy-changed': '安全策略刚被修改过，这次更改没有应用。请查看最新的设置后重试。',
  'presence-unavailable': '本机确认不可用',
  'presence-busy': '本机正在等待另一项确认，请先完成或取消',
  'presence-blocked': '有完全访问会话正在运行，本机确认暂时只能用于拒绝。请等待其结束或取消后重试。',
  'confirmation-not-found': '找不到该确认',
  'confirmation-pending': '本机尚未确认',
  'confirmation-denied': '本机拒绝了此操作。',
  'confirmation-expired': '本机确认已超时，请重试',
  'confirmation-mismatch': '确认内容与本次请求不一致，请重新确认',
  'confirmation-used': '该确认已使用',
  'confirmation-cancelled': '确认已取消，操作未执行。',
  'confirmation-failed': '本机确认组件出错，操作未执行。',
  'enrollment-denied': '本机拒绝了此设备。',
  'enrollment-not-found': '找不到该登记请求',
  'enrollment-pending': '本机尚未确认',
  'enrollment-completed': '该登记已完成',
  'enrollment-expired': '登记请求已超时，请重新提交',
  'enrollment-cancelled': '登记已取消。',
  'invitation-required': '手机等远程设备需要先在电脑上生成配对二维码',
  'invitation-invalid': '配对码无效或已过期',
  'offline-code-invalid': '离线登记码无效或已过期',
  'permission-drift': SESSION_STOP_TEXT['permission-drift'],
  'permission-unverified': SESSION_STOP_TEXT['permission-unverified'],
  'agent-definition-changed': SESSION_STOP_TEXT['agent-definition-changed'],
  'project-config-changed': SESSION_STOP_TEXT['project-config-changed'],
  'l3-confirmation-missing': '此会话没有经过本机确认，不能继续。请新建会话（需要本机确认）。',
  'approval-settled': '该审批已结束',
  // Answered by the desktop shell's main process, not the Host.
  'fingerprint-mismatch': '服务器返回的指纹与本机计算的不一致，已停止登记。',
  'host-unavailable': '无法连接本机的 Latch Host，请确认它仍在运行。',
  'credential-store-failed': '无法安全保存设备凭据，登记未完成。',
}

/** Prefix families in the catalog; an unlisted member still never shows server text. */
const FAMILY_FALLBACK: Array<[prefix: string, text: string]> = [
  ['presence-', '本机确认暂时不可用，请稍后重试'],
  ['confirmation-', '本机确认未完成，操作未执行'],
  ['enrollment-', '登记未完成，请重新提交'],
  ['invitation-', '配对码无效或已过期'],
]

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/

/** `host:port` (IPv6 in brackets) without control or bidirectional characters, ≤ 260 chars. */
export function safeTarget(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 260 || UNSAFE_TEXT.test(value)) return
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value)
  if (!match || Number(match[2]) > 65_535) return
  return value
}

/** A user-chosen device name shown in approval receipts; refused when the security-text rule would have to escape it. */
export function safeDeviceName(value: unknown): string | undefined {
  return typeof value === 'string' && isAcceptableDeviceName(value) ? value.trim() : undefined
}

export const DEVICE_NAME_INVALID_TEXT = '设备名称不能包含换行、不可见字符或改变文字方向的字符。'

const scopeLabel = (scope: unknown) =>
  typeof scope === 'string' && Object.hasOwn(SCOPE_LABELS, scope) ? SCOPE_LABELS[scope as DeviceScope] : undefined
const seconds = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined)

/** True when the code's text comes from the catalog rather than the Host. */
export function isCatalogCode(code: string): boolean {
  return (
    Object.hasOwn(FIXED, code)
    || code === 'scope-required'
    || code === 'stepup-required'
    || code === 'presence-cooldown'
    || code === 'egress-denied'
    || FAMILY_FALLBACK.some(([prefix]) => code.startsWith(prefix))
  )
}

/** The text a page shows for a Host error. */
export function describeFailure(status: number, code: string, message: string, details: Partial<ApiFailure> = {}): string {
  switch (code) {
    case 'scope-required': {
      const label = scopeLabel(details.required)
      return label ? `此设备没有「${label}」权限` : '此设备没有执行此操作的权限'
    }
    case 'stepup-required':
      return details.stepup?.where === 'host-desktop' ? HOST_DESKTOP_TEXT : '需要在本机确认'
    case 'presence-cooldown': {
      const wait = seconds(details.retryAfter)
      return `本机确认连续被拒绝 3 次，请 ${wait === undefined ? 5 : Math.max(1, Math.ceil(wait / 60))} 分钟后再试`
    }
    case 'egress-denied': {
      const target = safeTarget(details.target)
      return `Host 不会访问${target === undefined ? '该地址' : ` ${target}`}（本机、私网或元数据地址）。如需访问本机模型服务，请在本机确认后加入出站白名单。`
    }
    case 'rate-limited': {
      const wait = seconds(details.retryAfter)
      return wait === undefined ? '请求过于频繁，请稍后再试' : `请求过于频繁，请 ${wait} 秒后再试。`
    }
  }
  if (Object.hasOwn(FIXED, code)) return FIXED[code]!
  const family = FAMILY_FALLBACK.find(([prefix]) => code.startsWith(prefix))
  if (family) return family[1]
  return message || `请求未完成（${status}），请重试。`
}
