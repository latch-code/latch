import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_BRACKETS, AGENT_EYES, type AgentAvatar as Avatar, type AgentFace } from '@latch/protocol'
import { AgentAvatar } from '../src/agents/AgentAvatar.tsx'
import { BRACKET_PATHS, type AvatarState } from '../src/agents/avatarFace.ts'
import {
  AvatarScheduler,
  browserMotionHost,
  LOOP_MS,
  MAX_FEATURED,
  TICK_MS,
  type MotionHost,
  type MotionPart,
} from '../src/agents/avatarMotion.ts'

const face = (extra: Partial<AgentFace> = {}): Avatar => ({ kind: 'face', bracket: 'round', eyes: 'dot', hue: 'pine', ...extra })
const render = (props: Parameters<typeof AgentAvatar>[0]) => renderToStaticMarkup(createElement(AgentAvatar, props))

describe('the bracket face', () => {
  it('draws all 16 brackets × eyes on the 40 grid, in the hue, with no words, mouth or gloss', () => {
    for (const bracket of AGENT_BRACKETS)
      for (const eyes of AGENT_EYES) {
        const markup = render({ avatar: face({ bracket, eyes }), size: 40 })
        expect(markup).toContain('viewBox="0 0 40 40"')
        expect(markup).toContain('data-hue="pine"')
        for (const d of BRACKET_PATHS[bracket]) expect(markup).toContain(`d="${d}"`)
        const shape = { dot: '<circle cx="16.9"', oval: '<ellipse cx="16.9"', arc: 'M15.2 22.1 Q16.9 19.4', sleepy: 'M15.4 21.4 H18.4' }[
          eyes
        ]
        expect(markup).toContain(shape)
        expect(markup).not.toMatch(/<text|<image|gradient/u)
        expect(markup).toContain('aria-hidden="true"')
      }
  })

  it('names a face only where it stands for itself, and draws 通用 in grey', () => {
    expect(render({ avatar: face({ bracket: 'curly', eyes: 'arc', hue: 'plum' }), size: 32, decorative: false })).toContain(
      'aria-label="花括号、弯眼、李"',
    )
    expect(render({ avatar: 'general', size: 40 })).toContain('data-hue="neutral"')
  })

  it('wears a prop for its state only from 32px; smaller faces leave the state to the word beside them', () => {
    const props = (state: AvatarState, size: number) => {
      const markup = render({ avatar: face(), size, state })
      return {
        cursor: markup.includes('agent-avatar-cursor'),
        ask: markup.includes('data-tone="waiting"'),
        alert: markup.includes('data-tone="failed"'),
        sleep: markup.includes('agent-avatar-sleep'),
      }
    }
    const none = { cursor: false, ask: false, alert: false, sleep: false }
    for (const size of [32, 40, 56]) {
      expect(props('idle', size)).toEqual(none)
      expect(props('running', size)).toEqual({ ...none, cursor: true })
      expect(props('waiting', size)).toEqual({ ...none, ask: true })
      expect(props('failed', size)).toEqual({ ...none, alert: true })
      expect(props('resting', size)).toEqual({ ...none, sleep: true })
    }
    for (const size of [16, 20, 24])
      for (const state of ['idle', 'running', 'waiting', 'failed', 'resting'] as const) expect(props(state, size)).toEqual(none)
    // Resting closes the eyes at every size.
    expect(render({ avatar: face(), size: 16, state: 'resting' })).toContain('M15.4 21.4 H18.4')
    expect(render({ avatar: face(), size: 40 })).toContain('data-tier="full"')
    expect(render({ avatar: face(), size: 24 })).toContain('data-tier="blink"')
    expect(render({ avatar: face(), size: 16 })).toContain('data-tier="still"')
  })
})

