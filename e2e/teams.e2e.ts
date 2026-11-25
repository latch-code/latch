import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, TaskDetail, TeamAnswer, TeamSummary, WorkProposalSummary } from '@latch/protocol'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, reachable, settleShell } from './helpers/layout.ts'
import { promptValue } from './helpers/prompt.ts'

const OUTPUT = 'test-results/teams'
const VIEWS = [
  [1440, 900, 'light'],
  [1440, 900, 'dark'],
  [820, 1100, 'light'],
  [390, 844, 'dark'],
] as const

/**
 * A team in the page: the list a person writes and starts, the team in its session's conversation
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
    await vi.waitFor(async () => expect(['idle', 'failed', 'cancelled']).toContain((await detail(id)).summary.status), { timeout: 20_000 })
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
    // Gamma reports its own models and levels; a first session of it tells Latch what they are.
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: {
        id: 'gamma',
        name: 'Gamma',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_CONFIG: 'options', FAKE_ACP_EFFORT_BY_MODEL: '1', FAKE_ACP_STATE: join(state, 'gamma.json') },
      },
    })
    const gamma = await owner.confirmedJson<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: 'echo gamma', harnessId: 'gamma', mode: 'agent' },
    })
    await settled(gamma.sessionId)
    for (let tries = 0; tries < 200; tries++) {
      if ((await snapshot()).catalog?.harnesses.find(harness => harness.id === 'gamma')?.catalogue?.options.length) break
      await new Promise(done => setTimeout(done, 100))
    }
    // Codex as its fake app-server, whose sessions offer its own subagents.
    const bin = join(state, 'bin')
    await mkdir(bin)
    const codex = join(bin, 'codex')
    await writeFile(codex, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
    await chmod(codex, 0o755)
    await owner.confirmedJson('agents', {
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: codex, args: [], env: { FAKE_ACP_STATE: join(state, 'codex.json') } },
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
    expect(await promptValue(input)).toContain('propose_todos')
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
      await page.mouse.move(width - 2, 2)
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
    // Left to right on a wide card: this session, the members, where the results are.
    const [left, middle, right] = await Promise.all([
      card(team.id).locator('.team-lead').boundingBox(),
      card(team.id).locator('.team-members').boundingBox(),
      card(team.id).locator('.team-end').boundingBox(),
    ])
    expect(left!.x + left!.width).toBeLessThanOrEqual(middle!.x + 1)
    expect(middle!.x + middle!.width).toBeLessThanOrEqual(right!.x + 1)
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
    // With motion allowed, light runs only along the wire and across the pill of the member at work.
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const moving = (selector: string) =>
      card(team.id)
        .locator(selector)
        .evaluateAll(
          // Animations that run on, not light that runs once or a colour easing from one state to the next.
          nodes =>
            nodes
              .flatMap(node => node.getAnimations({ subtree: true }))
              .filter(item => item.playState === 'running' && item.effect?.getTiming().iterations === Infinity).length,
        )
    await poll(() => moving('.team-member[data-state="running"]')).toBeGreaterThan(0)
    expect(await moving('.team-member[data-state="done"]')).toBe(0)
    expect(await moving('.team-fan.is-in')).toBe(0)
    // Two runs of light apart on the wire to the member at work, and none on the others.
    await poll(() => moving('.team-fan.is-out')).toBe(2)
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
    const memberResult = results.getByRole('listitem').filter({ has: page.getByRole('button', { name: /读对账脚本/u }) })
    await memberResult.getByRole('button', { name: /读对账脚本/u }).click()
    await memberResult.locator('.team-result-body').getByText('按订单号去重', { exact: false }).waitFor()
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

  it('keeps team sessions and the lead’s own subagents in separate sections of the overview', async () => {
    const title = '核对移动端布局'
    const id = await lead(title, 'delegate nest')
    const team = await startTeam(id, {
      goal: title,
      tasks: [
        { title: '检查窄屏布局', prompt: 'permission', harnessId: 'alpha' },
        { title: '核对交互状态', prompt: 'endturn', harnessId: 'beta' },
      ],
    })
    await membersIn(team.id, ['waiting', 'running'])
    await open(title)
    const overview = page.getByRole('tabpanel', { name: '会话概要', exact: true })
    const members = overview.getByRole('region', { name: '团队成员', exact: true })
    const agents = overview.getByRole('region', { name: '子 Agent', exact: true })
    for (const [width, height] of [
      [1440, 900],
      [768, 1024],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height })
      await settleShell(page)
      if (!(await overview.isVisible())) await page.getByRole('button', { name: '侧边面板', exact: true }).filter({ visible: true }).click()
      const waiting = members.getByRole('listitem').filter({ hasText: '检查窄屏布局' })
      await waiting.getByText('等你处理', { exact: true }).waitFor()
      await members.getByRole('listitem').filter({ hasText: '核对交互状态' }).getByText('运行中', { exact: true }).waitFor()
      await agents.getByText('Test runner', { exact: true }).waitFor()
      await agents.getByText('Linter', { exact: true }).waitFor()
      expect(await members.getByRole('listitem').count()).toBe(2)
      expect(await agents.getByRole('listitem').count()).toBe(2)
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await settleShell(page)
        await noHorizontalOverflow(page, overview)
        await page.screenshot({ path: `${OUTPUT}/overview--${width}--${theme}.png`, animations: 'disabled', caret: 'hide' })
        if (width === 1440) {
          const [panel, bottom] = await Promise.all([overview.boundingBox(), agents.boundingBox()])
          expect(panel).toBeTruthy()
          expect(bottom).toBeTruthy()
          await page.screenshot({
            path: `${OUTPUT}/overview-members--${theme}.png`,
            clip: { x: panel!.x, y: panel!.y, width: panel!.width, height: bottom!.y + bottom!.height - panel!.y },
            animations: 'disabled',
            caret: 'hide',
          })
        }
      }
    }
    await agents.getByRole('button', { name: /Linter/u }).click()
    await agents.getByRole('button', { name: '查看工作记录', exact: true }).click()
    await overview.waitFor({ state: 'hidden' })
    const nested = page.locator('.transcript .subagent-name').filter({ hasText: /^Linter$/u })
    await nested.waitFor()
    const nestedControl = nested.locator('xpath=ancestor::button[1]')
    await expect
      .poll(() =>
        nestedControl.evaluate(button => {
          const bounds = button.getBoundingClientRect()
          const transcript = button.closest('.transcript')!.getBoundingClientRect()
          return bounds.top >= transcript.top && bounds.bottom <= transcript.bottom
        }),
      )
      .toBe(true)
    await reachable(nestedControl)
    await page.getByRole('button', { name: '侧边面板', exact: true }).filter({ visible: true }).click()
    await agents.getByRole('button', { name: /子 Agent/u }).click()
    expect(await agents.getByRole('listitem').count()).toBe(0)
    await members.getByRole('button', { name: /检查窄屏布局/u }).click()
    await page.locator('.team-member-line').waitFor()
    await page.getByLabel('待批准操作').filter({ visible: true }).waitFor()
    await owner.json(`teams/${team.id}/stop`, { method: 'POST', body: { requestId: randomUUID() } })
    await teamIn(team.id, 'kept')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light' })
  })

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

  /** The panel in every view, without horizontal overflow, reopened where a width change gave it way. */
  async function panelShots(name: string, entry: ReturnType<Page['getByRole']>, ready: () => Promise<void>): Promise<void> {
    for (const [width, height, theme] of VIEWS) {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme })
      await page.waitForTimeout(400)
      for (let tries = 0; tries < 3 && !(await page.locator('.team-panel').filter({ visible: true }).count()); tries++) {
        await entry.click()
        await page.waitForTimeout(400)
      }
      await ready()
      // Nothing hovered or focused in the shot.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.mouse.move(width - 2, 2)
      await page.evaluate(() => document.fonts.ready)
      await settleShell(page)
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${OUTPUT}/${name}--${width}--${theme}.png`, animations: 'disabled', caret: 'hide' })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light' })
    // The phone's sheet gives way as the width changes; the entry opens the popover with the same list.
    await page.waitForTimeout(600)
    for (let tries = 0; tries < 3 && !(await page.locator('.team-panel').filter({ visible: true }).count()); tries++) {
      await entry.click()
      await page.waitForTimeout(400)
    }
  }

  it("starts each member on the model and level chosen in its own row, never the lead's", async () => {
    const id = await lead('换个模型查缓存')
    await open('换个模型查缓存')
    const entry = page.getByRole('button', { name: '用团队分工', exact: true }).filter({ visible: true })
    await entry.click()
    const panel = page.getByRole('dialog', { name: '团队分工', exact: true })
    await panel.getByRole('textbox', { name: '第 1 项', exact: true }).fill('echo 查缓存命中率')
    await panel.getByRole('textbox', { name: '第 2 项', exact: true }).fill('echo 查缓存失效')
    // A Codex session's panel only: no way to choose how to split here.
    expect(await panel.getByRole('radiogroup', { name: '分工方式', exact: true }).count()).toBe(0)
    const rows = panel.locator('.team-task')
    // Every row has its Harness, then its model entry; the old muted model name is gone.
    await rows.nth(1).locator('.team-harness').getByRole('button').first().click()
    await page.getByRole('menuitemradio', { name: 'Gamma', exact: true }).click()
    const model = rows.nth(1).locator('.team-agent-model button.model-picker')
    await model.waitFor()
    expect(await model.innerText()).toContain('Small')
    await model.click()
    const board = page.locator('.ui-board.is-entry').filter({ visible: true })
    await board.waitFor()
    await board.getByRole('menuitemradio', { name: /^Large/u }).click()
    await board.getByRole('menuitemradio', { name: 'Max', exact: true }).click()
    await page.keyboard.press('Escape')
    await board.waitFor({ state: 'hidden' })
    expect(await panel.isVisible()).toBe(true)
    await poll(() => model.innerText()).toMatch(/Large[\s\S]*Max/u)
    // Row 1 stays on this session's Harness as a new session of it would start.
    expect(await rows.nth(0).locator('.team-harness').innerText()).toContain('Alpha')
    await panelShots('panel-sessions', entry, async () => {
      await page.locator('.team-panel .team-agent-model').first().waitFor()
    })
    // On a phone the row's entry opens over the panel's sheet, and the panel stays.
    const reopen = async () => {
      await page.waitForTimeout(800)
      for (let tries = 0; tries < 3 && !(await page.locator('.team-panel').filter({ visible: true }).count()); tries++) {
        await entry.click()
        await page.waitForTimeout(600)
      }
      await model.waitFor()
      await settleShell(page)
    }
    // Opened at that width: a popover left open across the phone breakpoint keeps its desktop dismissal (packages/ui).
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'hidden' })
    await page.setViewportSize({ width: 390, height: 844 })
    await reopen()
    await model.click()
    await board.waitFor()
    await settleShell(page)
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUTPUT}/panel-sessions-board--390--light.png`, animations: 'disabled', caret: 'hide' })
    await page.keyboard.press('Escape')
    await board.waitFor({ state: 'hidden' })
    expect(await model.isVisible()).toBe(true)
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'hidden' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await reopen()
    // Another Harness and back: the row is on that Harness's own start again.
    await rows.nth(1).locator('.team-harness').getByRole('button').first().click()
    await page.getByRole('menuitemradio', { name: 'Beta', exact: true }).click()
    await rows.nth(1).locator('.team-harness').getByRole('button').first().click()
    await page.getByRole('menuitemradio', { name: 'Gamma', exact: true }).click()
    await poll(() => model.innerText()).toContain('Small')
    await model.click()
    await board.getByRole('menuitemradio', { name: /^Large/u }).click()
    await board.getByRole('menuitemradio', { name: 'Max', exact: true }).click()
    await page.keyboard.press('Escape')
    await board.waitFor({ state: 'hidden' })
    const sent = page.waitForRequest(request => request.url().endsWith(`/tasks/${id}/team`) && request.method() === 'POST')
    await panel.getByRole('button', { name: '开始', exact: true }).click()
    const body = (await sent).postDataJSON() as { tasks: Array<Record<string, unknown>> }
    expect(body.tasks[1]).toMatchObject({
      harnessId: 'gamma',
      ownModel: true,
      config: [
        { configId: 'model', value: 'large' },
        { configId: 'effort', value: 'max' },
      ],
    })
    await panel.waitFor({ state: 'hidden' })
    const started = (await snapshot()).teams!.find(row => row.leadSessionId === id)!
    expect(started.members.map(member => member.harnessId)).toEqual(['alpha', 'gamma'])
    await poll(async () => (await teamOf(started.id)).members.every(member => member.sessionId)).toBe(true)
    const team = await teamOf(started.id)
    const member = team.members[1]!.sessionId!
    await settled(member)
    const config = (await detail(member)).config ?? []
    expect(config.find(option => option.id === 'model')?.currentValue).toBe('large')
    expect(config.find(option => option.id === 'effort')?.currentValue).toBe('max')
    await teamIn(team.id, 'returned')
  }, 180_000)

  it("hands the list to Codex's own subagents as one message to this session, leaving the input as it was", async () => {
    const response = await owner.confirmed('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: 'echo 先看看', harnessId: 'codex' },
    })
    const { sessionId: id } = (await response.json()) as { sessionId: string }
    await settled(id)
    await owner.json(`tasks/${id}`, { method: 'PATCH', body: { title: '整理两个页面' } })
    await poll(async () => (await detail(id)).codexTeam).toBe('available')
    await open('整理两个页面')
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('先别发')
    const entry = page.getByRole('button', { name: '用团队分工', exact: true }).filter({ visible: true })
    await entry.click()
    const panel = page.getByRole('dialog', { name: '团队分工', exact: true })
    const modes = panel.getByRole('radiogroup', { name: '分工方式', exact: true })
    expect(await modes.getByRole('radio', { name: '各开会话', exact: true }).getAttribute('aria-checked')).toBe('true')
    // The old way in, which put the request into the input, is gone.
    expect(await panel.getByRole('button', { name: '用 Codex 自带的子 Agent', exact: true }).count()).toBe(0)
    await modes.getByRole('radio', { name: 'Codex 子 Agent', exact: true }).click()
    // Codex chooses who does what: the rows are their words alone.
    expect(await panel.locator('.team-harness, .team-agent-model').count()).toBe(0)
    await panel.getByRole('textbox', { name: '第 1 项', exact: true }).fill('检查窄屏\n看 390 宽')
    await panel.getByRole('textbox', { name: '第 2 项', exact: true }).fill('核对回执')
    await panelShots('panel-codex', entry, async () => {
      await page.locator('.team-panel[data-mode="codex"]').waitFor()
    })
    // The mode is remembered for this session while the page lives.
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'hidden' })
    await entry.click()
    expect(await modes.getByRole('radio', { name: 'Codex 子 Agent', exact: true }).getAttribute('aria-checked')).toBe('true')
    const before = (await detail(id)).messages.filter(message => message.role === 'user').length
    await panel.getByRole('button', { name: '开始', exact: true }).click()
    await panel.waitFor({ state: 'hidden' })
    await poll(async () => (await detail(id)).messages.filter(message => message.role === 'user').length).toBe(before + 1)
    const sent = (await detail(id)).messages.filter(message => message.role === 'user').at(-1)!.text
    expect(sent).toBe(
      '请启动 Codex 的子 Agent 并行处理下列任务。分工后等待各成员结果，再汇总给我。\n\n1. 检查窄屏\n   看 390 宽\n2. 核对回执',
    )
    expect((await detail(id)).messages.findLast(message => message.role === 'user')?.teamRequest).toBe(true)
    expect(await promptValue(input)).toBe('先别发')
    // No team of sessions was made: Codex's own members are the record's.
    expect((await snapshot()).teams?.some(row => row.leadSessionId === id)).toBe(false)
    // While the session works (a member waits for the person), the next list waits in its queue, as a typed message would.
    await poll(async () => (await detail(id)).summary.status).toBe('waiting-approval')
    await entry.click()
    await panel.waitFor()
    expect(await modes.getByRole('radio', { name: 'Codex 子 Agent', exact: true }).getAttribute('aria-checked')).toBe('true')
    await panel.getByRole('textbox', { name: '第 1 项', exact: true }).fill('再看一遍')
    await panel.getByRole('button', { name: '开始', exact: true }).click()
    await panel.waitFor({ state: 'hidden' })
    await poll(async () => (await detail(id)).queue?.map(item => item.text)).toEqual([
      '请启动 Codex 的子 Agent 并行处理下列任务。分工后等待各成员结果，再汇总给我。\n\n1. 再看一遍',
    ])
    expect((await detail(id)).messages.filter(message => message.role === 'user').length).toBe(before + 1)
    expect(await promptValue(input)).toBe('先别发')
    await input.fill('')
  }, 180_000)

  it('sends existing members another round from the input with @, its results titled with the round', async () => {
    const id = await lead('拆分登录重构')
    const team = await startTeam(id, {
      tasks: [
        { title: '列出改动', prompt: 'echo 一共要改 6 个文件。', harnessId: 'alpha' },
        { title: '核对接口', prompt: 'echo 接口签名不变。', harnessId: 'beta' },
      ],
    })
    await teamIn(team.id, 'returned')
    await settled(id)
    await open('拆分登录重构')
    await card(team.id).waitFor()
    const input = () => page.getByRole('textbox', { name: '继续对话', exact: true }).filter({ visible: true })
    const list = page.getByRole('listbox', { name: '提到成员或文件', exact: true })
    const members = list.getByRole('group', { name: '成员', exact: true })
    // @ lists the members first, each with its Harness and how it stands.
    await input().fill('@')
    await members.waitFor()
    expect(await members.getByRole('option').allInnerTexts()).toEqual([
      expect.stringMatching(/列出改动[\s\S]*Alpha[\s\S]*已完成/u),
      expect.stringMatching(/核对接口[\s\S]*Beta[\s\S]*已完成/u),
    ])
    await shots('mention', '拆分登录重构', async view => {
      const field = view.getByRole('textbox', { name: '继续对话', exact: true }).filter({ visible: true })
      await field.fill('')
      await field.fill('@')
      await view.getByRole('listbox', { name: '提到成员或文件', exact: true }).getByRole('group', { name: '成员', exact: true }).waitFor()
    })
    // Picking one puts its chip in the input; a second chip names the other. Enter sends them a round, not this session.
    await input().fill('@核')
    await page.keyboard.press('Enter')
    await poll(() => promptValue(input())).toBe('@核对接口 ')
    await page.keyboard.type('@列')
    await members.waitFor()
    await page.keyboard.press('Enter')
    await page.keyboard.type('echo 再核对一遍边界。')
    expect(await page.locator('.composer-input .prompt-chip[data-kind="member"]').count()).toBe(2)
    expect(await promptValue(input())).toBe('@核对接口 @列出改动 echo 再核对一遍边界。')
    // Two members side by side: each its Harness mark and name, with room between them and before the text.
    const memberChips = await input().evaluate(element =>
      [...element.querySelectorAll<HTMLElement>('.prompt-chip[data-kind="member"]')].map(chip => ({
        label: chip.querySelector('.prompt-chip-label')!.textContent,
        title: chip.title,
        box: chip.getBoundingClientRect().toJSON() as DOMRect,
        icon: chip.querySelector('.prompt-chip-icon')!.getBoundingClientRect().toJSON() as DOMRect,
      })),
    )
    expect(memberChips.map(chip => chip.label)).toEqual(['核对接口', '列出改动'])
    expect(memberChips[1]!.box.left - memberChips[0]!.box.right).toBeGreaterThanOrEqual(4)
    expect(memberChips.every(chip => Math.abs(chip.icon.width - 14) <= 0.5)).toBe(true)
    await shots('member-chips', '拆分登录重构', async view => {
      const field = view.getByRole('textbox', { name: '继续对话', exact: true }).filter({ visible: true })
      await field.fill('@核对接口 @列出改动 echo 再核对一遍边界。')
      await field.locator('.prompt-chip[data-kind="member"]').nth(1).waitFor()
    })
    // The shared views have no light phone: that one too.
    await page.setViewportSize({ width: 390, height: 844 })
    await settleShell(page)
    if (!(await page.locator('.transcript .turn').first().isVisible())) await open('拆分登录重构')
    await input().fill('@核对接口 @列出改动 echo 再核对一遍边界。')
    await input().locator('.prompt-chip[data-kind="member"]').nth(1).waitFor()
    await page.mouse.move(388, 400)
    await page.screenshot({ path: `${OUTPUT}/member-chips--390--light.png`, animations: 'disabled', caret: 'hide' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await settleShell(page)
    if (!(await page.locator('.transcript .turn').first().isVisible())) await open('拆分登录重构')
    await input().fill('@核对接口 @列出改动 echo 再核对一遍边界。')
    await input().press('End')
    const before = (await detail(id)).messages.length
    await page.keyboard.press('Enter')
    await poll(() => promptValue(input())).toBe('')
    const second = await teamIn(team.id, 'returned')
    expect(second.round).toBe(2)
    expect(second.rounds?.at(-1)?.members.map(member => member.itemId)).toEqual(team.members.map(member => member.itemId))
    for (const member of team.members)
      expect((await detail(member.sessionId!)).messages.filter(message => message.role === 'user').at(-1)?.text).toBe(
        'echo 再核对一遍边界。',
      )
    // Nothing of it went to this session as a message of the person's: only the results came back.
    const after = (await detail(id)).messages.slice(before)
    expect(after.filter(message => message.role === 'user').map(message => message.text.startsWith('团队成员都结束了'))).toEqual([true])
    await settled(id)
    // The card shows the latest round; its results say which round they are.
    await poll(() => card(team.id).locator('.team-round').innerText()).toBe('第 2 轮')
    const results = page.locator(`.team-results[data-message-id="${second.returnedMessageId}"]`)
    await results.waitFor()
    expect(await results.locator('.team-results-title').innerText()).toBe('成员的结果 · 第 2 轮')
    await results.getByRole('button', { name: /核对接口/u }).click()
    await results.locator('.team-result-body').getByText('再核对一遍边界', { exact: false }).waitFor()
    // The first round's card still opens to that round's reply.
    const firstResults = page.locator(
      `.team-results[data-message-id="${team.returnedMessageId ?? (await snapshot()).teams!.find(row => row.id === team.id)!.rounds![0]!.returnedMessageId}"]`,
    )
    expect(await firstResults.locator('.team-results-title').innerText()).toBe('成员的结果 · 第 1 轮')
    await shots('round-2', '拆分登录重构', async view => {
      const shown = view.locator(`.team-results[data-message-id="${second.returnedMessageId}"]`)
      await shown.waitFor()
      await shown.evaluate(node => node.scrollIntoView({ block: 'center' }))
    })
    await noHorizontalOverflow(page)
  }, 240_000)

  it('marks the round on the card, and sends one member another round from its row', async () => {
    const id = await lead('拆分支付重构')
    const team = await startTeam(id, {
      tasks: [
        { title: '列出改动', prompt: 'echo 一共要改 6 个文件。', harnessId: 'alpha' },
        { title: '核对接口', prompt: 'echo 接口签名不变。', harnessId: 'beta' },
      ],
    })
    await teamIn(team.id, 'returned')
    await settled(id)
    await owner.json(`teams/${team.id}/rounds`, {
      method: 'POST',
      body: { requestId: randomUUID(), sends: [{ itemId: team.members[1]!.itemId, prompt: 'echo 再核对一遍边界。' }] },
    })
    await teamIn(team.id, 'returned')
    await settled(id)
    await open('拆分支付重构')
    await card(team.id).waitFor()
    const mark = card(team.id).locator('.team-round')
    await poll(() => mark.innerText()).toBe('第 2 轮')
    await mark.hover()
    await page.getByRole('tooltip').filter({ hasText: '你派的' }).waitFor()

    await shots('round-mark', '拆分支付重构', async view => {
      const graph = view.locator(`.team-card[data-team="${team.id}"]`)
      await graph.locator('.team-round').waitFor()
      await graph.evaluate(node => node.scrollIntoView({ block: 'center' }))
    })

    // 再派一轮 from a row: the action at the pill's end opens a line under the graph; Esc closes it, Enter sends that
    // member alone. The rows keep their height.
    const name = '再派一轮给「列出改动」'
    const row = card(team.id).locator('.team-member').nth(0)
    const height = (await row.boundingBox())!.height
    const openAgain = async (view: Page) => {
      const target = view.locator(`.team-card[data-team="${team.id}"] .team-member`).nth(0)
      await target.hover()
      await target.getByRole('button', { name, exact: true }).click()
    }
    const again = card(team.id).getByRole('textbox', { name, exact: true })
    await row.evaluate(node => node.scrollIntoView({ block: 'center' }))
    await row.hover()
    await row.getByRole('button', { name, exact: true }).waitFor()
    await page.screenshot({ path: `${OUTPUT}/again-hover--1440--light.png`, animations: 'disabled', caret: 'hide' })
    await openAgain(page)
    await again.waitFor()
    expect((await row.boundingBox())!.height).toBe(height)
    await page.keyboard.press('Escape')
    await again.waitFor({ state: 'hidden' })
    await openAgain(page)
    await again.fill('echo 把第 3 个文件拆成两个。')
    await shots('again', '拆分支付重构', async view => {
      const field = view.locator(`.team-card[data-team="${team.id}"]`).getByRole('textbox', { name, exact: true })
      if (!(await field.isVisible())) {
        await openAgain(view)
        await field.fill('echo 把第 3 个文件拆成两个。')
      }
      await field.evaluate(node => node.scrollIntoView({ block: 'center' }))
    })
    if (!(await again.isVisible())) {
      await openAgain(page)
      await again.fill('echo 把第 3 个文件拆成两个。')
    }
    await again.press('Enter')
    await again.waitFor({ state: 'hidden' })
    const third = await teamIn(team.id, 'returned')
    expect(third.rounds?.at(-1)).toMatchObject({ round: 3, by: 'person', members: [{ itemId: team.members[0]!.itemId }] })
    await poll(() => card(team.id).locator('.team-round').innerText()).toBe('第 3 轮')
    await noHorizontalOverflow(page)
  }, 240_000)
})

