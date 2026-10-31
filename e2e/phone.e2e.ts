import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TestDevice } from '@latch/testkit'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, reachable } from './helpers/layout.ts'
import { motions, tokens } from './helpers/motion.ts'

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
    return { context, page }
  }

  it('opens on the session list and pushes a session over it, then slides back to it', async () => {
    const { context, page } = await phone('no-preference', '动效手机')
    try {
      const list = page.locator('#session-navigation')
      await list.locator(`[data-task-id="${sessions[0]}"]`).waitFor()
      // The list is the page: its header, the pills and the waiting card, and no drawer anywhere.
      for (const name of ['设置', '搜索会话', '新建会话']) await reachable(list.getByRole('button', { name, exact: true }))
      await reachable(list.locator('.phone-inbox'))
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

      // The header is on the ground and the conversation is paper under it, rounded 16 at the top.
      const header = page.locator('.topbar[data-phone]')
      await reachable(header.getByRole('button', { name: '返回会话列表', exact: true }))
      await reachable(header.getByRole('button', { name: '会话信息', exact: true }))
      await reachable(header.locator('.topbar-title-button'))
      const paper = await page.locator('.workspace-body').evaluate(element => {
        const style = getComputedStyle(element)
        return { top: style.borderTopLeftRadius, background: style.backgroundColor }
      })
      expect(paper.top).toBe('16px')
      expect(await page.locator('main.workspace').evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(paper.background)
      // The input floats in the paper as one row, 52 high at rest, with send at its end.
      const composer = page.locator('.composer-dock form.composer')
      expect(await composer.locator('.composer-toolbar').count()).toBe(0)
      const row = await composer.evaluate(form => {
        const box = form.getBoundingClientRect()
        const send = form.querySelector('.send-button')!.getBoundingClientRect()
        const input = form.querySelector('textarea')!.getBoundingClientRect()
        return { height: box.height, sendInside: send.top >= input.top && send.bottom <= input.bottom, sendAfter: send.left >= input.right }
      })
      expect(row).toEqual({ height: 52, sendInside: true, sendAfter: true })

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

  it('starts a session from the sheet over the list and pushes its page', async () => {
    const { context, page } = await phone('no-preference', '新建手机')
    try {
      await page.locator('.phone-list-head').getByRole('button', { name: '新建会话', exact: true }).click()
      const sheet = page.getByRole('dialog', { name: '新会话', exact: true })
      await sheet.waitFor()
      await settled(page)
      // The sheet opens high (92% of the window) with focus on the chosen harness, so the keyboard stays down.
      expect(await page.locator('.new-session-sheet').getAttribute('data-detent')).toBe('large')
      const surface = page.locator('.new-session-sheet > .ui-sheet-surface')
      const standing = Math.round(844 * 0.92)
      expect(Math.round((await surface.boundingBox())!.height)).toBe(standing)
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.getAttribute('role') === 'radio' && document.activeElement.textContent))
        .toMatch(/^Latch 内置/)
      // Unadded agents are offered in place, with a reason and where to add one on this device.
      await sheet.getByRole('button', { name: /^添加 Agent/ }).click()
      const adder = page.getByRole('dialog', { name: '添加 Agent', exact: true })
      await adder.getByRole('button', { name: /^Codex/ }).click()
      await adder.getByText('在运行 Latch 的电脑上添加：设置 › Agent 成员', { exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await adder.waitFor({ state: 'hidden' })
      expect(Math.round((await surface.boundingBox())!.height)).toBe(standing)
      // A chat reads and writes no files, so it has no project.
      const projectRow = sheet.locator('.new-sheet-card').getByRole('button', { name: /^项目：/ })
      await projectRow.waitFor()
      await sheet
        .getByRole('radiogroup', { name: 'Agent', exact: true })
        .getByRole('radio', { name: /^Latch 内置\s*只对话$/ })
        .click()
      await projectRow.waitFor({ state: 'detached' })
      await sheet
        .getByRole('radiogroup', { name: 'Agent', exact: true })
        .getByRole('radio', { name: /^Latch 内置\s*Agent$/ })
        .click()
      await projectRow.waitFor()
      const start = sheet.getByRole('button', { name: '开始', exact: true })
      expect(await start.getAttribute('aria-disabled')).toBe('true')
      await sheet.getByRole('textbox', { name: '新会话消息', exact: true }).fill('展示流式输出')
      await expect.poll(() => start.getAttribute('aria-disabled')).toBeNull()
      // 取消 keeps what was typed for the next time the sheet opens.
      await sheet.getByRole('button', { name: '取消', exact: true }).click()
      await sheet.waitFor({ state: 'hidden' })
      await page.locator('.phone-list-head').getByRole('button', { name: '新建会话', exact: true }).click()
      await sheet.waitFor()
      await settled(page)
      expect(await sheet.getByRole('textbox', { name: '新会话消息', exact: true }).inputValue()).toBe('展示流式输出')
      await start.click()
      await page.locator('main.workspace[data-pushed]').waitFor()
      await sheet.waitFor({ state: 'hidden' })
      await page.locator('.topbar[data-phone] .topbar-title-text', { hasText: '展示流式输出' }).waitFor()
      // The sheet's opener is on the covered list, so focus goes to the new page's way back.
      await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('返回会话列表')
    } finally {
      await context.close()
    }
  })

  it('keeps each management link in its own picker and opens its settings page', async () => {
    const { context, page } = await phone('no-preference', '管理手机', true)
    try {
      await page.locator('.phone-list-head').getByRole('button', { name: '新建会话', exact: true }).click()
      const sheet = page.getByRole('dialog', { name: '新会话', exact: true })
      await sheet.waitFor()
      for (const [label, link, other] of [
        ['项目', '管理项目…', '管理模型服务…'],
        ['模型', '管理模型服务…', '管理项目…'],
      ]) {
        await sheet
          .locator('.new-sheet-card')
          .getByRole('button', { name: new RegExp(`^${label}：`) })
          .click()
        const picker = page.getByRole('dialog', { name: label, exact: true })
        await reachable(picker.getByRole('button', { name: link, exact: true }))
        expect(await picker.getByRole('button', { name: other, exact: true }).count()).toBe(0)
        if (label === '模型') {
          await picker.getByRole('button', { name: link, exact: true }).click()
          await sheet.waitFor({ state: 'hidden' })
          await page
            .getByRole('dialog', { name: '设置', exact: true })
            .getByRole('heading', { name: '模型服务', exact: true, level: 2 })
            .waitFor()
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

      // 会话信息, a page over the session: back returns to the conversation. Its pickers show their arrow at rest, as a
      // touch screen has no pointer to rest on them.
      await header.getByRole('button', { name: '会话信息', exact: true }).click()
      const info = page.getByRole('region', { name: '会话信息', exact: true })
      await info.locator('.inspector').waitFor()
      const model = info.getByRole('button', { name: /^模型：/ })
      await reachable(model)
      expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true)
      await expect.poll(() => model.locator('.ui-value-picker-chevron').evaluate(arrow => getComputedStyle(arrow).opacity)).toBe('1')
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

      // The same holds for a sheet over the list: back closes it, and the list stays.
      await page.locator('.phone-list-head').getByRole('button', { name: '新建会话', exact: true }).click()
      const sheet = page.getByRole('dialog', { name: '新会话', exact: true })
      await sheet.waitFor()
      await page.goBack()
      await sheet.waitFor({ state: 'hidden' })
      expect(page.url()).toBe(url)
      await reachable(list.locator('.phone-list-head').getByRole('button', { name: '新建会话', exact: true }))
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
      // The menu is the design system's sheet, on the ground with 取消.
      await page.getByRole('dialog', { name: title, exact: true }).getByRole('button', { name: '取消', exact: true }).click()
      await menu.waitFor({ state: 'hidden' })
      await expect.poll(() => row.getAttribute('class')).not.toMatch(/\bis-held\b/)
      // Search folds away with 取消 and gives focus back to the button that opened it.
      const search = page.locator('.phone-list-head').getByRole('button', { name: '搜索会话', exact: true })
      await search.click()
      await page.getByRole('searchbox', { name: '搜索会话', exact: true }).waitFor()
      await page.locator('.phone-search').getByRole('button', { name: '取消', exact: true }).click()
      await expect.poll(() => search.evaluate(button => button === document.activeElement)).toBe(true)
      // A tap that does not rest opens the session.
      await row.click()
      await page.locator('main.workspace').waitFor()
    } finally {
      await context.close()
    }
  })
})
