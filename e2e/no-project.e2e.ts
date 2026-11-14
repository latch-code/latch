import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { TaskDetail, TaskSummary } from '@latch/protocol'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'
import { homeInput } from './helpers/workbench.ts'

describe('no project means chat', () => {
  it.each([
    [390, 'light'],
    [1440, 'dark'],
  ] as const)('%s %s: the built-in Harness with no project touches no files, and a project gives them back', async (width, theme) => {
    const host = await startTestHost({ sessionFolders: true, hostName: 'studio-mini' })
    const browser = await chromium.launch(browserLaunchOptions())
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      await enrollBrowser(page, host, { name: '不选项目 ' + width })
      const input = homeInput(page)
      // The place of the home's input names no project instead of asking for one, on a phone in its row of chips.
      const place = page.locator('.workbench-home .home-composer-location')
      expect(await place.innerText()).toContain('不选项目')
      expect(await page.getByText('选择项目', { exact: true }).count()).toBe(0)
      if (width < 768) expect(await place.evaluate(element => element.closest('.composer-chips') !== null)).toBe(true)
      await input.fill('解释一下什么是 SSE')
      // The switch is gone; the project list is what decides.
      expect(await page.getByRole('switch', { name: /只聊天/ }).count()).toBe(0)
      await place.getByRole('button').filter({ visible: true }).first().click()
      // One kind of sentence for every Harness: who works, and how.
      await page.getByText('Latch 内置 只回复文字，不读写文件', { exact: true }).filter({ visible: true }).first().waitFor()
      // A browser is another device: projects are added on the computer, which the menu names.
      await page.getByText('在 studio-mini 上的 Latch 里添加项目', { exact: true }).filter({ visible: true }).first().waitFor()
      expect(await page.getByRole('menuitem', { name: '添加项目…' }).count()).toBe(0)
      await page.getByText('不选项目', { exact: true }).filter({ visible: true }).last().click()
      expect(await input.inputValue()).toBe('解释一下什么是 SSE')
      await page.getByText('不读写文件', { exact: true }).filter({ visible: true }).first().waitFor()
      await noHorizontalOverflow(page)
      await page.locator('.workbench-home').getByRole('button', { name: '发送', exact: true }).click()
      await expect
        .poll(
          async () =>
            (await owner.json<{ tasks: Array<{ mode?: string; workspaceId?: string; sessionFolder?: boolean }> }>('snapshot')).tasks,
        )
        .toMatchObject([{ mode: 'chat', workspaceId: 'default' }])
      const [task] = (await owner.json<{ tasks: TaskSummary[] }>('snapshot')).tasks
      expect(task?.sessionFolder).toBeUndefined()
      // The session's title row draws no empty folder chip: where it names the place at all, it says 不选项目 in words.
      if (width >= 768) {
        await page.locator('main.workspace .topbar .topbar-title-button').waitFor()
        const crumb = page.locator('main.workspace .topbar .topbar-crumb-button').filter({ visible: true })
        if ((await crumb.count()) > 0) {
          expect(await crumb.first().innerText()).toBe('不选项目')
          expect(await crumb.first().locator('svg').count()).toBe(0)
        }
      }
      const continued = page.getByRole('textbox', { name: '继续对话', exact: true })
      await expect.poll(() => continued.getAttribute('placeholder')).toBe('写下问题或想法…')
      const detail = await owner.json<TaskDetail>(`tasks/${task!.id}`)
      expect(detail.messages.filter(message => message.role === 'tool')).toEqual([])
    } finally {
      await browser.close()
      await host.close()
    }
  })
})
