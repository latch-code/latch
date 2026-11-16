import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { AppSnapshot, CustomAgent, TaskDetail, WorkItemAnswer, WorkItemStartAnswer, WorkspaceInfo } from '@latch/protocol'
import { latchEnv } from '@latch/host/env'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, settleShell } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'
import { switchView } from './helpers/workbench.ts'

const OUT = 'test-results/board-thread'

async function shot(page: Page, name: string, width: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.evaluate(() => document.fonts.ready)
  await settleShell(page)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${OUT}/${name}--${theme}--${width}.png`, animations: 'disabled', caret: 'hide' })
}
async function shots(page: Page, name: string, widths: number[] = [1440]) {
  for (const width of widths)
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
      await page.locator('.item-page-body').evaluate(body => {
        body.scrollTop = body.scrollHeight
      })
      await shot(page, name, width, theme)
    }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
}

it('posts in a 待办’s thread: @ a session gets what was added since, its reply shows, an @ in a reply wakes nobody, and an Agent’s post makes it private', async () => {
  const host = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'), demo: true, hostName: '待办电脑' })
  let browser: Browser | undefined
  try {
    await mkdir(OUT, { recursive: true })
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', { body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] } })
    const notes = join(host.root, 'notes')
    await mkdir(notes)
    await owner.addFolders({ name: '笔记', paths: [notes] })
    const { workspaces } = await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')
    const project = workspaces.find(item => item.name === '笔记')!
    const settled = async (sessionId: string) =>
      expect
        .poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, { timeout: 20_000 })
        .not.toMatch(/^(running|starting|waiting-approval)$/u)
    const userTexts = async (sessionId: string) =>
      (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.filter(message => message.role === 'user').map(message => message.text)

    const { item } = await owner.json<WorkItemAnswer>('work/items', {
      method: 'POST',
      body: { requestId: randomUUID(), title: '给 README 加一节', prompt: 'echo 写一节安装说明', projectId: project.id, harnessId: 'fake' },
    })
    const startOne = async (prompt: string, title: string, wait = true) => {
      const revision = (await owner.json<WorkItemAnswer>(`work/items/${item.id}`)).item.revision
      const { sessionId } = await owner.confirmedJson<WorkItemStartAnswer>(`work/items/${item.id}/start`, {
        method: 'POST',
        body: { requestId: randomUUID(), baseRevision: revision, prompt, mode: 'agent' },
      })
      if (wait) await settled(sessionId)
      await owner.json(`tasks/${sessionId}`, { method: 'PATCH', body: { title } })
      return sessionId
    }
    const writer = await startOne('echo 写一节安装说明', '写文档')
    const reviewer = await startOne('echo 审一遍', '审改动')
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: { requestId: randomUUID(), name: '助理', harnessId: 'fake' },
    })
    const { sessionId: chat } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), customAgentId: agent.id, prompt: 'echo 你好' },
    })
    await settled(chat)

    browser = await chromium.launch(browserLaunchOptions())
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    await stillMotion(context)
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    await enrollBrowser(page, host, { name: '待办设备', scopes: ['admin'], dataScope: 'all' })
    const workContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    const work = await workContext.newPage()
    work.setDefaultTimeout(20_000)
    await enrollBrowser(work, host, { name: '工作设备', scopes: ['view', 'run'], dataScope: 'work' })

    await switchView(page, 'board')
    await page.locator(`.work-board-card[data-work-item="${item.id}"] .work-board-card-main`).click()
    const thread = page.locator('.item-thread')
    await thread.waitFor()
    await shots(page, 'empty', [1440, 900, 390])

    const field = thread.getByRole('combobox', { name: '发言' })
    // A post with nobody named is only kept.
    await field.fill('先把安装步骤列出来')
    await field.press('Enter')
    await thread.locator('.item-thread-post').filter({ hasText: '先把安装步骤列出来' }).waitFor()

    // @ completion names one session; its post goes there with the thread since, quoted.
    await field.fill('@写')
    await page.getByRole('option', { name: /写文档/u }).waitFor()
    await field.press('Enter')
    await thread.locator('.item-thread-input-target').getByText('@写文档').waitFor()
    await field.fill('echo 好了就请 @审改动 看一下')
    const reviewerBefore = (await userTexts(reviewer)).length
    await field.press('Enter')
    const delivered = thread.locator('.item-thread-post').filter({ hasText: 'echo 好了就请' })
    await delivered.getByText('已交给 写文档').waitFor()
    await settled(writer)
    const sent = (await userTexts(writer)).at(-1)!
    expect(sent.startsWith('echo 好了就请 @审改动 看一下\n\n> 发自待办「给 README 加一节」的讨论。')).toBe(true)
    expect(sent).toContain('> 先把安装步骤列出来')
    // The reply shows under it; the @ in it wakes nobody.
    await delivered
      .locator('.item-thread-reply')
      .getByText(/^echo: echo 好了就请/u)
      .waitFor()
    expect((await userTexts(reviewer)).length).toBe(reviewerBefore)
    await shots(page, 'delivered', [1440, 900, 390])
    // The reply opens where it is: the session in 对话; the board comes back on the same 待办.
    await delivered.locator('.item-thread-reply').click()
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-view')).toBe('chat')
    await page
      .locator('.transcript')
      .getByText(/^echo: echo 好了就请/u)
      .first()
      .waitFor()
    await switchView(page, 'board')
    await thread.waitFor()

    // Sending, then an answer that never comes: 未确认送达 with 重试 and 放弃, as the input's own.
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    await page.route(`**/link/api/work/items/${item.id}/posts`, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      await held
      await route.abort('connectionreset')
    })
    await field.fill('还有一点')
    await field.press('Enter')
    await thread.locator('.item-thread-post[data-pending="sending"]').waitFor()
    await shots(page, 'sending', [1440, 900, 390])
    release()
    await thread.locator('.item-thread-post[data-pending="unknown"]').waitFor()
    await thread.getByRole('button', { name: '重试' }).waitFor()
    await shots(page, 'unknown', [1440, 900, 390])
    await page.unroute(`**/link/api/work/items/${item.id}/posts`)
    await thread.getByRole('button', { name: '重试' }).click()
    await thread.locator('.item-thread-post').filter({ hasText: '还有一点' }).first().waitFor()
    await expect.poll(() => thread.locator('.item-thread-post[data-pending]').count()).toBe(0)

    // A session in a turn refuses the post: the words stay in the input with the reason.
    const busy = await startOne('hang 一直在跑', '一直在跑', false)
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${busy}`)).summary.status).toBe('running')
    await field.fill('@一直')
    await page.getByRole('option', { name: /一直在跑/u }).waitFor()
    await field.press('Enter')
    await field.fill('echo 你先停一下')
    await field.press('Enter')
    await thread.locator('.item-thread-refused').waitFor()
    expect(await field.inputValue()).toBe('echo 你先停一下')
    await shots(page, 'failed', [1440, 900, 390])
    await thread.getByRole('button', { name: '不发给它' }).click()
    await field.fill('')

    // A device without the full data scope sees the 待办 and its thread until an Agent is named in it.
    expect(await work.evaluate(async id => (await fetch(`/link/api/work/items/${id}/posts`)).status, item.id)).toBe(200)
    await field.fill('@助')
    await page.getByRole('option', { name: /助理/u }).waitFor()
    await field.press('Enter')
    await field.fill('帮我记一下这条待办的进展')
    await field.press('Enter')
    await thread.locator('.item-thread-post').filter({ hasText: '帮我记一下' }).getByText('已交给 助理').waitFor()
    await settled(chat)
    expect((await userTexts(chat)).at(-1)).toMatch(/^帮我记一下这条待办的进展\n\n> /u)
    expect((await owner.json<AppSnapshot>('snapshot')).agentChats?.[agent.id]).toEqual({ state: 'ready', sessionId: chat })
    // Its reply opens the Agent's one chat.
    const toAgent = thread.locator('.item-thread-post').filter({ hasText: '帮我记一下' })
    await toAgent.locator('.item-thread-reply').click()
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-view')).toBe('chat')
    await page.locator('.agent-frame').filter({ hasText: '助理' }).first().waitFor()
    for (const path of [`/link/api/work/items/${item.id}`, `/link/api/work/items/${item.id}/posts`])
      expect(
        await work.evaluate(async url => {
          const response = await fetch(url)
          return [response.status, ((await response.json()) as { error: string }).error]
        }, path),
      ).toEqual([404, 'item-not-found'])
    await workContext.close()
  } finally {
    await browser?.close()
    await host.close()
  }
})
