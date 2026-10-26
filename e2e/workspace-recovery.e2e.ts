import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { backToPhoneSessions, noHorizontalOverflow } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'

describe('continue in a saved project after the old folder disappears', () => {
  it.each([
    [390, 'light'],
    [900, 'dark'],
    [1440, 'light'],
  ] as const)('%s %s retains the draft, chooses a project and waits for an explicit send', async (width, theme) => {
    const host = await startTestHost({ sessionFolders: true }),
      browser = await chromium.launch(browserLaunchOptions())
    const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme, reducedMotion: 'reduce' })
    try {
      const owner = await host.enroll({ listener: 'unix' }),
        target = join(host.root, 'continued-project')
      await mkdir(target)
      const added = await owner.addFolders({ name: '继续工作的项目', paths: [target] })
      expect(added.status).toBe(201)
      const project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace
      const created = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), prompt: '保留这段已结束的会话历史。' },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + created.sessionId)).summary.status).toBe('idle')
      const source = await owner.json<TaskDetail>('tasks/' + created.sessionId),
        page = await context.newPage()
      page.setDefaultTimeout(15_000)
      await enrollBrowser(page, host, { name: '项目继续 ' + width })
      await backToPhoneSessions(page)
      const navigation = page.getByRole('button', { name: '打开会话列表', exact: true })
      if (await navigation.isVisible()) await navigation.click()
      await page
        .locator('[data-task-id="' + created.sessionId + '"]:visible')
        .first()
        .click()
      const input = page.getByRole('textbox', { name: '继续对话', exact: true }),
        draft = '先检查当前文件，再按原计划继续。'
      await input.fill(draft)
      await rm(source.summary.cwd!, { recursive: true })
      const refused = page.waitForResponse(
        response => response.url().endsWith('/' + created.sessionId + '/prompt') && response.request().method() === 'POST',
      )
      await input.press('Meta+Enter')
      expect((await refused).status()).toBe(409)
      const recovery = page.getByRole('region', { name: '选择项目继续会话', exact: true })
      await recovery.waitFor()
      expect(await input.inputValue()).toBe(draft)
      await recovery.getByRole('button', { name: /继续会话的项目/u }).click()
      await page.getByRole(width === 390 ? 'radio' : 'menuitemradio', { name: /继续工作的项目/u }).click()
      await mkdir('test-results/workspace-recovery', { recursive: true })
      await noHorizontalOverflow(page, recovery)
      await page.screenshot({ path: 'test-results/workspace-recovery/choose-' + width + '-' + theme + '.png', animations: 'disabled' })
      let creates = 0
      page.on('request', request => {
        if (request.url().endsWith('/link/api/tasks') && request.method() === 'POST') creates++
      })
      await recovery.getByRole('button', { name: '在所选项目继续', exact: true }).click()
      const nextInput = page.getByRole('textbox', { name: '新会话消息', exact: true })
      await nextInput.waitFor()
      expect(await nextInput.inputValue()).toBe(draft)
      await expect.poll(() => nextInput.evaluate(element => element === document.activeElement)).toBe(true)
      expect(creates).toBe(0)
      const accepted = page.waitForResponse(
        response => response.url().endsWith('/link/api/tasks') && response.request().method() === 'POST',
      )
      await nextInput.press('Meta+Enter')
      const response = await accepted
      expect(response.ok()).toBe(true)
      expect(response.request().postDataJSON()).toMatchObject({
        prompt: draft,
        workspaceId: project.id,
        forkOf: { taskId: created.sessionId, upToMessageId: source.messages.at(-1)!.id },
      })
      const result = (await response.json()) as { sessionId: string }
      expect((await owner.json<TaskDetail>('tasks/' + result.sessionId)).summary.cwd).toBe(project.path)
      expect(creates).toBe(1)
    } finally {
      await context.close()
      await browser.close()
      await host.close()
    }
  })
})
