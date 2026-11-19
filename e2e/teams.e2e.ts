import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail, TeamAnswer, TeamSummary, WorkProposalSummary } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, settleShell } from './helpers/layout.ts'

const OUTPUT = 'test-results/teams'
const VIEWS = [
  [1440, 900, 'light'],
  [1440, 900, 'dark'],
  [820, 1100, 'light'],
  [390, 844, 'dark'],
] as const

/**
 * A team in the page (docs/TEAMS.md): the list a person writes and starts, the team in its session's conversation
 * while members work, wait and end, the results the Host hands back, stopping, a proposal started as a team, the line
 * over a member's conversation and the members under their session in the list.
 */
describe('a team of sessions, in the page', () => {
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let page: Page
  let state = ''

  /** The page follows the Host: what it shows is read until it says so. */
  const poll = <T>(read: () => T) => expect.poll(read, { timeout: 15_000 })
  const detail = (id: string) => owner.json<TaskDetail>(`tasks/${id}`)
  const snapshot = () => owner.json<AppSnapshot>('snapshot')
  const teamOf = async (id: string) => (await owner.json<TeamAnswer>(`teams/${id}`)).team
  const settled = async (id: string) => {
    await expect
      .poll(async () => ['idle', 'failed', 'cancelled'].includes((await detail(id)).summary.status), { timeout: 20_000 })
      .toBe(true)
  }
  const teamIn = async (id: string, wanted: TeamSummary['state']) => {
    await expect.poll(async () => (await teamOf(id)).state, { timeout: 20_000 }).toBe(wanted)
    return teamOf(id)
  }
  const membersIn = (id: string, states: string[]) =>
    expect.poll(async () => (await teamOf(id)).members.map(member => member.state), { timeout: 20_000 }).toEqual(states)

  /** A Code session on Alpha with a settled first turn, named so the page can find it. */
  async function lead(title: string, prompt = 'echo 先看一下登录为什么会超时'): Promise<string> {
    const response = await owner.confirmed('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt, harnessId: 'alpha', mode: 'agent' },
    })
    expect(response.status).toBe(201)
    const { sessionId } = (await response.json()) as { sessionId: string }
    await settled(sessionId)
    await owner.json(`tasks/${sessionId}`, { method: 'PATCH', body: { title } })
    return sessionId
  }
  const startTeam = async (leadId: string, body: Record<string, unknown>) =>
    (await owner.json<TeamAnswer>(`tasks/${leadId}/team`, { method: 'POST', body: { requestId: randomUUID(), ...body } })).team

  async function open(title: string): Promise<void> {
    await page.keyboard.press('Meta+k')
    const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
    await palette.getByRole('searchbox').fill(title)
    await palette.getByRole('option', { name: title, exact: true }).first().click()
    await page.locator('.transcript .turn').first().waitFor()
  }

  /** The same state at every width and theme, without horizontal overflow; `ready` waits for what the shot is of. */
  async function shots(name: string, title: string, ready: (view: Page) => Promise<void>): Promise<void> {
    for (const [width, height, theme] of VIEWS) {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme })
      await settleShell(page)
      // The page lays itself out for the new width as it stands; the session stays the one in view.
      if (!(await page.locator('.transcript .turn').first().isVisible())) await open(title)
      await ready(page)
      // Nothing hovered in the shot.
      await page.mouse.move(width - 2, Math.floor(height / 2))
      await page.evaluate(() => document.fonts.ready)
      await settleShell(page)
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${OUTPUT}/${name}--${width}--${theme}.png`, animations: 'disabled', caret: 'hide' })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light' })
  }

  const card = (teamId: string) => page.locator(`.team-card[data-team="${teamId}"]`)

  beforeAll(async () => {
    await mkdir(OUTPUT, { recursive: true })
    state = await mkdtemp(join(tmpdir(), 'latch-e2e-teams-'))
    host = await startTestHost({ demo: false })
    owner = await host.enroll({ listener: 'unix' })
    for (const [id, name] of [
      ['alpha', 'Alpha'],
      ['beta', 'Beta'],
    ])
      await owner.confirmedJson('agents', {
        method: 'POST',
        body: {
          id,
          name,
          command: process.execPath,
          args: [FAKE_ACP_AGENT],
          env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(state, `${id}.json`), FAKE_ACP_CAPS: 'load,resume' },
        },
      })
    browser = await chromium.launch(browserLaunchOptions())
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    page.setDefaultTimeout(20_000)
    page.on('pageerror', error => console.error('pageerror', error.stack ?? error.message))
    await enrollBrowser(page, host)
    await connected(page)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await host?.close()
    if (state) await rm(state, { recursive: true, force: true })
  })

  it('writes a list of two tasks on two Harnesses and starts them; the list survives closing the panel', async () => {
    const id = await lead('排查登录超时')
    await open('排查登录超时')
    const entry = page.getByRole('button', { name: '用团队分工', exact: true }).filter({ visible: true })
    await entry.click()
    const panel = page.getByRole('dialog', { name: '团队分工', exact: true })
    const first = panel.getByRole('textbox', { name: '第 1 项', exact: true })
    const second = panel.getByRole('textbox', { name: '第 2 项', exact: true })
    await first.waitFor()
    // The first row starts on this session's Harness, the second on another that is ready.
    const pickers = panel.locator('.team-harness')
    expect(await pickers.nth(0).innerText()).toContain('Alpha')
    expect(await pickers.nth(1).innerText()).not.toContain('Alpha')
    await pickers.nth(1).getByRole('button').first().click()
    await page.getByRole('menuitemradio', { name: 'Beta', exact: true }).click()
    expect(await pickers.nth(1).innerText()).toContain('Beta')
    // Nothing written: nothing to start.
    expect(await panel.getByRole('button', { name: '开始', exact: true }).isDisabled()).toBe(true)
    // 让 Agent 来分: the request goes into the input and is not sent; the panel closes.
    await panel.getByRole('button', { name: '让 Agent 来分', exact: true }).click()
    await panel.waitFor({ state: 'hidden' })
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    expect(await input.inputValue()).toContain('propose_todos')
    expect((await detail(id)).messages.filter(message => message.role === 'user')).toHaveLength(1)
    await input.fill('')
    await entry.click()
    await first.waitFor()
    await first.fill('endturn 查前端：登录表单在超时后做了什么')
    await second.fill('endturn 查后端：会话续期的接口\n看 token 的有效期和续期的条件。')
    // A third row, then removed again; the list is kept while the panel is closed.
    await panel.getByRole('button', { name: '添加一项', exact: true }).click()
    await panel.getByRole('textbox', { name: '第 3 项', exact: true }).waitFor()
    await panel.getByRole('button', { name: '移除第 3 项', exact: true }).click()
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'hidden' })
    await entry.click()
    expect(await first.inputValue()).toBe('endturn 查前端：登录表单在超时后做了什么')
    expect(await panel.getByRole('textbox').count()).toBe(2)
    // The second row can be moved to the other Harness and back.
    await pickers.nth(1).getByRole('button').first().click()
    await page.getByRole('menuitemradio', { name: 'Alpha', exact: true }).click()
    expect(await pickers.nth(1).innerText()).toContain('Alpha')
    await pickers.nth(1).getByRole('button').first().click()
    await page.getByRole('menuitemradio', { name: 'Beta', exact: true }).click()
    for (const [width, height, theme] of VIEWS) {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme })
      if (!(await first.isVisible())) await entry.click()
      await first.waitFor()
      await settleShell(page)
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${OUTPUT}/panel--${width}--${theme}.png`, animations: 'disabled', caret: 'hide' })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light' })
    // The phone's sheet gives way as the width changes; once it has, the entry opens the popover with the same list.
    await page.waitForTimeout(600)
    for (let tries = 0; tries < 3 && !(await first.isVisible()); tries++) {
      await entry.click()
      await page.waitForTimeout(400)
    }
    expect(await second.inputValue()).toContain('会话续期的接口')
    // ⌘Enter starts.
    await first.focus()
    await page.keyboard.press('Meta+Enter')
    await panel.waitFor({ state: 'hidden' })
    const team = (await snapshot()).teams!.find(row => row.leadSessionId === id)!
    expect(team.members.map(member => [member.title, member.harnessId])).toEqual([
      ['endturn 查前端：登录表单在超时后做了什么', 'alpha'],
      ['endturn 查后端：会话续期的接口', 'beta'],
    ])
    // The team is in the conversation, and the session offers no second one while this is open.
    await card(team.id).waitFor()
    await poll(() => entry.count()).toBe(0)
    await membersIn(team.id, ['running', 'running'])
    const rows = card(team.id).locator('.team-member')
    await poll(() => rows.nth(0).innerText()).toMatch(/查前端[\s\S]*运行中/u)
    // Stop: the members are cancelled, the results stay here and are not sent.
    await card(team.id).getByRole('button', { name: '停止', exact: true }).click()
    await teamIn(team.id, 'kept')
    await poll(() => card(team.id).locator('.team-end').innerText()).toContain('留在这里')
    expect(await card(team.id).getByRole('button', { name: '停止', exact: true }).count()).toBe(0)
    await poll(() => rows.nth(0).innerText()).toContain('已停止')
    // The pointer was on 停止, which is gone: it comes back to the end from elsewhere.
    await page.mouse.move(4, 4)
    await card(team.id).locator('.team-end-kept').hover()
    await page.getByRole('tooltip').filter({ hasText: '已停止' }).waitFor()
    await shots('kept', '排查登录超时', async view => {
      await view.locator(`.team-card[data-team="${team.id}"] .team-end[data-end="kept"]`).waitFor()
    })
    // With that team ended the entry is back.
    await poll(() => entry.count()).toBe(1)
    // On a phone the panel is a sheet, and a row's Harness is chosen from a sheet over it; the panel stays.
    await page.setViewportSize({ width: 390, height: 844 })
    await open('排查登录超时')
    await entry.click()
    await first.waitFor()
    await pickers.nth(0).getByRole('button').first().click()
    await page.getByRole('radio', { name: 'Beta', exact: true }).click()
    await poll(() => pickers.nth(0).innerText()).toContain('Beta')
    expect(await first.isVisible()).toBe(true)
    await noHorizontalOverflow(page)
    await page.setViewportSize({ width: 1440, height: 900 })
  }, 180_000)

  it('shows members at work, one waiting for the person in amber, and the results handed back before the reply', async () => {
    const id = await lead('核对支付回调')
    const team = await startTeam(id, {
      goal: '两头一起核对支付回调',
      tasks: [
        { title: '查回调的签名校验', prompt: 'permission', harnessId: 'alpha' },
        { title: '查重复通知的幂等', prompt: 'endturn', harnessId: 'beta' },
        { title: '读对账脚本', prompt: 'echo 对账脚本每天 02:00 跑一次，按订单号去重。', harnessId: 'beta' },
      ],
    })
    await membersIn(team.id, ['waiting', 'running', 'done'])
    await open('核对支付回调')
    await card(team.id).waitFor()
    // Top to bottom: this session, the members off its spine, where the results are.
    const [top, middle, bottom] = await Promise.all([
      card(team.id).locator('.team-lead').boundingBox(),
      card(team.id).locator('.team-members').boundingBox(),
      card(team.id).locator('.team-end').boundingBox(),
    ])
    expect(top!.y + top!.height).toBeLessThanOrEqual(middle!.y + 1)
    expect(middle!.y + middle!.height).toBeLessThanOrEqual(bottom!.y + 1)
    // How many have ended, beside where the results will be.
    expect(await card(team.id).locator('.team-end-count').innerText()).toBe('1/3')
    expect(await card(team.id).locator('.team-lead').innerText()).toContain('Alpha')
    // A member waits for the person: the end says so, in the waiting tone.
    const end = card(team.id).locator('.team-end')
    expect(await end.innerText()).toContain('等你处理')
    expect(await end.locator('.ui-status-word').getAttribute('data-tone')).toBe('waiting')
    const rows = card(team.id).locator('.team-member')
    expect(await rows.nth(0).innerText()).toMatch(/查回调的签名校验[\s\S]*等你处理/u)
    expect(await rows.nth(1).innerText()).toMatch(/查重复通知的幂等[\s\S]*运行中/u)
    expect(await rows.nth(2).innerText()).toMatch(/读对账脚本[\s\S]*对账脚本每天[\s\S]*已完成/u)
    await shots('waiting', '核对支付回调', async view => {
      await view.locator(`.team-card[data-team="${team.id}"] .team-end[data-end="you"]`).waitFor()
    })

    // Allowed: only the long one is left, and the end waits for members.
    const approval = (await snapshot()).approvals.find(row => row.sessionId === team.members[0]!.sessionId)!
    await owner.confirmed(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
    await membersIn(team.id, ['done', 'running', 'done'])
    await poll(() => end.innerText()).toContain('等成员')
    // Decided elsewhere: the toast that pointed at it leaves at once, whichever session is open.
    await poll(() => page.getByText('另一个会话等你处理', { exact: true }).count()).toBe(0)
    // With motion allowed, a bead of work runs only round the elbow of the member at work.
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const moving = (selector: string) =>
      card(team.id)
        .locator(selector)
        .evaluateAll(
          nodes => nodes.flatMap(node => node.getAnimations({ subtree: true })).filter(item => item.playState === 'running').length,
        )
    await poll(() => moving('.team-member[data-state="running"]')).toBeGreaterThan(0)
    expect(await moving('.team-member[data-state="done"]')).toBe(0)
    expect(await moving('.team-end .team-elbow')).toBe(0)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await moving('.team-card')).toBe(0)
    await shots('running', '核对支付回调', async view => {
      await view.locator(`.team-card[data-team="${team.id}"] .team-end[data-end="members"]`).waitFor()
    })

    // A member row opens that member's session, which says whose team it is in and leads back.
    await rows.nth(1).getByRole('button').click()
    const line = page.locator('.team-member-line')
    await line.waitFor()
    expect(await line.innerText()).toMatch(/核对支付回调[\s\S]*团队分工 · 2\/3/u)
    await page.screenshot({ path: `${OUTPUT}/member--1440--light.png`, animations: 'disabled', caret: 'hide' })
    // A member starts no team of its own.
    expect(await page.getByRole('button', { name: '用团队分工', exact: true }).filter({ visible: true }).count()).toBe(0)
    // In the list the members stand under their session, in the team's order.
    const listed = await page
      .locator('.sidebar [data-task-id]')
      .filter({ visible: true })
      .evaluateAll(rows => rows.map(row => [row.getAttribute('data-task-id'), row.closest('[data-team-member]') !== null] as const))
    const at = listed.findIndex(([task]) => task === id)
    expect(listed.slice(at, at + 4)).toEqual([[id, false], ...team.members.map(member => [member.sessionId, true])])
    // Its row says how many members it has and folds them away and back, remembered on this device.
    const visibleIds = () =>
      page
        .locator('.sidebar [data-task-id]')
        .filter({ visible: true })
        .evaluateAll(rows => rows.map(row => row.getAttribute('data-task-id')))
    const fold = page.locator(`.sidebar .session-entry:has([data-task-id="${id}"]) .team-fold`).filter({ visible: true })
    expect(await fold.count()).toBe(1)
    expect(await fold.innerText()).toContain('3')
    await fold.click()
    await poll(async () => (await visibleIds()).filter(task => team.members.some(member => member.sessionId === task))).toEqual([])
    expect(await fold.getAttribute('aria-expanded')).toBe('false')
    await page.screenshot({ path: `${OUTPUT}/list-folded--1440--light.png`, animations: 'disabled', caret: 'hide' })
    await fold.click()
    await poll(async () => (await visibleIds()).filter(task => team.members.some(member => member.sessionId === task)).length).toBe(3)
    await line.getByRole('button').click()
    await card(team.id).waitFor()
    // The phone's list nests them the same way.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page
      .getByRole('button', { name: /^返回/u })
      .filter({ visible: true })
      .first()
      .click()
    const phoneRows = page.locator('.phone-entry').filter({ visible: true })
    await phoneRows.first().waitFor()
    await settleShell(page)
    const phoneListed = await phoneRows.evaluateAll(rows =>
      rows.map(row => [row.querySelector('[data-task-id]')?.getAttribute('data-task-id'), row.hasAttribute('data-team-member')] as const),
    )
    const phoneAt = phoneListed.findIndex(([task]) => task === id)
    expect(phoneListed.slice(phoneAt, phoneAt + 4)).toEqual([[id, false], ...team.members.map(member => [member.sessionId, true])])
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUTPUT}/list--390--dark.png`, animations: 'disabled', caret: 'hide' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light' })
    await open('核对支付回调')
    await card(team.id).waitFor()

    // The last member ends: the results go to this session as one message, shown as the members' results, and the
    // session's agent answers after it.
    await owner.json(`tasks/${team.members[1]!.sessionId}/cancel`, { method: 'POST', body: {} })
    const done = await teamIn(team.id, 'returned')
    await settled(id)
    const results = page.locator(`.team-results[data-team-return="${team.id}"]`)
    await results.waitFor()
    expect(await results.getAttribute('data-message-id')).toBe(done.returnedMessageId)
    expect(await results.innerText()).toMatch(
      /成员的结果[\s\S]*查回调的签名校验[\s\S]*查重复通知的幂等[\s\S]*读对账脚本[\s\S]*发给 Agent 的原文/u,
    )
    // Not a bubble of the person's, and the words sent stay folded until asked for.
    expect(await page.locator(`.message-row[data-message-id="${done.returnedMessageId}"]`).count()).toBe(0)
    expect(await results.getByText('团队成员都结束了', { exact: false }).isVisible()).toBe(false)
    await results.getByRole('button', { name: '发给 Agent 的原文', exact: true }).click()
    await results.getByText('团队成员都结束了', { exact: false }).waitFor()
    await results.getByRole('button', { name: '发给 Agent 的原文', exact: true }).click()
    // A member's row opens to its whole reply, read from its own session.
    await results.getByRole('button', { name: /读对账脚本/u }).click()
    await results.locator('.team-result-body').getByText('按订单号去重', { exact: false }).waitFor()
    // The reply follows the results.
    const reply = page.locator('.turn').last().locator('.turn-reply')
    await reply.waitFor()
    const [above, below] = await Promise.all([results.boundingBox(), reply.boundingBox()])
    expect(above!.y).toBeLessThan(below!.y)
    // The card's end says the results were handed back, and leads to them.
    await poll(() => end.innerText()).toContain('已交回')
    await end.getByRole('button').click()
    await shots('returned', '核对支付回调', async view => {
      await view.locator(`.team-results[data-team-return="${team.id}"]`).waitFor()
      const graph = view.locator(`.team-card[data-team="${team.id}"]`)
      await graph.locator('.team-end[data-end="returned"]').waitFor()
      await graph.evaluate(node => node.scrollIntoView({ block: 'start' }))
    })
  }, 240_000)

  it('starts what this session’s agent proposed as a team, each entry on the Harness chosen for it', async () => {
    const items = [
      { title: '读网关日志', prompt: 'echo 网关日志里 14:02 起有一批 504。', harness: 'beta' },
      { title: '读服务配置', prompt: 'echo 上游超时配的是 3 秒。' },
      { title: '以后再说', prompt: 'echo later' },
      { title: '不用了', prompt: 'echo no' },
    ]
    const id = await lead('排查网关超时', `board ${JSON.stringify({ tool: 'propose_todos', args: { goal: '排查网关超时', items } })}`)
    let proposal: WorkProposalSummary | undefined
    await expect
      .poll(async () => {
        proposal = (await snapshot()).workProposals?.find(row => row.from.sessionId === id)
        return proposal?.entries?.length
      })
      .toBe(4)
    const review = page.getByRole('dialog', { name: '审阅提议', exact: true })
    const entries = review.locator('.work-board-proposal-entry')
    const reviewIt = async () => {
      await page.locator(`[data-work-proposal="${proposal!.id}"]`).getByRole('button', { name: '审阅', exact: true }).click()
      await poll(() => entries.count()).toBe(4)
    }
    // On a phone the review is a sheet; its three buttons fit.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await open('排查网关超时')
    await reviewIt()
    await review.getByRole('button', { name: '一起开始', exact: true }).waitFor()
    await settleShell(page)
    await noHorizontalOverflow(page)
    // The sheet scrolls as a whole; its buttons are at the end.
    await review.locator('.ui-modal-footer').scrollIntoViewIfNeeded()
    const foot = await review.locator('.ui-modal-footer').boundingBox()
    expect(foot!.y + foot!.height).toBeLessThanOrEqual(844)
    expect(foot!.x).toBeGreaterThanOrEqual(0)
    await page.screenshot({ path: `${OUTPUT}/proposal--390--dark.png`, animations: 'disabled', caret: 'hide' })
    await page.keyboard.press('Escape')
    await review.waitFor({ state: 'hidden' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light' })
    await open('排查网关超时')
    await reviewIt()
    // Each entry shows the Harness it would run on: the one the agent named, else this session's.
    expect(await entries.nth(0).locator('.team-harness').innerText()).toContain('Beta')
    expect(await entries.nth(1).locator('.team-harness').innerText()).toContain('Alpha')
    // The last one is left out; the second moves to Beta.
    await review.getByRole('checkbox', { name: '收下第 3 条', exact: true }).uncheck()
    await entries.nth(1).locator('.team-harness').getByRole('button').first().click()
    await page.getByRole('menuitemradio', { name: 'Beta', exact: true }).click()
    await page.setViewportSize({ width: 1440, height: 1200 })
    await page.screenshot({ path: `${OUTPUT}/proposal--1440--light.png`, animations: 'disabled', caret: 'hide' })
    await page.setViewportSize({ width: 1440, height: 900 })
    // 接受 and 不要 are still there, beside the primary one.
    await review.getByRole('button', { name: '接受 3 条', exact: true }).waitFor()
    await review.getByRole('button', { name: '全部不要', exact: true }).waitFor()
    // The proposal changes while the review is open: the start is refused in place and the review reads it again.
    const read = await owner.json<{ proposal: { revision: number } }>(`work/proposals/${proposal!.id}`)
    await owner.json(`work/proposals/${proposal!.id}/dismiss`, {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: read.proposal.revision, entries: [3] },
    })
    await review.getByRole('button', { name: '一起开始', exact: true }).click()
    await review.getByText('提议已有变化', { exact: false }).waitFor()
    await poll(() => entries.count()).toBe(3)
    await review.getByRole('checkbox', { name: '收下第 3 条', exact: true }).uncheck()
    await entries.nth(1).locator('.team-harness').getByRole('button').first().click()
    await page.getByRole('menuitemradio', { name: 'Beta', exact: true }).click()
    await review.getByRole('button', { name: '接受 2 条', exact: true }).waitFor()
    await review.getByRole('button', { name: '一起开始', exact: true }).click()
    await review.waitFor({ state: 'hidden' })
    const team = (await snapshot()).teams!.find(row => row.leadSessionId === id)!
    expect(team).toMatchObject({ proposalId: proposal!.id, goal: '排查网关超时' })
    expect(team.members.map(member => [member.title, member.harnessId])).toEqual([
      ['读网关日志', 'beta'],
      ['读服务配置', 'beta'],
    ])
    await card(team.id).waitFor()
    await teamIn(team.id, 'returned')
    await page.locator(`.team-results[data-team-return="${team.id}"]`).waitFor()
    // The entry left out still waits for the person, as a proposal.
    expect((await snapshot()).workProposals?.find(row => row.id === proposal!.id)?.entries?.map(entry => entry.state)).toEqual([
      'accepted',
      'accepted',
      'pending',
      'dismissed',
    ])
  }, 120_000)

  it('says in a member’s row why it did not start, and that row opens nothing', async () => {
    const id = await lead('整理发布说明')
    const team = await startTeam(id, {
      tasks: [
        { title: '列出这一版的改动', prompt: 'echo 这一版有 12 处改动。', harnessId: 'beta' },
        { title: '翻译成英文', prompt: 'echo x', harnessId: 'nope' },
      ],
    })
    await teamIn(team.id, 'returned')
    await open('整理发布说明')
    const row = card(team.id).locator('.team-member').nth(1)
    await row.waitFor()
    expect(await row.innerText()).toMatch(/翻译成英文[\s\S]*nope[\s\S]*没有开始/u)
    expect(await row.getAttribute('data-state')).toBe('unstarted')
    expect(await row.getByRole('button').count()).toBe(0)
    expect(await row.locator('.team-member-said').getAttribute('data-refusal')).toBe('')
    // The same in the results the Host handed back.
    const results = page.locator(`.team-results[data-team-return="${team.id}"]`)
    expect(await results.locator('.team-result').nth(1).innerText()).toMatch(/翻译成英文[\s\S]*没有开始/u)
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUTPUT}/unstarted--1440--light.png`, animations: 'disabled', caret: 'hide' })
  }, 120_000)
})
