import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { tooltipText } from './helpers/layout.ts'

const OUT = 'test-results/sidebar-rows'
const LONG_MODEL = 'a-very-long-model-identifier-from-a-model-service-2026-11-11-preview'

/** The v8 project tree keeps a complete status glyph and title; Home carries live words and attention evidence. */
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
    { ...base, id: 'failed', title: '失败的会话', harnessId: 'qwen', status: 'failed', model: 'qwen3-coder' },
    { ...base, id: 'read', title: '已读的会话', status: 'idle', model: 'deepseek-chat', branch: 'main' },
    { ...base, id: 'unread', title: '有新内容的会话', status: 'idle', model: 'deepseek-chat', updatedAt: now() },
    { ...base, id: 'returning', title: '等待交回的会话', status: 'idle' },
    { ...base, id: 'unreported', title: '还没报告模型的会话', harnessId: 'qwen', status: 'idle' },
    { ...base, id: 'long', title: '模型名很长的会话，包含完整的服务与实验分支名称', status: 'idle', model: LONG_MODEL },
  ]

  beforeAll(async () => {
    host = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'), hostName: '验收电脑' })
    browser = await chromium.launch({ ...browserLaunchOptions(), ignoreDefaultArgs: ['--hide-scrollbars'] })
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
      await route.fulfill({
        response,
        json: {
          ...snapshot,
          tasks: [...snapshot.tasks, ...fakes()],
          handoffs: [
            ...(snapshot.handoffs ?? []),
            {
              id: 'handoff-return',
              sourceSessionId: realId,
              targetSessionId: 'returning',
              status: 'started',
              returnScope: 'summary',
              updatedAt: now(),
            },
          ],
        },
      })
    })
    await enrollBrowser(page, host, { name: `侧栏行 ${width} ${colorScheme}` })
    // The first visit sets this device's reading baseline; after a reload the session updated since is unread.
    await page.reload()
    await connected(page)
    await page.locator('[data-task-id="read"]').waitFor()
    return page
  }

  const row = (page: Page, id: string) => page.locator(`.session-item:has([data-task-id="${id}"])`)

  it('keeps a slim thumb and lets a drag start in its transparent edge', async () => {
    const page = await open(1280, 420, 'dark')
    try {
      const list = page.locator('nav.session-list')
      const { right, top, viewportWidth, target, ink, length } = await list.evaluate(element => {
        const bar = getComputedStyle(element, '::-webkit-scrollbar')
        const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb')
        const box = element.getBoundingClientRect()
        const target = Number.parseFloat(bar.width)
        return {
          right: box.right,
          top: box.top,
          viewportWidth: element.clientWidth,
          target,
          ink: target - Number.parseFloat(thumb.borderLeftWidth) - Number.parseFloat(thumb.borderRightWidth),
          length: element.clientHeight ** 2 / element.scrollHeight,
        }
      })
      expect(target).toBe(10)
      expect(ink).toBe(4)
      const x = right - target + 1
      const y = top + length / 2
      await page.mouse.move(x, y)
      expect(await list.evaluate(element => element.clientWidth)).toBe(viewportWidth)
      await page.mouse.down()
      await page.mouse.move(x, y + 40, { steps: 5 })
      await page.mouse.up()
      await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    } finally {
      await page.context().close()
    }
  })

  it('draws complete compact status glyphs while keeping Harness, model and branch accessible', async () => {
    const page = await open(1440, 900, 'light')
    try {
      for (const id of [realId, 'command', 'routed', 'approval', 'asking', 'failed', 'read', 'unread', 'unreported', 'long']) {
        const item = row(page, id)
        expect(await item.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(34)
        expect(await item.locator('.session-row-glyph').isVisible()).toBe(true)
        expect(await item.locator('.session-meta').isVisible()).toBe(false)
        expect(await item.locator('.session-status').isVisible()).toBe(false)
      }
      // The leading icon is each session's Harness; its state is a 10px mark on the icon's corner.
      const marks: Record<string, RegExp> = { routed: /codex/u, approval: /claude/u, failed: /qwen/u, asking: /opencode/u }
      for (const [id, file] of Object.entries(marks))
        expect(await row(page, id).locator('.session-row-glyph img').first().getAttribute('src')).toMatch(file)
      expect(await row(page, 'read').locator('.session-row-glyph .brand-tile').isVisible()).toBe(true)
      expect(
        Math.round(
          (await row(page, 'routed').locator('.session-row-glyph .brand-tile, .session-row-glyph .ui-tile').first().boundingBox())!.height,
        ),
      ).toBe(16)
      const glyph = row(page, 'routed').locator('.session-row-glyph .session-row-state .ui-spinner')
      expect(Math.round((await glyph.boundingBox())!.height)).toBe(10)
      expect(await row(page, 'failed').locator('.session-row-glyph').getAttribute('data-tone')).toBe('failed')
      expect(await row(page, 'read').locator('.session-row-state').count()).toBe(0)
      // A routed model is authoritative over the Harness-reported default, including in the accessible row name.
      expect(await row(page, 'routed').locator('.session-item-main').ariaSnapshot()).toContain('kimi-k2.5')
      expect(await row(page, 'routed').locator('.session-item-main').ariaSnapshot()).not.toContain('gpt-5.5')
      expect(await row(page, 'read').locator('.session-item-main').ariaSnapshot()).toContain('deepseek-chat')
      // A session that reported no model names none, anywhere: no guess, not even 默认模型.
      expect(await row(page, 'unreported').locator('.session-item-main').ariaSnapshot()).not.toContain('默认模型')
      const hover = (id: string) => tooltipText(page, row(page, id).locator('.session-item-main'))
      expect(await hover('unreported')).toBe('还没报告模型的会话 · qwen')
      // The hover shows the full title, the Harness, the current model and its route or branch.
      expect(await hover('routed')).toBe('经服务的会话 · codex · kimi-k2.5 · 经 Latch 网关')
      expect(await hover('approval')).toBe('等批准的会话 · claude-agent · claude-sonnet-5-5')
      expect(await hover('read')).toBe('已读的会话 · Latch 内置 · deepseek-chat · main')
      expect(await row(page, 'command').locator('.sr-only').textContent()).toMatch(/^，Latch 内置，deepseek-chat，在跑命令，/u)
      expect(await row(page, 'approval').locator('.session-item-main').ariaSnapshot()).toContain('claude-agent')
    } finally {
      await page.context().close()
    }
  })

  it.each(['light', 'dark'] as const)('keeps a pending handoff return visible in the compact tree in %s', async theme => {
    const page = await open(1440, 900, theme)
    try {
      const item = row(page, 'returning')
      const label = item.locator('.session-line .session-handoff')
      expect(await label.isVisible()).toBe(true)
      expect(await label.textContent()).toBe('待交回')
      const line = (await item.locator('.session-line').boundingBox())!
      const box = (await label.boundingBox())!
      expect(box.x + box.width).toBeLessThanOrEqual(line.x + line.width)
      expect(box.y + box.height).toBeLessThanOrEqual(line.y + line.height)
      expect(await item.locator('.session-item-main').ariaSnapshot()).toContain('待交回')
      expect(await item.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(34)
      await page.screenshot({ path: `${OUT}/return-${theme}.png`, animations: 'disabled' })
    } finally {
      await page.context().close()
    }
  })

  // The 总览 home that listed sessions went in cae787a4 (docs/DESIGN.md 起始页: one input and a line of counts); the
  // same words stand on the session's row.
  it('says what the run is doing from the activity in the summary', async () => {
    const page = await open(1440, 900, 'light')
    try {
      const command = row(page, 'command')
      const routed = row(page, 'routed')
      await expect.poll(() => command.locator('.ui-status-word').textContent()).toMatch(/^在跑命令 0:4\d$/u)
      await expect.poll(() => routed.locator('.ui-status-word').textContent()).toMatch(/^在等模型 0:0\d$/u)
    } finally {
      await page.context().close()
    }
  })

  // The 总览 home's request list went in cae787a4 (看板 shows the Host's groups now, board.e2e): the rows keep the
  // attention, and no unverified summary path becomes evidence anywhere on the page.
  it('keeps attention on the rows, and never turns an unverified summary path into request evidence', async () => {
    const page = await open(1440, 900, 'light')
    try {
      expect(await page.locator('body').innerText()).not.toContain('secret-place')
      expect(await row(page, 'approval').locator('.session-item-main').ariaSnapshot()).toContain('等你处理')
      expect(await row(page, 'asking').locator('.session-item-main').ariaSnapshot()).toContain('等你处理')
      expect(await row(page, 'approval').locator('.session-row-glyph').getAttribute('data-tone')).toBe('waiting')
      expect(await row(page, 'approval').evaluate(item => item.classList.contains('is-strong'))).toBe(true)
    } finally {
      await page.context().close()
    }
  })

  it('keeps long names within the narrowest tree while preserving the full model in its accessible name', async () => {
    const page = await open(1440, 900, 'light')
    try {
      // With room for all three icons, hovering a row shows 置顶, 归档 and ⋯, and 置顶 toggles in place.
      const real = row(page, realId)
      await real.hover()
      const pin = real.getByRole('button', { name: '置顶：选中的会话', exact: true })
      await expect.poll(() => pin.isVisible()).toBe(true)
      await expect.poll(() => real.getByRole('button', { name: '归档：选中的会话', exact: true }).isVisible()).toBe(true)
      await expect.poll(() => real.getByRole('button', { name: '更多操作：选中的会话', exact: true }).isVisible()).toBe(true)
      await pin.click()
      const pinnedShelf = page.locator('.session-group[data-shelf="pinned"]')
      const unpin = pinnedShelf.getByRole('button', { name: '取消置顶：选中的会话', exact: true })
      await unpin.waitFor()
      await pinnedShelf.locator('.session-item').hover()
      await unpin.click()
      await pinnedShelf.waitFor({ state: 'detached' })

      await page.getByRole('separator', { name: '调整侧栏宽度', exact: true }).focus()
      await page.keyboard.press('Home')
      await expect
        .poll(() => page.locator('#session-navigation').evaluate(item => Math.round(item.getBoundingClientRect().width)))
        .toBe(220)
      expect(await row(page, 'long').locator('.session-model').isVisible()).toBe(false)
      expect(await row(page, 'long').locator('.session-item-main').ariaSnapshot()).toContain(LONG_MODEL)
      const long = row(page, 'long')
      expect(await tooltipText(page, long.locator('.session-item-main'))).toBe(
        `模型名很长的会话，包含完整的服务与实验分支名称 · Latch 内置 · ${LONG_MODEL}`,
      )
      const actions = long.locator('.session-actions')
      const measure = () =>
        long.evaluate(item => {
          const title = item.querySelector('.session-title')!
          const titleRect = title.getBoundingClientRect()
          const actionRect = item.querySelector('.session-actions')!.getBoundingClientRect()
          return {
            width: titleRect.width,
            titleRight: titleRect.right,
            actionLeft: actionRect.left,
            clipped: title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === 'ellipsis',
          }
        })
      const before = await measure()
      expect(before.clipped).toBe(true)
      expect(before.titleRight).toBeLessThanOrEqual(before.actionLeft)
      await long.hover()
      await expect.poll(() => actions.evaluate(item => getComputedStyle(item).opacity)).toBe('1')
      // Narrow row: only 置顶 and 归档 stay visible; ⋯ gives way while right-click still opens the same menu.
      expect(await long.locator('.session-item-pin').isVisible()).toBe(true)
      expect(await long.locator('.session-item-archive').isVisible()).toBe(true)
      expect(await long.locator('.session-item-more').isVisible()).toBe(false)
      expect(await measure()).toEqual(before)
      await long.click({ button: 'right' })
      const contextMenu = page.getByRole('menu', { name: /^会话操作：模型名很长的会话/u })
      await contextMenu.waitFor()
      await page.keyboard.press('Escape')
      await contextMenu.waitFor({ state: 'hidden' })
      await page.mouse.move(0, 0)
      await long.locator('.session-item-main').focus()
      await page.keyboard.press('Tab')
      expect(await actions.evaluate(item => item.contains(document.activeElement))).toBe(true)
      await expect.poll(() => actions.evaluate(item => getComputedStyle(item).opacity)).toBe('1')
      expect(await measure()).toEqual(before)
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
