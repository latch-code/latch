import type { Browser, BrowserContext, Locator, Page } from '@playwright/test'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { expect } from 'vitest'
import { layersInWindow } from './layout.ts'

/**
 * Captures of the real product for design review: every surface at three viewports in light and dark, written as
 * test-results/visual/<surface>--<viewport>--<theme>.png with an index, and optionally compared with an earlier run.
 */

export const VISUAL_OUTPUT = 'test-results/visual'
export const VISUAL_DIFF_OUTPUT = 'test-results/visual-diff'

export type Theme = 'light' | 'dark'
const THEMES: readonly Theme[] = ['light', 'dark']

export interface VisualViewport {
  name: 'phone' | 'tablet' | 'desktop'
  width: number
  height: number
  touch: boolean
}
export const VISUAL_VIEWPORTS: readonly VisualViewport[] = [
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'tablet', width: 768, height: 1024, touch: true },
  { name: 'desktop', width: 1440, height: 900, touch: false },
]

/**
 * One instant for the page clock and the Host's clock, so countdowns, expiry dates and relative times render the same
 * on every run. It lies before any real run, so sessions (stamped with the real time) always read 刚刚 and 今天.
 */
export const VISUAL_TIME = Date.parse('2026-10-20T09:30:00+08:00')

/**
 * Values that differ on every run because they derive from fresh keys: device fingerprints and check codes. They are
 * monospaced, so hiding only their glyphs keeps the layout identical.
 */
const VOLATILE_TEXT = ['.fingerprint span', '.fingerprint-hash code', '.fingerprint-inline', '.presence-code code', '.presence-inline']
const CAPTURE_STYLE = `${VOLATILE_TEXT.join(', ')} { color: transparent !important; }`

/**
 * Freezes the motion that runs on its own (the faces of 我的 Agent blink, glance and squint at random): the page reads
 * `data-motion="still"` on its root, as it reads reduced motion, so every capture shows the same frame with the state
 * props at rest. It sits with the fixed clock, in visualContext; other captures call it on their context.
 */
export async function stillMotion(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    document.documentElement.dataset.motion = 'still'
  })
}

/**
 * A browser device at a reference viewport: 1x pixels, a fixed clock, locale and time zone, and still motion. Motion
 * otherwise stays at the default preference, as most people see the page; captures stop animations themselves.
 */
export async function visualContext(browser: Browser, viewport: VisualViewport): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    isMobile: viewport.touch,
    hasTouch: viewport.touch,
    colorScheme: 'light',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  })
  context.setDefaultTimeout(15_000)
  // Date is frozen while timers keep running, so the page still polls, reconnects and settles normally.
  await context.clock.setFixedTime(VISUAL_TIME)
  await stillMotion(context)
  return context
}

export interface VisualEntry {
  file: string
  surface: string
  viewport: VisualViewport['name']
  theme: Theme
  /** The product state shown, in a few words. */
  state: string
  width: number
  height: number
  /** The design reference to compare with, from the mapping in LATCH_VISUAL_BOARDS; null when there is none. */
  board: string | null
}

/** `{ surface: { viewport: "reference--{theme}.png" } }`; `{theme}` is replaced per capture. */
type BoardMap = Record<string, Record<string, string>>

