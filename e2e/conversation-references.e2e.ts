import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { openSession } from './helpers/layout.ts'
import { promptValue } from './helpers/prompt.ts'

it.each([
  { width: 1440, height: 960 },
  { width: 820, height: 1180 },
  { width: 390, height: 844 },
])('references authorized work and returns to a quoted passage at $width px', async ({ width, height }) => {
  const host = await startTestHost({
    providerId: 'reference-ui',
    plugins: [
      {
        id: 'reference-fixture',
        name: 'References',
        version: '1',
        description: '',
        activate(context) {
          context.registerProvider({
            id: 'reference-ui',
            name: 'References',
            model: 'fake',
            async *stream() {
              yield { type: 'text', text: 'First result. Keep the original revision. Last result.' }
              yield { type: 'finish', reason: 'stop' }
            },
          })
        },
      },
    ],
  })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    async function start(prompt: string) {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), prompt, workspaceId: 'default', mode: 'agent' },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
      return sessionId
    }
    const source = await start('Earlier investigation')
    const target = await start('Resume work')
    await owner.json(`tasks/${source}`, { method: 'PATCH', body: { title: 'Last week review' } })
    const page = await browser.newPage({
      viewport: { width, height },
      colorScheme: width === 390 ? 'dark' : 'light',
      reducedMotion: 'reduce',
    })
    page.setDefaultTimeout(10000)
    const shots = 'test-results/conversation-references'
    await mkdir(shots, { recursive: true })
    const capture = async (step: string, prepare?: () => Promise<void>) => {
      await prepare?.()
      await page.screenshot({ path: `${shots}/${step}-${width}.png`, animations: 'disabled' })
    }
    await enrollBrowser(page, host, { name: '会话上下文' })
    await openSession(page, target)
    await page.locator('.attachment-button:visible').click()
    await page.getByText('引用另一条会话', { exact: true }).click()
    const picker = page.getByRole('dialog', { name: '引用另一条会话' })
    await picker.getByRole('searchbox', { name: '搜索会话标题' }).fill('week')
    await capture('picker', () => picker.getByRole('button', { name: 'Last week review' }).waitFor())
    await picker.getByRole('button', { name: 'Last week review' }).click()
    const input = page.locator('.composer .cm-content:visible')
    await expect.poll(() => promptValue(input)).toContain('[conversation-ref:')
    expect(await promptValue(input)).not.toContain('Keep the original revision.')
    await input.locator('.prompt-chip[data-kind=conversation] .prompt-chip-label').filter({ hasText: 'Last week review' }).waitFor()
    await capture('draft', () => input.locator('.prompt-chip[data-kind=conversation]').waitFor())
    await input.press('Meta+Enter')
    await expect
      .poll(async () =>
        (await owner.json<TaskDetail>(`tasks/${target}`)).messages.some(m => m.role === 'user' && m.text.includes('[conversation-ref:')),
      )
      .toBe(true)
    await page
      .locator('.message-assistant:not(.is-live) .message-text p')
      .first()
      .evaluate(node => {
        const text = node.firstChild!
        const quoteStart = text.textContent!.indexOf('Keep')
        const range = document.createRange()
        range.setStart(text, quoteStart)
        range.setEnd(text, quoteStart + 'Keep the original revision.'.length)
        const selection = document.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
      })
    // A new reply can scroll the transcript just after selection. The selection and its action must survive.
    await page.locator('.reply-quote-action').waitFor({ timeout: 5000 })
    await page.locator('.transcript:visible').first().dispatchEvent('scroll')
    await page.getByRole('button', { name: '引用这句话', exact: true }).click()
    await expect.poll(() => promptValue(input)).toContain('> Keep the original revision.')
    await input.locator('.prompt-chip[data-kind=quote]').waitFor()
    await input.press('Meta+Enter')
    const sourceLink = page.getByRole('button', { name: '查看引用原文', exact: true }).first()
    await sourceLink.waitFor()
    await page.reload()
    await sourceLink.click()
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe('Keep the original revision.')
    await capture('passage', async () => {
      await sourceLink.click()
      await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe('Keep the original revision.')
    })
  } finally {
    await browser.close()
    await host.close()
  }
})
