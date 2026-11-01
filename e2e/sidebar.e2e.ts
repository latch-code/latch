import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

/**
 * The sidebar from 1024px: dragging its edge, double-click reset, the keyboard steps and snapping shut (sliding, not
 * jumping), with the width remembered on this device and the conversation never narrower than 480; the title row's title moving one way as the column shuts and opens.
 */
describe('resizable sidebar', () => {
  let testHost: TestHost
  let browser: Browser
  let context: BrowserContext
  let page: Page

  beforeAll(async () => {
    testHost = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
    browser = await chromium.launch(browserLaunchOptions())
    // The slides are checked frame by frame, so the system's motion setting must not turn them off.
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      reducedMotion: 'no-preference',
    })
    context.setDefaultTimeout(15_000)
    page = await context.newPage()
    await enrollBrowser(page, testHost, { name: '侧栏验收' })
  })

  afterAll(async () => {
    await context?.close()
    await browser?.close()
    await testHost?.close()
  })

  /** The panel's width; shut, its track is empty. */
  const sidebarWidth = () => page.locator('#session-navigation').evaluate(element => Math.round(element.getBoundingClientRect().width))
  const SHUT = 0
  const paperWidth = () => page.locator('main.workspace').evaluate(element => Math.round(element.getBoundingClientRect().width))
  const handle = () => page.getByRole('separator', { name: '调整侧栏宽度', exact: true })
  /** Drags the handle by `dx` from its centre, as a person does: press, move in steps, release. */
  async function drag(dx: number): Promise<void> {
    // The handle slides with the column when it opens or shuts: press it where it has come to rest, not where it was.
    await handle().evaluate(element =>
      Promise.all(
        element.getAnimations().map(animation =>
          animation.finished.catch(() => {
            // A cancelled slide has stopped moving too.
          }),
        ),
      ),
    )
    const box = (await handle().boundingBox())!
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx / 2, y, { steps: 4 })
    await page.mouse.move(x + dx, y, { steps: 4 })
    await page.mouse.up()
  }
  async function reload(): Promise<void> {
    await page.reload()
    await connected(page)
  }
  /** Samples `measure` once a frame from just before `act` until `ms` after it. */
  async function frames(measure: string, act: () => Promise<void>, ms = 600): Promise<number[]> {
    const sampled = page.evaluate(
      ([selector, duration]) =>
        new Promise<number[]>(done => {
          const element = document.querySelector(selector)!
          const values = [Math.round(element.getBoundingClientRect().width)]
          const end = performance.now() + duration
          const tick = () => {
            values.push(Math.round(element.getBoundingClientRect().width))
            if (performance.now() < end) requestAnimationFrame(tick)
            else done(values)
          }
          requestAnimationFrame(tick)
        }),
      [measure, ms] as const,
    )
    await act()
    return sampled
  }
  /** The title's left edge once a frame, from just before a click on the button named `label` until 500ms after it. */
  function titleWhileToggling(label: string): Promise<number[]> {
    return page.evaluate(
      name =>
        new Promise<number[]>(done => {
          const title = document.querySelector('.topbar-title')!
          const lefts = [Math.round(title.getBoundingClientRect().left)]
          const end = performance.now() + 500
          const tick = () => {
            lefts.push(Math.round(title.getBoundingClientRect().left))
            if (performance.now() < end) requestAnimationFrame(tick)
            else done(lefts)
          }
          document.querySelector<HTMLElement>(`[aria-label="${name}"]`)!.click()
          requestAnimationFrame(tick)
        }),
      label,
    )
  }

  it('follows a drag, remembers the width and resets on a double click', async () => {
    expect(await sidebarWidth()).toBe(248)
    await expect.poll(() => handle().getAttribute('aria-valuenow')).toBe('248')
    await drag(60)
    await expect.poll(sidebarWidth).toBe(308)
    // The text under the drag is not selected, and the page is no longer marked as resizing once released.
    expect(await page.evaluate(() => getSelection()?.toString() ?? '')).toBe('')
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-resizing'))).toBe(false)
    await reload()
    expect(await sidebarWidth()).toBe(308)
    await drag(400)
    await expect.poll(sidebarWidth).toBe(400)
    await handle().dblclick()
    await expect.poll(sidebarWidth).toBe(248)
    await reload()
    expect(await sidebarWidth()).toBe(248)
  })

  it('steps with the arrow keys, goes to the ends with Home and End, and shuts and opens with Enter', async () => {
    await handle().focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => handle().getAttribute('aria-valuenow')).toBe('256')
    await page.keyboard.press('Shift+ArrowLeft')
    await expect.poll(() => handle().getAttribute('aria-valuenow')).toBe('224')
    await page.keyboard.press('Home')
    await expect.poll(sidebarWidth).toBe(220)
    await page.keyboard.press('End')
    await expect.poll(sidebarWidth).toBe(400)
    await page.keyboard.press('Enter')
    await page.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
    await expect.poll(sidebarWidth).toBe(SHUT)
    expect(await page.locator('#session-navigation').evaluate(element => element instanceof HTMLElement && element.inert)).toBe(true)
    await page.keyboard.press('Enter')
    await expect.poll(sidebarWidth).toBe(400)
    await handle().dblclick()
    await expect.poll(sidebarWidth).toBe(248)
  })

  it('snaps shut when dragged past 160 and opens again at its last width, from the top bar or by dragging the edge', async () => {
    await drag(-20)
    await expect.poll(sidebarWidth).toBe(228)
    await drag(-200)
    await page.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
    await expect.poll(sidebarWidth).toBe(SHUT)
    await reload()
    await page.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
    await expect.poll(sidebarWidth).toBe(228)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('收起侧栏')
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
    await page.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
    // The global command palette opens without changing the remembered sidebar state.
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
    await palette.waitFor()
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('搜索会话、文件、Harness 和命令')
    await page.keyboard.press('Escape')
    await palette.waitFor({ state: 'detached' })
    await page.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
    // From the window's edge, the shut column is dragged open.
    await drag(250)
    await expect.poll(sidebarWidth).toBe(250)
    await page.locator('.app-shell[data-sidebar="open"]').waitFor()
    await handle().dblclick()
    await expect.poll(sidebarWidth).toBe(248)
  })

  it('slides shut when a drag passes the snap point and slides open when a drag pulls it out again', async () => {
    expect(await sidebarWidth()).toBe(248)
    // Widths that follow the pointer are never under 220, so a frame between the inset and 200 is the column sliding.
    const sliding = (widths: number[]) => widths.filter(width => width > SHUT + 8 && width < 200)
    const shutting = await frames('#session-navigation', () => drag(-200))
    await page.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
    await expect.poll(sidebarWidth).toBe(SHUT)
    expect(sliding(shutting).length).toBeGreaterThan(0)
    const opening = await frames('#session-navigation', () => drag(300))
    await page.locator('.app-shell[data-sidebar="open"]').waitFor()
    await expect.poll(sidebarWidth).toBe(300)
    expect(sliding(opening).length).toBeGreaterThan(0)
    await handle().dblclick()
    await expect.poll(sidebarWidth).toBe(248)
  })

  it('moves the top bar title one way while the sidebar shuts and opens, never jumping back', async () => {
    const shutting = await titleWhileToggling('收起侧栏')
    await page.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
    // The opener and 新建会话 unfold with the track, so the title only ever moves left, then only ever right.
    expect(shutting.at(-1)!).toBeLessThan(shutting[0])
    expect(shutting.every((left, index) => index === 0 || left <= shutting[index - 1] + 1)).toBe(true)
    await page.getByRole('button', { name: '展开侧栏', exact: true }).waitFor()
    const opening = await titleWhileToggling('展开侧栏')
    await page.locator('.app-shell[data-sidebar="open"]').waitFor()
    expect(opening.at(-1)!).toBeGreaterThan(opening[0])
    expect(opening.every((left, index) => index === 0 || left >= opening[index - 1] - 1)).toBe(true)
    expect(opening.at(-1)).toBe(shutting[0])
    // Open, the top bar's copies are out of the way: hidden from the accessibility tree and not focusable.
    expect(await page.getByRole('button', { name: '展开侧栏', exact: true }).count()).toBe(0)
  })

  it('keeps one remembered width and the conversation at least 480 wide', async () => {
    await drag(80)
    await expect.poll(sidebarWidth).toBe(328)
    await page.setViewportSize({ width: 1100, height: 900 })
    await expect.poll(sidebarWidth).toBe(328)
    await drag(400)
    await expect.poll(sidebarWidth).toBe(400)
    await page.setViewportSize({ width: 1024, height: 900 })
    await expect.poll(sidebarWidth).toBe(400)
    expect(await paperWidth()).toBeGreaterThanOrEqual(480)
    await page.setViewportSize({ width: 1440, height: 900 })
    await handle().dblclick()
    await expect.poll(sidebarWidth).toBe(248)
  })
})

