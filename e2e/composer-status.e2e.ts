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
 * The composer's last row says where the session works, which way its model goes and what it used, only from what was
 * reported. A fake ACP agent reports the context window and the tokens; what no fake reports (a cost, a branch, a
 * route through a service) is written onto the session on its way to the page.
 */
describe('the composer status line', () => {
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
  const segment = (page: Page, kind: string) => status(page).locator(`[data-seg="${kind}"]`)
  /** The segments that are shown, each with its words. */
  const shown = (page: Page) =>
    status(page)
      .locator('[data-seg]')
      .evaluateAll(items =>
        items
          .filter(item => getComputedStyle(item).display !== 'none')
          .map(item => [item.getAttribute('data-seg'), (item as HTMLElement).innerText.replace(/\s+/gu, ' ').trim()]),
      )
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
      await enrollBrowser(page, host, { name: `状态行 ${width} ${theme} ${randomUUID().slice(0, 4)}` })
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

  it('says what the fake agent reported, with its name, and the context in cells beside its numbers', async () => {
    for (const [width, theme] of [
      [1440, 'light'],
      [1440, 'dark'],
      [768, 'light'],
    ] as const) {
      const { context, page } = await open(width, theme, { title: '状态行的会话' })
      try {
        await segment(page, 'context').waitFor()
        const segments = await shown(page)
        // A tablet's column is narrower: 用时 gives way first.
        expect(segments.map(([kind]) => kind)).toEqual(['folder', 'route', 'context', 'tokens', ...(width > 768 ? ['time'] : [])])
        expect(Object.fromEntries(segments)).toMatchObject({
          route: 'Fake Agent 自己的模型',
          context: '上下文 10 / 100',
          tokens: '输入 10 输出 20 由 Fake Agent 报告',
        })
        if (width > 768) expect(Object.fromEntries(segments).time).toMatch(/1 轮$/u)
        const meter = segment(page, 'context').getByRole('meter', { name: '上下文' })
        expect(await meter.getAttribute('aria-valuetext')).toBe('10 / 100')
        expect(await meter.locator('.ui-meter-cell[data-on]').count()).toBe(1)
        // The 50% ring and the branch under the frame are gone; the line is inside the frame, its last row.
        expect(await page.locator('.composer-usage, .composer-context').count()).toBe(0)
        expect(await status(page).evaluate(row => row === row.parentElement?.lastElementChild)).toBe(true)
        // The prompt glyph sits on the input's first line.
        expect(await page.locator('form.composer .composer-prompt').innerText()).toBe('>')
        await noHorizontalOverflow(page, status(page))
        await shot(page, `a-statusline-fake--${width}--${theme}`)
      } finally {
        await context.close()
      }
    }
  })

  it('names who reported a cost, says it is not a bill, and the route by the service’s name', async () => {
    const { context, page } = await open(1440, 'light', {
      title: '状态行的会话',
      rewrite: {
        id: planned,
        summary: {
          branch: BRANCH,
          usage: { inputTokens: 212_000, outputTokens: 9400 },
          modelRoute: { providerId: 'openai', model: 'gpt-5.5', name: 'OpenAI' },
        },
        detail: {
          usageReport: { contextUsed: 84_000, contextSize: 272_000, cost: { amount: 0.21, currency: 'USD' }, at: new Date().toISOString() },
        },
      },
    })
    try {
      // In a column wide enough, every segment; the cost always with who reported it and that it is not a bill.
      await page.locator('form.composer').evaluate(form => {
        ;(form.closest('.composer-stack') as HTMLElement).style.maxWidth = '1200px'
      })
      await segment(page, 'cost').waitFor()
      await expect
        .poll(async () => Object.fromEntries(await shown(page)))
        .toMatchObject({
          branch: BRANCH,
          route: 'OpenAI · 经 Latch',
          context: '上下文 84k / 272k',
          cost: 'US$0.21 由 Fake Agent 报告，不是账单',
        })
      // What gave way is the start of the order: 用时, then the tokens.
      expect((await shown(page)).map(([kind]) => kind)).toEqual(['folder', 'branch', 'route', 'context', 'cost'])
      await shot(page, 'a-statusline-cost-wide--1440--light')
      await page.locator('form.composer').evaluate(form => {
        ;(form.closest('.composer-stack') as HTMLElement).style.removeProperty('max-width')
      })
      // The branch is cut in the line and whole in its tooltip.
      const name = segment(page, 'branch').locator('.composer-status-value')
      expect(await name.evaluate(item => item.scrollWidth > item.clientWidth)).toBe(true)
      await segment(page, 'branch').locator('[tabindex="0"]').hover()
      await page
        .getByRole('tooltip')
        .filter({ hasText: `分支 ${BRANCH}` })
        .waitFor()
      await shot(page, 'a-statusline-cost--1440--light')

      // Narrower columns let go of 用时, then the tokens and the cost, then the route; the context stays, nothing overflows.
      const order: Array<[number, string[]]> = [
        [560, ['folder', 'branch', 'route', 'context']],
        [380, ['folder', 'branch', 'context']],
      ]
      for (const [column, kinds] of order) {
        await page.locator('form.composer').evaluate((form, px) => {
          ;(form.closest('.composer-stack') as HTMLElement).style.maxWidth = `${px}px`
        }, column)
        await expect.poll(async () => (await shown(page)).map(([kind]) => kind)).toEqual(kinds)
        await noHorizontalOverflow(page, status(page))
        if (column === 560) {
          // The four controls still share one row.
          const tops = await page
            .locator('form.composer [data-composer-control]')
            .evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().top)))
          expect(new Set(tops).size).toBe(1)
          await shot(page, 'a-statusline-560--1440--light')
        }
      }
    } finally {
      await context.close()
    }
  })

  it('keeps only the context on a phone, with its numbers', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const { context, page } = await open(390, theme, { title: '状态行的会话' })
      try {
        await segment(page, 'context').waitFor()
        expect(await shown(page)).toEqual([['context', '上下文 10 / 100']])
        await noHorizontalOverflow(page)
        await shot(page, `phone-composer--390--${theme}`)
      } finally {
        await context.close()
      }
    }
    const { context, page } = await open(320, 'light', { title: '状态行的会话' })
    try {
      await segment(page, 'context').waitFor()
      await noHorizontalOverflow(page)
    } finally {
      await context.close()
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
        expect(await input.getAttribute('placeholder')).toBe('@ 文件，/ 命令')
        await page
          .getByRole('button', { name: /^Harness：/u })
          .first()
          .click()
        await page
          .getByRole('menuitemradio', { name: /Fake Agent/u })
          .first()
          .click()
        // No project: the title offers one, and the line says only which way the model goes.
        await expect.poll(() => shown(page)).toEqual([['route', 'Fake Agent 自己的模型']])
        await shot(page, `a-new-no-project--${width}--${theme}`)
        // The title is the project; the line has its folder choice and its branch.
        await page
          .getByRole('button', { name: /^项目：/u })
          .first()
          .click()
        await page
          .getByRole('menuitemradio', { name: /latch-demo/u })
          .first()
          .click()
        await expect.poll(() => page.locator('.new-session-title').innerText()).toBe('latch-demo')
        await expect
          .poll(() => shown(page))
          .toEqual([
            ['folder', '当前文件夹'],
            ['branch', 'main'],
            ['route', 'Fake Agent 自己的模型'],
          ])
        // The folder choice is whole in the line: its arrow comes after its words.
        const [words, arrow] = await segment(page, 'folder')
          .locator('.ui-value-picker')
          .evaluate(picker => [
            picker.querySelector('.ui-value-picker-text[data-shown]')!.getBoundingClientRect().right,
            picker.querySelector('.ui-value-picker-chevron')!.getBoundingClientRect().left,
          ])
        expect(arrow).toBeGreaterThanOrEqual(words!)
        await noHorizontalOverflow(page, status(page))
        await shot(page, `a-new--${width}--${theme}`)
      } finally {
        await context.close()
      }
    }
  })

  it('joins a waiting approval to the composer with one joint, the line still the last row', async () => {
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
        // As wide as the composer, 3px above it, and the card's lower corners and the composer's upper ones small.
        expect(Math.round(drawer.width)).toBe(Math.round(form.width))
        expect(Math.round(form.top - drawer.bottom)).toBe(3)
        expect(await page.locator('form.composer').evaluate(item => getComputedStyle(item).borderTopLeftRadius)).toBe('4px')
        expect(await card.evaluate(item => getComputedStyle(item).borderBottomLeftRadius)).toBe('4px')
        // A phone has only the context, which this Harness has not reported yet: no line at all.
        if (width > 390) expect(await status(page).evaluate(row => row === row.parentElement?.lastElementChild)).toBe(true)
        else expect(await status(page).count()).toBe(0)
        await shot(page, `a-approval--${width}--${theme}`)
      }
    } finally {
      for (const { context } of pages) await context.close()
      await owner.json(`tasks/${sessionId}/cancel`, { method: 'POST', body: {} }).catch(() => undefined)
    }
  })
})
