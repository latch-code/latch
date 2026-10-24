import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

/**
 * The sidebar from 1024px: dragging its edge, double-click reset, the keyboard steps and snapping shut (sliding, not
 * jumping), with widths remembered on this device per breakpoint class and the conversation paper never narrower than
 * 520; the top bar's title moving one way as the column shuts and opens; and the filter pills under the search, which
 * must work where clicking a button does not focus it.
 */
describe('resizable sidebar', () => {
  let testHost: TestHost
  let browser: Browser
  let context: BrowserContext
  let page: Page

  beforeAll(async () => {
    testHost = await startTestHost({ uiDir: resolve(process.env.HARNESS_E2E_UI_DIR ?? 'dist/web') })
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

  /** The sidebar's width; shut, its track keeps only the window's 8px inset. */
  const sidebarWidth = () => page.locator('#session-navigation').evaluate(element => Math.round(element.getBoundingClientRect().width))
  const SHUT = 8
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
    expect(await sidebarWidth()).toBe(300)
    await expect.poll(() => handle().getAttribute('aria-valuenow')).toBe('300')
    await drag(60)
    await expect.poll(sidebarWidth).toBe(360)
    // The text under the drag is not selected, and the page is no longer marked as resizing once released.
    expect(await page.evaluate(() => getSelection()?.toString() ?? '')).toBe('')
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-resizing'))).toBe(false)
    await reload()
    expect(await sidebarWidth()).toBe(360)
    await drag(400)
    await expect.poll(sidebarWidth).toBe(480)
    await handle().dblclick()
    await expect.poll(sidebarWidth).toBe(300)
    await reload()
    expect(await sidebarWidth()).toBe(300)
  })

  it('steps with the arrow keys, goes to the ends with Home and End, and shuts and opens with Enter', async () => {
    await handle().focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => handle().getAttribute('aria-valuenow')).toBe('308')
    await page.keyboard.press('Shift+ArrowLeft')
    await expect.poll(() => handle().getAttribute('aria-valuenow')).toBe('276')
    await page.keyboard.press('Home')
    await expect.poll(sidebarWidth).toBe(220)
    await page.keyboard.press('End')
    await expect.poll(sidebarWidth).toBe(480)
    await page.keyboard.press('Enter')
    await page.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
    await expect.poll(sidebarWidth).toBe(SHUT)
    expect(await page.locator('#session-navigation').evaluate(element => element instanceof HTMLElement && element.inert)).toBe(true)
    await page.keyboard.press('Enter')
    await expect.poll(sidebarWidth).toBe(480)
    await handle().dblclick()
    await expect.poll(sidebarWidth).toBe(300)
  })

  it('snaps shut when dragged past 160 and opens again at its last width, from the top bar or by dragging the edge', async () => {
    await drag(-20)
    await expect.poll(sidebarWidth).toBe(280)
    await drag(-200)
    await page.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
    await expect.poll(sidebarWidth).toBe(SHUT)
    await reload()
    await page.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
    await expect.poll(sidebarWidth).toBe(280)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('收起侧栏')
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
    await page.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
    // ⌘K (Ctrl K) opens a shut column on its search.
    await page.keyboard.press('Control+k')
    await page.locator('.app-shell[data-sidebar="open"]').waitFor()
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('搜索会话')
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
    await page.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
    // From the window's edge, the shut column is dragged open.
    await drag(250)
    await expect.poll(sidebarWidth).toBe(250)
    await page.locator('.app-shell[data-sidebar="open"]').waitFor()
    await handle().dblclick()
    await expect.poll(sidebarWidth).toBe(300)
  })

  it('slides shut when a drag passes the snap point and slides open when a drag pulls it out again', async () => {
    expect(await sidebarWidth()).toBe(300)
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
    await expect.poll(sidebarWidth).toBe(300)
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

  it('chooses a filter where clicking a button does not focus it, and folds the pills after a press elsewhere', async () => {
    // As in Safari and on iOS: a press on a button leaves focus nowhere, so the search loses focus as the press starts.
    await page.evaluate(() => {
      const pressing = new AbortController()
      Reflect.set(window, 'pressWithoutFocus', pressing)
      document.addEventListener(
        'mousedown',
        event => {
          if (!(event.target instanceof Element) || !event.target.closest('button')) return
          event.preventDefault()
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        },
        { capture: true, signal: pressing.signal },
      )
    })
    try {
      const list = page.locator('nav.session-list')
      const filters = page.getByRole('group', { name: '筛选会话', exact: true })
      for (const [name, value] of [
        ['Agent', 'agent'],
        ['对话', 'chat'],
        ['全部', 'all'],
      ] as const) {
        await page.getByRole('searchbox', { name: '搜索会话', exact: true }).click()
        await filters.getByRole('button', { name, exact: true }).click()
        await expect.poll(() => list.getAttribute('data-session-filter')).toBe(value)
      }
      await page.locator('.sidebar-filters[data-open]').waitFor({ state: 'attached' })
      await page.locator('.topbar-title h1').click()
      await page.locator('.sidebar-filters:not([data-open])').waitFor({ state: 'attached' })
    } finally {
      await page.evaluate(() => {
        const pressing: unknown = Reflect.get(window, 'pressWithoutFocus')
        if (pressing instanceof AbortController) pressing.abort()
      })
    }
  })

  it('chooses a filter by touch where a tap does not focus the button, so the search blurs after the finger lifts', async () => {
    // A tablet in landscape: the persistent sidebar, driven by taps. A tap sends the pointer events first and the mouse
    // events (which move focus) after the finger has lifted; as on iOS, the tapped button takes no focus.
    const touch = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, locale: 'zh-CN' })
    try {
      const tablet = await touch.newPage()
      await enrollBrowser(tablet, testHost, { name: '侧栏触控验收' })
      await tablet.evaluate(() => {
        document.addEventListener(
          'mousedown',
          event => {
            if (!(event.target instanceof Element) || !event.target.closest('button')) return
            event.preventDefault()
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
          },
          true,
        )
      })
      const list = tablet.locator('nav.session-list')
      const filters = tablet.getByRole('group', { name: '筛选会话', exact: true })
      for (const [name, value] of [
        ['Agent', 'agent'],
        ['对话', 'chat'],
        ['全部', 'all'],
      ] as const) {
        await tablet.getByRole('searchbox', { name: '搜索会话', exact: true }).tap()
        await filters.getByRole('button', { name, exact: true }).tap()
        await expect.poll(() => list.getAttribute('data-session-filter')).toBe(value)
      }
      await tablet.locator('.topbar-title h1').tap()
      await tablet.locator('.sidebar-filters:not([data-open])').waitFor({ state: 'attached' })
    } finally {
      await touch.close()
    }
  })

  it('remembers widths per breakpoint class and keeps the paper at least 520 wide', async () => {
    await drag(80)
    await expect.poll(sidebarWidth).toBe(380)
    await page.setViewportSize({ width: 1100, height: 900 })
    // A laptop-width window starts from its own default, not the desktop width.
    await expect.poll(sidebarWidth).toBe(248)
    await drag(400)
    await expect.poll(sidebarWidth).toBe(480)
    expect(await paperWidth()).toBeGreaterThanOrEqual(520)
    await page.setViewportSize({ width: 1024, height: 900 })
    await expect.poll(sidebarWidth).toBe(480)
    expect(await paperWidth()).toBeGreaterThanOrEqual(520)
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect.poll(sidebarWidth).toBe(380)
    await handle().dblclick()
    await expect.poll(sidebarWidth).toBe(300)
  })
})
