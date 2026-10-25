import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { expect, test } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelProvider } from '@latch/sdk'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'

test('answers a multi-question wizard, keeps per-device drafts across sessions, and continues on three widths', async () => {
  const seen: string[] = []
  const provider: ModelProvider = {
    id: 'question-browser',
    name: '测试模型',
    model: 'fake',
    async *stream({ messages }) {
      if (messages.at(-1)?.role === 'tool') {
        seen.push(messages.at(-1)!.content)
        yield { type: 'text', text: '已按你的选择继续完成。' }
        yield { type: 'finish', reason: 'stop' }
      } else {
        yield {
          type: 'tool-call',
          call: {
            id: `ask-${randomUUID()}`,
            name: 'ask_user',
            arguments: {
              prompt: '开始实现之前，确认一下你的偏好。',
              questions: [
                {
                  id: 'language',
                  label: '用什么语言？',
                  options: [
                    { id: 'ts', label: 'TypeScript', description: '与现有项目保持一致' },
                    { id: 'swift', label: 'Swift' },
                  ],
                },
                {
                  id: 'checks',
                  label: '运行哪些检查？',
                  multiple: true,
                  options: [
                    { id: 'unit', label: '单元测试' },
                    { id: 'browser', label: '浏览器回归' },
                  ],
                },
              ],
            },
          },
        }
        yield { type: 'finish', reason: 'tool-calls' }
      }
    },
  }
  const plugin: HarnessPlugin = {
    id: 'question-browser-fixture',
    name: '',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerProvider(provider)
    },
  }
  const host = await startTestHost({ uiDir: resolve('dist/web'), plugins: [plugin], providerId: provider.id }),
    browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    for (const width of [1440, 768, 390]) {
      const prompt = `问答会话 ${width}`
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: { prompt, requestId: randomUUID() } })
      const path = `tasks/${sessionId}`
      await expect.poll(async () => (await owner.json<TaskDetail>(path)).questions?.length).toBe(1)
      const context = await browser.newContext({
          viewport: { width, height: 960 },
          reducedMotion: 'reduce',
          colorScheme: width === 390 ? 'dark' : 'light',
        }),
        page = await context.newPage()
      await enrollBrowser(page, host, { name: `问答 ${width}` })
      const open = async () => {
        await page.keyboard.press('Meta+k')
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.getByRole('searchbox').fill(prompt)
        await palette.getByRole('option', { name: prompt, exact: true }).click()
      }
      await open()
      const card = page.getByRole('region', { name: 'Agent 提问', exact: true })
      await expect.poll(() => card.isVisible()).toBe(true)
      await card.getByRole('radio', { name: 'TypeScript', exact: true }).check()
      await card.getByRole('button', { name: '下一题', exact: true }).click()
      await card.getByRole('checkbox', { name: '单元测试', exact: true }).check()
      await card.getByRole('checkbox', { name: '其他…', exact: true }).check()
      await card.getByRole('textbox', { name: '补充你的答案', exact: true }).fill('再检查可访问性')
      expect(await card.getByRole('checkbox', { name: '其他…', exact: true }).isChecked()).toBe(true)
      await page.screenshot({ path: `test-results/questions-pending-${width}.png`, fullPage: true })
      // Reload is a stronger draft lifetime boundary than a session switch; selected step and all choices survive.
      await page.reload()
      await connected(page)
      if (!(await card.isVisible())) await open()
      await expect.poll(() => card.getByText('第 2 题，共 2 题', { exact: true }).isVisible()).toBe(true)
      expect(await card.getByRole('checkbox', { name: '单元测试', exact: true }).isChecked()).toBe(true)
      expect(await card.getByRole('textbox', { name: '补充你的答案', exact: true }).inputValue()).toBe('再检查可访问性')
      await card.getByRole('button', { name: '上一题', exact: true }).click()
      expect(await card.getByRole('radio', { name: 'TypeScript', exact: true }).isChecked()).toBe(true)
      await card.getByRole('button', { name: '下一题', exact: true }).click()
      await card.getByRole('button', { name: '提交回答', exact: true }).click()
      await expect.poll(async () => (await owner.json<TaskDetail>(path)).summary.status).toBe('idle')
      await expect.poll(() => page.getByText('已按你的选择继续完成。', { exact: true }).isVisible()).toBe(true)
      expect(JSON.parse(seen.at(-1)!)).toMatchObject({
        answers: [{ choices: ['TypeScript'] }, { choices: ['单元测试'], other: '再检查可访问性' }],
      })
      const process = page.locator('.process-fold > .fold-toggle')
      await expect.poll(() => process.getAttribute('aria-expanded')).toBe('false')
      await process.click()
      await page.getByText('已回答 2 题', { exact: true }).click()
      await expect.poll(() => page.locator('.question-result').getByText('再检查可访问性', { exact: false }).isVisible()).toBe(true)
      await page.screenshot({ path: `test-results/questions-answered-${width}.png`, fullPage: true })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await context.close()
    }
  } finally {
    await browser.close()
    await host.close()
  }
}, 60_000)
