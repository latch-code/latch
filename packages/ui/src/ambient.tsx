import { useEffect, useRef } from 'react'
import { cx } from './internal.ts'

/*
 * The ambient field of an empty page: a few faint hairline orbits around the page's anchor with sparse stations on
 * them. Now and then a soft brightening travels clockwise along one stretch of an orbit, lifts the stations it passes
 * and settles back; after a rest the next stretch, one sector further round, takes its turn. Between passes nothing
 * moves and nothing is drawn. Ink keeps clear of the content: none within a margin of text, cards and the composer,
 * a wider one round a primary button, feathered beyond it, so the contrast under every word is unchanged.
 *
 * The page marks what the field must know with attributes inside the field's parent: `data-ambient-anchor` on the
 * element the orbits circle (the heading), `data-ambient-avoid="text" | "surface" | "accent"` on what ink keeps clear
 * of. The field stops while the person types in it (it dims to 45%), while a dialog is open, while the page is hidden,
 * the window is in the background or the field is off screen, and after 90s without input; under reduced motion it is
 * one still frame. One canvas, its backing store at most twice the CSS size, 15 frames a second during a pass and none
 * between. Every colour is the theme's ink (text-1) at a low alpha.
 */

type Kind = 'text' | 'surface' | 'accent'
interface Rect {
  x: number
  y: number
  w: number
  h: number
  kind: Kind
}

/** Margin (where nothing is drawn) and feather (where ink fades in) round each kind of content, in CSS px. */
const CLEAR = {
  ink: { text: [22, 36], surface: [90, 50], accent: [120, 50] },
  light: { text: [40, 50], surface: [90, 50], accent: [120, 50] },
} as const satisfies Record<string, Record<Kind, readonly [number, number]>>

const FRAME_MS = 66
/** A pass fades in and out over this long at each end. */
const FADE_S = 1.6
const IDLE_MS = 90_000
const RISE = 72
const SETTLE = 232
/** Samples along an orbit, and along the light. */
const ORBIT_STEP = Math.PI / 360
const LIGHT_STEP = 4
const TAU = Math.PI * 2

interface Theme {
  /** The ink as `r, g, b`. */
  ink: string
  hair: number
  station: number
  line: number
  lift: number
}

interface Orbit {
  r: number
  /** Per sample: x, y, ink visibility, light visibility. */
  points: Float32Array
}

interface Station {
  orbit: number
  angle: number
  x: number
  y: number
  r: number
  /** How much ink the place allows, 0 to 1: what the light lifts it to. */
  visible: number
  /** At rest: the allowance with a little variation from station to station. */
  alpha: number
  /** Its sample on the orbit, where the light's own alpha at the station is read. */
  sample: number
}

interface Stretch {
  orbit: number
  start: number
  /** Arc length in px. */
  length: number
  mid: number
}

interface Field {
  width: number
  height: number
  cx: number
  cy: number
  orbits: Orbit[]
  stations: Station[]
  stretches: Stretch[]
  phone: boolean
  /** What the layout was measured from: the same key is the same field. */
  key: string
}

/** A small seeded generator, so the field and its still frame are the same on every load. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const smooth = (value: number) => {
  const t = Math.min(1, Math.max(0, value))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/** How much ink a point may carry, 0 to 1, given what it must keep clear of. */
function clearance(
  x: number,
  y: number,
  rects: readonly Rect[],
  width: number,
  height: number,
  mode: 'ink' | 'light',
  edge: number,
): number {
  let factor = smooth((Math.min(x, width - x, y, height - y) - edge) / 30)
  for (const rect of rects) {
    const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.w))
    const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.h))
    const [pad, feather] = CLEAR[mode][rect.kind]
    factor = Math.min(factor, smooth((Math.hypot(dx, dy) - pad) / feather))
    if (factor === 0) return 0
  }
  return factor
}

/**
 * Measures what the field draws round, relative to the canvas itself: a parent that scrolls carries the canvas with its
 * content, so the drawing stays where the content is.
 */
