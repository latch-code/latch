import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { TestDevice } from '@latch/testkit'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { backToPhoneSessions, closeSettings, openSection, openSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/code-root'
const NOTICE = '在程序目录里，每次写入都问你'

/**
 * A Host whose start directory lies inside Latch's program directory (here a temporary stand-in for it): the three
 * places that show the folder warn before the first write asks, at desktop and phone width.
 */
describe('a start directory inside Latch’s program directory', () => {
  let root: string
  let testHost: TestHost
  let browser: Browser
  let context: BrowserContext
  let remote: TestDevice
  let sessionId: string

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'latch-code-root-')))
    await mkdir(join(root, 'repo'))
    testHost = await startTestHost({
      demo: true,
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
      codeRoot: root,
      workspaceRoot: join(root, 'repo'),
    })
    browser = await chromium.launch(browserLaunchOptions())
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    context.setDefaultTimeout(15_000)
    const enrolling: Page = await context.newPage()
    await enrollBrowser(enrolling, testHost, { name: '验收浏览器', scopes: ['admin'] })
    await enrolling.close()
    remote = await testHost.enroll({ name: '另一台浏览器' })
    const created = await remote.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '你好', requestId: randomUUID(), mode: 'agent', model: { providerId: 'demo', model: 'demo' } },
    })
    sessionId = created.sessionId
    for (let tries = 0; (await remote.json<TaskDetail>(`tasks/${encodeURIComponent(sessionId)}`)).summary.status !== 'idle'; tries++) {
      if (tries > 100) throw new Error('the demo reply did not settle')
      await new Promise(done => setTimeout(done, 100))
    }
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await testHost?.close()
    if (root) await rm(root, { recursive: true, force: true })
  })

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'phone', width: 390, height: 844 },
  ] as const) {
    it(`warns in 设置 › 项目, the new session and the session at ${viewport.name} width`, async () => {
      // Each width on a page of its own that starts at that width, as a person opening Latch there would.
      const page = await context.newPage()
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto(`${testHost.host.loopbackOrigin}/link/`)
      await connected(page)

      // 设置 › 项目: the start directory's card warns and offers no fix it cannot make (a browser cannot add projects).
      const settings = await openSettings(page)
      await openSection(settings, '项目')
      const notice = settings.locator('.project-code-root')
      await notice.getByText(NOTICE, { exact: false }).waitFor()
      expect(await notice.getAttribute('data-tone')).toBe('warn')
      expect(await notice.textContent()).toContain('Latch 启动时的文件夹')
      await page.screenshot({ path: `${OUTPUT}/settings-projects--${viewport.name}.png`, fullPage: true, animations: 'disabled' })
      await closeSettings(settings)

      // The new session: the composer says it before anything is sent.
      await backToPhoneSessions(page)
      await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
      await page.locator('.composer-notice', { hasText: NOTICE }).waitFor()
      await page.screenshot({ path: `${OUTPUT}/new-session--${viewport.name}.png`, fullPage: true, animations: 'disabled' })

      // The session that works there: the project's popover, and the panel's page on a phone.
      if (viewport.name === 'phone') {
        await page.getByRole('dialog', { name: '新会话', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
        await page.locator('.phone-list').locator(`[data-task-id="${sessionId}"]`).click()
      } else await page.locator(`[data-task-id="${sessionId}"]`).first().click()
      // The conversation is read in, so the capture shows it beside the warning rather than the loading line.
      await page.locator('.transcript [data-message-id]').filter({ hasText: '你好' }).first().waitFor()
      if (viewport.name === 'phone') await page.getByRole('button', { name: '侧边面板', exact: true }).click()
      else await page.locator('.topbar-crumb-button').click()
      await page.getByText(NOTICE, { exact: false }).last().waitFor()
      await page.screenshot({ path: `${OUTPUT}/session-info--${viewport.name}.png`, fullPage: true, animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.screenshot({ path: `${OUTPUT}/session-info--${viewport.name}--dark.png`, fullPage: true, animations: 'disabled' })
      await page.close()
    })
  }
})
