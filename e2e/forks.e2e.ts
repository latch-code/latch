import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'

describe('conversation forks', () => {
  it('opens a selectable new session, folds authoritative context and returns to its source at desktop, tablet and phone widths', async () => {
    const host = await startTestHost({ uiDir: resolve('dist/web') })
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const source = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '讨论另一个方案', requestId: randomUUID() },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${source.sessionId}`)).summary.status).toBe('idle')
      for (const width of [1440, 768, 390]) {
        const context = await browser.newContext({
          viewport: { width, height: 960 },
          reducedMotion: 'reduce',
          colorScheme: width === 390 ? 'dark' : 'light',
        })
        const page = await context.newPage()
        await enrollBrowser(page, host, { name: `分叉 ${width}` })
        await page.keyboard.press('Meta+k')
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.getByRole('searchbox').fill('讨论另一个方案')
        await palette.getByRole('option').filter({ hasText: '讨论另一个方案' }).first().click()
        await page.locator('.turn-reply').first().hover()
        await page.getByRole('button', { name: '从这里分叉', exact: true }).first().click()
        await page.getByText('文件不会复制或回滚', { exact: false }).waitFor()
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        expect(await input.inputValue()).toBe('请接着这个会话继续。')
        // What a fork borrows from its source is for this draft: nothing goes into what this device remembers.
        expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('latch.composer.')))).toEqual([])
        await input.fill('请走另一条路')
        if (width === 390)
          await page.getByRole('dialog', { name: '新会话', exact: true }).getByRole('button', { name: '开始', exact: true }).click()
        else await input.press('Enter')
        await page.locator('.fork-context summary').waitFor()
        expect(await page.locator('.fork-context').getAttribute('open')).toBeNull()
        await page.locator('.fork-context summary').click()
        await expect.poll(() => page.locator('.fork-context pre').textContent()).toContain('讨论另一个方案')
        await page.locator('.fork-context summary').click()
        await page.screenshot({ path: `test-results/fork-${width}.png`, fullPage: true })
        const backlink = page.getByRole('button', { name: '返回来源会话', exact: true })
        if (!(await backlink.isVisible())) await page.getByRole('button', { name: '会话信息', exact: true }).click()
        await backlink.click()
        await page.locator('.fork-context').waitFor({ state: 'detached' })
        const snapshot = await owner.json<{ tasks: Array<{ id: string; forkOf?: { taskId: string } }> }>('snapshot')
        const fork = snapshot.tasks.find(task => task.forkOf?.taskId === source.sessionId)
        expect(fork).toBeDefined()
        await context.close()
      }
    } finally {
      await browser.close()
      await host.close()
    }
  })
})