function build(parent: HTMLElement, canvas: HTMLCanvasElement): Field | null {
  const box = canvas.getBoundingClientRect()
  const width = box.width
  const height = box.height
  if (width < 1 || height < 1) return null
  const anchor = parent.querySelector('[data-ambient-anchor]')?.getBoundingClientRect()
  if (!anchor) return null
  const rects: Rect[] = []
  for (const element of parent.querySelectorAll<HTMLElement>('[data-ambient-avoid]')) {
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    const kind = element.dataset.ambientAvoid
    rects.push({
      x: rect.left - box.left,
      y: rect.top - box.top,
      w: rect.width,
      h: rect.height,
      kind: kind === 'accent' || kind === 'text' ? kind : 'surface',
    })
  }
  const phone = width < 600
  const centreX = anchor.left - box.left + anchor.width / 2
  const centreY = anchor.top - box.top + anchor.height / 2
  let radii: number[]
  if (phone) {
    // Two orbits through the band below the content.
    const bottom = rects.reduce((low, rect) => Math.max(low, rect.y + rect.h), centreY)
    const band = (bottom + height) / 2
    radii = height - bottom < 160 ? [] : [band - centreY - 18, band - centreY + 17]
  } else radii = [0.31, 0.39, 0.49, 0.62].map(share => share * Math.max(width, 900))
  const edge = phone ? 14 : 40
  const lightEdge = phone ? 34 : 60
  const next = random(0x1a7c4)
  const orbits: Orbit[] = []
  const stations: Station[] = []
  const stretches: Stretch[] = []
  radii.forEach((r, index) => {
    const count = Math.round((Math.PI * 2) / ORBIT_STEP)
    const points = new Float32Array(count * 4)
    for (let step = 0; step < count; step++) {
      const angle = step * ORBIT_STEP - Math.PI / 2
      const x = centreX + Math.cos(angle) * r
      const y = centreY + Math.sin(angle) * r
      points.set(
        [x, y, clearance(x, y, rects, width, height, 'ink', edge), clearance(x, y, rects, width, height, 'light', lightEdge)],
        step * 4,
      )
    }
    orbits.push({ r, points })
    // Stations about every 78px, each a little off its place, sized 1.0, 1.3 or 1.7.
    const many = Math.max(6, Math.round((Math.PI * 2 * r) / 78))
    for (let item = 0; item < many; item++) {
      const angle = ((item + (next() - 0.5) * 0.6) / many) * Math.PI * 2 - Math.PI / 2
      const x = centreX + Math.cos(angle) * r
      const y = centreY + Math.sin(angle) * r
      const visible = clearance(x, y, rects, width, height, 'ink', edge)
      const size = next()
      const jitter = 0.75 + next() * 0.5
      const sample = Math.round(((((angle + Math.PI / 2) % TAU) + TAU) % TAU) / ORBIT_STEP) % count
      if (visible > 0.02)
        stations.push({ orbit: index, angle, x, y, r: size < 0.55 ? 1 : size < 0.86 ? 1.3 : 1.7, visible, alpha: visible * jitter, sample })
    }
    // Stretches the light can walk: where it shows at 30% or more, at least 200px long, split past 520px.
    let run = -1
    for (let step = 0; step <= count; step++) {
      const shown = step < count && points[step * 4 + 3] >= 0.3
      if (shown && run < 0) run = step
      if (!shown && run >= 0) {
        const length = (step - run) * ORBIT_STEP * r
        const pieces = Math.max(1, Math.ceil(length / 520))
        for (let piece = 0; piece < pieces; piece++) {
          const part = length / pieces
          if (part < 200) continue
          const start = run * ORBIT_STEP - Math.PI / 2 + (piece * part) / r
          stretches.push({ orbit: index, start, length: part, mid: start + part / r / 2 })
        }
        run = -1
      }
    }
  })
  const key = [width, height, centreX, centreY, ...rects.flatMap(rect => [rect.kind, rect.x, rect.y, rect.w, rect.h])].map(String).join(',')
  return { width, height, cx: centreX, cy: centreY, orbits, stations, stretches, phone, key }
}

