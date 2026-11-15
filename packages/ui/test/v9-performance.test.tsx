import { useState } from 'react'
import { flushSync } from 'react-dom'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { cdp, commands, page } from 'vitest/browser'
import {
  Backdrop,
  LiveChanges,
  Roll,
  enter,
  exit,
  flip,
  moveLane,
  resolveAndRise,
  sendLift,
  sheenOnce,
  stagger,
  type BackdropKind,
  type BackdropLevel,
  type BackdropStats,
} from '../src/index.ts'

/*
 * The measurement harness of the v9 foundation: script time per frame of the background layer, and the script a move
 * costs in the frame that starts it, on a 1440 × 900 window with the CPU slowed four times. The budget is 8ms of
 * script a frame. It only measures script; what the compositor spends is not seen from here.
 *
 * It is skipped unless asked for, on a quiet machine:
 *   VITE_LATCH_UI_PERF=1 pnpm exec vitest run --config vitest.config.ts packages/ui/test/v9-performance.test.tsx
 * The readings go to test-results/v9-foundation/performance.json; VITE_LATCH_UI_PERF_ENFORCE=1 also fails the run
 * when a reading is over the budget. Times are for comparing on one machine, not thresholds across machines.
 */
const env = import.meta.env as Record<string, string | undefined>
const BUDGET = 8
const pause = (ms: number) => new Promise(done => setTimeout(done, ms))
const painted = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
const round = (value: number) => Math.round(value * 100) / 100

function summary(samples: number[]): { runs: number; avgMs: number; p95Ms: number; maxMs: number } {
  const sorted = samples.toSorted((a, b) => a - b)
  return {
    runs: sorted.length,
    avgMs: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p95Ms: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!),
    maxMs: round(sorted.at(-1)!),
  }
}

function Window({
  kind,
  level,
  focus,
  stats,
}: {
  kind: BackdropKind
  level: BackdropLevel
  focus: boolean
  stats: { read: (() => BackdropStats) | null }
}) {
  return (
    <div className="ui-backdrop-host" style={{ position: 'fixed', inset: 0 }}>
      <Backdrop
        kind={kind}
        level={level}
        running={3}
        focus={focus}
        fixed
        onStats={read => {
          stats.read = read
        }}
      />
      {/* Regions of words set straight on the canvas and a card, as a home has them. */}
      <div data-backdrop-clear="" style={{ position: 'absolute', left: 280, top: 220, width: 520, height: 560 }} />
      <div data-backdrop-clear="" style={{ position: 'absolute', left: 860, top: 220, width: 420, height: 260 }} />
      <div data-secure="" style={{ position: 'absolute', left: 300, top: 240, width: 480, height: 150 }} />
    </div>
  )
}

function rows(count: number): { root: HTMLElement; items: HTMLElement[] } {
  const root = document.createElement('div')
  root.style.cssText = 'position: fixed; left: 40px; top: 40px; width: 320px'
  const items = Array.from({ length: count }, (_, index) => {
    const row = document.createElement('div')
    row.textContent = `会话 ${index}`
    row.style.cssText = 'height: 44px; padding: 12px 8px'
    root.append(row)
    return row
  })
  document.body.append(root)
  return { root, items }
}

/** Times the script of `run` in the frame that starts a move, `runs` times, with a painted frame between. */
async function time(runs: number, setup: () => { run: () => void; done: () => void }): Promise<ReturnType<typeof summary>> {
  const samples: number[] = []
  for (let index = 0; index < runs; index++) {
    const { run, done } = setup()
    await painted()
    const start = performance.now()
    run()
    samples.push(performance.now() - start)
    await painted()
    done()
  }
  return summary(samples)
}

