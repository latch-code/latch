import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentSettings, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { type TestDevice, FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
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
    testHost = await startTestHost({ demo: true, uiDir: resolve(process.env.HARNESS_E2E_UI_DIR ?? 'dist/web'), plugins: [highRiskFixture] })
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
    await card.getByText('高风险', { exact: true }).waitFor()
    await card.getByText('高风险操作只能在执行端电脑上用 Latch 桌面端批准', { exact: true }).waitFor()
    expect(await card.getByRole('button', { name: /允许/ }).count()).toBe(0)
    await page.screenshot({ path: `${OUTPUT}/r2-browser-desktop.png`, fullPage: true, animations: 'disabled' })
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
    await card.waitFor({ state: 'detached' })
  })

  it('keeps an approval card as it is under styles added to the page', async () => {
    const { sessionId } = await remote.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '再写入一次标记', requestId: randomUUID(), mode: 'agent', model: { providerId: 'r2-model', model: 'fixture' } },
    })
    await expect.poll(async () => (await detail(sessionId)).approvals.length).toBe(1)
    await open(sessionId)
    const card = '[data-approval-id]'
    await page.locator(card).getByText('高风险', { exact: true }).waitFor()
    await expectUnmovedByInjectedStyles(page, [
      card,
      `${card} .tool-card-header`,
      `${card} .tool-card-title`,
      `${card} .tool-card-header .ui-status-pill`,
      `${card} .approval-panel`,
      `${card} .approval-meta`,
      `${card} .approval-preview .muted-line`,
      `${card} .approval-hint`,
      `${card} .ui-button`,
    ])
    await page.locator(card).getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
  })

  it('brings an approval card in and folds it away with the motion tokens, and only fades under reduced motion', async () => {
    const quiet = await startHighRisk('先看这一个')
    const arriving = await startHighRisk('看它到达')
    await open(quiet)
    const card = page.locator('[data-approval-id]')
    await card.getByText('高风险', { exact: true }).waitFor()
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
        fast: ms('--d-fast'),
        base: ms('--d-base'),
        ease: computed('transitionTimingFunction', '--ease'),
        exit: computed('transitionTimingFunction', '--ease-exit'),
      }
      probe.remove()
      return result
    })
    expect(tokens).toEqual({ fast: 120, base: 180, ease: 'cubic-bezier(0.2, 0, 0, 1)', exit: 'cubic-bezier(0.4, 0, 1, 1)' })

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
            duration: Number(animation.effect!.getTiming().duration),
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

    // Arrival: the card fades in over 180ms on the entry curve and does not grow, so nothing above it moves.
    await hold()
    await open(arriving)
    expect(await held()).toEqual([{ property: 'opacity', duration: tokens.base, easing: tokens.ease }])
    await frames('arrival', card)

    // Settled: the slot folds by its height over 180ms while its content fades over 120ms, both on the exit curve. The
    // folding copy stays until those transitions end, so the held frames show it.
    await hold()
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    await page.locator('.approval-slot[data-leaving]').waitFor()
    expect(await held()).toEqual([
      { property: 'grid-template-rows', duration: tokens.base, easing: tokens.exit },
      { property: 'opacity', duration: tokens.fast, easing: tokens.exit },
    ])
    await frames('settle', page.locator('.tool-card', { has: page.locator('.approval-slot') }))
    await page.locator('.approval-slot').waitFor({ state: 'detached' })
    await expect.poll(async () => (await detail(arriving)).summary.status).toBe('idle')

    // The preview's disclosure opens over 180ms on the entry curve and folds over 120ms on the exit curve.
    await open(quiet)
    await card.getByText('高风险', { exact: true }).waitFor()
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
      folded: `grid-template-rows ${tokens.fast / 1000}s ${tokens.exit}`,
      open: `grid-template-rows ${tokens.base / 1000}s ${tokens.ease}`,
    })

    // Reduced motion: no slide or growth, every transition here as good as instant.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reduced = await page.evaluate(() =>
      ['.approval-slot', '.approval-preview'].map(
        selector => getComputedStyle(document.querySelector(`[data-approval-id] ${selector}`)!).transitionDuration,
      ),
    )
    expect(reduced.every(value => value.split(', ').every(part => parseFloat(part) <= 0.001))).toBe(true)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(async () => (await detail(quiet)).summary.status).toBe('idle')
    await card.waitFor({ state: 'detached' })
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
    await card.getByText('只有执行端电脑上的 Latch 桌面端可以回应完全访问会话的询问', { exact: true }).waitFor()
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
    await page.getByRole('button', { name: /^Harness：/ }).click()
    const item = page.getByRole('menuitemradio', { name: /Fake Agent/ })
    await item.waitFor()
    expect(await item.isDisabled()).toBe(true)
    expect(await item.getAttribute('title')).toBe('仅本机桌面端')
    await page.screenshot({ path: `${OUTPUT}/harness-picker-desktop.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
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