async function readBoards(): Promise<BoardMap> {
  const file = process.env.LATCH_VISUAL_BOARDS
  if (!file) return {}
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${file} must hold a JSON object`)
  const boards: BoardMap = {}
  for (const surface of Object.keys(parsed)) {
    const viewports: unknown = Reflect.get(parsed, surface)
    if (typeof viewports !== 'object' || viewports === null) continue
    for (const viewport of Object.keys(viewports)) {
      const name: unknown = Reflect.get(viewports, viewport)
      if (typeof name === 'string') (boards[surface] ??= {})[viewport] = name
    }
  }
  return boards
}

export const captureName = (surface: string, viewport: VisualViewport['name'], theme: Theme) => `${surface}--${viewport}--${theme}.png`

/** Waits until the page has nothing left to paint: fonts, images and two animation frames. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(
      Array.from(document.images, image =>
        image.complete ? Promise.resolve() : new Promise(done => image.addEventListener('loadend', done, { once: true })),
      ),
    )
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}

export class VisualRecorder {
  readonly entries: VisualEntry[] = []
  private boards: BoardMap = {}
  private started = false

  /** Starts from empty output directories, so nothing left from an earlier run is mistaken for this one. */
  async start(): Promise<void> {
    const baseline = process.env.LATCH_VISUAL_BASELINE
    if (baseline) {
      // The output directories are emptied below; a baseline inside them would be deleted before it is compared.
      const within = (parent: string) => !relative(resolve(parent), resolve(baseline)).startsWith('..')
      if (within(VISUAL_OUTPUT) || within(VISUAL_DIFF_OUTPUT)) {
        throw new Error(
          `LATCH_VISUAL_BASELINE must lie outside ${VISUAL_OUTPUT} and ${VISUAL_DIFF_OUTPUT}, which every run empties: ${baseline}`,
        )
      }
      if (!(await stat(baseline).catch(() => null))?.isDirectory()) throw new Error(`LATCH_VISUAL_BASELINE is not a directory: ${baseline}`)
    }
    await rm(VISUAL_OUTPUT, { recursive: true, force: true })
    await rm(VISUAL_DIFF_OUTPUT, { recursive: true, force: true })
    await mkdir(VISUAL_OUTPUT, { recursive: true })
    this.boards = await readBoards()
    this.started = true
  }

  /** The screenshot alone, as the recorder would write it. */
  async shot(page: Page, target?: Locator): Promise<Buffer> {
    // The cursor rests in the top-left corner, where no control sits, so nothing shows a hover state. Touch
    // viewports are driven with clicks too: an emulated tap leaves Chrome's tap highlight painted on the page.
    await page.mouse.move(0, 0)
    await settle(page)
    const options = { animations: 'disabled', caret: 'hide', scale: 'css', style: CAPTURE_STYLE } as const
    if (!target) return page.screenshot(options)
    return target.screenshot(options)
  }

  /**
   * Captures the current state in both themes. Every capture also asserts that the page does not scroll sideways;
   * `target` captures one element (such as the sidebar) instead of the viewport.
   */
  async capture(page: Page, viewport: VisualViewport, surface: string, state: string, target?: Locator): Promise<void> {
    for (const theme of THEMES) {
      await page.emulateMedia({ colorScheme: theme })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
      const file = captureName(surface, viewport.name, theme)
      const image = await this.shot(page, target)
      await writeFile(join(VISUAL_OUTPUT, file), image)
      const mapping = this.boards[surface] ?? (surface.startsWith('ui-gallery-') ? this.boards['ui-gallery'] : undefined)
      const board = mapping?.[viewport.name]?.replaceAll('{theme}', theme) ?? null
      this.entries.push({ file, surface, viewport: viewport.name, theme, state, ...pngSize(image), board })
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await layersInWindow(page)
  }

  /** Writes index.json for this run's captures; a run that never started leaves the output untouched. */
  async writeIndex(): Promise<void> {
    if (!this.started) return
    const entries = this.entries.toSorted((a, b) => a.file.localeCompare(b.file))
    await writeFile(join(VISUAL_OUTPUT, 'index.json'), `${JSON.stringify(entries, null, 2)}\n`)
  }
}

function pngSize(image: Buffer): { width: number; height: number } {
  // The IHDR chunk follows the 8-byte signature and its own 8-byte header.
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) }
}

// ---- Comparison ------------------------------------------------------------------------------------------------

/**
 * Per-pixel tolerance: the squared YIQ distance (Kotsarenko and Ramos, the measure pixelmatch uses) above which two
 * pixels count as different, as a share of the largest possible distance. 0.1 ignores faint shade changes and still
 * catches a changed colour token or a moved glyph. A differing pixel that looks anti-aliased in either image (it lies
 * between a darker and a brighter neighbour, one of which is flat in both images: Vysniauskas's detector, as
 * pixelmatch applies it) is not counted, because Chrome may rasterize the edge of a small shape slightly differently
 * from one run to the next. Beyond that no pixel may differ, so any remaining difference is a change in what the
 * product draws.
 */
const PIXEL_THRESHOLD = 0.1

export interface PixelDiff {
  width: number
  height: number
  sizeMatches: boolean
  diffPixels: number
  /** PNG of the differences (red; ignored anti-aliasing yellow) over a faded copy of the expected image; null when nothing differs. */
  image: Buffer | null
}

/**
 * Compares two PNGs in a page of `browser`: Chrome decodes any PNG exactly (no colour conversion, no premultiplied
 * alpha) and encodes the diff image, so the comparison needs no image library.
 */
export async function diffImages(browser: Browser, actual: Buffer, expected: Buffer): Promise<PixelDiff> {
  const page = await differ(browser)
  const result = await page.evaluate(
    async ({ pngs, threshold }) => {
      // Index 0 is the actual image, 1 the expected one.
      const images = await Promise.all(
        pngs.map(async base64 => {
          const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none',
          })
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          const context = canvas.getContext('2d', { willReadFrequently: true })!
          context.drawImage(bitmap, 0, 0)
          return context.getImageData(0, 0, bitmap.width, bitmap.height)
        }),
      )
      const [first, second] = images
      const sizeMatches = first.width === second.width && first.height === second.height
      const width = Math.max(first.width, second.width)
      const height = Math.max(first.height, second.height)
      const out = new ImageData(width, height)
      const maxDelta = 35215 * threshold * threshold

      /** Red, green and blue of a pixel of image `which`, blended over white so transparency compares by what it shows. */
      const colour = (which: number, x: number, y: number): readonly [number, number, number] => {
        const { data, width: row } = images[which]
        const i = (y * row + x) * 4
        const alpha = data[i + 3]
        return [255 + ((data[i] - 255) * alpha) / 255, 255 + ((data[i + 1] - 255) * alpha) / 255, 255 + ((data[i + 2] - 255) * alpha) / 255]
      }
      const luma = (which: number, x: number, y: number) => {
        const [red, green, blue] = colour(which, x, y)
        return red * 0.29889531 + green * 0.58662247 + blue * 0.11448223
      }
      /** Squared YIQ distance between the two images at (x, y). */
      const distance = (x: number, y: number) => {
        const [r1, g1, b1] = colour(0, x, y)
        const [r2, g2, b2] = colour(1, x, y)
        const dy = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223
        const di = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189
        const dq = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694
        return 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq
      }
      const identical = (which: number, x1: number, y1: number, x2: number, y2: number) => {
        const { data, width: row } = images[which]
        const i = (y1 * row + x1) * 4
        const j = (y2 * row + x2) * 4
        return data[i] === data[j] && data[i + 1] === data[j + 1] && data[i + 2] === data[j + 2] && data[i + 3] === data[j + 3]
      }
      // Anti-aliasing is only looked for when both images have the same size, so one width and height serve both.
      const around = (x: number, y: number) => {
        const cells: Array<readonly [number, number]> = []
        for (let ny = Math.max(y - 1, 0); ny <= Math.min(y + 1, height - 1); ny++) {
          for (let nx = Math.max(x - 1, 0); nx <= Math.min(x + 1, width - 1); nx++) if (nx !== x || ny !== y) cells.push([nx, ny])
        }
        return cells
      }
      /** A pixel on the border counts what lies outside as one more neighbour like itself. */
      const border = (x: number, y: number) => (x === 0 || y === 0 || x === width - 1 || y === height - 1 ? 1 : 0)
      /** Part of a flat area of image `which`: three or more identical neighbours. */
      const flat = (which: number, x: number, y: number) =>
        border(x, y) + around(x, y).filter(([nx, ny]) => identical(which, x, y, nx, ny)).length > 2
      const antialiased = (which: number, x: number, y: number) => {
        const centre = luma(which, x, y)
        let level = border(x, y)
        let darkest: { delta: number; at: readonly [number, number] | null } = { delta: 0, at: null }
        let brightest: { delta: number; at: readonly [number, number] | null } = { delta: 0, at: null }
        for (const [nx, ny] of around(x, y)) {
          const delta = luma(which, nx, ny) - centre
          if (delta === 0) {
            level++
            if (level > 2) return false
          } else if (delta < darkest.delta) darkest = { delta, at: [nx, ny] }
          else if (delta > brightest.delta) brightest = { delta, at: [nx, ny] }
        }
        if (darkest.at === null || brightest.at === null) return false
        return [darkest.at, brightest.at].some(([nx, ny]) => flat(0, nx, ny) && flat(1, nx, ny))
      }

      let diffPixels = 0
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4
          const inside = x < first.width && y < first.height && x < second.width && y < second.height
          if (inside && distance(x, y) <= maxDelta) {
            // Unchanged: a faded grey copy of the expected pixel.
            const grey = 255 + (luma(1, x, y) - 255) * 0.1
            out.data.set([grey, grey, grey, 255], offset)
          } else if (inside && sizeMatches && (antialiased(0, x, y) || antialiased(1, x, y))) {
            out.data.set([255, 255, 0, 255], offset)
          } else {
            diffPixels++
            out.data.set([255, 0, 0, 255], offset)
          }
        }
      }
      if (diffPixels === 0) return { width, height, sizeMatches, diffPixels, image: null }
      const canvas = new OffscreenCanvas(width, height)
      canvas.getContext('2d')!.putImageData(out, 0, 0)
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
      let binary = ''
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
      return { width, height, sizeMatches, diffPixels, image: btoa(binary) }
    },
    { pngs: [actual.toString('base64'), expected.toString('base64')], threshold: PIXEL_THRESHOLD },
  )
  return { ...result, image: result.image === null ? null : Buffer.from(result.image, 'base64') }
}

const differs = new WeakMap<Browser, Promise<Page>>()
/** One blank page per browser does every comparison. */
function differ(browser: Browser): Promise<Page> {
  let page = differs.get(browser)
  if (!page) {
    page = browser.newContext().then(context => context.newPage())
    differs.set(browser, page)
  }
  return page
}

export interface BaselineResult {
  file: string
  status: 'same' | 'changed' | 'missing-baseline' | 'missing-capture'
  diffPixels?: number
  totalPixels?: number
  sizeMatches?: boolean
  diff?: string
}

/**
 * Compares every capture with the file of the same name in `baseline`, writes a diff image for each changed one and
 * report.json under test-results/visual-diff/, and returns the results. Baseline files without a capture are listed too.
 */
export async function compareWithBaseline(browser: Browser, entries: readonly VisualEntry[], baseline: string): Promise<BaselineResult[]> {
  await mkdir(VISUAL_DIFF_OUTPUT, { recursive: true })
  const results: BaselineResult[] = []
  for (const entry of entries.toSorted((a, b) => a.file.localeCompare(b.file))) {
    const expected = await readFile(join(baseline, entry.file)).catch(() => null)
    if (expected === null) {
      results.push({ file: entry.file, status: 'missing-baseline' })
      continue
    }
    const diff = await diffImages(browser, await readFile(join(VISUAL_OUTPUT, entry.file)), expected)
    const result: BaselineResult = {
      file: entry.file,
      status: diff.diffPixels === 0 ? 'same' : 'changed',
      diffPixels: diff.diffPixels,
      totalPixels: diff.width * diff.height,
      sizeMatches: diff.sizeMatches,
    }
    if (diff.image) {
      result.diff = entry.file
      await writeFile(join(VISUAL_DIFF_OUTPUT, entry.file), diff.image)
    }
    results.push(result)
  }
  const captured = new Set(entries.map(entry => entry.file))
  for (const file of (await readdir(baseline)).filter(name => name.endsWith('.png')).toSorted()) {
    if (!captured.has(file)) results.push({ file, status: 'missing-capture' })
  }
  const count = (status: BaselineResult['status']) => results.filter(result => result.status === status).length
  const summary = {
    baseline,
    pixelThreshold: PIXEL_THRESHOLD,
    same: count('same'),
    changed: count('changed'),
    missingBaseline: count('missing-baseline'),
    missingCapture: count('missing-capture'),
  }
  await writeFile(join(VISUAL_DIFF_OUTPUT, 'report.json'), `${JSON.stringify({ summary, results }, null, 2)}\n`)
  return results
}
