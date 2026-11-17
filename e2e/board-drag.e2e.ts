import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { AppSnapshot, WorkItemAnswer, WorkspaceInfo } from '@latch/protocol'
import { latchEnv } from '@latch/host/env'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { settleShell } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'
import { switchView } from './helpers/workbench.ts'

const OUT = 'test-results/board-drag'

const board = (page: Page) => page.locator('.work-board')
const column = (page: Page, name: string) => board(page).getByRole('region', { name, exact: true })
const itemCard = (page: Page, id: string) => board(page).locator(`.work-board-card[data-work-item="${id}"]`)
const sessionCard = (page: Page, id: string) => board(page).locator(`.work-board-card[data-work-session="${id}"]`)

/** Presses the card's own button, moves past the threshold and over `to`'s middle, holding the button. */
async function hold(page: Page, card: Locator, to: Locator): Promise<void> {
  const from = (await card.locator('.work-board-card-main').boundingBox())!
  const over = (await to.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + 14)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 4, from.y + 18, { steps: 2 })
  const x = over.x + over.width / 2
  const y = over.y + over.height / 2
  await page.mouse.move(x, y, { steps: 12 })
  await expect.poll(() => board(page).getAttribute('data-dragging')).toBe('')
  // The copy stays under the pointer where the card was pressed: 14px below its top, at its middle.
  const ghost = (await board(page).locator('.work-board-ghost').boundingBox())!
  expect(Math.abs(ghost.y - (y - 14))).toBeLessThan(3)
  expect(Math.abs(ghost.x + from.width / 2 - x)).toBeLessThan(3)
}

async function capture(page: Page, name: string, width: number): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: `${OUT}/${name}--${theme}--${width}.png`, animations: 'disabled', caret: 'hide' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

