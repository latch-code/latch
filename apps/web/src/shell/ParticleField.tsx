import { useEffect, useRef } from 'react'

/*
 * The one idle motion of the page: a quiet field of points drifting up behind the work panel's content, near neighbours
 * joined by hairlines that fade with distance. Its picture is a pure function of the seed, the panel's size, the theme's
 * tokens and the time; the time is Date.now() on a 33ms grid, and 0 under reduced motion. So the field draws at most
 * 30 frames a second, a frozen clock (the visual tests') gives the same frame on every run, and the page needs no hook
 * for tests. One canvas, its pixel ratio capped at 1.5; it stops while the tab is hidden, the panel is out of view or the
 * element is gone, reads no layout while it draws, and leaves no listener behind.
 */

export const FIELD_SEED = 7
export const FIELD_POINTS = 96
/** Points closer than this (CSS pixels) are joined. */
export const FIELD_LINK = 96
/** The clock's grid: 33ms, at most 30 frames a second. */
export const FIELD_TICK = 33
const MAX_RATIO = 1.5
/** A point leaves 4px past an edge before it comes back at the other one. */
const EDGE = 4
/** Hairlines are stroked in this many strengths, so a frame strokes a few paths rather than one per pair. */
const LINE_STEPS = 8

interface Seed {
  /** Where the point starts, as a fraction of the panel's width and height. */
  x: number
  y: number
  r: number
  /** CSS pixels a second; vy is negative, the points rise. */
  vx: number
  vy: number
  a: number
  /** The phase of the twinkle. */
  ph: number
  /** Every seventh point takes the second colour. */
  hue: boolean
}

export interface FieldDot {
  x: number
  y: number
  r: number
  alpha: number
  hue: boolean
}

export interface FieldColours {
  ink: string
  accent: string
  strength: number
}

/** Park–Miller: the same sequence for the same seed, and never Math.random. */
function sequence(seed: number): () => number {
  let state = seed
  return () => ((state = (state * 16807) % 2147483647) - 1) / 2147483646
}

const seeds = new Map<number, readonly Seed[]>()
function seedPoints(seed: number): readonly Seed[] {
  let points = seeds.get(seed)
  if (!points) {
    const next = sequence(seed)
    points = Array.from({ length: FIELD_POINTS }, (_, index) => ({
      x: next(),
      y: next(),
      r: 0.8 + next() * 1.1,
      vx: (next() - 0.5) * 7,
      vy: -(3 + next() * 8),
      a: 0.2 + next() * 0.34,
      ph: next() * 6.28,
      hue: index % 7 === 0,
    }))
    seeds.set(seed, points)
  }
  return points
}

/** Where a point comes back in at the bottom on a given lap: a hash of the seed, the point and the lap. */
function lapStart(seed: number, index: number, lap: number): number {
  let hash = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(index + 1, 0xc2b2ae35) ^ Math.imul((lap % 0x7fffffff) | 0, 0x27d4eb2f)
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d)
  hash = Math.imul(hash ^ (hash >>> 12), 0x297a2d39)
  return ((hash ^ (hash >>> 15)) >>> 0) / 4294967296
}

const wrap = (value: number, span: number) => value - Math.floor(value / span) * span

/** The time a frame shows: the clock on the 33ms grid, or 0 under reduced motion. */
export function frameTime(now: number, reduced: boolean): number {
  return reduced ? 0 : Math.round(now / FIELD_TICK) * FIELD_TICK
}

/** The points of a frame: where each one is and how strongly it shows, from the seed, the size and the time alone. */
export function fieldFrame(width: number, height: number, time: number, seed = FIELD_SEED): FieldDot[] {
  const seconds = time / 1000
  const down = height + 2 * EDGE
  const across = width + 2 * EDGE
  return seedPoints(seed).map((point, index) => {
    const risen = point.y * height + EDGE + point.vy * seconds
    const lap = Math.floor(risen / down)
    const start = lap === 0 ? point.x : lapStart(seed, index, lap)
    return {
      x: wrap(start * width + EDGE + point.vx * seconds, across) - EDGE,
      y: risen - lap * down - EDGE,
      r: point.r,
      alpha: point.a * (0.6 + 0.4 * Math.sin(time / 1400 + point.ph)),
      hue: point.hue,
    }
  })
}

