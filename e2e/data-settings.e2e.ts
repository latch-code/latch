import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openSection, openSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/data-settings'

describe('设置 › 数据 and 安全记录 in a browser', { timeout: 180_000 }, () => {
  let host: TestHost
  let browser: Browser

  beforeAll(async () => {
    host = await startTestHost({ demo: true, uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
    const desktop = await host.enroll({ listener: 'unix', name: '本机桌面端' })
    // Something to read: a memory written by the desktop app, and a device renamed.
    await desktop.json('custom-agents/general/memories', { method: 'POST', body: { requestId: randomUUID(), content: '喜欢简短的回答' } })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  async function open(
    width: number,
    theme: 'light' | 'dark' = 'light',
    access: { scopes: Array<'view' | 'run' | 'admin'>; dataScope: 'work' | 'all' } = { scopes: ['view', 'run', 'admin'], dataScope: 'all' },
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme,
      reducedMotion: 'reduce',
      locale: 'zh-CN',
    })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    await enrollBrowser(page, host, { name: `数据 ${width} ${theme}`, ...access })
    return { context, page }
  }

  it('lists what is kept, where and for how long, counts sizes once, and has no export in a browser', async () => {
    for (const [width, theme] of [
      [1440, 'light'],
      [1440, 'dark'],
      [820, 'light'],
      [390, 'light'],
    ] as const) {
      const { context, page } = await open(width, theme)
      try {
        const settings = await openSettings(page)
        await openSection(settings, '数据')
        await settings.getByText('数据目录', { exact: true }).waitFor()
        await settings.getByText(host.dataDir).first().waitFor()
        await settings.getByRole('button', { name: /^安全记录/u }).waitFor()
        await settings.getByText('一直保留').first().waitFor()
        await settings.getByText('明细 90 天，按月删去更早的；单价与预算一直保留').waitFor()
        await settings.locator('.data-size').first().waitFor()
        await settings.getByText(/统计于/u).waitFor()
        // 导出全部 is the desktop app's: a browser does not offer it.
        expect(await settings.getByText('导出全部').count()).toBe(0)
        await page.screenshot({ path: join(OUTPUT, `data-${width}-${theme}.png`), animations: 'disabled', fullPage: true })
      } finally {
        await context.close()
      }
    }
  })

  it('reads the audit log by kind and by who, a page at a time, with no hash in sight', async () => {
    for (const [width, theme] of [
      [1440, 'light'],
      [1440, 'dark'],
      [820, 'light'],
      [390, 'light'],
    ] as const) {
      const { context, page } = await open(width, theme)
      try {
        const settings = await openSettings(page)
        await openSection(settings, '数据')
        await settings.getByRole('button', { name: /安全记录/u }).click()
        const list = page.getByRole('list', { name: '安全记录' })
        await list.locator('.audit-row').first().waitFor()
        expect(await list.locator('.audit-row').count()).toBeGreaterThan(2)
        // By kind: only 设备与连接.
        await page.getByRole('button', { name: '全部类别' }).click()
        await page
          .getByRole('menuitemradio', { name: '设备与连接' })
          .or(page.getByRole('menuitem', { name: '设备与连接' }))
          .click()
        await expect.poll(() => list.locator('.audit-row', { hasText: '修改 Agent 或记忆' }).count()).toBe(0)
        await list.getByText('设备已连接').first().waitFor()
        // By who: the desktop app wrote the memory.
        await page.getByRole('button', { name: '设备与连接' }).click()
        await page
          .getByRole('menuitemradio', { name: '全部类别' })
          .or(page.getByRole('menuitem', { name: '全部类别' }))
          .click()
        await page.getByRole('button', { name: '所有人' }).click()
        await page
          .getByRole('menuitemradio', { name: '本机桌面端' })
          .or(page.getByRole('menuitem', { name: '本机桌面端' }))
          .click()
        const memory = list.locator('.audit-row', { hasText: '修改 Agent 或记忆' }).first()
        await memory.waitFor()
        await memory.locator('summary').click()
        await memory.locator('.audit-fields').getByText('agent.changed').waitFor()
        const text = (await list.textContent()) ?? ''
        expect(text).not.toMatch(/[0-9a-f]{64}/u)
        expect(text).not.toContain('喜欢简短的回答')
        await page.screenshot({ path: join(OUTPUT, `audit-${width}-${theme}.png`), animations: 'disabled', fullPage: true })
      } finally {
        await context.close()
      }
    }
  })

  it('is not there for a device that may not read everything', async () => {
    const { context, page } = await open(1440, 'light', { scopes: ['view', 'run', 'admin'], dataScope: 'work' })
    try {
      const settings = await openSettings(page)
      await settings.getByRole('tab', { name: '通用' }).waitFor()
      expect(await settings.getByRole('tab', { name: '数据' }).count()).toBe(0)
      const refused = await page.evaluate(() => fetch('/link/api/audit/records').then(response => response.status))
      expect(refused).toBe(403)
    } finally {
      await context.close()
    }
  })
})
