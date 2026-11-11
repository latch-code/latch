import { describe, expect, it } from 'vitest'
import type { Device, NativePairingStatus } from '@latch/protocol'
import type { DeviceAccess } from '../src/core/permissions.ts'
import type { LatchShell } from '../src/core/shell.ts'
import {
  connectWays,
  deviceLabel,
  deviceSwitches,
  filesChange,
  grantedText,
  listedDevices,
  manageChange,
  removeBody,
  seenText,
} from '../src/settings/devices/deviceRows.ts'
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

describe('the 设备 section rows', () => {
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
    expect(removeBody(device({ id: 'left-behind', listener: 'unix' }), false, [])).toContain('那台电脑的 Latch 里重新确认')
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

describe('a device page', () => {
  const access = (local: boolean, admin: boolean): DeviceAccess => ({
    legacy: false,
    local,
    admin,
    scopes: new Set(admin ? ['view', 'admin'] : ['view']),
    device: null,
  })
  const browser = device({ id: 'browser', listener: 'loopback-tcp', dataScope: 'work' })
  const phone = device({ id: 'phone' })
  const desktop = device({ id: 'desktop', listener: 'unix' })

  it('gives a browser both switches, live on this Mac and locked off elsewhere, and none without 管理', () => {
    expect(deviceSwitches(browser, false, access(true, true))).toEqual({ manage: true, files: true, raise: true })
    expect(deviceSwitches(browser, false, access(false, true))).toEqual({ manage: true, files: true, raise: false })
    expect(deviceSwitches(browser, false, access(false, false))).toMatchObject({ manage: false, files: false })
  })

  it('draws no switch on its own page, or for a device that is not active', () => {
    expect(deviceSwitches(browser, true, access(false, true))).toMatchObject({ manage: false, files: false })
    expect(deviceSwitches({ ...browser, status: 'review' }, false, access(true, true))).toMatchObject({ manage: false, files: false })
  })

  it('never offers 项目文件 to a phone or a desktop device, which see everything from the start', () => {
    expect(deviceSwitches(phone, false, access(true, true))).toMatchObject({ manage: false, files: false })
    expect(deviceSwitches({ ...phone, scopes: [...phone.scopes, 'admin'] }, false, access(true, true))).toMatchObject({
      manage: true,
      files: false,
    })
    expect(deviceSwitches(desktop, false, access(true, true))).toMatchObject({ manage: false, files: false })
  })

  it('asks for exactly the change the switch names', () => {
    expect(manageChange(browser, true)).toEqual({ scopes: ['view', 'run', 'approve:standard', 'admin'] })
    expect(manageChange({ scopes: ['view', 'admin', 'run'] }, false)).toEqual({ scopes: ['view', 'run'] })
    expect(filesChange(true)).toEqual({ dataScope: 'all' })
    expect(filesChange(false)).toEqual({ dataScope: 'work' })
  })

  it('says what the device may do, leaving 管理 to its switch', () => {
    const managing = { scopes: ['view', 'run', 'admin'] as Device['scopes'] }
    expect(grantedText(managing, true)).toBe('查看会话、开始和继续会话')
    expect(grantedText(managing, false)).toBe('查看会话、开始和继续会话、管理这台 Mac（模型服务、插件、项目和设备）')
  })
})

describe('连接新设备', () => {
  const opened = () => Promise.resolve({ ok: true as const })
  const shell = (over: Partial<LatchShell> = {}): Pick<LatchShell, 'platform' | 'openInBrowser' | 'copyComputerLink'> => ({
    platform: 'darwin',
    openInBrowser: opened,
    copyComputerLink: opened,
    ...over,
  })
  const here = { local: true, admin: true }
  const entry = { origin: 'https://studio.example.test:4318' }

  it('offers another computer only while the Host has an HTTPS entry and the app can copy its link', () => {
    expect(connectWays(shell(), here, null).copyLink).toBeUndefined()
    expect(connectWays(shell({ copyComputerLink: undefined }), here, entry).copyLink).toBeUndefined()
    expect(connectWays(shell(), here, entry).copyLink).toBe(opened)
  })

  it('offers nothing but the way to a Mac elsewhere, and nothing the app cannot do outside macOS', () => {
    expect(connectWays(shell(), { local: false, admin: true }, entry)).toEqual({
      pair: false,
      openInBrowser: undefined,
      copyLink: undefined,
    })
    expect(connectWays(shell(), { local: true, admin: false }, entry).pair).toBe(false)
    expect(connectWays(null, here, entry)).toEqual({ pair: true, openInBrowser: undefined, copyLink: undefined })
    expect(connectWays(shell({ platform: 'win32' }), here, entry)).toMatchObject({ openInBrowser: undefined, copyLink: undefined })
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
