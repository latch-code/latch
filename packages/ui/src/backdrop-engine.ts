/*
 * The drawing of the background layer (Backdrop): four effects on one canvas, and the limits that keep it cheap. It
 * is decoration. It follows three real states it is told about (how many sessions run, whether the input holds the
 * focus, where a decision was just resolved) and carries no information of its own: each of them is also written in
 * the foreground in words.
 *
 * Limits: 15 frames a second for slow drift and 30 while something moves quickly, on an even beat of display refreshes,
 * each armed by one timer and one animation frame (never an animation frame per refresh); the number of particles
 * follows the viewport's area and is capped (90 for 轻, 180 for 标准); the digits cost a few canvas calls a frame
 * whatever their number; nothing is drawn inside a hole (a security surface, or a region whose words sit straight on
 * the canvas), with a feather round it; the canvas is its own layer and the loop only writes its pixels, so no layout
 * or paint of content is caused. An ambient layer keeps drifting while it is looked at; otherwise the layer stops a
 * few seconds after the last thing it follows (a running session, a widening ring, the focus settling) and draws again
 * when told something. Whoever owns the engine pauses it (tab hidden, window in the background, a reply streaming in
 * view, reduced motion, low battery); paused, it holds one still frame.
 */

export type BackdropKind = 'grid' | 'field' | 'digits' | 'glow'
export type BackdropStrength = 'light' | 'standard'

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** A region to keep clear. The grid can drop soft regions while focused, but always keeps security surfaces clear. */
export interface Hole extends Box {
  hard: boolean
}

export interface BackdropStats {
  /** Frames drawn since the engine started. */
  frames: number
  /** Points drawn per frame: the particles of the field, the dots of the grid; 0 for the glow. */
  points: number
  /** Script time per drawn frame over the last 300 frames, in milliseconds. */
  avg: number
  p95: number
  max: number
  /** The shortest time between two drawn frames, in milliseconds (never under the 30 fps interval). */
  minGap: number
  paused: string[]
  /** Nothing it follows is happening: the loop has stopped on its last frame. */
  idle: boolean
  /** A timer or an animation frame is armed. */
  armed: boolean
  /** Rings still widening from resolved decisions. */
  rings: number
}

export interface BackdropEngine {
  resize(width: number, height: number, dpr: number): void
  /** The theme's background ink as `r, g, b`; without one nothing is drawn. */
  setInk(rgb: string | null, lightTheme: boolean): void
  setHoles(holes: readonly Hole[]): void
  setRunning(count: number): void
  setFocus(target: Box | null): void
  ripple(x: number, y: number): void
  /** Where the pointer is over the layer, or null when it left: the field's near points reach for it. */
  setPointer(point: { x: number; y: number } | null): void
  /** The monospace family the field sets its digits in. */
  setFont(family: string): void
  pause(reason: string): void
  resume(reason: string): void
  stats(): BackdropStats
  destroy(): void
}

/** The least time between two frames: 30 a second, while something moves quickly (a ring, the field gathering, the pointer). */
export const FRAME_INTERVAL = 1000 / 30
/** The time between two frames of slow drift: 15 a second, enough for motion of a few pixels a second. */
export const AMBIENT_INTERVAL = 1000 / 15
/**
 * How long before a frame is due the timer asks for the animation frame. The animation frame then lands on the first
 * display refresh at or after the due time; a timer of the full interval lands one refresh late, every time.
 */
const VSYNC_LEAD = 6
/** How long the layer keeps moving after the last thing it follows has stopped. */
export const IDLE_AFTER = 5000
/** How long after the pointer last moved the field still answers it at the quick cadence. */
const POINTER_QUICK = 800

/** How long to wait, `sinceLast` after the last frame, before asking for the animation frame of the next one. */
export function armDelay(sinceLast: number, interval: number): number {
  return Math.max(0, interval - sinceLast - VSYNC_LEAD)
}

/**
 * When an animation frame may draw, and the time it stands for; null while it is early. `stamp` is the frame's own
 * time and `real` the clock as the callback runs. An engine asks within its lead of the due time, and a browser can
 * answer at once with the time of the refresh before (the clock is then near the due time, the stamp a refresh behind)
 * or at the next refresh (both at or past it); either way the frame stands for the due time, so the beat stays even
 * and does not drift by the lead. A frame that comes late stands for its own time.
 */
export function frameTime(last: number, stamp: number, real: number, interval: number): number | null {
  if (last <= 0) return stamp
  if (real - last < interval - VSYNC_LEAD - 1) return null
  return Math.max(stamp, last + interval)
}

