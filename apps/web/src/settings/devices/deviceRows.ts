import { escapeSecurityText, type Device } from '@latch/protocol'
import { DEVICES_COPY as COPY } from '../../core/securityCopy.ts'
import { relativeTime } from '../../format.ts'

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
  const time = relativeTime(device.lastSeenAt, now)
  return /\d (?:分钟|小时|天)$/u.test(time) ? `${time}前` : time
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
