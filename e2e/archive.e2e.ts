import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot, SessionBatchResult, TaskDetail } from '@latch/protocol'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { backToPhoneSessions, noHorizontalOverflow } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'

describe('archived session management', () => {
  it.each([
    [390, 'light'],
    [900, 'dark'],
    [1440, 'light'],
  ] as const)('%s %s restores and deletes actual selected records, and persists explicit unread state', async (width, theme) => {
    const host = await startTestHost(),
      browser = await chromium.launch(browserLaunchOptions()),
      context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' })
    context.setDefaultTimeout(15_000)
    try {
      const owner = await host.enroll({ listener: 'unix' }),
        records = new Map<string, { id: string; prompt: string }>(),
        keep = join(host.workspaceRoot, 'keep-after-record-delete.txt')
      await writeFile(keep, 'Session deletion keeps workspace files.')
      for (let index = 0; index < 5; index++) {
        const prompt = `归档测试正文 ${width} ${index}`,
          title = `归档记录 ${width} ${index}`,
          { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
            method: 'POST',
            body: { prompt, mode: 'chat', requestId: randomUUID() },
          })
        await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + sessionId)).summary.status).toBe('idle')
        await owner.json('tasks/' + sessionId, { method: 'PATCH', body: { title, archived: true } })
        records.set(title, { id: sessionId, prompt })
      }
      const page = await context.newPage()
      await enrollBrowser(page, host, { name: `归档验收 ${width}`, scopes: ['admin'] })
      const showList = async (page: Page) => {
        await backToPhoneSessions(page)
        if (width === 900) {
          const open = page.getByRole('button', { name: '打开会话列表', exact: true })
          if ((await open.isVisible()) && (await open.getAttribute('aria-expanded')) !== 'true') await open.click()
          await page.locator('#session-navigation.is-open').waitFor()
        }
      }
      const filter = async (label: '已归档' | '全部') => {
        await showList(page)
        const list = page.locator('#session-navigation')
        if (label === '已归档') await list.getByRole('button', { name: /^已归档的会话/ }).click()
        else await list.locator('.archived-back, .phone-archived-back').click()
      }
      await filter('已归档')
      await page.getByRole('button', { name: '批量管理', exact: true }).click()
      const batch = page.getByRole('region', { name: '批量管理归档会话', exact: true }),
        labels = batch.locator('label'),
        checks = batch.getByRole('checkbox')
      await expect.poll(() => checks.count()).toBe(5)
      const selected = (await labels.allTextContents()).slice(0, 3).map(title => records.get(title.trim())!)
      await checks.nth(0).click()
      await checks.nth(2).click({ modifiers: ['Shift'] })
      await expect.poll(() => batch.locator('input:checked').count()).toBe(3)
      for (let index = 0; index < 5; index++) expect(await checks.nth(index).isChecked()).toBe(index < 3)
      const restoreResponse = page.waitForResponse(
        response => response.url().endsWith('/link/api/tasks/batch') && response.request().method() === 'POST',
      )
      await batch.getByRole('button', { name: '恢复 3', exact: true }).click()
      const restored = await restoreResponse
      expect(restored.ok()).toBe(true)
      expect(restored.request().postDataJSON()).toEqual({ action: 'unarchive', ids: selected.map(record => record.id) })
      expect(((await restored.json()) as SessionBatchResult).results.every(result => result.ok)).toBe(true)
      await expect
        .poll(async () =>
          (await owner.json<AppSnapshot>('snapshot')).tasks
            .filter(task => !task.archived)
            .map(task => task.id)
            .toSorted(),
        )
        .toEqual(selected.map(record => record.id).toSorted())
      await page.getByRole('button', { name: '批量管理', exact: true }).click()
      await expect.poll(() => checks.count()).toBe(2)
      const removed = (await labels.allTextContents()).map(title => records.get(title.trim())!)
      await checks.nth(0).click()
      await checks.nth(1).click({ modifiers: ['Shift'] })
      await expect.poll(() => batch.locator('input:checked').count()).toBe(2)
      await batch.getByRole('button', { name: '删除', exact: true }).click()
      const confirmation = page.getByRole('dialog', { name: '删除 2 个会话？', exact: true })
      await confirmation.getByText('会话记录会永久删除，文件夹中的文件不受影响。', { exact: true }).waitFor()
      const deleteResponse = page.waitForResponse(
        response => response.url().endsWith('/link/api/tasks/batch') && response.request().method() === 'POST',
      )
      await confirmation.getByRole('button', { name: '删除', exact: true }).click()
      const deleted = await deleteResponse
      expect(deleted.ok()).toBe(true)
      expect(deleted.request().postDataJSON()).toEqual({ action: 'delete', ids: removed.map(record => record.id) })
      expect(((await deleted.json()) as SessionBatchResult).results.every(result => result.ok)).toBe(true)
      await confirmation.waitFor({ state: 'detached' })
      await expect
        .poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.map(task => task.id).toSorted())
        .toEqual(selected.map(record => record.id).toSorted())
      for (const record of removed) expect((await owner.request('tasks/' + record.id)).status).toBe(404)
      expect(await readFile(keep, 'utf8')).toBe('Session deletion keeps workspace files.')
      await filter('全部')
      const row = (id: string) => page.locator(`[data-task-id="${id}"]`),
        unreadElement = (id: string) => (width === 390 ? row(id) : row(id).locator('..')),
        first = selected[0]!,
        second = selected[1]!
      await row(first.id).click()
      await page.locator('.transcript').getByText(first.prompt, { exact: true }).waitFor()
      await showList(page)
      await row(second.id).click()
      await page.locator('.transcript').getByText(second.prompt, { exact: true }).waitFor()
      await showList(page)
      await expect.poll(() => unreadElement(first.id).getAttribute('class')).not.toMatch(/\bis-unread\b/u)
      const title = [...records].find(([, record]) => record.id === first.id)![0],
        before = (await owner.json<TaskDetail>('tasks/' + first.id)).summary.updatedAt
      if (width === 390) await row(first.id).click({ button: 'right' })
      else await page.getByRole('button', { name: '更多操作：' + title, exact: true }).click()
      await page.getByRole('menuitem', { name: '标为未读', exact: true }).click()
      await expect.poll(() => unreadElement(first.id).getAttribute('class')).toMatch(/\bis-unread\b/u)
      expect((await owner.json<TaskDetail>('tasks/' + first.id)).summary.updatedAt).toBe(before)
      await page.reload()
      await connected(page)
      await showList(page)
      await expect.poll(() => unreadElement(first.id).getAttribute('class')).toMatch(/\bis-unread\b/u)
      await noHorizontalOverflow(page)
      await mkdir('test-results/archive', { recursive: true })
      await page.screenshot({ path: `test-results/archive/unread-${width}-${theme}.png`, animations: 'disabled' })
      await row(first.id).click()
      await page.locator('.transcript').getByText(first.prompt, { exact: true }).waitFor()
      await showList(page)
      await expect.poll(() => unreadElement(first.id).getAttribute('class')).not.toMatch(/\bis-unread\b/u)
    } finally {
      await context.close()
      await browser.close()
      await host.close()
    }
  })

  it('takes an archive back from the line under the list, by ⌘Z and by its button', async () => {
    const host = await startTestHost(),
      browser = await chromium.launch(browserLaunchOptions()),
      context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    context.setDefaultTimeout(15_000)
    try {
      const owner = await host.enroll({ listener: 'unix' }),
        { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: { prompt: '归档后撤销', mode: 'chat', requestId: randomUUID() },
        })
      await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + sessionId)).summary.status).toBe('idle')
      await owner.json('tasks/' + sessionId, { method: 'PATCH', body: { title: '撤销归档' } })
      const page = await context.newPage()
      await page.clock.install()
      await enrollBrowser(page, host, { name: '撤销归档验收', scopes: ['admin'] })
      const row = page.locator('.session-item:has([data-task-id="' + sessionId + '"])'),
        line = page.locator('.archive-undo')
      const archive = async () => {
        await row.hover()
        await row.getByRole('button', { name: '归档：撤销归档', exact: true }).click()
        await line.waitFor()
        await row.waitFor({ state: 'detached' })
        expect((await owner.json<TaskDetail>('tasks/' + sessionId)).summary.archived).toBe(true)
      }
      await archive()
      await page.locator('body').click({ position: { x: 900, y: 300 } })
      await page.keyboard.press('ControlOrMeta+z')
      await row.waitFor()
      await line.waitFor({ state: 'detached' })
      expect((await owner.json<TaskDetail>('tasks/' + sessionId)).summary.archived).toBeFalsy()
      await archive()
      await line.getByRole('button').click()
      await row.waitFor()
      expect((await owner.json<TaskDetail>('tasks/' + sessionId)).summary.archived).toBeFalsy()
      // Each archive gets its whole window, even when the line was already up for the one before.
      const other = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '第二次归档', mode: 'chat', requestId: randomUUID() },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + other.sessionId)).summary.status).toBe('idle')
      await owner.json('tasks/' + other.sessionId, { method: 'PATCH', body: { title: '第二次归档' } })
      const otherRow = page.locator('.session-item:has([data-task-id="' + other.sessionId + '"])')
      await otherRow.waitFor()
      await archive()
      await page.clock.fastForward(6000)
      await otherRow.hover()
      await otherRow.getByRole('button', { name: '归档：第二次归档', exact: true }).click()
      await otherRow.waitFor({ state: 'detached' })
      await page.clock.fastForward(6000)
      expect(await line.isVisible()).toBe(true)
      await line.getByRole('button').click()
      await otherRow.waitFor()
      expect((await owner.json<TaskDetail>('tasks/' + other.sessionId)).summary.archived).toBeFalsy()
    } finally {
      await context.close()
      await browser.close()
      await host.close()
    }
  })
})
