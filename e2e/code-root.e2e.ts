import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { backToPhoneSessions, closeSettings, noHorizontalOverflow, openSection, openSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/code-root'
const NOTICE = '正在开发当前运行的 Latch，构建或重启可能影响当前使用。'

/**
 * A Host whose start directory lies inside Latch's program directory (here a temporary stand-in for it): the three
 * places that show the folder explain the effect of building or restarting it. ACP can start there or in an added project.
 */
describe('a start directory inside Latch’s program directory', () => {
  let root: string
  let testHost: TestHost
  let browser: Browser
  let context: BrowserContext
  let remote: TestDevice
  let sessionId: string
  let project: WorkspaceInfo

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'latch-code-root-')))
    await mkdir(join(root, 'repo'))
    await mkdir(join(root, 'project'))
    testHost = await startTestHost({
      demo: false,
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
      codeRoot: root,
      workspaceRoot: join(root, 'repo'),
    })
    const owner = await testHost.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      body: { id: 'fake', name: '测试 Harness', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    const added = await owner.addFolders({ name: 'Latch 源码', paths: [join(root, 'project')] })
    expect(added.status).toBe(201)
    project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace
    expect(project.codeRoot).toBe(true)
    expect(project.unavailable).toBeUndefined()
    await owner.json('preferences', {
      method: 'PUT',
      body: { defaults: { workspaceId: 'default', harnessId: 'fake', pinned: true } },
    })
    browser = await chromium.launch(browserLaunchOptions())
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    context.setDefaultTimeout(15_000)
    const enrolling: Page = await context.newPage()
    await enrollBrowser(enrolling, testHost, { name: '验收浏览器', scopes: ['admin'] })
    await enrolling.close()
    remote = await testHost.enroll({ name: '另一台浏览器' })
    const created = await remote.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '你好', requestId: randomUUID(), mode: 'agent', harnessId: 'fake' },
    })
    sessionId = created.sessionId
    for (let tries = 0; (await remote.json<TaskDetail>(`tasks/${encodeURIComponent(sessionId)}`)).summary.status !== 'idle'; tries++) {
      if (tries > 100) throw new Error('the fake ACP reply did not settle')
      await new Promise(done => setTimeout(done, 100))
    }
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await testHost?.close()
    if (root) await rm(root, { recursive: true, force: true })
  })

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'tablet', width: 900, height: 1000 },
    { name: 'phone', width: 390, height: 844 },
  ] as const) {
    it(`warns in 设置 › 项目, the new session and the session at ${viewport.name} width`, async () => {
      // Each width on a page of its own that starts at that width, as a person opening Latch there would.
      const page = await context.newPage()
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto(`${testHost.host.loopbackOrigin}/link/`)
      await connected(page)

      // 设置 › 项目: both the start directory and the saved project warn without requiring another folder.
      const settings = await openSettings(page)
      await openSection(settings, '项目')
      const notice = settings.locator('.project-code-root').filter({ hasText: 'Latch 启动时的文件夹' })
      await notice.getByText(NOTICE, { exact: false }).waitFor()
      expect(await notice.getAttribute('data-tone')).toBe('warn')
      expect(await notice.textContent()).toContain('Latch 启动时的文件夹')
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${OUTPUT}/settings-projects--${viewport.name}.png`, fullPage: true, animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.screenshot({ path: `${OUTPUT}/settings-projects--${viewport.name}--dark.png`, fullPage: true, animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'light' })
      await closeSettings(settings)

      // The new session: the composer says it before anything is sent.
      await backToPhoneSessions(page)
      await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
      await page.locator('.composer-notice', { hasText: NOTICE }).waitFor()
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${OUTPUT}/new-session--${viewport.name}.png`, fullPage: true, animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.screenshot({ path: `${OUTPUT}/new-session--${viewport.name}--dark.png`, fullPage: true, animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'light' })

      // The session that works there: the project's popover, and the panel's page on a phone.
      if (viewport.name === 'phone') {
        // The new session was the home's input: the list is one step back.
        await backToPhoneSessions(page)
        await page.locator('.phone-list').locator(`[data-task-id="${sessionId}"]`).click()
      } else {
        const navigation = page.getByRole('button', { name: '打开会话列表', exact: true })
        if (await navigation.isVisible()) await navigation.click()
        await page.locator(`[data-task-id="${sessionId}"]:visible`).first().click()
      }
      // The conversation is read in, so the capture shows it beside the warning rather than the loading line.
      await page.locator('.transcript [data-message-id]').filter({ hasText: '你好' }).first().waitFor()
      if (viewport.name === 'phone') await page.getByRole('button', { name: '侧边面板', exact: true }).click()
      else await page.locator('.topbar-crumb-button').click()
      const information =
        viewport.name === 'phone' ? page.getByRole('region', { name: '侧边面板', exact: true }) : page.locator('.ui-popover:popover-open')
      await information.getByText(NOTICE, { exact: false }).waitFor()
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${OUTPUT}/session-info--${viewport.name}.png`, fullPage: true, animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.screenshot({ path: `${OUTPUT}/session-info--${viewport.name}--dark.png`, fullPage: true, animations: 'disabled' })
      await page.close()
    })
  }

  it('sends with ACP from the default program folder and an explicitly added program project', async () => {
    const page = await context.newPage()
    try {
      await page.goto(`${testHost.host.loopbackOrigin}/link/`)
      await connected(page)
      for (const target of [
        { id: 'default', name: '不选项目', path: testHost.workspaceRoot },
        { id: project.id, name: project.name, path: project.path },
      ]) {
        await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
        await page
          .locator('.home-headline')
          .getByRole('button', { name: /^项目：/u })
          .click()
        const option = page.getByRole('menuitemradio', { name: new RegExp(target.name, 'u') })
        expect(await option.getAttribute('aria-disabled')).not.toBe('true')
        await option.click()
        await page.locator('.composer-notice', { hasText: NOTICE }).waitFor()
        const prompt = `检查 ${target.name}`
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await input.fill(prompt)
        const submitted = page.waitForResponse(
          response => response.url().endsWith('/link/api/tasks') && response.request().method() === 'POST',
        )
        await input.press('Meta+Enter')
        const response = await submitted
        expect(response.status()).toBe(201)
        expect(response.request().postDataJSON()).toMatchObject({ harnessId: 'fake', workspaceId: target.id, prompt })
        const { sessionId: created } = (await response.json()) as { sessionId: string }
        await page.locator('.transcript').getByText(`echo: ${prompt}`, { exact: true }).waitFor()
        await expect.poll(async () => (await remote.json<TaskDetail>(`tasks/${created}`)).summary.status).toBe('idle')
        const detail = await remote.json<TaskDetail>(`tasks/${created}`)
        expect(detail.summary.cwd).toBe(target.path)
        expect(detail.summary.harnessId).toBe('fake')
      }
    } finally {
      await page.close()
    }
  })
})
