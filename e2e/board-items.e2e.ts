import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { AppSnapshot, WorkItemAnswer, WorkItemStartAnswer, WorkItemSummary, WorkspaceInfo } from '@latch/protocol'
import { latchEnv } from '@latch/host/env'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, settleShell } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'
import { switchView } from './helpers/workbench.ts'
import { promptValue } from './helpers/prompt.ts'

const OUT = 'test-results/board-items'

const board = (page: Page) => page.locator('.work-board')
const column = (page: Page, name: string) => board(page).getByRole('region', { name, exact: true })
const itemCard = (page: Page, id: string) => board(page).locator(`.work-board-card[data-work-item="${id}"]`)

async function openBoard(page: Page): Promise<void> {
  await switchView(page, 'board')
  await page.locator('.work-board').waitFor()
}

async function shot(page: Page, name: string, width: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.evaluate(() => document.fonts.ready)
  await settleShell(page)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${OUT}/${name}--${theme}--${width}.png`, animations: 'disabled', caret: 'hide' })
}

it('keeps 待办 in 未开始, starts them as one card with their sessions, and edits and deletes them', async () => {
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
    const create = async (title: string, prompt: string, extra: object = {}) =>
      (
        await owner.json<WorkItemAnswer>('work/items', {
          method: 'POST',
          body: { requestId: randomUUID(), title, prompt, projectId: project.id, harnessId: 'fake', ...extra },
        })
      ).item
    const itemOf = async (id: string) => (await owner.json<AppSnapshot>('snapshot')).items?.find(item => item.id === id)

    browser = await chromium.launch(browserLaunchOptions())
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    await stillMotion(context)
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    await enrollBrowser(page, host, { name: '待办设备', scopes: ['admin'] })
    const workContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    const work = await workContext.newPage()
    work.setDefaultTimeout(20_000)
    await enrollBrowser(work, host, { name: '工作设备', scopes: ['view', 'run'], dataScope: 'work' })

    const release = await create('整理发布说明', 'echo 整理发布说明')
    // Both 高: the newer first, so 全部开始 takes readme, then stale.
    const stale = await create('升级依赖', 'echo 升级依赖', { priority: 'high' })
    const readme = await create('给 README 加一节', 'echo 给 README 加一节\n第二行写清安装步骤', { priority: 'high', tags: ['文档'] })
    const running = await create('重写设置页', 'hang 重写设置页')
    await openBoard(page)
    for (const item of [readme, release, stale, running]) await column(page, '未开始').locator(`[data-work-item="${item.id}"]`).waitFor()
    // 高 first; the card has its suggested Harness, project and tags, and its whole 要求 on request.
    const order = await column(page, '未开始')
      .locator('.work-board-card')
      .evaluateAll(items => items.map(item => item.getAttribute('data-work-item')))
    expect(order[0]).toBe(readme.id)
    await itemCard(page, readme.id).getByText('文档', { exact: true }).waitFor()
    await itemCard(page, readme.id).getByRole('button', { name: '要求' }).click()
    await itemCard(page, readme.id)
      .getByText(/第二行写清安装步骤/u)
      .waitFor()
    await shot(page, 'todo', 1440, 'light')
    await shot(page, 'todo', 1440, 'dark')
    await shot(page, 'todo-3x2', 1100, 'light')
    await shot(page, 'todo-3x2', 1100, 'dark')
    await page.setViewportSize({ width: 1440, height: 900 })

    // A device without the full data scope sees a 待办 that is not private, and counts it.
    await openBoard(work)
    await itemCard(work, readme.id).waitFor()
    expect(await column(work, '未开始').locator('.work-board-column-head').textContent()).toMatch(/^未开始4(全部开始)?$/u)

    // 新建 with 先不开始: a 待办 in 未开始, titled by its first line, with its priority and tags; no session starts.
    const sessionsBefore = (await owner.json<AppSnapshot>('snapshot')).tasks.length
    await board(page).getByRole('button', { name: '新建', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '新建' })
    await dialog.locator('.composer-input [role="textbox"]').fill('echo 补一份迁移说明\n细节稍后')
    await dialog.getByRole('switch', { name: '先不开始' }).click()
    await dialog.getByRole('radio', { name: '低', exact: true }).click()
    const tagField = dialog.getByRole('textbox', { name: '标签', exact: true })
    await tagField.fill('迁移')
    await tagField.press('Enter')
    await shot(page, 'new-later', 1440, 'light')
    await shot(page, 'new-later', 1440, 'dark')
    await page.setViewportSize({ width: 1440, height: 900 })
    await dialog.getByRole('button', { name: '发送', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    let kept: WorkItemSummary | undefined
    await expect
      .poll(async () => {
        kept = (await owner.json<AppSnapshot>('snapshot')).items?.find(item => item.title.startsWith('echo 补一份迁移说明'))
        return kept?.board.group
      })
      .toBe('todo')
    expect(kept).toMatchObject({ priority: 'low', tags: ['迁移'], hasPrompt: true })
    expect((await owner.json<AppSnapshot>('snapshot')).tasks.length).toBe(sessionsBefore)
    await expect.poll(() => itemCard(page, kept!.id).getAttribute('data-marked')).toBe('')

    // 编辑… from the card's menu while it has no session.
    await itemCard(page, kept!.id).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '编辑…' }).click()
    const edit = page.getByRole('dialog', { name: '编辑待办' })
    const title = edit.getByRole('textbox', { name: '标题' })
    await expect.poll(() => title.inputValue()).not.toBe('')
    await title.fill('迁移说明')
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => (await itemOf(kept!.id))?.title).toBe('迁移说明')

    // A start bound to a revision the 待办 has left starts nothing; the card shows the 要求 as it now is.
    await page.route(`**/link/api/work/items/${stale.id}/start`, async route => {
      await owner.json(`work/items/${stale.id}`, {
        method: 'PATCH',
        body: { baseRevision: stale.revision, prompt: 'echo 升级依赖到最新版并跑测试' },
      })
      await route.continue()
    })
    // 全部开始 goes card by card in the column's order (高 first), and stops at the first refusal.
    const rejectedStart = page.waitForResponse(
      response => response.url().endsWith(`/link/api/work/items/${stale.id}/start`) && response.request().method() === 'POST',
    )
    await column(page, '未开始').getByRole('button', { name: '全部开始' }).click()
    const conflict = await rejectedStart
    expect(conflict.status()).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: 'item-changed' })
    await itemCard(page, stale.id).getByText('待办已被修改，请刷新后再试。', { exact: true }).waitFor()
    await itemCard(page, stale.id)
      .getByText(/升级依赖到最新版并跑测试/u)
      .waitFor()
    expect((await itemOf(stale.id))?.sessionIds).toEqual([])
    await page.unroute(`**/link/api/work/items/${stale.id}/start`)
    // The ones before it started, each as the same card with its session as a row.
    const started = await itemOf(readme.id)
    expect(started?.sessionIds.length).toBe(1)
    await shot(page, 'stale', 1440, 'light')
    await page.setViewportSize({ width: 1440, height: 900 })
    await itemCard(page, stale.id).getByRole('button', { name: '知道了' }).click()

    // 开始 opens the input with the 待办's 要求 and suggestions; the started card is the same card, now 进行中.
    await itemCard(page, running.id).getByRole('button', { name: '开始', exact: true }).click()
    const start = page.getByRole('dialog', { name: '开始' })
    await expect.poll(() => promptValue(start.locator('.composer-input [role="textbox"]'))).toBe('hang 重写设置页')
    await shot(page, 'start', 1440, 'light')
    await page.setViewportSize({ width: 1440, height: 900 })
    await start.getByRole('button', { name: '发送', exact: true }).click()
    await start.waitFor({ state: 'hidden' })
    await column(page, '进行中').locator(`[data-work-item="${running.id}"]`).waitFor({ timeout: 30_000 })
    const runningItem = await itemOf(running.id)
    expect(runningItem?.sessionIds.length).toBe(1)
    await itemCard(page, running.id).locator(`[data-work-session="${runningItem!.sessionIds[0]}"]`).waitFor()
    // Its session is a row of the card, never a card of its own.
    expect(await board(page).locator(`.work-board-card[data-work-session="${runningItem!.sessionIds[0]}"]`).count()).toBe(0)

    // A 待办 with one session failed and another running waits on the person, and says the failed one's words.
    const broken = await create('修复登录', 'crash 修复登录')
    const brokenStart = await owner.json<{ sessionId: string }>(`work/items/${broken.id}/start`, {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: broken.revision },
    })
    await expect.poll(async () => (await itemOf(broken.id))?.board.group, { timeout: 30_000 }).toBe('attention')
    const after = (await itemOf(broken.id))!
    await owner.json(`work/items/${broken.id}/start`, {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: after.revision, prompt: 'hang 再看一遍登录' },
    })
    await column(page, '等你处理')
      .locator(`[data-work-item="${broken.id}"]`)
      .getByText(/^失败/u)
      .first()
      .waitFor()
    await itemCard(page, broken.id).locator(`[data-work-session="${brokenStart.sessionId}"]`).waitFor()
    await expect.poll(() => itemCard(page, broken.id).locator('.work-board-item-sessions > li').count()).toBe(2)

    // Every session of a started 待办 ended: 可交付 with 完成, then 已结束.
    await expect.poll(async () => (await itemOf(readme.id))?.board, { timeout: 30_000 }).toEqual({ group: 'deliver', reason: 'settled' })
    const completedSession = started!.sessionIds[0]!
    await owner.json(`work/items/${readme.id}/sessions/${completedSession}`, { method: 'DELETE' })
    const cardWithoutMember = column(page, '未开始').locator(`.work-board-card[data-work-item="${readme.id}"]`)
    await cardWithoutMember.waitFor()
    expect(await cardWithoutMember.locator(`[data-work-session="${completedSession}"]`).count()).toBe(0)
    expect(await cardWithoutMember.getByText('1 个未加入', { exact: true }).count()).toBe(0)
    await owner.json(`work/items/${readme.id}/sessions`, { method: 'POST', body: { sessionId: completedSession } })
    await itemCard(page, readme.id).locator(`[data-work-session="${completedSession}"]`).waitFor()
    expect(
      await itemCard(page, readme.id)
        .locator('.work-board-item-sessions')
        .evaluate(el => getComputedStyle(el).borderTopWidth),
    ).toBe('0px')
    await shot(page, 'started', 1440, 'light')
    await shot(page, 'started', 1440, 'dark')
    await page.setViewportSize({ width: 1440, height: 900 })
    await itemCard(page, readme.id).getByRole('button', { name: '完成', exact: true }).click()
    await column(page, '已结束').locator(`[data-work-item="${readme.id}"]`).waitFor()

    // The list: a 待办's row with its sessions under it; 未开始 as a state.
    await board(page).getByRole('radio', { name: '表', exact: true }).click()
    await board(page).locator(`.work-board-row[data-work-item="${running.id}"]`).waitFor()
    await board(page).locator(`.work-board-row[data-nested][data-work-session="${runningItem!.sessionIds[0]}"]`).waitFor()
    await board(page)
      .getByRole('button', { name: /^未开始/u })
      .click()
    await board(page).locator(`.work-board-row[data-work-item="${stale.id}"]`).waitFor()
    expect(await board(page).locator(`.work-board-row[data-work-item="${running.id}"]`).count()).toBe(0)
    await shot(page, 'list', 1440, 'light')
    await shot(page, 'list', 1440, 'dark')
    await page.setViewportSize({ width: 1440, height: 900 })
    await board(page).getByRole('radio', { name: '板', exact: true }).click()

    // A 待办's card opens its page on the board, not 对话; back returns.
    await itemCard(page, release.id).locator('.work-board-card-main').click()
    await board(page).locator(`.item-page[data-item-id="${release.id}"]`).waitFor()
    await board(page).locator('.item-page').getByRole('button', { name: '看板', exact: true }).click()
    await itemCard(page, release.id).waitFor()

    // Deleting a 待办 keeps its sessions: they stand as cards of their own.
    const session = runningItem!.sessionIds[0]!
    await itemCard(page, running.id).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除待办…' }).click()
    await page.getByRole('dialog', { name: '删除待办' }).getByRole('button', { name: '删除', exact: true }).click()
    await board(page).locator(`.work-board-card[data-work-session="${session}"]`).waitFor()
    expect(await itemOf(running.id)).toBeUndefined()

    // The Host can report that a start created a session without joining it. Its card still stands on its own.
    const outsidePath = `**/link/api/work/items/${release.id}/start`
    await page.route(outsidePath, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      const { item } = await owner.json<WorkItemAnswer>(`work/items/${release.id}`)
      return route.fulfill({
        status: 201,
        json: { sessionId: session, outside: 'item-full', item } satisfies WorkItemStartAnswer,
      })
    })
    await itemCard(page, release.id).getByRole('button', { name: '开始', exact: true }).click()
    await page.getByRole('dialog', { name: '开始', exact: true }).getByRole('button', { name: '发送', exact: true }).click()
    await itemCard(page, release.id).getByText('1 个未加入', { exact: true }).waitFor()
    expect((await itemOf(release.id))?.sessionIds).toEqual([])
    await page.unroute(outsidePath)

    // Phone: 未开始 is a state of the list.
    await page.setViewportSize({ width: 390, height: 844 })
    await board(page).locator('.work-board-phone').waitFor()
    await board(page)
      .getByRole('group', { name: '状态' })
      .getByRole('button', { name: /^未开始/u })
      .click()
    await board(page).getByRole('list', { name: '未开始' }).locator(`[data-work-item="${stale.id}"]`).waitFor()
    await shot(page, 'phone-todo', 390, 'light')
    await shot(page, 'phone-todo', 390, 'dark')
    await workContext.close()
  } finally {
    await browser?.close()
    await host.close()
  }
})
