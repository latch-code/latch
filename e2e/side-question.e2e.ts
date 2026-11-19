import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelProvider } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { openSession, settleShell } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'
import { promptValue } from './helpers/prompt.ts'

const OUT = 'test-results/side-question'

describe('/btw', () => {
  it('asks a side question beside a running turn without touching it, and archives the fork when the panel closes', async () => {
    const releases: Array<() => void> = []
    const prompts: string[] = []
    const provider: ModelProvider = {
      id: 'side-question-model',
      name: '测试模型',
      model: 'fake',
      async *stream({ messages, signal }) {
        const prompt = String(messages.at(-1)?.content ?? '')
        prompts.push(prompt)
        if (prompt.includes('长任务')) {
          yield { type: 'text', text: '正在处理长任务' }
          await new Promise<void>((done, fail) => {
            if (signal.aborted) return fail(signal.reason)
            signal.addEventListener('abort', () => fail(signal.reason), { once: true })
            releases.push(done)
          })
        } else if (prompt.includes('顺便问')) yield { type: 'text', text: '旁支回答：这是 Latch 的测试项目。' }
        else yield { type: 'text', text: '收到。' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const plugin: HarnessPlugin = {
      id: 'side-question-fixture',
      name: '旁支测试',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider(provider)
      },
    }
    const host = await startTestHost({ uiDir: resolve('dist/web'), plugins: [plugin], providerId: provider.id })
    const browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUT, { recursive: true })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '第一句：介绍一下项目', requestId: randomUUID() },
      })
      const path = `tasks/${sessionId}`
      await expect.poll(async () => (await owner.json<TaskDetail>(path)).summary.status, { timeout: 15_000 }).toBe('idle')
      await owner.json(`${path}/prompt`, { method: 'POST', body: { prompt: '长任务：慢慢做', requestId: randomUUID() } })
      await expect.poll(() => releases.length, { timeout: 15_000 }).toBe(1)
      const before = (await owner.json<TaskDetail>(path)).messages.length

      async function open(width: number, theme: 'light' | 'dark'): Promise<Page> {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, locale: 'zh-CN' })
        const page = await context.newPage()
        page.setDefaultTimeout(15_000)
        await enrollBrowser(page, host, { name: `旁支 ${width}`, scopes: ['admin'] })
        await page.locator('.app-shell').waitFor()
        await settleShell(page)
        await openSession(page, sessionId)
        await settleShell(page)
        await page.getByRole('textbox', { name: '继续对话', exact: true }).waitFor()
        return page
      }

      const page = await open(1440, 'light')
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      await input.fill('/bt')
      const menu = page.getByRole('listbox', { name: '命令与提示模板', exact: true })
      await menu.getByRole('option', { name: /\/btw/u }).waitFor()
      await page.screenshot({ path: `${OUT}/menu-1440-light.png`, animations: 'disabled' })
      await input.press('Enter')
      expect(await promptValue(input)).toBe('/btw ')
      await input.pressSequentially('顺便问一句：这是什么项目？')
      await input.press('Enter')
      const panel = page.getByRole('complementary', { name: '旁支提问', exact: true })
      await panel.getByText('旁支回答：这是 Latch 的测试项目。').waitFor()
      expect(await promptValue(input)).toBe('')

      // The fork had the settled turn as background and nothing of the running one; the running turn did not move.
      const asked = prompts.find(prompt => prompt.includes('顺便问一句'))!
      expect(asked).toContain('第一句：介绍一下项目')
      expect(asked).not.toContain('长任务')
      const source = await owner.json<TaskDetail>(path)
      expect(source.summary.status).toBe('running')
      expect(source.messages).toHaveLength(before)
      expect(source.messages.some(message => message.text.includes('顺便问一句'))).toBe(false)
      const listed = (await owner.json<AppSnapshot>('snapshot')).tasks
      const fork = listed.find(task => task.forkOf?.taskId === sessionId)!
      expect(fork).toMatchObject({ mode: 'chat', harnessId: source.summary.harnessId })
      // While the panel is open the fork is the panel's, not a row of the session list.
      expect(await page.locator(`#session-navigation [data-task-id="${fork.id}"]`).count()).toBe(0)
      await page.screenshot({ path: `${OUT}/answer-1440-light.png`, animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.screenshot({ path: `${OUT}/answer-1440-dark.png`, animations: 'disabled' })

      await panel.getByRole('button', { name: '插入到输入框', exact: true }).click()
      await panel.waitFor({ state: 'detached' })
      expect(await promptValue(input)).toBe('> 旁支回答：这是 Latch 的测试项目。')
      await expect
        .poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.id === fork.id)?.archived)
        .toBe(true)
      expect((await owner.json<TaskDetail>(path)).summary.status).toBe('running')
      await page.context().close()

      for (const [width, theme] of [
        [768, 'dark'],
        [390, 'light'],
      ] as const) {
        const narrow = await open(width, theme)
        const box = narrow.getByRole('textbox', { name: '继续对话', exact: true })
        await box.fill(`/btw 顺便问 ${width}`)
        await box.press('Enter')
        const side = narrow.getByRole('complementary', { name: '旁支提问', exact: true })
        await side.getByText('旁支回答：这是 Latch 的测试项目。').waitFor()
        expect(await narrow.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await narrow.screenshot({ path: `${OUT}/answer-${width}-${theme}.png`, animations: 'disabled' })
        await side.getByRole('button', { name: '关闭并归档', exact: true }).click()
        await side.waitFor({ state: 'detached' })
        await narrow.context().close()
      }
      expect((await owner.json<TaskDetail>(path)).summary.status).toBe('running')
    } finally {
      for (const release of releases) release()
      await browser.close()
      await host.close()
    }
  })
})
