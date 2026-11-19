import { describe, expect, it } from 'vitest'
import { AMBIENT_INTERVAL, FRAME_INTERVAL, armDelay, createBackdropEngine, frameTime } from '../src/backdrop-engine.ts'

/**
 * The engine's loop against a simulated display, with the timer up to a millisecond late. A browser answers an animation
 * frame asked for between refreshes in one of two ways: at the next refresh, stamped with it (`next`), or at once,
 * stamped with the refresh before (`at-once`). Returns the gaps between the times the drawn frames stand for, and how
 * many animation frames were asked for.
 */
function simulate(refresh: number, interval: number, answer: 'next' | 'at-once', seconds = 10) {
  let last = 0
  let requests = 0
  let draws = 0
  let lateness = 0
  const gaps: number[] = []
  // The first frame, on a refresh; its callback runs a little after it, and the next is armed from there.
  let clock = refresh * 3
  let stamp = clock
  while (clock < seconds * 1000) {
    const time = frameTime(last, stamp, clock, interval)
    if (time !== null) {
      if (last > 0) gaps.push(time - last)
      last = time
      draws++
    }
    clock += 0.4
    lateness = (lateness + 0.37) % 1
    const fired = clock + armDelay(clock - last, interval) + lateness
    requests++
    if (answer === 'next') {
      stamp = Math.ceil(fired / refresh - 1e-9) * refresh
      clock = stamp + 0.3
    } else {
      stamp = Math.floor(fired / refresh + 1e-9) * refresh
      clock = fired + 0.3
    }
  }
  return { gaps, requests, draws }
}

describe('the background layer’s cadence', () => {
  const cases = [
    { refresh: 1000 / 60, interval: FRAME_INTERVAL },
    { refresh: 1000 / 60, interval: AMBIENT_INTERVAL },
    { refresh: 1000 / 120, interval: FRAME_INTERVAL },
    { refresh: 1000 / 120, interval: AMBIENT_INTERVAL },
  ]
  it.for(cases.flatMap(item => (['next', 'at-once'] as const).map(answer => ({ ...item, answer }))))(
    'draws on an even beat of its interval, one animation frame a frame ($refresh ms refresh, $interval ms, $answer)',
    ({ refresh, interval, answer }) => {
      const { gaps, requests, draws } = simulate(refresh, interval, answer)
      expect(draws).toBeGreaterThan((10_000 / interval) * 0.95)
      for (const gap of gaps) expect(gap).toBeCloseTo(interval, 3)
      // Never one per refresh, and none asked for twice.
      expect(requests).toBeLessThanOrEqual(draws)
    },
  )

  it('keeps to the interval on a refresh rate it does not divide', () => {
    const refresh = 1000 / 144
    for (const answer of ['next', 'at-once'] as const) {
      const { gaps, requests, draws } = simulate(refresh, FRAME_INTERVAL, answer)
      const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(FRAME_INTERVAL - 0.01)
      expect(average).toBeLessThan(FRAME_INTERVAL + refresh)
      expect(requests).toBeLessThanOrEqual(draws * 2)
    }
  })

  it('waits for a frame that comes early, and lets a late one stand for its own time', () => {
    expect(FRAME_INTERVAL - armDelay(0, FRAME_INTERVAL)).toBeGreaterThan(0)
    expect(FRAME_INTERVAL - armDelay(0, FRAME_INTERVAL)).toBeLessThan(1000 / 60)
    expect(armDelay(FRAME_INTERVAL, FRAME_INTERVAL)).toBe(0)
    expect(frameTime(100, 110, 110, FRAME_INTERVAL)).toBeNull()
    expect(frameTime(100, 100 + 1000 / 60, 128, FRAME_INTERVAL)).toBe(100 + FRAME_INTERVAL)
    expect(frameTime(100, 200, 200.5, FRAME_INTERVAL)).toBe(200)
  })
})

/** Counts the calls a 2D context receives, by name, on the canvas the engine draws into. */
function counted(canvas: HTMLCanvasElement): Record<string, number> {
  const context = canvas.getContext('2d')!
  const calls: Record<string, number> = {}
  for (const name of ['fillText', 'fill', 'fillRect', 'stroke', 'drawImage', 'putImageData', 'clearRect', 'rect', 'moveTo'] as const) {
    const original = context[name] as (...args: unknown[]) => unknown
    ;(context as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      calls[name] = (calls[name] ?? 0) + 1
      return original.apply(context, args)
    }
  }
  return calls
}

/** One held frame of `kind` at a size, the engine paused so every change draws at once and nothing runs on a clock. */
function stillFrame(kind: 'digits' | 'field', width: number, height: number) {
  const canvas = document.createElement('canvas')
  const calls = counted(canvas)
  const engine = createBackdropEngine(canvas, kind, 'standard', true)
  engine.pause('test')
  engine.setInk('206, 218, 238', false)
  engine.resize(width, height, 2)
  const first = { ...calls }
  for (const key of Object.keys(calls)) calls[key] = 0
  engine.setHoles([{ left: width / 2 - 300, top: height / 2 - 80, right: width / 2 + 300, bottom: height / 2 + 120, hard: false }])
  const stats = engine.stats()
  engine.destroy()
  return { first, next: { ...calls }, points: stats.points, canvas }
}

describe('the background layer’s work per frame', () => {
  it('draws the digits in a handful of calls whatever the size, and sets their text only once', () => {
    const small = stillFrame('digits', 1440, 900)
    const large = stillFrame('digits', 2560, 1440)
    for (const frame of [small.next, large.next]) {
      // One clear, the sheet, the mask and its upload, one cut per hole: no text, no path, no call per cell.
      expect(frame.fillText ?? 0).toBe(0)
      expect(frame.fill ?? 0).toBe(0)
      expect((frame.clearRect ?? 0) + (frame.fillRect ?? 0) + (frame.drawImage ?? 0)).toBeLessThanOrEqual(4)
    }
    expect(large.next).toEqual(small.next)
    expect(small.points).toBeGreaterThan(0)
    // Lit cells grow with the area; the calls do not.
    expect(large.points).toBeGreaterThan(small.points)
  })

  it('draws the particles in one fill and one stroke per step of alpha, and no more points than its cap', () => {
    const { next, points } = stillFrame('field', 2560, 1440)
    expect((next.fill ?? 0) + (next.stroke ?? 0)).toBeLessThanOrEqual(32)
    expect(next.fillText ?? 0).toBe(0)
    expect(points).toBeLessThanOrEqual(180)
  })
})
