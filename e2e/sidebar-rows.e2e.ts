import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const OUT = 'test-results/sidebar-rows'
const LONG_MODEL = 'a-very-long-model-identifier-from-a-model-service-2026-11-11-preview'

/**
 * Every sidebar row is two lines: the title with the time or what the run is doing, then the Harness's 12px mark and
 * the model. In 等你处理 the second line says what waits from the summary alone. The list is rewritten on its way to the
 * page around one real session, which the page can open.
 */
describe('sidebar rows', () => {
  let host: TestHost
  let browser: Browser
  let realId = ''

  const now = () => new Date().toISOString()
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const base = { updatedAt: ago(3_600_000), harnessId: 'standard', mode: 'agent' as const }
  const fakes = () => [
    {
      ...base,
      id: 'command',
      title: '跑测试的会话',
      status: 'running',
      model: 'deepseek-chat',
      live: { runId: 'r1', activity: 'command', since: ago(1000), runStartedAt: ago(42_000), lastEventAt: now() },
    },
    {
      ...base,
      id: 'routed',
      title: '经服务的会话',
      harnessId: 'codex',
      status: 'running',
      model: 'gpt-5.5',
      modelRoute: { providerId: 'moonshot', model: 'kimi-k2.5' },
      live: { runId: 'r2', activity: 'model', since: ago(1000), runStartedAt: ago(4000), lastEventAt: now() },
    },
    {
      ...base,
      id: 'approval',
      title: '等批准的会话',
      harnessId: 'claude-agent',
      status: 'waiting-approval',
      cwd: '/Users/me/secret-place',
      model: 'claude-sonnet-5-5',
    },
    { ...base, id: 'asking', title: '有问题的会话', harnessId: 'opencode', status: 'running', pendingQuestions: 2 },
    { ...base, id: 'failed', title: '失败的会话', harnessId: 'gemini', status: 'failed', model: 'gemini-3-pro' },
    { ...base, id: 'read', title: '已读的会话', status: 'idle', model: 'deepseek-chat', branch: 'main' },
    { ...base, id: 'unread', title: '有新内容的会话', status: 'idle', model: 'deepseek-chat', updatedAt: now() },
    { ...base, id: 'unreported', title: '还没报告模型的会话', harnessId: 'qwen', status: 'idle' },
    { ...base, id: 'long', title: '模型名很长的会话', status: 'idle', model: LONG_MODEL },
  ]

  beforeAll(async () => {
    host = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
    browser = await chromium.launch(browserLaunchOptions())
    const owner = await host.enroll({ listener: 'unix' })
    realId = (
      await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '选中的会话', mode: 'chat', requestId: randomUUID() },
      })
    ).sessionId
    for (let tries = 0; (await owner.json<TaskDetail>('tasks/' + realId)).summary.status !== 'idle'; tries++) {
      if (tries > 200) throw new Error('the demo reply did not settle')
      await new Promise(done => setTimeout(done, 50))
    }
    await owner.json('tasks/' + realId, { method: 'PATCH', body: { title: '选中的会话' } })
    await mkdir(OUT, { recursive: true })
  })

  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  async function open(width: number, height: number, colorScheme: 'light' | 'dark'): Promise<Page> {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', reducedMotion: 'reduce', colorScheme })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    await page.route('**/link/api/snapshot*', async route => {
      const response = await route.fetch()
      const snapshot = (await response.json()) as AppSnapshot
      // Before the page has connected the Host answers with an error, which goes through as it is.
      if (!Array.isArray(snapshot.tasks)) return route.fulfill({ response })
      await route.fulfill({ response, json: { ...snapshot, tasks: [...snapshot.tasks, ...fakes()] } })
    })
    await enrollBrowser(page, host, { name: `侧栏行 ${width} ${colorScheme}` })
    // The first visit sets this device's reading baseline; after a reload the session updated since is unread.
    await page.reload()
    await connected(page)
    await page.locator('[data-task-id="read"]').waitFor()
    return page
  }

  const row = (page: Page, id: string) => page.locator(`.session-item:has([data-task-id="${id}"])`)

  it('draws every row on two lines with the Harness mark and the model', async () => {
    const page = await open(1440, 900, 'light')
    try {
      for (const id of [realId, 'command', 'routed', 'approval', 'asking', 'failed', 'read', 'unread', 'unreported', 'long']) {
        expect(await row(page, id).evaluate(item => Math.round(item.getBoundingClientRect().height))).toBe(52)
        expect(await row(page, id).locator('.session-meta .session-mark > *').count()).toBe(1)
      }
      // The mark is 12 on the screen.
      const mark = await row(page, 'routed')
        .locator('.session-mark')
        .evaluate(item => Math.round(item.getBoundingClientRect().height))
      expect(mark).toBe(12)
      // The model: the routed one, else the reported one, else 默认模型 until an external Harness reports one.
      expect(await row(page, 'routed').locator('.session-model').textContent()).toBe('kimi-k2.5')
      expect(await row(page, 'read').locator('.session-model').textContent()).toBe('deepseek-chat')
      expect(await row(page, 'unreported').locator('.session-model').textContent()).toBe('默认模型')
      expect(
        await row(page, 'read')
          .locator('.session-model')
          .evaluate(item => getComputedStyle(item).fontFamily),
      ).toMatch(/mono|Menlo/iu)
      // A brand's mark says which Harness; the neutral glyph needs the name beside it.
      expect(await row(page, 'routed').locator('.session-harness').count()).toBe(0)
      expect(await row(page, 'read').locator('.session-harness').count()).toBe(0)
      expect(await row(page, 'approval').locator('.session-harness').textContent()).toBe('claude-agent')
      // The branch and 「Latch 内置」 left the line; the branch is in the row's tooltip.
      expect(await row(page, 'read').locator('.session-meta').textContent()).not.toContain('main')
      expect(await row(page, 'read').locator('.session-meta').textContent()).not.toContain('Latch 内置')
      expect(await row(page, 'read').locator('.session-item-main').getAttribute('title')).toContain('main')
      // The screen reader still hears the Harness, the model, the status and the time.
      expect(await row(page, 'command').locator('.sr-only').textContent()).toMatch(/^，Latch 内置，deepseek-chat，在跑命令，/u)
    } finally {
      await page.context().close()
    }
  })

  it('says what the run is doing from the activity in the summary', async () => {
    const page = await open(1440, 900, 'light')
    try {
      await expect.poll(() => row(page, 'command').locator('.ui-status-word').textContent()).toMatch(/^在跑命令 0:4\d$/u)
      await expect.poll(() => row(page, 'routed').locator('.ui-status-word').textContent()).toMatch(/^在等模型 0:0\d$/u)
    } finally {
      await page.context().close()
    }
  })

  it('says in 等你处理 only the kind of wait and the Harness, never a path or what the request does', async () => {
    const page = await open(1440, 900, 'light')
    try {
      const waiting = page.locator('.session-group[data-shelf="waiting"]')
      expect(
        await waiting.locator('[data-task-id]').evaluateAll(rows => rows.map(item => item.getAttribute('data-task-id')).toSorted()),
      ).toEqual(['approval', 'asking'])
      expect(await row(page, 'approval').locator('.session-wait').textContent()).toBe('审批')
      expect(await row(page, 'asking').locator('.session-wait').textContent()).toBe('2 个问题')
      expect(await row(page, 'approval').locator('.session-model').count()).toBe(0)
      expect(await row(page, 'approval').locator('.session-meta').textContent()).not.toContain('secret-place')
      // The shelf says it waits: the row's first line keeps the time, not a second 等你处理.
      expect(await row(page, 'approval').locator('.ui-status-word').count()).toBe(0)
      await row(page, 'approval').locator('.ui-status-time').waitFor()
      expect(await row(page, 'approval').evaluate(item => item.classList.contains('is-strong'))).toBe(true)
    } finally {
      await page.context().close()
    }
  })

  it('cuts a long model short in the narrowest sidebar without widening the row', async () => {
    const page = await open(1440, 900, 'light')
    try {
      await page.getByRole('separator', { name: '调整侧栏宽度', exact: true }).focus()
      await page.keyboard.press('Home')
      await expect
        .poll(() => page.locator('#session-navigation').evaluate(item => Math.round(item.getBoundingClientRect().width)))
        .toBe(220)
      const model = row(page, 'long').locator('.session-model')
      expect(await model.evaluate(item => item.scrollWidth > item.clientWidth)).toBe(true)
      const [right, list] = await Promise.all([
        row(page, 'long').evaluate(item => item.getBoundingClientRect().right),
        page.locator('nav.session-list').evaluate(item => item.getBoundingClientRect().right),
      ])
      expect(right).toBeLessThanOrEqual(list)
      expect(await page.locator('nav.session-list').evaluate(item => item.scrollWidth <= item.clientWidth)).toBe(true)
      await page.locator('#session-navigation').screenshot({ path: `${OUT}/narrow--1440--light.png`, animations: 'disabled' })
    } finally {
      await page.context().close()
    }
  })

  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
  ] as const)
    for (const theme of ['light', 'dark'] as const)
      it(`draws running, waiting, failed, read, unread, selected and hovered rows at ${width} in ${theme}`, async () => {
        const page = await open(width, height, theme)
        try {
          await page.locator(`[data-task-id="${realId}"]`).click()
          await page.locator(`[data-task-id="${realId}"][aria-current="page"]`).waitFor()
          await expect.poll(() => row(page, 'unread').getAttribute('class')).toMatch(/\bis-unread\b/u)
          await row(page, 'read').hover()
          await expect
            .poll(() =>
              row(page, 'read')
                .locator('.session-actions')
                .evaluate(item => getComputedStyle(item).opacity),
            )
            .toBe('1')
          await page.locator('#session-navigation').screenshot({ path: `${OUT}/sidebar--${width}--${theme}.png`, animations: 'disabled' })
        } finally {
          await page.context().close()
        }
      })
})
