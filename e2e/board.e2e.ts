import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { AppSnapshot, Automation, BoardGroup, CustomAgent, TaskDetail, TaskSummary, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { latchEnv } from '@latch/host/env'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, settleShell } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'
import { switchView } from './helpers/workbench.ts'

const OUT = 'test-results/board'
type Column = 'todo' | BoardGroup
const GROUPS: readonly Column[] = ['todo', 'attention', 'running', 'deliver', 'done']
const LABELS: Record<Column, string> = { todo: '未开始', attention: '等你处理', running: '进行中', deliver: '可交付', done: '已结束' }

/** The 「对话 | 看板」 switch in the title row (or the phone's heading): the one way onto the board. */
async function openBoard(page: Page): Promise<void> {
  await switchView(page, 'board')
  await page.locator('.work-board').waitFor()
}

const board = (page: Page) => page.locator('.work-board')
const column = (page: Page, group: Column) => board(page).getByRole('region', { name: LABELS[group], exact: true })
const card = (page: Page, id: string) => board(page).locator(`.work-board-card[data-work-session="${id}"]`)

async function shot(page: Page, name: string, width: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.evaluate(() => document.fonts.ready)
  await settleShell(page)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${OUT}/${name}--${theme}--${width}.png`, animations: 'disabled', caret: 'hide' })
}

/** Each column's box, left to right as the page draws them. */
async function cells(page: Page) {
  return page.locator('.work-board-columns > *').evaluateAll(items =>
    items.map(item => {
      const box = item.getBoundingClientRect()
      return { name: item.getAttribute('aria-label'), x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width) }
    }),
  )
}

/** Rows of cells, top to bottom, each left to right: how the board is laid out at this width. */
async function rows(page: Page): Promise<number[]> {
  const boxes = await cells(page)
  const tops = [...new Set(boxes.map(box => box.y))].toSorted((a, b) => a - b)
  return tops.map(top => boxes.filter(box => box.y === top).length)
}

it('lays the Host’s groups out as a board that reflows by its own width, and works its cards', async () => {
  // A local scripted model that asks to write one file: an ordinary R1 request, answered on the card.
  const plugin: HarnessPlugin = {
    id: 'board-states',
    name: '看板状态',
    version: '1',
    description: 'Local scripted provider only.',
    activate(context) {
      context.registerProvider({
        id: 'board-model',
        name: '本地看板模型',
        model: 'fixture',
        async *stream({ messages }) {
          if (messages.at(-1)?.role !== 'tool') {
            yield { type: 'text', text: '需要写入配置。' }
            yield {
              type: 'tool-call',
              call: { id: randomUUID(), name: 'write_file', arguments: { path: 'settings.ts', content: 'export const keep = true\n' } },
            }
            yield { type: 'finish', reason: 'tool-calls' }
            return
          }
          yield { type: 'text', text: '已写入。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({
    uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
    demo: false,
    plugins: [plugin],
    providerId: 'board-model',
    hostName: '看板电脑',
  })
  let browser: Browser | undefined
  try {
    await mkdir(OUT, { recursive: true })
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', { body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] } })
    // Mounting Latch's MCP servers keeps a background run within the level a schedule may use.
    await owner.confirmedJson('agents', {
      body: { id: 'fake-agent', name: 'Fake Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_MCP: 'dsh' } },
    })
    const repo = join(host.root, 'release')
    await mkdir(repo)
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    await writeFile(join(repo, 'tracked.txt'), 'committed\n')
    git('add', '.')
    git('commit', '-q', '-m', 'first')
    const notes = join(host.root, 'notes')
    await mkdir(notes)
    await writeFile(join(notes, 'settings.ts'), 'export const keep = false\n')
    await owner.addFolders({ name: '发版仓库', paths: [repo] })
    await owner.addFolders({ name: '笔记', paths: [notes] })
    const { workspaces } = await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')
    const repoProject = workspaces.find(item => item.name === '发版仓库')!
    const notesProject = workspaces.find(item => item.name === '笔记')!

    // Devices connect first: a confirmation waits while an external Harness runs.
    browser = await chromium.launch(browserLaunchOptions())
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    await stillMotion(context)
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    await enrollBrowser(page, host, { name: '看板设备', scopes: ['admin'] })
    const devices = (await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')).devices
    await owner.confirmedJson(`devices/${devices.find(item => item.name === '看板设备')!.id}`, {
      method: 'PATCH',
      body: { dataScope: 'all' },
    })
    const workContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    const work = await workContext.newPage()
    work.setDefaultTimeout(20_000)
    await enrollBrowser(work, host, { name: '工作设备', scopes: ['view', 'run', 'approve:standard'], dataScope: 'work' })
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
    await enrollBrowser(phone, host, { name: '看板手机', scopes: ['view', 'run'] })
    const start = async (prompt: string, workspaceId: string, extra: object = { mode: 'agent', harnessId: 'fake' }) =>
      (await owner.confirmedJson<{ sessionId: string }>('tasks', { body: { prompt, requestId: randomUUID(), workspaceId, ...extra } }))
        .sessionId
    const summaryOf = async (id: string) => (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.id === id)
    const groupOf = async (id: string) => (await summaryOf(id))?.board?.group
    const done1 = await start('echo 整理发布说明', notesProject.id)
    const done2 = await start('echo 解释注册顺序', notesProject.id)
    await expect.poll(() => groupOf(done2), { timeout: 20_000 }).toBe('done')
    const delivered = await start('shell-edit 加上健康检查', repoProject.id)
    await expect.poll(() => groupOf(delivered), { timeout: 20_000 }).toBe('deliver')
    const failed = await start('crash 升级依赖', notesProject.id)
    const asking = await start('elicit 选一个发布日期', notesProject.id)
    const stuck = await start('unknownhang 清理远端分支', notesProject.id)
    const running = await start('hang 重写设置页', notesProject.id)
    const approval = await start('保存配置', notesProject.id, { model: { providerId: 'board-model', model: 'fixture' } })
    await expect.poll(() => groupOf(failed), { timeout: 20_000 }).toBe('attention')
    await expect.poll(async () => (await summaryOf(asking))?.board?.reason, { timeout: 20_000 }).toBe('question')
    await expect.poll(async () => (await summaryOf(stuck))?.board?.reason, { timeout: 20_000 }).toBe('unrecognized')
    await expect.poll(async () => (await summaryOf(approval))?.board?.reason, { timeout: 20_000 }).toBe('approval')
    await expect.poll(() => groupOf(running), { timeout: 20_000 }).toBe('running')
    // A scheduled run of one of 我的 Agent: a card, and private, so a 「work」 device never sees it or counts it.
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '巡检',
        description: '每天看一眼',
        harnessId: 'fake-agent',
        mode: 'agent',
        defaultProjectId: notesProject.id,
      },
    })
    const schedule = await owner.json<Automation>('automations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '早间巡检',
        customAgentId: agent.id,
        projectId: notesProject.id,
        prompt: 'hang 巡检',
        schedule: { kind: 'daily', time: '08:00' },
        enabled: false,
        notify: false,
      },
    })
    await owner.json(`automations/${schedule.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
    let scheduled: TaskSummary | undefined
    await expect
      .poll(
        async () => {
          scheduled = (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.automationId === schedule.id)
          return scheduled?.board?.card
        },
        { timeout: 20_000 },
      )
      .toBe(true)
    await owner.json(`tasks/${done1}`, { method: 'PATCH', body: { tags: ['发版', '文档'], priority: 'high' } })
    await owner.json(`tasks/${done2}`, { method: 'PATCH', body: { priority: 'low' } })

    await page.reload()
    await connected(page)
    await openBoard(page)

    // Every card stands in the column of the Host's group, and nothing else is a card.
    const snapshot = await owner.json<AppSnapshot>('snapshot')
    for (const task of snapshot.tasks.filter(item => item.board?.card)) {
      const where = column(page, task.board!.group).locator(`.work-board-card[data-work-session="${task.id}"]`)
      await where.waitFor()
    }
    expect(await board(page).locator('.work-board-card').count()).toBe(snapshot.tasks.filter(item => item.board?.card).length)
    for (const group of GROUPS) {
      const count = snapshot.tasks.filter(task => task.board?.card && task.board.group === group).length
      expect(await column(page, group).locator('.work-board-column-head').textContent()).toContain(String(count))
    }
    // A quiet column is still present and labeled.
    const columnFill = (group: Column) => column(page, group).evaluate(el => getComputedStyle(el).backgroundColor)
    expect(await column(page, 'todo').getAttribute('data-empty')).toBe('')
    expect(await column(page, 'attention').getAttribute('data-empty')).toBeNull()
    expect(await columnFill('todo')).toBe('rgba(0, 0, 0, 0)')
    // Priority first within a column: 高 above the rest of 已结束.
    const doneOrder = await column(page, 'done')
      .locator('.work-board-card')
      .evaluateAll(items => items.map(item => item.getAttribute('data-work-session')))
    expect(doneOrder.indexOf(done1)).toBe(0)
    expect(doneOrder.at(-1)).toBe(done2)
    await card(page, scheduled!.id).getByText('定时 早间巡检').waitFor()
    await card(page, failed)
      .getByText(/^失败/u)
      .waitFor()
    // The board stands alone: where the session list and the input would be, there is the board.
    const covers = (x: number, y: number) =>
      page.evaluate(([px, py]) => !!document.elementFromPoint(px!, py!)?.closest('.work-board'), [x, y] as const)
    expect(await covers(120, 400)).toBe(true)
    expect(await covers(720, 860)).toBe(true)
    await shot(page, 'board', 1440, 'light')
    expect(await columnFill('attention')).not.toBe(await columnFill('todo'))
    await shot(page, 'board', 1440, 'dark')
    // Dark monochrome keeps both columns on the black canvas. Hover lifts the entire card, including its footer.
    expect(await columnFill('attention')).toBe(await columnFill('todo'))
    const ordinaryCard = card(page, done1)
    const mainButton = ordinaryCard.locator('.work-board-card-main')
    const cardFill = () => ordinaryCard.evaluate(el => getComputedStyle(el).backgroundColor)
    expect(await cardFill()).toBe('rgb(8, 8, 8)')
    await mainButton.hover()
    await expect.poll(cardFill).toBe('rgb(21, 21, 21)')
    expect(await mainButton.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    await page.mouse.move(0, 0)

    // Reflow by the board's own width: five in a row, 3 + 2, 2 + 2 + 1, then the narrow list. Order never changes, and
    // an empty 未开始 keeps its cell.
    for (const [width, expected] of [
      [1440, [5]],
      [1100, [3, 2]],
      [900, [3, 2]],
      [600, [2, 2, 1]],
    ] as const) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(() => rows(page)).toEqual(expected)
      expect((await cells(page)).map(item => item.name)).toEqual(GROUPS.map(group => LABELS[group]))
      for (const item of await cells(page)) expect(item.width).toBeGreaterThanOrEqual(240)
    }
    // The title row spans the window at every width: a tablet's rail column is hidden under 看板, so the mark stands at
    // the window's start as it does wider, with nothing drawn before it.
    const titleRow = async () =>
      page.locator('.titlebar[data-board]').evaluate(row => {
        const mark = row.querySelector('.titlebar-wordmark')!.getBoundingClientRect()
        return { left: Math.round(row.getBoundingClientRect().left), mark: Math.round(mark.left), shown: mark.width > 0 }
      })
    await page.setViewportSize({ width: 1440, height: 900 })
    const wide = await titleRow()
    for (const width of [768, 900, 1023]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await titleRow()).toEqual(wide)
      // Its computer stays in reach of the pointer there too.
      await page.locator('.titlebar[data-board] .titlebar-board-computer button').first().click({ trial: true })
    }
    await page.mouse.move(0, 0)
    await page.setViewportSize({ width: 900, height: 900 })
    await shot(page, 'board-3x2', 900, 'light')
    await shot(page, 'board-3x2', 900, 'dark')
    await page.setViewportSize({ width: 400, height: 844 })
    await board(page).locator('.work-board-phone').waitFor()
    // A short board keeps every cell at least 180px tall and scrolls as a whole; each cell still scrolls its own cards.
    await page.setViewportSize({ width: 900, height: 400 })
    await page.locator('.work-board-columns').waitFor()
    for (const cell of await page.locator('.work-board-column').all())
      expect((await cell.boundingBox())!.height).toBeGreaterThanOrEqual(180)
    expect(
      await board(page)
        .locator('.work-board-body')
        .evaluate(body => body.scrollHeight > body.clientHeight),
    ).toBe(true)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('.work-board-columns').waitFor()
    await page.reload()
    await connected(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await board(page).waitFor()

    // The first ordinary request is answered on its card.
    await openBoard(work)
    const ordinary = card(work, approval).locator('.approval-panel[data-file-review]')
    await ordinary.getByText('写入文件 settings.ts', { exact: true }).waitFor()
    await ordinary.locator('.approval-preview .argument-list').getByText('settings.ts', { exact: true }).waitFor()
    expect(await ordinary.locator('.diff-view').count()).toBe(0)
    await expect.poll(() => ordinary.getByRole('button', { name: '允许', exact: true }).isEnabled()).toBe(true)
    await shot(work, 'ordinary-file-work-scope', 1440, 'light')
    await shot(work, 'ordinary-file-work-scope', 1440, 'dark')
    const decision = card(page, approval)
    await decision.locator('.approval-panel').waitFor()
    await expect.poll(() => decision.locator('.approval-panel[data-arming]').count()).toBe(0)
    await decision.getByRole('button', { name: '允许', exact: true }).click()
    await expect.poll(() => readFile(join(notes, 'settings.ts'), 'utf8'), { timeout: 20_000 }).toContain('keep = true')
    await expect.poll(() => groupOf(approval), { timeout: 20_000 }).not.toBe('attention')

    // A card opens its session in 对话; back on the board the card is marked and in view.
    await card(page, done2).locator('.work-board-card-main').click()
    await page.locator('main.workspace .topbar').getByText('echo 解释注册顺序').first().waitFor()
    expect(await covers(720, 400)).toBe(false)
    await openBoard(page)
    await expect.poll(() => card(page, done2).getAttribute('data-marked')).toBe('')
    expect(await card(page, done2).isVisible()).toBe(true)

    // Priority and tags from the card's menu (its ⋯; a right click opens the same menu).
    await card(page, running).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '高', exact: true }).click()
    await expect.poll(async () => (await summaryOf(running))?.priority).toBe('high')
    await card(page, running).getByRole('img', { name: '优先级高' }).waitFor()
    await card(page, running).hover()
    await card(page, running)
      .getByRole('button', { name: /^更多操作/u })
      .click()
    await page.getByRole('menuitem', { name: '标签…', exact: true }).click()
    // The session menu's own tag dialog: tags typed one after another or picked from other sessions, saved at once.
    const tags = page.getByRole('dialog', { name: '标签' })
    const field = tags.getByRole('textbox', { name: '新标签' })
    await field.fill('设置页')
    await field.press('Enter')
    await expect.poll(() => field.inputValue()).toBe('')
    await field.fill('前端')
    await field.press('Enter')
    await tags.getByRole('button', { name: '发版', exact: true }).click()
    await shot(page, 'board-tags', 1440, 'light')
    await shot(page, 'board-tags', 1440, 'dark')
    await tags.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => (await summaryOf(running))?.tags).toEqual(['设置页', '前端', '发版'])
    await tags.waitFor({ state: 'hidden' })
    await card(page, running).getByText('设置页', { exact: true }).waitFor()

    // Filters: by tag, remembered on this device.
    await board(page)
      .getByRole('button', { name: /^标签/u })
      .click()
    await page.getByRole('checkbox', { name: '发版' }).check()
    await page.keyboard.press('Escape')
    await expect.poll(() => board(page).locator('.work-board-card').count()).toBe(2)
    expect(await column(page, 'done').locator('.work-board-column-head').textContent()).toMatch(/1 \/ \d/u)
    await page.reload()
    await connected(page)
    await expect.poll(() => board(page).locator('.work-board-card').count()).toBe(2)
    await board(page)
      .getByRole('button', { name: /^项目/u })
      .click()
    await page.getByRole('checkbox', { name: '发版仓库', exact: true }).check()
    await page.keyboard.press('Escape')
    await expect.poll(() => board(page).locator('.work-board-card').count()).toBe(0)
    await board(page).getByText('没有符合筛选条件的卡片', { exact: true }).waitFor()
    const clear = board(page).getByRole('button', { name: '清除筛选', exact: true })
    expect(await clear.count()).toBe(1)
    await clear.click()
    await expect.poll(() => board(page).locator('.work-board-card').count()).toBeGreaterThan(2)
    expect(await board(page).getByText('没有符合筛选条件的卡片', { exact: true }).count()).toBe(0)

    // The list: every session by group, the same menu, a state filter.
    await board(page).getByRole('radio', { name: '表', exact: true }).click()
    await board(page).locator('.work-board-table').waitFor()
    await shot(page, 'list', 1440, 'light')
    await shot(page, 'list', 1440, 'dark')
    await board(page)
      .getByRole('button', { name: /^已结束/u })
      .click()
    const ended = (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.board?.card && task.board.group === 'done')
    await expect.poll(() => board(page).locator('.work-board-row').count()).toBe(ended.length)
    await board(page).getByRole('radio', { name: '板', exact: true }).click()

    // 新建 with a session open behind the board: a new session starts, the open one gets nothing, the board stays.
    const before = (await owner.json<TaskDetail>(`tasks/${done2}`)).messages.length
    await board(page).getByRole('button', { name: '新建', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '新建' })
    await dialog.locator('.composer-input [role="textbox"]').fill('echo 从看板开始')
    await shot(page, 'board-new', 1440, 'light')
    await shot(page, 'board-new', 1440, 'dark')
    await dialog.getByRole('button', { name: '发送', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    let fresh: TaskSummary | undefined
    await expect
      .poll(async () => {
        fresh = (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.title.includes('从看板开始'))
        return fresh?.id
      })
      .toBeTruthy()
    await expect.poll(() => card(page, fresh!.id).getAttribute('data-marked')).toBe('')
    expect((await owner.json<TaskDetail>(`tasks/${done2}`)).messages.length).toBe(before)
    await board(page).waitFor()

    // A device that may not read private sessions: no card, no count, no filter choice for them.
    await openBoard(work)
    const ownerCards = (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.board?.card)
    await card(work, running).getByText('设置页', { exact: true }).waitFor()
    expect(await card(work, scheduled!.id).count()).toBe(0)
    const visible = ownerCards.filter(task => !task.agent)
    expect(await board(work).locator('.work-board-card').count()).toBe(visible.length)
    for (const group of GROUPS) {
      const count = visible.filter(task => task.board!.group === group).length
      expect(await column(work, group).locator('.work-board-column-head').textContent()).toMatch(
        new RegExp(`${LABELS[group]}${count}$`, 'u'),
      )
    }
    await board(work)
      .getByRole('button', { name: /^谁在做/u })
      .click()
    expect(await work.getByRole('checkbox', { name: '巡检' }).count()).toBe(0)
    await work.keyboard.press('Escape')
    // A failed run opened (and its unknown results checked) on another device leaves 等你处理 here; 失败 stays red on the card.
    const failedPlace = (await summaryOf(failed))!.board!
    expect(failedPlace.group).toBe('attention')
    await owner.json(`tasks/${failed}/attend`, { method: 'POST', body: { settle: failedPlace.settle, opened: true, checked: true } })
    await expect.poll(async () => (await summaryOf(failed))?.board?.group).not.toBe('attention')
    const settled = card(work, failed)
    await expect.poll(() => settled.evaluate(item => item.closest('section')?.getAttribute('data-group'))).not.toBe('attention')
    await settled
      .locator('.work-board-card-state[data-tone="failed"]')
      .getByText(/^失败/u)
      .waitFor()
    await workContext.close()

    // A run the Host says has gone quiet: no fixture Harness goes silent within a test, so the Host's snapshot is
    // answered once with that one fact changed, which is all the board reads.
    await page.route('**/link/api/snapshot', async route => {
      const response = await route.fetch()
      const body = (await response.json()) as AppSnapshot
      const quiet = new Date(Date.now() - 4 * 60_000).toISOString()
      for (const task of body.tasks)
        if (task.id === running && task.live) {
          task.live = { ...task.live, silent: true, lastEventAt: quiet }
          task.board = { ...task.board!, group: 'attention', reason: 'silent' }
        }
      await route.fulfill({ response, json: body })
    })
    await page.reload()
    await connected(page)
    await column(page, 'attention')
      .locator(`.work-board-card[data-work-session="${running}"]`)
      .getByText(/^没有动静/u)
      .waitFor()
    await shot(page, 'board-silent', 1440, 'light')
    await shot(page, 'board-silent', 1440, 'dark')
    await page.unroute('**/link/api/snapshot')

    // Phone: one list under a state filter, 等你处理 first.
    await openBoard(phone)
    const states = board(phone).getByRole('group', { name: '状态' })
    await expect.poll(async () => states.getByRole('button', { pressed: true }).textContent()).toMatch(/^等你处理/u)
    await board(phone).getByRole('list', { name: '等你处理' }).locator(`[data-work-session="${asking}"]`).waitFor()
    await shot(phone, 'phone', 390, 'light')
    await shot(phone, 'phone', 390, 'dark')
    await states.getByRole('button', { name: /^进行中/u }).click()
    await board(phone).getByRole('list', { name: '进行中' }).locator(`[data-work-session="${running}"]`).waitFor()
    await phoneContext.close()
  } finally {
    await browser?.close()
    await host.close()
  }
})
