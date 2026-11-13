import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

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
      const phone = width < 768
      if (phone) await page.getByRole('button', { name: '新会话选项', exact: true }).click()
      const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
      await input.fill('解释一下什么是 SSE')
      // The switch is gone; the project list is what decides.
      expect(await page.getByRole('switch', { name: /只聊天/ }).count()).toBe(0)
      await page
        .getByRole('button', { name: /^项目：|^选择项目/ })
        .filter({ visible: true })
        .first()
        .click()
      // One kind of sentence for every Harness: who works, and how.
      await page.getByText('Latch 内置 只回复文字，不读写文件', { exact: true }).filter({ visible: true }).first().waitFor()
      // A browser is another device: projects are added on the computer, which the menu names.
      await page.getByText('在 studio-mini 上的 Latch 里添加项目', { exact: true }).filter({ visible: true }).first().waitFor()
      expect(await page.getByRole('menuitem', { name: '添加项目…' }).count()).toBe(0)
      await page.getByText('不选项目', { exact: true }).filter({ visible: true }).last().click()
      expect(await input.inputValue()).toBe('解释一下什么是 SSE')
      await page.getByText('不读写文件', { exact: true }).filter({ visible: true }).first().waitFor()
      await noHorizontalOverflow(page)
      await page
        .getByRole('button', { name: /^(发送|开始)$/ })
        .filter({ visible: true })
        .first()
        .click()
      await expect
        .poll(
          async () =>
            (await owner.json<{ tasks: Array<{ mode?: string; workspaceId?: string; sessionFolder?: boolean }> }>('snapshot')).tasks,
        )
        .toMatchObject([{ mode: 'chat', workspaceId: 'default' }])
      const [task] = (await owner.json<{ tasks: Array<{ sessionFolder?: boolean }> }>('snapshot')).tasks
      expect(task?.sessionFolder).toBeUndefined()
      await page
        .getByPlaceholder(/不读写文件、不运行命令/)
        .filter({ visible: true })
        .first()
        .waitFor()
    } finally {
      await browser.close()
      await host.close()
    }
  })
})
