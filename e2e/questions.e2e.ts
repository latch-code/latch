import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { expect, test } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelProvider } from '@latch/sdk'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'

test('keeps text written before a question arrived as the next message, until 其他… makes it the answer', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const seen: string[] = []
  const provider: ModelProvider = {
    id: 'question-arrival',
    name: '测试模型',
    model: 'fake',
    async *stream({ messages }) {
      if (messages.at(-1)?.role === 'tool') {
        seen.push(messages.at(-1)!.content)
        yield { type: 'text', text: '收到回答。' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      if (seen.length > 0) {
        yield { type: 'text', text: '收到下一条。' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      await held
      yield {
        type: 'tool-call',
        call: {
          id: `ask-${randomUUID()}`,
          name: 'ask_user',
          arguments: {
            prompt: '用什么语言？',
            questions: [{ id: 'language', label: '用什么语言？', options: [{ id: 'ts', label: 'TypeScript' }] }],
          },
        },
      }
      yield { type: 'finish', reason: 'tool-calls' }
    },
  }
  const plugin: HarnessPlugin = {
    id: 'question-arrival-fixture',
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
    const prompt = '等待中的问答'
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: { prompt, requestId: randomUUID() } })
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' }),
      page = await context.newPage()
    await enrollBrowser(page, host, { name: '问答到达' })
    await page.locator(`[data-task-id="${sessionId}"]`).click()
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('顺便看看手机端')
    release()
    const card = page.getByRole('region', { name: 'Agent 提问', exact: true })
    await card.waitFor()
    // The text stays in the input and the slot still queues; Enter would not have answered.
    await page.getByRole('button', { name: '排队发送', exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '发送', exact: true }).count()).toBe(0)
    expect(await input.inputValue()).toBe('顺便看看手机端')
    // 其他… says this text is the answer.
    await card.getByRole('button', { name: '其他…', exact: true }).click()
    await page.getByRole('button', { name: '发送', exact: true }).waitFor()
    await input.press('Meta+Enter')
    await expect.poll(() => seen.length).toBe(1)
    expect(JSON.parse(seen[0]!)).toMatchObject({ answers: [{ other: '顺便看看手机端' }] })
    await context.close()
  } finally {
    release()
    await browser.close()
    await host.close()
  }
}, 60_000)

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
      // A question leaves the run's status alone; the list still says it waits. At 768 the list is an overlay nobody opened.
      if (width !== 768) await page.locator(`[data-task-id="${sessionId}"]`).getByText('等你处理', { exact: true }).waitFor()
      const open = async () => {
        await page.keyboard.press('Meta+k')
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.getByRole('searchbox').fill(prompt)
        await palette.getByRole('option', { name: prompt, exact: true }).click()
      }
      await open()
      const card = page.getByRole('region', { name: 'Agent 提问', exact: true })
      await expect.poll(() => card.isVisible()).toBe(true)
      // A single-choice question answers on the press and goes on to the next.
      await card.getByRole('button', { name: /TypeScript/ }).click()
      await card.getByText('2/2', { exact: true }).waitFor()
      // Nothing else stops a run that waits on a question: the send slot stays stop until an answer is written.
      await page.getByRole('button', { name: '停止', exact: true }).waitFor()
      await card.getByRole('button', { name: /单元测试/ }).click()
      await page.screenshot({ path: `test-results/questions-pending-${width}.png`, fullPage: true })
      // Reload is a stronger draft lifetime boundary than a session switch; selected step and all choices survive.
      await page.reload()
      await connected(page)
      if (!(await card.isVisible())) await open()
      await card.getByText('2/2', { exact: true }).waitFor()
      expect(await card.getByRole('button', { name: /单元测试/ }).getAttribute('aria-pressed')).toBe('true')
      await card.getByRole('button', { name: '上一题', exact: true }).click()
      expect(await card.getByRole('button', { name: /TypeScript/ }).getAttribute('aria-pressed')).toBe('true')
      // New choices take no press at first, so a key meant for what was there cannot land on them.
      await page.locator('.question-card:not([data-arming])').waitFor()
      // The number keys choose, and 其他… hands over to the input, where what is written answers this question.
      await page.keyboard.press('1')
      await card.getByText('2/2', { exact: true }).waitFor()
      await card.getByRole('button', { name: '其他…', exact: true }).click()
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await input.getAttribute('placeholder')).toContain('输入你自己的回答')
      await input.fill('再检查可访问性')
      await input.press('Meta+Enter')
      await expect.poll(async () => (await owner.json<TaskDetail>(path)).summary.status).toBe('idle')
      await expect.poll(() => page.getByText('已按你的选择继续完成。', { exact: true }).isVisible()).toBe(true)
      expect(JSON.parse(seen.at(-1)!)).toMatchObject({
        answers: [{ choices: ['TypeScript'] }, { choices: ['单元测试'], other: '再检查可访问性' }],
      })
      // What the person answered stays in reading order, out of the work's fold.
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
