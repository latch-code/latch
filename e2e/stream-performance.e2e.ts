import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus, arch, platform, loadavg } from 'node:os'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type CDPSession, type Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { openSession } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'

// Explicit performance run only: this uses long conversations and DevTools instrumentation, never a real model.
const enabled = process.env.LATCH_STREAM_BENCH === '1'
// Same built page and Host for both arms. Only the test's fixed capability advertisement changes.
const transport = process.env.LATCH_STREAM_TRANSPORT === 'full' ? 'full' : 'delta'
const label = process.env.LATCH_STREAM_LABEL ?? 'baseline'
const output = join('test-results', 'stream-performance', /^[a-z0-9-]{1,48}$/u.test(label) ? label : 'baseline')
const uiDir = resolve(process.env.LATCH_E2E_UI_DIR ?? 'dist/web')
const paragraph = '这是一段固定的中文分析，说明实现、验证和结果。内容需要完整保留，消息身份不随流式更新改变。'
const section = `### 可重复的工作记录\n\n${paragraph.repeat(8)}\n\n- 检查输入与上下文\n- 保留原始内容\n- 验证实际结果\n\n| 项目 | 结果 |\n| --- | --- |\n| 身份 | 稳定 |\n| 状态 | 已核对 |\n\n\`\`\`ts\nconst value = 1\nconst twice = value * 2\nconsole.log(twice)\n\`\`\`\n\n${paragraph.repeat(4)}\n\n`
const liveText = Array.from({ length: Math.ceil(20_000 / section.length) }, () => section)
  .join('')
  .slice(0, 20_000)
const historyText = `${paragraph.repeat(18)}\n\n完成了本轮固定任务。`
const chunkSize = 160
const intervalMs = 40

interface Probe {
  active: boolean
  start: number
  end: number
  frames: number[]
  parses: Array<{ at: number; ms: number; chars: number; live: number; type: 'task-state' | 'task-delta' }>
  longTasks: Array<{ at: number; ms: number }>
}
declare global {
  interface Window {
    latchStreamProbe?: Probe
  }
}
interface TraceEvent {
  name: string
  ph: string
  ts: number
  dur?: number
  pid: number
  tid: number
}
interface Count {
  count: number
  bytes: number
  histogram: number[]
}
interface Traffic {
  kinds: Record<string, Count>
  connections: Array<{ id: number; closedAt?: string }>
}

function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  const quantile = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
  return {
    count: values.length,
    min: sorted[0] ?? 0,
    p50: quantile(0.5),
    p95: quantile(0.95),
    max: sorted.at(-1) ?? 0,
    mean: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
  }
}

async function instrument(page: Page) {
  await page.addInitScript(transport => {
    const fetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      if (url.pathname !== '/link/api/events' || transport !== 'full') return fetch(input, init)
      const headers = new Headers(init?.headers)
      headers.delete('x-latch-state')
      return fetch(input, { ...init, headers })
    }
    const probe: Probe = { active: false, start: 0, end: 0, frames: [], parses: [], longTasks: [] }
    window.latchStreamProbe = probe
    const parse = JSON.parse.bind(JSON)
    const lengths = new Map<string, number>()
    JSON.parse = (text, reviver) => {
      const start = performance.now()
      const result: unknown = parse(text, reviver)
      const elapsed = performance.now() - start
      if (result && typeof result === 'object' && 'type' in result && (result.type === 'task-state' || result.type === 'task-delta')) {
        const event = result as {
          type: 'task-state' | 'task-delta'
          sessionId: string
          detail?: { liveText?: string }
          text?: { append: string }
          stream?: { subscriptionId: string }
        }
        const key = `${event.sessionId}:${event.stream?.subscriptionId ?? 'full'}`
        const live =
          event.type === 'task-state' ? (event.detail?.liveText?.length ?? 0) : (lengths.get(key) ?? 0) + (event.text?.append.length ?? 0)
        lengths.set(key, live)
        if (probe.active) probe.parses.push({ at: start, ms: elapsed, chars: text.length, live, type: event.type })
      }
      return result
    }
    const observer = new PerformanceObserver(list => {
      if (!probe.active) return
      for (const entry of list.getEntries()) probe.longTasks.push({ at: entry.startTime, ms: entry.duration })
    })
    observer.observe({ type: 'longtask', buffered: false })
    const frame = () => {
      if (probe.active && probe.frames.length < 30_000) probe.frames.push(performance.now())
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }, transport)
}

