import { isAcceptableDeviceName, SCOPE_LABELS, type ApiFailure, type DeviceScope } from '@latch/protocol'

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
export const LOCAL_ONLY_TEXT = '此操作只能在执行端电脑上用 Latch 桌面端进行'

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
