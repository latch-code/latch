import { mkdir, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type CDPSession, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openSection, openSession, openSettings } from './helpers/layout.ts'
import { homeInput } from './helpers/workbench.ts'

/*
 * The start page's background under measurement, on the built page in Chrome: frame times, long tasks, main-thread time
 * per second, the script of each animation frame, the canvas work of each drawn frame, and the time from a key to the
 * next frame while typing in the input, with the layer off and on. Explicit run only, on a quiet machine:
 *   LATCH_BACKDROP_BENCH=1 LATCH_BROWSER_PATH=… pnpm exec vitest run --config e2e/vitest.config.ts e2e/backdrop-performance.e2e.ts
 * Readings go to test-results/backdrop-performance/<LATCH_BACKDROP_LABEL>.json. They compare runs on one machine.
 */
const enabled = process.env.LATCH_BACKDROP_BENCH === '1'
// A directory for the review screenshots of both looks at three widths, light and dark; outside the repository.
const shots = process.env.LATCH_BACKDROP_SHOTS
const label = /^[a-z0-9-]{1,48}$/u.test(process.env.LATCH_BACKDROP_LABEL ?? '') ? process.env.LATCH_BACKDROP_LABEL! : 'run'
const seconds = Number(process.env.LATCH_BACKDROP_SECONDS ?? '10')
// A slower machine: the CPU slowed this many times through DevTools, as the v9 measurement does.
const throttle = Number(process.env.LATCH_BACKDROP_THROTTLE ?? '1')
const uiDir = resolve(process.env.LATCH_E2E_UI_DIR ?? 'dist/web')
const SIZES = [
  { width: 1440, height: 900 },
  { width: 2560, height: 1440 },
] as const

interface Probe {
  frames: number[]
  callbacks: number[]
  longTasks: number[]
  keys: number[]
  events: Array<{ name: string; duration: number }>
  /** When the backdrop cleared its whole canvas: one drawn frame each. */
  clears: number[]
}
declare global {
  interface Window {
    latchBackdropProbe?: Probe
  }
}

function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
  const round = (value: number) => Math.round(value * 100) / 100
  return { count: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? 0) }
}

/** Times every animation-frame callback but the probe's own, and records the page's frame times and long tasks. */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: Probe = { frames: [], callbacks: [], longTasks: [], keys: [], events: [], clears: [] }
    window.latchBackdropProbe = probe
    const request = window.requestAnimationFrame.bind(window)
    const own = new WeakSet<FrameRequestCallback>()
    window.requestAnimationFrame = callback => {
      if (own.has(callback)) return request(callback)
      return request(time => {
        const start = performance.now()
        try {
          callback(time)
        } finally {
          probe.callbacks.push(performance.now() - start)
        }
      })
    }
    // A full clear of a backdrop canvas marks one drawn frame; the cost of this hook is one push.
    const clear = CanvasRenderingContext2D.prototype.clearRect
    CanvasRenderingContext2D.prototype.clearRect = function (x, y, w, h) {
      const canvas = this.canvas
      const s = this.getTransform().a
      if (canvas.classList.contains('ui-backdrop') && x === 0 && y === 0 && w * s >= canvas.width - 2) probe.clears.push(performance.now())
      clear.call(this, x, y, w, h)
    }
    let last = 0
    const tick: FrameRequestCallback = time => {
      if (last > 0) probe.frames.push(time - last)
      last = time
      request(tick)
    }
    own.add(tick)
    request(tick)
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) probe.longTasks.push(entry.duration)
    }).observe({ type: 'longtask', buffered: false })
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) probe.events.push({ name: entry.name, duration: entry.duration })
    }).observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit)
    // Key to next frame: the frame after the key is handled, read once that frame's work is done.
    window.addEventListener(
      'keydown',
      event => {
        const started = event.timeStamp
        request(() => {
          const channel = new MessageChannel()
          channel.port1.onmessage = () => probe.keys.push(performance.now() - started)
          channel.port2.postMessage(0)
        })
      },
      true,
    )
  })
}