async function metrics(cdp: CDPSession) {
  const [{ metrics }, dom] = await Promise.all([
    cdp.send('Performance.getMetrics') as Promise<{ metrics: Array<{ name: string; value: number }> }>,
    cdp.send('Memory.getDOMCounters') as Promise<{ documents: number; nodes: number; jsEventListeners: number }>,
  ])
  const wanted = ['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration', 'JSHeapUsedSize', 'JSHeapTotalSize']
  return { ...Object.fromEntries(metrics.filter(item => wanted.includes(item.name)).map(item => [item.name, item.value])), ...dom }
}

/** Union nested script intervals; a React callback inside a microtask must count only once. */
function scriptFrames(trace: TraceEvent[], probe: Probe) {
  const mark = trace.find(event => event.name === 'latch-stream-start')
  if (!mark) throw new Error('The renderer timing marker is missing')
  const offset = mark.ts / 1000 - probe.start
  const names = new Set(['FunctionCall', 'EvaluateScript', 'RunMicrotasks', 'FireAnimationFrame', 'EventDispatch', 'TimerFire'])
  const intervals = trace
    .filter(event => event.pid === mark.pid && event.tid === mark.tid && event.ph === 'X' && event.dur && names.has(event.name))
    .map(event => [event.ts / 1000 - offset, (event.ts + event.dur!) / 1000 - offset] as [number, number])
    .sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const interval of intervals) {
    const last = merged.at(-1)
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1])
    else merged.push([...interval])
  }
  const frames = [probe.start, ...probe.frames, probe.end]
  const values: number[] = []
  let cursor = 0
  for (let i = 1; i < frames.length; i++) {
    const from = frames[i - 1]!,
      to = frames[i]!
    while (cursor < merged.length && merged[cursor]![1] <= from) cursor++
    let value = 0
    for (let j = cursor; j < merged.length && merged[j]![0] < to; j++)
      value += Math.max(0, Math.min(to, merged[j]![1]) - Math.max(from, merged[j]![0]))
    values.push(value)
  }
  return values.map((ms, i) => ({ at: frames[i]!, until: frames[i + 1]!, ms }))
}

/** Exact SSE frame bytes from the browser's own connection, decoded in the test process, never in the timed page. */
async function wireMeter(cdp: CDPSession) {
  let active = false,
    supported = true
  const frames: number[] = []
  const full: number[] = [],
    delta: number[] = []
  const streams = new Map<string, { decoder: StringDecoder; text: string }>()
  const accept = (id: string, data: string) => {
    const stream = streams.get(id)
    if (!stream) return
    stream.text += stream.decoder.write(Buffer.from(data, 'base64'))
    if (stream.text.length > 8 * 1024 * 1024) throw new Error('Performance fixture frame exceeded its bounded buffer')
    for (;;) {
      const at = stream.text.indexOf('\n\n')
      if (at < 0) break
      const frame = stream.text.slice(0, at + 2)
      stream.text = stream.text.slice(at + 2)
      if (active) {
        const head = frame.slice(0, 200)
        const group = head.includes('event: task-state\n') ? full : head.includes('event: task-delta\n') ? delta : undefined
        if (group) {
          const bytes = Buffer.byteLength(frame)
          frames.push(bytes)
          group.push(bytes)
        }
      }
    }
  }
  cdp.on('Network.responseReceived', event => {
    const parsed = new URL(event.response.url)
    if (parsed.pathname !== '/link/api/events') return
    streams.set(event.requestId, { decoder: new StringDecoder('utf8'), text: '' })
    void cdp
      .send('Network.streamResourceContent', { requestId: event.requestId })
      .then(result => {
        if (result.bufferedData) accept(event.requestId, result.bufferedData)
      })
      .catch(() => {
        supported = false
      })
  })
  cdp.on('Network.dataReceived', event => {
    if (event.data) accept(event.requestId, event.data)
  })
  await cdp.send('Network.enable')
  return {
    begin: () => {
      active = true
    },
    end: () => {
      active = false
      return { supported, frames, full, delta }
    },
  }
}

