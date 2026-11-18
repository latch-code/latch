import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page, type Request } from '@playwright/test'
import { expect, it } from 'vitest'
import type { AppSnapshot, Device, TaskDetail, TaskSummary, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, settleShell } from './helpers/layout.ts'
import { switchView } from './helpers/workbench.ts'

const OUT = 'test-results/board-attend'

async function shot(page: Page, name: string, width: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: theme })
  await settleShell(page)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${OUT}/${name}--${theme}--${width}.png`, animations: 'disabled', caret: 'hide' })
}

/**
 * Inside a session: opening a failed run takes it out of 等你处理 for every device and keeps 失败; the run-end line's
 * 已核对 repeats the same request while its result is unknown; the session menu sets 优先级 and 标签; the header names
 * one source. The board's own card (package C) is checked through the second device's snapshot here.
 */
it('marks a failed run opened only when it is really shown, and checks unknown results with the same request', async () => {
  const plugin: HarnessPlugin = {
    id: 'board-attend',
    name: '看板记号验收',
    version: '1',
    description: 'Local scripted provider only.',
    activate(context) {
      context.registerProvider({
        id: 'attend-model',
        name: '本地验收模型',
        model: 'fixture',
        async *stream({ messages }) {
          if (messages.findLast(message => message.role === 'user')?.content === '这一轮会失败') throw new Error('模型服务没有响应')
          yield { type: 'text', text: '已经改好了。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ demo: false, plugins: [plugin], providerId: 'attend-model', hostName: '验收电脑' })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  try {
    await mkdir(OUT, { recursive: true })
    // The second device: it reads the same Host's groups.
    const other = await host.enroll({ listener: 'unix' })
    const folder = join(host.root, 'attend-project')
    await mkdir(folder)
    const { workspace } = (await (await other.addFolders({ name: '记号项目', paths: [folder] })).json()) as { workspace: WorkspaceInfo }
    const start = async (prompt: string, extra: Record<string, unknown> = {}) =>
      (
        await other.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: {
            requestId: randomUUID(),
            prompt,
            workspaceId: workspace.id,
            model: { providerId: 'attend-model', model: 'fixture' },
            ...extra,
          },
        })
      ).sessionId
    const read = (id: string) => other.json<TaskDetail>(`tasks/${id}`)
    const listed = async (id: string) => (await other.json<AppSnapshot>('snapshot')).tasks.find(task => task.id === id)!
    const failed = await start('这一轮会失败')
    await expect.poll(async () => (await read(failed)).summary.status).toBe('failed')
    const done = await start('整理一下配置')
    await expect.poll(async () => (await read(done)).summary.status).toBe('idle')
    const doneDetail = await read(done)
    const forked = await start('', { forkOf: { taskId: done, upToMessageId: doneDetail.messages.at(-1)!.id } })
    expect((await listed(failed)).board).toMatchObject({ group: 'attention', reason: 'failed' })

    await enrollBrowser(page, host, { name: '记号验收设备', scopes: ['admin'] })
    const { devices } = await other.json<{ devices: Device[] }>('devices')
    const device = devices.find(item => item.name === '记号验收设备')!
    await other.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    const attends: Request[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && /\/tasks\/[^/]+\/attend$/u.test(request.url())) attends.push(request)
    })
    await page.reload()
    await connected(page)
    // Listed, read and drawn in the sidebar is not opened.
    const row = (id: string) => page.locator(`[data-task-id="${id}"]`).filter({ visible: true }).first()
    await row(failed).waitFor()
    await page.waitForTimeout(1500)
    expect(attends).toHaveLength(0)
    expect((await listed(failed)).board).toMatchObject({ group: 'attention', reason: 'failed' })

    await row(failed).click()
    await page.locator('main.workspace:not([inert]) .transcript-content').waitFor()
    await expect.poll(async () => (await listed(failed)).board?.group).not.toBe('attention')
    const after = await listed(failed)
    expect(after.status).toBe('failed')
    expect(attends).toHaveLength(1)
    expect(attends[0]!.postDataJSON()).toEqual({ settle: after.board!.settle, opened: true })
    // 失败 stays on the row.
    await expect.poll(() => row(failed).textContent()).toContain('失败')
    await shot(page, 'failed-opened', 1440, 'light')

    // A session open under 看板 that fails there is not opened by it; back in 对话 it is.
    const later = await start('先整理一下')
    await expect.poll(async () => (await read(later)).summary.status).toBe('idle')
    await row(later).click()
    await page.locator('.transcript').getByText('已经改好了。', { exact: true }).waitFor()
    await switchView(page, 'board')
    await other.json(`tasks/${later}/prompt`, { method: 'POST', body: { prompt: '这一轮会失败', requestId: randomUUID() } })
    await expect.poll(async () => (await read(later)).summary.status).toBe('failed')
    await expect.poll(async () => (await listed(later)).board?.reason).toBe('failed')
    await page.waitForTimeout(1500)
    expect(attends).toHaveLength(1)
    expect((await listed(later)).board).toMatchObject({ group: 'attention', reason: 'failed' })
    await switchView(page, 'chat')
    await expect.poll(async () => (await listed(later)).board?.group).not.toBe('attention')
    expect(attends).toHaveLength(2)
    expect(attends[1]!.postDataJSON()).toMatchObject({ opened: true })
    await row(failed).click()

    // 优先级 and 标签 from the session menu reach the second device.
    const menu = () => page.getByRole('button', { name: '会话操作', exact: true }).locator('visible=true').first().click()
    await menu()
    await page.getByRole('menuitem', { name: '高', exact: true }).click()
    await expect.poll(async () => (await listed(failed)).priority).toBe('high')
    await menu()
    await expect.poll(() => page.getByRole('menuitem', { name: '高', exact: true }).locator('svg').count()).toBe(1)
    await shot(page, 'session-menu', 1440, 'light')
    await shot(page, 'session-menu', 1440, 'dark')
    await page.getByRole('menuitem', { name: '标签…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '标签', exact: true })
    const field = dialog.getByRole('textbox', { name: '新标签', exact: true })
    await field.fill('发布前')
    await field.press('Enter')
    await dialog.getByRole('button', { name: '移除 发布前', exact: true }).waitFor()
    await field.fill('一二三四五六七八九十一二三四五六七八九十一二三四五')
    await dialog.getByText('25 / 24', { exact: true }).waitFor()
    await shot(page, 'tags-dialog', 1440, 'light')
    await shot(page, 'tags-dialog', 1440, 'dark')
    await field.fill('')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await expect.poll(async () => (await listed(failed)).tags).toEqual(['发布前'])

    // 来自: the fork names its source and opens it.
    await row(forked).click()
    const from = page
      .locator('.topbar')
      .getByRole('button', { name: /^来自/u })
      .locator('visible=true')
    await expect.poll(() => from.count()).toBe(1)
    expect(await from.textContent()).toContain('整理一下配置')
    await shot(page, 'header-from', 1440, 'light')
    await shot(page, 'header-from', 900, 'dark')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('.fork-context').waitFor()
    await from.click()
    await page.locator('.fork-context').waitFor({ state: 'detached' })

    // 已核对: the detail says the Host holds the session for one unknown result; the first answer is lost, the same
    // request goes again, and the button goes once the Host has answered.
    const settle = 'run-unknown'
    const endedAt = new Date().toISOString()
    const held = (summary: TaskSummary): TaskSummary => ({
      ...summary,
      status: 'interrupted',
      runEnd: {
        reason: 'forced-stop',
        at: endedAt,
        unknownResultCount: 1,
        unknownResults: [{ messageId: 'gone', name: 'pnpm deploy' }],
      },
      board: { group: 'attention', reason: 'unknown', settle, card: true },
    })
    let answered: TaskSummary | undefined
    await page.route(new RegExp(`/link/api/tasks/${done}$`, 'u'), async route => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const detail = (await response.json()) as TaskDetail
      const summary = answered ?? held(detail.summary)
      return route.fulfill({ response, json: { ...detail, summary } })
    })
    const checks: unknown[] = []
    await page.route(new RegExp(`/link/api/tasks/${done}/attend$`, 'u'), async route => {
      checks.push(route.request().postDataJSON())
      if (checks.length === 1) return route.abort('timedout')
      const summary = (await read(done)).summary
      answered = { ...held(summary), board: { group: 'done', settle } }
      return route.fulfill({ json: { summary: answered } })
    })
    const openWithFreshDetail = async () => {
      await row(failed).click()
      await page.locator('main.workspace:not([inert]) .user-bubble').getByText('这一轮会失败', { exact: true }).first().waitFor()
      // Switching back to an already open conversation can use its warm detail. Reload to observe the scripted read.
      await page.reload()
      await connected(page)
      const readDetail = page.waitForResponse(
        response => response.url().endsWith(`/link/api/tasks/${done}`) && response.request().method() === 'GET',
      )
      await row(done).click()
      expect((await readDetail).ok()).toBe(true)
    }
    await openWithFreshDetail()
    const end = page.locator('main.workspace:not([inert]) .run-end')
    await end.getByText('已强制停止 · 这 1 条命令结果未知，请核对', { exact: true }).waitFor()
    const check = end.getByRole('button', { name: '已核对', exact: true })
    await shot(page, 'run-end-check', 1440, 'light')
    await shot(page, 'run-end-check', 390, 'dark')
    await page.setViewportSize({ width: 1440, height: 900 })
    await check.click()
    await expect.poll(() => checks.length, { timeout: 10_000 }).toBe(2)
    expect(checks).toEqual([
      { settle, checked: true },
      { settle, checked: true },
    ])
    await check.waitFor({ state: 'detached' })
    // Read again, the Host's answer has the line say so.
    await openWithFreshDetail()
    await end.getByText('已强制停止 · 这 1 条命令结果未知 · 已核对', { exact: true }).waitFor()
    expect(await end.getByRole('button', { name: '已核对', exact: true }).count()).toBe(0)
    await shot(page, 'run-end-checked', 1440, 'light')

    // A phone: the same menu as a sheet, and the source under the title.
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.topbar-title-button').locator('visible=true').first().click()
    await page.getByRole('menuitem', { name: '标签…', exact: true }).waitFor()
    await shot(page, 'session-menu', 390, 'light')
    await shot(page, 'session-menu', 390, 'dark')
  } finally {
    await context.close()
    await browser.close()
    await host.close()
  }
})
