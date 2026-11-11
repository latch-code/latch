import { chromium, type Browser, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Device, NativeLinkInfo, NativePairingStatus, WaitingEnrollmentView } from '@latch/protocol'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openEntry, openSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/phone-page'
const SIZES = [
  { width: 1440, height: 900, label: 'desktop' },
  { width: 820, height: 1000, label: 'tablet' },
  { width: 390, height: 844, label: 'phone' },
] as const

const device = (id: string, name: string, listener: Device['listener'], hoursAgo: number): Device => ({
  id,
  name,
  status: 'active',
  listener,
  scopes: ['view', 'run', 'approve:standard'],
  dataScope: 'all',
  fingerprint: 'ABCD EFGH IJKL MNOP QRST',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  credentialExpiresAt: '2026-12-01T00:00:00.000Z',
  pairedBy: { method: 'invitation' },
})

/**
 * The page as the desktop app sees it, in a browser: this device reads as the Mac's own and the Host's answers about
 * phones are fixtures, so every state of the sheet can be drawn. The QR is made from a dead code: a live invitation is
 * never captured. `e2e/desktop-native.e2e.ts` runs the real flow against the Host.
 */
interface PageState {
  devices: Device[]
  pairing: NativePairingStatus
  create: 'ok' | 'no-lan' | 'blocked' | 'failed'
  relays: NativeLinkInfo['relays']
  /** The Mac cannot confirm anything. */
  presenceDown?: boolean
  listFails?: boolean
  waiting?: WaitingEnrollmentView[]
  /** How long the Host takes to answer for a new QR, and how many it was asked for. */
  createDelay?: number
  created?: number
  /** The bodies of scope changes, in order. */
  patches?: { id: string; scopes: Device['scopes'] }[]
}

async function asDesktop(page: Page, state: PageState) {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'latchShell', {
      value: { kind: 'electron', platform: 'darwin', openInBrowser: async () => ({ ok: true }) },
    })
  })
  await page.route('**/link/api/snapshot', async route => {
    const response = await route.fetch()
    const snapshot = (await response.json()) as { device: Device; host: { presence: unknown } }
    snapshot.device = { ...snapshot.device, listener: 'unix', scopes: ['view', 'run', 'approve:standard', 'admin'] }
    if (state.presenceDown) snapshot.host.presence = { status: 'unavailable', message: '测试中的原因' }
    await route.fulfill({ response, json: snapshot })
  })
  await page.route('**/link/api/devices', route =>
    state.listFails
      ? route.fulfill({ status: 500, json: { error: 'internal', code: 'internal', message: '读取失败' } })
      : route.fulfill({ json: { devices: state.devices } }),
  )
  await page.route('**/link/api/devices/*', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    const id = decodeURIComponent(route.request().url().split('/').at(-1)!)
    const { scopes } = route.request().postDataJSON() as { scopes: Device['scopes'] }
    state.patches?.push({ id, scopes })
    state.devices = state.devices.map(item => (item.id === id ? { ...item, scopes, status: 'active' } : item))
    return route.fulfill({ json: { device: state.devices.find(item => item.id === id) } })
  })
  await page.route('**/link/api/enrollments', route =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { enrollments: state.waiting ?? [], blockingTasks: [] } })
      : route.fallback(),
  )
  await page.route('**/link/api/native/pairings', async route => {
    state.created = (state.created ?? 0) + 1
    if (state.createDelay) await new Promise(done => setTimeout(done, state.createDelay))
    if (state.create === 'ok')
      return route.fulfill({
        status: 201,
        json: { invitation: { id: `qr-${Date.now()}`, payload: 'LATCHPAIR2.fixture-dead-code', expiresAt: '2030-01-01T00:00:00.000Z' } },
      })
    const code = state.create === 'no-lan' ? 'native-no-lan' : state.create === 'blocked' ? 'presence-blocked' : 'native-not-ready'
    return route.fulfill({ status: state.create === 'failed' ? 503 : 409, json: { error: code, code, message: '手机连接服务正在准备' } })
  })
  await page.route('**/link/api/native/pairings/*', route =>
    route.request().method() === 'GET' ? route.fulfill({ json: state.pairing }) : route.fulfill({ json: { removed: true } }),
  )
  await page.route('**/link/api/native/info', route =>
    route.fulfill({ json: { version: 1, enabled: true, directManaged: false, listening: null, directory: false, relays: state.relays } }),
  )
  await page.route('**/link/api/native/relays/*', route => {
    state.relays = []
    return route.fulfill({ json: { version: 1, enabled: true, directManaged: false, listening: null, directory: false, relays: [] } })
  })
  await page.route('**/link/api/native/pairings/*/device', route => route.fulfill({ json: { removed: true } }))
}