describe.runIf(enabled)('stream performance baseline', () => {
  it.each([10, 100, 300])(
    '%i history turns and a 20000-character reply at CPU 4x',
    async rounds => {
      const plugin: HarnessPlugin = {
        id: 'stream-benchmark',
        name: '固定流式性能夹具',
        version: '1',
        description: 'Local deterministic provider; no model network',
        activate(ctx) {
          ctx.registerProvider({
            id: 'stream-benchmark',
            name: '固定流式夹具',
            model: 'fixture',
            async *stream({ messages, signal }) {
              const prompt = messages.findLast(message => message.role === 'user')?.content
              if (prompt === 'benchmark-live') {
                for (let at = 0; at < liveText.length; at += chunkSize) {
                  signal.throwIfAborted()
                  yield { type: 'text', text: liveText.slice(at, at + chunkSize) }
                  await delay(intervalMs, undefined, { signal })
                }
              } else yield { type: 'text', text: historyText }
              yield { type: 'finish', reason: 'stop' }
            },
          })
        },
      }
      const host = await startTestHost({ demo: false, plugins: [plugin], hostName: '性能基线', uiDir })
      const browser = await chromium.launch(browserLaunchOptions())
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', reducedMotion: 'reduce' })
      const page = await context.newPage()
      page.setDefaultTimeout(30_000)
      let tracing = false
      try {
        const owner = await host.enroll({ listener: 'unix' })
        const bridge = host.host.bridge
        const { sessionId } = await bridge.createTask({
          prompt: 'history-0',
          requestId: randomUUID(),
          mode: 'chat',
          model: { providerId: 'stream-benchmark', model: 'fixture' },
        })
        const settle = async () => {
          await expect.poll(async () => (await bridge.detail(sessionId)).summary.status, { interval: 5, timeout: 20_000 }).toBe('idle')
        }
        await settle()
        for (let i = 1; i < rounds; i++) {
          await bridge.prompt(sessionId, `history-${i}`, randomUUID())
          await settle()
        }
        expect((await bridge.detail(sessionId)).messages.filter(message => message.role === 'assistant')).toHaveLength(rounds)
        await instrument(page)
        const cdp = await context.newCDPSession(page)
        await cdp.send('Performance.enable')
        const meter = await wireMeter(cdp)
        await enrollBrowser(page, host, { name: '流式性能', scopes: ['view', 'run'] })
        await openSession(page, sessionId)
        const input = page.getByRole('textbox', { name: '继续对话', exact: true })
        await input.waitFor()
        await page.evaluate(() => document.fonts.ready)
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
        const loadBefore = loadavg()
        const before = await metrics(cdp)
        const trafficBefore = await owner.json<Traffic>('traffic')
        const trace: TraceEvent[] = []
        cdp.on('Tracing.dataCollected', event => {
          for (const value of event.value as unknown as TraceEvent[])
            if (trace.length < 250_000)
              trace.push({ name: value.name, ph: value.ph, ts: value.ts, dur: value.dur, pid: value.pid, tid: value.tid })
        })
        await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing', transferMode: 'ReportEvents' })
        tracing = true
        const profiling = process.env.LATCH_STREAM_PROFILE === '1'
        if (profiling) {
          await cdp.send('Profiler.enable')
          await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
          await cdp.send('Profiler.start')
        }
        meter.begin()
        await page.evaluate(() => {
          const probe = window.latchStreamProbe!
          probe.start = performance.now()
          performance.mark('latch-stream-start')
          probe.active = true
        })
        // The page sends through its normal composer; Host authority, stream parser and message identity stay real.
        await input.fill('benchmark-live')
        await input.press('Meta+Enter')
        await expect
          .poll(async () => (await bridge.detail(sessionId)).messages.filter(message => message.role === 'assistant').length, {
            timeout: 90_000,
          })
          .toBe(rounds + 1)
        const content = page.locator('.turn-reply .message-content').last()
        await expect.poll(() => page.locator('.turn-reply .message-content').count(), { timeout: 90_000 }).toBe(rounds + 1)
        await expect.poll(() => content.getAttribute('aria-busy'), { timeout: 90_000 }).toBe(null)
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        const probe = await page.evaluate(() => {
          const probe = window.latchStreamProbe!
          probe.end = performance.now()
          probe.active = false
          performance.mark('latch-stream-end')
          return probe
        })
        const wire = meter.end()
        const ended = new Promise<void>(resolve => cdp.once('Tracing.tracingComplete', () => resolve()))
        await cdp.send('Tracing.end')
        await ended
        tracing = false
        if (profiling) {
          const { profile } = await cdp.send('Profiler.stop')
          await mkdir(output, { recursive: true })
          await writeFile(
            join(output, `${rounds}-turns-profile.json`),
            JSON.stringify({
              nodes: profile.nodes.map(node => ({
                id: node.id,
                children: node.children,
                functionName: node.callFrame.functionName,
                file: node.callFrame.url.split('/').at(-1)?.split('?')[0],
                line: node.callFrame.lineNumber,
                column: node.callFrame.columnNumber,
              })),
              samples: profile.samples,
              timeDeltas: profile.timeDeltas,
            }),
          )
        }
        const after = await metrics(cdp)
        const trafficAfter = await owner.json<Traffic>('traffic')
        const perKind = (kind: string) => {
          const first = trafficBefore.kinds[kind],
            last = trafficAfter.kinds[kind]
          return {
            frames: (last?.count ?? 0) - (first?.count ?? 0),
            bytes: (last?.bytes ?? 0) - (first?.bytes ?? 0),
            histogram: (last?.histogram ?? []).map((value, i) => value - (first?.histogram[i] ?? 0)),
          }
        }
        const fullTraffic = perKind('task-state'),
          deltaTraffic = perKind('task-delta')
        const frameCount = fullTraffic.frames + deltaTraffic.frames,
          frameBytes = fullTraffic.bytes + deltaTraffic.bytes
        const scripts = scriptFrames(trace, probe)
        const lateStart = probe.parses.find(item => item.live >= 15_000)?.at ?? probe.end
        const lastLive = probe.parses.findLast(item => item.live > 0)?.at ?? probe.start
        const durationMs = probe.end - probe.start
        const lateScripts = distribution(scripts.filter(item => item.at >= lateStart && item.until <= lastLive).map(item => item.ms))
        // A fixed sequence of real wheel input also exercises content-visibility while reading older turns.
        const transcript = page.locator('.transcript').filter({ visible: true })
        const scrollBefore = await transcript.evaluate(element => element.scrollTop)
        await transcript.hover()
        await page.evaluate(() => {
          const probe = window.latchStreamProbe!
          probe.frames = []
          probe.longTasks = []
          probe.parses = []
          probe.start = performance.now()
          probe.active = true
        })
        for (let i = 0; i < 24; i++) {
          await page.mouse.wheel(0, -1000)
          await delay(64)
        }
        const scrollProbe = await page.evaluate(() => {
          const probe = window.latchStreamProbe!
          probe.end = performance.now()
          probe.active = false
          return probe
        })
        const scrollAfter = await transcript.evaluate(element => element.scrollTop)
        const afterScroll = await metrics(cdp)
        const report = {
          schema: 1,
          label,
          transport,
          rounds,
          baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          uiIndexSha256: createHash('sha256')
            .update(await readFile(join(uiDir, 'index.html')))
            .digest('hex'),
          sourceRendererSha256: createHash('sha256')
            .update(await readFile('apps/web/src/MessageContent.tsx'))
            .digest('hex'),
          sourceTransportSha256: createHash('sha256')
            .update(await readFile('packages/protocol/src/task-delta.ts'))
            .update(await readFile('apps/host/src/task-delta.ts'))
            .update(await readFile('apps/web/src/core/taskStream.ts'))
            .update(await readFile('apps/web/src/core/eventStream.ts'))
            .update(await readFile('apps/web/src/core/useHarness.ts'))
            .digest('hex'),
          browser: browser.version(),
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0]?.model,
          viewport: { width: 390, height: 844 },
          cpuSlowdown: 4,
          reducedMotion: true,
          concurrentLoad: { coordinatedQuietWindow: process.env.LATCH_STREAM_QUIET === '1', loadBefore, loadAfter: loadavg() },
          fixture: {
            liveCharacters: liveText.length,
            liveSha256: createHash('sha256').update(liveText).digest('hex'),
            historyCharactersPerReply: historyText.length,
            chunkSize,
            intervalMs,
          },
          durationMs,
          hostTraffic: {
            frames: frameCount,
            bytes: frameBytes,
            bytesPerFrame: frameBytes / Math.max(1, frameCount),
            histogram: fullTraffic.histogram.map((value, i) => value + (deltaTraffic.histogram[i] ?? 0)),
            framesPerSecond: (frameCount / durationMs) * 1000,
            full: fullTraffic,
            delta: deltaTraffic,
            connectionsOpened: trafficAfter.connections.length - trafficBefore.connections.length,
          },
          wire: {
            supported: wire.supported,
            bytes: distribution(wire.frames),
            samples: wire.frames,
            full: distribution(wire.full),
            delta: distribution(wire.delta),
            firstFullFrameBytes: wire.full[0] ?? null,
            finalFullFrameBytes: wire.full.at(-1) ?? null,
            fullSamples: wire.full,
            deltaSamples: wire.delta,
          },
          jsonParseMs: distribution(probe.parses.map(item => item.ms)),
          parseSamples: probe.parses,
          scriptMsPerAnimationFrame: distribution(scripts.map(item => item.ms)),
          lateStreamingScriptMs: lateScripts,
          budget: {
            maxLateScriptMs: 8,
            noLongTasks: true,
            passed: lateScripts.count > 0 && lateScripts.max <= 8 && probe.longTasks.length === 0,
          },
          scriptFrameSamples: scripts,
          animationFrameMs: distribution(probe.frames.slice(1).map((at, i) => at - probe.frames[i]!)),
          longTasks: probe.longTasks,
          before,
          after,
          scroll: {
            requestedPixels: 24_000,
            actualPixels: scrollBefore - scrollAfter,
            durationMs: scrollProbe.end - scrollProbe.start,
            framesPerSecond: (scrollProbe.frames.length / (scrollProbe.end - scrollProbe.start)) * 1000,
            frameMs: distribution(scrollProbe.frames.slice(1).map((at, i) => at - scrollProbe.frames[i]!)),
            longTasks: scrollProbe.longTasks,
            after: afterScroll,
          },
          notes: [
            'Both transport arms use the same built page and Host; full removes only the fixed capability header inside the test browser.',
            'JSON.parse is timed around the real parser; validation remains included in renderer script time.',
            'Script intervals are unioned on the timing-marker renderer thread and split at observed animation-frame callbacks; this includes probe overhead.',
            'Host bytes exclude HTTP/TLS overhead; the optional CDP stream meter records exact SSE text-frame sizes in the test process.',
            'No performance budget assertion in a baseline run; missing evidence or a changed final response fails the test.',
          ],
        }
        expect(probe.parses.length).toBeGreaterThan(0)
        expect(scripts.length).toBeGreaterThan(0)
        expect((await bridge.detail(sessionId)).messages.filter(message => message.role === 'assistant').at(-1)?.text).toBe(liveText)
        await mkdir(output, { recursive: true })
        await writeFile(join(output, `${rounds}-turns.json`), JSON.stringify(report, null, 2) + '\n')
        await page.screenshot({ path: join(output, `${rounds}-turns.png`) })
        if (transport === 'full') expect(deltaTraffic.frames).toBe(0)
        else expect(deltaTraffic.frames).toBeGreaterThan(0)
        if (process.env.LATCH_STREAM_ENFORCE_BUDGET === '1') expect(report.budget.passed).toBe(true)
      } finally {
        if (tracing) await (await context.newCDPSession(page)).send('Tracing.end').catch(() => {})
        await context.close()
        await browser.close()
        await host.close()
      }
    },
    240_000,
  )
})
