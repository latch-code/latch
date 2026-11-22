import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * `pnpm --filter @latch/site measure [url…]`: lab measurement without dependencies. Drives a local Chrome (CHROME, or
 * the default macOS install) over the DevTools protocol with the throttling Lighthouse uses for its mobile run (150 ms
 * RTT, 1.6 Mbps down, 4x CPU) and for desktop (40 ms, 10 Mbps, no CPU slowdown), and reports LCP, FCP, CLS, TBT, TTFB
 * and what was transferred. Serve dist/ first (`preview`). Chrome runs headless on a throwaway profile.
 */
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const urls = process.argv.length > 2 ? process.argv.slice(2) : ['http://localhost:4790/']

interface Profile {
  width: number
  height: number
  dpr: number
  mobile: boolean
  cpu: number
  latency: number
  down: number
  up: number
}

const PROFILES: Record<string, Profile> = {
  mobile: { width: 412, height: 823, dpr: 1.75, mobile: true, cpu: 4, latency: 150, down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8 },
  desktop: {
    width: 1350,
    height: 940,
    dpr: 1,
    mobile: false,
    cpu: 1,
    latency: 40,
    down: (10 * 1024 * 1024) / 8,
    up: (10 * 1024 * 1024) / 8,
  },
}
const PORT = 9333

interface Measured {
  lcp: number
  lcpEl: string
  cls: number
  tbt: number
  longTasks: number
  shifts: string[]
  fcp: number
  ttfb: number
  bytes: number
  js: number
  img: number
  requests: number
}

type Params = Record<string, unknown>

const profileDir = mkdtempSync(join(tmpdir(), 'latch-audit-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function connect(): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{
        type: string
        webSocketDebuggerUrl: string
      }>
      const page = list.find(target => target.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // Chrome is not listening yet.
    }
    await sleep(200)
  }
  throw new Error('Chrome did not start')
}

function client(url: string) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map<number, { resolve: (value: Params) => void; reject: (error: Error) => void }>()
  const handlers = new Map<string, Array<(params: Params) => void>>()
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)) as {
      id?: number
      method?: string
      params?: Params
      result?: Params
      error?: { message: string }
    }
    const waiting = message.id === undefined ? undefined : pending.get(message.id)
    if (waiting && message.id !== undefined) {
      pending.delete(message.id)
      if (message.error) waiting.reject(new Error(message.error.message))
      else waiting.resolve(message.result ?? {})
    } else if (message.method) for (const handler of handlers.get(message.method) ?? []) handler(message.params ?? {})
  })
  return {
    open: new Promise(resolve => ws.addEventListener('open', resolve)),
    send: (method: string, params: Params = {}) =>
      new Promise<Params>((resolve, reject) => {
        const next = ++id
        pending.set(next, { resolve, reject })
        ws.send(JSON.stringify({ id: next, method, params }))
      }),
    on: (method: string, handler: (params: Params) => void) => handlers.set(method, [...(handlers.get(method) ?? []), handler]),
    close: () => ws.close(),
  }
}

const OBSERVE = `
try { localStorage.setItem('latch-lang', location.pathname.startsWith('/zh/') ? 'zh' : 'en') } catch (e) {}
window.__m = { lcp: 0, lcpEl: '', cls: 0, tbt: 0, longTasks: 0, shifts: [] };
new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__m.lcp = e.startTime; const el = e.element; window.__m.lcpEl = el ? (el.tagName + ' ' + (el.currentSrc || el.textContent || '').slice(0, 60)) : e.url; } }).observe({ type: 'largest-contentful-paint', buffered: true });
new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__m.cls += e.value; window.__m.shifts.push(e.value.toFixed(4) + ' @' + Math.round(e.startTime) + 'ms ' + (e.sources || []).map((s) => (s.node && (s.node.className || s.node.nodeName)) + ' ' + JSON.stringify(s.previousRect) + '>' + JSON.stringify(s.currentRect)).join(' | ')); } }).observe({ type: 'layout-shift', buffered: true });
new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__m.longTasks++; window.__m.tbt += Math.max(0, e.duration - 50); } }).observe({ type: 'longtask', buffered: true });
`

const READ = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  const res = performance.getEntriesByType('resource');
  const bytes = res.reduce((s, r) => s + (r.transferSize || 0), nav.transferSize || 0);
  const js = res.filter((r) => r.initiatorType === 'script' || /\\.js(\\?|$)/.test(r.name)).reduce((s, r) => s + (r.transferSize || 0), 0);
  const img = res.filter((r) => r.initiatorType === 'img' || /\\.(avif|webp|png|jpe?g|svg)(\\?|$)/.test(r.name)).reduce((s, r) => s + (r.transferSize || 0), 0);
  return JSON.stringify({ ...window.__m, fcp: fcp ? fcp.startTime : 0, ttfb: nav.responseStart, bytes, js, img, requests: res.length + 1 });
})()`

async function measure(cdp: ReturnType<typeof client>, url: string, profile: Profile, scheme: string): Promise<Measured> {
  await cdp.send('Network.clearBrowserCache')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: profile.latency,
    downloadThroughput: profile.down,
    uploadThroughput: profile.up,
  })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu })
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: profile.width,
    height: profile.height,
    deviceScaleFactor: profile.dpr,
    mobile: profile.mobile,
  })
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
  const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVE })
  const loaded = new Promise(resolve => cdp.on('Page.loadEventFired', resolve))
  await cdp.send('Page.navigate', { url })
  await loaded
  await sleep(3500)
  const { result } = await cdp.send('Runtime.evaluate', { expression: READ, returnByValue: true })
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  return JSON.parse(String((result as { value: unknown }).value)) as Measured
}

const ms = (value: number) => `${Math.round(value)} ms`
const kb = (value: number) => `${(value / 1024).toFixed(1)} KB`
try {
  const cdp = client(await connect())
  await cdp.open
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('Runtime.enable')
  const rows = []
  for (const url of urls) {
    for (const [name, profile] of Object.entries(PROFILES)) {
      // The site has one theme, so only the dark scheme is measured.
      for (const scheme of ['dark']) {
        const measured = await measure(cdp, url, profile, scheme)
        if (measured.shifts.length > 0) console.log(url, name, measured.shifts.join('\n  '))
        rows.push({
          url: url.replace(/^https?:\/\/[^/]+/u, ''),
          profile: `${name}/${scheme}`,
          LCP: ms(measured.lcp),
          FCP: ms(measured.fcp),
          CLS: measured.cls.toFixed(3),
          TBT: ms(measured.tbt),
          TTFB: ms(measured.ttfb),
          transferred: kb(measured.bytes),
          images: kb(measured.img),
          js: kb(measured.js),
          requests: measured.requests,
          'LCP element': measured.lcpEl,
        })
      }
    }
  }
  console.table(rows)
  cdp.close()
} finally {
  chrome.kill()
  await sleep(300)
  rmSync(profileDir, { recursive: true, force: true })
}
