import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { settleShell } from './helpers/layout.ts'
import { VISUAL_TIME } from './helpers/visual.ts'

const OUT = 'test-results/particle-field'

/** A model that answers at length, so the session page has a long transcript over the field. */
const fixture: HarnessPlugin = {
  id: 'particle-field-fixture',
  name: 'Fixture',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerProvider({
      id: 'field',
      name: 'Fixture',
      model: 'fixture',
      async *stream() {
        for (let index = 1; index <= 40; index++)
          yield { type: 'text', text: `第 ${index} 段：检查设置页的保存逻辑，省略密钥时保留已保存的值，再运行一次回归测试。\n\n` }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}

/** Counts the field's frames: each one starts by clearing its canvas. Test instrumentation only, not a page hook. */
const COUNT_FRAMES = () => {
  const clear = CanvasRenderingContext2D.prototype.clearRect
  Object.assign(window, { fieldFrames: 0 })
  CanvasRenderingContext2D.prototype.clearRect = function (...args) {
    if (this.canvas.closest('.particle-field')) (window as unknown as { fieldFrames: number }).fieldFrames++
    return clear.apply(this, args)
  }
}
const frames = (page: Page) => page.evaluate(() => (window as unknown as { fieldFrames: number }).fieldFrames)

describe('the field behind the work panel', () => {
  let host: TestHost
  let browser: Browser
  let session = ''
  const contexts: BrowserContext[] = []

  beforeAll(async () => {
    host = await startTestHost({ demo: false, plugins: [fixture] })
    ;({ sessionId: session } = await host.host.bridge.createTask({
      prompt: '把设置页的保存逻辑检查一遍',
      requestId: randomUUID(),
      mode: 'agent',
      model: { providerId: 'field', model: 'fixture' },
    }))
    const deadline = Date.now() + 20_000
    while ((await host.host.bridge.detail(session)).summary.status !== 'idle') {
      if (Date.now() > deadline) throw new Error('the fixture session never finished')
      await new Promise(done => setTimeout(done, 50))
    }
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUT, { recursive: true })
  })
  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => {})
    await browser?.close()
    await host?.close()
  })

  async function open(options: {
    width: number
    height: number
    colorScheme?: 'light' | 'dark'
    reducedMotion?: 'reduce' | 'no-preference'
    frozen?: boolean
    scale?: number
    session?: boolean
  }): Promise<Page> {
    const context = await browser.newContext({
      viewport: { width: options.width, height: options.height },
      deviceScaleFactor: options.scale ?? 1,
      locale: 'zh-CN',
      colorScheme: options.colorScheme ?? 'light',
      reducedMotion: options.reducedMotion ?? 'no-preference',
    })
    contexts.push(context)
    context.setDefaultTimeout(15_000)
    if (options.frozen) await context.clock.setFixedTime(VISUAL_TIME)
    await context.addInitScript(COUNT_FRAMES)
    const page = await context.newPage()
    await enrollBrowser(page, host, { name: `粒子 ${randomUUID().slice(0, 6)}`, scopes: ['admin'] })
    await page.locator('.app-shell[data-connection="connected"]').waitFor()
    if (options.session !== false) {
      await page.locator(`[data-task-id="${session}"]`).first().click()
      await page.locator('.transcript-content').waitFor()
    }
    await settleShell(page)
    return page
  }

  /** The canvas as a data URL, and the strongest pixel it holds. */
  const picture = (page: Page) =>
    page.locator('.particle-field canvas').evaluate((canvas: HTMLCanvasElement) => {
      // The first read moves an accelerated canvas to memory and can round its edges differently; read after that one.
      const pen = canvas.getContext('2d')!
      pen.getImageData(0, 0, 1, 1)
      const data = pen.getImageData(0, 0, canvas.width, canvas.height).data
      let strongest = [0, 0, 0, 0]
      let blue = 0
      for (let index = 0; index < data.length; index += 4) {
        const [r, g, b, a] = [data[index]!, data[index + 1]!, data[index + 2]!, data[index + 3]!]
        if (a > strongest[3]!) strongest = [r, g, b, a]
        if (a > 64 && b > r + 80) blue++
      }
      return { url: canvas.toDataURL(), strongest, blue }
    })

  it('sits in the work panel under everything, out of the reading tree and of the pointer', async () => {
    const page = await open({ width: 1440, height: 900, scale: 2 })
    const field = page.locator('.particle-field')
    expect(await field.getAttribute('aria-hidden')).toBe('true')
    const box = await field.evaluate(element => {
      const style = getComputedStyle(element)
      const panel = getComputedStyle(element.parentElement!, '::before')
      const canvas = element.querySelector('canvas')!
      const rect = element.getBoundingClientRect()
      return {
        pointer: style.pointerEvents,
        select: style.userSelect,
        radius: style.borderTopLeftRadius,
        margins: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft],
        panel: [panel.marginTop, panel.marginRight, panel.marginBottom, panel.marginLeft],
        ratio: canvas.width / rect.width,
        topmost: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('.particle-field') !== null,
      }
    })
    expect(box.pointer).toBe('none')
    expect(box.select).toBe('none')
    expect(box.radius).toBe('12px')
    expect(box.margins).toEqual(box.panel)
    // A 2x screen draws at 1.5x at most.
    expect(box.ratio).toBeCloseTo(1.5, 2)
    expect(box.topmost).toBe(false)
  })

  it('shows the same still frame on every load under a frozen clock, and draws no more while it stands', async () => {
    const shots: string[] = []
    for (const theme of ['light', 'dark'] as const) {
      const first = await open({ width: 1440, height: 900, colorScheme: theme, frozen: true })
      const second = await open({ width: 1440, height: 900, colorScheme: theme, frozen: true })
      const [a, b] = [await picture(first), await picture(second)]
      expect(a.url).toBe(b.url)
      shots.push(a.url)
      // Dark: white points, the seventh too. Light: slate, with the execute blue in every seventh point.
      if (theme === 'dark') {
        expect(a.strongest[0]).toBeGreaterThan(200)
        expect(a.blue).toBe(0)
      } else expect(a.blue).toBeGreaterThan(0)
      const before = await frames(first)
      await first.waitForTimeout(500)
      expect(await frames(first)).toBe(before)
      await first.screenshot({ path: `${OUT}/frozen--1440--${theme}.png` })
    }
    expect(shots[0]).not.toBe(shots[1])
  })

  it('drifts at 30 frames a second at most, and stops once the field is gone', async () => {
    const page = await open({ width: 1440, height: 900 })
    const start = await frames(page)
    await page.waitForTimeout(2000)
    const drawn = (await frames(page)) - start
    expect(drawn).toBeGreaterThan(20)
    expect(drawn).toBeLessThanOrEqual(64)
    // A phone has no panel: the field leaves and its loop with it.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.particle-field').waitFor({ state: 'detached' })
    const after = await frames(page)
    await page.waitForTimeout(500)
    expect(await frames(page)).toBe(after)
  })

  it('stands on one frame under reduced motion, and switches colours with the theme', async () => {
    const page = await open({ width: 1024, height: 768, reducedMotion: 'reduce' })
    // Draws happen only when something changes (size, theme): let the page settle first.
    await page.waitForTimeout(300)
    const still = await picture(page)
    expect(still.blue).toBeGreaterThan(0)
    const before = await frames(page)
    await page.waitForTimeout(600)
    expect(await frames(page)).toBe(before)
    expect((await picture(page)).url).toBe(still.url)
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await expect.poll(async () => (await picture(page)).blue).toBe(0)
    expect((await picture(page)).strongest[0]).toBeGreaterThan(200)
  })

  it('leaves the phone without a field', async () => {
    const page = await open({ width: 390, height: 844, session: false })
    expect(await page.locator('.particle-field').count()).toBe(0)
  })
})