/** Alpha is drawn in this many steps, one fill or stroke per step, instead of one per point. */
const STEPS = 16
const FEATHER = 56
/** The calm round words on the start page, for the field and the digits: nothing reaches up to a text surface. */
const CALM = 120
const FOCUS_FEATHER = 40
const PITCH = 28
const LINK = 140
/** How far the pointer reaches into the field. */
const REACH = 170
const CAPS: Record<BackdropStrength, { most: number; area: number }> = {
  light: { most: 90, area: 13_000 },
  standard: { most: 180, area: 7000 },
}

/** The digits' lattice: a cell every 15px, its glyph 10px; the sheet's tile is 37 × 23 cells. */
const PITCH_01 = 15
const GLYPH_01 = 10
const TILE_COLUMNS = 37
const TILE_ROWS = 23
/** The brightest a digit gets at 标准, on a dark and a light page: far under the words. */
const PEAK_01_DARK = 0.2
const PEAK_01_LIGHT = 0.16
/** At most this share of a form's cells show a digit. */
const FILL_01 = 0.62
/** The forms are worked out on a node every this many cells and eased between. */
const NODE_01 = 2
/** The width over which the forms fade at the layer's edges. */
const EDGE_01 = 90

/** A fixed number in [0, 1) for a cell and a salt. */
function cellHash(column: number, row: number, salt: number): number {
  let mixed = Math.imul(column + 1, 0x27d4eb2d) ^ Math.imul(row + 1, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1)
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x85ebca6b)
  mixed = Math.imul(mixed ^ (mixed >>> 13), 0xc2b2ae35)
  return ((mixed ^ (mixed >>> 16)) >>> 0) / 4294967296
}

