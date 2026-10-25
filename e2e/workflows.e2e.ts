import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'

describe('session search and workbench navigation', () => {
  it('finds private body text, reveals the original message, uses DOM highlights and opens commands at desktop and phone widths', async () => {
    const host = await startTestHost({ uiDir: resolve('dist/web') }),
      browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const created = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '正文包含 独特检索词 中文 hello world', requestId: randomUUID() },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle')
      await owner.json(`tasks/${created.sessionId}`, { method: 'PATCH', body: { title: '示例会话' } })
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
        await page.keyboard.press('Meta+f')
        const find = page.getByRole('search', { name: '会话内查找' })
        await find.getByRole('searchbox', { name: '查找消息内容' }).fill('hello')
        await expect.poll(() => page.evaluate(() => CSS.highlights.get('latch-find')?.size ?? 0)).toBeGreaterThan(0)
        expect(await find.getByRole('status').textContent()).toMatch(/1\//u)
        await find.getByRole('searchbox').press('Escape')
        await find.waitFor({ state: 'hidden' })
        if (width === 1440) {
          await page.keyboard.press('Alt+/')
          await page.getByRole('dialog', { name: '键盘快捷键', exact: true }).waitFor()
          await page.getByRole('dialog', { name: '键盘快捷键', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
          await page.keyboard.press('Alt+b')
          await page.getByRole('button', { name: '展开侧栏', exact: true }).waitFor()
          await page.keyboard.press('Alt+b')
          await page.getByRole('button', { name: '收起侧栏', exact: true }).waitFor()
          await page.keyboard.press('Alt+n')
          await page.getByRole('heading', { name: '今天要做什么？', exact: true }).waitFor()
          await page.keyboard.press('Alt+1')
          await page.locator('.transcript').waitFor()
        }

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
        body: { id: 'review', name: '检查变更', content: '阅读变更，并解释结果。', scope: { kind: 'all' } },
      })
      for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' }),
          page = await context.newPage()
        await enrollBrowser(page, host, { name: `模板 ${width}` })
        if (width === 390) await page.locator('.phone-list-head').getByRole('button', { name: '新建会话', exact: true }).click()
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await input.fill('/')
        await page.getByRole('button', { name: '检查变更 提示模板', exact: true }).click()
        expect(await input.inputValue()).toBe('阅读变更，并解释结果。')
        expect((await owner.json<{ tasks: unknown[] }>('snapshot')).tasks).toEqual([])
        await context.close()
      }
    } finally {
      await browser.close()
      await host.close()
    }
  })
})