/** Clockwise sector (of five, from 12 o'clock) that an angle on the screen falls in. */
const sectorOf = (angle: number) =>
  Math.floor(((((angle + Math.PI / 2) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / ((Math.PI * 2) / 5))

/** The order the stretches take their turns: one per sector clockwise, a different orbit each time round. */
function rounds(field: Field): Stretch[] {
  if (field.stretches.length === 0) return []
  const sectors = Array.from({ length: 5 }, (_, sector) => field.stretches.filter(item => sectorOf(item.mid) === sector))
  const order: Stretch[] = []
  for (let round = 0; order.length < field.stretches.length * 2 && round < 16; round++)
    for (const list of sectors) if (list.length) order.push(list[round % list.length])
  // The opening pass is the lowest stretch, mid-way: the still frame shows it there.
  const opening = field.stretches.reduce((low, item) => (Math.sin(item.mid) > Math.sin(low.mid) ? item : low))
  const at = order.indexOf(opening)
  return [...order.slice(at), ...order.slice(0, at)]
}

function themeOf(element: HTMLElement): Theme {
  const ink =
    getComputedStyle(element)
      .color.match(/\d+(?:\.\d+)?/gu)
      ?.slice(0, 3)
      .join(', ') ?? '0, 0, 0'
  const dark = (Number(ink.split(',')[0]) || 0) > 128
  // The lift is the most ink anything carries: .29 of the light ink on paper is 64 levels of 255 from the paper, .32
  // of the dark ink 66 (at most 70 on the desktop); a phone's light runs at 80%, 51 and 53 (at most 60).
  return dark ? { ink, hair: 0.028, station: 0.13, line: 0.24, lift: 0.32 } : { ink, hair: 0.022, station: 0.12, line: 0.2, lift: 0.29 }
}

/**
 * The ambient field behind an empty page (see the note at the top of this file). It fills its parent, which must be
 * positioned; `still` draws only the opening pose, as reduced motion does, for a sheet that must not move. The state it
 * is in is on `data-state`: pass, rest, quiet (typing, dimmed), paused, settled (idle) or still.
 */
export function AmbientField({ still = false, className }: { still?: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const parent = canvas?.parentElement
    const context = canvas?.getContext('2d')
    if (!canvas || !parent || !context) return undefined
    const reduce = matchMedia('(prefers-reduced-motion: reduce)')
    let field: Field | null = null
    let order: Stretch[] = []
    let theme = themeOf(canvas)
    let dpr = 1
    let turn = 0
    // The pass under way: its stretch, how far it has gone in seconds and the clock when it last moved.
    let pass: { stretch: Stretch; elapsed: number; duration: number } | null = null
    let last = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let restUntil = 0
    let lastInput = performance.now()
    let settled = false
    let visible = true
    let frames = 0
    let dialog = false
    // Reused every frame: the light's box this frame and last, and the area repainted.
    const box = { x: 0, y: 0, w: 0, h: 0 }
    const previous = { x: 0, y: 0, w: 0, h: 0 }
    const clip = { x: 0, y: 0, w: 0, h: 0 }
    const rest = random(0x51ab)

    const setState = (state: string) => {
      if (canvas.dataset.state !== state) canvas.dataset.state = state
    }
    const applyTheme = () => {
      theme = themeOf(canvas)
      context.strokeStyle = `rgb(${theme.ink})`
      context.fillStyle = `rgb(${theme.ink})`
    }

    const outside = (x0: number, y0: number, x1: number, y1: number, area: typeof clip) =>
      Math.max(x0, x1) < area.x || Math.min(x0, x1) > area.x + area.w || Math.max(y0, y1) < area.y || Math.min(y0, y1) > area.y + area.h

    /** The hairlines and resting stations, only where they cross `area` when it is given. */
    const paintStatic = (area: typeof clip | null) => {
      if (!field) return
      const hair = theme.hair * (dpr / 2)
      context.lineWidth = 1 / dpr
      for (const orbit of field.orbits) {
        const points = orbit.points
        const count = points.length / 4
        for (let step = 0; step < count; step++) {
          const next = ((step + 1) % count) * 4
          const visibility = Math.min(points[step * 4 + 2], points[next + 2])
          if (visibility < 0.01) continue
          const x0 = points[step * 4]
          const y0 = points[step * 4 + 1]
          const x1 = points[next]
          const y1 = points[next + 1]
          if (area && outside(x0, y0, x1, y1, area)) continue
          context.globalAlpha = hair * visibility
          context.beginPath()
          context.moveTo(x0, y0)
          context.lineTo(x1, y1)
          context.stroke()
        }
      }
      for (const station of field.stations) {
        if (area && outside(station.x - 3, station.y - 3, station.x + 3, station.y + 3, area)) continue
        context.globalAlpha = theme.station * station.alpha
        context.beginPath()
        context.arc(station.x, station.y, station.r, 0, Math.PI * 2)
        context.fill()
      }
      context.globalAlpha = 1
    }

    const pointAt = (stretch: Stretch, along: number, axis: 0 | 1) => {
      const orbit = field!.orbits[stretch.orbit]
      const angle = stretch.start + along / orbit.r
      return axis === 0 ? field!.cx + Math.cos(angle) * orbit.r : field!.cy + Math.sin(angle) * orbit.r
    }

    /** The light's box with the head `head` px along its stretch, into `box`. */
    const measure = (stretch: Stretch, head: number) => {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let offset = -SETTLE; offset <= RISE; offset += LIGHT_STEP) {
        const x = pointAt(stretch, head + offset, 0)
        const y = pointAt(stretch, head + offset, 1)
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
      box.x = Math.floor(minX - 4)
      box.y = Math.floor(minY - 4)
      box.w = Math.ceil(maxX + 4) - box.x
      box.h = Math.ceil(maxY + 4) - box.y
    }

    /** The light, `head` px along its stretch at `strength` (0 to 1): the hairline brightens and lifts its stations. */
    const paintLight = (stretch: Stretch, head: number, strength: number) => {
      if (!field) return
      const orbit = field.orbits[stretch.orbit]
      const samples = orbit.points.length / 4
      const scale = field.phone ? 0.8 : 1
      for (let offset = -SETTLE; offset < RISE; offset += LIGHT_STEP) {
        const middle = offset + LIGHT_STEP / 2
        const envelope = middle >= 0 ? smooth(1 - middle / RISE) : (1 + middle / SETTLE) ** 2
        const angle = stretch.start + (head + middle) / orbit.r
        const sample = Math.round(((((angle + Math.PI / 2) % TAU) + TAU) % TAU) / ORBIT_STEP) % samples
        const alpha = theme.line * scale * envelope * strength * orbit.points[sample * 4 + 3]
        if (alpha < 0.004) continue
        context.globalAlpha = alpha
        context.lineWidth = 0.5 + 0.55 * envelope
        context.beginPath()
        context.moveTo(pointAt(stretch, head + offset, 0), pointAt(stretch, head + offset, 1))
        context.lineTo(pointAt(stretch, head + offset + LIGHT_STEP, 0), pointAt(stretch, head + offset + LIGHT_STEP, 1))
        context.stroke()
      }
      // Stations under the light rise towards the lift and grow by a quarter. The lifted dot adds only the alpha still
      // missing over its resting dot and the light's line, so the three never stack past the lift.
      const round = TAU * orbit.r
      for (const station of field.stations) {
        if (station.orbit !== stretch.orbit) continue
        let along = (station.angle - stretch.start) * orbit.r - head
        along -= Math.round(along / round) * round
        if (along < -SETTLE || along > RISE) continue
        const envelope = along >= 0 ? smooth(1 - along / RISE) : (1 + along / SETTLE) ** 2
        const line = theme.line * scale * envelope * strength * orbit.points[station.sample * 4 + 3]
        const under = 1 - (1 - theme.station * station.alpha) * (1 - line)
        const target = theme.lift * scale * envelope * strength * station.visible
        if (target - under < 0.004) continue
        context.globalAlpha = (target - under) / (1 - under)
        context.beginPath()
        context.arc(station.x, station.y, station.r * (1 + 0.25 * envelope), 0, Math.PI * 2)
        context.fill()
      }
      context.globalAlpha = 1
    }

    const paintAll = () => {
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, canvas.width, canvas.height)
      paintStatic(null)
      previous.w = 0
    }

    const speed = () => (field?.phone ? 21 : 26)
    const strengthOf = (current: NonNullable<typeof pass>) =>
      Math.max(0, Math.min(1, current.elapsed / FADE_S, (current.duration - current.elapsed) / FADE_S))

    /** Repaints only where the light was and is: the union of this frame's box and the last one's. */
    const frame = () => {
      if (!pass || !field) return
      const head = pass.elapsed * speed()
      measure(pass.stretch, head)
      clip.x = previous.w ? Math.min(previous.x, box.x) : box.x
      clip.y = previous.w ? Math.min(previous.y, box.y) : box.y
      clip.w = Math.max(previous.w ? previous.x + previous.w : 0, box.x + box.w) - clip.x
      clip.h = Math.max(previous.w ? previous.y + previous.h : 0, box.y + box.h) - clip.y
      context.save()
      context.beginPath()
      context.rect(clip.x, clip.y, clip.w, clip.h)
      context.clip()
      context.clearRect(clip.x, clip.y, clip.w, clip.h)
      paintStatic(clip)
      paintLight(pass.stretch, head, strengthOf(pass))
      context.restore()
      previous.x = box.x
      previous.y = box.y
      previous.w = box.w
      previous.h = box.h
    }

    /** The opening pose: the first pass half-way along its stretch, at full strength. */
    const paintStill = () => {
      paintAll()
      const opening = order[0]
      if (opening) paintLight(opening, opening.length / 2, 1)
    }

    const quietReason = (): string | null => {
      if (document.hidden || !document.hasFocus() || !visible || dialog) return 'paused'
      const active = document.activeElement
      if (active && parent.contains(active) && active.matches('textarea, input, [contenteditable="true"]')) return 'quiet'
      return null
    }

    const stop = () => {
      clearTimeout(timer)
      timer = undefined
    }

    const startPass = (now: number) => {
      const stretch = order[turn % Math.max(1, order.length)]
      turn++
      if (!stretch) return
      pass = { stretch, elapsed: 0, duration: stretch.length / speed() }
      last = now
    }

    const pause = (reason: string) => {
      stop()
      if (reason === 'still') {
        paintStill()
        setState('still')
        return
      }
      // Typing takes the light away at once; the other pauses only hold the frame as it is.
      if (reason === 'quiet' && pass) {
        pass = null
        paintAll()
        restUntil = performance.now() + 2500
      }
      setState(reason)
    }

    const tick = () => {
      timer = undefined
      const now = performance.now()
      // A dialog may open without moving focus here: look every eighth frame, and at every rest.
      if (frames % 8 === 0 || !pass) dialog = document.querySelector('dialog[open], [aria-modal="true"]') !== null
      frames++
      const reason = still || reduce.matches ? 'still' : quietReason()
      if (reason !== null) {
        pause(reason)
        return
      }
      if (pass) {
        pass.elapsed += Math.min(0.2, (now - last) / 1000)
        last = now
        if (pass.elapsed < pass.duration) {
          frame()
          setState('pass')
          timer = setTimeout(tick, FRAME_MS)
          return
        }
        pass = null
        paintAll()
        if (now - lastInput > IDLE_MS) {
          settled = true
          setState('settled')
          return
        }
        restUntil = now + (field?.phone ? 20_000 + rest() * 8000 : 6000 + rest() * 4000)
      }
      if (now >= restUntil && order.length) {
        startPass(now)
        timer = setTimeout(tick, 0)
        return
      }
      setState('rest')
      if (order.length) timer = setTimeout(tick, restUntil - now)
    }

    /** Looks again now, unless a frame is already due. */
    const wake = () => {
      if (timer !== undefined && canvas.dataset.state === 'pass') return
      stop()
      last = performance.now()
      tick()
    }

    const rebuild = () => {
      const rect = canvas.getBoundingClientRect()
      const ratio = Math.min(2, devicePixelRatio || 1)
      const next = build(parent, canvas)
      // A change that moved nothing the field draws round (the observers' first report, a row that kept its size)
      // leaves the field, and a pass under way, as they are.
      if (field && next && next.key === field.key && ratio === dpr) return
      dpr = ratio
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      applyTheme()
      field = next
      order = field ? rounds(field) : []
      // The light finishes on the old layout's stretch no more; the next one starts soon after.
      if (pass) {
        pass = null
        restUntil = performance.now() + 1200
      }
      if (still || reduce.matches) paintStill()
      else paintAll()
    }

    let rebuildTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRebuild = () => {
      clearTimeout(rebuildTimer)
      rebuildTimer = setTimeout(() => {
        rebuild()
        wake()
      }, 150)
    }
    const repaint = () => {
      applyTheme()
      if (still || reduce.matches) paintStill()
      else paintAll()
    }

    rebuild()
    if (!still && !reduce.matches) startPass(performance.now())
    tick()

    const resize = new ResizeObserver(scheduleRebuild)
    const watch = () => {
      resize.observe(parent)
      for (const element of parent.querySelectorAll('[data-ambient-avoid], [data-ambient-anchor]')) resize.observe(element)
    }
    watch()
    const mutations = new MutationObserver(() => {
      watch()
      scheduleRebuild()
    })
    mutations.observe(parent, { childList: true, subtree: true })
    const themeWatch = new MutationObserver(repaint)
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const scheme = matchMedia('(prefers-color-scheme: dark)')
    const onMotion = () => {
      if (reduce.matches) pause('still')
      else {
        paintAll()
        restUntil = 0
        wake()
      }
    }
    const intersection = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting)
      wake()
    })
    intersection.observe(canvas)
    const input = () => {
      lastInput = performance.now()
      if (!settled) return
      settled = false
      restUntil = lastInput + 2000
      wake()
    }
    const change = () => {
      dialog = document.querySelector('dialog[open], [aria-modal="true"]') !== null
      wake()
    }
    const inputs = ['pointermove', 'keydown', 'wheel', 'touchstart', 'input'] as const
    scheme.addEventListener('change', repaint)
    reduce.addEventListener('change', onMotion)
    document.addEventListener('visibilitychange', change)
    window.addEventListener('focus', change)
    window.addEventListener('blur', change)
    document.addEventListener('focusin', change)
    document.addEventListener('focusout', change)
    for (const name of inputs) window.addEventListener(name, input, { passive: true })
    return () => {
      stop()
      clearTimeout(rebuildTimer)
      resize.disconnect()
      mutations.disconnect()
      themeWatch.disconnect()
      intersection.disconnect()
      scheme.removeEventListener('change', repaint)
      reduce.removeEventListener('change', onMotion)
      document.removeEventListener('visibilitychange', change)
      window.removeEventListener('focus', change)
      window.removeEventListener('blur', change)
      document.removeEventListener('focusin', change)
      document.removeEventListener('focusout', change)
      for (const name of inputs) window.removeEventListener(name, input)
    }
  }, [still])
  return <canvas ref={ref} className={cx('ui-ambient', className)} aria-hidden="true" />
}
