import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium, type Browser, type Page } from '@playwright/test'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { leaveHomeFocus } from './helpers/layout.ts'
import { homeInput } from './helpers/workbench.ts'

let host: TestHost
let browser: Browser

beforeAll(async () => {
  host = await startTestHost({ demo: true })
  browser = await chromium.launch(browserLaunchOptions())
})

afterAll(async () => {
  await browser?.close()
  await host?.close()
})

/** A session with one finished turn, opened in a new browser of this Host. */
async function openSession(title: string): Promise<{ page: Page; sessionId: string; close: () => Promise<void> }> {
  const owner = await host.enroll({ listener: 'unix' })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { requestId: randomUUID(), prompt: title, mode: 'chat' },
  })
  await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status, { timeout: 10_000 }).toBe('idle')
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  await enrollBrowser(page, host, { scopes: ['view', 'run'] })
  await page.keyboard.press('Meta+k')
  const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
  await palette.getByRole('searchbox').fill(title)
  await palette.getByRole('option', { name: title, exact: true }).click()
  return { page, sessionId, close: () => context.close() }
}

/** The page now, light and dark, at its width and at a phone's, for acceptance. */
async function shots(page: Page, name: string): Promise<void> {
  await mkdir('test-results/offline-send', { recursive: true })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width > 400 ? 900 : 844 })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(300)
      await page.screenshot({ path: `test-results/offline-send/${name}--${width}--${scheme}.png`, animations: 'disabled' })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
}

const userTexts = async (sessionId: string) =>
  ((await host.host.bridge.detail(sessionId)) as TaskDetail).messages
    .filter(message => message.role === 'user')
    .map(message => message.text)

it('keeps the text an editable draft while this device is offline: Enter sends nothing, as the button', async () => {
  const { page, sessionId, close } = await openSession('离线草稿')
  try {
    const posts: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/tasks(?:\/[^/]+\/prompt)?$/u.test(new URL(request.url()).pathname))
        posts.push(request.url())
    })
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('离线时写的')
    await page.context().setOffline(true)
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-connection')).toBe('offline')
    const send = page.getByRole('button', { name: '发送', exact: true }).last()
    expect(await send.getAttribute('aria-disabled')).toBe('true')
    await input.press('Enter')
    await send.click({ force: true })
    await page.waitForTimeout(500)
    expect(posts).toEqual([])
    expect(await page.getByText('未确认送达', { exact: true }).count()).toBe(0)
    expect(await input.isEditable()).toBe(true)
    await shots(page, 'offline-draft')
    await input.fill('离线时改过的')
    await page.context().setOffline(false)
    await connected(page)
    await input.press('Enter')
    await expect.poll(() => userTexts(sessionId), { timeout: 10_000 }).toEqual(['离线草稿', '离线时改过的'])
  } finally {
    await close()
  }
})

it('says the device is offline on an unconfirmed send, and checks it with the Host by itself once back', async () => {
  const { page, sessionId, close } = await openSession('离线核对')
  try {
    const requestIds: string[] = []
    await page.route(`**/link/api/tasks/${sessionId}/prompt`, async route => {
      requestIds.push((route.request().postDataJSON() as { requestId: string }).requestId)
      // The first try is lost on the way: nothing proves it reached the Host.
      if (requestIds.length === 1) await route.abort('failed')
      else await route.continue()
    })
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('先没送到的')
    await input.press('Enter')
    await page.getByRole('button', { name: '重试这次提交', exact: true }).waitFor()
    // Another input can be written meanwhile; nothing else is sent until this one ends.
    await page.getByRole('button', { name: '总览', exact: true }).click()
    const home = homeInput(page)
    expect(await home.isEditable()).toBe(true)
    await home.fill('等上一条确认时写的')
    expect(await page.locator('.workbench-home').getByRole('button', { name: '发送', exact: true }).getAttribute('aria-disabled')).toBe(
      'true',
    )
    await leaveHomeFocus(page)
    await page.getByRole('button', { name: '打开', exact: true }).first().click()
    await page.getByRole('button', { name: '重试这次提交', exact: true }).waitFor()
    await page.context().setOffline(true)
    await page.getByText('这台设备没有联网', { exact: true }).filter({ visible: true }).first().waitFor()
    expect(await userTexts(sessionId)).toEqual(['离线核对'])
    await shots(page, 'offline-unconfirmed')
    await page.context().setOffline(false)
    // No button pressed: the same request goes again once the connection is back.
    await expect.poll(() => userTexts(sessionId), { timeout: 15_000 }).toEqual(['离线核对', '先没送到的'])
    await page.getByRole('button', { name: '重试这次提交', exact: true }).waitFor({ state: 'detached' })
    expect(requestIds).toHaveLength(2)
    expect(new Set(requestIds).size).toBe(1)
    await expect.poll(() => input.isEditable()).toBe(true)
  } finally {
    await close()
  }
})