/**
 * The session panel against a Host whose list says what is really happening: read rows on one line, 等你处理 ahead of the
 * projects with what waits, honest status words, folding, and the row actions. The list is rewritten on its way to the
 * page, so a silent run needs no waiting.
 */
describe('session panel', () => {
  let testHost: TestHost
  let browser: Browser
  let page: Page
  let frozen = false

  const now = () => new Date(Date.now()).toISOString()
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const base = { updatedAt: ago(3_600_000), harnessId: 'standard', mode: 'agent' as const }
  const tasks = () => [
    { ...base, id: 'read', title: '已读会话', status: 'idle', branch: 'main' },
    { ...base, id: 'failed', title: '失败会话', status: 'failed', branch: 'deps' },
    { ...base, id: 'stopped', title: '已停的会话', status: 'cancelled', runOutcome: 'cancelled' },
    {
      ...base,
      id: 'forced',
      title: '强制停止的会话',
      status: 'interrupted',
      runEnd: { reason: 'forced-stop', at: now(), unknownResultCount: 2 },
    },
    {
      ...base,
      id: 'running',
      title: '运行中的会话',
      status: 'running',
      branch: 'main',
      live: { runId: 'r1', activity: 'model', since: ago(1000), runStartedAt: ago(72_000), lastEventAt: now() },
    },
    {
      ...base,
      id: 'stopping',
      title: '停止中的会话',
      status: 'running',
      live: { runId: 'r2', activity: 'cancelling', since: ago(1000), lastEventAt: now() },
    },
    {
      ...base,
      id: 'silent',
      title: '没有动静的会话',
      status: 'running',
      live: { runId: 'r3', activity: 'model', since: ago(180_000), lastEventAt: ago(180_000), silent: true },
    },
    { ...base, id: 'waiting', title: '等你的会话', status: 'waiting-approval' },
  ]

  beforeAll(async () => {
    testHost = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
    browser = await chromium.launch(browserLaunchOptions())
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    context.setDefaultTimeout(15_000)
    page = await context.newPage()
    await page.route('**/link/api/snapshot*', async route => {
      if (frozen) return route.abort('connectionreset')
      const response = await route.fetch()
      const snapshot = (await response.json()) as Record<string, unknown>
      await route.fulfill({ response, json: { ...snapshot, tasks: tasks() } })
    })
    await enrollBrowser(page, testHost, { name: '会话面板验收' })
    await page.locator('[data-task-id="read"]').waitFor()
  })

  afterAll(async () => {
    await browser?.close()
    await testHost?.close()
  })

  const row = (id: string) => page.locator(`.session-item:has([data-task-id="${id}"])`)
  const height = (id: string) => row(id).evaluate(element => Math.round(element.getBoundingClientRect().height))

  it('gathers what waits ahead of the projects, with a neutral count and the word in each row', async () => {
    const shelves = page.locator('nav.session-list .session-group')
    await expect.poll(() => shelves.first().getAttribute('data-shelf')).toBe('waiting')
    const waiting = shelves.first()
    expect(
      await waiting.locator('[data-task-id]').evaluateAll(rows => rows.map(item => item.getAttribute('data-task-id')).toSorted()),
    ).toEqual(['silent', 'waiting'])
    expect(await waiting.locator('.shelf-count').textContent()).toBe('2')
    // The tab says what the shelf says.
    expect(await page.title()).toBe('(2) Latch')
    // The shelf says it waits, so the row keeps the word and loses the shield.
    const word = row('waiting').locator('.ui-status-word')
    expect(await word.getAttribute('data-tone')).toBe('warn')
    expect(await word.textContent()).toBe('等你处理')
    expect(await word.locator('svg').count()).toBe(0)
    expect(await row('silent').locator('.ui-status-word').textContent()).toBe('没有动静 3 分钟')
    // Header rows have no hairline: nothing draws a line under a shelf's head.
    expect(await waiting.locator('.shelf-head').evaluate(head => getComputedStyle(head).borderBottomStyle)).toBe('none')
  })

  it('keeps a read session to one line with the metadata in muted, and gives the others a second', async () => {
    expect(await height('read')).toBe(32)
    expect(await row('read').locator('.session-meta').count()).toBe(0)
    // The status slot's time carries the muted ink, never the fainter one.
    const muted = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--muted)'
      document.body.append(probe)
      const value = getComputedStyle(probe).color
      probe.remove()
      return value
    })
    expect(
      await row('read')
        .locator('.ui-status-time')
        .evaluate(item => getComputedStyle(item).color),
    ).toBe(muted)
    expect(await row('read').locator('.session-item-main').getAttribute('title')).toContain('main')
    for (const id of ['running', 'failed', 'waiting', 'silent', 'stopping', 'forced']) expect(await height(id)).toBe(52)
    expect(await row('running').locator('.session-meta').textContent()).toContain('Latch 内置')
    expect(await row('running').locator('.session-meta').textContent()).toContain('main')
  })

  it('says only what the Host said: the whole run on the clock, 正在停止 until settled, then 已停止', async () => {
    await expect.poll(() => row('running').locator('.ui-status-word').textContent()).toMatch(/^运行中 1:1\d$/)
    expect(await row('stopping').locator('.ui-status-word').textContent()).toBe('正在停止')
    expect(await row('stopped').locator('.ui-status-word').textContent()).toBe('已停止')
    expect(await height('stopped')).toBe(32)
    expect(await row('forced').locator('.ui-status-word').textContent()).toBe('已强制停止')
    expect(await row('forced').locator('.session-meta').textContent()).toContain('2 条结果未知')
  })

  it('changes a running row at most once a second', async () => {
    const changes = await row('running')
      .locator('.ui-status-word')
      .evaluate(
        word =>
          new Promise<number[]>(done => {
            const at: number[] = []
            const observer = new MutationObserver(() => at.push(performance.now()))
            observer.observe(word, { subtree: true, childList: true, characterData: true })
            setTimeout(() => {
              observer.disconnect()
              done(at)
            }, 3500)
          }),
      )
    expect(changes.length).toBeGreaterThan(0)
    for (let index = 1; index < changes.length; index++) expect(changes[index]! - changes[index - 1]!).toBeGreaterThan(800)
  })

  it('folds a shelf and remembers it on this device', async () => {
    const shelf = page.locator('.session-group[data-shelf="other"]')
    const toggle = shelf.locator('.shelf-toggle')
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    await shelf.locator('.shelf-count').waitFor()
    await row('read').waitFor({ state: 'hidden' })
    await page.reload()
    await connected(page)
    await expect.poll(() => shelf.locator('.shelf-toggle').getAttribute('aria-expanded')).toBe('false')
    await shelf.locator('.shelf-toggle').click()
    await row('read').waitFor()
  })

  it('swaps the status for 归档 and ⋯ on hover', async () => {
    await row('read').hover()
    await expect
      .poll(() =>
        row('read')
          .locator('.session-actions')
          .evaluate(item => getComputedStyle(item).opacity),
      )
      .toBe('1')
    await expect
      .poll(() =>
        row('read')
          .locator('.session-status')
          .evaluate(item => getComputedStyle(item).opacity),
      )
      .toBe('0')
    await row('read').getByRole('button', { name: '归档：已读会话', exact: true }).waitFor()
    await row('read').getByRole('button', { name: '更多操作：已读会话', exact: true }).waitFor()
    await page.locator('.topbar').hover()
  })

  it('opens the palette from 搜索', async () => {
    await page.locator('.sidebar-top').getByRole('button', { name: '搜索', exact: true }).click()
    const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
    await palette.waitFor()
    await page.keyboard.press('Escape')
    await palette.waitFor({ state: 'detached' })
  })

  it('draws nothing live while the connection is down, only when it last knew', async () => {
    frozen = true
    await page.context().setOffline(true)
    await row('running').locator('.session-frozen').waitFor()
    expect(await row('running').locator('.session-frozen').textContent()).toMatch(/^上次确认 \d\d:\d\d$/)
    expect(await row('running').locator('.ui-spinner').count()).toBe(0)
    expect(await row('waiting').locator('.ui-status-word').count()).toBe(0)
    // Frozen, what waits still stands out from what merely ran.
    expect(await row('waiting').evaluate(item => item.classList.contains('is-strong'))).toBe(true)
    expect(await row('running').evaluate(item => item.classList.contains('is-strong'))).toBe(false)
    await row('failed').locator('.ui-status-word', { hasText: '失败' }).waitFor()
    await page.context().setOffline(false)
    frozen = false
    await row('running').locator('.ui-spinner').waitFor()
  })
})

