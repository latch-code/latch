import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail, WorkItem, WorkItemAnswer, WorkItemStartAnswer, WorkspaceInfo } from '@latch/protocol'
import { latchEnv } from '@latch/host/env'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession, settleShell } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'
import { switchView } from './helpers/workbench.ts'

const OUT = 'test-results/item-page'
const itemPage = (page: Page) => page.locator('.item-page')
const row = (page: Page, id: string) => itemPage(page).locator(`.item-page-row[data-work-session="${id}"]`)

async function shot(page: Page, name: string, width: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.evaluate(() => document.fonts.ready)
  await page.mouse.move(0, 0)
  await settleShell(page)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${OUT}/${name}--${theme}--${width}.png`, animations: 'disabled', caret: 'hide' })
}

async function shots(page: Page, name: string, widths: readonly number[]) {
  for (const width of widths) for (const theme of ['light', 'dark'] as const) await shot(page, name, width, theme)
  await page.emulateMedia({ colorScheme: 'light' })
}

/**
 * A 待办's page with no card to reach it from (the cards are another package): the page is what this tab keeps in
 * `sessionStorage`, as the session header's 待办 link writes it.
 */
async function openItem(page: Page, itemId: string): Promise<void> {
  await page.evaluate(async id => {
    const snapshot = (await (await fetch('/link/api/snapshot')).json()) as { device: { id: string } }
    sessionStorage.setItem(`latch.board.item.${location.origin}`, JSON.stringify({ deviceId: snapshot.device.id, itemId: id }))
  }, itemId)
  await page.reload()
  await connected(page)
  if ((await page.locator('.app-shell').getAttribute('data-view')) !== 'board') await switchView(page, 'board')
  await itemPage(page).waitFor()
  await settleShell(page)
}

it('opens a 待办 inside 看板 with its sessions, starts another, brings a reply over, and finishes it', async () => {
  const host = await startTestHost({
    uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
    demo: false,
    hostName: '待办电脑',
  })
  let browser: Browser | undefined
  try {
    await mkdir(OUT, { recursive: true })
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', { body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] } })
    const repo = join(host.root, 'release')
    await mkdir(repo)
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    await writeFile(join(repo, 'README.md'), '# release\n')
    git('add', '.')
    git('commit', '-q', '-m', 'first')
    await owner.addFolders({ name: '发版仓库', paths: [repo] })
    const { workspaces } = await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')
    const project = workspaces.find(item => item.name === '发版仓库')!

    browser = await chromium.launch(browserLaunchOptions())
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    await stillMotion(context)
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    await enrollBrowser(page, host, { name: '待办设备', scopes: ['admin'] })
    const phoneContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
      isMobile: true,
      hasTouch: true,
    })
    await stillMotion(phoneContext)
    const phone = await phoneContext.newPage()
    phone.setDefaultTimeout(20_000)
    await enrollBrowser(phone, host, { name: '待办手机', scopes: ['view', 'run'] })

    const create = async (title: string, prompt: string, extra: object = {}) =>
      (
        await owner.json<WorkItemAnswer>('work/items', {
          method: 'POST',
          body: { requestId: `item-${randomUUID()}`, title, prompt, projectId: project.id, harnessId: 'fake', ...extra },
        })
      ).item
    const itemOf = async (id: string) => (await owner.json<WorkItemAnswer>(`work/items/${id}`)).item
    const startIn = async (itemId: string, prompt: string) =>
      (
        await owner.confirmedJson<WorkItemStartAnswer>(`work/items/${itemId}/start`, {
          body: {
            requestId: randomUUID(),
            baseRevision: (await itemOf(itemId)).revision,
            prompt,
            mode: 'agent',
            harnessId: 'fake',
            workspaceId: project.id,
          },
        })
      ).sessionId
    const summaryOf = async (id: string) => (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.id === id)

    const todo = await create('给 README 加一节', '写一节安装说明', { priority: 'high', tags: ['文档'] })
    const mixed = await create('升级依赖并审查', '把依赖升到最新，再审一遍改动')
    const reviewed = await startIn(mixed.id, 'echo 审这个分支相对 main 的改动')
    await expect.poll(async () => (await summaryOf(reviewed))?.board?.group, { timeout: 20_000 }).toBe('done')
    const running = await startIn(mixed.id, 'hang 重写设置页')
    const failed = await startIn(mixed.id, 'crash 升级依赖')
    await expect.poll(async () => (await summaryOf(failed))?.board?.group, { timeout: 20_000 }).toBe('attention')
    await expect.poll(async () => (await summaryOf(running))?.status, { timeout: 20_000 }).toBe('running')
    const finished = await create('整理发布说明', '列出这次发布的改动')
    await startIn(finished.id, 'echo 发布说明')
    const closing = await itemOf(finished.id)
    await owner.json(`work/items/${finished.id}`, { method: 'PATCH', body: { baseRevision: closing.revision, closed: true } })
    const loose = (
      await owner.confirmedJson<{ sessionId: string }>('tasks', {
        body: { prompt: 'echo 单独的会话', requestId: randomUUID(), workspaceId: project.id, mode: 'agent', harnessId: 'fake' },
      })
    ).sessionId
    await expect.poll(async () => (await summaryOf(loose))?.status, { timeout: 20_000 }).toBe('idle')

    // The session's header names its 待办; the name opens the 待办's page in 看板, with no sidebar.
    await page.reload()
    await connected(page)
    await openSession(page, reviewed)
    const link = page.locator('main.workspace .topbar').getByRole('button', { name: /升级依赖并审查/u })
    await link.click()
    await itemPage(page).waitFor()
    expect(await page.locator('.app-shell').getAttribute('data-view')).toBe('board')
    expect(await page.locator('.work-board-columns').count()).toBe(0)
    for (const id of [reviewed, running, failed]) await row(page, id).waitFor()
    await row(page, failed).locator('[data-tone="failed"]').waitFor()
    await row(page, running).locator('[data-tone="running"]').waitFor()
    // Started: 要求 only reads.
    expect(await itemPage(page).getByRole('region', { name: '要求' }).locator('textarea').count()).toBe(0)
    await itemPage(page).getByText('把依赖升到最新，再审一遍改动').waitFor()
    await shots(page, 'mixed', [1440, 900])

    // Out and back: Esc, the browser's back and ← 看板 all return to the board; a reload keeps the page.
    await page.keyboard.press('Escape')
    await page.locator('.work-board-columns').waitFor()
    expect(await itemPage(page).count()).toBe(0)
    await switchView(page, 'chat')
    await link.click()
    await itemPage(page).waitFor()
    await page.reload()
    await connected(page)
    await itemPage(page).waitFor()
    await page.goBack()
    await page.locator('.work-board-columns').waitFor()
    await switchView(page, 'chat')
    await link.click()
    await itemPage(page).getByRole('button', { name: '看板', exact: true }).click()
    await page.locator('.work-board-columns').waitFor()
    await switchView(page, 'chat')
    await link.click()
    await itemPage(page).waitFor()

    // A row opens its session in 对话; back on 看板 the page is still there, the row marked.
    await row(page, running).locator('.item-page-row-main').click()
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-view')).toBe('chat')
    await page.locator('main.workspace .topbar').getByText('hang 重写设置页').first().waitFor()
    await switchView(page, 'board')
    await expect.poll(() => row(page, running).getAttribute('data-marked')).toBe('')

    // 再开一个: the home's input in a dialog with the 待办's 要求; sending starts a session of this 待办, the page stays.
    await itemPage(page).getByRole('button', { name: '再开一个', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '升级依赖并审查' })
    const input = dialog.locator('textarea')
    await expect.poll(() => input.inputValue()).toBe('把依赖升到最新，再审一遍改动')
    await shots(page, 'start-another', [1440])
    await input.fill('echo 再来一个会话')
    // Changed elsewhere while this page still shows the older revision: refused, nothing starts, and the page reads it again.
    const shown = (await itemOf(mixed.id)).revision
    await page.route('**/link/api/snapshot', async route => {
      const response = await route.fetch()
      const body = (await response.json()) as AppSnapshot
      for (const entry of body.items ?? []) if (entry.id === mixed.id) entry.revision = shown
      await route.fulfill({ response, json: body })
    })
    await owner.json(`work/items/${mixed.id}`, { method: 'PATCH', body: { baseRevision: shown, priority: 'low' } })
    const rejected = page.waitForResponse(
      response => response.url().endsWith(`/link/api/work/items/${mixed.id}/start`) && response.request().method() === 'POST',
    )
    await dialog.getByRole('button', { name: '发送', exact: true }).click()
    const conflict = await rejected
    expect(conflict.status()).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: 'item-changed' })
    await dialog.getByText('待办已被修改，请刷新后再试。', { exact: true }).waitFor()
    expect(await input.inputValue()).toBe('echo 再来一个会话')
    expect((await itemOf(mixed.id)).sessionIds.length).toBe(3)
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    // The next change reaches the page as it is: the dialog's next send names the revision now shown.
    await owner.json(`work/items/${mixed.id}`, { method: 'PATCH', body: { baseRevision: shown + 1, priority: 'mid' } })
    await expect.poll(() => itemPage(page).getByRole('radio', { name: '中', exact: true }).getAttribute('aria-checked')).toBe('true')
    await dialog.getByRole('button', { name: '发送', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(async () => (await itemOf(mixed.id)).sessionIds.length, { timeout: 20_000 }).toBe(4)
    const another = (await itemOf(mixed.id)).sessionIds.at(-1)!
    await row(page, another).waitFor()
    expect(await page.locator('.app-shell').getAttribute('data-view')).toBe('board')
    await expect.poll(async () => (await summaryOf(another))?.status, { timeout: 20_000 }).toBe('idle')

    // 带过去: the review's last reply goes into the other session's input as a quote; nothing is sent.
    const before = (await owner.json<TaskDetail>(`tasks/${another}`)).messages.length
    await row(page, reviewed).getByRole('button', { name: '带过去', exact: true }).click()
    await page.getByRole('menuitem', { name: 'echo 再来一个会话' }).click()
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-view')).toBe('chat')
    const composer = page.locator('main.workspace').getByRole('textbox').last()
    await expect.poll(() => composer.inputValue()).toContain('> echo: echo 审这个分支相对 main 的改动')
    expect((await owner.json<TaskDetail>(`tasks/${another}`)).messages.length).toBe(before)
    await composer.fill('')
    await switchView(page, 'board')
    await itemPage(page).waitFor()

    // Tags and priority from the facts card.
    await itemPage(page).getByRole('radio', { name: '高', exact: true }).click()
    await expect.poll(async () => (await itemOf(mixed.id)).priority).toBe('high')
    await itemPage(page).getByRole('button', { name: '编辑标签' }).click()
    const tags = page.getByRole('dialog', { name: '标签' })
    await tags.getByRole('textbox', { name: '新标签' }).fill('依赖')
    await tags.getByRole('textbox', { name: '新标签' }).press('Enter')
    await tags.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => (await itemOf(mixed.id)).tags).toEqual(['依赖'])

    // Remove a session from its row and add one back through 加入会话.
    await row(page, another)
      .getByRole('button', { name: /^更多操作/u })
      .click()
    await page.getByRole('menuitem', { name: '移出待办', exact: true }).click()
    await expect.poll(async () => (await itemOf(mixed.id)).sessionIds.includes(another)).toBe(false)
    await row(page, another).waitFor({ state: 'detached' })
    await itemPage(page).getByRole('button', { name: '加入会话', exact: true }).click()
    const pick = page.getByRole('dialog', { name: '加入会话' })
    await pick.getByRole('button', { name: /echo 再来一个会话/u }).click()
    await pick.waitFor({ state: 'hidden' })
    await row(page, another).waitFor()

    // 完成 puts it in 已结束; 重新打开 brings back the group its sessions give it.
    await itemPage(page).getByRole('button', { name: '完成', exact: true }).click()
    await expect.poll(async () => (await itemOf(mixed.id)).board.group).toBe('done')
    await itemPage(page).getByRole('button', { name: '重新打开', exact: true }).click()
    await expect.poll(async () => (await itemOf(mixed.id)).board.group).toBe('attention')

    // The session side: 加入待办… and 移出待办 in its menu, and the header names the 待办 once it is in one.
    await switchView(page, 'chat')
    await openSession(page, loose)
    const title = page.locator('main.workspace .topbar h1').getByRole('button').first()
    await title.click()
    await page.getByRole('menuitem', { name: '加入待办…', exact: true }).click()
    const joining = page.getByRole('dialog', { name: '加入待办' })
    expect(await joining.getByRole('button', { name: /整理发布说明/u }).count()).toBe(0)
    await joining.getByRole('button', { name: /给 README 加一节/u }).click()
    await joining.waitFor({ state: 'hidden' })
    await expect.poll(async () => (await itemOf(todo.id)).sessionIds).toEqual([loose])
    await page
      .locator('main.workspace .topbar')
      .getByRole('button', { name: /给 README 加一节/u })
      .waitFor()
    await title.click()
    await page.getByRole('menuitem', { name: '移出待办', exact: true }).click()
    await expect.poll(async () => (await itemOf(todo.id)).sessionIds).toEqual([])
    await page
      .locator('main.workspace .topbar')
      .getByRole('button', { name: /给 README 加一节/u })
      .waitFor({ state: 'detached' })

    // Not started: title and 要求 can change, and 开始 stands where 再开一个 will.
    await openItem(page, todo.id)
    const field = itemPage(page).getByRole('region', { name: '要求' }).locator('textarea')
    await expect.poll(() => field.inputValue()).toBe('写一节安装说明')
    await shots(page, 'todo', [1440, 900])
    await field.fill('写一节安装说明，含 pnpm 的版本')
    await itemPage(page).getByRole('region', { name: '要求' }).getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => (await itemOf(todo.id)).prompt).toBe('写一节安装说明，含 pnpm 的版本')
    await itemPage(page)
      .getByRole('button', { name: /^标题/u })
      .click()
    await itemPage(page).getByRole('textbox', { name: '标题' }).fill('给 README 加安装一节')
    await itemPage(page).getByRole('textbox', { name: '标题' }).press('Enter')
    await expect.poll(async () => (await itemOf(todo.id)).title).toBe('给 README 加安装一节')
    await itemPage(page).getByRole('button', { name: '开始', exact: true }).waitFor()

    // Done: 重新打开 in the head, no 再开一个.
    await openItem(page, finished.id)
    await itemPage(page).getByRole('button', { name: '重新打开', exact: true }).waitFor()
    expect(await itemPage(page).getByRole('button', { name: '再开一个', exact: true }).count()).toBe(0)
    await shots(page, 'done', [1440, 900])

    // Phone: a pushed page, the facts card first, ← 看板 in its head.
    await openItem(phone, mixed.id)
    const facts = await itemPage(phone).locator('.item-page-facts').boundingBox()
    const sessions = await itemPage(phone).getByRole('region', { name: '会话' }).boundingBox()
    expect(facts!.y).toBeLessThan(sessions!.y)
    await shots(phone, 'mixed', [390])
    await openItem(phone, todo.id)
    await shots(phone, 'todo', [390])
    await itemPage(phone).getByRole('button', { name: '看板', exact: true }).click()
    await phone.locator('.work-board-phone').waitFor()

    // Deleting the 待办 keeps its sessions.
    await openItem(page, mixed.id)
    await itemPage(page).getByRole('button', { name: '待办操作' }).click()
    await page.getByRole('menuitem', { name: '删除待办', exact: true }).click()
    await page.getByRole('dialog', { name: '删除待办' }).getByRole('button', { name: '删除', exact: true }).click()
    await page.locator('.work-board-columns').waitFor()
    expect((await owner.json<AppSnapshot>('snapshot')).items?.some(item => item.id === mixed.id)).toBe(false)
    expect(await summaryOf(reviewed)).toBeTruthy()
    const record: WorkItem | undefined = (await owner.json<AppSnapshot>('snapshot')).items?.find(item => item.id === todo.id) as
      | WorkItem
      | undefined
    expect(record?.title).toBe('给 README 加安装一节')
    await phoneContext.close()
  } finally {
    await browser?.close()
    await host.close()
  }
})