describe.runIf(env.VITE_LATCH_UI_PERF === '1')('v9 foundation: script time per frame under a 4× CPU slowdown', () => {
  it('measures the background layer and the moves against the 8ms budget', { timeout: 180_000 }, async () => {
    await page.viewport(1440, 900)
    await cdp().send('Emulation.setCPUThrottlingRate', { rate: 4 })
    const backdrop: Record<string, unknown> = {}
    const moves: Record<string, ReturnType<typeof summary>> = {}
    const foreground = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    try {
      for (const kind of ['grid', 'field', 'glow'] as const)
        for (const level of ['light', 'standard'] as const)
          for (const focus of [false, true]) {
            const stats = { read: null as (() => BackdropStats) | null }
            const screen = await render(<Window kind={kind} level={level} focus={focus} stats={stats} />)
            await pause(3000)
            const read = stats.read?.()
            backdrop[`${kind} ${level}${focus ? ' focused' : ''}`] = read && {
              frames: read.frames,
              points: read.points,
              avgMs: round(read.avg),
              p95Ms: round(read.p95),
              maxMs: round(read.max),
              minFrameGapMs: round(read.minGap),
            }
            await screen.unmount()
          }

      moves['enter'] = await time(20, () => {
        const { root, items } = rows(1)
        return { run: () => void enter(items[0]!), done: () => root.remove() }
      })
      moves['exit'] = await time(20, () => {
        const { root, items } = rows(1)
        return { run: () => void exit(items[0]!), done: () => root.remove() }
      })
      moves['flip, 12 rows'] = await time(20, () => {
        const { root, items } = rows(13)
        return {
          run: () =>
            void flip(items.slice(1), () => {
              items[0]!.remove()
            }),
          done: () => root.remove(),
        }
      })
      moves['resolve: wipe starts'] = await time(20, () => {
        const { root, items } = rows(6)
        return { run: () => void resolveAndRise(items[0]!, items.slice(1), () => items[0]!.remove()), done: () => root.remove() }
      })
      moves['move-lane: row leaves'] = await time(20, () => {
        const { root, items } = rows(6)
        return { run: () => void moveLane(items[0]!, items.slice(1), () => root.append(items[0]!)), done: () => root.remove() }
      })
      moves['menu, 8 items'] = await time(20, () => {
        const { root, items } = rows(8)
        return { run: () => void stagger(items), done: () => root.remove() }
      })
      moves['send-lift'] = await time(20, () => {
        const { root, items } = rows(2)
        const from = items[1]!.getBoundingClientRect()
        return { run: () => void sendLift(items[0]!, from), done: () => root.remove() }
      })
      moves['done-sheen'] = await time(20, () => {
        const { root, items } = rows(1)
        return { run: () => void sheenOnce(items[0]!), done: () => root.remove() }
      })

      let set: (value: number) => void = () => {}
      function Counter() {
        const [count, setCount] = useState(0)
        set = setCount
        return (
          <LiveChanges value="perf">
            <Roll value={count} />
          </LiveChanges>
        )
      }
      const counter = await render(<Counter />)
      let next = 0
      moves['roll: a count changes'] = await time(20, () => ({
        run: () => {
          flushSync(() => {
            set(++next)
          })
        },
        done: () => {},
      }))
      await counter.unmount()
    } finally {
      foreground.mockRestore()
      await cdp().send('Emulation.setCPUThrottlingRate', { rate: 1 })
      await page.viewport(1280, 800)
    }
    const over = [
      ...Object.entries(backdrop).filter(([, read]) => read && (read as { maxMs: number }).maxMs > BUDGET),
      ...Object.entries(moves).filter(([, read]) => read.maxMs > BUDGET),
    ].map(([name]) => name)
    const report = {
      note: 'Headless Chrome, 1440 × 900, CPU throttled 4×. Script time only; compositor time is not measured here.',
      budgetMs: BUDGET,
      backdropPerFrame: backdrop,
      movesStartingFrame: moves,
      overBudget: over,
    }
    await commands.writeFile('test-results/v9-foundation/performance.json', JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    expect(Object.values(backdrop).every(Boolean)).toBe(true)
    if (env.VITE_LATCH_UI_PERF_ENFORCE === '1') expect(over).toEqual([])
  })
})
