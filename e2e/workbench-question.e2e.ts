import { randomUUID } from 'node:crypto'
import { chromium, webkit } from '@playwright/test'
import { expect, it } from 'vitest'
import type { QuestionSubmission, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { switchView } from './helpers/workbench.ts'

it.each([
  { name: 'chromium', engine: chromium },
  { name: 'webkit', engine: webkit },
])(
  '$name keeps an uncertain multi-step answer in the retained conversation across the start screen and retries its original request',
  async ({ engine }) => {
    const plugin: HarnessPlugin = {
      id: 'workbench-question',
      name: '问题恢复验收',
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
      // The session is in 等你处理 on the start screen's count line and in the sidebar; its question is answered in the
      // conversation, which keeps the steps chosen and an uncertain answer across leaving it.
      const waiting = page.locator('.start-count[data-group="attention"]')
      await expect.poll(() => waiting.innerText()).toMatch(/^1\s*等你处理$/u)
      // A count opens 看板 on its group; 对话 comes back to the same start screen.
      await waiting.click()
      await expect.poll(() => page.locator('.app-shell').getAttribute('data-view')).toBe('board')
      await page.locator('.board-surface').waitFor()
      await switchView(page, 'chat')
      await page.locator('.workbench-home').waitFor()
      const row = page.locator(`#session-navigation [data-task-id="${sessionId}"]`)
      await row.click()
      const conversation = page.locator('.workspace .question-card')
      await expect.poll(() => conversation.getAttribute('data-arming')).toBe(null)
      await conversation.getByRole('button', { name: /预览环境/ }).click()
      await conversation.getByText('如何发布？', { exact: true }).filter({ visible: true }).waitFor()
      const toStart = () => page.locator('#session-navigation [data-space-primary]').click()
      await toStart()
      await page.locator('.workbench-home').waitFor()
      await row.click()
      await conversation.getByText('如何发布？', { exact: true }).filter({ visible: true }).waitFor()
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
      await expect.poll(() => conversation.getAttribute('data-arming')).toBe(null)
      // The last step is a single choice: choosing it sends the answer.
      await conversation.getByRole('button', { name: /先做预览/ }).click()
      await expect.poll(() => requests.length).toBe(1)
      const retry = conversation.getByRole('button', { name: '重试这次回答', exact: true })
      await retry.waitFor()
      expect(await retry.getAttribute('aria-busy')).toBe('true')
      await retry.click()
      expect(requests).toHaveLength(1)
      expect(await conversation.getByRole('button', { name: /直接发布/ }).isDisabled()).toBe(true)
      // Away on the start screen while the answer is still unknown; back, the same request is kept for a retry.
      await toStart()
      await page.locator('.workbench-home').waitFor()
      releaseAnswer()
      await row.click()
      await expect.poll(() => retry.getAttribute('aria-busy')).toBe(null)
      expect(requests).toHaveLength(1)
      expect(await conversation.getByRole('button', { name: /直接发布/ }).isDisabled()).toBe(true)
      await retry.click()
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
