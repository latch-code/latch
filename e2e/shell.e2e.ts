import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DeviceScope, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { homeInput, switchView } from './helpers/workbench.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import {
  backToPhoneSessions,
  noHorizontalOverflow,
  openEntry,
  openPanelTab,
  openSession,
  openSessions,
  phoneStartScreen,
  settleShell,
} from './helpers/layout.ts'
import { promptValue } from './helpers/prompt.ts'

const CONNECTION_SHOTS = 'test-results/workbench-connection'

/** The frame of the shell at each width: the title row, the sidebar or the tab bar, and what moving to a page keeps. */
describe('the shell', () => {
  let host: TestHost
  let browser: Browser

  beforeAll(async () => {
    host = await startTestHost({ hostName: '验收电脑' })
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

  it('lays out the 52px title row and the sidebar from the window edge, and lands a cold start on the start screen with its input', async () => {
    const page = await open(1440, 900, '壳层桌面')
    expect(await box(page, '.titlebar')).toMatchObject({ left: 0, top: 0, width: 1440, height: 52 })
    expect(await box(page, '#session-navigation')).toMatchObject({ left: 0, top: 52, width: 264 })
    expect((await box(page, 'main.workspace')).left).toBe(264)
    // A browser knows its transport and the current computer. The desktop's computer list is absent.
    const foot = page.getByRole('navigation', { name: '主导航', exact: true })
    // One row of icons, named by their labels: 设置 and 额度与用量 at the left, 检查更新 at the right end.
    expect(await foot.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual([
      '设置',
      '额度与用量',
      '检查更新',
    ])
    const connection = page.getByRole('group', { name: '连接状态', exact: true })
    const computer = connection.getByRole('button', { name: '验收电脑', exact: true })
    await computer.waitFor()
    expect(await connection.getByText('回环 HTTP', { exact: true }).count()).toBe(1)
    expect(await connection.getByText(/host\.sock|台在线/u).count()).toBe(0)
    const strip = await box(page, '.workbench-connection')
    expect(strip.top + strip.height).toBe(900)
    expect(await page.getByRole('button', { name: '验收电脑', exact: true }).count()).toBe(1)
    expect((await box(page, '#session-navigation .space-switch')).top).toBeLessThan(
      (await box(page, '#session-navigation .sidebar-top .sidebar-nav-row >> nth=0')).top,
    )
    await page.locator('.workbench-home').waitFor()
    expect(await page.locator('main.workspace').getAttribute('inert')).not.toBeNull()
    expect(await page.getByRole('textbox', { name: '新会话消息', exact: true }).count()).toBe(1)
    await mkdir(CONNECTION_SHOTS, { recursive: true })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.screenshot({ path: `${CONNECTION_SHOTS}/start-1440-light.png`, animations: 'disabled' })
    // The start screen: the input in the middle, the count line under it keeping its height while it is empty.
    const composer = page.locator('.workbench-home-composer .composer')
    const before = (await composer.boundingBox())!
    const page1440 = (await page.locator('.workbench-home').boundingBox())!
    expect(Math.abs(before.x + before.width / 2 - (page1440.x + page1440.width / 2))).toBeLessThanOrEqual(2)
    expect((await page.locator('.start-counts').boundingBox())!.height).toBeGreaterThan(0)
    expect(await page.locator('.start-count').count()).toBe(0)
    // 看板 covers 对话 under the title row; the status bar stays, and so does the one switch.
    await switchView(page, 'board')
    await page.locator('.board-surface').waitFor()
    expect(await page.getByRole('textbox', { name: '新会话消息', exact: true }).count()).toBe(0)
    expect(await page.locator('#session-navigation').evaluate(element => (element as HTMLElement).inert)).toBe(true)
    const title = page.locator('.titlebar')
    for (const name of ['设置', '额度与用量', '检查更新'])
      await title.getByRole('button', { name, exact: true }).filter({ visible: true }).first().waitFor()
    await computer.waitFor()
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: `${CONNECTION_SHOTS}/board-1440-dark.png`, animations: 'disabled' })
    await switchView(page, 'chat')
    const fill = (element: Element) => getComputedStyle(element).backgroundColor
    for (const group of [page.locator('#session-navigation .space-switch'), page.locator('.shell-view-switch')]) {
      expect(await group.evaluate(fill)).toBe('rgb(0, 0, 0)')
      await expect.poll(() => group.getByRole('radio', { checked: true }).evaluate(fill)).toBe('rgb(12, 12, 12)')
    }
    // Back in 对话 the input stands exactly where it stood.
    expect(await composer.boundingBox()).toEqual(before)
    // 对话 | 看板 lives on the left inside the sidebar's title zone, compactly sized, while the right keeps pane toggles only.
    const viewSwitchBox = await box(page, '.titlebar-lead .shell-view-switch')
    expect(viewSwitchBox.left + viewSwitchBox.width).toBeLessThanOrEqual(264)
    expect(viewSwitchBox.width).toBeLessThan(120)
    expect(await page.locator('.titlebar-views .shell-view-switch').count()).toBe(0)
    await page.context().setOffline(true)
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-connection')).toMatch(/^(reconnecting|offline)$/u)
    await expect.poll(() => connection.locator('.ui-status-strip-fact').first().textContent()).toMatch(/(正在重连|离线)$/u)
    expect(await connection.locator('.ui-live-dot[data-live]').count()).toBe(0)
    expect(await connection.getByText('回环 HTTP', { exact: true }).count()).toBe(0)
    await page.screenshot({ path: `${CONNECTION_SHOTS}/offline-1440-dark.png`, animations: 'disabled' })
    await page.context().setOffline(false)
    await connection.getByText('回环 HTTP', { exact: true }).waitFor()
    await noHorizontalOverflow(page)
    await page.context().close()
  })

  it('keeps 对话 | 看板 in the left title zone, adapts between text and icons by available width, and stays mounted through view switches', async () => {
    const page = await open(1440, 900, '左栏视图切换')
    const sw = page.locator('.titlebar-lead .shell-view-switch')
    await sw.waitFor()
    const node = await sw.elementHandle()
    // Without traffic lights, the 264px sidebar header shows compact words rather than icons.
    const textIconVisible = () =>
      sw
        .locator('.ui-segmented-option > svg')
        .first()
        .evaluate(el => getComputedStyle(el).display !== 'none')
    expect(await textIconVisible()).toBe(false)
    expect((await box(page, '.titlebar-lead .shell-view-switch')).width).toBeLessThan(110)

    // Focus and the same DOM element survive 对话 ⇄ 看板.
    const boardRadio = sw.getByRole('radio', { name: /^看板/u })
    await boardRadio.click()
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-view')).toBe('board')
    expect(await node?.evaluate(el => el.isConnected)).toBe(true)
    expect(await boardRadio.evaluate(el => el === document.activeElement)).toBe(true)
    await switchView(page, 'chat')
    expect(await node?.evaluate(el => el.isConnected)).toBe(true)

    // Simulate macOS traffic lights inset (76px -> 88px lead inset) to exercise adaptive icon & narrow-wordmark tiers.
    await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('.titlebar')!
      bar.dataset.lights = ''
      bar.style.setProperty('--lights-end', '76px')
    })
    await expect.poll(textIconVisible).toBe(true)
    const iconBox = await box(page, '.titlebar-lead .shell-view-switch')
    const leadBox = await box(page, '.titlebar-lead')
    expect(iconBox.width).toBe(60)
    expect(iconBox.left + iconBox.width).toBeLessThanOrEqual(leadBox.left + leadBox.width)
    expect(await page.locator('.titlebar-wordmark-text').isVisible()).toBe(true)

    // Drag sidebar to minimum width (220px): wordmark text hides so the 60px icon switch still fits cleanly.
    const handle = (await page.getByRole('separator', { name: '调整侧栏宽度', exact: true }).boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 200)
    await page.mouse.down()
    await page.mouse.move(220, handle.y + 200, { steps: 4 })
    await page.mouse.up()
    await settleShell(page)
    await expect.poll(() => page.locator('.titlebar-wordmark-text').isVisible()).toBe(false)
    const minSwitch = await box(page, '.titlebar-lead .shell-view-switch')
    const minLead = await box(page, '.titlebar-lead')
    expect(minLead.width).toBe(220)
    expect(minSwitch.width).toBe(60)
    expect(minSwitch.left + minSwitch.width).toBeLessThanOrEqual(minLead.left + minLead.width)

    // Drag sidebar wider (320px): wordmark text and text segments both return.
    const minHandle = (await page.getByRole('separator', { name: '调整侧栏宽度', exact: true }).boundingBox())!
    await page.mouse.move(minHandle.x + minHandle.width / 2, minHandle.y + 200)
    await page.mouse.down()
    await page.mouse.move(320, minHandle.y + 200, { steps: 4 })
    await page.mouse.up()
    await settleShell(page)
    await expect.poll(() => page.locator('.titlebar-wordmark-text').isVisible()).toBe(true)
    await expect.poll(textIconVisible).toBe(false)
    const wideSwitch = await box(page, '.titlebar-lead .shell-view-switch')
    const wideLead = await box(page, '.titlebar-lead')
    expect(wideSwitch.left + wideSwitch.width).toBeLessThanOrEqual(wideLead.left + wideLead.width)
    await page.context().close()
  })

  it('opens on 看板 a device that had chosen the old 顶栏 layout, and remembers 对话 once chosen', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    context.setDefaultTimeout(15_000)
    // The key and value an earlier build stored for 顶栏; written once, before the page first reads its preferences.
    await context.addInitScript(() => {
      if (localStorage.getItem('latch.preferences') === null)
        localStorage.setItem('latch.preferences', JSON.stringify({ workbenchLayout: 'triage', theme: 'dark' }))
    })
    const page = await context.newPage()
    await enrollBrowser(page, host, { name: '旧顶栏设备' })
    await connected(page)
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-view')).toBe('board')
    await page.locator('.board-surface').waitFor()
    await switchView(page, 'chat')
    await page.reload()
    await connected(page)
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-view')).toBe('chat')
    const stored = JSON.parse((await page.evaluate(() => localStorage.getItem('latch.preferences')))!) as Record<string, unknown>
    expect(stored).toMatchObject({ workView: 'chat', theme: 'dark' })
    expect(stored).not.toHaveProperty('workbenchLayout')
    await context.close()
  })

  it('keeps the same Home and draft under the settings modal, and returns focus with Escape', async () => {
    const page = await open(1440, 900, '壳层切换')
    const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
    await input.fill('切换入口时保留的草稿')
    const retained = await input.elementHandle()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await openEntry(page, '设置')
    await settings.waitFor()
    expect(await retained?.evaluate(element => element.isConnected)).toBe(true)
    expect(
      await retained?.evaluate(element => {
        element.focus()
        return element === document.activeElement
      }),
    ).toBe(false)
    expect(await settings.locator('.settings-title').textContent()).toBe('通用')
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('关闭设置')
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'detached' })
    const opener = page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '设置', exact: true })
    expect(await opener.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await promptValue(input)).toBe('切换入口时保留的草稿')
    await openEntry(page, '设置')
    await settings.waitFor()
    await page.reload()
    await connected(page)
    await settings.waitFor({ state: 'detached' })
    expect(await promptValue(input)).toBe('切换入口时保留的草稿')
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
    await page.getByRole('tab', { name: '通用', exact: true }).waitFor()
    await openSessions(page)
    expect(await page.locator('.app-shell').getAttribute('data-sidebar')).toBe('collapsed')
    await page.context().close()
  })

  it('surfaces external Harness updates on 检查更新 across desktop, dark mode and phone, and opens the Harness in settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-update-check-e2e-'))
    const bin = join(root, 'bin')
    const pkg = join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'bin')
    await mkdir(bin)
    await mkdir(pkg, { recursive: true })
    await writeFile(
      join(pkg, 'dsh'),
      ['#!/bin/sh', 'if [ "$1" = --version ]; then echo 0.2.2; exit 0; fi', `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`, ''].join(
        '\n',
      ),
    )
    await chmod(join(pkg, 'dsh'), 0o755)
    await symlink(join(pkg, 'dsh'), join(bin, 'dsh'))
    const updateHost = await startTestHost({
      hostName: '更新验收电脑',
      detectPreset: preset => (preset.id === 'dsh' ? { found: true, path: join(bin, 'dsh') } : { found: false }),
      loginPrograms: name => (existsSync(join(bin, name)) ? join(bin, name) : undefined),
      commandDirectories: () => [bin],
      harnessUpdates: {
        home: '/nonexistent',
        claudeDir: join(root, 'claude'),
        fetch: async () => new Response(JSON.stringify({ latest: '0.3.0' }), { status: 200 }),
      },
    })
    try {
      const owner = await updateHost.enroll({ listener: 'unix' })
      await owner.confirmedJson('agents', {
        method: 'POST',
        body: { id: 'dsh', name: 'DeepSeek Harness', presetId: 'dsh', command: 'dsh', args: ['--profile', 'acp'], env: {} },
      })

      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
      context.setDefaultTimeout(15_000)
      const page = await context.newPage()
      await enrollBrowser(page, updateHost, { name: '更新检查桌面', scopes: ['view', 'run', 'admin'] })
      await connected(page)

      const updateButton = (surface: Locator) => surface.getByRole('button', { name: '检查更新', exact: true })
      const trigger = updateButton(page.getByRole('navigation', { name: '主导航', exact: true }))
      await trigger.locator('.icon-dot').waitFor()
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: '检查更新', exact: true })
      await dialog.getByText('DeepSeek Harness', { exact: true }).waitFor()
      await dialog.getByText('0.2.2 → 0.3.0', { exact: true }).waitFor()
      await dialog.getByRole('button', { name: '复制升级命令', exact: true }).waitFor()

      await mkdir(CONNECTION_SHOTS, { recursive: true })
      await page.emulateMedia({ colorScheme: 'light' })
      await page.screenshot({ path: `${CONNECTION_SHOTS}/update-check-1440-light.png`, animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.screenshot({ path: `${CONNECTION_SHOTS}/update-check-1440-dark.png`, animations: 'disabled' })
      await noHorizontalOverflow(page)

      await dialog.getByRole('button', { name: '在设置中打开 DeepSeek Harness', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.getByText('有新版本', { exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await settings.waitFor({ state: 'detached' })

      // Tablet (820x1180) and phone (390x844) rendering.
      await page.setViewportSize({ width: 820, height: 1180 })
      const railTrigger = updateButton(page.getByRole('navigation', { name: '工作台导航', exact: true }))
      await railTrigger.locator('.icon-dot').waitFor()
      await railTrigger.click()
      await dialog.getByText('0.2.2 → 0.3.0', { exact: true }).waitFor()
      await page.screenshot({ path: `${CONNECTION_SHOTS}/update-check-820-dark.png`, animations: 'disabled' })
      await noHorizontalOverflow(page)
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      await context.close()

      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', reducedMotion: 'reduce' })
      phone.setDefaultTimeout(15_000)
      try {
        const handset = await phone.newPage()
        await enrollBrowser(handset, updateHost, { name: '更新检查手机', scopes: ['view', 'run', 'admin'] })
        await connected(handset)
        await phoneStartScreen(handset)
        const phoneTrigger = handset.locator('.workbench-phone-heading').getByRole('button', { name: '检查更新', exact: true })
        await phoneTrigger.locator('.icon-dot').waitFor()
        await phoneTrigger.click()
        const updates = handset.getByRole('dialog', { name: '检查更新', exact: true })
        await updates.getByText('0.2.2 → 0.3.0', { exact: true }).waitFor()
        await handset.emulateMedia({ colorScheme: 'light' })
        await handset.screenshot({ path: `${CONNECTION_SHOTS}/update-check-390-light.png`, animations: 'disabled' })
        await noHorizontalOverflow(handset)
        await updates.getByRole('button', { name: '在设置中打开 DeepSeek Harness', exact: true }).click()
        const harness = handset.getByRole('region', { name: 'DeepSeek Harness', exact: true })
        await harness.getByText('有新版本', { exact: true }).waitFor()
      } finally {
        await phone.close()
      }
    } finally {
      await updateHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('slides the session list over on tablets, with 设置 at its foot', async () => {
    const page = await open(768, 1024, '壳层平板')
    const connection = page.getByRole('group', { name: '连接状态', exact: true })
    const computer = connection.getByRole('button', { name: '验收电脑', exact: true })
    expect((await computer.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
    const list = page.getByRole('dialog', { name: '会话导航', exact: true })
    await list.waitFor()
    expect(await page.locator('.workbench-connection').evaluate(element => (element as HTMLElement).inert)).toBe(true)
    await list.getByRole('button', { name: '关闭会话列表', exact: true }).click()
    await computer.waitFor()
    await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
    await list.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.settings-page').waitFor()
    const panel = await box(page, '.settings-overlay')
    const categories = await box(page, '.settings-nav-pane')
    expect(panel.left).toBeGreaterThan(0)
    expect(categories.left).toBeGreaterThanOrEqual(panel.left)
    expect(categories.width).toBe(200)
    await openSessions(page)
    await list.waitFor()
    expect(await list.getByRole('button', { name: '设置', exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    await list.getByRole('button', { name: '关闭会话列表', exact: true }).click()
    await noHorizontalOverflow(page)
    await page.context().close()
  })

  it('gives a phone a tab bar of places only, and a full-screen settings stack', async () => {
    const page = await open(390, 844, '壳层手机')
    expect(await page.locator('.titlebar').count()).toBe(0)
    expect(await page.locator('.workbench-connection').count()).toBe(0)
    const tabs = page.getByRole('navigation', { name: '主导航', exact: true })
    // 额度与用量 is no place: it opens as a sheet from the home's header and from the composer.
    expect(await tabs.getByRole('button').allTextContents()).toEqual(['Code', '我的 Agent', '设置'])
    const bar = await box(page, '.phone-tabs')
    expect(bar.top + bar.height).toBe(844)
    await mkdir(CONNECTION_SHOTS, { recursive: true })
    await page.screenshot({ path: `${CONNECTION_SHOTS}/phone-tabs-390.png`, animations: 'disabled' })
    await tabs.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.settings-page').waitFor()
    await page.getByRole('tab', { name: '通用', exact: true }).click()
    await page.locator('.settings-layout[data-level="section"]').waitFor()
    await page.goBack()
    await page.locator('.settings-layout[data-level="root"]').waitFor()
    expect(await box(page, '.settings-overlay')).toEqual({ left: 0, top: 0, width: 390, height: 844 })
    await page.goBack()
    await page.locator('.settings-page').waitFor({ state: 'detached' })
    expect(await tabs.getByRole('button', { name: '设置', exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    await page.context().close()
  })

  it('lists 设备 among the sections of 设置, with or without 管理此 Host', async () => {
    const tabsOf = async (page: Page) => {
      await openEntry(page, '设置')
      return page.locator('.settings-page').getByRole('tab').allTextContents()
    }
    const owner = await open(1440, 900, '壳层分区管理', true)
    await allData(owner)
    expect(await tabsOf(owner)).toEqual([
      '通用',
      '外观',
      '快捷键',
      '模型',
      'Harness',
      'MCP',
      '扩展',
      '插件',
      '项目',
      '数据',
      '设备',
      '连接转发',
      '关于',
    ])
    await owner.context().close()
    const guest = await open(1440, 900, '壳层分区只读')
    expect(await tabsOf(guest)).toEqual(['通用', '外观', '快捷键', '设备', '关于'])
    await guest.context().close()
  })

  it('opens the implemented schedule page and keeps it out of settings sections', async () => {
    const page = await open(1440, 900, '壳层没有空页')
    await allData(page)
    const sidebar = page.locator('#session-navigation')
    await sidebar.getByRole('button', { name: '定时任务', exact: true }).click()
    const profile = page.getByRole('region', { name: '通用 的资料', exact: true })
    await profile.waitFor()
    await profile.locator('.agent-schedules').getByText('没有定时任务', { exact: true }).waitFor()
    const closeProfile = profile.getByRole('button', { name: '关闭资料', exact: true })
    const box = await profile.boundingBox()
    expect(box?.width).toBeGreaterThan(200)
    expect(box!.x + box!.width).toBeLessThanOrEqual(1440)
    await page.screenshot({ path: 'test-results/schedule-after-1440.png', animations: 'disabled' })
    await closeProfile.click()
    await openEntry(page, '设置')
    const settings = page.locator('.settings-overlay:modal')
    await settings.getByRole('tab', { name: '通用', exact: true }).waitFor()
    expect(await settings.getByRole('tab', { name: 'Agent', exact: true }).count()).toBe(0)
    expect(await settings.getByRole('tab', { name: '定时任务', exact: true }).count()).toBe(0)
    await openSessions(page)
    await page.locator('.agents-page[data-chat]').waitFor()
    expect(await page.locator('.app-shell').getAttribute('data-entry')).toBe('agents')
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
      const panelBefore = await page.locator('.app-shell').getAttribute('data-inspector')
      const findKey = await page.evaluateHandle(() => ({
        prevented: new Promise<boolean>(done => {
          const onFind = (event: KeyboardEvent) => {
            if (!event.ctrlKey || event.code !== 'KeyF') return
            window.removeEventListener('keydown', onFind)
            setTimeout(() => done(event.defaultPrevented))
          }
          window.addEventListener('keydown', onFind)
        }),
      }))
      await page.keyboard.press('Control+F')
      const prevented = await findKey.evaluate(result => result.prevented)
      await findKey.dispose()
      expect(prevented).toBe(false)
      for (const keys of ['Alt+]', 'Alt+Shift+B', 'Alt+Shift+E', 'Alt+P', 'Alt+W', 'Alt+L']) {
        await page.keyboard.press(keys)
        await page.locator('.settings-page').waitFor()
      }
      expect(await page.locator('dialog[open]').count()).toBe(1)
      expect(await page.locator('.app-shell').getAttribute('data-inspector')).toBe(panelBefore)
      expect(await selected()).toBe(before)
      await openSessions(page)
      expect(await findBar(page).count()).toBe(0)
      expect(await page.locator('.app-shell').getAttribute('data-inspector')).toBe(panelBefore)
      await page.context().close()
    })

    it('holds workbench shortcuts inside settings until it closes', async () => {
      const page = await openOnSettings(1440, '壳层快捷键入口')
      await page.keyboard.press('Alt+Digit4')
      await page.keyboard.press('Alt+KeyN')
      await page.locator('.settings-page[data-entry="settings"]').waitFor()
      expect(await page.locator('.workbench-home').count()).toBe(0)
      await page.keyboard.press('Escape')
      await page.locator('.settings-page').waitFor({ state: 'detached' })
      await page.keyboard.press('Alt+KeyN')
      // 新会话 is the home with its input focused; the session stays open under it.
      await page.locator('.workbench-home').waitFor()
      await expect.poll(() => homeInput(page).evaluate(element => element === document.activeElement)).toBe(true)
      expect(await page.locator('main.workspace').getAttribute('class')).toContain('has-task')
      expect(await page.locator('main.workspace').getAttribute('inert')).toBe('')
      await page.context().close()
    })

    it('keeps the palette behind settings and restores its shortcut after closing', async () => {
      const page = await openOnSettings(1440, '壳层面板')
      const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
      await page.keyboard.press('Control+K')
      expect(await palette.count()).toBe(0)
      await openSessions(page)
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

    it('shows the sent Home message while an older reading session stays retained', async () => {
      const page = await open(1440, 900, '首页已发消息')
      const { sessionId } = await host.host.bridge.createTask({ prompt: '保留阅读的会话', requestId: randomUUID(), mode: 'agent' })
      await page.locator(`[data-task-id="${sessionId}"]`).first().click()
      await page.locator('.transcript-content').waitFor()
      await page.locator('#session-navigation [data-space-primary]').click()
      let release: () => void = () => {}
      const held = new Promise<void>(done => {
        release = done
      })
      let starts = 0
      await page.route(
        url => url.pathname.endsWith('/tasks'),
        async route => {
          if (route.request().method() === 'POST') {
            starts++
            await held
          }
          await route.continue()
        },
      )
      const prompt = '从首页发送的新消息'
      await page.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true }).fill(prompt)
      await page.locator('.workbench-home').getByRole('button', { name: '发送', exact: true }).click()
      const pending = page.locator('main.workspace[data-pending-start]:not([inert])')
      await pending.locator('.transcript .sending-message').getByText(prompt, { exact: true }).waitFor()
      expect(await pending.locator('.transcript').getByText('保留阅读的会话', { exact: true }).count()).toBe(0)
      expect(await page.locator('.workbench-home').count()).toBe(0)
      expect(starts).toBe(1)
      const created = page.waitForResponse(response => response.url().endsWith('/tasks') && response.request().method() === 'POST')
      release()
      await created
      await page.locator('main.workspace:not([inert]) .user-bubble').getByText(prompt, { exact: true }).waitFor()
      await page.locator('.sending-message').waitFor({ state: 'detached' })
      expect(starts).toBe(1)
      await page.context().close()
    })

    it('keeps focus on the workspace without a transcript focus ring when starting from Home with Enter', async () => {
      const page = await open(1440, 900, '首页回车聚焦')
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
      const prompt = '第一次回车发送的消息'
      const input = page.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true })
      await input.click()
      await input.fill(prompt)
      await page.keyboard.press('Enter')
      const pending = page.locator('main.workspace[data-pending-start]:not([inert])')
      await pending.locator('.transcript .sending-message').getByText(prompt, { exact: true }).waitFor()
      const state = await pending.evaluate(workspace => {
        const transcript = workspace.querySelector<HTMLElement>('.transcript')!
        const active = document.activeElement as HTMLElement | null
        return {
          focusedWorkspace: active === workspace,
          workspaceOutline: active ? getComputedStyle(active).outlineStyle : null,
          transcriptFocused: active === transcript,
          transcriptFocusVisible: transcript.matches(':focus-visible'),
          transcriptOutline: getComputedStyle(transcript).outlineStyle,
        }
      })
      expect(state).toEqual({
        focusedWorkspace: true,
        workspaceOutline: 'none',
        transcriptFocused: false,
        transcriptFocusVisible: false,
        transcriptOutline: 'none',
      })
      const created = page.waitForResponse(response => response.url().endsWith('/tasks') && response.request().method() === 'POST')
      release()
      await created
      await page.locator('main.workspace:not([inert]) .user-bubble').getByText(prompt, { exact: true }).waitFor()
      await page.locator('.sending-message').waitFor({ state: 'detached' })
      expect(
        await page.locator('main.workspace:not([inert]) .transcript').evaluate(transcript => ({
          focusVisible: transcript.matches(':focus-visible'),
          outline: getComputedStyle(transcript).outlineStyle,
        })),
      ).toEqual({ focusVisible: false, outline: 'none' })
      await page.context().close()
    })

    it('opens the accepted conversation when the person returned to the same pending Home input', async () => {
      const page = await open(1440, 900, '壳层回到待发送首页')
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
      const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
      await input.fill('回到原输入后接收结果')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await openEntry(page, '设置')
      await openSessions(page)
      const pending = page.locator('main.workspace[data-pending-start]:not([inert])')
      await pending.locator('.sending-message').waitFor()
      expect(await pending.locator('form[hidden] .composer-input [role="textbox"]').isDisabled()).toBe(true)
      const created = page.waitForResponse(response => response.url().endsWith('/tasks') && response.request().method() === 'POST')
      release()
      await created
      await page.locator('main.workspace:not([inert]) .transcript-content').waitFor()
      await page.locator('main.workspace .topbar-title-button', { hasText: '回到原输入后接收结果' }).waitFor()
      await page.locator('#session-navigation [data-space-primary]').click()
      expect(await promptValue(input)).toBe('')
      await page.context().close()
    })

    it.each(['settings', 'board'] as const)('stays on %s when a send settles after the person moved there', async destination => {
      const page = await open(1440, 900, `壳层发送 ${destination}`)
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
      const prompt = `晚些才回来的消息 ${destination}`
      await page.getByRole('textbox', { name: '新会话消息', exact: true }).fill(prompt)
      await page.getByRole('button', { name: '发送', exact: true }).click()
      if (destination === 'settings') await openEntry(page, '设置')
      else await switchView(page, 'board')
      const destinationPage = page.locator(destination === 'settings' ? '.settings-page' : '.board-surface')
      await destinationPage.waitFor()
      const created = page.waitForResponse(response => response.url().endsWith('/tasks') && response.request().method() === 'POST')
      release()
      await created
      await page.locator('[data-task-id]').first().waitFor({ state: 'attached' })
      await settleShell(page)
      await destinationPage.waitFor()
      if (destination === 'settings') {
        await page.locator('.settings-overlay:modal').waitFor()
        await openSessions(page)
        await page.locator('main.workspace .user-bubble').getByText(prompt, { exact: true }).waitFor()
      } else {
        // The accepted session is the one 对话 comes back to.
        expect(await page.locator('.app-shell').getAttribute('data-view')).toBe('board')
        await switchView(page, 'chat')
        await page.locator('main.workspace .user-bubble').getByText(prompt, { exact: true }).waitFor()
      }
      await page.context().close()
    })
  })

  // docs/DESIGN.md (区域划分): the panel narrows itself to leave the conversation 440px, and floats over it only where
  // even 360px will not fit beside it.
  it('narrows a panel dragged wider to keep the conversation, and floats it only where it cannot fit', async () => {
    const page = await open(1200, 850, '壳层面板拖动')
    await allData(page)
    await writeFile(resolve(host.workspaceRoot, '验收文档.txt'), '面板验收文件\n')
    const { sessionId } = await host.host.bridge.createTask({ prompt: '面板拖动的会话', requestId: randomUUID(), mode: 'agent' })
    await page.locator(`[data-task-id="${sessionId}"]`).first().click()
    await page.locator('.app-shell[data-inspector="open"]').waitFor()
    await settleShell(page)
    // The default summary is a column; drag it wider through its real handle than the conversation can give.
    const initialHandle = page.getByRole('separator', { name: '调整侧边面板宽度', exact: true })
    const divider = () => page.locator('.inspector-column-inner').evaluate(element => getComputedStyle(element).borderInlineStartWidth)
    const highlight = () => initialHandle.evaluate(element => getComputedStyle(element, '::after').opacity)
    expect(await divider()).toBe('1px')
    await expect.poll(highlight).toBe('0')
    await initialHandle.hover()
    await expect.poll(highlight).toBe('1')
    await page.mouse.move(0, 0)
    await expect.poll(highlight).toBe('0')
    expect(await initialHandle.getAttribute('aria-valuenow')).toBe('400')
    const initialEdge = (await initialHandle.boundingBox())!
    expect(Math.round(initialEdge.x + initialEdge.width / 2)).toBe(800)
    const initialY = initialEdge.y + initialEdge.height / 2
    await initialHandle.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => initialHandle.getAttribute('aria-valuenow')).toBe('392')
    await expect.poll(highlight).toBe('1')
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => initialHandle.getAttribute('aria-valuenow')).toBe('400')
    await settleShell(page)
    await page.mouse.move(initialEdge.x + initialEdge.width / 2, initialY)
    await page.mouse.down()
    expect(await initialHandle.getAttribute('data-dragging')).not.toBeNull()
    await expect.poll(highlight).toBe('1')
    await page.mouse.move(1200 - 520, initialY, { steps: 4 })
    await page.mouse.up()
    await settleShell(page)
    // 1200 less the 264 sidebar and the conversation's 440 leaves 496.
    expect({
      width: await initialHandle.getAttribute('aria-valuenow'),
      placement: await page.locator('.app-shell').getAttribute('data-inspector'),
      sidebar: await page.getByRole('separator', { name: '调整侧栏宽度', exact: true }).getAttribute('aria-valuenow'),
    }).toEqual({ width: '496', placement: 'open', sidebar: '264' })
    expect((await box(page, 'main.workspace')).width).toBe(440)
    expect(await divider()).toBe('1px')
    // Narrower than the rail, 360 and 440 together: the open panel floats over the conversation, with no divider.
    await page.setViewportSize({ width: 800, height: 850 })
    await page.locator('.app-shell[data-inspector="sheet"]').waitFor()
    await settleShell(page)
    expect(await divider()).toBe('0px')
    // Wide again, it stands beside the conversation once more.
    await page.setViewportSize({ width: 1200, height: 850 })
    await page.locator('.app-shell[data-inspector="open"]').waitFor()
    await settleShell(page)
    expect((await box(page, '.inspector-column')).width).toBeGreaterThanOrEqual(399)
    const output = 'test-results/session-title-icon'
    await mkdir(output, { recursive: true })
    await page.mouse.move(0, 0)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      expect(await divider()).toBe('1px')
      await page.screenshot({ path: `${output}/pane-${colorScheme}.png`, animations: 'disabled' })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await openPanelTab(page, '文件')
    await page.getByRole('treeitem', { name: '验收文档.txt', exact: true }).waitFor()
    await page.locator('.app-shell[data-inspector="open"]').waitFor()
    const computer = page.locator('.workspace .topbar-computer .topbar-crumb-text')
    await computer.getByText('验收电脑', { exact: true }).waitFor()
    expect(await computer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      expect(await divider()).toBe('1px')
      await page.screenshot({ path: `${output}/pane-files-1440-${colorScheme}.png`, animations: 'disabled' })
    }
    await page.context().close()
  })

  it('keeps the rename pencil beside the Code title', async () => {
    const output = 'test-results/session-title-icon'
    await mkdir(output, { recursive: true })
    const owner = await host.enroll({ listener: 'unix' })
    const project = '标题验收项目'
    const branch = 'title-check'
    const folder = resolve(host.root, branch)
    await mkdir(folder)
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          ...args,
        ],
        { cwd: folder, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'ignore' },
      )
    git('init', '--template=', `--initial-branch=${branch}`)
    git('commit', '--allow-empty', '-m', 'Title fixture')
    const added = await owner.addFolders({ name: project, paths: [folder] })
    expect(added.status).toBe(201)
    const { workspace } = (await added.json()) as { workspace: WorkspaceInfo }
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '核对会话标题', requestId: randomUUID(), mode: 'agent', workspaceId: workspace.id },
    })
    const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
    await expect.poll(async () => (await detail()).summary.status).toBe('idle')
    const short = '估算机评流程所需 TPM'
    const long = '这是一条很长的会话标题，仍然需要保留重命名入口。'.repeat(5)

    for (const [width, height] of [
      [1440, 900],
      [768, 1024],
      [390, 844],
    ] as const) {
      const phone = width === 390
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: width === 768 ? 'light' : 'dark',
        locale: 'zh-CN',
        reducedMotion: 'reduce',
        ...(phone ? { isMobile: true, hasTouch: true } : {}),
      })
      context.setDefaultTimeout(15_000)
      try {
        const page = await context.newPage()
        await enrollBrowser(page, host, { name: `标题验收 ${width}` })
        await connected(page)
        if (!phone) await openSession(page, sessionId)
        await page.evaluate(() => document.fonts.ready)
        const header = page.locator('main.workspace .topbar')
        const heading = (name: string) => header.getByRole('heading', { name, exact: true })
        const pencil = header.getByRole('button', { name: '重命名会话', exact: true })
        const dialog = page.getByRole('dialog', { name: '重命名会话', exact: true })
        const field = dialog.getByRole('textbox', { name: '会话名称', exact: true })
        const shoot = async (name: string) => {
          for (const colorScheme of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme })
            await page.screenshot({ path: `${output}/${name}-${page.viewportSize()?.width}-${colorScheme}.png`, animations: 'disabled' })
          }
        }
        const checkLine = async (clipped: boolean) => {
          const rects = await header.evaluate(element => {
            const rect = ({ x, y, width, height, right, bottom }: DOMRect) => ({ x, y, width, height, right, bottom })
            const heading = element.querySelector('h1')!.getBoundingClientRect()
            const rename = element.querySelector('.topbar-rename')!.getBoundingClientRect()
            const text = element.querySelector('.topbar-title-text')!
            const meta = ['.topbar-crumb-button', '.topbar-session-branch', '.topbar-computer'].map(selector =>
              element.querySelector(selector)!.getBoundingClientRect(),
            )
            const centers = meta.map(item => item.y + item.height / 2)
            return {
              heading: rect(heading),
              rename: rect(rename),
              meta: meta.map(rect),
              secondLine: meta.every(item => item.top >= heading.bottom) && Math.max(...centers) - Math.min(...centers) <= 1,
              clipped: text.scrollWidth > text.clientWidth && getComputedStyle(text).textOverflow === 'ellipsis',
            }
          })
          expect(rects.secondLine, JSON.stringify({ width, meta: rects.meta, heading: rects.heading })).toBe(true)
          expect(rects.clipped).toBe(clipped)
          expect(rects.rename.y + rects.rename.height / 2).toBeCloseTo(rects.heading.y + rects.heading.height / 2, 0)
          expect(rects.rename.x - rects.heading.right).toBeGreaterThanOrEqual(0)
          expect(rects.rename.x - rects.heading.right).toBeLessThanOrEqual(8)
          expect(rects.rename.width).toBeGreaterThanOrEqual(24)
          return rects
        }

        for (const layout of ['chat'] as const) {
          await owner.json(`tasks/${sessionId}`, { method: 'PATCH', body: { title: short } })
          if (phone) await openSession(page, sessionId)
          await heading(short).waitFor()
          if (phone) {
            expect(await pencil.count()).toBe(0)
            await header.locator('.topbar-subline').getByText(branch, { exact: true }).waitFor()
            await shoot(`short-${layout}`)
            await heading(short).getByRole('button', { name: short, exact: true }).click()
            await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
          } else {
            await header.getByRole('button', { name: `项目：${project}`, exact: true }).waitFor()
            await header.locator('.topbar-session-branch').getByText(branch, { exact: true }).waitFor()
            await header.locator('.topbar-computer').getByText('验收电脑', { exact: true }).waitFor()
            const initial = await checkLine(false)
            const title = heading(short).getByRole('button', { name: short, exact: true })
            const pencilOpacity = () => pencil.evaluate(element => getComputedStyle(element).opacity)
            const titleBackground = () => title.evaluate(element => getComputedStyle(element).backgroundColor)
            const record = async (state: string) => {
              if (width === 1440)
                await page.screenshot({ path: `${output}/title-${state}-${layout}-${width}-dark.png`, animations: 'disabled' })
            }
            await page.mouse.move(0, 0)
            await expect.poll(pencilOpacity).toBe('0')
            const atRest = await titleBackground()
            await record('rest')
            await header.locator('.topbar-computer').hover()
            expect(await titleBackground()).toBe(atRest)
            const metaPencil = await pencil.evaluate(async element => {
              await Promise.all(element.getAnimations().map(animation => animation.finished))
              return getComputedStyle(element).opacity
            })
            await record('metadata-hover')
            await title.hover()
            await expect.poll(pencilOpacity).toBe('1')
            await expect.poll(titleBackground).not.toBe(atRest)
            expect(await checkLine(false)).toEqual(initial)
            const titleGeometry = await title.evaluate(button => {
              const text = button.querySelector('.topbar-title-text')!
              const range = document.createRange()
              range.selectNodeContents(text)
              const line = range.getBoundingClientRect()
              const span = text.getBoundingClientRect()
              const box = button.getBoundingClientRect()
              return {
                buttonHeight: box.height,
                spanHeight: span.height,
                glyphHeight: line.height,
                spanFits: span.top >= box.top && span.bottom <= box.bottom,
                glyphFits: line.top >= box.top && line.bottom <= box.bottom,
                x: (line.left + line.right) / 2,
                edges: [line.top + 1, line.bottom - 1],
              }
            })
            await record('title-hover')
            expect.soft(metaPencil, `${width} ${layout} metadata hover`).toBe('0')
            expect.soft(titleGeometry, `${width} ${layout} title hit box ${JSON.stringify(titleGeometry)}`).toMatchObject({
              spanFits: true,
              glyphFits: true,
            })
            await shoot(`short-${layout}`)
            const menu = header.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: '重命名', exact: true }) })
            for (const [edge, y] of titleGeometry.edges.entries()) {
              await page.mouse.move(titleGeometry.x, y)
              await expect.poll(() => title.evaluate(element => element.matches(':hover'))).toBe(true)
              const hit = await title.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), {
                x: titleGeometry.x,
                y,
              })
              expect(hit).toBe(true)
              await page.mouse.click(titleGeometry.x, y)
              await menu.waitFor()
              expect(await title.getAttribute('aria-expanded')).toBe('true')
              expect(await titleBackground()).not.toBe(atRest)
              if (edge === 0) await record('menu-open')
              await page.keyboard.press('Escape')
              await menu.waitFor({ state: 'hidden' })
              expect(await title.getAttribute('aria-expanded')).toBe('false')
              await expect.poll(() => title.evaluate(element => element === document.activeElement)).toBe(true)
            }
            await page.mouse.click(1, 1)
            await title.hover()
            await pencil.hover()
            expect(await title.evaluate(element => element.matches(':focus-visible'))).toBe(false)
            await expect.poll(pencilOpacity).toBe('1')
            await expect.poll(titleBackground).toBe(atRest)
            await expect
              .poll(() => pencil.evaluate(element => getComputedStyle(element, '::before').backgroundColor))
              .not.toBe('rgba(0, 0, 0, 0)')
            await record('pencil-hover')
            await page.mouse.move(0, 0)
            await title.focus()
            await record('title-focus')
            await page.keyboard.press('Tab')
            expect(await pencil.evaluate(element => element === document.activeElement)).toBe(true)
            await expect.poll(() => pencil.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
            expect(await checkLine(false)).toEqual(initial)
            expect(await pencil.evaluate(element => element.matches(':focus-visible'))).toBe(true)
            await record('pencil-focus')
            await page.keyboard.press('Enter')
            await field.waitFor()
            expect(await field.inputValue()).toBe(short)
            await field.fill('应当取消')
            await dialog.getByRole('button', { name: '取消', exact: true }).click()
            await dialog.waitFor({ state: 'hidden' })
            await heading(short).waitFor()
            expect((await detail()).summary.title).toBe(short)
            await header.locator('.topbar-crumb-button').focus()
            await expect.poll(pencilOpacity).toBe('0')
            await record('blur')
            await title.hover()
            await pencil.click()
          }
          await field.fill(long)
          await dialog.getByRole('button', { name: '保存', exact: true }).click()
          await dialog.waitFor({ state: 'hidden' })
          await heading(long).waitFor()
          expect((await detail()).summary.title).toBe(long)

          if (phone) {
            expect(await pencil.count()).toBe(0)
            expect(await header.locator('.topbar-title-text').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
          } else {
            if (width === 1440) {
              await heading(long).hover()
              await expect.poll(() => pencil.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
              await shoot(`long-${layout}`)
              const panel = page.getByRole('button', { name: '侧边面板', exact: true })
              if ((await panel.getAttribute('aria-pressed')) !== 'true') await panel.click()
              await page.setViewportSize({ width: 1200, height })
              await page.locator('.app-shell[data-inspector="open"]').waitFor()
              await settleShell(page)
            }
            await checkLine(true)
            await heading(long).hover()
            await expect.poll(() => pencil.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
            await pencil.click()
            await field.waitFor()
            expect(await field.inputValue()).toBe(long)
            await dialog.getByRole('button', { name: '取消', exact: true }).click()
            await dialog.waitFor({ state: 'hidden' })
            expect((await detail()).summary.title).toBe(long)
          }
          await noHorizontalOverflow(page)
          await shoot(`long-${layout}`)
          if (width === 1440) {
            await page.setViewportSize({ width, height })
            await settleShell(page)
          }
        }
      } finally {
        await context.close()
      }
    }
  })
})