/**
 * The switch that lets the lead's agent send work by itself, on a Host with the demo model: a member on Latch 内置 (L1)
 * is the only kind the default unattended ceiling lets a round nobody pressed reach.
 */
describe("the lead's agent sending its team another round", () => {
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let page: Page
  let state = ''

  const poll = <T>(read: () => T) => expect.poll(read, { timeout: 20_000 })
  const teamOf = async (id: string) => (await owner.json<TeamAnswer>(`teams/${id}`)).team
  const settled = async (id: string) =>
    expect
      .poll(async () => ['idle', 'failed', 'cancelled'].includes((await owner.json<TaskDetail>(`tasks/${id}`)).summary.status), {
        timeout: 20_000,
      })
      .toBe(true)

  beforeAll(async () => {
    await mkdir(OUTPUT, { recursive: true })
    state = await mkdtemp(join(tmpdir(), 'latch-e2e-team-agent-'))
    host = await startTestHost({ demo: true })
    owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: {
        id: 'alpha',
        name: 'Alpha',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(state, 'alpha.json'), FAKE_ACP_CAPS: 'load,resume' },
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

  it('turns the switch on, and the results of the round the agent sent come back as round 2', async () => {
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: 'echo 先把文案定下来', harnessId: 'alpha', mode: 'agent' },
    })
    const { sessionId: id } = (await created.json()) as { sessionId: string }
    await settled(id)
    await owner.json(`tasks/${id}`, { method: 'PATCH', body: { title: '首页文案' } })
    const { team } = await owner.json<TeamAnswer>(`tasks/${id}/team`, {
      method: 'POST',
      body: { requestId: randomUUID(), tasks: [{ title: '写问候语', prompt: '写一句问候', harnessId: 'standard' }] },
    })
    await poll(async () => (await teamOf(team.id)).state).toBe('returned')
    await settled(id)
    await page.keyboard.press('Meta+k')
    const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
    await palette.getByRole('searchbox').fill('首页文案')
    await palette.getByRole('option', { name: '首页文案', exact: true }).first().click()
    const graph = page.locator(`.team-card[data-team="${team.id}"]`)
    await graph.waitFor()
    // Off by default; the person turns it on.
    const toggle = graph.getByRole('switch', { name: '让它自己派活', exact: true })
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    await toggle.click()
    await poll(async () => (await teamOf(team.id)).agentDispatch).toBe(true)
    await poll(() => toggle.getAttribute('aria-checked')).toBe('true')
    for (const [width, height, theme] of VIEWS) {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme })
      await settleShell(page)
      await graph.evaluate(node => node.scrollIntoView({ block: 'center' }))
      await page.mouse.move(width - 2, Math.floor(height / 2))
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${OUTPUT}/switch--${width}--${theme}.png`, animations: 'disabled', caret: 'hide' })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light' })

    // The lead's agent sends its member another round through its own tool.
    await owner.json(`tasks/${id}/prompt`, {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        prompt: `mcp latch-skills send_to_members ${JSON.stringify({ sends: [{ member: 'm1', prompt: '再写一句更短的问候' }] })}`,
      },
    })
    await poll(async () => (await teamOf(team.id)).rounds?.at(-1)?.state).toBe('returned')
    const done = await teamOf(team.id)
    expect(done.rounds?.at(-1)).toMatchObject({ round: 2, by: 'agent' })
    const results = page.locator(`.team-results[data-message-id="${done.returnedMessageId}"]`)
    await results.waitFor()
    await poll(() => results.locator('.team-results-title').innerText()).toBe('成员的结果 · 第 2 轮')
    // The lead can still be following its reply to the returned results. Hover after the conversation has settled.
    await settled(id)
    const mark = graph.locator('.team-round')
    await poll(() => mark.innerText()).toBe('第 2 轮')
    await poll(() => mark.getAttribute('aria-describedby')).toBeTruthy()
    await mark.scrollIntoViewIfNeeded()
    await settleShell(page)
    await page.mouse.move(0, 0)
    await mark.hover()
    await page.getByRole('tooltip').filter({ hasText: 'Agent 派的' }).waitFor()
    await results.evaluate(node => node.scrollIntoView({ block: 'center' }))
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUTPUT}/agent-round--1440--light.png`, animations: 'disabled', caret: 'hide' })
    // Turned off again by the person.
    await toggle.click()
    await poll(async () => (await teamOf(team.id)).agentDispatch).toBeUndefined()
  }, 180_000)
})