/** Smooth value noise in [0, 1]: one fixed number per lattice point, eased between them. */
function noise(x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = cellHash(ix, iy, 5)
  const b = cellHash(ix + 1, iy, 5)
  const c = cellHash(ix, iy + 1, 5)
  const d = cellHash(ix + 1, iy + 1, 5)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

/** 0 below `from`, 1 above `to`, eased between. */
function smooth(from: number, to: number, value: number): number {
  const at = Math.max(0, Math.min(1, (value - from) / (to - from)))
  return at * at * (3 - 2 * at)
}

/** How many particles a viewport gets: one per `area` square pixels, capped. */
export function particleCount(width: number, height: number, strength: BackdropStrength): number {
  const { most, area } = CAPS[strength]
  return Math.max(0, Math.min(most, Math.round((width * height) / area)))
}

/** Six numbers per particle: x, y, depth, vx, vy, and its angle on the ring it gathers to. */
const STRIDE = 6
/** Four per visible particle of a frame: x, y, depth, alpha. */
const VISIBLE = 4

/** `ambient`: the field or the digits keep moving while nothing they follow happens, for a page with no text over it. */
export function createBackdropEngine(
  canvas: HTMLCanvasElement,
  kind: BackdropKind,
  strength: BackdropStrength,
  ambient = false,
): BackdropEngine {
  const context = canvas.getContext('2d', { alpha: true })
  let width = 0
  let height = 0
  let pixelRatio = 1
  let ink: string | null = null
  let power = strength === 'standard' ? 1 : 0.62
  let lightTheme = false
  let holes: readonly Hole[] = []
  let focus: Box | null = null
  let gather = 0
  let running = 0
  let ripples: Array<{ x: number; y: number; r: number; t: number }> = []
  let particles = new Float32Array(0)
  // This frame's visible particles, VISIBLE numbers each.
  let visible = new Float32Array(0)
  const buckets: number[][] = Array.from({ length: STEPS + 1 }, () => [])
  const lineBuckets: number[][] = Array.from({ length: STEPS + 1 }, () => [])
  const paused = new Set<string>()
  const times = new Float32Array(300)
  let frames = 0
  let points = 0
  let minGap = Infinity
  let request = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let idle = false
  let lastActive = performance.now()
  let last = 0
  const started = performance.now()
  let destroyed = false
  // The glow rests a third of the way down and moves behind the focused input.
  let glowX = 0
  let glowY = 0
  let glowSet = false
  let dirty = true
  let pointer: { x: number; y: number } | null = null
  let pointerMoved = 0
  let mono = 'monospace'
  let sheet: { key: string; pattern: CanvasPattern } | null = null
  let mask: {
    canvas: HTMLCanvasElement
    drawing: CanvasRenderingContext2D
    image: ImageData
    /** Each cell's threshold and its own tint, fixed for the size. */
    thresholds: Float32Array
    tints: Float32Array
    /** The forms on a node every `NODE_01` cells, worked out again each frame. */
    nodes: Float32Array
  } | null = null

  const alphaScale = () => (lightTheme ? 0.9 : 1) * power

  // The start page (ambient) keeps the wide calm round its words; a session's narrow margins keep the narrower feather.
  const soft = kind === 'field' || kind === 'digits'
  const feather = soft && ambient ? CALM : FEATHER
  /** 0 inside a hole, 1 well outside every one, with a feather between (eased, so the calm has no visible rim). */
  function clear(x: number, y: number): number {
    let amount = 1
    for (const hole of holes) {
      if (kind === 'grid' && gather > 0.5 && !hole.hard) continue
      const dx = Math.max(hole.left - x, 0, x - hole.right)
      const dy = Math.max(hole.top - y, 0, y - hole.bottom)
      if (dx === 0 && dy === 0) return 0
      if (dx < feather && dy < feather) {
        const near = Math.min(1, Math.sqrt(dx * dx + dy * dy) / feather)
        amount = Math.min(amount, soft ? near * near * (3 - 2 * near) : near)
      }
    }
    if (gather > 0.5 && focus) {
      const dx = Math.max(focus.left - x, 0, x - focus.right)
      const dy = Math.max(focus.top - y, 0, y - focus.bottom)
      if (dx === 0 && dy === 0) return 0
      amount = Math.min(amount, Math.sqrt(dx * dx + dy * dy) / FOCUS_FEATHER)
    }
    return amount
  }

  /**
   * Particle `index` always draws the same numbers, whatever was seeded before it: the still frame of a given size is
   * the same every time, also after the layer shrank and grew back.
   */
  const sequenceFor = (index: number) => {
    // mulberry32: successive draws of a linear generator fall on a lattice, which shows as rows of points.
    let state = Math.imul(index + 1, 0x9e3779b1) >>> 0
    return () => {
      state = (state + 0x6d2b79f5) >>> 0
      let mixed = Math.imul(state ^ (state >>> 15), state | 1)
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
    }
  }
  /**
   * Sets the particles for the size the layer has now. The ones it had keep their place in proportion (a resized
   * window does not reshuffle its field); a larger area gets more from the same fixed sequence, a smaller one keeps
   * the first of them.
   */
  function seed(fromWidth: number, fromHeight: number): void {
    const count = particleCount(width, height, strength)
    const next = new Float32Array(count * STRIDE)
    const kept = Math.min(count, particles.length / STRIDE)
    const sx = fromWidth > 0 ? width / fromWidth : 1
    const sy = fromHeight > 0 ? height / fromHeight : 1
    for (let index = 0; index < kept; index++) {
      const at = index * STRIDE
      next.set(particles.subarray(at, at + STRIDE), at)
      next[at] = particles[at]! * sx
      next[at + 1] = particles[at + 1]! * sy
    }
    for (let index = kept; index < count; index++) {
      const random = sequenceFor(index)
      const depth = 0.35 + random() * 0.65
      const at = index * STRIDE
      next[at] = random() * width
      next[at + 1] = random() * height
      next[at + 2] = depth
      next[at + 3] = (random() - 0.5) * 7 * depth
      next[at + 4] = (random() - 0.5) * 5 * depth
      next[at + 5] = random() * 6.28
    }
    particles = next
    visible = new Float32Array(count * VISIBLE)
  }

  /** Called in bitmap coordinates so a fractional box clears every physical pixel it touches. */
  function eraseFieldBox(target: CanvasRenderingContext2D, box: Box): void {
    const left = Math.floor(box.left * pixelRatio)
    const top = Math.floor(box.top * pixelRatio)
    const right = Math.ceil(box.right * pixelRatio)
    const bottom = Math.ceil(box.bottom * pixelRatio)
    target.clearRect(left, top, right - left, bottom - top)
  }

  /**
   * The field: points at several depths that drift and twinkle, the near ones linked by thin lines, and the points near
   * the pointer reaching for it. `seconds` is fixed for a held frame, so a still is the same every time.
   */
  function drawField(target: CanvasRenderingContext2D, dt: number, seconds: number, held: boolean): void {
    const speed = (1.3 + Math.min(running, 5) * 0.35) * dt
    const reach = !held && pointer && clear(pointer.x, pointer.y) > 0.5 ? pointer : null
    const cx = focus ? (focus.left + focus.right) / 2 : width / 2
    const cy = focus ? (focus.top + focus.bottom) / 2 : height / 2
    const scale = alphaScale()
    let shown = 0
    for (let at = 0; at < particles.length; at += STRIDE) {
      let px = particles[at]! + particles[at + 3]! * speed
      let py = particles[at + 1]! + particles[at + 4]! * speed
      if (px < -20) px += width + 40
      else if (px > width + 20) px -= width + 40
      if (py < -20) py += height + 40
      else if (py > height + 20) py -= height + 40
      particles[at] = px
      particles[at + 1] = py
      const depth = particles[at + 2]!
      const angle = particles[at + 5]!
      // Gathered: each point leans toward a wide ring around the input.
      const gx = cx + Math.cos(angle) * (width * 0.34) * (0.7 + depth * 0.5)
      const gy = cy + Math.sin(angle) * (height * 0.3) * (0.7 + depth * 0.5)
      let x = px + (gx - px) * gather * 0.42
      let y = py + (gy - py) * gather * 0.42
      let boost = 0
      for (const ring of ripples) {
        const distance = Math.hypot(x - ring.x, y - ring.y)
        const push = Math.max(0, 1 - Math.abs(distance - ring.r) / 70) * (1 - ring.t)
        if (push > 0) {
          x += ((x - ring.x) / (distance || 1)) * 7 * push
          y += ((y - ring.y) / (distance || 1)) * 7 * push
          boost += push * 0.5
        }
      }
      if (reach) {
        const dx = x - reach.x
        const dy = y - reach.y
        const distance = Math.hypot(dx, dy)
        if (distance < REACH) {
          const near = 1 - distance / REACH
          // Leans a little out of the pointer's way and brightens.
          x += (dx / (distance || 1)) * 9 * near * depth
          y += (dy / (distance || 1)) * 9 * near * depth
          boost += near * 0.35
        }
      }
      const amount = clear(x, y)
      if (amount <= 0.02) continue
      const twinkle = 0.78 + 0.22 * Math.sin(seconds * (0.5 + depth) + angle * 3)
      visible[shown] = x
      visible[shown + 1] = y
      visible[shown + 2] = depth
      visible[shown + 3] = (0.16 + depth * 0.4 + boost) * amount * scale * twinkle
      shown += VISIBLE
    }
    points = shown / VISIBLE
    for (const bucket of buckets) bucket.length = 0
    for (const bucket of lineBuckets) bucket.length = 0
    for (let a = 0; a < shown; a += VISIBLE) {
      const step = Math.min(STEPS, Math.round(Math.min(1, visible[a + 3]!) * STEPS))
      if (step > 0) buckets[step]!.push(visible[a]!, visible[a + 1]!, 1.2 + visible[a + 2]! * 1.8)
      if (reach) {
        const dx = visible[a]! - reach.x
        const dy = visible[a + 1]! - reach.y
        const distance = Math.sqrt(dx * dx + dy * dy)
        const line = Math.round((1 - distance / REACH) * 0.5 * visible[a + 3]! * STEPS * 4)
        if (distance < REACH && line > 0) lineBuckets[Math.min(STEPS, line)]!.push(visible[a]!, visible[a + 1]!, reach.x, reach.y)
      }
      if (visible[a + 2]! < 0.6) continue
      for (let b = a + VISIBLE; b < shown; b += VISIBLE) {
        if (visible[b + 2]! < 0.6) continue
        const dx = visible[a]! - visible[b]!
        const dy = visible[a + 1]! - visible[b + 1]!
        if (dx > LINK || dx < -LINK || dy > LINK || dy < -LINK) continue
        const distance = Math.sqrt(dx * dx + dy * dy)
        if (distance >= LINK) continue
        let line = Math.round((1 - distance / LINK) * 0.45 * Math.min(visible[a + 3]!, visible[b + 3]!) * STEPS * 4)
        // A link whose middle crosses the calm round words fades with it, though both its ends lie outside.
        if (line > 0 && holes.length > 0)
          line = Math.round(line * clear((visible[a]! + visible[b]!) / 2, (visible[a + 1]! + visible[b + 1]!) / 2))
        if (line > 0) lineBuckets[Math.min(STEPS, line)]!.push(visible[a]!, visible[a + 1]!, visible[b]!, visible[b + 1]!)
      }
    }
    // One stroke per step of line alpha (in quarters of a step, lines being faint) and one fill per step of point alpha.
    target.lineWidth = 1
    for (let step = 1; step <= STEPS; step++) {
      const lines = lineBuckets[step]!
      if (lines.length === 0) continue
      target.strokeStyle = `rgba(${ink}, ${step / (STEPS * 4)})`
      target.beginPath()
      for (let at = 0; at < lines.length; at += 4) {
        target.moveTo(lines[at]!, lines[at + 1]!)
        target.lineTo(lines[at + 2]!, lines[at + 3]!)
      }
      target.stroke()
    }
    for (let step = 1; step <= STEPS; step++) {
      const dots = buckets[step]!
      if (dots.length === 0) continue
      target.fillStyle = `rgba(${ink}, ${step / STEPS})`
      target.beginPath()
      for (let at = 0; at < dots.length; at += 3) {
        const size = dots[at + 2]!
        target.rect(dots[at]! - size / 2, dots[at + 1]! - size / 2, size, size)
      }
      target.fill()
    }
    if (holes.length > 0 || focus) {
      // A link can cross a hole even when both of its endpoints survived the feather.
      target.resetTransform()
      for (const hole of holes) eraseFieldBox(target, hole)
      if (focus) eraseFieldBox(target, focus)
      target.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    }
  }

  /**
   * The digits' sheet: one tile of 0s and 1s at full ink, drawn once for the size, ink and font, and repeated by a
   * pattern. A tile of prime size in cells, so its repeat does not line up with anything else on the page.
   */
  function digitSheet(target: CanvasRenderingContext2D): CanvasPattern | null {
    if (sheet && sheet.key === `${ink} ${mono} ${pixelRatio}`) return sheet.pattern
    const tile = document.createElement('canvas')
    tile.width = Math.round(TILE_COLUMNS * PITCH_01 * pixelRatio)
    tile.height = Math.round(TILE_ROWS * PITCH_01 * pixelRatio)
    const drawing = tile.getContext('2d')
    if (!drawing) return null
    drawing.scale(pixelRatio, pixelRatio)
    drawing.fillStyle = `rgb(${ink})`
    drawing.textAlign = 'center'
    drawing.textBaseline = 'middle'
    drawing.font = `${GLYPH_01}px ${mono}`
    for (let row = 0; row < TILE_ROWS; row++)
      for (let column = 0; column < TILE_COLUMNS; column++)
        drawing.fillText(cellHash(column, row, 3) < 0.5 ? '0' : '1', (column + 0.5) * PITCH_01, (row + 0.5) * PITCH_01)
    const pattern = target.createPattern(tile, 'repeat')
    // The context draws in CSS pixels; the tile is already at the bitmap's resolution.
    pattern?.setTransform(new DOMMatrix().scale(1 / pixelRatio))
    sheet = pattern ? { key: `${ink} ${mono} ${pixelRatio}`, pattern } : null
    return pattern
  }

  /**
   * How much of the drifting forms is at a point, 0 to 1. Their outlines wander (each point is looked up a little
   * aside, by a slow noise), and they fade at the layer's own edges too, so a form never ends on a straight line.
   */
  function formDensity(x: number, y: number, t: number): number {
    // A small layer (a preview tile) fades over a share of its size instead.
    const fade = Math.min(EDGE_01, Math.min(width, height) * 0.15)
    const edge = smooth(0, fade, x) * smooth(0, fade, width - x) * smooth(0, fade, y) * smooth(0, fade, height - y)
    if (edge <= 0) return 0
    const span = Math.min(width, height)
    const wx = x + (noise(x * 0.0018 + 3.1, y * 0.0018 + t * 0.6) - 0.5) * 200
    const wy = y + (noise(x * 0.0018 - 7.4, y * 0.0018 - t * 0.5) - 0.5) * 200
    let field = 0
    for (let body = 0; body < 3; body++) {
      const bx = width * (0.5 + 0.44 * Math.sin(t * (0.61 + body * 0.23) + body * 2.1))
      const by = height * (0.5 + 0.42 * Math.cos(t * (0.47 + body * 0.31) + body * 1.3))
      const radius = span * (0.36 + body * 0.06)
      const d2 = ((wx - bx) * (wx - bx) + (wy - by) * (wy - by)) / (radius * radius)
      if (d2 < 1) field += (1 - d2) * (1 - d2)
    }
    for (const ring of ripples) field += Math.max(0, 1 - Math.abs(Math.hypot(x - ring.x, y - ring.y) - ring.r) / 46) * (1 - ring.t) * 0.5
    return smooth(0.1, 0.9, field) * edge
  }

  /**
   * 01: soft forms made of 0s and 1s drifting over a fixed lattice. The forms decide which cells show at all (each
   * cell has its own threshold and fades in over a small band round it, so an edge dissolves instead of cutting) and
   * how bright; even at a form's heart only some cells show, so it reads as a texture and never as a table. Words keep
   * a wide calm round them.
   *
   * Per frame it works out the forms on a node every other cell, eases each cell's number from the four round it into
   * a small mask (one byte a cell), then draws the whole sheet of digits once and keeps it only where the mask lets
   * it: a few calls whatever the number of cells, and no text drawn after the sheet.
   */
  function drawDigits(target: CanvasRenderingContext2D, seconds: number): void {
    const pattern = digitSheet(target)
    if (!pattern) return
    const columns = Math.ceil(width / PITCH_01)
    const rows = Math.ceil(height / PITCH_01)
    if (!mask || mask.canvas.width !== columns || mask.canvas.height !== rows) {
      const canvas = document.createElement('canvas')
      canvas.width = columns
      canvas.height = rows
      const drawing = canvas.getContext('2d')
      if (!drawing) return
      const thresholds = new Float32Array(columns * rows)
      const tints = new Float32Array(columns * rows)
      for (let row = 0; row < rows; row++)
        for (let column = 0; column < columns; column++) {
          thresholds[row * columns + column] = cellHash(column, row, 11)
          tints[row * columns + column] = 0.7 + 0.3 * cellHash(column, row, 17)
        }
      const across = Math.ceil(columns / NODE_01) + 1
      const down = Math.ceil(rows / NODE_01) + 1
      mask = { canvas, drawing, image: drawing.createImageData(columns, rows), thresholds, tints, nodes: new Float32Array(across * down) }
    }
    const t = seconds * (0.05 + Math.min(running, 5) * 0.01)
    const scale = Math.min(1, alphaScale() * (lightTheme ? PEAK_01_LIGHT : PEAK_01_DARK) * (1 - gather * 0.5))
    const { image, thresholds, tints, nodes } = mask
    const across = Math.ceil(columns / NODE_01) + 1
    const down = Math.ceil(rows / NODE_01) + 1
    for (let j = 0; j < down; j++)
      for (let i = 0; i < across; i++)
        nodes[j * across + i] = formDensity((i * NODE_01 + 0.5) * PITCH_01, (j * NODE_01 + 0.5) * PITCH_01, t)
    const data = image.data
    let shown = 0
    let first = rows
    let last = -1
    for (let row = 0; row < rows; row++) {
      const y = (row + 0.5) * PITCH_01
      const j = Math.floor(row / NODE_01)
      const fy = (row - j * NODE_01) / NODE_01
      for (let column = 0; column < columns; column++) {
        const cell = row * columns + column
        const i = Math.floor(column / NODE_01)
        const fx = (column - i * NODE_01) / NODE_01
        const top = nodes[j * across + i]! + (nodes[j * across + i + 1]! - nodes[j * across + i]!) * fx
        const bottom = nodes[(j + 1) * across + i]! + (nodes[(j + 1) * across + i + 1]! - nodes[(j + 1) * across + i]!) * fx
        const density = top + (bottom - top) * fy
        let alpha = 0
        if (density > 0.01) {
          const amount = clear((column + 0.5) * PITCH_01, y)
          if (amount > 0.02) {
            const threshold = thresholds[cell]!
            const present = smooth(threshold - 0.1, threshold + 0.1, density * FILL_01)
            alpha = Math.round(present * (0.3 + 0.7 * density) * tints[cell]! * amount * scale * 255)
          }
        }
        data[cell * 4 + 3] = alpha
        if (alpha > 0) {
          shown++
          if (row < first) first = row
          last = row
        }
      }
    }
    points = shown
    if (shown === 0) return
    mask.drawing.putImageData(image, 0, 0)
    // Only the band of rows with something lit takes the sheet.
    target.fillStyle = pattern
    target.fillRect(0, first * PITCH_01, width, (last + 1 - first) * PITCH_01)
    target.globalCompositeOperation = 'destination-in'
    target.imageSmoothingEnabled = false
    target.drawImage(mask.canvas, 0, 0, columns, rows, 0, 0, columns * PITCH_01, rows * PITCH_01)
    target.globalCompositeOperation = 'source-over'
    target.imageSmoothingEnabled = true
    // A digit centred outside a hole can still reach into it by a few pixels: every hole is cut out exactly.
    if (holes.length > 0 || focus) {
      target.resetTransform()
      for (const hole of holes) eraseFieldBox(target, hole)
      if (focus) eraseFieldBox(target, focus)
      target.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    }
  }

  function drawGrid(target: CanvasRenderingContext2D, now: number): void {
    const seconds = (now - started) / 1000
    const lively = Math.min(running, 5)
    const drift = (seconds * (2 + lively)) % PITCH
    // A slow diagonal band of brightness.
    const band = ((seconds * 0.035 * (1 + lively * 0.15)) % 1.6) - 0.3
    const locked = gather > 0.01 && focus !== null
    const cx = focus ? (focus.left + focus.right) / 2 : 0
    const cy = focus ? (focus.top + focus.bottom) / 2 : 0
    const ix = 1 / (width * 0.5)
    const iy = 1 / (height * 0.6)
    const far = 1 - gather * 0.55
    const near = 0.34 * gather
    const scale = alphaScale()
    for (const bucket of buckets) bucket.length = 0
    let shown = 0
    for (let y = -PITCH + drift * 0.5; y < height + PITCH; y += PITCH) {
      const ey = (y - cy) * iy
      for (let x = -PITCH + drift; x < width + PITCH; x += PITCH) {
        const amount = clear(x, y)
        if (amount <= 0.02) continue
        const across = (x / width + y / height) / 2 - band
        let alpha = 0.13 + (across > -0.16 && across < 0.16 ? (1 - Math.abs(across) / 0.16) * 0.2 : 0)
        if (locked) {
          const ex = (x - cx) * ix
          const d2 = ex * ex + ey * ey
          alpha = alpha * far + (d2 < 1 ? (1 - Math.sqrt(d2)) * near : 0)
        }
        for (const ring of ripples)
          alpha += Math.max(0, 1 - Math.abs(Math.hypot(x - ring.x, y - ring.y) - ring.r) / 46) * (1 - ring.t) * 0.5
        // Alpha in steps, one fill per step: a handful of state changes a frame instead of one per dot.
        const step = Math.min(STEPS, Math.round(Math.min(0.7, alpha * amount * scale) * STEPS))
        if (step > 0) {
          buckets[step]!.push(x, y)
          shown++
        }
      }
    }
    points = shown
    for (let step = 1; step <= STEPS; step++) {
      const bucket = buckets[step]!
      if (bucket.length === 0) continue
      target.fillStyle = `rgba(${ink}, ${step / STEPS})`
      target.beginPath()
      for (let at = 0; at < bucket.length; at += 2) target.rect(bucket[at]! - 0.5, bucket[at + 1]! - 0.5, 1.25, 1.25)
      target.fill()
    }
  }

  /**
   * The soft light: one faint disc, redrawn only while it moves. Every hole is cut out of it with a hard edge, so it
   * never tints a security surface. Returns whether it still moves.
   */
  function drawGlow(target: CanvasRenderingContext2D, dt: number, snap: boolean): boolean {
    const tx = focus ? (focus.left + focus.right) / 2 : width / 2
    const ty = focus ? (focus.top + focus.bottom) / 2 : height / 3
    if (!glowSet || snap) {
      glowX = tx
      glowY = ty
      glowSet = true
    } else {
      const ease = Math.min(1, dt * 3)
      glowX += (tx - glowX) * ease
      glowY += (ty - glowY) * ease
    }
    const radius = Math.min(380, Math.max(width, height) * 0.45)
    const light = target.createRadialGradient(glowX, glowY, 0, glowX, glowY, radius)
    light.addColorStop(0, `rgba(${ink}, ${0.085 * alphaScale()})`)
    light.addColorStop(1, `rgba(${ink}, 0)`)
    target.fillStyle = light
    target.fillRect(glowX - radius, glowY - radius, radius * 2, radius * 2)
    for (const hole of holes) target.clearRect(hole.left, hole.top, hole.right - hole.left, hole.bottom - hole.top)
    points = 0
    return Math.abs(tx - glowX) > 0.5 || Math.abs(ty - glowY) > 0.5
  }

  /** Draws one frame; returns whether something it follows is still happening. */
  function draw(now: number, held: boolean): boolean {
    if (!context || width === 0 || height === 0) return false
    const dt = held || last === 0 ? 0.033 : Math.min(0.1, (now - last) / 1000)
    const begun = performance.now()
    const to = focus ? 1 : 0
    gather = held ? to : gather + (to - gather) * Math.min(1, dt * 7)
    if (held) ripples = []
    for (const ring of ripples) {
      ring.t += dt / 0.9
      ring.r = 30 + ring.t * 420
    }
    ripples = ripples.filter(ring => ring.t < 1)
    context.clearRect(0, 0, width, height)
    let moving = false
    if (ink === null) points = 0
    else if (kind === 'field') drawField(context, held ? 0 : dt, held ? 9 : (now - started) / 1000, held)
    else if (kind === 'digits') drawDigits(context, held ? 9 : (now - started) / 1000)
    else if (kind === 'grid') drawGrid(context, held ? started + 9000 : now)
    else moving = drawGlow(context, dt, held)
    if (frames > 0 && last > 0 && !held && !dirty) minGap = Math.min(minGap, now - last)
    times[frames % times.length] = performance.now() - begun
    frames++
    last = held ? 0 : now
    dirty = false
    if (kind === 'glow') return moving
    // An ambient field drifts for as long as nothing holds it still.
    if ((kind === 'field' || kind === 'digits') && ambient) return true
    return running > 0 || ripples.length > 0 || Math.abs(to - gather) > 0.01
  }

  /**
   * The cadence: 30 frames a second while something moves quickly (a ring widening, the field gathering or letting
   * go, the pointer moving over the field), 15 for the slow drift that is all the rest.
   */
  function interval(now: number): number {
    const quick =
      ripples.length > 0
      || Math.abs((focus ? 1 : 0) - gather) > 0.01
      || (kind === 'field' && pointer !== null && now - pointerMoved < POINTER_QUICK)
    return quick || kind === 'grid' || kind === 'glow' ? FRAME_INTERVAL : AMBIENT_INTERVAL
  }

  function frame(stamp: number): void {
    request = 0
    if (destroyed || paused.size > 0) return
    // A frame that comes early waits for its beat, unless something it draws from changed: that is drawn at once, so a
    // surface that just appeared is never under the layer for a beat's wait.
    const real = performance.now()
    const now = dirty ? Math.max(stamp, last) : frameTime(last, stamp, real, interval(real))
    if (now === null) {
      schedule()
      return
    }
    if (draw(now, false)) lastActive = now
    // The glow rests the moment it has arrived; the others drift on for a few seconds, then hold their frame.
    idle = now - lastActive >= (kind === 'glow' ? 0 : IDLE_AFTER)
    if (!idle || dirty) schedule()
  }

  /**
   * Arms the next frame: one timer that ends a little before the frame is due, then one animation frame, which lands
   * on the refresh at or after it. The frames come on an even beat of refreshes, never one late each time, and never
   * an animation frame per refresh. Never more than one of each.
   */
  function schedule(): void {
    if (request !== 0 || timer !== undefined || paused.size > 0 || destroyed) return
    const arm = () => {
      timer = undefined
      if (paused.size === 0 && !destroyed) request = requestAnimationFrame(frame)
    }
    const now = performance.now()
    const wait = dirty || last === 0 ? 0 : armDelay(now - last, interval(now))
    if (wait > 0) timer = setTimeout(arm, wait)
    else arm()
  }

  function disarm(): void {
    if (request !== 0) cancelAnimationFrame(request)
    if (timer !== undefined) clearTimeout(timer)
    request = 0
    timer = undefined
  }

  /** While paused the canvas holds one still frame of what it is told now. */
  function still(): void {
    draw(performance.now(), true)
  }

  /** Something it draws from changed (its size, its ink, a hole): one new frame, held or drawn. */
  function changed(): void {
    dirty = true
    if (paused.size > 0) {
      still()
      return
    }
    // A timer waiting out the beat gives way: the change is drawn on the next animation frame.
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    schedule()
  }

  /** Something it follows happened: it moves again. */
  function wake(): void {
    lastActive = performance.now()
    idle = false
    changed()
  }

  return {
    resize(nextWidth, nextHeight, dpr) {
      if (!context) return
      const [fromWidth, fromHeight] = [width, height]
      width = nextWidth
      height = nextHeight
      pixelRatio = dpr
      canvas.width = Math.round(nextWidth * dpr)
      canvas.height = Math.round(nextHeight * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (kind === 'field') seed(fromWidth, fromHeight)
      glowSet = false
      changed()
    },
    setInk(rgb, light) {
      if (rgb === ink && light === lightTheme) return
      ink = rgb
      lightTheme = light
      changed()
    },
    setHoles(next) {
      const same =
        next.length === holes.length
        && next.every((hole, index) => {
          const old = holes[index]!
          return (
            old.hard === hole.hard
            && old.left === hole.left
            && old.top === hole.top
            && old.right === hole.right
            && old.bottom === hole.bottom
          )
        })
      if (same) return
      holes = next
      changed()
    },
    setRunning(count) {
      const next = Number.isFinite(count) ? Math.max(0, count) : 0
      if (next === running) return
      running = next
      if (next > 0) wake()
    },
    setFocus(target) {
      const same =
        target === focus
        || (target !== null
          && focus !== null
          && target.left === focus.left
          && target.top === focus.top
          && target.right === focus.right
          && target.bottom === focus.bottom)
      if (same) return
      focus = target
      wake()
    },
    ripple(x, y) {
      // A ripple is movement: none while the layer is held still, and none in the glow.
      if (paused.size > 0 || kind === 'glow') return
      ripples.push({ x, y, r: 30, t: 0 })
      wake()
    },
    setPointer(point) {
      if (kind !== 'field' || (point === null && pointer === null)) return
      pointer = point
      pointerMoved = performance.now()
    },
    setFont(family) {
      if (family === mono || family === '') return
      mono = family
      changed()
    },
    pause(reason) {
      if (paused.has(reason)) return
      paused.add(reason)
      disarm()
      still()
    },
    resume(reason) {
      if (!paused.delete(reason) || paused.size > 0) return
      last = 0
      wake()
    },
    stats() {
      const count = Math.min(frames, times.length)
      const sorted = Array.from(times.subarray(0, count)).toSorted((a, b) => a - b)
      const sum = sorted.reduce((total, time) => total + time, 0)
      return {
        frames,
        points,
        avg: count === 0 ? 0 : sum / count,
        p95: count === 0 ? 0 : sorted[Math.min(count - 1, Math.floor(count * 0.95))]!,
        max: count === 0 ? 0 : sorted[count - 1]!,
        minGap: Number.isFinite(minGap) ? minGap : 0,
        paused: [...paused],
        idle,
        armed: request !== 0 || timer !== undefined,
        rings: ripples.length,
      }
    },
    destroy() {
      destroyed = true
      disarm()
    },
  }
}
