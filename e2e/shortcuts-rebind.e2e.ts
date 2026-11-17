import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ShortcutsState } from '@latch/protocol'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { closeSettings, openSection, openSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/shortcuts-rebind'

describe('rebinding a shortcut in a browser', { timeout: 120_000 }, () => {
  let host: TestHost
  let browser: Browser

  beforeAll(async () => {
    host = await startTestHost({ demo: true, uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
    await host.enroll({ listener: 'unix', name: '本机桌面端' })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  async function open(width: number, theme: 'light' | 'dark' = 'light'): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', locale: 'zh-CN' })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    await enrollBrowser(page, host, { name: `改键 ${width} ${theme}`, scopes: ['view', 'run'] })
    return { context, page }
  }

  const palette = (page: Page) => page.getByRole('dialog', { name: '命令面板', exact: true })

  it('records new keys, refuses taken ones by name, answers the new keys after a reload, and resets', async () => {
    const { context, page } = await open(1440)
    try {
      const settings = await openSettings(page)
      await openSection(settings, '快捷键')
      const row = settings.locator('.shortcut-row', { hasText: '搜索' }).first()
      await row.getByRole('button', { name: '改「搜索」的快捷键', exact: true }).click()
      await row.getByRole('status').getByText('按下新的组合键').waitFor()
      // Alt B is 收起或展开侧栏's: refused with its name, still recording.
      await page.keyboard.press('Alt+KeyB')
      await row.getByText('已用于「收起或展开侧栏」').waitFor()
      await page.keyboard.press('Control+KeyT')
      await row.getByText('浏览器保留').waitFor()
      await page.screenshot({ path: join(OUTPUT, 'recording-refused.png'), animations: 'disabled' })
      await page.keyboard.press('Alt+KeyY')
      await row.locator('[data-keys="Alt Y"]').waitFor()
      await closeSettings(settings)

      // The new keys open the palette; the old ones no longer do.
      await page.keyboard.press('Alt+KeyY')
      await palette(page).waitFor()
      await page.keyboard.press('Escape')
      await palette(page).waitFor({ state: 'detached' })
      await page.keyboard.press('Control+KeyK')
      await page.waitForTimeout(300)
      expect(await palette(page).count()).toBe(0)

      // Kept by the Host for this device: a reload reads them back.
      await page.reload()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      const state = await page.evaluate(() => fetch('/link/api/shortcuts').then(response => response.json() as Promise<ShortcutsState>))
      expect(state.doc).toEqual({ schema: 1, client: 'browser', bindings: { palette: 'Alt+KeyY' } })
      await page.keyboard.press('Alt+KeyY')
      await palette(page).waitFor()
      await page.keyboard.press('Escape')

      const again = await openSettings(page)
      await openSection(again, '快捷键')
      await again.getByRole('button', { name: '全部恢复默认', exact: true }).click()
      await again.locator('.shortcut-row', { hasText: '搜索' }).first().locator('[data-keys="⌘K"], [data-keys="Ctrl K"]').waitFor()
      await closeSettings(again)
      await page.keyboard.press('Control+KeyK')
      await palette(page).waitFor()
    } finally {
      await context.close()
    }
  })

  it('captures 设置 › 快捷键 recording a refused key at each width', async () => {
    for (const [width, theme] of [
      [1440, 'light'],
      [1440, 'dark'],
      [820, 'light'],
    ] as const) {
      const { context, page } = await open(width, theme)
      try {
        const settings = await openSettings(page)
        await openSection(settings, '快捷键')
        const row = settings.locator('.shortcut-row', { hasText: '额度与用量' }).first()
        await row.getByRole('button', { name: '改「额度与用量」的快捷键', exact: true }).click()
        await page.keyboard.press('Alt+KeyN')
        await row.getByText('已用于「新会话」').waitFor()
        await row.scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(OUTPUT, `shortcuts-recording-${width}-${theme}.png`), animations: 'disabled' })
        await page.keyboard.press('Escape')
      } finally {
        await context.close()
      }
    }
    // A phone has no 设置 › 快捷键 (no keyboard to rebind); its settings list is captured to show it.
    const { context, page } = await open(390)
    try {
      await openSettings(page)
      await page.screenshot({ path: join(OUTPUT, 'shortcuts-phone-390-light.png'), animations: 'disabled' })
    } finally {
      await context.close()
    }
  })
})