it('drags a card between columns: the drop does the card’s own action, the Host’s group places it', async () => {
  const host = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'), demo: true, hostName: '拖动电脑' })
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
    const create = async (title: string, prompt: string) =>
      (
        await owner.json<WorkItemAnswer>('work/items', {
          method: 'POST',
          body: { requestId: randomUUID(), title, prompt, projectId: project.id, harnessId: 'fake' },
        })
      ).item
    const snapshot = () => owner.json<AppSnapshot>('snapshot')
    const itemOf = async (id: string) => (await snapshot()).items?.find(item => item.id === id)
    const taskOf = async (id: string) => (await snapshot()).tasks.find(task => task.id === id)

    browser = await chromium.launch(browserLaunchOptions())
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    await stillMotion(context)
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    await enrollBrowser(page, host, { name: '拖动设备', scopes: ['admin'] })
    const todo = await create('整理发布说明', 'echo 整理发布说明')
    const live = await create('重写设置页', 'hang 重写设置页')
    await owner.json(`work/items/${live.id}/start`, { method: 'POST', body: { requestId: randomUUID(), baseRevision: live.revision } })
    const failed = (
      await owner.confirmedJson<{ sessionId: string }>('tasks', {
        body: { prompt: 'crash 升级依赖', requestId: randomUUID(), workspaceId: project.id, mode: 'agent', harnessId: 'fake' },
      })
    ).sessionId
    const running = (
      await owner.confirmedJson<{ sessionId: string }>('tasks', {
        body: { prompt: 'steerable 巡检日志', requestId: randomUUID(), workspaceId: project.id, mode: 'agent', harnessId: 'fake' },
      })
    ).sessionId
    // It works until it is stopped, and stops on cancel.
    await owner.json(`tasks/${running}`, { method: 'PATCH', body: { title: '巡检日志' } })
    await expect.poll(async () => (await itemOf(live.id))?.board.group, { timeout: 30_000 }).toBe('running')
    await expect.poll(async () => (await taskOf(failed))?.board?.group, { timeout: 30_000 }).toBe('attention')
    await expect.poll(async () => (await taskOf(running))?.board?.group, { timeout: 30_000 }).toBe('running')

    await switchView(page, 'board')
    for (const card of [itemCard(page, todo.id), itemCard(page, live.id), sessionCard(page, failed), sessionCard(page, running)])
      await card.waitFor()
    await settleShell(page)

    // A click still opens the card: the 待办's page on the board.
    await itemCard(page, todo.id).locator('.work-board-card-main').click()
    await board(page).locator(`.item-page[data-item-id="${todo.id}"]`).waitFor()
    await board(page).locator('.item-page').getByRole('button', { name: '看板', exact: true }).click()
    await itemCard(page, todo.id).waitFor()

    // Held over 等你处理: forbidden there and on 可交付 and 已结束, 进行中 the one target, its own column as it was.
    const writes: string[] = []
    page.on('request', request => {
      if (request.method() !== 'GET' && /\/link\/api\/(work|tasks)\//u.test(request.url())) writes.push(request.url())
    })
    await hold(page, itemCard(page, todo.id), column(page, '等你处理'))
    const drop = (name: string) => column(page, name).getAttribute('data-drop')
    expect(await drop('未开始')).toBe('source')
    expect(await drop('进行中')).toBe('target')
    for (const name of ['等你处理', '可交付', '已结束']) {
      expect(await drop(name)).toBe('forbidden')
      await column(page, name).getByRole('img', { name: '不能放到这里' }).waitFor()
    }
    expect(await column(page, '等你处理').evaluate(element => getComputedStyle(element).cursor)).toBe('not-allowed')
    await capture(page, 'drag-todo', 1440)
    // Dropped there, nothing happens: the card is back in 未开始 and nothing was sent.
    await page.mouse.up()
    await expect.poll(() => board(page).getAttribute('data-dragging')).toBeNull()
    await column(page, '未开始').locator(`[data-work-item="${todo.id}"]`).waitFor()
    expect(await page.getByRole('dialog', { name: '开始' }).count()).toBe(0)
    expect(await board(page).locator('.work-board-item-page, .item-page').count()).toBe(0)
    expect(writes).toEqual([])

    // Esc puts it back as well.
    await hold(page, itemCard(page, todo.id), column(page, '进行中'))
    expect(await column(page, '进行中').getAttribute('data-over')).toBe('')
    await page.keyboard.press('Escape')
    await expect.poll(() => board(page).getAttribute('data-dragging')).toBeNull()
    await page.mouse.up()
    expect(await page.getByRole('dialog', { name: '开始' }).count()).toBe(0)
    expect(writes).toEqual([])

    // Dropped on 进行中: the same start dialog as 开始, with the 待办's 要求.
    await hold(page, itemCard(page, todo.id), column(page, '进行中'))
    await page.mouse.up()
    const start = page.getByRole('dialog', { name: '开始' })
    await expect.poll(() => start.locator('textarea').inputValue()).toBe('echo 整理发布说明')
    await page.keyboard.press('Escape')
    await start.waitFor({ state: 'hidden' })
    expect((await itemOf(todo.id))?.sessionIds).toEqual([])

    // A started 待办 dropped on 已结束 is 已完成; dropped back on 进行中 it is reopened, and its running session keeps it there.
    await hold(page, itemCard(page, live.id), column(page, '已结束'))
    expect(await drop('已结束')).toBe('target')
    expect(await drop('等你处理')).toBe('forbidden')
    await page.mouse.up()
    await column(page, '已结束').locator(`[data-work-item="${live.id}"]`).getByText('已完成', { exact: true }).waitFor()
    expect((await itemOf(live.id))?.closedAt).toBeDefined()
    await hold(page, itemCard(page, live.id), column(page, '进行中'))
    expect(await drop('进行中')).toBe('target')
    await page.mouse.up()
    await column(page, '进行中').locator(`[data-work-item="${live.id}"]`).waitFor()
    expect((await itemOf(live.id))?.closedAt).toBeUndefined()

    // A running session held over 已结束, then the stop confirm where it was dropped.
    await hold(page, sessionCard(page, running), column(page, '已结束'))
    expect(await drop('已结束')).toBe('target')
    expect(await drop('未开始')).toBe('forbidden')
    // The column under the pointer is the drop's place: the accent's tint over its fill, besides the hairline.
    expect(await column(page, '已结束').evaluate(element => getComputedStyle(element).backgroundImage)).not.toBe('none')
    await capture(page, 'drag-session', 1440)
    await page.mouse.up()
    const confirm = page.getByRole('dialog', { name: '停止会话' })
    await confirm.waitFor()
    // Dropped near the window's end, the confirm keeps the board's gutter from it.
    expect(await confirm.evaluate(element => innerWidth - element.getBoundingClientRect().right)).toBeGreaterThanOrEqual(15.5)
    await capture(page, 'stop-confirm', 1440)
    // 取消 does nothing; the confirm's 停止 stops it, and the card goes where the Host says once the run settled.
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    await confirm.waitFor({ state: 'hidden' })
    expect((await taskOf(running))?.board?.group).toBe('running')
    await hold(page, sessionCard(page, running), column(page, '已结束'))
    await page.mouse.up()
    await confirm.getByRole('button', { name: '停止', exact: true }).click()
    await confirm.waitFor({ state: 'hidden' })
    await expect.poll(async () => (await taskOf(running))?.board?.group, { timeout: 30_000 }).not.toBe('running')
    await sessionCard(page, running).waitFor()
    await expect.poll(() => column(page, '进行中').locator(`[data-work-session="${running}"]`).count()).toBe(0)

    // With motion allowed, a drop where the card may not go returns its copy with a short motion, then removes it.
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await hold(page, sessionCard(page, failed), column(page, '可交付'))
    await page.mouse.up()
    expect(await board(page).locator('.work-board-ghost').count()).toBe(1)
    await expect.poll(() => board(page).locator('.work-board-ghost').count()).toBe(0)
    await page.emulateMedia({ reducedMotion: 'reduce' })

    // A failed run dropped on 已结束 is marked opened and checked: an answer that never came says 结果未知 with 重试,
    // which sends the same request; then it leaves 等你处理 and keeps 失败.
    await page.route(`**/link/api/tasks/${failed}/attend`, route => route.abort('connectionreset'))
    await hold(page, sessionCard(page, failed), column(page, '已结束'))
    await page.mouse.up()
    await sessionCard(page, failed).getByText('结果未知', { exact: true }).waitFor()
    expect(await sessionCard(page, failed).getAttribute('data-write')).toBe('')
    // A card with an unanswered write takes no new drop.
    await hold(page, sessionCard(page, failed), column(page, '已结束'))
    expect(await drop('已结束')).toBe('forbidden')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.unroute(`**/link/api/tasks/${failed}/attend`)
    await sessionCard(page, failed).getByRole('button', { name: '重试', exact: true }).click()
    await expect.poll(async () => (await taskOf(failed))?.board?.group, { timeout: 20_000 }).not.toBe('attention')
    await sessionCard(page, failed)
      .getByText(/^失败/u)
      .first()
      .waitFor()

    // 3 + 2: a 待办 held over the lower row.
    await page.setViewportSize({ width: 1100, height: 900 })
    await settleShell(page)
    await hold(page, itemCard(page, todo.id), column(page, '可交付'))
    expect(await drop('进行中')).toBe('target')
    expect(await drop('可交付')).toBe('forbidden')
    await capture(page, 'drag-todo-3x2', 1100)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    // 2 + 2 + 1: 进行中 still takes the drop.
    await page.setViewportSize({ width: 760, height: 900 })
    await settleShell(page)
    await hold(page, itemCard(page, todo.id), column(page, '进行中'))
    expect(await column(page, '进行中').getAttribute('data-over')).toBe('')
    await page.mouse.up()
    await start.waitFor()
    await page.keyboard.press('Escape')
    await start.waitFor({ state: 'hidden' })
  } finally {
    await browser?.close()
    await host.close()
  }
})
