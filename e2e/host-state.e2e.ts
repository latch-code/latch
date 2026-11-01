import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

/** The widths the banner is checked at besides the desktop one; each is a separately enrolled browser. */
const NARROW = [
  { label: 'phone', viewport: { width: 375, height: 812 }, touch: true },
  { label: 'tablet', viewport: { width: 768, height: 1024 }, touch: true },
] as const

async function openPage(browser: Browser, viewport: { width: number; height: number }, touch: boolean) {
  const context = await browser.newContext({
    viewport,
    hasTouch: touch,
    isMobile: touch,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'zh-CN',
  })
  context.setDefaultTimeout(20_000)
  return { context, page: await context.newPage() }
}

/** Captures `page` in light and then dark mode; the banner must stay inside the width in both. */
async function captureBothThemes(page: Page, name: string, banner: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.locator('.banner-region').getByText(banner, { exact: true }).waitFor()
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `test-results/${name}-${scheme}.png`, animations: 'disabled' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

describe('the Host announcing it stops answering', () => {
  let browser: Browser
  let page: Page
  let testHost: TestHost
  const contexts: BrowserContext[] = []
  const narrow: Array<{ label: string; page: Page }> = []
  const requests: string[] = []

  beforeAll(async () => {
    testHost = await startTestHost({ demo: true })
    browser = await chromium.launch(browserLaunchOptions())
    const desktop = await openPage(browser, { width: 1440, height: 900 }, false)
    contexts.push(desktop.context)
    page = desktop.page
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (path === '/link/api/events' || path === '/link/api/snapshot') requests.push(`${Date.now()} ${path}`)
    })
    await mkdir('test-results', { recursive: true })
    await enrollBrowser(page, testHost, { name: '状态测试浏览器' })
    for (const { label, viewport, touch } of NARROW) {
      const opened = await openPage(browser, viewport, touch)
      contexts.push(opened.context)
      await enrollBrowser(opened.page, testHost, { name: `状态测试 ${label}` })
      narrow.push({ label, page: opened.page })
    }
  }, 90_000)

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => {})
    await browser?.close()
    await testHost?.close()
  })

  it('shows why and since when, reconnects when the Host said to, and clears the line once it answers', async () => {
    const report = (body: unknown) => testHost.raw('unix', 'api/host/state', { method: 'POST', body })
    const banner = page.locator('.banner-region')

    // The computer goes to sleep: the page drops its stream at once and tries again after the announced 10 seconds.
    requests.length = 0
    const announced = Date.now()
    expect((await report({ state: 'sleeping' })).status).toBe(200)
    const asleep = banner.getByText(/^Mac 已休眠（\d{2}:\d{2} 起）$/u)
    await asleep.waitFor()
    await banner.getByText('Mac 唤醒后会自动重新连接。').waitFor()
    expect(await page.locator('.app-shell').getAttribute('data-connection')).toBe('reconnecting')
    await page.screenshot({ path: 'test-results/host-state-sleeping.png', animations: 'disabled' })
    // This Host never slept, so the first attempt after the wait connects and the line goes away.
    await connected(page)
    await asleep.waitFor({ state: 'detached' })
    const first = requests.find(line => line.endsWith('/link/api/events'))
    expect(Number(first!.split(' ')[0]) - announced).toBeGreaterThanOrEqual(8_000)

    // The same line on a phone, a tablet and the desktop, light and dark. Each report holds every page off for another
    // ten seconds, so each page is captured right after one.
    for (const target of [...narrow, { label: 'desktop', page }]) {
      expect((await report({ state: 'sleeping' })).status).toBe(200)
      const title = await target.page
        .locator('.banner-region')
        .getByText(/^Mac 已休眠（\d{2}:\d{2} 起）$/u)
        .textContent()
      await captureBothThemes(target.page, `host-state-sleeping-${target.label}`, title!)
    }
    // Every page dropped its stream, so each clears the line once its next attempt after the announced wait connects.
    for (const target of [page, ...narrow.map(item => item.page)]) {
      await connected(target)
      await target
        .locator('.banner-region')
        .getByText(/^电脑已休眠/u)
        .waitFor({ state: 'detached' })
    }

    // A restart said ahead: the Host's last frame names it, and the page says so instead of a generic line.
    expect((await report({ state: 'stopping', reason: 'restart' })).status).toBe(200)
    await testHost.host.close()
    await banner.getByText('Mac 上的 Latch 正在重启', { exact: true }).waitFor()
    await banner.getByText('几秒后会自动重新连接。').waitFor()
    expect(await banner.getByText('连接已中断，正在重连…', { exact: true }).count()).toBe(0)
    await page.screenshot({ path: 'test-results/host-state-restarting.png', animations: 'disabled' })
    // This Host does not come back, so the line stays while each page is captured.
    for (const target of [...narrow, { label: 'desktop', page }])
      await captureBothThemes(target.page, `host-state-restarting-${target.label}`, 'Mac 上的 Latch 正在重启')
  }, 120_000)
})

describe('a Host refusing the device after it announced a stop', () => {
  let browser: Browser
  let testHost: TestHost

  beforeAll(async () => {
    testHost = await startTestHost({ demo: true })
    browser = await chromium.launch(browserLaunchOptions())
  })

  afterAll(async () => {
    await browser?.close()
    await testHost?.close()
  })

  it('leaves the announcement for the enrollment page when the next stream attempt is refused', async () => {
    const { context, page } = await openPage(browser, { width: 1440, height: 900 }, false)
    try {
      await enrollBrowser(page, testHost, { name: '撤销测试浏览器' })
      const device = testHost.host.security.devices.list().find(item => item.name === '撤销测试浏览器')!
      expect((await testHost.raw('unix', 'api/host/state', { method: 'POST', body: { state: 'sleeping' } })).status).toBe(200)
      const asleep = page.locator('.banner-region').getByText(/^Mac 已休眠（\d{2}:\d{2} 起）$/u)
      await asleep.waitFor()
      // Revoked while the page waits out the announced ten seconds: the next stream attempt gets 401 device-revoked.
      expect((await testHost.raw('unix', `api/devices/${device.id}`, { method: 'DELETE' })).status).toBe(200)
      await page.getByRole('heading', { name: '连接到 Latch', exact: true }).waitFor({ timeout: 30_000 })
      await page.getByText('这台设备已被移除。要继续使用，请重新连接。', { exact: true }).first().waitFor()
      expect(await asleep.count()).toBe(0)
    } finally {
      await context.close()
    }
  }, 60_000)
})
