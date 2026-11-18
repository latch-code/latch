import { escapeSecurityText, type AppSnapshot, type Device } from '@latch/protocol'
import type { DeviceAccess } from '../../core/permissions.ts'
import { DEVICES_COPY as COPY, GRANTED_TEXT } from '../../core/securityCopy.ts'
import type { LatchShell } from '../../core/shell.ts'
import { defineCopy } from '../../core/i18n.ts'
import { relativeTime } from '../../format.ts'

/** A count of minutes, hours or days reads as time ago; 刚刚, 昨天 and dates read as they are. */
const SEEN_COPY = defineCopy(
  { ago: (time: string) => (/\d (?:分钟|小时|天)$/u.test(time) ? `${time}前` : time) },
  { ago: (time: string) => (/\d (?:min|h|d)$/u.test(time) ? `${time} ago` : time) },
)

/** Names recorded before the Host checked them may still hide characters, so they are shown escaped. */
export const deviceLabel = (name: string): string => escapeSecurityText(name) || COPY.unnamed

/**
 * The devices this page lists, the most recently seen first. The desktop app reading it is the Mac itself, not a device
 * that connects to it; any other desktop device (say, left behind by a wiped keychain) still holds what a desktop holds,
 * so it stays here to be removed. A removed device has left the page (its removal stays in the audit log).
 */
export function listedDevices(devices: readonly Device[], currentId: string): Device[] {
  return devices
    .filter(device => device.status !== 'revoked' && !(device.listener === 'unix' && device.id === currentId))
    .toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
}

export const isPhoneDevice = (device: Pick<Device, 'listener' | 'native'>): boolean =>
  device.native !== undefined || device.listener === 'native-direct' || device.listener === 'native-relay'

export const isBrowserDevice = (device: Pick<Device, 'listener' | 'native'>): boolean =>
  !isPhoneDevice(device) && device.listener !== 'unix'

/**
 * When a device was last seen, and only that: the Host reports no live connection for another device, so 「在线」 is said
 * only of the device reading this page.
 */
export function seenText(device: Pick<Device, 'lastSeenAt'>, self: boolean, now = new Date()): string {
  if (self) return COPY.online
  return SEEN_COPY.ago(relativeTime(device.lastSeenAt, now))
}

/** The body of the remove dialog: what happens, in words that fit how the device connects, and what else it takes with it. */
export function removeBody(target: Device, self: boolean, devices: readonly Device[]): string {
  const first = self
    ? COPY.removeSelf
    : target.listener === 'unix'
      ? COPY.removeDesktop
      : isBrowserDevice(target)
        ? COPY.removeBrowser
        : COPY.removePhone
  const invited = devices.some(device => device.pairedBy.deviceId === target.id && device.status !== 'revoked')
  return invited ? `${first}${COPY.removeCascade}` : first
}

/**
 * The ways 连接新设备 offers, only those that work here: all of them on the Latch app on this Mac with 管理, none
 * elsewhere. The app's main process makes each link and hands it on (the browser it opens, the clipboard), so the page
 * never holds one, and only the macOS app does that. Another computer also needs the Host's HTTPS entry.
 */
export function connectWays(
  shell: Pick<LatchShell, 'platform' | 'openInBrowser' | 'copyComputerLink'> | null,
  access: Pick<DeviceAccess, 'local' | 'admin'>,
  tls: AppSnapshot['host']['tls'],
) {
  const here = access.local && access.admin
  const app = here && shell?.platform === 'darwin' ? shell : undefined
  return {
    pair: here,
    openInBrowser: app?.openInBrowser,
    copyLink: tls ? app?.copyComputerLink : undefined,
  }
}

/** A change to what a device may do or see: its scopes, its data scope, or both. */
export type ScopeChange = { scopes?: Device['scopes']; dataScope?: Device['dataScope'] }

/**
 * The switches' requests: 管理 adds or drops `admin`; 项目文件 moves the data scope between `work` and `files`, 私有内容
 * between `files` and `all`.
 */
export const manageChange = (device: Pick<Device, 'scopes'>, on: boolean): ScopeChange => ({
  scopes: on ? [...device.scopes, 'admin'] : device.scopes.filter(item => item !== 'admin'),
})
export const filesChange = (on: boolean): ScopeChange => ({ dataScope: on ? 'files' : 'work' })
export const privateChange = (on: boolean): ScopeChange => ({ dataScope: on ? 'all' : 'files' })

/**
 * Which of a device's switches this page draws, and whether an off one is locked. Only a browser gets 项目文件: a phone
 * and a desktop device see everything from the start. 管理 also stays on a phone that kept it, so it can be taken away.
 * Turning either on takes this Mac's confirmation, so elsewhere an off switch is locked; turning off works anywhere.
 */
export function deviceSwitches(device: Device, self: boolean, access: DeviceAccess) {
  const open = device.status === 'active' && access.admin && !self
  const admin = device.scopes.includes('admin')
  return {
    manage: open && (isBrowserDevice(device) || (isPhoneDevice(device) && admin)),
    files: open && isBrowserDevice(device),
    raise: access.local,
  }
}

/** The 「可以」 line: what the device may do, in the words of the connection details, without what a switch says. */
export function grantedText(device: Pick<Device, 'scopes'>, manageSwitch: boolean): string {
  return device.scopes
    .filter(scope => !(manageSwitch && scope === 'admin'))
    .map(scope => GRANTED_TEXT[scope])
    .join('、')
}
