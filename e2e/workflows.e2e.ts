import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { closeSettings, openSection, openSessions, openSettings } from './helpers/layout.ts'
import type { TaskDetail } from '@latch/protocol'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'

describe('session search and workbench navigation', () => {
  it('finds private body text, reveals the original message, uses DOM highlights and opens commands at desktop and phone widths', async () => {
    const host = await startTestHost({ uiDir: resolve('dist/web') }),
      browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      await mkdir(join(host.workspaceRoot, '.git'))
      await writeFile(join(host.workspaceRoot, '.git/HEAD'), 'ref: refs/heads/feature/quiet-ui\n')
      const created = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '正文包含 独特检索词 中文 hello world', requestId: randomUUID() },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle')
      await owner.json(`tasks/${created.sessionId}`, { method: 'PATCH', body: { title: '示例会话' } })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.branch).toBe('feature/quiet-ui')
      for (const width of [1440, 768, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: width === 390 ? 'dark' : 'light' })
        const page = await context.newPage()
        await enrollBrowser(page, host, { name: `检索 ${width}` })
        await page.keyboard.press('Meta+k')
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.waitFor()
        await palette.getByRole('searchbox').fill('独特检索词')
        const result = palette.getByRole('option').filter({ hasText: '独特检索词' }).first()
        await result.waitFor()
        await result.click()
        await page.locator('.transcript [data-search-target]').first().waitFor()
        // The branch is the title row's: after the project on a wide window, in the title's second line on a phone.
        await page
          .locator(width < 768 ? '.topbar-branch' : '.topbar .topbar-session-branch')
          .filter({ hasText: 'feature/quiet-ui' })
          .first()
          .waitFor()
        await page.keyboard.press('Meta+f')
        const find = page.getByRole('search', { name: '会话内查找' })
        await find.getByRole('searchbox', { name: '查找消息内容' }).fill('hello')
        await expect.poll(() => page.evaluate(() => CSS.highlights.get('latch-find')?.size ?? 0)).toBeGreaterThan(0)
        expect(await find.getByRole('status').textContent()).toMatch(/1\//u)
        await find.getByRole('searchbox').press('Escape')
        await find.waitFor({ state: 'hidden' })
        if (width === 1440) {
          const input = page.getByRole('textbox', { name: '继续对话', exact: true })
          await page.keyboard.press('Alt+l')
          await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
          await input.press('ArrowUp')
          expect(await input.inputValue()).toBe('正文包含 独特检索词 中文 hello world')
          await input.fill('保留草稿')
          await page.keyboard.press('Meta+k')
          await palette.getByRole('searchbox').fill('外观：深色')
          await palette.getByRole('option', { name: '外观：深色', exact: true }).click()
          await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('dark')
          expect(await input.inputValue()).toBe('保留草稿')
          await input.fill('运行可取消长任务')
          await input.press('Meta+Enter')
          await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + created.sessionId)).summary.status).not.toBe('idle')
          await input.focus()
          await input.press('Escape')
          expect((await owner.json<TaskDetail>('tasks/' + created.sessionId)).summary.status).not.toBe('cancelled')
          await input.press('Escape')
          await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + created.sessionId)).summary.status).toBe('cancelled')
          // The shortcuts lie over the session; Esc puts them away.
          await page.keyboard.press('Alt+/')
          await page.getByRole('searchbox', { name: '搜索快捷键', exact: true }).waitFor()
          await page.keyboard.press('Escape')
          await page.locator('.shortcuts-overlay').waitFor({ state: 'hidden' })
          await page.keyboard.press('Alt+b')
          await page.getByRole('button', { name: '展开侧栏', exact: true }).waitFor()
          await page.keyboard.press('Alt+b')
          await page.getByRole('button', { name: '收起侧栏', exact: true }).waitFor()
          await page.keyboard.press('Alt+n')
          // 新会话 is the home with its input focused.
          await page.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true }).waitFor()
          // In a field a Mac browser's ⌥, types ≤; the keys are the app's once focus has left it.
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
          await page.keyboard.press('Alt+,')
          await page.locator('.settings-page').waitFor()
          await openSessions(page)
          await page.locator('#session-navigation [data-task-id]').first().click()
        }

        await page.locator('.transcript').getByText('正文包含 独特检索词 中文 hello world', { exact: true }).waitFor()
        await page.getByRole('textbox', { name: '继续对话', exact: true }).waitFor()
        await page.screenshot({ path: `test-results/workflows-${width}.png`, fullPage: true })
        await context.close()
      }
    } finally {
      await browser.close()
      await host.close()
    }
  })
  it('inserts a scoped prompt template as editable text without sending it, on desktop and phone', async () => {
    const host = await startTestHost({ uiDir: resolve('dist/web') }),
      browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      await owner.json('prompts/review', {
        method: 'PUT',
        body: { id: 'review', name: '检查改动', content: '阅读改动，并解释结果。', scope: { kind: 'all' } },
      })
      for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' }),
          page = await context.newPage()
        await enrollBrowser(page, host, { name: `模板 ${width}` })
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await input.fill('/review')
        await page
          .getByRole('listbox', { name: '命令与提示模板', exact: true })
          .getByRole('option', { name: /\/review/u })
          .click()
        expect(await input.inputValue()).toBe('阅读改动，并解释结果。')
        expect((await owner.json<{ tasks: unknown[] }>('snapshot')).tasks).toEqual([])
        await context.close()
      }
    } finally {
      await browser.close()
      await host.close()
    }
  })
  it('filters abbreviated model names, remembers choices, hides models locally and counts a plugin provider’s turns as their own source', async () => {
    const plugin: HarnessPlugin = {
      id: 'workflow-models',
      description: '只在测试中提供模型和计数。',
      name: '测试模型',
      version: '1',
      activate(context) {
        context.registerProvider({
          id: 'workflow-models',
          name: '测试模型',
          model: 'gpt-5.0-mini',
          models: Array.from({ length: 10 }, (_, i) => `gpt-5.${i}-mini`),
          async *stream() {
            yield { type: 'text', text: '完成' }
            yield { type: 'usage', inputTokens: 123, outputTokens: 45, cacheReadTokens: 10 }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const host = await startTestHost({ uiDir: resolve('dist/web'), plugins: [plugin] }),
      browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const created = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '本地测试', requestId: randomUUID(), model: { providerId: 'workflow-models', model: 'gpt-5.1-mini' } },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle')
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }),
        page = await context.newPage()
      await enrollBrowser(page, host, { name: '模型列表', scopes: ['admin'] })
      const settings = await openSettings(page)
      await openSection(settings, '模型')
      const visible = settings.getByRole('switch', { name: /gpt-5\.0-mini/u })
      await visible.click()
      expect(await visible.getAttribute('aria-checked')).toBe('false')
      await closeSettings(settings)
      // 额度与用量: a plugin's own provider is not metered by the gateway, so its turns are counted as their own source,
      // tokens as reported and never priced. Reached by its shortcut, over a chosen period.
      await page.keyboard.press('Alt+Shift+U')
      const usage = page.getByRole('dialog', { name: '额度与用量', exact: true })
      await usage.getByRole('radio', { name: '用量', exact: true }).click()
      const rows = usage.getByRole('table', { name: '用量', exact: true })
      await rows.getByRole('rowheader', { name: /^Latch 内置/u }).waitFor()
      expect(await rows.textContent()).toContain('168')
      expect(await usage.textContent()).not.toMatch(/[$¥]/u)
      await usage.getByRole('button', { name: /^来源：/u }).click()
      await page.getByRole('menuitemradio', { name: '插件服务', exact: true }).click()
      await usage.getByRole('radio', { name: '7 天', exact: true }).click()
      await rows.getByRole('rowheader', { name: /^Latch 内置/u }).waitFor()
      expect(await rows.textContent()).toContain('1 轮')
      await page.screenshot({ path: 'test-results/workflow-model-usage.png', fullPage: true })
      await page.keyboard.press('Escape')
      await usage.waitFor({ state: 'hidden' })
      await page.keyboard.press('Alt+n')
      await page.locator('.model-picker:visible').click()
      await page.getByRole('searchbox', { name: '搜索模型', exact: true }).fill('gpt5m')
      expect(await page.getByRole('menuitemradio', { name: /gpt-5.0-mini/u }).count()).toBe(0)
      await page.getByRole('menuitemradio', { name: /gpt-5.1-mini/u }).click()
      await page.locator('.model-picker:visible').click()
      // The one just used stays in the list, first.
      expect(await page.getByRole('menuitemradio').first().textContent()).toContain('gpt-5.1-mini')
      // A model hidden in 设置 stays out of the menu: there is no disclosure for it here.
      expect(await page.getByRole('menuitemradio', { name: /gpt-5.0-mini/u }).count()).toBe(0)
      await context.close()
    } finally {
      await browser.close()
      await host.close()
    }
  })
})
