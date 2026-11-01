import { describe, expect, it } from 'vitest'
import type { Device, NativePairingStatus } from '@latch/protocol'
import { deviceLabel, listedDevices, removeBody, seenText } from '../src/settings/devices/deviceRows.ts'
import { QR_REFRESH_MS, readPairing } from '../src/settings/devices/pairingFlow.ts'

const device = (over: Partial<Device>): Device => ({
  id: 'dev_a',
  name: 'iPhone 16 Pro',
  status: 'active',
  listener: 'native-relay',
  scopes: ['view', 'run', 'approve:standard'],
  dataScope: 'all',
  fingerprint: '',
  createdAt: '2026-11-01T00:00:00.000Z',
  lastSeenAt: '2026-11-01T00:00:00.000Z',
  credentialExpiresAt: '2026-12-01T00:00:00.000Z',
  pairedBy: { method: 'invitation' },
  ...over,
})

describe('the 手机 page rows', () => {
  const devices = [
    device({ id: 'old', lastSeenAt: '2026-10-01T00:00:00.000Z' }),
    device({ id: 'mac', listener: 'unix', lastSeenAt: '2026-11-02T00:00:00.000Z' }),
    device({ id: 'left-behind', listener: 'unix', lastSeenAt: '2026-09-01T00:00:00.000Z' }),
    device({ id: 'gone', status: 'revoked', lastSeenAt: '2026-11-02T00:00:00.000Z' }),
    device({ id: 'new', listener: 'loopback-tcp', lastSeenAt: '2026-11-01T00:00:00.000Z' }),
  ]

  it('lists connecting devices, newest first, without the desktop app reading the page or removed devices', () => {
    expect(listedDevices(devices, 'mac').map(item => item.id)).toEqual(['new', 'old', 'left-behind'])
  })

  it('keeps a desktop device left behind within reach, and the Mac from a browser, because each holds what a desktop holds', () => {
    expect(listedDevices(devices, 'new').map(item => item.id)).toEqual(['mac', 'new', 'old', 'left-behind'])
    expect(removeBody(device({ id: 'left-behind', listener: 'unix' }), false, [])).toContain('桌面端重新确认')
  })

  it('says 在线 only of the device reading the page, because the Host reports no live state for others', () => {
    const now = new Date('2026-11-01T12:00:00.000Z')
    const seen = (at: string) => seenText({ lastSeenAt: at }, false, now)
    expect(seen('2026-11-01T11:59:50.000Z')).toBe('刚刚')
    expect(seen('2026-11-01T11:30:00.000Z')).toBe('30 分钟前')
    expect(seen('2026-11-01T09:00:00.000Z')).toBe('3 小时前')
    expect(seen('2026-10-31T09:00:00.000Z')).toBe('昨天')
    expect(seenText({ lastSeenAt: '2026-10-31T09:00:00.000Z' }, true, now)).toBe('在线')
  })

  it('says what removing costs in words that fit the device, and what else goes with it', () => {
    const phone = device({ id: 'phone' })
    const browser = device({ id: 'browser', listener: 'loopback-tcp' })
    const invited = device({ id: 'invited', pairedBy: { method: 'invitation', deviceId: 'browser' } })
    expect(removeBody(phone, false, [phone])).toBe('它会立即断开，之后要重新扫码才能连接。')
    expect(removeBody(browser, false, [browser])).toBe('它会立即断开，之后要重新发链接才能连接。')
    expect(removeBody(browser, true, [browser])).toBe('这台设备会立即断开，之后要重新发链接才能连接。')
    expect(removeBody(browser, false, [browser, invited])).toContain('由它连接的设备会降为只能查看')
    // A device already removed is no longer a consequence.
    expect(removeBody(browser, false, [browser, { ...invited, status: 'revoked' }])).not.toContain('由它邀请')
  })

  it('escapes hidden characters in a name it puts into a sentence', () => {
    expect(deviceLabel('iPhone‮')).toBe('iPhone\\u{202E}')
  })
})

describe('the pairing sheet', () => {
  const at = 1_000_000
  const issued = [
    { id: 'old', at: at - 30_000 },
    { id: 'new', at },
  ]
  const answer = (state: NativePairingStatus['state'], over: Partial<NativePairingStatus> = {}): NativePairingStatus => ({
    state,
    offNetwork: false,
    ...over,
  })

  it('lets a burn win over everything, even the question after Touch ID', () => {
    expect(readPairing(issued, [answer('done', { device: 'iPhone' }), answer('contended')], at)).toEqual({ kind: 'contended' })
  })

  it('asks about the device a QR paired, with its ID as the way back', () => {
    expect(readPairing(issued, [answer('done', { device: 'iPhone', deviceId: 'dev_a' }), answer('ready')], at)).toEqual({
      kind: 'done',
      id: 'old',
      device: 'iPhone',
      deviceId: 'dev_a',
    })
  })

  it('replaces only the QR that was used, so closing the sheet can still reach its sibling', () => {
    expect(readPairing(issued, [answer('ready'), answer('timeout')], at)).toEqual({ kind: 'ended', ids: ['new'], state: 'timeout' })
    expect(readPairing(issued, [answer('cancelled'), answer('ready')], at)).toEqual({ kind: 'ended', ids: ['old'], state: 'cancelled' })
  })

  it('holds the QR still while a device is being confirmed, so a second phone scans the same one', () => {
    const late = at + QR_REFRESH_MS * 2
    expect(readPairing(issued, [answer('confirming', { device: 'iPhone' }), answer('ready')], late)).toEqual({
      kind: 'busy',
      state: 'confirming',
      device: 'iPhone',
    })
    expect(readPairing(issued, [answer('ready'), answer('approved')], late)).toEqual({ kind: 'busy', state: 'approved' })
  })

  it('changes the QR silently after a minute, or at once when the newest has lapsed', () => {
    expect(readPairing(issued, [answer('ready'), answer('ready')], at + QR_REFRESH_MS - 1)).toEqual({ kind: 'idle' })
    expect(readPairing(issued, [answer('ready'), answer('ready')], at + QR_REFRESH_MS)).toEqual({ kind: 'refresh' })
    expect(readPairing(issued, [answer('ready'), answer('expired')], at)).toEqual({ kind: 'refresh' })
  })

  it('does nothing on an answer it could not read', () => {
    expect(readPairing(issued, [null, null], at)).toEqual({ kind: 'idle' })
  })
})
