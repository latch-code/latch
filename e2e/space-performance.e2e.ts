import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { chromium, type Locator, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'

/** Measures frames after a real click, excluding Playwright's wait for a clickable button. */
async function switchConversation(page: Page, control: Locator, text: string) {
  const timed = control.evaluate(
    (button, message) =>
      new Promise<{ switchMs: number; transcriptMs: number }>((resolve, reject) => {
        button.addEventListener(
          'click',
          event => {
            const start = event.timeStamp
            let selectedAt: number | undefined
            function measure() {
              const elapsed = performance.now() - start
              if (selectedAt === undefined && button.getAttribute('aria-checked') === 'true') selectedAt = elapsed
              if (selectedAt !== undefined && document.querySelector('.transcript-shell')?.textContent?.includes(message)) {
                const switchMs = selectedAt
                requestAnimationFrame(() => resolve({ switchMs, transcriptMs: performance.now() - start }))
              } else if (elapsed > 10_000) reject(new Error('The destination conversation did not appear'))
              else requestAnimationFrame(measure)
            }
            requestAnimationFrame(measure)
          },
          { capture: true, once: true },
        )
        button.setAttribute('data-measuring-switch', '')
      }),
    text,
  )
  await page.locator('[data-measuring-switch]').waitFor({ state: 'attached' })
  await control.click()
  const result = await timed
  await control.evaluate(button => button.removeAttribute('data-measuring-switch'))
  return result
}

/** Keydown to the task after the next animation frame, as in the backdrop benchmark. */
async function measureTyping(page: Page) {
  const editor = page.locator('.composer-stack .cm-content:visible').first()
  await editor.focus()
  const text = 'abcdefghijklmnopqrstuvwx'
  const measured = editor.evaluate(
    (element, count) =>
      new Promise<number[]>(resolve => {
        const samples: number[] = []
        const onKey = (event: Event) => {
          const at = event.timeStamp
          requestAnimationFrame(() =>
            setTimeout(() => {
              samples.push(performance.now() - at)
              if (samples.length === count) {
                element.removeEventListener('keydown', onKey)
                resolve(samples)
              }
            }, 0),
          )
        }
        element.addEventListener('keydown', onKey)
        element.setAttribute('data-measuring-typing', '')
      }),
    text.length,
  )
  await page.locator('[data-measuring-typing]').waitFor({ state: 'attached' })
  await page.keyboard.type(text, { delay: 80 })
  await expect.poll(() => editor.textContent()).toBe(text)
  return measured
}

it.skipIf(process.env.LATCH_SPACE_BENCH !== '1')(
  'measures switching between two open conversations and typing beside 60 Code sessions',
  async () => {
    const host = await startTestHost()
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const codePrompt = '性能样本 Code 会话'
      const generalPrompt = '性能样本通用会话'
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), prompt: codePrompt, mode: 'chat' },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + sessionId)).summary.status).toBe('idle')
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
      let snapshots = 0,
        details = 0
      page.on('request', request => {
        const path = new URL(request.url()).pathname
        if (path === '/link/api/snapshot') snapshots++
        if (/^\/link\/api\/tasks\/[^/]+$/u.test(path) && request.method() === 'GET') details++
      })
      // Only the filler sidebar rows are synthesized. Both open chats, reads, writes and event streams use the test Host.
      await page.route('**/link/api/snapshot*', async route => {
        const response = await route.fetch()
        const snapshot = (await response.json()) as AppSnapshot
        const source = snapshot.tasks?.find(task => task.id === sessionId)
        if (!source) return route.fulfill({ response })
        const rows = Array.from({ length: 59 }, (_, i) => ({ ...source, id: 'fixture-' + i, title: '已完成的会话 ' + i }))
        return route.fulfill({ response, json: { ...snapshot, tasks: [...snapshot.tasks, ...rows] } })
      })
      await enrollBrowser(page, host, { name: '交互验收' })
      const device = host.host.security.devices.list().find(device => device.name === '交互验收')!
      expect((await owner.confirmed('devices/' + device.id, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await page.reload()
      await connected(page)
      await page.locator('#session-navigation [data-task-id="' + sessionId + '"]').click()
      const transcript = page.locator('.transcript-shell')
      await transcript.getByText(codePrompt, { exact: true }).first().waitFor()
      const control = (name: string) => page.getByRole('radio', { name, exact: true }).filter({ visible: true }).first()
      await control('我的 Agent').click()
      await page.getByRole('navigation', { name: '我的 Agent', exact: true }).locator('[data-agent-id="general"]').first().click()
      const input = page.getByRole('textbox', { name: '给通用发消息', exact: true })
      await input.fill(generalPrompt)
      await input.press('Meta+Enter')
      await transcript.getByText(generalPrompt, { exact: true }).first().waitFor()
      await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.generalChat)?.status).toBe('idle')

      const samples = []
      const heap = []
      const soak = process.env.LATCH_SPACE_SOAK === '1'
      const cdp = soak ? await page.context().newCDPSession(page) : undefined
      for (let i = 0; i < (soak ? 112 : 16); i++) {
        const code = i % 2 === 0
        const space = code ? 'Code' : '我的 Agent'
        await page.waitForTimeout(250)
        snapshots = 0
        details = 0
        const result = await switchConversation(page, control(space), code ? codePrompt : generalPrompt)
        await page.waitForTimeout(250)
        const rows = page.locator('#session-navigation .session-item')
        if (code) expect(await rows.count()).toBe(60)
        samples.push({ space, ...result, snapshots, details, hiddenMenuItems: await rows.locator('[role^="menuitem"]').count() })
        // Sample on the same space after warm-up. Explicit GC keeps garbage awaiting collection out of the comparison.
        if (cdp && (i + 1) % 32 === 16) {
          await cdp.send('HeapProfiler.collectGarbage')
          const { usedSize } = await cdp.send('Runtime.getHeapUsage')
          const { nodes, jsEventListeners } = await cdp.send('Memory.getDOMCounters')
          heap.push({ switches: i + 1, usedSize, nodes, jsEventListeners })
        }
      }
      await control('Code').click()
      await transcript.getByText(codePrompt, { exact: true }).first().waitFor()
      const keys = await measureTyping(page)
      const label = process.env.LATCH_SPACE_LABEL ?? 'local'
      if (!/^[a-z0-9-]{1,48}$/u.test(label)) throw new Error('Invalid benchmark label')
      const output = 'test-results/space-performance'
      await mkdir(output, { recursive: true })
      await writeFile(join(output, label + '.json'), JSON.stringify({ keys, samples, ...(soak ? { heap } : {}) }, null, 2) + '\n')
    } finally {
      await browser.close()
      await host.close()
    }
  },
  process.env.LATCH_SPACE_SOAK === '1' ? 300_000 : 120_000,
)
