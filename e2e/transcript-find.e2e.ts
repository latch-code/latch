import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'
import { promptValue } from './helpers/prompt.ts'

it('finds never-opened tool output, opens both disclosures, highlights each match and preserves the draft at three widths', async () => {
  let calls = 0
  const plugin: HarnessPlugin = {
    id: 'find-model',
    name: 'Find fixture',
    description: '',
    version: '1',
    activate(context) {
      context.registerProvider({
        id: 'find-model',
        name: 'Find fixture',
        model: 'fixture',
        async *stream({ messages }) {
          calls++
          if (messages.at(-1)?.role !== 'tool') {
            yield { type: 'tool-call', call: { id: 'read-for-find', name: 'read_file', arguments: { path: 'report.txt' } } }
            yield { type: 'finish', reason: 'tool-calls' }
          } else {
            yield { type: 'text', text: '已完成文件阅读。' }
            yield { type: 'finish', reason: 'stop' }
          }
        },
      })
    },
  }
  const host = await startTestHost({ demo: false, providerId: 'find-model', plugins: [plugin] }),
    browser = await chromium.launch(browserLaunchOptions())
  try {
    await writeFile(join(host.workspaceRoot, 'report.txt'), '唯一输出检索词 FIRST\n普通一行\n唯一输出检索词 SECOND\n')
    const owner = await host.enroll({ listener: 'unix' })
    const created = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '读取本地报告', requestId: randomUUID() },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + created.sessionId)).summary.status).toBe('idle')
    const detail = await owner.json<TaskDetail>('tasks/' + created.sessionId),
      output = detail.messages.find(message => message.role === 'tool' && message.toolName === 'read_file')!
    expect(output).toBeDefined()
    const before = calls
    await mkdir('test-results/transcript-find', { recursive: true })
    for (const width of [390, 900, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        colorScheme: width === 900 ? 'dark' : 'light',
        locale: 'zh-CN',
        reducedMotion: 'reduce',
      })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      try {
        await enrollBrowser(page, host, { name: 'Find ' + width })
        await page.keyboard.press('Meta+k')
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.getByRole('searchbox').fill(detail.summary.title)
        await palette.getByRole('option', { name: detail.summary.title, exact: true }).click()
        const row = page.locator('.tool-card[data-message-id="' + output.id + '"]')
        await row.waitFor({ state: 'attached' })
        expect(await row.locator('.tool-output').count()).toBe(0)
        const draft = page.getByRole('textbox', { name: '继续对话', exact: true })
        const bubble = page.locator('.transcript .user-bubble').first()
        expect(await bubble.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(
          width === 900 ? 'rgb(21, 21, 21)' : 'rgb(233, 237, 243)',
        )
        await draft.fill('尚未发送的草稿')
        await draft.focus()
        await page.keyboard.press('Meta+f')
        const find = page.getByRole('search', { name: '会话内查找', exact: true }),
          query = find.getByRole('searchbox', { name: '查找消息内容', exact: true })
        await query.fill('唯一输出检索词')
        await expect.poll(() => find.getByRole('status').textContent()).toBe('1/2')
        await row.locator('.tool-output').waitFor()
        expect(await row.getByRole('button').first().getAttribute('aria-expanded')).toBe('true')
        await expect.poll(() => page.evaluate(() => CSS.highlights.get('latch-find-current')?.size ?? 0)).toBe(1)
        expect(await page.evaluate(() => [...(CSS.highlights.get('latch-find-current') ?? [])].map(range => range.toString()))).toEqual([
          '唯一输出检索词',
        ])
        await query.press('Enter')
        await expect.poll(() => find.getByRole('status').textContent()).toBe('2/2')
        await query.press('Shift+Enter')
        await expect.poll(() => find.getByRole('status').textContent()).toBe('1/2')
        await noHorizontalOverflow(page, find)
        expect(await find.evaluate(element => getComputedStyle(element).backdropFilter)).toBe(
          width < 768 ? 'none' : 'blur(16px) saturate(1.1)',
        )
        if (width === 900) {
          await find.getByRole('button', { name: '下一个匹配' }).hover()
          const tip = page.getByRole('tooltip', { name: /^下一个/u })
          await tip.waitFor()
          expect(await tip.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(12, 12, 12)')
          await page.mouse.move(0, 0)
        }
        await page.screenshot({ path: 'test-results/transcript-find/output-' + width + '.png', animations: 'disabled' })
        if (width === 900) {
          const cdp = await context.newCDPSession(page)
          await cdp.send('Emulation.setEmulatedMedia', {
            features: [
              { name: 'prefers-color-scheme', value: 'dark' },
              { name: 'prefers-reduced-transparency', value: 'reduce' },
            ],
          })
          await expect
            .poll(() => find.evaluate(element => [getComputedStyle(element).backdropFilter, getComputedStyle(element).backgroundColor]))
            .toEqual(['none', 'rgb(12, 12, 12)'])
        }
        await query.fill('')
        await expect.poll(() => page.evaluate(() => CSS.highlights.get('latch-find')?.size ?? 0)).toBe(0)
        await query.press('Escape')
        await find.waitFor({ state: 'hidden' })
        expect(await promptValue(draft)).toBe('尚未发送的草稿')
        expect(await draft.evaluate(element => element === document.activeElement)).toBe(true)
        expect(calls).toBe(before)
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await host.close()
  }
})