/**
 * The title row's ⋯ (and its title), a sidebar row's ⋯ and a phone row held down draw one menu: eight items for the open
 * session, seven for any other row. While a turn runs, 清空上下文 and 删除 stay, greyed, with today's reasons.
 */
describe('the session menu', () => {
  const OUTPUT = 'test-results/session-menu'
  // 标签… and the priorities follow the first group where the Host groups sessions (docs/DESIGN.md, 会话菜单).
  // 加入待办… since ace96eb7: a Host that keeps 待办 offers it on every Code session.
  const OPEN = [
    '重命名',
    '置顶',
    '标为未读',
    '标签…',
    '优先级',
    '加入待办…',
    '复制为 Markdown',
    '导出 Markdown',
    '清空上下文',
    '归档',
    '删除',
  ]
  const OTHER = OPEN.filter(name => name !== '清空上下文')
  let host: TestHost
  let owner: TestDevice
  let browser: Browser

  beforeAll(async () => {
    host = await startTestHost()
    owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: {
        id: 'fake-agent',
        name: 'Fake Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume,close' },
      },
    })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  const status = async (id: string) => (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status
  async function session(title: string): Promise<string> {
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'fake-agent', prompt: `echo ${title}`, requestId: randomUUID() },
    })
    await expect.poll(() => status(sessionId), { timeout: 15_000 }).toBe('idle')
    await owner.json(`tasks/${sessionId}`, { method: 'PATCH', body: { title } })
    return sessionId
  }
  /** Each item's name, and the reason under it when it is greyed. */
  const items = (menu: Locator) =>
    menu
      .locator('[role="menuitem"]')
      .evaluateAll(elements =>
        elements.map(element =>
          element.getAttribute('aria-disabled') === 'true'
            ? `${element.getAttribute('data-label')}（${element.querySelector('.ui-menu-item-reason')?.textContent ?? ''}）`
            : element.getAttribute('data-label'),
        ),
      )
  const greyed = (names: string[]) =>
    names.map(name =>
      name === '清空上下文' ? `${name}（这一轮结束后才能清空上下文）` : name === '删除' ? `${name}（运行中的会话需要先停止）` : name,
    )

  for (const [width, height, theme] of [
    [1440, 900, 'light'],
    [768, 1024, 'dark'],
    [390, 844, 'light'],
  ] as const) {
    it(`draws the same menu from the title row, the sidebar row and a phone row held down at ${width} ${theme}`, async () => {
      const phone = width < 600
      const tablet = !phone && width < 1024
      const shown = `菜单 ${width} 打开的`
      const other = `菜单 ${width} 另一个`
      const shownId = await session(shown)
      const otherId = await session(other)
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: theme,
        locale: 'zh-CN',
        reducedMotion: 'reduce',
        ...(phone ? { isMobile: true, hasTouch: true } : {}),
      })
      context.setDefaultTimeout(15_000)
      const page = await context.newPage()
      await enrollBrowser(page, host, { name: `会话菜单 ${width}` })
      await connected(page)
      const list = async () => {
        if (!tablet) return page.locator('#session-navigation')
        const drawer = page.getByRole('button', { name: '打开会话列表', exact: true })
        if ((await drawer.getAttribute('aria-expanded')) !== 'true') await drawer.click()
        await page.locator('#session-navigation.is-open').waitFor()
        await settleShell(page)
        return page.locator('#session-navigation')
      }
      const shot = async (state: string) => {
        await settleShell(page)
        await page.screenshot({ path: `${OUTPUT}/${state}--${width}--${theme}.png` })
      }
      /** Opens a menu, reads it, shoots it and closes it again. */
      const read = async (trigger: Locator, name: string, state: string) => {
        await trigger.click()
        const menu = page.getByRole('menu', { name, exact: true })
        await menu.waitFor()
        const names = await items(menu)
        await shot(state)
        if (state === 'title-idle') {
          await menu.getByRole('menuitem', { name: '优先级', exact: true }).click()
          for (const name of ['高', '中', '低']) {
            const option = page.getByRole('menuitemradio', { name, exact: true })
            expect(await option.getAttribute('aria-checked')).toBe(String(name === '中'))
          }
          await page.keyboard.press('Escape')
          await menu.getByRole('menuitem', { name: '优先级', exact: true }).waitFor()
        }
        await page.keyboard.press('Escape')
        await menu.waitFor({ state: 'hidden' })
        return names
      }
      const menus = async (running: boolean) => {
        const state = running ? 'running' : 'idle'
        const open = running ? greyed(OPEN) : OPEN
        const rest = running ? greyed(OTHER) : OTHER
        expect(await read(page.locator('.topbar .topbar-title-button'), `会话：${shown}`, `title-${state}`)).toEqual(open)
        if (phone) {
          await backToPhoneSessions(page)
          // A row held down: the context-menu gesture is the hold's stand-in here.
          const held = async (id: string, title: string) => {
            await page.locator(`.phone-row[data-task-id="${id}"]`).click({ button: 'right' })
            const sheet = page.getByRole('menu', { name: title, exact: true })
            await sheet.waitFor()
            const names = await items(sheet)
            await shot(`held-${id === shownId ? 'open' : 'other'}-${state}`)
            await page.keyboard.press('Escape')
            await sheet.waitFor({ state: 'hidden' })
            return names
          }
          // Back on the list no session is open, so its own row has seven items too.
          expect(await page.locator(`.phone-row[data-task-id="${shownId}"]`).getAttribute('aria-current')).toBeNull()
          expect(await held(shownId, shown)).toEqual(rest)
          expect(await held(otherId, other)).toEqual(OTHER)
          await page.locator(`.phone-row[data-task-id="${shownId}"]`).click()
          await page.locator('.topbar[data-phone] .topbar-title-button').waitFor()
          return
        }
        expect(
          await read(page.locator('.topbar').getByRole('button', { name: '会话操作', exact: true }), '会话操作', `more-${state}`),
        ).toEqual(open)
        const row = async (title: string) => (await list()).getByRole('button', { name: `更多操作：${title}`, exact: true })
        expect(await read(await row(shown), `会话操作：${shown}`, `row-open-${state}`)).toEqual(open)
        expect(await read(await row(other), `会话操作：${other}`, `row-other-${state}`)).toEqual(OTHER)
        if (tablet) {
          await page.keyboard.press('Escape')
          await page.locator('#session-navigation.is-open').waitFor({ state: 'detached' })
        }
      }

      if (phone) {
        await backToPhoneSessions(page)
        await page.locator(`.phone-row[data-task-id="${shownId}"]`).click()
      } else await (await list()).locator(`[data-task-id="${shownId}"]`).click()
      await page.locator('.transcript').getByText(`echo: echo ${shown}`).waitFor()
      await menus(false)
      // The menu never had 同步最新状态: a healthy connection has nothing to retry.
      expect(await page.getByRole('menuitem', { name: '同步最新状态' }).count()).toBe(0)

      await owner.json(`tasks/${shownId}/prompt`, { method: 'POST', body: { prompt: 'count 3000', requestId: randomUUID() } })
      await expect.poll(() => status(shownId)).toBe('running')
      await page.getByRole('button', { name: '停止', exact: true }).waitFor()
      await menus(true)
      // Reading the menus left the session where it was: its transcript is the same element.
      await page.locator('.transcript').getByText(`echo: echo ${shown}`).waitFor()
      await owner.json(`tasks/${shownId}/cancel`, { method: 'POST', body: {} })
      await expect.poll(() => status(shownId), { timeout: 15_000 }).not.toBe('running')
      await context.close()
    })
  }
})
