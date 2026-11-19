import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail, TaskSummary } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const OUTPUT = 'test-results/composer-status'
const BRANCH = 'feat/enroll-check-and-a-branch-name-long-enough-to-be-cut'
const OPENAI = { id: 'openai', name: 'OpenAI', kind: 'openai-responses', models: ['gpt-5.5'], defaultModel: 'gpt-5.5' }

/**
 * A session's input has no status row: where it works is the title row's, what it used is the line under the input, a
 * cost stays with who reported it, and only a route that needs saying is said under the input. A draft still shows where it
 * would work. A fake ACP agent reports the context window and the tokens; what no fake reports (a cost, a branch, a
 * route through a service) is written onto the session on its way to the page.
 */
describe('the composer without a status line', () => {
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let planned = ''

  const detail = (id: string) => owner.json<TaskDetail>(`tasks/${id}`)
  /** Waits for the session to settle; a plain loop, since it also runs before the tests. */
  async function settled(id: string): Promise<void> {
    for (let tries = 0; (await detail(id)).summary.status !== 'idle'; tries++) {
      if (tries > 300) throw new Error('the session did not settle')
      await new Promise(done => setTimeout(done, 50))
    }
  }
  const status = (page: Page) => page.locator('form.composer .composer-status')
  const shot = (page: Page, name: string) => page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled' })

  beforeAll(async () => {
    host = await startTestHost()
    owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'fake-agent', name: 'Fake Agent', command: process.execPath, args: [FAKE_ACP_AGENT] },
    })
    planned = (
      await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId: 'fake-agent', prompt: 'plan', requestId: randomUUID() },
      })
    ).sessionId
    await settled(planned)
    await owner.json(`tasks/${planned}`, { method: 'PATCH', body: { title: '状态行的会话' } })
    // A Git project on main, for a draft's folder and branch.
    const project = join(host.root, 'latch-demo')
    await mkdir(project)
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
        cwd: project,
        stdio: 'pipe',
      })
    git('init', '-q')
    await writeFile(join(project, 'README.md'), '# latch-demo\n')
    git('add', '-A')
    git('commit', '-qm', 'first')
    expect((await owner.addFolders({ paths: [project] })).ok).toBe(true)
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  /**
   * A page enrolled on the Host, on the session titled `title` when one is given. `rewrite` changes a session on its way
   * to the page, in the snapshot and in its detail, and adds the services it names to the catalog.
   */
  async function open(
    width: number,
    theme: 'light' | 'dark',
    options: { title?: string; rewrite?: { id: string; summary: Partial<TaskSummary>; detail?: Partial<TaskDetail> } } = {},
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme,
      reducedMotion: 'reduce',
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const { rewrite } = options
    if (rewrite) {
      await page.route('**/link/api/snapshot*', async route => {
        const response = await route.fetch()
        const snapshot = (await response.json()) as AppSnapshot
        if (!Array.isArray(snapshot.tasks)) return route.fulfill({ response })
        const tasks = snapshot.tasks.map(task => (task.id === rewrite.id ? { ...task, ...rewrite.summary } : task))
        const catalog = snapshot.catalog && { ...snapshot.catalog, providers: [...snapshot.catalog.providers, OPENAI] }
        await route.fulfill({ response, json: { ...snapshot, tasks, ...(catalog ? { catalog } : {}) } })
      })
      await page.route(
        url => url.pathname.endsWith(`/api/tasks/${rewrite.id}`),
        async route => {
          if (route.request().method() !== 'GET') return route.fallback()
          const response = await route.fetch()
          const body = (await response.json()) as TaskDetail
          await route.fulfill({ response, json: { ...body, ...rewrite.detail, summary: { ...body.summary, ...rewrite.summary } } })
        },
      )
    }
    try {
      const name = `状态行 ${width} ${theme} ${randomUUID().slice(0, 4)}`
      await enrollBrowser(page, host, { name })
      // It sees project files, so the draft offers @ mentions; a narrower device says it cannot.
      const devices = await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')
      const id = devices.devices.find(item => item.name === name)!.id
      expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await page.reload()
      await connected(page)
    } catch (error) {
      await shot(page, `failed-enroll-${width}-${theme}`)
      throw error
    }
    if (options.title) await go(page, options.title)
    return { context, page }
  }
  async function go(page: Page, title: string): Promise<void> {
    await page.keyboard.press('Meta+k')
    const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
    await palette.getByRole('searchbox').fill(title)
    await palette.getByRole('option').first().click()
    await page.getByRole('textbox', { name: '继续对话', exact: true }).waitFor()
  }

  /** The line under the session's input: what the whole session did and used. */
  async function usageLine(page: Page): Promise<string> {
    const line = page.locator('.vitals-strip').locator('visible=true').first()
    await line.getByText('tok', { exact: false }).first().waitFor()
    return (await line.innerText()).replace(/\s+/gu, ' ').trim()
  }

  it('draws no status row in a session’s input, and says what the fake agent reported once, on the line under it', async () => {
    for (const [width, theme] of [
      [1440, 'light'],
      [1440, 'dark'],
      [768, 'light'],
    ] as const) {
      const { context, page } = await open(width, theme, { title: '状态行的会话' })
      try {
        // Where it works is the title row's; nothing is repeated under the input, and nothing stands before its text.
        expect(await status(page).count()).toBe(0)
        expect(await page.locator('form.composer [data-seg]').count()).toBe(0)
        expect(await page.locator('.composer-usage, .composer-context, form.composer .composer-prompt, .status-clock').count()).toBe(0)
        expect(await page.locator('form.composer .composer-notice[data-tint="warn"]').count()).toBe(0)
        const form = page.locator('form.composer')
        expect(await form.evaluate(item => item.lastElementChild?.classList.contains('composer-toolbar'))).toBe(true)
        await shot(page, `a-session-input--${width}--${theme}`)
        const words = await usageLine(page)
        expect(words).toMatch(/^1 轮 30 tok 10%$/u)
        await noHorizontalOverflow(page)
        await shot(page, `a-usage-menu--${width}--${theme}`)
        await page.keyboard.press('Escape')
      } finally {
        await context.close()
      }
    }
  })

  it('keeps a cost with who reported it in the project’s popover, and warns under the input only for a route that needs saying', async () => {
    const usage = { inputTokens: 212_000, outputTokens: 9400 }
    const usageReport = { contextUsed: 84_000, contextSize: 272_000, cost: { amount: 0.21, currency: 'USD' }, at: new Date().toISOString() }
    const fine = await open(1440, 'light', {
      title: '状态行的会话',
      rewrite: {
        id: planned,
        summary: { branch: BRANCH, usage, modelRoute: { providerId: 'openai', model: 'gpt-5.5', name: 'OpenAI' } },
        detail: { usageReport },
      },
    })
    try {
      const { page } = fine
      expect(await status(page).count()).toBe(0)
      // A route that works says nothing under the input.
      expect(await page.locator('form.composer .composer-notice').count()).toBe(0)
      const words = await usageLine(page)
      expect(words).toContain('221k tok')
      expect(words).toMatch(/31%$/u)
      // The line never carries a cost: a cost needs who reported it.
      expect(words).not.toContain('US$')
      await shot(page, 'a-usage-menu-cost--1440--light')
      await page.keyboard.press('Escape')
      // The branch is the title row's, whole.
      expect(await page.locator('.topbar .topbar-session-branch').locator('visible=true').first().textContent()).toBe(BRANCH)
      await page.locator('.topbar .topbar-crumb-button').locator('visible=true').first().click()
      await page.getByText('由 Fake Agent 报告，不是账单', { exact: false }).locator('visible=true').first().waitFor()
      expect(await page.locator('.crumb-body').innerText()).toContain('US$0.21')
      await shot(page, 'a-project-popover-cost--1440--light')
    } finally {
      await fine.context.close()
    }
    const bypassed = await open(1440, 'light', {
      title: '状态行的会话',
      rewrite: {
        id: planned,
        summary: { usage, modelRoute: { providerId: 'openai', model: 'gpt-5.5', name: 'OpenAI', bypassed: true } },
        detail: { usageReport },
      },
    })
    try {
      const { page } = bypassed
      const note = page.locator('form.composer .composer-notice[data-tint="warn"]')
      await note.getByText('有一轮没经过 Latch', { exact: true }).waitFor()
      expect(await status(page).count()).toBe(0)
      await noHorizontalOverflow(page, page.locator('form.composer'))
      await shot(page, 'a-route-warning--1440--light')
    } finally {
      await bypassed.context.close()
    }
  })

  it('keeps a phone’s input full width below the chips and above the send row, with no status line', async () => {
    for (const [width, theme] of [
      [390, 'light'],
      [390, 'dark'],
      [320, 'light'],
    ] as const) {
      const { context, page } = await open(width, theme, { title: '状态行的会话' })
      try {
        const form = page.locator('form.composer').filter({ visible: true })
        expect(await status(page).count()).toBe(0)
        expect(await form.locator('.composer-chips, .composer-line, [data-rows], .composer-prompt').count()).toBe(0)
        expect(await form.getByRole('button', { name: '／', exact: true }).count()).toBe(0)
        // The full-width text over one line: the Harness and the one entry, then send, all inside the frame.
        const line = form.locator('.composer-toolbar')
        expect(await line.locator('[data-composer-control]').count()).toBe(2)
        const [frameBox, lineBox, inputBox, sendBox, entryBox] = await Promise.all([
          form.boundingBox(),
          line.boundingBox(),
          form.locator('textarea').boundingBox(),
          line.locator('.send-button').boundingBox(),
          line.locator('[data-composer-control="model"]').boundingBox(),
        ])
        expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(lineBox!.y + 1)
        expect(inputBox!.width).toBeGreaterThan(frameBox!.width - 20)
        expect(Math.abs(entryBox!.y + entryBox!.height / 2 - (sendBox!.y + sendBox!.height / 2))).toBeLessThan(2)
        expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(frameBox!.x + frameBox!.width)
        expect(await line.locator('.send-button').getAttribute('aria-label')).toBe('发送')
        await noHorizontalOverflow(page)
        if (width === 390) await shot(page, `phone-composer--390--${theme}`)
      } finally {
        await context.close()
      }
    }
  })

  it('shows a draft where it would work and which way its model goes, and nothing it has not used', async () => {
    for (const [width, theme] of [
      [1440, 'light'],
      [1440, 'dark'],
      [768, 'light'],
    ] as const) {
      const { context, page } = await open(width, theme)
      try {
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await input.waitFor()
        expect(await input.getAttribute('placeholder')).toBe('想让 Agent 做什么？')
        await page
          .getByRole('button', { name: /^Harness：/u })
          .first()
          .click()
        await page
          .getByRole('menuitemradio', { name: /Fake Agent/u })
          .first()
          .click()
        // No project: the headline asks 想做什么？ with 选一个项目 under it, and never 选择项目.
        const headline = page.locator('.home-headline')
        expect(await headline.innerText()).toContain('想做什么？')
        expect(await headline.innerText()).toContain('选一个项目')
        expect(await page.getByText('选择项目', { exact: true }).count()).toBe(0)
        expect(await page.locator('.home-place').innerText()).toBe('')
        expect(await status(page).locator('visible=true').count()).toBe(0)
        expect(
          await page
            .locator('form.composer [data-seg="context"], form.composer [data-seg="tokens"], form.composer [data-seg="cost"]')
            .count(),
        ).toBe(0)
        await shot(page, `a-new-no-project--${width}--${theme}`)
        // The headline names the project; the line under the input has its folder choice and its branch.
        await page
          .getByRole('button', { name: /^项目：/u })
          .first()
          .click()
        await page
          .getByRole('menuitemradio', { name: /latch-demo/u })
          .first()
          .click()
        await expect.poll(() => headline.innerText()).toContain('latch-demo')
        const location = page.locator('.home-place')
        await expect.poll(() => location.innerText()).toContain('main')
        expect(await location.innerText()).toContain('当前文件夹')
        // The folder choice is whole in the line: its arrow comes after its words.
        const [words, arrow] = await location
          .locator('[data-seg="folder"]')
          .locator('.ui-value-picker')
          .evaluate(picker => [
            picker.querySelector('.ui-value-picker-text[data-shown]')!.getBoundingClientRect().right,
            picker.querySelector('.ui-value-picker-chevron')!.getBoundingClientRect().left,
          ])
        expect(arrow).toBeGreaterThanOrEqual(words!)
        await noHorizontalOverflow(page, location)
        await shot(page, `a-new--${width}--${theme}`)
      } finally {
        await context.close()
      }
    }
  })

  it('places the shared decision card above the composer, which has no status line', async () => {
    // Connecting a device needs the Mac's confirmation, which an external Harness's waiting session holds back: connect first.
    const pages = [
      { width: 1440, theme: 'light' as const, ...(await open(1440, 'light')) },
      { width: 1440, theme: 'dark' as const, ...(await open(1440, 'dark')) },
      { width: 390, theme: 'light' as const, ...(await open(390, 'light')) },
    ]
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'fake-agent', prompt: 'permission', requestId: randomUUID() },
    })
    try {
      await expect.poll(async () => (await detail(sessionId)).approvals.length, { timeout: 15_000 }).toBe(1)
      await owner.json(`tasks/${sessionId}`, { method: 'PATCH', body: { title: '等审批的会话' } })
      for (const { width, theme, page } of pages) {
        await go(page, '等审批的会话')
        const card = page.locator('.composer-drawers > .approval-panel')
        await card.waitFor()
        await page.waitForTimeout(400)
        const [drawer, form] = await Promise.all([
          card.evaluate(item => item.getBoundingClientRect().toJSON() as DOMRect),
          page.locator('form.composer').evaluate(item => item.getBoundingClientRect().toJSON() as DOMRect),
        ])
        // The card keeps its own edge, rather than the retired drawer/composer joint.
        expect(Math.round(drawer.width)).toBe(Math.round(form.width))
        expect(Math.round(form.top - drawer.bottom)).toBeGreaterThanOrEqual(7)
        expect(await page.locator('form.composer').evaluate(item => getComputedStyle(item).borderTopLeftRadius)).toBe('16px')
        expect(await card.evaluate(item => getComputedStyle(item).borderBottomLeftRadius)).toBe('16px')
        // A session's input has no line under it, on any width.
        expect(await status(page).count()).toBe(0)
        await shot(page, `a-approval--${width}--${theme}`)
      }
    } finally {
      for (const { context } of pages) await context.close()
      await owner.json(`tasks/${sessionId}/cancel`, { method: 'POST', body: {} }).catch(() => undefined)
    }
  })
})
