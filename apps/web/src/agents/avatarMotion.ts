import { captureStill, motionAllowed, watchMotion } from '@latch/ui'
import type { AvatarState, AvatarTier } from './avatarFace.ts'

/**
 * One scheduler moves every avatar on the page: one interval, running only while some avatar is in view and the page
 * is shown. Each motion is a short Web Animation of transform or opacity, so no avatar keeps a timer of its own. Under
 * reduced motion (the system's preference, or 减弱 on this device), or while the page is frozen for tests and captures
 * (`data-capture="still"` on the root element), nothing moves and the state props stand still.
 */

/** What the scheduler needs of a page; a test passes its own. */
export interface MotionHost {
  now(): number
  random(): number
  setInterval(run: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  /** The page is hidden (another tab, a minimised window). */
  hidden(): boolean
  /** Reduced motion, or frozen for a capture. */
  still(): boolean
  /** Calls back when hidden() or still() may have changed; returns the unsubscribe. */
  watch(changed: () => void): () => void
  /** Calls back with whether the element is in view; returns the unsubscribe. */
  observe(element: Element, seen: (visible: boolean) => void): () => void
}

/** The part of an avatar a motion plays on. */
export type MotionPart = 'eyes' | 'eye' | 'base' | 'happy' | 'ask'
export interface MotionTarget {
  /** Plays one motion; an element without the part is skipped. */
  play(part: MotionPart, keyframes: Keyframe[], duration: number): void
  /** Props that loop in CSS (the cursor, the z) run only while this is set. */
  setMoving(moving: boolean): void
  /** Where in their loop this face's props start, so faces never blink their cursors in step. */
  setPhase(seconds: number): void
  /** The looping prop (the `_` cursor, the z) moves only while this is set; otherwise it stands at rest. */
  setLooping(looping: boolean): void
}

interface Entry {
  target: MotionTarget
  element: Element
  tier: AvatarTier
  state: AvatarState
  visible: boolean
  next: number
  /** Until when a squint or a prop plays; at most MAX_FEATURED at once. */
  featuredUntil: number
  /** Until when its looping prop moves, and from when it may move again: the three places rotate among the faces. */
  loopUntil: number
  restUntil: number
  stop: () => void
}

export const TICK_MS = 250
/** Squints and props at once across the page, staggered so the page never moves in step. */
export const MAX_FEATURED = 3
/** How long a face's cursor or z moves before it gives its place to another, and rests before asking again. */
export const LOOP_MS = 6000
export const LOOP_REST_MS = 4000

/** States whose prop loops: the running cursor and the resting z. */
const loops = (state: AvatarState) => state === 'running' || state === 'resting'
const between = (host: MotionHost, low: number, high: number) => low + host.random() * (high - low)

const BLINK: Keyframe[] = [{ transform: 'scaleY(1)' }, { transform: 'scaleY(0.12)', offset: 0.45 }, { transform: 'scaleY(1)' }]
const fadeOut = (hold: number): Keyframe[] => [
  { opacity: 1 },
  { opacity: 0, offset: hold },
  { opacity: 0, offset: 1 - hold },
  { opacity: 1 },
]
const fadeIn = (hold: number): Keyframe[] => [
  { opacity: 0 },
  { opacity: 1, offset: hold },
  { opacity: 1, offset: 1 - hold },
  { opacity: 0 },
]

export class AvatarScheduler {
  private readonly entries = new Set<Entry>()
  private timer: unknown = undefined
  private unwatch: (() => void) | undefined

  constructor(private readonly host: MotionHost) {}

  /** Adds an avatar; the returned handle changes its state or plays a moment, and removes it. */
  add(element: Element, target: MotionTarget, tier: AvatarTier, state: AvatarState) {
    const entry: Entry = {
      target,
      element,
      tier,
      state,
      visible: false,
      // Faces start at their own times, so the page never blinks in step.
      next: this.host.now() + between(this.host, 400, tier === 'full' ? 2600 : 11_000),
      featuredUntil: 0,
      loopUntil: 0,
      restUntil: 0,
      stop: () => {},
    }
    target.setPhase(Math.round(between(this.host, 0, 3.2) * 100) / 100)
    entry.stop = this.host.observe(element, visible => {
      entry.visible = visible
      this.refresh()
    })
    this.entries.add(entry)
    if (!this.unwatch)
      this.unwatch = this.host.watch(() => {
        this.refresh()
      })
    this.refresh()
    return {
      setState: (state: AvatarState) => {
        entry.state = state
        if (!loops(state)) this.release(entry)
        this.refresh()
      },
      /** 刚完成: one squint and a blink, if the face is moving at all. */
      celebrate: () => {
        if (!this.moving(entry) || entry.tier !== 'full' || this.featured() >= MAX_FEATURED) return
        this.happy(entry, 1800)
        entry.next = this.host.now() + 2400
      },
      remove: () => {
        entry.stop()
        entry.target.setMoving(false)
        this.release(entry)
        this.entries.delete(entry)
        if (!this.entries.size) {
          this.unwatch?.()
          this.unwatch = undefined
        }
        this.refresh()
      },
    }
  }

  /** Whether the interval runs; for tests. */
  get running(): boolean {
    return this.timer !== undefined
  }

  private moving(entry: Entry): boolean {
    return entry.visible && entry.tier !== 'still' && !this.host.hidden() && !this.host.still()
  }