/** The near pairs of a frame, each with the strength step (1 to LINE_STEPS) of its hairline. */
export function fieldLinks(dots: readonly FieldDot[]): Array<[number, number, number]> {
  const links: Array<[number, number, number]> = []
  for (let i = 0; i < dots.length; i++) {
    const a = dots[i]!
    for (let j = i + 1; j < dots.length; j++) {
      const b = dots[j]!
      const dx = a.x - b.x
      const dy = a.y - b.y
      if (dx > FIELD_LINK || dx < -FIELD_LINK || dy > FIELD_LINK || dy < -FIELD_LINK) continue
      const near = 1 - Math.sqrt(dx * dx + dy * dy) / FIELD_LINK
      if (near > 0) links.push([i, j, Math.ceil(near * LINE_STEPS)])
    }
  }
  return links
}

type Pen = Pick<
  CanvasRenderingContext2D,
  'clearRect' | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'arc' | 'fill' | 'strokeStyle' | 'fillStyle' | 'lineWidth' | 'globalAlpha'
>

/** Paints a frame: hairlines first, one path per strength, then the points. */
export function drawField(pen: Pen, dots: readonly FieldDot[], width: number, height: number, colours: FieldColours): void {
  pen.clearRect(0, 0, width, height)
  const links = fieldLinks(dots)
  pen.strokeStyle = colours.ink
  pen.lineWidth = 0.6
  for (let step = 1; step <= LINE_STEPS; step++) {
    let any = false
    for (const [i, j, strength] of links) {
      if (strength !== step) continue
      if (!any) pen.beginPath()
      any = true
      pen.moveTo(dots[i]!.x, dots[i]!.y)
      pen.lineTo(dots[j]!.x, dots[j]!.y)
    }
    if (!any) continue
    pen.globalAlpha = 0.16 * colours.strength * (step / LINE_STEPS)
    pen.stroke()
  }
  for (const dot of dots) {
    pen.fillStyle = dot.hue ? colours.accent : colours.ink
    // The second colour is a little stronger, so the few blue points read on white.
    pen.globalAlpha = Math.min(1, dot.alpha * colours.strength * (dot.hue ? 1.5 : 1))
    pen.beginPath()
    pen.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2)
    pen.fill()
  }
  pen.globalAlpha = 1
}

/** The field, under everything else in the work panel. Not on phones, which have no panel. */
export function ParticleField() {
  const box = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const host = box.current
    const canvas = canvasRef.current
    const pen = canvas?.getContext('2d')
    if (!host || !canvas || !pen) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    const dark = matchMedia('(prefers-color-scheme: dark)')
    let width = 0
    let height = 0
    let ratio = 1
    let inView = true
    let colours: FieldColours = { ink: '', accent: '', strength: 1 }
    let shown = Number.NaN
    let request = 0

    // Only when the theme changes: the colours are the theme's tokens.
    const readColours = () => {
      const style = getComputedStyle(host)
      const ink = style.getPropertyValue('--particle').trim()
      colours = {
        ink,
        accent: style.getPropertyValue('--particle-accent').trim() || ink,
        strength: Number.parseFloat(style.getPropertyValue('--particle-strength')) || 1,
      }
    }
    const paint = (time: number) => {
      shown = time
      if (!width || !height || !colours.ink) return
      pen.setTransform(ratio, 0, 0, ratio, 0, 0)
      drawField(pen, fieldFrame(width, height, time), width, height, colours)
    }
    const running = () => !reduced.matches && !document.hidden && inView && width > 0 && height > 0
    const step = () => {
      request = 0
      if (!running()) return
      request = requestAnimationFrame(step)
      // A new frame only when the clock reaches the next 33ms: at most 30 a second, and none while the clock is frozen.
      const time = frameTime(Date.now(), false)
      if (time !== shown) paint(time)
    }
    /** Something changed (size, theme, preference, visibility): draw the frame now and run or stop the loop. */
    const refresh = () => {
      paint(frameTime(Date.now(), reduced.matches))
      if (running()) request ||= requestAnimationFrame(step)
      else if (request) {
        cancelAnimationFrame(request)
        request = 0
      }
    }

    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return
      width = entry.contentRect.width
      height = entry.contentRect.height
      ratio = Math.min(window.devicePixelRatio || 1, MAX_RATIO)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      refresh()
    })
    const view = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? true
      refresh()
    })
    const theme = new MutationObserver(() => {
      readColours()
      refresh()
    })
    const onScheme = () => {
      readColours()
      refresh()
    }
    readColours()
    resize.observe(host)
    view.observe(host)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    dark.addEventListener('change', onScheme)
    reduced.addEventListener('change', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      if (request) cancelAnimationFrame(request)
      resize.disconnect()
      view.disconnect()
      theme.disconnect()
      dark.removeEventListener('change', onScheme)
      reduced.removeEventListener('change', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
  return (
    <div ref={box} className="particle-field" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  )
}
