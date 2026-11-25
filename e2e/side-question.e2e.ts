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
    let releaseFirstReceipt!: () => void
    const firstReceipt = new Promise<void>(resolve => {
      releaseFirstReceipt = resolve
    })
    const provider: ModelProvider = {
      id: 'side-question-model',
      name: '测试模型',
      model: 'fake',
      async *stream({ messages, signal }) {
        const prompt = String(messages.at(-1)?.content ?? '')
        prompts.push(prompt)
        if (prompt.includes('长任务') || prompt.includes('第一问慢慢答')) {
          yield { type: 'text', text: prompt.includes('第一问慢慢答') ? '第一问正在回答' : '正在处理长任务' }
          await new Promise<void>((done, fail) => {
            if (signal.aborted) return fail(signal.reason)
            signal.addEventListener('abort', () => fail(signal.reason), { once: true })
            releases.push(done)
          })
        } else if (prompt.includes('第二问')) yield { type: 'text', text: '第二问的回答。' }
        else if (prompt.includes('顺便问')) yield { type: 'text', text: '旁支回答：这是 Latch 的测试项目。' }
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
    const host = await startTestHost({
      uiDir: resolve(process.env.LATCH_E2E_UI_DIR ?? 'dist/web'),
      plugins: [plugin],
      providerId: provider.id,
    })
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
      expect(await promptValue(input)).toBe('旁支回答：\n> 旁支回答：这是 Latch 的测试项目。')
      expect(await input.locator('[data-source=side]').count()).toBe(1)
      await expect
        .poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.id === fork.id)?.archived)
        .toBe(true)
      expect((await owner.json<TaskDetail>(path)).summary.status).toBe('running')

      await page.route('**/link/api/tasks', async route => {
        const request = route.request()
        if (request.method() !== 'POST' || request.postDataJSON()?.prompt !== '第一问慢慢答') return route.continue()
        const response = await route.fetch()
        await firstReceipt
        await route.fulfill({ response })
      })
      await input.fill('/btw 第一问慢慢答')
      expect(await promptValue(input)).toBe('/btw 第一问慢慢答')
      await input.press('Enter')
      await panel.getByText('正在回答', { exact: true }).waitFor()
      await expect.poll(() => releases.length).toBe(2)
      const firstFork = async () =>
        (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.forkOf?.taskId === sessionId && !task.archived)
      await expect.poll(firstFork).toMatchObject({ status: 'running' })
      const firstId = (await firstFork())!.id
      const second = '/btw 第二问的草稿'
      const replacement = page.getByRole('dialog', { name: '替换第一条旁支提问？' })
      await input.fill(second)
      await input.press('Enter')
      await replacement.waitFor()
      await page.emulateMedia({ colorScheme: 'light' })
      await page.screenshot({ path: `${OUT}/replace-1440-light.png`, animations: 'disabled' })
      await replacement.getByRole('button', { name: '保留第一问' }).click()
      await replacement.waitFor({ state: 'hidden' })
      await expect.poll(() => promptValue(input)).toBe(second)
      expect(await input.evaluate(element => document.activeElement === element)).toBe(true)
      await panel.getByText('第一问慢慢答', { exact: true }).waitFor()
      releaseFirstReceipt()
      await expect.poll(() => panel.getByRole('button', { name: '打开为会话' }).getAttribute('aria-disabled')).toBeNull()
      expect((await owner.json<TaskDetail>(`tasks/${firstId}`)).summary).toMatchObject({ status: 'running' })
      expect(prompts.some(prompt => prompt.includes('第二问'))).toBe(false)
      const { sessionId: otherId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '另一个会话', requestId: randomUUID() },
      })
      await openSession(page, otherId)
      await panel.waitFor({ state: 'detached' })
      expect(await promptValue(input)).toBe('')
      await openSession(page, sessionId)
      await panel.getByText('第一问慢慢答', { exact: true }).waitFor()
      expect(await promptValue(input)).toBe(second)
      await page.screenshot({ path: `${OUT}/kept-1440-light.png`, animations: 'disabled' })

      await input.fill(second + '继续编辑')
      await input.press('Enter')
      await replacement.getByRole('button', { name: '替换并发送' }).click()
      await panel.getByText('第二问的回答。').waitFor()
      expect(await promptValue(input)).toBe('')
      expect(prompts.filter(prompt => prompt.includes('第二问'))).toHaveLength(1)
      expect(prompts.find(prompt => prompt.includes('第二问'))).toContain('第二问的草稿继续编辑')
      await expect
        .poll(async () => (await owner.json<TaskDetail>(`tasks/${firstId}`)).summary)
        .toMatchObject({ archived: true, status: 'cancelled' })
      await panel.getByRole('button', { name: '关闭并归档', exact: true }).click()
      await panel.waitFor({ state: 'detached' })
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
        if (width === 390) {
          const viewSide = narrow.getByRole('button', { name: '查看旁支提问', exact: true })
          await side.getByRole('button', { name: '返回对话', exact: true }).click()
          await side.waitFor({ state: 'detached' })
          await viewSide.click()
          await side.getByText('旁支回答：这是 Latch 的测试项目。').waitFor()
          await narrow.goBack()
          await viewSide.waitFor()
        }
        const askAgain = narrow.getByRole('dialog', { name: '替换第一条旁支提问？' })
        await box.fill('/btw 保留这条第二问')
        await box.press('Enter')
        await askAgain.waitFor()
        await narrow.screenshot({ path: `${OUT}/replace-${width}-${theme}.png`, animations: 'disabled' })
        await narrow.keyboard.press('Escape')
        await askAgain.waitFor({ state: 'hidden' })
        expect(await promptValue(box)).toBe('/btw 保留这条第二问')
        if (width === 390) await narrow.getByRole('button', { name: '查看旁支提问', exact: true }).click()
        await side.getByText('旁支回答：这是 Latch 的测试项目。').waitFor()
        await side.getByRole('button', { name: '关闭并归档', exact: true }).click()
        await side.waitFor({ state: 'detached' })
        await narrow.context().close()
      }
      expect((await owner.json<TaskDetail>(path)).summary.status).toBe('running')
    } finally {
      releaseFirstReceipt()
      for (const release of releases) release()
      await browser.close()
      await host.close()
    }
  })
})