/** A page for the scheduler with a hand-driven clock and visibility. */
function fakeHost(options: { still?: boolean; random?: () => number } = {}) {
  let now = 0
  const intervals = new Map<number, () => void>()
  let next = 1
  const seen = new Map<object, (visible: boolean) => void>()
  let changed = () => {}
  const state = { hidden: false, still: options.still ?? false, setIntervalCalls: 0, watching: 0 }
  const host: MotionHost = {
    now: () => now,
    random: options.random ?? (() => 0.5),
    setInterval(run) {
      state.setIntervalCalls++
      intervals.set(next, run)
      return next++
    },
    clearInterval(handle) {
      intervals.delete(handle as number)
    },
    hidden: () => state.hidden,
    still: () => state.still,
    watch(callback) {
      changed = callback
      state.watching++
      return () => {
        state.watching--
      }
    },
    observe(element, callback) {
      seen.set(element, callback)
      return () => seen.delete(element)
    },
  }
  return {
    host,
    state,
    intervals,
    seen,
    show: (element: object, visible = true) => seen.get(element)?.(visible),
    change: () => {
      changed()
    },
    advance(ms: number) {
      for (let at = 0; at < ms; at += TICK_MS) {
        now += TICK_MS
        for (const run of [...intervals.values()]) run()
      }
    },
  }
}
function fakeAvatar() {
  const played: Array<{ part: MotionPart; at: number; duration: number }> = []
  let clock = () => 0
  const moving: boolean[] = []
  const phases: number[] = []
  const looping: Array<{ value: boolean; at: number }> = []
  return {
    looping,
    element: {} as Element,
    played,
    moving,
    phases,
    clockFrom(now: () => number) {
      clock = now
    },
    target: {
      play(part: MotionPart, _keyframes: Keyframe[], duration: number) {
        played.push({ part, at: clock(), duration })
      },
      setMoving(value: boolean) {
        moving.push(value)
      },
      setPhase(seconds: number) {
        phases.push(seconds)
      },
      setLooping(value: boolean) {
        looping.push({ value, at: clock() })
      },
    },
  }
}