/** Counts the canvas calls of the backdrop and the area it clears or fills per drawn frame, for a short while. */
async function countDraws(page: Page, ms: number) {
  return page.locator('canvas.ui-backdrop').evaluate(async (element, ms) => {
    const canvas = element as HTMLCanvasElement
    const context = canvas.getContext('2d')!
    const calls: Record<string, number> = {}
    let area = 0
    let frames = 0
    const restore: Array<() => void> = []
    const scale = () => context.getTransform().a
    for (const name of ['fillText', 'fillRect', 'fill', 'stroke', 'rect', 'drawImage', 'clearRect', 'putImageData', 'moveTo'] as const) {
      const original = context[name] as (...args: unknown[]) => unknown
      ;(context as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        calls[name] = (calls[name] ?? 0) + 1
        if (name === 'clearRect' || name === 'fillRect') {
          const s = scale()
          area += Math.abs(Number(args[2]) * Number(args[3])) * s * s
          if (name === 'clearRect' && Number(args[2]) * s >= canvas.width - 2) frames++
        }
        if (name === 'drawImage' && args.length >= 5) {
          const s = scale()
          const [w, h] = args.length >= 9 ? [args[7], args[8]] : [args[3], args[4]]
          area += Math.abs(Number(w) * Number(h)) * s * s
        }
        return original.apply(context, args)
      }
      restore.push(() => {
        delete (context as unknown as Record<string, unknown>)[name]
      })
    }
    await new Promise(done => setTimeout(done, ms))
    for (const undo of restore) undo()
    const drawn = Math.max(1, frames)
    const perFrame = Object.fromEntries(Object.entries(calls).map(([name, count]) => [name, Math.round(count / drawn)]))
    return { framesCleared: frames, perFrame, areaPerFramePx: Math.round(area / drawn), bitmap: [canvas.width, canvas.height] }
  }, ms)
}

interface TraceEvent {
  name: string
  ph: string
  dur?: number
  pid: number
  tid: number
  args?: { name?: string }
}

/** Busy time per thread name, in ms per second, from the browser-wide top-level task trace. */
async function traceThreads(session: CDPSession, run: () => Promise<void>, span: number) {
  const events: TraceEvent[] = []
  const collect = (data: { value: Array<Record<string, unknown>> }) => {
    events.push(...(data.value as unknown as TraceEvent[]))
  }
  session.on('Tracing.dataCollected', collect)
  await session.send('Tracing.start', { traceConfig: { includedCategories: ['toplevel', '__metadata'] }, transferMode: 'ReportEvents' })
  await run()
  const complete = new Promise(done => session.once('Tracing.tracingComplete', done))
  await session.send('Tracing.end')
  await complete
  session.off('Tracing.dataCollected', collect)
  const names = new Map<string, string>()
  for (const event of events)
    if (event.ph === 'M' && event.name === 'thread_name') names.set(`${event.pid}:${event.tid}`, event.args?.name ?? '?')
  const busy: Record<string, number> = {}
  for (const event of events) {
    if (event.ph !== 'X' || !event.dur || !/RunTask|ProcessTask/u.test(event.name)) continue
    const name = names.get(`${event.pid}:${event.tid}`) ?? '?'
    busy[name] = (busy[name] ?? 0) + event.dur / 1000
  }
  const keep = ['CrRendererMain', 'Compositor', 'CrGpuMain', 'VizCompositorThread', 'CompositorTileWorker1', 'CompositorTileWorker2']
  return Object.fromEntries(keep.map(name => [name, Math.round(((busy[name] ?? 0) / span) * 100) / 100]))
}

