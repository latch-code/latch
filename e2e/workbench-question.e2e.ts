import { randomUUID } from 'node:crypto'
import { chromium, webkit } from '@playwright/test'
import { expect, it } from 'vitest'
import type { QuestionSubmission, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { switchLayout } from './helpers/workbench.ts'

it.each([
  { name: 'chromium', engine: chromium },
  { name: 'webkit', engine: webkit },
])(
  '$name shares an uncertain multi-step answer between Home and the retained conversation and retries its original request',
  async ({ engine }) => {
    const plugin: HarnessPlugin = {
      id: 'workbench-question',
      name: '首页问题验收',
      version: '1',
      description: 'Local fixture only.',
      activate(context) {
        context.registerProvider({
          id: 'question-model',
          name: '本地验收模型',
          model: 'fixture',
          async *stream({ messages }) {
            if (messages.at(-1)?.role !== 'tool') {
              yield {
                type: 'tool-call',
                call: {
                  id: randomUUID(),
                  name: 'ask_user',
                  arguments: {
                    prompt: '确认环境和发布方式',
                    questions: [
                      {
                        id: 'environment',
                        label: '使用哪个环境？',
                        options: [
                          { id: 'preview', label: '预览环境' },
                          { id: 'production', label: '正式环境' },
                        ],
                      },
                      {
                        id: 'release',
                        label: '如何发布？',
                        options: [
                          { id: 'preview', label: '先做预览' },
                          { id: 'release', label: '直接发布' },
                        ],
                      },
                    ],
                  },
                },
              }
              yield { type: 'finish', reason: 'tool-calls' }
              return
            }
            yield { type: 'text', text: '已按所选环境和方式继续。' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const host = await startTestHost({ demo: false, plugins: [plugin], providerId: 'question-model' })
    const browser = await engine.launch(engine === chromium ? browserLaunchOptions() : undefined)
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    let sessionId: string | undefined
    let releaseAnswer = () => {}
    try {
      const owner = await host.enroll({ listener: 'unix' })
      ;({ sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), prompt: '确认发布', model: { providerId: 'question-model', model: 'fixture' } },
      }))
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).questions?.length).toBe(1)
      await enrollBrowser(page, host, { name: '问题恢复验收', scopes: ['admin'] })
      const home = page.locator('.workbench-home')
      const card = home.locator(`[data-work-session="${sessionId}"]`)
      await card.getByRole('button', { name: '查看问题', exact: true }).click()
      const conversation = page.locator('.workspace .question-card')
      await expect.poll(() => conversation.getAttribute('data-arming')).toBe(null)
      await conversation.getByRole('button', { name: /预览环境/ }).click()
      await conversation.getByText('如何发布？', { exact: true }).filter({ visible: true }).waitFor()
      await page.getByRole('button', { name: '总览', exact: true }).filter({ visible: true }).first().click()
      const viewQuestion = card.getByRole('button', { name: '查看问题', exact: true })
      await viewQuestion.waitFor()
      expect(await card.locator('.question-card').count()).toBe(0)
      await viewQuestion.click()
      await conversation.getByText('如何发布？', { exact: true }).filter({ visible: true }).waitFor()
      await page.getByRole('button', { name: '总览', exact: true }).filter({ visible: true }).first().click()
      const requests: QuestionSubmission[] = []
      const answerGate = new Promise<void>(resolve => {
        releaseAnswer = resolve
      })
      await page.route('**/link/api/tasks/*/questions/*/answer', async route => {
        requests.push(route.request().postDataJSON() as QuestionSubmission)
        if (requests.length === 1) {
          await answerGate
          await route.fulfill({ status: 503, json: { error: 'question-unknown', message: '回答回执暂不可用' } })
        } else await route.continue()
      })
      await switchLayout(page, 'triage')
      await page.setViewportSize({ width: 390, height: 844 })
      await home.locator('.workbench-phone-heading').waitFor()
      // A phone has no new-session sheet any more: its options are the chips over the home's input, and a chip's own
      // sheet is the modal that keeps the number keys from answering the card behind it.
      expect(await home.getByRole('button', { name: '新会话选项', exact: true }).count()).toBe(0)
      expect(await page.getByRole('textbox', { name: '新会话消息', exact: true }).count()).toBe(1)
      const opener = home.locator('.composer-chips .home-composer-location').getByRole('button').first()
      await opener.click()
      const sheet = page.getByRole('dialog', { name: '项目', exact: true })
      await sheet.waitFor()
      expect(await sheet.evaluate(element => element.matches(':modal'))).toBe(true)
      await expect.poll(() => card.locator('.question-card').getAttribute('data-arming')).toBe(null)
      await page.keyboard.press('1')
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      expect(requests).toHaveLength(0)
      await home.locator('textarea').evaluate(element => element.focus())
      expect(await sheet.evaluate(element => element.contains(document.activeElement))).toBe(true)
      await page.keyboard.press('Escape')
      await sheet.waitFor({ state: 'hidden' })
      expect(requests).toHaveLength(0)
      await page.setViewportSize({ width: 1440, height: 1000 })
      await expect.poll(() => card.locator('.question-card').getAttribute('data-arming')).toBe(null)
      await card.getByRole('button', { name: /先做预览/ }).click()
      await card.getByRole('button', { name: '重试这次回答', exact: true }).waitFor()
      await expect.poll(() => requests.length).toBe(1)
      await card.getByRole('button', { name: '确认发布', exact: true }).click()
      await conversation.getByRole('button', { name: '重试这次回答', exact: true }).waitFor()
      const retry = conversation.getByRole('button', { name: '重试这次回答', exact: true })
      expect(await retry.getAttribute('aria-busy')).toBe('true')
      await retry.click()
      expect(requests).toHaveLength(1)
      expect(await conversation.getByRole('button', { name: /直接发布/ }).isDisabled()).toBe(true)
      await page.getByRole('button', { name: '总览', exact: true }).filter({ visible: true }).first().click()
      releaseAnswer()
      await expect.poll(() => card.getByRole('button', { name: '重试这次回答', exact: true }).getAttribute('aria-busy')).toBe(null)
      await switchLayout(page, 'triage')
      expect(requests).toHaveLength(1)
      await card.getByRole('button', { name: '确认发布', exact: true }).click()
      await conversation.getByRole('button', { name: '重试这次回答', exact: true }).waitFor()
      expect(await conversation.getByRole('button', { name: /直接发布/ }).isDisabled()).toBe(true)
      await conversation.getByRole('button', { name: '重试这次回答', exact: true }).click()
      await expect.poll(() => requests.length).toBe(2)
      expect(requests[1]).toEqual(requests[0])
      expect(requests[0]!.answers).toEqual([
        { questionId: 'environment', optionIds: ['preview'] },
        { questionId: 'release', optionIds: ['preview'] },
      ])
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
      const settled = await owner.json<TaskDetail>(`tasks/${sessionId}`)
      expect(settled.questions).toHaveLength(0)
      expect(settled.messages.filter(message => message.role === 'user')).toHaveLength(1)
    } finally {
      releaseAnswer()
      await browser.close()
      if (sessionId) await host.host.bridge.cancel(sessionId).catch(() => undefined)
      await host.close()
    }
  },
)
