import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { readFile, readdir, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot } from '@latch/protocol'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { backToPhoneSessions, openEntry, openSessions, openSession } from './helpers/layout.ts'

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
    testHost = await startTestHost({ demo: true, uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
    host = testHost.host
    directory = testHost.workspaceRoot
    browser = await chromium.launch(browserLaunchOptions())
    const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    desktopContext.setDefaultTimeout(15_000)
    desktop = await desktopContext.newPage()
    // The Host's first device; its invitation allows 管理此 Host.
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
  /** A phone opens a session from its list, the root page: the session's page is pushed over the list. */
  async function choosePhone(id: string) {
    await openSession(mobile, id)
    await mobile.locator('.phone-list[data-covered]').waitFor()
    // The page has slid into place.
    await mobile.locator('main.workspace').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)))
  }
  async function start(prompt: string): Promise<string> {
    const before = (await snapshot()).tasks.map(t => t.id)
    await desktop.getByRole('button', { name: '新建会话', exact: true }).click()
    await desktop.getByRole('textbox', { name: '新会话消息' }).fill(prompt)
    await desktop.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(async () => (await snapshot()).tasks.filter(t => !before.includes(t.id)).length).toBe(1)
    const id = (await snapshot()).tasks.find(t => !before.includes(t.id))!.id
    await desktop.locator(`[data-task-id="${id}"]`).waitFor()
    expect(await desktop.locator('[data-session-filter]').getAttribute('data-session-filter')).toBe('all')
    return id
  }

  it('contains mobile navigation focus and restores it on Escape without disabling desktop navigation', async () => {
    // The session list slides over on tablets; phones open it as their root page instead.
    const tabletContext = await browser.newContext({
      viewport: { width: 768, height: 1024 },
      isMobile: true,
      hasTouch: true,
      storageState: await desktop.context().storageState(),
    })
    try {
      const tablet = await tabletContext.newPage()
      tablet.setDefaultTimeout(15_000)
      await tablet.goto(host.origin + '/link/')
      await connected(tablet)
      const opener = tablet.getByRole('button', { name: '打开会话列表', exact: true })
      await opener.focus()
      await opener.press('Enter')
      await tablet.getByRole('dialog', { name: '会话导航', exact: true }).waitFor()
      expect(await tablet.locator('.workspace').evaluate(element => (element as HTMLElement).inert)).toBe(true)
      await expect
        .poll(() => tablet.locator('.sidebar').evaluate(element => element.contains(document.activeElement)), { timeout: 2_000 })
        .toBe(true)
      await tablet.keyboard.press('Shift+Tab')
      expect(await tablet.locator('.sidebar').evaluate(element => element.contains(document.activeElement))).toBe(true)
      await tablet.keyboard.press('Tab')
      expect(await tablet.locator('.sidebar').evaluate(element => element.contains(document.activeElement))).toBe(true)
      await tablet.keyboard.press('Escape')
      await expect.poll(() => opener.getAttribute('aria-expanded')).toBe('false')
      await expect.poll(() => opener.evaluate(element => element === document.activeElement), { timeout: 2_000 }).toBe(true)
      await tablet.locator('.workbench-home').waitFor()
      expect(await tablet.locator('.workbench-home').evaluate(element => element.closest('[inert]') !== null)).toBe(false)
      expect(await tablet.locator('.workspace').evaluate(element => (element as HTMLElement).inert)).toBe(true)
      expect(await tablet.locator('.sidebar').evaluate(element => (element as HTMLElement).inert)).toBe(true)
      expect(await desktop.locator('.workbench-home').evaluate(element => element.closest('[inert]') !== null)).toBe(false)
      expect(await desktop.locator('.workspace').evaluate(element => (element as HTMLElement).inert)).toBe(true)
      expect(await desktop.locator('.sidebar').evaluate(element => (element as HTMLElement).inert)).toBe(false)
      // A phone starts on Home, then opens history as its own page, with no drawer.
      expect(await mobile.locator('.workbench-home').evaluate(element => element.closest('[inert]') !== null)).toBe(false)
      await backToPhoneSessions(mobile)
      expect(await mobile.locator('.sidebar').count()).toBe(0)
      expect(await mobile.locator('#session-navigation').evaluate(element => element instanceof HTMLElement && element.inert)).toBe(false)
    } finally {
      await tabletContext.close()
    }
  })

  it('starts on desktop, approves on phone, and shows the same real result after reconnect', async () => {
    approvedTask = await start('批准生成验收报告')
    await choosePhone(approvedTask)
    await mobile.getByRole('button', { name: '允许', exact: true }).waitFor()
    await desktop.getByRole('button', { name: '允许', exact: true }).waitFor()
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const button = await mobile.getByRole('button', { name: '允许', exact: true }).boundingBox()
    expect(button!.x).toBeGreaterThanOrEqual(0)
    expect(button!.x + button!.width).toBeLessThanOrEqual(390)
    expect(button!.y).toBeGreaterThanOrEqual(0)
    expect(button!.y + button!.height).toBeLessThanOrEqual(844)
    expect(
      await mobile.getByRole('button', { name: '允许', exact: true }).evaluate(element => {
        const rect = element.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return hit !== null && element.contains(hit)
      }),
    ).toBe(true)
    const composer = await mobile.locator('.composer').filter({ visible: true }).boundingBox()
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(844)
    await mobile.screenshot({ path: 'test-results/mobile-approval.png', fullPage: true, animations: 'disabled' })
    await phoneContext.setOffline(true)
    expect((await snapshot()).tasks.find(t => t.id === approvedTask)?.status).toBe('waiting-approval')
    await phoneContext.setOffline(false)
    await mobile.reload()
    await mobile.getByRole('button', { name: '允许', exact: true }).waitFor()
    await mobile.getByRole('button', { name: '允许', exact: true }).click()
    await expect.poll(async () => (await snapshot()).tasks.find(t => t.id === approvedTask)?.status).toBe('idle')
    await desktop.locator('[data-approval-id]').waitFor({ state: 'detached' })
    // The Host goes on noting the run's files after it goes idle, so two reads may straddle a change; they must agree once it rests.
    await vi.waitFor(
      async () => {
        const read = (context: BrowserContext) => context.request.get(host.origin + `/link/api/tasks/${approvedTask}`).then(r => r.json())
        expect(await read(phoneContext)).toEqual(await read(desktop.context()))
      },
      { timeout: 15_000, interval: 250 },
    )
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
      const tabletComposer = await tablet.locator('.composer').filter({ visible: true }).boundingBox()
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
    const { runId } = await host.bridge.summary(id)
    await mobile.getByRole('button', { name: '停止', exact: true }).waitFor()
    await mobile.getByRole('button', { name: '停止', exact: true }).click()
    await expect.poll(async () => (await snapshot()).tasks.find(t => t.id === id)?.status).toBe('cancelled')
    // The page named the run it showed, and the Host kept the receipt with the session for a retry. The receipt is
    // written after the run settles, so the session can show 已取消 a moment before it.
    const receipts = async () => {
      const meta = JSON.parse(await readFile(join(testHost.dataDir, 'sessions-meta.json'), 'utf8').catch(() => '{"sessions":[]}')) as {
        sessions: Array<{ id: string; receipts?: Array<Record<string, unknown>> }>
      }
      return meta.sessions.find(session => session.id === id)?.receipts
    }
    await expect
      .poll(receipts)
      .toEqual([expect.objectContaining({ kind: 'cancel', runId, outcome: 'stopped', status: 'cancelled', requestId: expect.any(String) })])
    expect((await readdir(join(directory, 'artifacts'))).some(file => file.includes(id) && file.startsWith('completion-'))).toBe(false)
    const detail = await host.bridge.detail(id)
    expect(new Set(detail.messages.map(m => m.id)).size).toBe(detail.messages.length)
    await mobile.reload()
    await mobile.locator('.topbar .ui-status-word', { hasText: '已停止' }).waitFor()
    expect((await host.bridge.detail(id)).messages).toEqual(detail.messages)
    await mobile.screenshot({ path: 'test-results/mobile-cancelled.png', fullPage: true, animations: 'disabled' })
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