describe('the motion scheduler', () => {
  it('drives every avatar with one interval, only while one is in view and the page is shown', () => {
    const page = fakeHost()
    const scheduler = new AvatarScheduler(page.host)
    const avatars = Array.from({ length: 12 }, fakeAvatar)
    for (const avatar of avatars) scheduler.add(avatar.element, avatar.target, 'full', 'idle')
    // Nothing in view yet: no timer at all.
    expect(scheduler.running).toBe(false)
    for (const avatar of avatars) page.show(avatar.element)
    expect(page.state.setIntervalCalls).toBe(1)
    expect(page.intervals.size).toBe(1)
    page.advance(10_000)
    expect(avatars.every(avatar => avatar.played.length > 0)).toBe(true)
    // A hidden page stops the timer; showing it again starts one, never a second.
    page.state.hidden = true
    page.change()
    expect(page.intervals.size).toBe(0)
    page.state.hidden = false
    page.change()
    expect(page.intervals.size).toBe(1)
  })

  it('leaves a face out of view alone', () => {
    const page = fakeHost()
    const scheduler = new AvatarScheduler(page.host)
    const shown = fakeAvatar()
    const away = fakeAvatar()
    scheduler.add(shown.element, shown.target, 'full', 'idle')
    scheduler.add(away.element, away.target, 'full', 'idle')
    page.show(shown.element)
    page.advance(20_000)
    expect(shown.played.length).toBeGreaterThan(0)
    expect(away.played).toEqual([])
    expect(away.moving.at(-1)).toBe(false)
  })

  it('stands still under reduced motion or a frozen page: no timer, no motion, props at rest', () => {
    const page = fakeHost({ still: true })
    const scheduler = new AvatarScheduler(page.host)
    const avatar = fakeAvatar()
    const handle = scheduler.add(avatar.element, avatar.target, 'full', 'running')
    page.show(avatar.element)
    handle.setState('idle')
    handle.celebrate()
    page.advance(20_000)
    expect(page.state.setIntervalCalls).toBe(0)
    expect(avatar.played).toEqual([])
    expect(avatar.moving.every(value => !value)).toBe(true)
  })

  it('reads 减弱 on this device and the capture freeze from the page, each by its own attribute, and watches both', () => {
    const dataset: Record<string, string> = {}
    const system = { matches: false, addEventListener: () => {}, removeEventListener: () => {} }
    const observed: Array<{ attributeFilter?: string[] }> = []
    let disconnected = 0
    vi.stubGlobal('document', {
      documentElement: { dataset },
      visibilityState: 'visible',
      addEventListener: () => {},
      removeEventListener: () => {},
    })
    // The system does not ask for less motion: `no-preference` matches, `reduce` does not.
    vi.stubGlobal('matchMedia', (query: string) => ({ ...system, matches: query.includes('no-preference') }))
    vi.stubGlobal(
      'MutationObserver',
      class {
        observe(_target: unknown, options: { attributeFilter?: string[] }) {
          observed.push(options)
        }
        disconnect() {
          disconnected++
        }
      },
    )
    try {
      const host = browserMotionHost()
      expect(host.still()).toBe(false)
      dataset.motion = 'reduce'
      expect(host.still()).toBe(true)
      delete dataset.motion
      // The capture freeze is its own attribute: the setting writing or removing data-motion never clears it.
      dataset.capture = 'still'
      expect(host.still()).toBe(true)
      dataset.motion = 'still'
      delete dataset.capture
      expect(host.still()).toBe(false)
      const stop = host.watch(() => {})
      expect(observed.map(options => options.attributeFilter)).toEqual([['data-motion', 'data-capture']])
      stop()
      expect(disconnected).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('stands the faces still for 减弱: the scheduler of a page that chose it starts no timer and plays nothing', () => {
    const dataset: Record<string, string> = { motion: 'reduce' }
    vi.stubGlobal('document', { documentElement: { dataset } })
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('no-preference') }))
    try {
      const page = fakeHost()
      // The real host's answer, on the fake page's clock and timers.
      const scheduler = new AvatarScheduler({ ...page.host, still: browserMotionHost().still })
      const avatar = fakeAvatar()
      const handle = scheduler.add(avatar.element, avatar.target, 'full', 'running')
      page.show(avatar.element)
      handle.celebrate()
      page.advance(20_000)
      expect(page.state.setIntervalCalls).toBe(0)
      expect(avatar.played).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('squints or shows a prop on at most three faces at once', () => {
    // Every roll is a squint for an idle face; every waiting face wants its ?.
    const page = fakeHost({ random: () => 0.95 })
    const scheduler = new AvatarScheduler(page.host)
    const avatars = Array.from({ length: 8 }, (_, index) => ({ ...fakeAvatar(), state: (index % 2 ? 'waiting' : 'idle') as AvatarState }))
    for (const avatar of avatars) {
      avatar.clockFrom(page.host.now)
      scheduler.add(avatar.element, avatar.target, 'full', avatar.state)
      page.show(avatar.element)
    }
    page.advance(30_000)
    const featured = avatars.flatMap(avatar =>
      avatar.played.filter(item => item.part === 'happy' || item.part === 'ask').map(item => [item.at, item.at + item.duration]),
    )
    expect(featured.length).toBeGreaterThan(3)
    const peak = Math.max(...featured.map(([start]) => featured.filter(([from, to]) => from! <= start! && start! < to!).length))
    expect(peak).toBeLessThanOrEqual(MAX_FEATURED)
  })

  it('blinks only, and seldom, at 20–31px; a finished run squints once only on a full-size face', () => {
    const page = fakeHost({ random: () => 0.95 })
    const scheduler = new AvatarScheduler(page.host)
    const small = fakeAvatar()
    const large = fakeAvatar()
    const smallHandle = scheduler.add(small.element, small.target, 'blink', 'idle')
    const largeHandle = scheduler.add(large.element, large.target, 'full', 'running')
    page.show(small.element)
    page.show(large.element)
    smallHandle.celebrate()
    largeHandle.setState('idle')
    largeHandle.celebrate()
    expect(large.played.map(item => item.part)).toEqual(['base', 'happy'])
    page.advance(30_000)
    expect(new Set(small.played.map(item => item.part))).toEqual(new Set(['eye']))
    expect(small.played.length).toBeLessThanOrEqual(30_000 / 5000 + 1)
    expect(small.moving.at(-1)).toBe(false)
    expect(large.moving.at(-1)).toBe(true)
  })

  it('lets go of everything on unmount: the interval, the observer and the visibility listener', () => {
    const page = fakeHost()
    const scheduler = new AvatarScheduler(page.host)
    const one = fakeAvatar()
    const two = fakeAvatar()
    const first = scheduler.add(one.element, one.target, 'full', 'running')
    const second = scheduler.add(two.element, two.target, 'blink', 'idle')
    page.show(one.element)
    page.show(two.element)
    expect([page.intervals.size, page.seen.size, page.state.watching]).toEqual([1, 2, 1])
    first.remove()
    expect([page.intervals.size, page.seen.size, page.state.watching]).toEqual([1, 1, 1])
    second.remove()
    expect([page.intervals.size, page.seen.size, page.state.watching]).toEqual([0, 0, 0])
    expect(scheduler.running).toBe(false)
  })

  it('starts each face’s loops and first blink at its own time, and a finished run waits for a free place', () => {
    let seed = 0
    const page = fakeHost({ random: () => (seed = (seed * 9301 + 49297) % 233280) / 233280 })
    const scheduler = new AvatarScheduler(page.host)
    const faces = Array.from({ length: 5 }, fakeAvatar)
    const handles = faces.map(face => {
      face.clockFrom(page.host.now)
      const handle = scheduler.add(face.element, face.target, 'full', 'running')
      page.show(face.element)
      return handle
    })
    expect(new Set(faces.map(face => face.phases[0])).size).toBe(5)
    page.advance(5000)
    const firsts = faces.map(face => face.played.find(item => item.part === 'eye')?.at)
    expect(new Set(firsts).size).toBeGreaterThan(1)
    // Five runs end at once: only three squint.
    for (const handle of handles) {
      handle.setState('idle')
      handle.celebrate()
    }
    const now = page.host.now()
    expect(faces.filter(face => face.played.some(item => item.part === 'happy' && item.at === now)).length).toBe(MAX_FEATURED)
  })

  it('moves the cursor or z of at most three faces at once, and passes the places around', () => {
    const page = fakeHost({ random: () => 0.3 })
    const scheduler = new AvatarScheduler(page.host)
    const handles: Array<ReturnType<AvatarScheduler['add']>> = []
    const faces = Array.from({ length: 10 }, (_, index) => {
      const face = fakeAvatar()
      face.clockFrom(page.host.now)
      handles.push(scheduler.add(face.element, face.target, 'full', index % 3 ? 'running' : 'resting'))
      page.show(face.element)
      return face
    })
    const peak = { now: 0, max: 0 }
    const on = new Set<number>()
    for (let step = 0; step < 240; step++) {
      page.advance(TICK_MS)
      peak.now = faces.filter(face => face.looping.at(-1)?.value === true).length
      peak.max = Math.max(peak.max, peak.now)
      faces.forEach((face, index) => {
        if (face.looping.at(-1)?.value) on.add(index)
      })
    }
    expect(peak.max).toBe(MAX_FEATURED)
    // Over a minute every face got its turn.
    expect(on.size).toBe(10)
    // A face that stops running gives its place back at once.
    const holder = faces.findIndex(face => face.looping.at(-1)?.value)
    expect(holder).toBeGreaterThanOrEqual(0)
    handles[holder]!.setState('idle')
    expect(faces[holder]!.looping.at(-1)?.value).toBe(false)
    // No face holds a place longer than its turn.
    for (const face of faces)
      face.looping.forEach((item, index) => {
        const off = face.looping[index + 1]
        if (item.value && off) expect(off.at - item.at).toBeLessThanOrEqual(LOOP_MS + TICK_MS)
      })
  })
})
