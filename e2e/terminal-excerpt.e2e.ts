import { chromium, type Browser, type Locator } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { recordClipboardWrites } from './helpers/clipboard.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession, reachable } from './helpers/layout.ts'
import { promptValue, setPromptSelection } from './helpers/prompt.ts'

const output = 'test-results/terminal-excerpt'
const label = '终端 1 · 最近报错'
const original = ['请帮我定位这条报错。', '', label, '```text', 'TypeError: task is undefined', '    at render (app.ts:5:2)', '```'].join(
  '\n',
)

describe('an editable terminal error in the composer and sent history', () => {
  let host: TestHost
  let browser: Browser
  beforeAll(async () => {
    host = await startTestHost()
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(output, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  it.each([
    [390, 844],
    [768, 1024],
    [1440, 900],
  ])('renders the draft and the sent quotation in both themes at %i × %i', async (width, height) => {
    const context = await browser.newContext({
      viewport: { width, height },
      locale: 'zh-CN',
      hasTouch: width < 1024,
      isMobile: width < 1024,
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    try {
      const { sessionId } = await host.host.bridge.createTask({
        requestId: randomUUID(),
        prompt: '检查运行结果',
        mode: 'chat',
        model: { providerId: 'demo', model: 'demo' },
      })
      await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status).toBe('idle')
      await enrollBrowser(page, host)
      await openSession(page, sessionId)
      const copied = await recordClipboardWrites(page)
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      const composer = page.locator('form.composer').filter({ has: input })
      // A previously copied terminal excerpt retains its recorded format when pasted into a different device's composer.
      await input.focus()
      await input.evaluate((element, text) => {
        const data = new DataTransfer()
        data.setData('text/plain', text)
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      }, original)
      await expect.poll(() => promptValue(input)).toBe(original)
      await input.locator('.terminal-excerpt-heading').filter({ hasText: label }).waitFor()
      const word = original.indexOf('task')
      await setPromptSelection(input, word, word + 'task'.length)
      await page.keyboard.insertText('result')
      const edited = original.replace('task', 'result')
      await expect.poll(() => promptValue(input)).toBe(edited)
      await input.locator('.terminal-excerpt-body').filter({ hasText: 'TypeError: result is undefined' }).waitFor()
      expect(await input.innerText()).not.toContain('```')
      const screenshots = async (state: string, surface: Locator) => {
        for (const theme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: theme })
          await noHorizontalOverflow(page, surface)
          await surface.screenshot({ path: `${output}/${state}-${width}-${theme}.png`, animations: 'disabled', caret: 'hide' })
        }
      }
      await screenshots('draft', composer)
      const send = composer.getByRole('button', { name: '发送', exact: true })
      await reachable(send)
      await send.click()
      // The optimistic bubble is replaced by the Host's message while the demo reply streams.
      const messageId = await vi.waitFor(
        async () => {
          const detail = await host.host.bridge.detail(sessionId)
          const sent = detail.messages.find(item => item.role === 'user' && item.text === edited)
          if (!sent || detail.summary.status !== 'idle') throw new Error('Waiting for the confirmed message')
          return sent.id
        },
        { timeout: 15_000 },
      )
      const message = page.locator(`.message-user[data-message-id="${messageId}"]`)
      const bubble = message.locator('.user-bubble')
      const excerpt = bubble.locator('.sent-terminal-excerpt')
      await excerpt.locator('figcaption').filter({ hasText: label }).waitFor()
      expect(await excerpt.locator('pre').textContent()).toBe('TypeError: result is undefined\n    at render (app.ts:5:2)')
      expect(await bubble.innerText()).not.toContain('```')
      await screenshots('sent', bubble)
      if (width < 1024) await bubble.tap()
      else await bubble.hover()
      await message.getByRole('button', { name: '复制', exact: true }).click()
      expect(await copied()).toEqual([edited])
    } finally {
      await context.close()
    }
  })
})