describe('a notification ahead of the page', () => {
  it('reaches the request of a session the page lists but has not yet seen ask', async () => {
    const plugin: HarnessPlugin = {
      id: 'asking-model',
      name: 'Asking fixture',
      version: '1',
      description: 'Only local test responses.',
      activate(context) {
        context.registerProvider({
          id: 'asking-model',
          name: 'Asking fixture',
          model: 'fixture',
          async *stream() {
            yield { type: 'tool-call', call: { id: randomUUID(), name: 'write_report', arguments: {} } }
            yield { type: 'finish', reason: 'tool-calls' }
          },
        })
      },
    }
    const host = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'), plugins: [plugin] })
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '请求批准', mode: 'agent', model: { providerId: 'asking-model', model: 'fixture' }, requestId: randomUUID() },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + sessionId)).approvals.length, { timeout: 10_000 }).toBe(1)
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      const name = '通知验收'
      await enrollBrowser(page, host, { name, scopes: ['view', 'run', 'approve:standard'] })
      const deviceId = host.host.security.devices.list().find(device => device.name === name)!.id
      expect((await owner.confirmed('devices/' + deviceId, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await page.addInitScript(() => {
        const notifications = {
          subscribe: (callback: (id: string) => void) => {
            Reflect.set(window, 'notificationClick', callback)
            return () => {}
          },
        }
        Object.defineProperty(window, 'latchShell', { value: { kind: 'electron', devMode: false, platform: 'darwin', notifications } })
      })
      let behind = true
      await page.route('**/link/api/snapshot*', async route => {
        const reading = behind
        const response = await route.fetch()
        const snapshot = (await response.json()) as AppSnapshot
        if (!reading) {
          // The answer comes after the click has been handled, as it does over any real connection.
          await new Promise(done => setTimeout(done, 400))
          return route.fulfill({ response, json: snapshot })
        }
        const tasks = snapshot.tasks.map(task => (task.id === sessionId ? { ...task, status: 'running' as const } : task))
        return route.fulfill({ response, json: { ...snapshot, tasks, approvals: [] } })
      })
      await page.reload()
      await page.locator(`[data-task-id="${sessionId}"]`).waitFor()
      behind = false
      await page.evaluate(id => (Reflect.get(window, 'notificationClick') as (id: string) => void)(id), sessionId)
      await page.locator(`[data-task-id="${sessionId}"][aria-current="page"]`).waitFor()
      await page.locator('.transcript [data-approval-target]').waitFor()
    } finally {
      await browser.close()
      await host.close()
    }
  })
})
