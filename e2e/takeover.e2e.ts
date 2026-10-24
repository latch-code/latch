import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { readFile, readdir, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot } from '@latch/protocol'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

describe('desktop to phone takeover', () => {
  let testHost: TestHost
  let host: TestHost['host']
  let directory: string
  let browser: Browser
  let desktop: Page
  let mobile: Page
  let phoneContext: BrowserContext
  let approvedTask: string
  beforeAll(async () => {
    testHost = await startTestHost({ demo: true, uiDir: resolve(process.env.HARNESS_E2E_UI_DIR ?? 'dist/web') })
    host = testHost.host
    directory = testHost.workspaceRoot
    browser = await chromium.launch(browserLaunchOptions())
    const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    desktopContext.setDefaultTimeout(15_000)
    desktop = await desktopContext.newPage()
    // The Host's first device; the enrollment page offers 管理此 Host by default.
    await enrollBrowser(desktop, testHost, { name: '我的电脑' })
    await connected(desktop)
    // The second device is another loopback browser with a phone viewport (phones over HTTPS need an invitation).
    phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
    phoneContext.setDefaultTimeout(15_000)
    mobile = await phoneContext.newPage()
    await enrollBrowser(mobile, testHost, { name: '我的手机' })
    await connected(mobile)
    await mkdir('test-results', { recursive: true })
    await desktop.screenshot({ path: 'test-results/desktop-empty.png', fullPage: true, animations: 'disabled' })
    await mobile.screenshot({ path: 'test-results/mobile-empty.png', fullPage: true, animations: 'disabled' })
  })
  afterAll(async () => {
    await browser?.close()
    await testHost?.close()
  })

  async function snapshot(): Promise<AppSnapshot> {
    return desktop
      .context()
      .request.get(host.origin + '/link/api/snapshot')
      .then(r => r.json())
  }
  async function choosePhone(id: string) {
    await mobile.getByRole('button', { name: '打开会话列表', exact: true }).click()
    await mobile.locator(`[data-task-id="${id}"]`).click()
    await mobile.locator('.drawer-backdrop').waitFor({ state: 'detached' })
    await expect.poll(() => mobile.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0)
  }
  async function filterSessions(page: Page, name: '全部' | '对话' | 'Agent') {
    // The filter pills unfold under the search while it is in use.
    await page.getByRole('searchbox', { name: '搜索会话', exact: true }).focus()
    await page.getByRole('group', { name: '筛选会话', exact: true }).getByRole('button', { name, exact: true }).click()
  }
  async function start(prompt: string): Promise<string> {
    const before = (await snapshot()).tasks.map(t => t.id)
    await filterSessions(desktop, '对话')
    await desktop.getByRole('button', { name: '新建会话', exact: true }).click()
    // The device remembers its last mode; demo tasks that use tools need Agent.
    await desktop.getByRole('radiogroup', { name: '会话模式' }).getByRole('radio', { name: 'Agent', exact: true }).click()
    await desktop.getByRole('textbox', { name: '新会话消息' }).fill(prompt)
    await desktop.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(async () => (await snapshot()).tasks.filter(t => !before.includes(t.id)).length).toBe(1)
    const id = (await snapshot()).tasks.find(t => !before.includes(t.id))!.id
    await desktop.locator(`[data-task-id="${id}"]`).waitFor()
    expect(await desktop.locator('[data-session-filter]').getAttribute('data-session-filter')).toBe('all')
    return id
  }

  it('contains mobile navigation focus and restores it on Escape without disabling desktop navigation', async () => {
    const opener = mobile.getByRole('button', { name: '打开会话列表', exact: true })
    try {
      await opener.focus()
      await opener.press('Enter')
      await mobile.getByRole('dialog', { name: '会话导航', exact: true }).waitFor()
      expect(await mobile.locator('.workspace').evaluate(element => (element as HTMLElement).inert)).toBe(true)
      await expect
        .poll(() => mobile.locator('.sidebar').evaluate(element => element.contains(document.activeElement)), { timeout: 2_000 })
        .toBe(true)
      await mobile.keyboard.press('Shift+Tab')
      expect(await mobile.locator('.sidebar').evaluate(element => element.contains(document.activeElement))).toBe(true)
      await mobile.keyboard.press('Tab')
      expect(await mobile.locator('.sidebar').evaluate(element => element.contains(document.activeElement))).toBe(true)
      await mobile.keyboard.press('Escape')
      await expect.poll(() => opener.getAttribute('aria-expanded')).toBe('false')
      await expect.poll(() => opener.evaluate(element => element === document.activeElement), { timeout: 2_000 }).toBe(true)
      expect(await mobile.locator('.workspace').evaluate(element => (element as HTMLElement).inert)).toBe(false)
      expect(await mobile.locator('.sidebar').evaluate(element => (element as HTMLElement).inert)).toBe(true)
      expect(await desktop.locator('.workspace').evaluate(element => (element as HTMLElement).inert)).toBe(false)
      expect(await desktop.locator('.sidebar').evaluate(element => (element as HTMLElement).inert)).toBe(false)
    } finally {
      if ((await mobile.locator('#session-navigation').getAttribute('aria-modal')) === 'true') {
        await mobile.locator('.sidebar').getByRole('button', { name: '关闭会话列表', exact: true }).click()
      }
    }
  })

  it('starts on desktop, approves on phone, and shows the same real result after reconnect', async () => {
    approvedTask = await start('批准生成验收报告')
    await choosePhone(approvedTask)
    await mobile.getByRole('button', { name: '允许一次', exact: true }).waitFor()
    await desktop.getByRole('button', { name: '允许一次', exact: true }).waitFor()
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const button = await mobile.getByRole('button', { name: '允许一次', exact: true }).boundingBox()
    expect(button!.x).toBeGreaterThanOrEqual(0)
    expect(button!.x + button!.width).toBeLessThanOrEqual(390)
    expect(button!.y).toBeGreaterThanOrEqual(0)
    expect(button!.y + button!.height).toBeLessThanOrEqual(844)
    expect(
      await mobile.getByRole('button', { name: '允许一次', exact: true }).evaluate(element => {
        const rect = element.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return hit !== null && element.contains(hit)
      }),
    ).toBe(true)
    const composer = await mobile.locator('.composer').boundingBox()
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(844)
    await mobile.screenshot({ path: 'test-results/mobile-approval.png', fullPage: true, animations: 'disabled' })
    await phoneContext.setOffline(true)
    expect((await snapshot()).tasks.find(t => t.id === approvedTask)?.status).toBe('waiting-approval')
    await phoneContext.setOffline(false)
    await mobile.reload()
    await mobile.getByRole('button', { name: '允许一次', exact: true }).waitFor()
    await mobile.getByRole('button', { name: '允许一次', exact: true }).click()
    await expect.poll(async () => (await snapshot()).tasks.find(t => t.id === approvedTask)?.status).toBe('idle')
    await desktop.locator('[data-approval-id]').waitFor({ state: 'detached' })
    const desktopDetail = await desktop
      .context()
      .request.get(host.origin + `/link/api/tasks/${approvedTask}`)
      .then(r => r.json())
    const mobileDetail = await phoneContext.request.get(host.origin + `/link/api/tasks/${approvedTask}`).then(r => r.json())
    expect(mobileDetail).toEqual(desktopDetail)
    const files = await readdir(join(directory, 'artifacts'))
    const report = files.find(file => file.includes(approvedTask) && file.startsWith('report-'))!
    expect(report).toBeTruthy()
    expect((await readFile(join(directory, 'artifacts', report), 'utf8')).length).toBeGreaterThan(0)
    await desktop.getByText(/审批已通过，报告已写入/).waitFor()
    await desktop.screenshot({ path: 'test-results/desktop-result.png', fullPage: true, animations: 'disabled' })
    await mobile.screenshot({ path: 'test-results/mobile-result.png', fullPage: true, animations: 'disabled' })
    await desktop.emulateMedia({ colorScheme: 'dark' })
    await desktop.screenshot({ path: 'test-results/desktop-dark.png', fullPage: true, animations: 'disabled' })
    await desktop.emulateMedia({ colorScheme: 'light' })

    const tabletContext = await browser.newContext({
      viewport: { width: 768, height: 1024 },
      storageState: await desktop.context().storageState(),
    })
    try {
      const tablet = await tabletContext.newPage()
      tablet.setDefaultTimeout(15_000)
      await tablet.goto(host.origin + '/link/')
      await connected(tablet)
      // Tablets keep a rail; the session list slides over.
      await tablet.getByRole('button', { name: '打开会话列表', exact: true }).click()
      await tablet.locator(`[data-task-id="${approvedTask}"]`).click()
      await tablet.getByText(/审批已通过，报告已写入/).waitFor()
      expect(await tablet.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const tabletComposer = await tablet.locator('.composer').boundingBox()
      expect(tabletComposer!.y + tabletComposer!.height).toBeLessThanOrEqual(1024)
      await tablet.screenshot({ path: 'test-results/tablet-result.png', fullPage: true, animations: 'disabled' })
    } finally {
      await tabletContext.close()
    }
  })

  it('keeps a task running while the phone is offline and cancels the actual tool after reconnect', async () => {
    const id = await start('运行可取消长任务')
    await choosePhone(id)
    await expect
      .poll(async () => {
        const detail = await host.bridge.detail(id)
        return detail.messages.some(m => m.role === 'tool' && m.state === 'running')
      })
      .toBe(true)
    await phoneContext.setOffline(true)
    await new Promise(resolveDelay => setTimeout(resolveDelay, 400))
    expect((await snapshot()).tasks.find(t => t.id === id)?.status).toBe('running')
    await phoneContext.setOffline(false)
    await mobile.reload()
    await mobile.getByRole('button', { name: '取消任务', exact: true }).waitFor()
    await mobile.getByRole('button', { name: '取消任务', exact: true }).click()
    await expect.poll(async () => (await snapshot()).tasks.find(t => t.id === id)?.status).toBe('cancelled')
    expect((await readdir(join(directory, 'artifacts'))).some(file => file.includes(id) && file.startsWith('completion-'))).toBe(false)
    const detail = await host.bridge.detail(id)
    expect(new Set(detail.messages.map(m => m.id)).size).toBe(detail.messages.length)
    await mobile.reload()
    await mobile.locator('.topbar .ui-status-pill', { hasText: '已取消' }).waitFor()
    expect((await host.bridge.detail(id)).messages).toEqual(detail.messages)
    await mobile.screenshot({ path: 'test-results/mobile-cancelled.png', fullPage: true, animations: 'disabled' })
  })

  it('creates a tool-free conversation from the real mode selector', async () => {
    const before = (await snapshot()).tasks.map(task => task.id)
    await filterSessions(desktop, 'Agent')
    await desktop.getByRole('button', { name: '新建会话', exact: true }).click()
    await desktop.getByRole('radiogroup', { name: '会话模式' }).getByRole('radio', { name: '对话', exact: true }).click()
    await desktop.getByRole('textbox', { name: '新会话消息' }).fill('批准生成验收报告')
    await desktop.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(async () => (await snapshot()).tasks.filter(task => !before.includes(task.id)).length).toBe(1)
    const task = (await snapshot()).tasks.find(task => !before.includes(task.id))!
    await desktop.locator(`[data-task-id="${task.id}"]`).waitFor()
    expect(await desktop.locator('[data-session-filter]').getAttribute('data-session-filter')).toBe('all')
    expect(task.mode).toBe('chat')
    await expect.poll(async () => (await host.bridge.detail(task.id)).summary.status).toBe('idle')
    const detail = await host.bridge.detail(task.id)
    expect(detail.messages.some(message => message.role === 'assistant')).toBe(true)
    expect(detail.messages.some(message => message.role === 'tool')).toBe(false)
    expect(detail.approvals).toEqual([])
    expect((await readdir(join(directory, 'artifacts'))).some(file => file.includes(task.id))).toBe(false)
    await choosePhone(task.id)
    await mobile.getByPlaceholder(/对话模式不调用工具/).waitFor()
    await mobile.screenshot({ path: 'test-results/mobile-chat.png', fullPage: true, animations: 'disabled' })
    await desktop.getByRole('button', { name: '设置', exact: true }).click()
    await desktop.getByRole('dialog', { name: '设置', exact: true }).waitFor()
    await desktop.getByRole('tab', { name: '插件', exact: true }).click()
    await desktop.getByRole('switch').first().waitFor()
    await desktop.screenshot({ path: 'test-results/desktop-plugins.png', fullPage: true, animations: 'disabled' })
    await desktop.getByRole('button', { name: '关闭', exact: true }).click()
  })

  it('renders the built-in streaming demonstration as readable Markdown on both devices', async () => {
    const id = await start('展示流式输出')
    await desktop.getByRole('heading', { name: '一段工作，在不同设备上继续', exact: true }).waitFor()
    await expect.poll(async () => (await host.bridge.detail(id)).summary.status, { timeout: 10_000 }).toBe('idle')
    await desktop.getByRole('button', { name: '复制代码', exact: true }).waitFor()
    expect(await desktop.locator('.message-content table').count()).toBe(1)
    await desktop.locator('.message-code').scrollIntoViewIfNeeded()
    await desktop.screenshot({ path: 'test-results/desktop-rich-result.png', fullPage: true, animations: 'disabled' })
    await choosePhone(id)
    await mobile.getByRole('heading', { name: '一段工作，在不同设备上继续', exact: true }).waitFor()
    await mobile.locator('.message-code').scrollIntoViewIfNeeded()
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await mobile.screenshot({ path: 'test-results/mobile-rich-result.png', fullPage: true, animations: 'disabled' })
  })
})
