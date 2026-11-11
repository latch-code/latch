import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { DeviceScope } from '@latch/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openEntry, openSessions, settleShell } from './helpers/layout.ts'

/** The frame of the shell at each width: the title row, the sidebar or the tab bar, and what moving to a page keeps. */
describe('the shell', () => {
  let host: TestHost
  let browser: Browser

  beforeAll(async () => {
    host = await startTestHost({ uiDir: resolve('dist/web') })
    browser = await chromium.launch(browserLaunchOptions())
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  async function open(width: number, height: number, name: string, admin = false): Promise<Page> {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', reducedMotion: 'reduce' })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    await enrollBrowser(page, host, { name, ...(admin ? { scopes: ['admin'] as const satisfies DeviceScope[] } : {}) })
    await connected(page)
    return page
  }
  /** A device whose data scope is everything, which only this computer grants. */
  async function allData(page: Page): Promise<void> {
    const desktop = await host.enroll({ listener: 'unix' })
    const id = await page.evaluate(async () => (await (await fetch('/link/api/snapshot')).json()).device.id as string)
    expect((await desktop.confirmed('devices/' + id, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.reload()
    await connected(page)
  }
  const box = (page: Page, selector: string) =>
    page.locator(selector).evaluate(element => {
      const rect = element.getBoundingClientRect()
      return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
    })

  it('lays out the 52px title row and the sidebar from the window edge, and lands a cold start on the new session', async () => {
    const page = await open(1440, 900, '壳层桌面')
    expect(await box(page, '.titlebar')).toMatchObject({ left: 0, top: 0, width: 1440, height: 52 })
    expect(await box(page, '#session-navigation')).toMatchObject({ left: 0, top: 52, width: 248 })
    expect((await box(page, 'main.workspace')).left).toBe(248)
    // A browser, even over loopback on the Mac, is told which computer it reads; its foot has 设置 alone, with its word.
    const foot = page.getByRole('navigation', { name: '主导航', exact: true })
    expect(await foot.getByRole('button').allTextContents()).toEqual(['设置'])
    const name = page.locator('#session-navigation .sidebar-top > .sidebar-host')
    expect((await name.textContent())?.trim()).not.toBe('')
    expect((await box(page, '.sidebar-host')).top).toBeLessThan((await box(page, '.sidebar-top .sidebar-nav-line')).top)
    expect(await page.locator('main.workspace').getAttribute('class')).toContain('is-new')
    await noHorizontalOverflow(page)
    await page.context().close()
  })

  it('keeps the draft across pages, without a modal, and Esc does nothing on a page', async () => {
    const page = await open(1440, 900, '壳层切换')
    const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
    await input.fill('切换入口时保留的草稿')
    await openEntry(page, '设置')
    expect(await page.locator('dialog[open]').count()).toBe(0)
    await page.locator('.settings-page').waitFor()
    expect(await page.locator('.settings-panel .settings-title').textContent()).toBe('通用')
    await page.keyboard.press('Escape')
    await page.locator('.settings-page').waitFor()
    await openSessions(page)
    expect(await input.inputValue()).toBe('切换入口时保留的草稿')
    await page.context().close()
  })

  it('shuts the sidebar with its toggle, and a page still has its way back', async () => {
    const page = await open(1280, 800, '壳层收起')
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
    await page.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
    await page.getByRole('button', { name: '展开侧栏', exact: true }).waitFor()
    await page.locator('.titlebar').getByRole('button', { name: '新建会话', exact: true }).waitFor()
    expect((await box(page, 'main.workspace')).left).toBe(0)
    await page.keyboard.press('Alt+Comma')
    await page.locator('.settings-page').waitFor()
    await page.locator('.titlebar').getByRole('button', { name: '返回会话', exact: true }).click()
    await page.locator('.settings-page').waitFor({ state: 'detached' })
    await page.context().close()
  })

  it('slides the session list over on tablets, with 设置 at its foot', async () => {
    const page = await open(768, 1024, '壳层平板')
    await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
    const list = page.getByRole('dialog', { name: '会话导航', exact: true })
    await list.waitFor()
    await list.getByRole('button', { name: '关闭会话列表', exact: true }).click()
    await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
    await list.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.settings-page').waitFor()
    expect(await box(page, '.settings-nav-pane')).toMatchObject({ left: 0, width: 200 })
    await openSessions(page)
    await noHorizontalOverflow(page)
    await page.context().close()
  })

  it('gives a phone a tab bar of 会话 and 设置', async () => {
    const page = await open(390, 844, '壳层手机')
    expect(await page.locator('.titlebar').count()).toBe(0)
    const tabs = page.getByRole('navigation', { name: '主导航', exact: true })
    expect(await tabs.getByRole('button').allTextContents()).toEqual(['会话', '设置'])
    const bar = await box(page, '.phone-tabs')
    expect(bar.top + bar.height).toBe(844)
    await tabs.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.settings-page').waitFor()
    await page.getByRole('tab', { name: '通用', exact: true }).click()
    await page.locator('.settings-layout[data-level="section"]').waitFor()
    await page.goBack()
    await page.locator('.settings-layout[data-level="root"]').waitFor()
    await page.context().close()
  })

  it('lists 设备 among the sections of 设置, with or without 管理此 Host', async () => {
    const tabsOf = async (page: Page) => {
      await openEntry(page, '设置')
      return page.locator('.settings-page').getByRole('tab').allTextContents()
    }
    const owner = await open(1440, 900, '壳层分区管理', true)
    await allData(owner)
    expect(await tabsOf(owner)).toEqual(['通用', '模型', 'Harness', '项目', '插件', '设备', '快捷键', '关于'])
    await owner.context().close()
    const guest = await open(1440, 900, '壳层分区只读')
    expect(await tabsOf(guest)).toEqual(['通用', '设备', '快捷键', '关于'])
    await guest.context().close()
  })

  it('has no Agent or 定时任务 entry while neither has a page', async () => {
    const page = await open(1440, 900, '壳层没有空页')
    await allData(page)
    const sidebar = page.locator('#session-navigation')
    expect(await sidebar.getByRole('button', { name: 'Agent', exact: true }).count()).toBe(0)
    expect(await sidebar.getByRole('button', { name: '定时任务', exact: true }).count()).toBe(0)
    await openEntry(page, '设置')
    const settings = page.locator('.settings-page')
    await settings.getByRole('tab', { name: '通用', exact: true }).waitFor()
    expect(await settings.getByRole('tab', { name: 'Agent', exact: true }).count()).toBe(0)
    expect(await settings.getByRole('tab', { name: '定时任务', exact: true }).count()).toBe(0)
    await page.context().close()
  })

  it('goes back within 设置 on a phone', async () => {
    const page = await open(390, 844, '壳层手机返回', true)
    await allData(page)
    const tabs = page.getByRole('navigation', { name: '主导航', exact: true })
    await tabs.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.settings-page[data-entry="settings"] .settings-layout[data-level="root"]').waitFor()
    await page.getByRole('tab', { name: '关于', exact: true }).click()
    await page.locator('.settings-layout[data-level="section"]').waitFor()
    await page.locator('.settings-page').getByRole('button', { name: '返回', exact: true }).click()
    await page.locator('.settings-page[data-entry="settings"] .settings-layout[data-level="root"]').waitFor()
    await page.context().close()
  })

  describe('over a page entry', () => {
    async function openOnSettings(width: number, name: string): Promise<Page> {
      const { sessionId } = await host.host.bridge.createTask({ prompt: `${name} 的会话`, requestId: randomUUID(), mode: 'agent' })
      const page = await open(width, 900, name, true)
      if (width >= 1024) await page.locator(`[data-task-id="${sessionId}"]`).first().click()
      await openEntry(page, '设置')
      await page.locator('.settings-page').waitFor()
      return page
    }
    const findBar = (page: Page) => page.getByRole('search', { name: '会话内查找', exact: true })

    it('leaves the hidden session alone: its shortcuts do nothing and the page stays', async () => {
      const page = await openOnSettings(1440, '壳层快捷键')
      const selected = () => page.locator('#session-navigation [aria-current="true"], #session-navigation [aria-current="page"]').count()
      const before = await selected()
      const prevented = page.evaluate(
        () =>
          new Promise<boolean>(done => {
            window.addEventListener('keydown', event => setTimeout(() => done(event.defaultPrevented)), { once: true })
          }),
      )
      await page.keyboard.press('Control+F')
      expect(await prevented).toBe(false)
      for (const keys of ['Alt+]', 'Alt+Shift+B', 'Alt+Shift+E', 'Alt+P', 'Alt+W', 'Alt+L']) {
        await page.keyboard.press(keys)
        await page.locator('.settings-page').waitFor()
      }
      expect(await page.locator('dialog[open]').count()).toBe(0)
      expect(await page.locator('.app-shell').getAttribute('data-inspector')).toBeNull()
      expect(await selected()).toBe(before)
      await openSessions(page)
      expect(await findBar(page).count()).toBe(0)
      expect(await page.locator('.app-shell').getAttribute('data-inspector')).toBeNull()
      await page.context().close()
    })

    it('still starts a new session, and the old number keys do nothing', async () => {
      const page = await openOnSettings(1440, '壳层快捷键入口')
      await page.keyboard.press('Alt+Digit4')
      await page.locator('.settings-page[data-entry="settings"]').waitFor()
      await page.keyboard.press('Alt+KeyN')
      await page.locator('.settings-page').waitFor({ state: 'detached' })
      expect(await page.locator('main.workspace').getAttribute('class')).toContain('is-new')
      await page.context().close()
    })

    it('takes a palette command for the session back to the session', async () => {
      const page = await openOnSettings(1440, '壳层面板')
      const run = async (label: string) => {
        await page.keyboard.press('Control+K')
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.getByRole('searchbox').fill(label)
        await palette.getByRole('option', { name: label }).first().click()
      }
      await run('在当前会话中查找')
      await page.locator('.settings-page').waitFor({ state: 'detached' })
      await findBar(page).waitFor()
      await findBar(page).getByRole('button', { name: '关闭查找' }).click()
      await page.context().close()
    })

    it('opens no drawer on a tablet, where the page has no session list to show', async () => {
      const page = await openOnSettings(800, '壳层平板页面')
      await page.keyboard.press('Alt+KeyB')
      await settleShell(page)
      expect(await page.locator('.drawer-backdrop').count()).toBe(0)
      await page.getByRole('tab', { name: '通用', exact: true }).click()
      await page.context().close()
    })

    it('stays when a send settles after the person moved to the page', async () => {
      const page = await open(1440, 900, '壳层发送')
      let release: () => void = () => {}
      const held = new Promise<void>(done => {
        release = done
      })
      await page.route(
        url => url.pathname.endsWith('/tasks'),
        async route => {
          if (route.request().method() === 'POST') await held
          await route.continue()
        },
      )
      await page.getByRole('textbox', { name: '新会话消息', exact: true }).fill('晚些才回来的消息')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await openEntry(page, '设置')
      await page.locator('.settings-page').waitFor()
      const created = page.waitForResponse(response => response.url().endsWith('/tasks') && response.request().method() === 'POST')
      release()
      await created
      await page.locator('[data-task-id]').first().waitFor({ state: 'attached' })
      await settleShell(page)
      await page.locator('.settings-page').waitFor()
      expect(await page.locator('.app-shell').getAttribute('data-entry')).toBe('settings')
      await page.context().close()
    })
  })

  it('lets a sheet be dragged narrower, until it fits beside the conversation', async () => {
    const page = await open(1200, 850, '壳层面板拖动')
    const { sessionId } = await host.host.bridge.createTask({ prompt: '面板拖动的会话', requestId: randomUUID(), mode: 'agent' })
    await page.locator(`[data-task-id="${sessionId}"]`).first().click()
    await page
      .getByRole('button', { name: /侧边面板/u })
      .first()
      .click()
    await page.locator('.app-shell[data-inspector="sheet"]').waitFor()
    await settleShell(page)
    const edge = page.getByRole('separator', { name: '调整侧边面板宽度', exact: true })
    const handle = await edge.boundingBox()
    expect(handle).not.toBeNull()
    expect(Math.round(handle!.x + handle!.width / 2)).toBe(1200 - 520)
    const y = handle!.y + handle!.height / 2
    await page.mouse.move(handle!.x + handle!.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(1200 - 400, y, { steps: 4 })
    expect((await box(page, 'main.workspace')).width).toBe(1200 - 248)
    await page.mouse.up()
    await page.locator('.app-shell[data-inspector="open"]').waitFor()
    expect((await box(page, '.inspector-column')).width).toBeGreaterThanOrEqual(399)
    await page.context().close()
  })
})
