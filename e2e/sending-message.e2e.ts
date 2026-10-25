import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { expect, test } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'

test('shows immediate text, delays delivery wording and retries an uncertain input with the same identity on three widths', async () => {
  const host = await startTestHost({ uiDir: resolve('dist/web') }),
    browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    for (const width of [1440, 768, 390]) {
      const title = `发送状态 ${width}`
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: title, requestId: randomUUID() },
      })
      const path = `tasks/${sessionId}`
      await expect.poll(async () => (await owner.json<TaskDetail>(path)).summary.status).toBe('idle')
      const context = await browser.newContext({
          viewport: { width, height: 960 },
          colorScheme: width === 390 ? 'dark' : 'light',
          reducedMotion: 'reduce',
        }),
        page = await context.newPage()
      await enrollBrowser(page, host, { name: `发送 ${width}` })
      await page.keyboard.press('Meta+k')
      const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
      await palette.getByRole('searchbox').fill(title)
      await palette.getByRole('option', { name: title, exact: true }).click()
      let release!: () => void
      const delayed = new Promise<void>(resolve => {
          release = resolve
        }),
        requests: Array<{ prompt: string; requestId: string }> = []
      let count = 0
      await page.route(`**/link/api/${path}/prompt`, async route => {
        count++
        requests.push(route.request().postDataJSON() as { prompt: string; requestId: string })
        if (count === 1) {
          await delayed
          await route.continue()
        } else if (count === 2) await route.abort('failed')
        else await route.continue()
      })
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      const text = `慢请求 ${width}`
      await input.fill(text)
      await input.press('Enter')
      const pending = page.locator('.sending-message')
      await expect.poll(() => pending.isVisible()).toBe(true)
      expect(await pending.getByText(text, { exact: true }).isVisible()).toBe(true)
      await expect.poll(() => pending.getByText('发送中…', { exact: true }).isVisible()).toBe(true)
      expect((await owner.json<TaskDetail>(path)).messages.filter(message => message.text === text)).toEqual([])
      await page.screenshot({ path: `test-results/sending-${width}.png`, fullPage: true })
      release()
      await expect.poll(async () => (await owner.json<TaskDetail>(path)).messages.some(message => message.text === text)).toBe(true)
      await expect.poll(async () => (await owner.json<TaskDetail>(path)).summary.status).toBe('idle')
      await expect.poll(() => pending.count()).toBe(0)
      expect(await page.locator('.user-bubble').getByText(text, { exact: true }).count()).toBe(1)
      await expect.poll(() => page.getByRole('button', { name: '发送', exact: true }).isVisible()).toBe(true)
      const unknown = `断线后的提交 ${width}`
      await input.fill(unknown)
      await input.press('Enter')
      await expect.poll(() => pending.getByText('未确认送达', { exact: false }).isVisible()).toBe(true)
      expect((await owner.json<TaskDetail>(path)).messages.some(message => message.text === unknown)).toBe(false)
      await page.screenshot({ path: `test-results/sending-unknown-${width}.png`, fullPage: true })
      expect(await page.getByRole('button', { name: '重试这次提交', exact: true }).count()).toBe(1)
      await page.getByRole('button', { name: '重试这次提交', exact: true }).click()
      await expect.poll(() => requests.length).toBe(3)
      expect(requests[2]).toEqual(requests[1])
      await expect
        .poll(async () => (await owner.json<TaskDetail>(path)).messages.filter(message => message.text === unknown).length)
        .toBe(1)
      await expect.poll(() => pending.count()).toBe(0)
      expect(await page.locator('.user-bubble').getByText(unknown, { exact: true }).count()).toBe(1)
      await context.close()
    }
  } finally {
    await browser.close()
    await host.close()
  }
}, 60_000)