describe('the 手机 page', () => {
  let testHost: TestHost
  let browser: Browser

  beforeAll(async () => {
    testHost = await startTestHost({
      demo: true,
      hostName: 'studio-mini',
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
    })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser.close()
    await testHost.close()
  })

  for (const size of SIZES)
    it(`draws the page and every state of the pairing sheet at ${size.label} width`, async () => {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height } })
      context.setDefaultTimeout(15_000)
      const page = await context.newPage()
      await enrollBrowser(page, testHost, { name: `固定的浏览器 ${size.label}`, scopes: ['view', 'run', 'approve:standard', 'admin'] })
      const iphone = device('dev_phone', 'iPhone 16 Pro', 'native-relay', 0.01)
      const state: PageState = {
        devices: [],
        pairing: { state: 'ready', offNetwork: false },
        create: 'ok',
        relays: [{ relayId: 'a'.repeat(32), url: 'wss://relay.fixture.test', status: 'connected' }],
      }
      await asDesktop(page, state)
      await page.reload()
      await connected(page)
      const capture = async (name: string) => {
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
          await page.waitForTimeout(60)
          await page.screenshot({ path: `${OUTPUT}/${name}-${size.label}-${colorScheme}.png`, animations: 'disabled' })
        }
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
      }
      const phone = size.label === 'phone'
      await openEntry(page, '手机')

      // No device yet.
      await page.getByText('还没有别的设备连接这台 Mac。', { exact: true }).waitFor()
      await capture('empty')

      // The row, its page, its menu and 关于连接. The desktop app reading the page is not listed; another desktop device is.
      const self = await page.evaluate(() =>
        fetch('/link/api/snapshot').then(async answer => ((await answer.json()) as { device: { id: string } }).device.id),
      )
      state.devices = [
        iphone,
        device('dev_ipad', 'iPad Air', 'native-direct', 3),
        device('dev_browser', '我的浏览器', 'loopback-tcp', 26),
        device(self, 'Latch 桌面端', 'unix', 0),
        device('dev_old_mac', '换钥匙串之前的桌面端', 'unix', 900),
      ]
      await page.reload()
      await connected(page)
      await openEntry(page, '手机')
      const row = page.locator('[data-device-id="dev_phone"]')
      await row.waitFor()
      expect(await page.locator(`[data-device-id="${self}"]`).count()).toBe(0)
      await page.locator('[data-device-id="dev_old_mac"]').waitFor()
      for (const word of ['指纹', '权限', '局域网', '回环', 'HTTPS', '登记有效期'])
        expect(await page.locator('.settings-page').getByText(word).count()).toBe(0)
      await capture('list')
      await page.getByRole('button', { name: '关于连接', exact: true }).click()
      await page.getByText('Latch 目前还不提供其他网络下的连接', { exact: false }).waitFor()
      await capture('about')
      // A saved relay can be taken back, here and only here.
      await page.getByText('wss://relay.fixture.test', { exact: true }).waitFor()
      await capture('about-saved')
      await page.locator('.device-saved').getByRole('button', { name: '移除', exact: true }).click()
      await page.getByText('wss://relay.fixture.test', { exact: true }).waitFor({ state: 'hidden' })
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '在浏览器中打开', exact: true }).click()
      await page.getByText('已在浏览器中打开', { exact: false }).waitFor()
      await capture('browser-opened')
      await page.locator('[data-device-id="dev_browser"] .plugin-nav-row').click()
      await page.getByRole('switch', { name: '可以管理这台 Mac', exact: true }).waitFor()
      await capture('browser-device')
      if (phone) await page.getByRole('button', { name: '返回手机与设备', exact: true }).click()
      await row.locator('.plugin-nav-row').click()
      await page.getByRole('button', { name: '移除…', exact: true }).waitFor()
      await capture('device')
      if (!phone) {
        await row.hover()
        await row.getByRole('button', { name: 'iPhone 16 Pro 的操作', exact: true }).click()
        await page.getByRole('menuitem', { name: '重命名', exact: true }).waitFor()
        await capture('menu')
        await page.keyboard.press('Escape')
      }
      await page.getByRole('button', { name: '移除…', exact: true }).click()
      await page.getByText('移除「iPhone 16 Pro」？', { exact: true }).waitFor()
      await capture('remove')
      await page.keyboard.press('Escape')
      if (phone) await page.getByRole('button', { name: '返回手机与设备', exact: true }).click()

      // A browser asking to connect: who, whether it could manage, and its code shut until wanted.
      const asking: WaitingEnrollmentView = {
        id: 'enr_browser',
        name: 'Mac 上的 Chrome',
        fingerprint: 'ABCD EFGH IJKL MNOP QRST',
        listener: 'loopback-tcp',
        method: 'invitation',
        status: 'pending',
        expiresAt: '2030-01-01T00:00:00.000Z',
        reason: '允许「Mac 上的 Chrome」连接这台 Mac',
        scopes: ['view', 'run', 'approve:standard', 'admin'],
        dataScope: 'work',
      }
      state.waiting = [asking]
      const waitingRow = page.locator('.device-waiting')
      await waitingRow.getByText('「Mac 上的 Chrome」想连接这台 Mac', { exact: true }).waitFor()
      await waitingRow.getByText('它还可以管理这台 Mac', { exact: true }).waitFor()
      expect(await waitingRow.locator('.connection-code').isVisible()).toBe(false)
      await capture('waiting-browser')
      await waitingRow.locator('summary').click()
      await waitingRow.locator('.connection-code').waitFor()
      await capture('waiting-browser-open')
      state.waiting = []
      await waitingRow.waitFor({ state: 'detached' })

      // The sheet.
      const connect = page.locator('.device-connect')
      await connect.click()
      const sheet = page.getByRole('dialog', { name: '连接手机', exact: true })
      const qr = sheet.getByAltText('原生客户端配对二维码')
      await qr.waitFor()
      expect(await sheet.getByRole('button', { name: '关闭', exact: true }).count()).toBe(1)
      await capture('sheet-ready')
      for (const word of ['发送到其他设备', '防火墙', '六位', '剩余']) expect(await sheet.getByText(word).count()).toBe(0)

      const setPairing = async (next: NativePairingStatus, ready: () => Promise<unknown>) => {
        state.pairing = next
        await ready()
      }
      await setPairing({ state: 'confirming', device: 'iPhone 16 Pro', offNetwork: false }, () =>
        sheet.getByText('在系统窗口中确认', { exact: true }).waitFor(),
      )
      await capture('sheet-confirming')
      // A QR phone shows no code to compare with: the fold has the sentence and what it gets.
      state.waiting = [
        {
          ...asking,
          id: 'enr_phone',
          name: 'iPhone 16 Pro',
          listener: 'native-direct',
          reason: '允许「iPhone 16 Pro」连接这台 Mac',
          scopes: ['view', 'run', 'approve:standard'],
          dataScope: 'all',
        },
      ]
      const phoneDetails = sheet.locator('details.connection-details')
      await phoneDetails.locator('summary').click()
      await phoneDetails.getByText('全部会话', { exact: true }).waitFor()
      expect(await phoneDetails.locator('.connection-code').count()).toBe(0)
      await capture('sheet-confirming-details')
      state.waiting = []
      await phoneDetails.waitFor({ state: 'detached' })
      await setPairing({ state: 'approved', device: 'iPhone 16 Pro', offNetwork: false }, () =>
        sheet.getByText('正在连接…', { exact: true }).waitFor(),
      )
      await capture('sheet-approved')
      await setPairing({ state: 'cancelled', offNetwork: false }, async () => {
        await sheet.getByText('已取消。可以重新扫码。', { exact: true }).waitFor()
        state.pairing = { state: 'ready', offNetwork: false }
      })
      await capture('sheet-cancelled')
      await setPairing({ state: 'timeout', offNetwork: false }, async () => {
        await sheet.getByText('没有确认，已取消。可以重新扫码。', { exact: true }).waitFor()
        state.pairing = { state: 'ready', offNetwork: false }
      })
      await capture('sheet-timeout')
      await setPairing({ state: 'contended', offNetwork: false }, async () => {
        await sheet.getByText('有两台设备扫了同一个二维码，已全部取消。请重新扫码。', { exact: true }).waitFor()
        state.pairing = { state: 'ready', offNetwork: false }
      })
      await capture('sheet-contention')
      await setPairing({ state: 'ready', offNetwork: true }, () =>
        sheet.getByText('有设备从其他网络尝试连接，已拒绝。', { exact: true }).waitFor(),
      )
      await capture('sheet-offnet')

      // After Touch ID only an answer ends it: no close, and Esc does nothing.
      await setPairing({ state: 'done', device: 'iPhone 16 Pro', deviceId: 'dev_phone', offNetwork: false }, () =>
        sheet.getByText('手机上显示已连接了吗？', { exact: true }).waitFor(),
      )
      expect(await sheet.getByRole('button', { name: '关闭', exact: true }).count()).toBe(0)
      // The browser force-closes a modal on a repeated Escape unless told not to, so one press proves nothing.
      for (let press = 0; press < 4; press++) {
        await page.keyboard.press('Escape')
        await page.waitForTimeout(100)
        expect(await sheet.isVisible()).toBe(true)
      }
      await sheet.getByRole('button', { name: '是的，完成', exact: true }).waitFor()
      await capture('sheet-done')
      await sheet.getByRole('button', { name: '没有，移除', exact: true }).click()
      await sheet.getByText('它已断开，之后要重新扫码才能连接。', { exact: true }).waitFor()
      await capture('sheet-removed')
      await sheet.getByRole('button', { name: '好', exact: true }).click()
      await sheet.waitFor({ state: 'hidden' })

      // No network, and a sheet that could not get a QR.
      state.pairing = { state: 'ready', offNetwork: false }
      state.create = 'no-lan'
      await connect.click()
      await sheet.getByText('这台 Mac 没有连接 Wi‑Fi 或有线网络。', { exact: true }).waitFor()
      expect(await qr.count()).toBe(0)
      await capture('sheet-nonet')
      // The network comes back: the QR appears by itself.
      state.create = 'ok'
      await qr.waitFor()
      await sheet.getByRole('button', { name: '关闭', exact: true }).click()
      await sheet.waitFor({ state: 'hidden' })
      state.create = 'failed'
      await connect.click()
      await sheet.getByRole('button', { name: '重试', exact: true }).waitFor()
      await capture('sheet-failed')
      await context.close()
    })

  describe('at desktop width', () => {
    const open = async (state: PageState) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      context.setDefaultTimeout(15_000)
      const page = await context.newPage()
      await enrollBrowser(page, testHost, { scopes: ['view', 'run', 'approve:standard', 'admin'] })
      await asDesktop(page, state)
      await page.reload()
      await connected(page)
      await openEntry(page, '手机')
      const sheet = page.getByRole('dialog', { name: '连接手机', exact: true })
      return { context, page, sheet, qr: sheet.getByAltText('原生客户端配对二维码') }
    }
    const base = (over: Partial<PageState> = {}): PageState => ({
      devices: [device('dev_phone', 'iPhone 16 Pro', 'native-direct', 1)],
      pairing: { state: 'ready', offNetwork: false },
      create: 'ok',
      relays: [],
      ...over,
    })

    it('does not say no phone is connected when the list failed to load', async () => {
      const state = base({ listFails: true })
      const { context, page } = await open(state)
      await page.getByText('读取失败', { exact: false }).waitFor()
      expect(await page.getByText('还没有别的设备连接这台 Mac。', { exact: true }).count()).toBe(0)
      state.listFails = false
      await page.locator('[data-device-id="dev_phone"]').waitFor()
      await context.close()
    })

    it('raises and lowers management, restores a device, and takes it from a phone that kept it', async () => {
      const scopes: Device['scopes'] = ['view', 'run', 'approve:standard']
      const state = base({
        patches: [],
        devices: [
          device('dev_browser', '我的浏览器', 'loopback-tcp', 1),
          { ...device('dev_review', '被降级的浏览器', 'loopback-tcp', 2), status: 'review', scopes: ['view'] },
          { ...device('dev_phone', '老 iPhone', 'native-direct', 3), scopes: [...scopes, 'admin'] },
          device('dev_new_phone', '新 iPhone', 'native-direct', 4),
          device('dev_old_mac', '换钥匙串之前的桌面端', 'unix', 5),
        ],
      })
      const { context, page } = await open(state)
      const manage = page.getByRole('switch', { name: '可以管理这台 Mac', exact: true })
      const pick = (id: string) => page.locator(`[data-device-id="${id}"] .plugin-nav-row`).click()

      await pick('dev_browser')
      await manage.click()
      await expect.poll(() => state.patches?.at(-1)).toEqual({ id: 'dev_browser', scopes: [...scopes, 'admin'] })
      await expect.poll(() => manage.getAttribute('aria-checked')).toBe('true')
      await manage.click()
      await expect.poll(() => state.patches?.at(-1)).toEqual({ id: 'dev_browser', scopes })

      await pick('dev_review')
      await page.getByRole('button', { name: '恢复使用', exact: true }).click()
      await expect.poll(() => state.patches?.at(-1)).toEqual({ id: 'dev_review', scopes: [...scopes, 'approve:elevated'] })
      await page.getByRole('button', { name: '恢复使用', exact: true }).waitFor({ state: 'hidden' })

      await pick('dev_phone')
      await manage.click()
      await expect.poll(() => state.patches?.at(-1)).toEqual({ id: 'dev_phone', scopes })
      await manage.waitFor({ state: 'hidden' })
      await pick('dev_new_phone')
      await page.getByRole('button', { name: '移除…', exact: true }).waitFor()
      expect(await manage.count()).toBe(0)

      // A desktop device left behind can only be removed, in its own words.
      await pick('dev_old_mac')
      await page.getByText('它会立即断开，之后要在那台电脑的 Latch 里重新确认才能连接。', { exact: true }).waitFor()
      expect(await manage.count()).toBe(0)
      await context.close()
    })

    it('keeps showing what happened when the next QR cannot be made', async () => {
      const state = base()
      const { context, page, sheet, qr } = await open(state)
      await page.locator('.device-connect').click()
      await qr.waitFor()
      state.create = 'failed'
      state.pairing = { state: 'contended', offNetwork: false }
      await sheet.getByRole('button', { name: '重试', exact: true }).waitFor()
      await sheet.getByText('有两台设备扫了同一个二维码，已全部取消。请重新扫码。', { exact: true }).waitFor()
      expect(await qr.count()).toBe(0)
      await page.screenshot({ path: `${OUTPUT}/sheet-contended-failed-desktop-light.png`, animations: 'disabled' })
      await context.close()
    })

    it('says connecting until a confirmation is on screen', async () => {
      const state = base()
      const { context, page, sheet, qr } = await open(state)
      await page.locator('.device-connect').click()
      await qr.waitFor()
      state.pairing = { state: 'confirming', offNetwork: false }
      await sheet.getByText('正在连接…', { exact: true }).waitFor()
      await sheet.getByText('一台设备', { exact: true }).waitFor()
      expect(await sheet.getByText('在系统窗口中确认', { exact: true }).count()).toBe(0)
      state.pairing = { state: 'confirming', device: 'iPhone 16 Pro', offNetwork: false }
      await sheet.getByText('在系统窗口中确认', { exact: true }).waitFor()
      await context.close()
    })

    it('held back, asks for no scan, gives a reason without the snapshot, and opens by itself', async () => {
      const state = base({ create: 'blocked' })
      const { context, page, sheet, qr } = await open(state)
      await page.locator('.device-connect').click()
      await sheet.getByText('有外部 Harness 的会话正在运行或等你处理', { exact: false }).waitFor()
      expect(await sheet.getByText('用 iPhone 上的 Latch 扫码', { exact: true }).count()).toBe(0)
      expect(await sheet.locator('.pair-qr').count()).toBe(0)
      await page.screenshot({ path: `${OUTPUT}/sheet-held-back-desktop-light.png`, animations: 'disabled' })
      const asked = state.created ?? 0
      await page.waitForTimeout(3500)
      expect((state.created ?? 0) - asked).toBeLessThanOrEqual(2)
      state.create = 'ok'
      await qr.waitFor()
      await context.close()
    })

    it('opens a sheet with no QR while the Mac cannot confirm, and makes one when it can', async () => {
      const state = base({ presenceDown: true })
      const { context, page, sheet, qr } = await open(state)
      await page.locator('.device-connect').click()
      await sheet.getByText('测试中的原因', { exact: false }).waitFor()
      await page.screenshot({ path: `${OUTPUT}/sheet-presence-down-desktop-light.png`, animations: 'disabled' })
      expect(state.created ?? 0).toBe(0)
      state.presenceDown = false
      await page.evaluate(() => window.dispatchEvent(new Event('online')))
      await qr.waitFor()
      await context.close()
    })

    it('asks the Host for one QR at a time', async () => {
      const state = base({ createDelay: 2500 })
      const { context, page, sheet, qr } = await open(state)
      await page.locator('.device-connect').click()
      await qr.waitFor()
      const asked = state.created ?? 0
      state.pairing = { state: 'expired', offNetwork: false }
      await page.waitForTimeout(5000)
      expect((state.created ?? 0) - asked).toBeLessThanOrEqual(2)
      expect(await sheet.isVisible()).toBe(true)
      await context.close()
    })

    it('tells a device that cannot pair where to', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      context.setDefaultTimeout(15_000)
      const page = await context.newPage()
      await enrollBrowser(page, testHost, { scopes: ['view', 'run', 'approve:standard'] })
      await openSettings(page, '手机与设备')
      await page.getByText('新设备在 studio-mini 上的 Latch 里连接：设置 › 设备。', { exact: true }).waitFor()
      await page.screenshot({ path: `${OUTPUT}/pair-elsewhere-desktop-light.png`, animations: 'disabled' })
      expect(await page.locator('.device-connect').count()).toBe(0)
      await context.close()
    })
  })
})
