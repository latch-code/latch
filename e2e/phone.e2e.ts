import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import type { HarnessPlugin } from '@latch/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TestDevice } from '@latch/testkit'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession, reachable } from './helpers/layout.ts'
import { motions, tokens } from './helpers/motion.ts'
import { homeInput, openHomeDecision, switchLayout, returnFromHomeFocus } from './helpers/workbench.ts'

/**
 * A phone stacks its pages: the session list is the root, a session's page is pushed over it and slides back, and a new
 * session is a sheet over the list. The motion takes its durations and curves from the tokens.
 */

/** Waits until nothing on the page is moving but the live indicators, which keep turning by design. */
const settled = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity),
  )

describe('the phone stack', () => {
  let fixture: TestHost
  let browser: Browser
  let local: TestDevice
  const sessions: string[] = []

  beforeAll(async () => {
    fixture = await startTestHost({ demo: true, uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
    browser = await chromium.launch(browserLaunchOptions())
    local = await fixture.enroll({ listener: 'unix', name: '本机桌面端' })
    for (const prompt of ['展示流式输出', '批准生成验收报告']) {
      const { sessionId } = await local.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt, requestId: randomUUID(), mode: 'agent' },
      })
      sessions.push(sessionId)
    }
    // The streamed demo reply settles on its own.
    for (let tries = 0; (await fixture.host.bridge.detail(sessions[0])).summary.status !== 'idle'; tries++) {
      if (tries > 200) throw new Error('The demo reply did not settle')
      await new Promise(done => setTimeout(done, 100))
    }
  })

  afterAll(async () => {
    await browser?.close()
    await fixture?.close()
  })

  async function phone(
    reducedMotion: 'reduce' | 'no-preference',
    name: string,
    admin = false,
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      reducedMotion,
    })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    await enrollBrowser(page, fixture, { name, ...(admin ? { scopes: ['admin'] } : {}) })
    await page.locator('.workbench-home').waitFor()
    await page.getByRole('button', { name: '全部会话', exact: true }).click()
    await page.locator('.phone-list:not([inert])').waitFor()
    return { context, page }
  }

  for (const layout of ['overview', 'triage'] as const)
    for (const width of [320, 390])
      it(`${layout} ${width}: Code returns Home and history stays an explicit entry, preserving its draft`, async () => {
        const { context, page } = await phone('reduce', `首页返回 ${layout} ${width}`)
        try {
          await page.setViewportSize({ width, height: 844 })
          if (layout === 'triage') await switchLayout(page, 'triage')
          await page.locator('.phone-tabs').getByRole('button', { name: 'Code', exact: true }).click()
          const home = page.locator('.workbench-home')
          await home.waitFor()
          const input = home.getByRole('textbox', { name: '新会话消息', exact: true })
          await input.fill('首页尚未发送的草稿')
          await returnFromHomeFocus(page)
          const before = (await local.json<{ tasks: unknown[] }>('snapshot')).tasks.length
          await openHomeDecision(page, sessions[1]!)
          await page.locator('main.workspace:not([inert]) .transcript-content').waitFor()
          await settled(page)
          await expect
            .poll(() =>
              page.locator('.phone-list').evaluate(element => ({
                inert: element instanceof HTMLElement && element.inert,
                overview: document.querySelector('.app-shell')?.hasAttribute('data-overview'),
                leaving: document.querySelector('main.workspace')?.hasAttribute('data-leaving'),
              })),
            )
            .toEqual({ inert: true, overview: false, leaving: false })
          await page.locator('.topbar[data-phone]').getByRole('button', { name: '返回总览', exact: true }).click()
          await home.waitFor()
          expect(await input.inputValue()).toBe('首页尚未发送的草稿')
          expect(await page.locator('main.workspace').getAttribute('inert')).not.toBeNull()
          await home.getByRole('button', { name: '全部会话', exact: true }).click()
          const list = page.locator('.phone-list:not([inert])')
          await list.locator(`[data-task-id="${sessions[0]}"]`).click()
          await page.locator('main.workspace:not([inert]) .transcript-content').waitFor()
          await page.getByRole('button', { name: '返回会话列表', exact: true }).click()
          await list.waitFor()
          await reachable(list.getByRole('searchbox', { name: '搜索会话', exact: true }))
          await page.locator('.phone-tabs').getByRole('button', { name: 'Code', exact: true }).click()
          await home.waitFor()
          expect(await input.inputValue()).toBe('首页尚未发送的草稿')
          expect((await local.json<{ tasks: unknown[] }>('snapshot')).tasks.length).toBe(before)
          await noHorizontalOverflow(page)
          await page.screenshot({ path: `test-results/phone-home-${layout}-${width}.png`, animations: 'disabled' })
        } finally {
          await context.close()
        }
      })

  it('opens the session list from Home and pushes a session over it, then slides back to it', async () => {
    const { context, page } = await phone('no-preference', '动效手机')
    try {
      const list = page.locator('#session-navigation')
      await list.locator(`[data-task-id="${sessions[0]}"]`).waitFor()
      // The list is the page: its header, its search and what waits first, and no drawer anywhere.
      await reachable(list.getByRole('button', { name: '新建会话', exact: true }))
      await reachable(list.getByRole('searchbox', { name: '搜索会话', exact: true }))
      await reachable(list.locator('.phone-group[data-shelf="waiting"]').locator('[data-task-id]').first())
      await reachable(page.locator('.phone-tabs').getByRole('button', { name: '设置', exact: true }))
      expect(await page.locator('.sidebar, .drawer-backdrop, main.workspace').count()).toBe(0)
      await noHorizontalOverflow(page)

      const token = await tokens(page)
      // The page slides in from the right over --m-push while the list beneath moves a quarter to the left and dims.
      const push = await motions(page, () => list.locator(`[data-task-id="${sessions[0]}"]`).click())
      expect(push).toContainEqual({
        kind: 'animation',
        target: 'workspace has-task',
        name: 'page-in',
        duration: token.push,
        easing: token.ePush,
      })
      expect(push).toContainEqual({
        kind: 'transition',
        target: 'phone-list',
        name: 'translate',
        duration: token.push,
        easing: token.ePush,
      })
      await page.locator('main.workspace[data-pushed]').waitFor()
      expect(await list.evaluate(element => getComputedStyle(element).translate)).toMatch(/^-24%/)
      expect(await list.evaluate(element => element instanceof HTMLElement && element.inert)).toBe(true)
      // The covered list cannot hold focus: the page takes it at its way back.
      await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('返回会话列表')
      await page.locator('.transcript-content').waitFor()

      // The header and the conversation share one canvas.
      const header = page.locator('.topbar[data-phone]')
      // A 44px touch target, 8px padding on each side, and the 1px divider.
      expect((await header.boundingBox())!.height).toBe(61)
      await reachable(header.getByRole('button', { name: '返回会话列表', exact: true }))
      await reachable(header.getByRole('button', { name: '侧边面板', exact: true }))
      await reachable(header.locator('.topbar-title-button'))
      // The four controls are one row of chips over the input's line (＋, the text, send); the row scrolls sideways by
      // itself, and nothing of them is left outside the frame.
      const composer = page.locator('.composer-dock form.composer')
      expect(await composer.locator('.composer-toolbar, [data-rows], .composer-prompt').count()).toBe(0)
      expect(await composer.getByRole('button', { name: '／', exact: true }).count()).toBe(0)
      expect(
        await page.locator('.composer-dock [data-composer-control]').evaluateAll(nodes => nodes.every(node => node.closest('form'))),
      ).toBe(true)
      const chips = composer.getByRole('group', { name: '会话选项', exact: true })
      expect(await chips.evaluate(element => element.classList.contains('composer-chips'))).toBe(true)
      const rows = await composer.evaluate(form => {
        const box = (selector: string) => form.querySelector(selector)?.getBoundingClientRect()
        const control = (name: string) => box(`.composer-chips [data-composer-control="${name}"]`)
        const [input, harness, model, thinking, permission, send, add, line, row] = [
          box('.composer-line textarea'),
          control('harness'),
          control('model'),
          control('thinking'),
          control('permission'),
          box('.composer-line .send-button'),
          box('.composer-line .attachment-button, .composer-line button'),
          box('.composer-line'),
          box('.composer-chips'),
        ]
        const frame = form.getBoundingClientRect()
        const level = (a?: DOMRect, b?: DOMRect) => !!a && !!b && Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < 2
        const scroller = form.querySelector('.composer-chips')!
        return {
          found: [input, harness, model, thinking, permission, send, add, line, row].every(Boolean),
          oneRow: level(harness, model) && level(model, thinking) && level(thinking, permission),
          inOrder: harness!.right <= model!.left + 1 && model!.right <= thinking!.left + 1 && thinking!.right <= permission!.left + 1,
          chipsOverLine: row!.bottom <= line!.top + 1,
          line: add!.right <= input!.left + 1 && input!.right <= send!.left + 1,
          sendAtEnd: frame.right - send!.right < 16,
          scrolls: /auto|scroll/u.test(getComputedStyle(scroller).overflowX),
          inside: row!.left >= frame.left && row!.right <= frame.right && send!.right <= frame.right,
        }
      })
      expect(rows).toEqual({
        found: true,
        oneRow: true,
        inOrder: true,
        chipsOverLine: true,
        line: true,
        sendAtEnd: true,
        scrolls: true,
        inside: true,
      })
      expect(await composer.locator('.composer-line .send-button').getAttribute('aria-label')).toBe('发送')
      // The send key is neutral ink, never the blue of what runs.
      expect(
        await composer.locator('.composer-line .send-button').evaluate(element => {
          const probe = document.createElement('i')
          probe.style.color = 'var(--blue)'
          document.body.append(probe)
          const blue = getComputedStyle(probe).color
          probe.remove()
          return getComputedStyle(element).backgroundColor !== blue
        }),
      ).toBe(true)
      // The Harness's name is never what gives way.
      const harness = composer.locator('[data-composer-control="harness"] .chip-text')
      expect(await harness.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await noHorizontalOverflow(page)

      // Back: the page slides away in 70% of the time on the exit curve, the list returns and focus lands on the row it
      // opened.
      const pop = await motions(page, () => header.getByRole('button', { name: '返回会话列表', exact: true }).click())
      expect(pop).toContainEqual({
        kind: 'animation',
        target: 'workspace has-task',
        name: 'page-out',
        duration: token.pushExit,
        easing: token.exit,
      })
      expect(pop).toContainEqual({
        kind: 'transition',
        target: 'phone-list',
        name: 'translate',
        duration: token.pushExit,
        easing: token.exit,
      })
      await page.locator('main.workspace').waitFor({ state: 'detached' })
      expect(await list.evaluate(element => element instanceof HTMLElement && element.inert)).toBe(false)
      await expect
        .poll(() =>
          page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.taskId : undefined)),
        )
        .toBe(sessions[0])
      await expect.poll(() => list.evaluate(element => getComputedStyle(element).translate)).toBe('none')
    } finally {
      await context.close()
    }
  })

  it('cross-fades the pushed page under reduced motion, with nothing moving', async () => {
    const { context, page } = await phone('reduce', '静止手机')
    try {
      const list = page.locator('#session-navigation')
      const token = await tokens(page)
      const push = await motions(page, () => list.locator(`[data-task-id="${sessions[0]}"]`).click())
      await page.locator('main.workspace[data-pushed]').waitFor()
      expect(push).toContainEqual({
        kind: 'animation',
        target: 'workspace has-task',
        name: 'fade-in',
        duration: token.micro,
        easing: token.eMicro,
      })
      // Nothing slides: neither the page nor the list beneath it.
      expect(push.filter(motion => /^(page-in|translate|transform)$/u.test(motion.name))).toEqual([])
      expect(await list.evaluate(element => getComputedStyle(element).translate)).toBe('none')
      const pop = await motions(page, () => page.locator('.topbar').getByRole('button', { name: '返回会话列表', exact: true }).click())
      await page.locator('main.workspace').waitFor({ state: 'detached' })
      expect(pop.filter(motion => /^(page-out|translate|transform)$/u.test(motion.name))).toEqual([])
    } finally {
      await context.close()
    }
  })

  it('starts a session from the home input, which 新建会话 on the list leads to, and pushes its page', async () => {
    const { context, page } = await phone('no-preference', '新建手机')
    try {
      const home = page.locator('.workbench-home')
      const input = homeInput(page)
      // 新建会话 is the home with its input focused: no sheet, no form of rows.
      await page.locator('.phone-list-head').getByRole('button', { name: '新建会话', exact: true }).click()
      await home.waitFor()
      await settled(page)
      await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await page.getByRole('dialog', { name: '新会话', exact: true }).count()).toBe(0)
      expect(await page.locator('.new-session-sheet, .new-sheet-card, .new-session').count()).toBe(0)
      expect(await page.getByRole('button', { name: '新会话选项', exact: true }).count()).toBe(0)
      // What the message goes with is the row of chips over the input: the project first, then the four controls.
      const chips = home.getByRole('group', { name: '会话选项', exact: true })
      await reachable(chips.locator('.home-composer-location').getByRole('button').first())
      expect(await chips.locator('.home-composer-location').innerText()).not.toContain('选择项目')
      // Another device runs on the built-in engine alone: the Harness chip holds nothing else.
      expect(await chips.getByText('Codex').count()).toBe(0)
      const send = home.locator('.composer-line').getByRole('button', { name: '发送', exact: true })
      expect(await send.getAttribute('aria-disabled')).toBe('true')
      await input.fill('展示流式输出')
      await expect.poll(() => send.getAttribute('aria-disabled')).toBeNull()
      // Leaving for the list keeps what was typed for the next time 新建会话 leads here; typing put Home in focus first.
      await returnFromHomeFocus(page)
      await home.getByRole('button', { name: '全部会话', exact: true }).click()
      await page.locator('.phone-list:not([inert])').waitFor()
      await page.locator('.phone-list-head').getByRole('button', { name: '新建会话', exact: true }).click()
      await home.waitFor()
      await settled(page)
      expect(await input.inputValue()).toBe('展示流式输出')
      await noHorizontalOverflow(page)
      await send.click()
      await page.locator('main.workspace[data-pushed]').waitFor()
      await page.locator('.topbar[data-phone] .topbar-title-text', { hasText: '展示流式输出' }).waitFor()
      // The home is covered, so focus goes to the new page's way back.
      await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toMatch(/^返回(?:总览|会话列表)$/u)
    } finally {
      await context.close()
    }
  })

  it('keeps each management link in its own picker and opens its settings page', async () => {
    const { context, page } = await phone('no-preference', '管理手机', true)
    try {
      await page.locator('.phone-list-head').getByRole('button', { name: '新建会话', exact: true }).click()
      const home = page.locator('.workbench-home')
      await home.waitFor()
      const chips = home.getByRole('group', { name: '会话选项', exact: true })
      for (const [label, link, other] of [
        ['项目', '管理项目…', '管理模型…'],
        ['模型', '管理模型…', '管理项目…'],
      ]) {
        // Each chip opens its own bottom sheet.
        await (
          label === '项目'
            ? chips.locator('.home-composer-location').getByRole('button').first()
            : chips.locator('[data-composer-control="model"]').getByRole('button').first()
        ).click()
        const picker = page.getByRole('dialog', { name: label, exact: true })
        await reachable(picker.getByRole('button', { name: link, exact: true }))
        expect(await picker.getByRole('button', { name: other, exact: true }).count()).toBe(0)
        if (label === '模型') {
          await picker.getByRole('button', { name: link, exact: true }).click()
          await page.locator('.settings-page').getByRole('heading', { name: '模型', exact: true, level: 2 }).waitFor()
        } else {
          await page.keyboard.press('Escape')
          await picker.waitFor({ state: 'hidden' })
        }
      }
    } finally {
      await context.close()
    }
  })

  it("closes the top page or sheet with the platform's back, and lands on the list with focus on the row", async () => {
    const { context, page } = await phone('no-preference', '返回手机')
    try {
      const list = page.locator('#session-navigation')
      const row = list.locator(`[data-task-id="${sessions[0]}"]`)
      await row.click()
      await page.locator('main.workspace[data-pushed]').waitFor()
      await page.locator('.transcript-content').waitFor()
      const header = page.locator('.topbar[data-phone]')
      const url = page.url()

      // The title's menu, a sheet over the session: back closes it and the session stays.
      await header.locator('.topbar-title-button').click()
      const menu = page.getByRole('menu', { name: /^会话：/ })
      await menu.waitFor()
      await page.goBack()
      await menu.waitFor({ state: 'hidden' })
      expect(await page.locator('main.workspace').count()).toBe(1)

      // The panel, a page over the session: back returns to the conversation. Touch has no keys to name, so its rows name none.
      await header.getByRole('button', { name: '侧边面板', exact: true }).click()
      const info = page.getByRole('region', { name: '侧边面板', exact: true })
      await info.getByRole('tabpanel', { name: '会话概要', exact: true }).waitFor()
      await reachable(info.getByRole('tab', { name: '概要', exact: true }))
      // A connected browser reads project files: a session without changes says so in one line, with no heading.
      await info.locator('.session-overview').waitFor()
      expect(await info.locator('.ui-kbd').filter({ visible: true }).count()).toBe(0)
      await page.goBack()
      await info.waitFor({ state: 'detached' })
      expect(await page.locator('main.workspace').count()).toBe(1)

      // A reload keeps the session and adds no entry; back then returns to the list, focus on the session's row.
      const entries = await page.evaluate(() => history.length)
      await page.reload()
      await page.locator('.transcript-content').waitFor()
      expect(await page.evaluate(() => history.length)).toBe(entries)
      await page.goBack()
      await page.locator('main.workspace').waitFor({ state: 'detached' })
      await page.locator('.phone-list:not([data-covered])').waitFor()
      await expect
        .poll(() =>
          page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.taskId : undefined)),
        )
        .toBe(sessions[0])
      // Latch never left the page: every entry it pushed has the same address.
      expect(page.url()).toBe(url)

      // The same holds for a sheet over the home's input: back closes it, and the home stays.
      await page.locator('.phone-list-head').getByRole('button', { name: '新建会话', exact: true }).click()
      const home = page.locator('.workbench-home')
      await home.waitFor()
      await home.locator('.composer-chips .home-composer-location').getByRole('button').first().click()
      const sheet = page.getByRole('dialog', { name: '项目', exact: true })
      await sheet.waitFor()
      await page.goBack()
      await sheet.waitFor({ state: 'hidden' })
      expect(page.url()).toBe(url)
      await reachable(homeInput(page))
    } finally {
      await context.close()
    }
  })

  it('cancels leaving an unsaved file without leaving the conversation in its exit state', async () => {
    const provider: HarnessPlugin = {
      id: 'phone-edit-return',
      name: 'Fixture',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'phone-edit-return',
          name: 'Fixture',
          model: 'fixture',
          async *stream() {
            yield { type: 'text', text: '文件：[phone-return.txt](phone-return.txt)' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const host = await startTestHost({ demo: false, plugins: [provider] })
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: 'zh-CN',
      reducedMotion: 'no-preference',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      const file = join(host.workspaceRoot, 'phone-return.txt')
      await writeFile(file, 'saved\n')
      const { sessionId } = await host.host.bridge.createTask({
        prompt: '编辑后返回',
        requestId: randomUUID(),
        mode: 'agent',
        model: { providerId: provider.id, model: 'fixture' },
      })
      await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status).toBe('idle')
      await enrollBrowser(page, host, { name: '编辑返回手机', scopes: ['admin'] })
      const owner = await host.enroll({ listener: 'unix' })
      const deviceId = host.host.security.devices.list().find(device => device.name === '编辑返回手机')!.id
      expect((await owner.confirmed(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await page.reload()
      await openSession(page, sessionId)
      await page.locator('.transcript').getByRole('button', { name: '预览文件：phone-return.txt', exact: true }).click()
      const preview = page.getByRole('region', { name: '文件预览', exact: true })
      await preview.getByRole('button', { name: '编辑', exact: true }).click()
      const editor = page.getByRole('region', { name: '编辑 phone-return.txt', exact: true })
      const area = editor.getByLabel('phone-return.txt 的内容', { exact: true })
      await area.fill('unsaved phone edit\n')
      // Rotate to the tablet layout to change tabs without discarding the edit, then return to the portrait conversation.
      await page.setViewportSize({ width: 844, height: 390 })
      await page.locator('.info-page').waitFor({ state: 'detached' })
      await page.locator('.inspector-column').getByRole('tab', { name: '文件', exact: true }).click()
      await editor.waitFor({ state: 'detached' })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.locator('.info-page-head').getByRole('button', { name: '返回', exact: true }).click()
      await page.locator('.info-page').waitFor({ state: 'detached' })
      await page.locator('.topbar[data-phone]').getByRole('button', { name: '返回会话列表', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: '放弃你的修改？', exact: true })
      await confirm.getByRole('button', { name: '取消', exact: true }).click()
      await confirm.waitFor({ state: 'hidden' })
      const conversation = page.locator('main.workspace')
      await expect.poll(() => conversation.getAttribute('data-leaving')).toBeNull()
      await reachable(page.locator('.topbar[data-phone]').getByRole('button', { name: '侧边面板', exact: true }))
      await page.locator('.topbar[data-phone]').getByRole('button', { name: '侧边面板', exact: true }).click()
      await page.getByRole('tab', { name: /phone-return\.txt/u }).click()
      expect(await area.inputValue()).toBe('unsaved phone edit\n')
      await editor.getByRole('button', { name: '保存', exact: true }).click()
      await preview.getByRole('status').filter({ hasText: '已保存' }).waitFor()
      expect(await readFile(file, 'utf8')).toBe('unsaved phone edit\n')
      await page.locator('.info-page-head').getByRole('button', { name: '返回', exact: true }).click()
      await page.locator('.info-page').waitFor({ state: 'detached' })
      await page.locator('.topbar[data-phone]').getByRole('button', { name: '返回会话列表', exact: true }).click()
      await page.locator('.phone-list:not([inert])').waitFor()
      await reachable(page.locator('.phone-list').locator(`[data-task-id="${sessionId}"]`))
    } finally {
      await context.close()
      await host.close()
    }
  })

  it('keeps a toast above the tab bar and the safe area at every phone width', async () => {
    const { context, page } = await phone('reduce', '提示手机')
    try {
      await page.locator('#session-navigation').waitFor()
      for (const width of [320, 375, 390, 414]) {
        await page.setViewportSize({ width, height: 740 })
        // A new approval in another session raises 另一个会话等你处理 over the list.
        await local.json('tasks', { method: 'POST', body: { prompt: '批准生成验收报告', requestId: randomUUID(), mode: 'agent' } })
        const toast = page.locator('.toast', { hasText: '另一个会话等你处理' })
        await toast.waitFor()
        const bar = (await page.locator('.phone-tabs').boundingBox())!
        await expect
          .poll(async () => {
            const box = (await toast.boundingBox())!
            return box.y + box.height
          })
          .toBeLessThanOrEqual(bar.y)
        await page.screenshot({ path: `test-results/phone-toast--${width}.png` })
      }
    } finally {
      await context.close()
    }
  })

  it("opens a row's menu when the row is held, without opening the session", async () => {
    const { context, page } = await phone('no-preference', '长按手机')
    try {
      const row = page.locator(`#session-navigation [data-task-id="${sessions[0]}"]`)
      await row.waitFor()
      const box = (await row.boundingBox())!
      const at = { clientX: box.x + 40, clientY: box.y + 20, pointerType: 'touch', isPrimary: true, pointerId: 7, bubbles: true }
      await row.dispatchEvent('pointerdown', at)
      await page.waitForTimeout(600)
      await row.dispatchEvent('pointerup', at)
      await row.dispatchEvent('click', at)
      const title = (await fixture.host.bridge.detail(sessions[0])).summary.title
      const menu = page.getByRole('menu', { name: title, exact: true })
      await menu.waitFor()
      for (const name of ['重命名', '置顶', '归档', '导出 Markdown', '删除'])
        await reachable(menu.getByRole('menuitem', { name, exact: true }))
      expect(await page.locator('main.workspace').count()).toBe(0)
      // The row stays pressed while its menu is open; the item that holds focus is not marked after a touch.
      expect(await row.getAttribute('class')).toMatch(/\bis-held\b/)
      await settled(page)
      const first = menu.getByRole('menuitem', { name: '重命名', exact: true })
      await expect.poll(() => first.evaluate(item => item === document.activeElement)).toBe(true)
      expect(await first.evaluate(item => getComputedStyle(item).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
      // The menu is the design system's sheet, on the ground, closed by its one close button.
      await page.getByRole('dialog', { name: title, exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
      await menu.waitFor({ state: 'hidden' })
      await expect.poll(() => row.getAttribute('class')).not.toMatch(/\bis-held\b/)
      // 取消 shows while the search is in use, clears it and leaves the field.
      const search = page.getByRole('searchbox', { name: '搜索会话', exact: true })
      await search.click()
      await page.locator('.phone-search').getByRole('button', { name: '取消', exact: true }).click()
      await page.locator('.phone-search').getByRole('button', { name: '取消', exact: true }).waitFor({ state: 'detached' })
      await expect.poll(() => search.evaluate(input => input === document.activeElement)).toBe(false)
      // A tap that does not rest opens the session.
      await row.click()
      await page.locator('main.workspace').waitFor()
    } finally {
      await context.close()
    }
  })
})
