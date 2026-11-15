import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, type Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { closeSettings, openEntry } from './helpers/layout.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { returnFromHomeFocus } from './helpers/workbench.ts'

describe('optional settings chunk lifecycle', () => {
  let host: TestHost
  let browser: Browser
  beforeAll(async () => {
    host = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
    browser = await chromium.launch(browserLaunchOptions())
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  it.each([390, 820, 1440])('does not mount a late private section after permission revocation at width %i', async width => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN' })
    const page = await context.newPage()
    const owner = await host.enroll({ listener: 'unix' })
    let release!: () => void
    const waiting = new Promise<void>(resolve => {
      release = resolve
    })
    let requested = false
    let privateReads = 0
    try {
      await enrollBrowser(page, host, { name: `加载设置 ${width}`, scopes: ['view', 'run', 'admin'] })
      const device = host.host.security.devices.list().find(item => item.name === `加载设置 ${width}`)!
      const draft = page.getByRole('textbox', { name: '新会话消息', exact: true })
      await draft.fill('Retain this unsent draft while settings loads')
      await returnFromHomeFocus(page)
      const resources = () =>
        page.evaluate(() =>
          performance
            .getEntriesByType('resource')
            .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
            .filter(entry => new URL(entry.name).pathname.startsWith('/link/assets/'))
            .map(entry => ({
              path: new URL(entry.name).pathname,
              transferSize: entry.transferSize,
              encodedBodySize: entry.encodedBodySize,
              decodedBodySize: entry.decodedBodySize,
              startTime: entry.startTime,
              duration: entry.duration,
              initiator: entry.initiatorType,
            })),
        )
      const initial = await resources()
      expect(initial.some(entry => /\/assets\/PluginsSettings-[^/]+\.js/u.test(entry.path))).toBe(false)
      await page.route('**/assets/PluginsSettings-*.js', async route => {
        requested = true
        await waiting
        await route.continue().catch(() => {})
      })
      page.on('request', request => {
        if (new URL(request.url()).pathname === '/link/api/plugins') privateReads++
      })
      await page.setViewportSize({ width, height: 1000 })
      const settings = page.locator('.settings-page')
      await openEntry(page, '插件')
      await expect.poll(() => requested).toBe(true)
      expect(privateReads).toBe(0)
      await owner.json(`devices/${device.id}`, { method: 'PATCH', body: { scopes: ['view', 'run'] } })
      await expect.poll(() => settings.getByRole('tab', { name: '插件', exact: true }).count()).toBe(0)
      const received = page.waitForResponse(response => /\/assets\/PluginsSettings-[^/]+\.js/u.test(new URL(response.url()).pathname))
      release()
      await (await received).finished()
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      expect(privateReads).toBe(0)
      expect(
        await settings
          .locator('.settings-content')
          .filter({ has: page.getByRole('heading', { name: '插件', exact: true }) })
          .count(),
      ).toBe(0)
      await mkdir(resolve('test-results/client-loading'), { recursive: true })
      await writeFile(
        resolve(`test-results/client-loading/network-${width}.json`),
        JSON.stringify(
          {
            scope:
              'Only /link/assets resource timing entries before opening settings and two frames after releasing the withheld plugin chunk.',
            width,
            browser: browser.version(),
            initial,
            afterRevocation: await resources(),
            privateReads,
          },
          null,
          2,
        ),
      )
      await closeSettings(settings)
      await page.setViewportSize({ width: 1440, height: 1000 })
      expect(await draft.inputValue()).toBe('Retain this unsent draft while settings loads')
    } finally {
      release()
      await context.close()
    }
  })
})
