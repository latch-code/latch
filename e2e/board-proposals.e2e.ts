import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { AppSnapshot, CustomAgent, TaskDetail, WorkItemAnswer, WorkProposalSummary } from '@latch/protocol'
import { latchEnv } from '@latch/host/env'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, settleShell } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'
import { switchView } from './helpers/workbench.ts'

const OUT = 'test-results/board-proposals'

const board = (page: Page) => page.locator('.work-board')
const column = (page: Page, name: string) => board(page).getByRole('region', { name, exact: true })
const proposalCard = (page: Page, id: string) => board(page).locator(`.work-board-card[data-work-proposal="${id}"]`)
const itemCard = (page: Page, id: string) => board(page).locator(`.work-board-card[data-work-item="${id}"]`)
const call = (tool: string, args: Record<string, unknown>, fetch = false) =>
  `board ${JSON.stringify({ tool, args, ...(fetch ? { fetch } : {}) })}`

async function shot(page: Page, name: string, width: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.evaluate(() => document.fonts.ready)
  await settleShell(page)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${OUT}/${name}--${theme}--${width}.png`, animations: 'disabled', caret: 'hide' })
}

async function settled(device: TestDevice, sessionId: string): Promise<TaskDetail> {
  let detail: TaskDetail | undefined
  await expect
    .poll(
      async () => {
        detail = await device.json<TaskDetail>(`tasks/${sessionId}`)
        return ['idle', 'completed', 'failed', 'cancelled'].includes(detail.summary.status)
      },
      { timeout: 20_000 },
    )
    .toBe(true)
  return detail!
}

/** A Code session on the fake agent whose one turn runs `prompt`; answers what it proposed once the Host has it. */
async function propose(owner: TestDevice, prompt: string, entries = 1): Promise<{ sessionId: string; proposal: WorkProposalSummary }> {
  const response = await owner.confirmed('tasks', {
    method: 'POST',
    body: { requestId: randomUUID(), prompt, harnessId: 'fake', mode: 'agent' },
  })
  const { sessionId } = (await response.json()) as { sessionId: string }
  await settled(owner, sessionId)
  let proposal: WorkProposalSummary | undefined
  await expect
    .poll(async () => {
      proposal = (await owner.json<AppSnapshot>('snapshot')).workProposals?.find(row => row.from.sessionId === sessionId)
      return proposal?.entries?.length ?? (proposal?.change ? 1 : 0)
    })
    .toBe(entries)
  return { sessionId, proposal: proposal! }
}

it('an agent proposes 待办: shown as proposed, edited and accepted, started at its revision; a group, a dismissal, outside content and privacy', async () => {
  const state = await mkdtemp(join(tmpdir(), 'latch-e2e-proposals-'))
  const host = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'), demo: true, hostName: '提议电脑' })
  let browser: Browser | undefined
  try {
    await mkdir(OUT, { recursive: true })
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      body: {
        id: 'fake',
        name: 'Fake',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(state, 'state.json') },
      },
    })

    browser = await chromium.launch(browserLaunchOptions())
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    await stillMotion(context)
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    await enrollBrowser(page, host, { name: '提议设备', scopes: ['admin'] })
    // The full data scope, which private proposals need.
    const pageDevice = host.host.security.devices.list().find(device => device.name === '提议设备')!.id
    expect((await owner.confirmed(`devices/${pageDevice}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.reload()
    await connected(page)
    const workContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    const work = await workContext.newPage()
    work.setDefaultTimeout(20_000)
    await enrollBrowser(work, host, { name: '工作设备', scopes: ['view', 'run'], dataScope: 'work' })

    // One proposal: a card in 未开始 that says 提议 and who proposed it; not a 待办.
    const single = await propose(
      owner,
      call('propose_todo', { title: '给 README 加安装一节', prompt: 'echo 在 README 末尾加安装一节', tags: ['文档'] }),
    )
    const group = await propose(
      owner,
      call('propose_todos', {
        goal: '拆开设置页重写',
        items: [
          { title: '拆出账号面板', prompt: 'echo 拆出账号面板' },
          { title: '拆出通知面板', prompt: 'echo 拆出通知面板' },
          { title: '删掉旧设置页', prompt: 'echo 删掉旧设置页' },
        ],
      }),
      3,
    )
    const outside = await propose(owner, call('propose_todo', { title: '照网页说的改配置', prompt: 'echo 照网页改配置' }, true))
    const change = await propose(owner, call('propose_card', { target: 'session', title: '整理首页文案', note: '等设计稿' }))
    expect(outside.proposal.external).toBe(true)
    await switchView(page, 'board')
    for (const row of [single, group, outside]) await column(page, '未开始').locator(`[data-work-proposal="${row.proposal.id}"]`).waitFor()
    await proposalCard(page, single.proposal.id).getByText('提议', { exact: true }).waitFor()
    await proposalCard(page, group.proposal.id).getByText('提议 3 条', { exact: true }).waitFor()
    await proposalCard(page, outside.proposal.id).getByText('来自外部内容').waitFor()
    // The suggestion waits on its session's card.
    const suggestion = board(page).locator(`.work-board-card[data-work-session="${change.sessionId}"] .work-board-suggestion`)
    await suggestion.getByText('整理首页文案', { exact: true }).waitFor()
    expect((await owner.json<AppSnapshot>('snapshot')).items ?? []).toEqual([])
    await shot(page, 'proposed', 1440, 'light')
    await shot(page, 'proposed', 1440, 'dark')
    await shot(page, 'proposed', 1100, 'light')
    await shot(page, 'proposed', 1100, 'dark')
    await page.setViewportSize({ width: 1440, height: 900 })

    // 审阅: the full 要求, edited, then accepted: an unstarted 待办 that says where it came from.
    await proposalCard(page, single.proposal.id).getByRole('button', { name: '审阅' }).click()
    const review = page.getByRole('dialog', { name: '审阅提议' })
    const prompt = review.getByRole('textbox', { name: '要求' })
    await expect.poll(() => prompt.inputValue()).toBe('echo 在 README 末尾加安装一节')
    await prompt.fill('echo 在 README 末尾加安装一节，写清 Node 版本')
    await shot(page, 'review', 1440, 'light')
    await page.setViewportSize({ width: 1440, height: 900 })
    await review.getByRole('button', { name: '接受', exact: true }).click()
    await review.waitFor({ state: 'hidden' })
    let accepted = (await owner.json<AppSnapshot>('snapshot')).items?.find(item => item.from?.proposalId === single.proposal.id)
    await expect
      .poll(async () => {
        accepted = (await owner.json<AppSnapshot>('snapshot')).items?.find(item => item.from?.proposalId === single.proposal.id)
        return accepted?.board.group
      })
      .toBe('todo')
    await itemCard(page, accepted!.id).waitFor()
    await proposalCard(page, single.proposal.id).waitFor({ state: 'hidden' })

    // The group: two of three accepted, the third dismissed from its card.
    await proposalCard(page, group.proposal.id).getByRole('button', { name: '审阅' }).click()
    const groupReview = page.getByRole('dialog', { name: '审阅提议' })
    await groupReview.getByRole('checkbox', { name: '收下第 3 条' }).click()
    await groupReview.getByRole('button', { name: '接受 2 条' }).click()
    await groupReview.waitFor({ state: 'hidden' })
    await proposalCard(page, group.proposal.id).getByText('提议 1 条', { exact: true }).waitFor()
    await proposalCard(page, group.proposal.id).getByRole('button', { name: '不要', exact: true }).click()
    await proposalCard(page, group.proposal.id).waitFor({ state: 'hidden' })
    const titles = ((await owner.json<AppSnapshot>('snapshot')).items ?? []).map(item => item.title).toSorted()
    expect(titles).toEqual(['拆出账号面板', '拆出通知面板', '给 README 加安装一节'])

    // The suggestion: accepted, the session's card has its title and note.
    await suggestion.getByRole('button', { name: '接受', exact: true }).click()
    await board(page).locator(`.work-board-card[data-work-session="${change.sessionId}"]`).getByText('等设计稿').waitFor()

    // Outside content: its mark goes with the accepted 待办 and into 开始.
    await proposalCard(page, outside.proposal.id).getByRole('button', { name: '审阅' }).click()
    const outsideReview = page.getByRole('dialog', { name: '审阅提议' })
    await outsideReview.getByText('来自外部内容').waitFor()
    await outsideReview.getByRole('button', { name: '接受', exact: true }).click()
    await outsideReview.waitFor({ state: 'hidden' })
    let external = (await owner.json<AppSnapshot>('snapshot')).items?.find(item => item.from?.proposalId === outside.proposal.id)
    await expect
      .poll(async () => {
        external = (await owner.json<AppSnapshot>('snapshot')).items?.find(item => item.from?.proposalId === outside.proposal.id)
        return external?.from?.external
      })
      .toBe(true)
    await itemCard(page, external!.id).getByText('来自外部内容').waitFor()
    await shot(page, 'accepted', 1440, 'light')
    await shot(page, 'accepted', 820, 'dark')
    await page.setViewportSize({ width: 1440, height: 900 })
    await itemCard(page, external!.id).getByRole('button', { name: '开始', exact: true }).click()
    const startExternal = page.getByRole('dialog', { name: '开始' })
    await startExternal.getByText('来自外部内容').waitFor()
    await expect.poll(() => startExternal.locator('textarea').inputValue()).toBe('echo 照网页改配置')
    await shot(page, 'start-external', 1440, 'light')
    await page.setViewportSize({ width: 1440, height: 900 })
    await startExternal.getByRole('button', { name: '发送', exact: true }).click()
    await startExternal.waitFor({ state: 'hidden' })
    await expect
      .poll(async () => (await owner.json<WorkItemAnswer>(`work/items/${external!.id}`)).item.sessionIds.length, { timeout: 30_000 })
      .toBe(1)
    const { item: startedExternal } = await owner.json<WorkItemAnswer>(`work/items/${external!.id}`)
    expect(startedExternal.from).toMatchObject({ external: true })

    // 开始 the edited one: the input holds the 要求 at the revision the person accepted; that is what the session gets.
    await itemCard(page, accepted!.id).getByRole('button', { name: '开始', exact: true }).click()
    const start = page.getByRole('dialog', { name: '开始' })
    await expect.poll(() => start.locator('textarea').inputValue()).toBe('echo 在 README 末尾加安装一节，写清 Node 版本')
    await start.getByRole('button', { name: '发送', exact: true }).click()
    await start.waitFor({ state: 'hidden' })
    await expect
      .poll(async () => (await owner.json<WorkItemAnswer>(`work/items/${accepted!.id}`)).item.sessionIds.length, { timeout: 30_000 })
      .toBe(1)
    const { item: startedItem } = await owner.json<WorkItemAnswer>(`work/items/${accepted!.id}`)
    expect((await settled(owner, startedItem.sessionIds[0]!)).messages[0]?.text).toBe('echo 在 README 末尾加安装一节，写清 Node 版本')

    // A dismissed proposal leaves nothing.
    const dropped = await propose(owner, call('propose_todo', { title: '没必要的事', prompt: 'echo 没必要' }))
    await proposalCard(page, dropped.proposal.id).getByRole('button', { name: '不要', exact: true }).click()
    await proposalCard(page, dropped.proposal.id).waitFor({ state: 'hidden' })
    expect(((await owner.json<AppSnapshot>('snapshot')).items ?? []).some(item => item.title === '没必要的事')).toBe(false)

    // A private chat's proposal: on the full-scope board, never on a work-scope device's.
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: { requestId: randomUUID(), name: '助理', harnessId: 'fake' },
    })
    const { sessionId: chat } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        customAgentId: agent.id,
        prompt: call('propose_todo', { title: '私下记的事', prompt: 'echo 私下' }),
      },
    })
    await settled(owner, chat)
    let privateRow: WorkProposalSummary | undefined
    await expect
      .poll(async () => {
        privateRow = (await owner.json<AppSnapshot>('snapshot')).workProposals?.find(row => row.from.sessionId === chat)
        return privateRow?.private
      })
      .toBe(true)
    await proposalCard(page, privateRow!.id).getByText('助理').waitFor()
    await switchView(work, 'board')
    await column(work, '未开始').waitFor()
    await work.reload()
    await switchView(work, 'board')
    // It sees the 待办 that are not private, and nothing of the private proposal.
    await column(work, '未开始').getByText('拆出账号面板', { exact: true }).waitFor()
    expect(await board(work).locator(`[data-work-proposal="${privateRow!.id}"]`).count()).toBe(0)
    const narrow = await host.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope: 'work' })
    expect((await narrow.request(`work/proposals/${privateRow!.id}`)).status).toBe(404)

    // Who proposed it opens the proposing session, where the proposal follows the turn that made it.
    await proposalCard(page, privateRow!.id).getByRole('button', { name: '提议自 助理' }).click()
    await page.locator('.work-board-session-proposal').getByText('私下记的事').waitFor()
    await shot(page, 'session', 1440, 'light')
    await shot(page, 'session', 1440, 'dark')
    await page.setViewportSize({ width: 1440, height: 900 })
    await switchView(page, 'board')

    // The list and the phone.
    await board(page).getByRole('radio', { name: '表', exact: true }).click()
    await board(page).locator(`.work-board-row[data-work-proposal="${privateRow!.id}"]`).waitFor()
    await shot(page, 'list', 1440, 'light')
    await shot(page, 'list', 1440, 'dark')
    await page.setViewportSize({ width: 390, height: 844 })
    await board(page).locator('.work-board-phone').waitFor()
    await board(page)
      .getByRole('group', { name: '状态' })
      .getByRole('button', { name: /^未开始/u })
      .click()
    await board(page).getByRole('list', { name: '未开始' }).locator(`[data-work-proposal="${privateRow!.id}"]`).waitFor()
    await shot(page, 'phone', 390, 'light')
    await shot(page, 'phone', 390, 'dark')
    await workContext.close()
  } finally {
    await browser?.close()
    await host.close()
    await rm(state, { recursive: true, force: true })
  }
})