  private refresh(): void {
    let any = false
    for (const entry of this.entries) {
      const moving = this.moving(entry)
      entry.target.setMoving(moving && entry.tier === 'full')
      if (!moving) this.release(entry)
      any ||= moving
    }
    if (any && this.timer === undefined)
      this.timer = this.host.setInterval(() => {
        this.tick()
      }, TICK_MS)
    else if (!any && this.timer !== undefined) {
      this.host.clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private featured(): number {
    const now = this.host.now()
    let count = 0
    for (const entry of this.entries) if (entry.featuredUntil > now || entry.loopUntil > now) count++
    return count
  }

  private release(entry: Entry): void {
    if (entry.loopUntil === 0) return
    entry.loopUntil = 0
    entry.target.setLooping(false)
  }

  /** At most three faces move a squint or a prop at once: a face's cursor or z moves for a while, then rests for the next. */
  private rotate(now: number): void {
    for (const entry of this.entries) if (entry.loopUntil && entry.loopUntil <= now) this.release(entry)
    const waiting = [...this.entries]
      .filter(entry => this.moving(entry) && entry.tier === 'full' && loops(entry.state) && !entry.loopUntil && entry.restUntil <= now)
      .sort((a, b) => a.restUntil - b.restUntil)
    for (const entry of waiting) {
      if (this.featured() >= MAX_FEATURED) break
      entry.loopUntil = now + LOOP_MS
      entry.restUntil = now + LOOP_MS + LOOP_REST_MS
      entry.target.setLooping(true)
    }
  }

  private tick(): void {
    const now = this.host.now()
    this.rotate(now)
    for (const entry of this.entries) {
      if (!this.moving(entry) || entry.next > now || entry.featuredUntil > now) continue
      this.act(entry)
    }
  }

  private act(entry: Entry): void {
    const { host } = this
    const now = host.now()
    if (entry.tier !== 'full' || entry.state === 'failed' || entry.state === 'running') {
      this.blink(entry)
      entry.next = now + (entry.tier === 'full' ? between(host, 3000, 5500) : between(host, 5000, 11_000))
      return
    }
    if (entry.state === 'resting') {
      entry.next = now + 5000
      return
    }
    const room = this.featured() < MAX_FEATURED
    if (entry.state === 'waiting') {
      if (room) {
        entry.target.play(
          'ask',
          [
            { opacity: 0, transform: 'scale(0.4)' },
            { opacity: 1, transform: 'scale(1)', offset: 0.15 },
            { opacity: 1, transform: 'scale(1)', offset: 0.85 },
            { opacity: 0, transform: 'scale(0.4)' },
          ],
          1800,
        )
        entry.featuredUntil = now + 1800
      } else this.blink(entry)
      entry.next = now + between(host, 3600, 4800)
      return
    }
    const roll = host.random()
    if (roll < 0.55 || (roll >= 0.85 && !room)) this.blink(entry)
    else if (roll < 0.85) {
      const dx = between(host, -1.4, 1.4)
      const dy = between(host, -0.6, 0.4)
      const away = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`
      entry.target.play(
        'eyes',
        [
          { transform: 'translate(0, 0)' },
          { transform: away, offset: 0.25 },
          { transform: away, offset: 0.8 },
          { transform: 'translate(0, 0)' },
        ],
        Math.round(between(host, 1300, 2000)),
      )
    } else this.happy(entry, 1400)
    entry.next = now + between(host, 2600, 5200)
  }

  private blink(entry: Entry): void {
    entry.target.play('eye', BLINK, 160)
  }

  private happy(entry: Entry, duration: number): void {
    entry.target.play('base', fadeOut(0.1), duration)
    entry.target.play('happy', fadeIn(0.1), duration)
    entry.featuredUntil = this.host.now() + duration
  }
}

/** The browser's page for the scheduler. */
export function browserMotionHost(): MotionHost {
  const observers = new Map<Element, (visible: boolean) => void>()
  let intersection: IntersectionObserver | undefined
  return {
    now: () => performance.now(),
    random: () => Math.random(),
    setInterval: (run, ms) => window.setInterval(run, ms),
    clearInterval: handle => {
      window.clearInterval(handle as number)
    },
    hidden: () => document.visibilityState === 'hidden',
    still: () => !motionAllowed() || captureStill(),
    watch(changed) {
      document.addEventListener('visibilitychange', changed)
      // The system's preference, 减弱 (data-motion) and the capture freeze (data-capture).
      const unwatch = watchMotion(changed)
      return () => {
        document.removeEventListener('visibilitychange', changed)
        unwatch()
      }
    },
    observe(element, seen) {
      if (typeof IntersectionObserver !== 'function') {
        seen(true)
        return () => {}
      }
      intersection ??= new IntersectionObserver(records => {
        for (const record of records) observers.get(record.target)?.(record.isIntersecting)
      })
      observers.set(element, seen)
      intersection.observe(element)
      return () => {
        observers.delete(element)
        intersection?.unobserve(element)
        if (!observers.size) {
          intersection?.disconnect()
          intersection = undefined
        }
      }
    },
  }
}

let shared: AvatarScheduler | undefined
export const avatarScheduler = (): AvatarScheduler => (shared ??= new AvatarScheduler(browserMotionHost()))
