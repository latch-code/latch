import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentSettings, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { type TestDevice, FAKE_ACP_AGENT } from '@latch/testkit'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { expectUnmovedByInjectedStyles } from './helpers/security.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openSection, openSettings, closeSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/permissions'

/**
 * A model that always calls a tool from a third-party plugin. The Host classifies
 * tools it does not know as high risk (R2), whatever the plugin declares.
 */
const highRiskFixture: HarnessPlugin = {
  id: 'r2-fixture',
  name: '高风险工具验收插件',
  version: '1.0.0',
  description: '仅测试使用。',
  activate(context) {
    context.registerTool({
      name: 'touch_marker',
      description: '测试用工具，不访问文件。',
      parameters: { type: 'object', properties: {} },
      requiresApproval: false,
      async execute() {
        return { text: 'marker touched' }
      },
    })
    context.registerProvider({
      id: 'r2-model',
      name: 'R2 fixture',
      model: 'fixture',
      async *stream({ messages }) {
        if (messages.at(-1)?.role === 'tool') {
          yield { type: 'text', text: '工具调用已结算。' }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        yield { type: 'tool-call', call: { id: 'call-r2', name: 'touch_marker', arguments: {} } }
        yield { type: 'finish', reason: 'tool-calls' }
      },
    })
  },
}

describe('permission states in a browser', () => {
  let testHost: TestHost
  let browser: Browser
  let page: Page
  let local: TestDevice
  let remote: TestDevice

  beforeAll(async () => {
    testHost = await startTestHost({
      demo: true,
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
      plugins: [highRiskFixture],
    })
    browser = await chromium.launch(browserLaunchOptions())
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    context.setDefaultTimeout(15_000)
    page = await context.newPage()
    await enrollBrowser(page, testHost, { name: '验收浏览器' })
    // The Host's own desktop (unix socket) and another browser device, both driven through the API.
    local = await testHost.enroll({ listener: 'unix', name: '本机桌面端' })
    remote = await testHost.enroll({ name: '另一台浏览器' })
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await testHost?.close()
  })

  /** A Latch 内置 card: 拒绝 asks what to do instead in the composer, and the second 拒绝 rejects without a note. */
  async function rejectWithoutNote(card: Locator): Promise<void> {
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    await card.getByText('在输入框里告诉 Agent 改做什么，再按「拒绝」；不写也可以。', { exact: true }).waitFor()
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
  }
  async function open(sessionId: string): Promise<void> {
    await page.locator(`[data-task-id="${sessionId}"]`).click()
    await page.locator('.transcript-content').waitFor()
  }
  const detail = (id: string) => local.json<TaskDetail>(`tasks/${encodeURIComponent(id)}`)
  /** A session whose tool the Host classifies as high risk, once its approval waits. */
  async function startHighRisk(prompt: string): Promise<string> {
    const { sessionId } = await remote.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt, requestId: randomUUID(), mode: 'agent', model: { providerId: 'r2-model', model: 'fixture' } },
    })
    await expect.poll(async () => (await detail(sessionId)).approvals.length).toBe(1)
    return sessionId
  }

  it('shows a high-risk approval with the host-desktop hint and no allow button; reject still works', async () => {
    const { sessionId } = await remote.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '写入标记', requestId: randomUUID(), mode: 'agent', model: { providerId: 'r2-model', model: 'fixture' } },
    })
    await expect.poll(async () => (await detail(sessionId)).approvals.length).toBe(1)
    expect((await detail(sessionId)).approvals[0]?.risk).toBe('R2')
    await open(sessionId)
    const card = page.locator('[data-approval-id]')
    await card.getByText('高风险 · 未登记的工具', { exact: true }).waitFor()
    await card.getByText('高风险操作只能在运行 Latch 的电脑上用 Latch 桌面端批准', { exact: true }).waitFor()
    expect(await card.getByRole('button', { name: /允许/ }).count()).toBe(0)
    await page.screenshot({ path: `${OUTPUT}/r2-browser-desktop.png`, fullPage: true, animations: 'disabled' })
    // 拒绝 asks what to do instead; pressing it again rejects without a note.
    await rejectWithoutNote(card)
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
    await card.waitFor({ state: 'detached' })
    // The card folds into its row: the state slot reads the record, 已拒绝 and its time in the hint ink, never 失败, and
    // nothing says it a second time.
    const row = page.locator('.tool-card', { has: page.locator('.tool-decision-words') })
    const record = row.locator('.tool-card-state .tool-decision-words')
    await record.waitFor()
    expect(await row.locator('.tool-card-state').getAttribute('class')).not.toContain('state-failed')
    expect(await record.textContent()).toMatch(/^已拒绝 · \d{2}:\d{2}$/u)
    expect(await record.getAttribute('title')).toContain('在其他设备上决定')
    expect(await row.locator('.tool-decision').count()).toBe(0)
    expect((await row.textContent())?.match(/已拒绝/gu)).toHaveLength(1)
    // A titled tool's row names it by its title; the plugin tool here has none, so its ID is the label itself.
    expect(await row.locator('.tool-card-name').count()).toBe(0)
    expect((await detail(sessionId)).messages.find(message => message.role === 'tool')?.tool?.decision).toMatchObject({
      outcome: 'rejected',
      via: 'other-device',
    })
    expect(await page.locator('.transcript-content').textContent()).not.toMatch(/APPROVAL_REJECTED|。。/u)
    // Captured once the turn has settled on the page: no live line, and the send button back in place of stop.
    await page.locator('.turn-phase').waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '取消任务' }).waitFor({ state: 'detached' })
    await page.screenshot({ path: `${OUTPUT}/r2-rejected-record.png`, fullPage: true, animations: 'disabled' })
  })

  it('asks what to do instead after 拒绝 and hands it to Latch 内置 with the rejection', async () => {
    const { sessionId } = await remote.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '生成需要审批的报告', requestId: randomUUID(), mode: 'agent', model: { providerId: 'demo', model: 'demo' } },
    })
    await expect.poll(async () => (await detail(sessionId)).approvals.length).toBe(1)
    await open(sessionId)
    const card = page.locator('[data-approval-id]')
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    // The rejection waits: the composer takes focus and asks, and the card says where to write.
    const note = page.getByRole('textbox', { name: '告诉 Agent 改做什么', exact: true })
    await expect.poll(() => note.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await note.getAttribute('placeholder')).toBe('告诉 Agent 改做什么…')
    await card.getByText('在输入框里告诉 Agent 改做什么，再按「拒绝」；不写也可以。', { exact: true }).waitFor()
    await page.getByText('写下的话会和拒绝一起交给模型；不写也可以直接拒绝。', { exact: true }).waitFor()
    expect((await detail(sessionId)).approvals).toHaveLength(1)
    await page.screenshot({ path: `${OUTPUT}/reject-note-asking.png`, fullPage: true, animations: 'disabled' })
    await note.fill('改写到 docs/ 下')
    await note.press('Enter')
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
    const settled = await detail(sessionId)
    expect(settled.messages.find(message => message.role === 'tool')?.tool?.decision).toMatchObject({ outcome: 'rejected' })
    expect(settled.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain('收到你的说明：「改写到 docs/ 下」')
    await page.getByText(/收到你的说明：「改写到 docs\/ 下」/u).waitFor()
    // The composer is itself again, and what was written went with the rejection, not into the draft.
    const composer = page.getByRole('textbox', { name: '继续对话', exact: true })
    await composer.waitFor()
    expect(await composer.inputValue()).toBe('')
    expect(await page.getByText('写下的话会和拒绝一起交给模型；不写也可以直接拒绝。', { exact: true }).count()).toBe(0)
  })

  it.each([
    { name: 'phone', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
  ])('keeps approval buttons reachable after switching conversations on $name', async ({ width, height }) => {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, locale: 'zh-CN' })
    const phone = await context.newPage()
    const sessions: string[] = []
    try {
      await enrollBrowser(phone, testHost, { name: '审批手机' })
      sessions.push(await startHighRisk('第一个等待审批的会话'), await startHighRisk('第二个等待审批的会话'))
      for (let round = 0; round < 16; round++) {
        await phone.evaluate(() => sessionStorage.clear())
        await phone.reload()
        await connected(phone)
        const drawer = phone.getByRole('button', { name: '打开会话列表', exact: true })
        if (width >= 768) await drawer.click()
        await phone.locator(`[data-task-id="${sessions[0]}"]`).click()
        await phone.locator('.drawer-backdrop').waitFor({ state: 'detached' })
        const reject = phone.locator('[data-approval-id]').getByRole('button', { name: '拒绝', exact: true })
        // Exercise the actual pointer hit test after the session's entry animation, including a non-scrolling transcript.
        // An opacity animation on the masked scroller used to leave its visible buttons outside Chromium's hit region.
        await reject.click({ trial: true, timeout: 6000 })
      }
    } finally {
      await context.close()
      for (const id of sessions) await remote.request(`tasks/${id}/cancel`, { method: 'POST' })
    }
  })

  it('keeps an approval card as it is under styles added to the page', async () => {
    const { sessionId } = await remote.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '再写入一次标记', requestId: randomUUID(), mode: 'agent', model: { providerId: 'r2-model', model: 'fixture' } },
    })
    await expect.poll(async () => (await detail(sessionId)).approvals.length).toBe(1)
    await open(sessionId)
    const card = '[data-approval-id]'
    await page.locator(card).getByText('高风险 · 未登记的工具', { exact: true }).waitFor()
    await expectUnmovedByInjectedStyles(page, [
      card,
      `${card} .tool-card-header`,
      `${card} .tool-card-title`,
      `${card} .tool-card-header .ui-status-word`,
      `${card} .tool-card-header .ui-status-word-glyph`,
      `${card} .approval-panel`,
      `${card} .approval-meta`,
      `${card} .approval-preview .muted-line`,
      `${card} .approval-hint`,
      `${card} .ui-button`,
    ])
    await rejectWithoutNote(page.locator(card))
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
  })

  it('brings an approval card in and folds it away with the motion tokens, and only fades under reduced motion', async () => {
    const quiet = await startHighRisk('先看这一个')
    const arriving = await startHighRisk('看它到达')
    await open(quiet)
    const card = page.locator('[data-approval-id]')
    await card.getByText('高风险 · 未登记的工具', { exact: true }).waitFor()
    // The motion tokens as the browser resolves them (a probe reads each through a transition property).
    const tokens = await page.evaluate(() => {
      const probe = document.createElement('div')
      document.body.append(probe)
      const computed = (property: 'transitionDuration' | 'transitionTimingFunction', token: string) => {
        probe.style[property] = `var(${token})`
        return getComputedStyle(probe)[property]
      }
      const ms = (token: string) => Math.round(parseFloat(computed('transitionDuration', token)) * 1000)
      const result = {
        micro: ms('--m-micro'),
        enter: ms('--m-enter'),
        panel: ms('--m-panel'),
        eEnter: computed('transitionTimingFunction', '--e-enter'),
        ePanel: computed('transitionTimingFunction', '--e-panel'),
        exit: computed('transitionTimingFunction', '--e-exit'),
      }
      probe.remove()
      return result
    })
    expect(tokens).toEqual({
      micro: 120,
      enter: 160,
      panel: 200,
      eEnter: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      ePanel: 'cubic-bezier(0.32, 0.72, 0, 1)',
      exit: 'cubic-bezier(0.4, 0, 1, 1)',
    })
    /** An exit takes 70% of its entrance. */
    const exit = (ms: number) => Math.round(ms * 0.7)

    /**
     * From now on, pauses every transition of an approval slot within a frame of its start, so a card that the page
     * renders again (the transcript of a session it switches to) still has its arrival to step through.
     */
    const hold = () =>
      page.evaluate(() => {
        const flag = 'holdingSlots'
        Reflect.set(globalThis, flag, true)
        const tick = () => {
          if (Reflect.get(globalThis, flag) !== true) return
          for (const animation of document.getAnimations()) {
            const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
            if (target?.matches('.approval-slot') && animation.playState === 'running') animation.pause()
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    /** The held transitions of the slot under the tool card, once the page has settled for a moment. */
    const held = async () => {
      await page.waitForTimeout(400)
      return page.evaluate(() =>
        document
          .getAnimations()
          .filter(
            animation =>
              animation.effect instanceof KeyframeEffect
              && animation.effect.target?.matches('.tool-card[data-message-id] > .approval-slot'),
          )
          .map(animation => ({
            property: animation instanceof CSSTransition ? animation.transitionProperty : '',
            // An exit is calc(token * 0.7), which the browser reports with floating-point noise (139.99999999999997).
            duration: Math.round(Number(animation.effect!.getTiming().duration)),
            easing: String(animation.effect!.getTiming().easing),
          }))
          .toSorted((a, b) => a.property.localeCompare(b.property)),
      )
    }
    /** Puts the held transitions at `ms` and every other animation at its end, then captures the card's frame. */
    const frames = async (name: string, target: Locator) => {
      for (const ms of [0, 60, 120, 180]) {
        await page.evaluate(at => {
          for (const animation of document.getAnimations()) {
            const element = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
            if (element?.matches('.approval-slot')) {
              animation.pause()
              animation.currentTime = at
            } else if (Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))) animation.finish()
          }
        }, ms)
        await target.screenshot({ path: `${OUTPUT}/approval-${name}-${ms}ms.png` })
      }
      await page.evaluate(() => {
        Reflect.set(globalThis, 'holdingSlots', false)
        for (const animation of document.getAnimations())
          if (Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))) animation.finish()
      })
    }

    // Arrival: the card fades in over --m-enter and does not grow, so nothing above it moves.
    await hold()
    await open(arriving)
    expect(await held()).toEqual([{ property: 'opacity', duration: tokens.enter, easing: tokens.eEnter }])
    await frames('arrival', card)

    // Settled: the slot folds by its height (70% of --m-panel) while its content fades (70% of --m-micro), both on the
    // exit curve. The folding copy stays until those transitions end, so the held frames show it. The first 拒绝 asks
    // for a note.
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    await card.getByText('在输入框里告诉 Agent 改做什么，再按「拒绝」；不写也可以。', { exact: true }).waitFor()
    await hold()
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    await page.locator('.approval-slot[data-leaving]').waitFor()
    expect(await held()).toEqual([
      { property: 'grid-template-rows', duration: exit(tokens.panel), easing: tokens.exit },
      { property: 'opacity', duration: exit(tokens.micro), easing: tokens.exit },
    ])
    await frames('settle', page.locator('.tool-card', { has: page.locator('.approval-slot') }))
    await page.locator('.approval-slot').waitFor({ state: 'detached' })
    await expect.poll(async () => (await detail(arriving)).summary.status).toBe('idle')

    // The preview's disclosure opens over --m-panel and folds in 70% of it on the exit curve.
    await open(quiet)
    await card.getByText('高风险 · 未登记的工具', { exact: true }).waitFor()
    const disclosure = await page.evaluate(() => {
      const panel = document.querySelector('[data-approval-id] .approval-panel')!
      const probe = document.createElement('div')
      probe.className = 'approval-preview'
      panel.append(probe)
      const style = getComputedStyle(probe)
      const folded = `${style.transitionProperty} ${style.transitionDuration} ${style.transitionTimingFunction}`
      probe.setAttribute('data-open', '')
      const opened = `${style.transitionProperty} ${style.transitionDuration} ${style.transitionTimingFunction}`
      probe.remove()
      return { folded, open: opened }
    })
    expect(disclosure).toEqual({
      folded: `grid-template-rows ${exit(tokens.panel) / 1000}s ${tokens.exit}`,
      open: `grid-template-rows ${tokens.panel / 1000}s ${tokens.ePanel}`,
    })

    // Reduced motion: no slide or growth; only fades of 120ms or less remain.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reduced = await page.evaluate(() =>
      ['.approval-slot', '.approval-preview'].map(selector => {
        const style = getComputedStyle(document.querySelector(`[data-approval-id] ${selector}`)!)
        return { properties: style.transitionProperty, durations: style.transitionDuration }
      }),
    )
    for (const { properties, durations } of reduced) {
      expect(properties).not.toMatch(/grid-template-rows|transform|translate|scale/u)
      expect(durations.split(', ').every(part => parseFloat(part) <= 0.12)).toBe(true)
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await rejectWithoutNote(card)
    await expect.poll(async () => (await detail(quiet)).summary.status).toBe('idle')
    await card.waitFor({ state: 'detached' })
  })

  it('says approvals wait in amber above the input only while none of their cards is in view', async () => {
    // A long request makes the conversation taller than the window, so the card can be scrolled out of view.
    const sessionId = await startHighRisk(Array.from({ length: 40 }, (_, line) => `第 ${line + 1} 行要求`).join('\n'))
    await page.setViewportSize({ width: 1440, height: 640 })
    try {
      await open(sessionId)
      const card = page.locator('[data-approval-id]')
      await card.getByText('高风险 · 未登记的工具', { exact: true }).waitFor()
      const bar = page.locator('.run-bar-collapse')
      const transcript = page.locator('.transcript')
      const cardShows = () =>
        card.evaluate(element => {
          const box = element.getBoundingClientRect()
          const frame = element.closest('.transcript')!.getBoundingClientRect()
          return box.bottom > frame.top && box.top < frame.bottom
        })
      // The page opens on the latest output: the card is in view and says so itself, so the bar says nothing.
      expect(await cardShows()).toBe(true)
      await expect.poll(() => bar.getAttribute('data-state')).toBe('closed')
      expect(await page.locator('.run-bar.is-waiting').count()).toBe(0)
      await page.screenshot({ path: `${OUTPUT}/run-bar-card-in-view.png`, animations: 'disabled' })

      // Scrolled away from it by the reader, the bar says it in amber, with what it would do and 查看.
      await transcript.hover()
      await page.mouse.wheel(0, -4000)
      await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBe(0)
      expect(await cardShows()).toBe(false)
      const waiting = page.locator('.run-bar.is-waiting')
      await waiting.getByText('1 项待批准', { exact: true }).waitFor()
      await expect.poll(() => bar.getAttribute('data-state')).toBe('open')
      expect((await waiting.locator('.run-bar-detail').textContent())?.trim()).toBeTruthy()
      await page.locator('.run-bar-collapse[data-settled]').waitFor()
      await page.screenshot({ path: `${OUTPUT}/run-bar-waiting.png`, animations: 'disabled' })

      // 查看 brings the card back into view, and the bar folds away again.
      await waiting.getByRole('button', { name: '查看', exact: true }).click()
      await expect.poll(cardShows).toBe(true)
      await expect.poll(() => bar.getAttribute('data-state')).not.toBe('open')
      await rejectWithoutNote(card)
      await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
    } finally {
      await page.setViewportSize({ width: 1440, height: 1000 })
    }
  })

  it('keeps a full-access session read-only in the browser and shows permission drift', async () => {
    const saved = await local.confirmed('agents', {
      method: 'POST',
      body: { name: 'Fake Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    expect(saved.status).toBe(201)
    const { agent } = (await saved.json()) as { agent: AgentSettings }
    const created = await local.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'permission', requestId: randomUUID(), mode: 'agent', harnessId: agent.id },
    })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    await expect.poll(async () => (await detail(sessionId)).approvals.length).toBe(1)
    await open(sessionId)

    await page.locator('.topbar').getByText('完全访问', { exact: true }).waitFor()
    await page.getByText('完全访问会话只接受执行端电脑上 Latch 桌面端的输入。此设备可以查看、拒绝和取消。', { exact: true }).waitFor()
    expect(await page.getByRole('textbox', { name: '继续对话' }).count()).toBe(0)
    const card = page.locator('[data-approval-id]')
    await card.getByText('仅提示', { exact: true }).waitFor()
    await card.getByText('完全访问会话中，Agent 的询问只是提示：拒绝会转达给它，但不能阻止它执行其他操作。', { exact: true }).waitFor()
    await card.getByText('只有运行 Latch 的电脑上的 Latch 桌面端可以回应完全访问会话的询问', { exact: true }).waitFor()
    expect(await card.getByRole('button', { name: /允许/ }).count()).toBe(0)
    await page.screenshot({ path: `${OUTPUT}/l3-read-only-desktop.png`, fullPage: true, animations: 'disabled' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: `${OUTPUT}/l3-read-only-phone.png`, fullPage: true, animations: 'disabled' })
    await page.setViewportSize({ width: 1440, height: 1000 })
    // Reject is a class-C action every device may take; the card names the agent's option in the product's words.
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')

    // The harness switches its own permission mode mid-turn: the Host cancels the turn and stops the session.
    await local.json(`tasks/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      body: { prompt: 'drift plan', requestId: randomUUID() },
    })
    await expect.poll(async () => (await detail(sessionId)).summary.permissionDrift, { timeout: 15_000 }).toBe(true)
    await page.getByText('检测到权限模式变化，本轮已取消，挂起的询问已拒绝。该会话不再接受输入，请新建会话。', { exact: true }).waitFor()
    expect(await page.getByRole('textbox', { name: '继续对话' }).count()).toBe(0)
    await page.screenshot({ path: `${OUTPUT}/l3-drift-desktop.png`, fullPage: true, animations: 'disabled' })
    // The banner that stops the session is a security surface too.
    await expectUnmovedByInjectedStyles(page, [
      '.ui-notice[data-secure]',
      '.ui-notice[data-secure] .ui-notice-text',
      '.ui-notice[data-secure] .ui-button',
    ])
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: `${OUTPUT}/l3-drift-dark.png`, fullPage: true, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'light' })
  })

  it('marks full-access harnesses as desktop-only in the new-session picker', async () => {
    await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
    const item = page.getByRole('radiogroup', { name: 'Agent', exact: true }).getByRole('radio', { name: /Fake Agent/ })
    await item.waitFor()
    expect(await item.getAttribute('aria-disabled')).toBe('true')
    expect(await item.getAttribute('aria-checked')).toBe('false')
    // Its line says so on the tile; pressed, the reason is said under the row (touch screens have no tooltip).
    expect(await item.textContent()).toContain('仅本机桌面端')
    await item.click({ force: true })
    expect(await item.getAttribute('aria-checked')).toBe('false')
    await page.locator('.harness-choice .ui-tile-choice-reason', { hasText: '仅本机桌面端' }).waitFor()
    await page.screenshot({ path: `${OUTPUT}/harness-picker-desktop.png`, animations: 'disabled' })
  })

  const policy = () => testHost.host.security.policy.get()

  it('lets an admin browser lower the ceilings in 设置 › 电脑 but never raise them', async () => {
    expect(policy().local).toEqual({ maxLevel: 'L2', allowL3: true })
    expect(policy().remote).toMatchObject({ maxLevel: 'L1', allowRemoteStart: true })
    const settings = await openSettings(page)
    await openSection(settings, '电脑')
    const raiseHere = '只能在这台电脑的 Latch 桌面端调高'

    // Lowering applies at once from any admin device: 完全访问 → 逐项询问 writes both local fields in one change.
    const menu = (name: string) => page.getByRole('menu', { name: new RegExp(`^${name}：`) })
    await settings.getByRole('button', { name: '在这台电脑上发起：完全访问', exact: true }).click()
    await menu('在这台电脑上发起')
      .getByRole('menuitemradio', { name: /^逐项询问/ })
      .click()
    await expect.poll(() => policy().local).toEqual({ maxLevel: 'L1', allowL3: false })
    await settings.getByRole('button', { name: '在这台电脑上发起：逐项询问', exact: true }).waitFor()
    await settings.getByRole('button', { name: '从手机和其他电脑发起：逐项询问', exact: true }).click()
    await menu('从手机和其他电脑发起')
      .getByRole('menuitemradio', { name: /^只读/ })
      .click()
    await expect.poll(() => policy().remote.maxLevel).toBe('L0')

    // Raising is not offered in a browser: every higher step says why before anything is sent.
    await settings.getByRole('button', { name: '从手机和其他电脑发起：只读', exact: true }).click()
    // An item's name is its title and its 默认 badge.
    for (const level of ['逐项询问', '自动编辑']) {
      const item = menu('从手机和其他电脑发起').getByRole('menuitemradio', { name: new RegExp(`^${level}`) })
      expect(await item.getAttribute('aria-disabled')).toBe('true')
      expect(await item.textContent()).toContain(raiseHere)
    }
    const full = menu('从手机和其他电脑发起').getByRole('menuitemradio', { name: /^完全访问/ })
    expect(await full.textContent()).toContain('完全访问会话只能在这台电脑的 Latch 桌面端发起')
    await full.click({ force: true })
    await page.keyboard.press('Escape')
    await settings.getByRole('button', { name: '在这台电脑上发起：逐项询问', exact: true }).click()
    expect(
      await menu('在这台电脑上发起')
        .getByRole('menuitemradio', { name: /^完全访问/ })
        .textContent(),
    ).toContain(raiseHere)
    await page.keyboard.press('Escape')

    // Turning remote starts off is a lowering; turning it back on is locked here.
    const remoteStart = settings.getByRole('switch', { name: '允许其他设备在这里新建会话', exact: true })
    await remoteStart.click()
    await expect.poll(() => policy().remote.allowRemoteStart).toBe(false)
    await expect.poll(() => remoteStart.getAttribute('aria-disabled')).toBe('true')
    await settings.getByText('只能在这台电脑的 Latch 桌面端开启', { exact: true }).waitFor()
    await page.screenshot({ path: `${OUTPUT}/ceilings-browser.png`, animations: 'disabled' })

    // The Host refuses a raise from a browser whatever the page shows; nothing changed.
    const refused = await page.evaluate(async () => {
      const response = await fetch('/link/api/policy', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ remote: { maxLevel: 'L1' } }),
      })
      return { status: response.status, body: await response.text() }
    })
    expect(refused.status).toBe(403)
    expect(refused.body).toContain('"error":"local-only"')
    expect(policy().local).toEqual({ maxLevel: 'L1', allowL3: false })
    expect(policy().remote).toMatchObject({ maxLevel: 'L0', allowRemoteStart: false })
    await closeSettings(settings)
  })
})