describe.runIf(enabled || shots !== undefined)('the start page background under measurement', () => {
  let testHost: TestHost
  let browser: Browser
  const report: Record<string, unknown> = {}

  beforeAll(async () => {
    testHost = await startTestHost({ uiDir, demo: true, hostName: '性能电脑' })
    browser = await chromium.launch(browserLaunchOptions())
  })
  afterAll(async () => {
    await browser?.close()
    await testHost?.close()
  })

  async function open(width: number, height: number, preferences: Record<string, string>) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: 'light' })
    const page = await context.newPage()
    await page.addInitScript(value => {
      localStorage.setItem('latch.preferences', value)
    }, JSON.stringify(preferences))
    await instrument(page)
    if (throttle > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle })
    await enrollBrowser(page, testHost, { name: `性能 ${width}` })
    await connected(page)
    await homeInput(page).waitFor()
    await page.bringToFront()
    return { context, page }
  }

  const reset = (page: Page) =>
    page.evaluate(() => {
      const probe = window.latchBackdropProbe!
      probe.frames.length = 0
      probe.callbacks.length = 0
      probe.longTasks.length = 0
      probe.keys.length = 0
      probe.events.length = 0
      probe.clears.length = 0
    })
  const read = (page: Page) => page.evaluate(() => structuredClone(window.latchBackdropProbe!))

  async function metrics(page: Page) {
    const session = await page.context().newCDPSession(page)
    await session.send('Performance.enable')
    return async () => {
      const { metrics } = await session.send('Performance.getMetrics')
      return Object.fromEntries(metrics.map(metric => [metric.name, metric.value]))
    }
  }

  it.runIf(enabled)('measures digits, field and off at both sizes', { timeout: 600_000 }, async () => {
    const tracer = await browser.newBrowserCDPSession()
    const gpu = await (async () => {
      const page = await browser.newPage()
      const renderer = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl')
        const info = gl?.getExtension('WEBGL_debug_renderer_info')
        return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'none'
      })
      await page.close()
      return renderer
    })()
    report['machine'] = { cpu: cpus()[0]?.model, cores: cpus().length, chrome: browser.version(), gpu, label, throttle }
    const only = process.env.LATCH_BACKDROP_ONLY
    for (const { width, height } of SIZES)
      for (const kind of ['digits', 'field', 'off'] as const) {
        if (only && only !== `${kind} ${width}`) continue
        const preferences: Record<string, string> = kind === 'off' ? { backdrop: 'off' } : { backdrop: 'standard', backdropStyle: kind }
        const { context, page } = await open(width, height, preferences)
        try {
          const entry: Record<string, unknown> = {}
          if (kind !== 'off') {
            await page.locator(`canvas.ui-backdrop[data-kind="${kind}"]`).waitFor()
            expect(await page.evaluate(() => document.hasFocus())).toBe(true)
          }
          await page.waitForTimeout(1500)
          const sample = await metrics(page)
          await reset(page)
          const before = await sample()
          const threads = await traceThreads(tracer, () => page.waitForTimeout(seconds * 1000), seconds)
          const after = await sample()
          const idle = await read(page)
          const per = (name: string) => Math.round(((after[name]! - before[name]!) / seconds) * 1000 * 100) / 100
          entry['idle'] = {
            frameMs: distribution(idle.frames),
            drawGapMs: distribution(idle.clears.slice(1).map((time, index) => time - idle.clears[index]!)),
            drawsPerSecond: Math.round((idle.clears.length / seconds) * 10) / 10,
            rafScriptMs: distribution(idle.callbacks),
            longTasks: idle.longTasks.length,
            longTaskMaxMs: Math.max(0, ...idle.longTasks),
            threadBusyMsPerSecond: threads,
            perSecondMs: {
              script: per('ScriptDuration'),
              task: per('TaskDuration'),
              layout: per('LayoutDuration'),
              style: per('RecalcStyleDuration'),
            },
          }
          if (kind !== 'off') entry['draws'] = await countDraws(page, 3000)
          // Typing: one key every 80ms, the input focused as a person would leave it.
          await homeInput(page).click()
          await page.waitForTimeout(300)
          await reset(page)
          const typedBefore = await sample()
          const start = Date.now()
          await page.keyboard.type('measuring input latency on the start page: the quick brown fox jumps over the lazy dog 0123456789', {
            delay: 80,
          })
          const elapsed = (Date.now() - start) / 1000
          const typedAfter = await sample()
          const typed = await read(page)
          entry['typing'] = {
            keyToFrameMs: distribution(typed.keys),
            frameMs: distribution(typed.frames),
            slowEvents: typed.events.length,
            slowEventMaxMs: Math.max(0, ...typed.events.map(event => event.duration)),
            longTasks: typed.longTasks.length,
            scriptPerSecondMs: Math.round(((typedAfter['ScriptDuration']! - typedBefore['ScriptDuration']!) / elapsed) * 100_000) / 100,
          }
          report[`${kind} ${width}x${height}@2`] = entry
        } finally {
          await context.close()
        }
      }
    const output = join('test-results', 'backdrop-performance')
    await mkdir(output, { recursive: true })
    await writeFile(join(output, `${label}.json`), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  })
  it.runIf(shots !== undefined)('takes the review screenshots', { timeout: 600_000 }, async () => {
    const sessions: string[] = []
    for (const name of ['重构登录页的表单校验', '整理发布说明', '修复列表滚动卡顿', '补充接口的单元测试'])
      sessions.push((await testHost.host.bridge.createTask({ prompt: name, requestId: randomUUID(), mode: 'agent' })).sessionId)
    const kinds = (process.env.LATCH_BACKDROP_KINDS ?? 'digits,field').split(',')
    const views = [
      { name: 'phone-390', width: 390, height: 844, mobile: true },
      { name: 'tablet-820', width: 820, height: 1180, mobile: true },
      { name: 'desktop-1440', width: 1440, height: 900, mobile: false },
    ]
    const only = process.env.LATCH_BACKDROP_VIEWS?.split(',')
    await mkdir(shots!, { recursive: true })
    for (const kind of kinds)
      for (const view of views.filter(item => !only || only.includes(item.name)))
        for (const scheme of ['light', 'dark'] as const) {
          const context = await browser.newContext({
            viewport: { width: view.width, height: view.height },
            deviceScaleFactor: 2,
            isMobile: view.mobile,
            hasTouch: view.mobile,
            colorScheme: scheme,
            reducedMotion: process.env.LATCH_BACKDROP_REDUCED === '1' ? 'reduce' : 'no-preference',
          })
          const page = await context.newPage()
          // By default 标准 and a charging battery, for the moving layer; LATCH_BACKDROP_LEVEL=device keeps this device's
          // own default level and battery (a phone that reports none holds its still frame).
          const level = process.env.LATCH_BACKDROP_LEVEL ?? 'standard'
          await page.addInitScript(
            ({ value, charged }) => {
              localStorage.setItem('latch.preferences', value)
              if (charged)
                Object.defineProperty(navigator, 'getBattery', {
                  configurable: true,
                  value: () => Promise.resolve(Object.assign(new EventTarget(), { charging: true, level: 1 })),
                })
            },
            {
              value: JSON.stringify(level === 'device' ? { backdropStyle: kind } : { backdrop: level, backdropStyle: kind }),
              charged: level !== 'device',
            },
          )
          await enrollBrowser(page, testHost, { name: `截图 ${view.name}` })
          await connected(page)
          if (!(await page.locator('.workbench-home').isVisible()))
            await page.getByRole('button', { name: '新建会话', exact: true }).filter({ visible: true }).first().click()
          await homeInput(page).waitFor()
          await page.bringToFront()
          await page.locator(`canvas.ui-backdrop[data-kind="${kind}"]`).waitFor()
          await page.waitForTimeout(Number(process.env.LATCH_BACKDROP_WAIT ?? '4000'))
          await page.screenshot({ path: join(shots!, `${kind}-${view.name}-${scheme}.png`) })
          // Later frames of the same layer, to see what moves and how.
          for (let later = 1; later < Number(process.env.LATCH_BACKDROP_FRAMES ?? '1'); later++) {
            await page.waitForTimeout(3000)
            await page.screenshot({ path: join(shots!, `${kind}-${view.name}-${scheme}-${later * 3}s.png`) })
          }
          if (view.name === 'desktop-1440') {
            // The same layer behind an open session, and the style tiles in 设置 › 外观.
            await openSession(page, sessions[1]!)
            await page.waitForTimeout(2500)
            await page.screenshot({ path: join(shots!, `${kind}-${view.name}-${scheme}-session.png`) })
            const settings = await openSettings(page)
            await openSection(settings, '外观')
            await settings.getByRole('radiogroup', { name: '背景样式' }).waitFor()
            await page.waitForTimeout(1500)
            await page.screenshot({ path: join(shots!, `${kind}-${view.name}-${scheme}-settings.png`) })
          }
          await context.close()
        }
  })
})
