/*
 * The drawing of the background layer (Backdrop): three effects on one canvas, and the limits that keep it cheap. It
 * is decoration. It follows three real states it is told about (how many sessions run, whether the input holds the
 * focus, where a decision was just resolved) and carries no information of its own: each of them is also written in
 * the foreground in words.
 *
 * Limits: at most 30 frames a second, each armed by one timer and one animation frame (never an animation frame per
 * display refresh); the number of points follows the viewport's area and is capped (60 for 轻, 110 for 标准); nothing
 * is drawn inside a hole (a security surface, or a region whose words sit straight on the canvas), with a feather
 * round it; the canvas is its own layer and the loop only writes its pixels, so no layout or paint of content is
 * caused. When nothing it follows is happening (no session runs, no ring widens, the focus has settled) it stops after
 * a few seconds on the frame it has, and draws again when told something. Whoever owns the engine pauses it (tab
 * hidden, window in the background, a reply streaming in view, reduced motion, low battery); paused, it holds one
 * still frame.
 */

export type BackdropKind = 'grid' | 'field' | 'glow'
export type BackdropStrength = 'light' | 'standard'

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** A region nothing is drawn in. `hard` regions (security surfaces) are also kept clear while the input is focused. */
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
  pause(reason: string): void
  resume(reason: string): void
  stats(): BackdropStats
  destroy(): void
}

/** The least time between two frames: 30 a second. */
export const FRAME_INTERVAL = 1000 / 30
/** How long the layer keeps moving after the last thing it follows has stopped. */
export const IDLE_AFTER = 5000
/** Alpha is drawn in this many steps, one fill or stroke per step, instead of one per point. */
const STEPS = 16
const FEATHER = 56
const FOCUS_FEATHER = 40
const PITCH = 28
const LINK = 120
const CAPS: Record<BackdropStrength, { most: number; area: number }> = {
  light: { most: 60, area: 24_000 },
  standard: { most: 110, area: 14_000 },
}

/** How many particles a viewport gets: one per `area` square pixels, capped. */
export function particleCount(width: number, height: number, strength: BackdropStrength): number {
  const { most, area } = CAPS[strength]
  return Math.max(0, Math.min(most, Math.round((width * height) / area)))
}

/** Six numbers per particle: x, y, depth, vx, vy, and its angle on the ring it gathers to. */
const STRIDE = 6

export function createBackdropEngine(canvas: HTMLCanvasElement, kind: BackdropKind, strength: BackdropStrength): BackdropEngine {
  const context = canvas.getContext('2d', { alpha: true })
  let width = 0
  let height = 0
  let ink: string | null = null
  let power = strength === 'standard' ? 1 : 0.62
  let lightTheme = false
  let holes: readonly Hole[] = []
  let focus: Box | null = null
  let gather = 0
  let running = 0
  let ripples: Array<{ x: number; y: number; r: number; t: number }> = []
  let particles = new Float32Array(0)
  // Positions and alphas of this frame's visible particles: x, y, depth, alpha.
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

  const alphaScale = () => (lightTheme ? 0.9 : 1) * power

  /** 0 inside a hole, 1 well outside every one, with a feather between. */
  function clear(x: number, y: number): number {
    let amount = 1
    for (const hole of holes) {
      // Focused, the lanes have stood down: only the input itself and security surfaces stay clear.
      if (gather > 0.5 && !hole.hard) continue
      const dx = Math.max(hole.left - x, 0, x - hole.right)
      const dy = Math.max(hole.top - y, 0, y - hole.bottom)
      if (dx === 0 && dy === 0) return 0
      if (dx < FEATHER && dy < FEATHER) amount = Math.min(amount, Math.sqrt(dx * dx + dy * dy) / FEATHER)
    }
    if (gather > 0.5 && focus) {
      const dx = Math.max(focus.left - x, 0, x - focus.right)
      const dy = Math.max(focus.top - y, 0, y - focus.bottom)
      if (dx === 0 && dy === 0) return 0
      amount = Math.min(amount, Math.sqrt(dx * dx + dy * dy) / FOCUS_FEATHER)
    }
    return amount
  }

  // A fixed sequence: the still frame of a given size is the same every time.
  let sequence = 7
  const random = () => (sequence = (sequence * 16807) % 2147483647) / 2147483647
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
    visible = new Float32Array(count * 4)
  }

  function drawField(target: CanvasRenderingContext2D, dt: number): void {
    const speed = (0.45 + Math.min(running, 5) * 0.2) * dt
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
      const amount = clear(x, y)
      if (amount <= 0.02) continue
      visible[shown] = x
      visible[shown + 1] = y
      visible[shown + 2] = depth
      visible[shown + 3] = (0.16 + depth * 0.34 + boost) * amount * scale
      shown += 4
    }
    points = shown / 4
    for (const bucket of buckets) bucket.length = 0
    for (const bucket of lineBuckets) bucket.length = 0
    for (let a = 0; a < shown; a += 4) {
      const step = Math.min(STEPS, Math.round(Math.min(1, visible[a + 3]!) * STEPS))
      if (step > 0) buckets[step]!.push(visible[a]!, visible[a + 1]!, 1 + visible[a + 2]! * 1.4)
      if (visible[a + 2]! < 0.6) continue
      for (let b = a + 4; b < shown; b += 4) {
        if (visible[b + 2]! < 0.6) continue
        const dx = visible[a]! - visible[b]!
        const dy = visible[a + 1]! - visible[b + 1]!
        if (dx > LINK || dx < -LINK || dy > LINK || dy < -LINK) continue
        const distance = Math.sqrt(dx * dx + dy * dy)
        if (distance >= LINK) continue
        const line = Math.round((1 - distance / LINK) * 0.32 * Math.min(visible[a + 3]!, visible[b + 3]!) * STEPS * 4)
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
    else if (kind === 'field') drawField(context, held ? 0 : dt)
    else if (kind === 'grid') drawGrid(context, held ? started + 9000 : now)
    else moving = drawGlow(context, dt, held)
    if (frames > 0 && last > 0 && !held) minGap = Math.min(minGap, now - last)
    times[frames % times.length] = performance.now() - begun
    frames++
    last = held ? 0 : now
    dirty = false
    if (kind === 'glow') return moving
    return running > 0 || ripples.length > 0 || Math.abs(to - gather) > 0.01
  }

  function frame(now: number): void {
    request = 0
    if (destroyed || paused.size > 0) return
    // The 30 fps cap: a frame that comes early waits out the rest of the interval on the timer.
    if (last > 0 && now - last < FRAME_INTERVAL - 1) {
      schedule(FRAME_INTERVAL - (now - last))
      return
    }
    if (draw(now, false)) lastActive = now
    // The glow rests the moment it has arrived; the others drift on for a few seconds, then hold their frame.
    idle = now - lastActive >= (kind === 'glow' ? 0 : IDLE_AFTER)
    if (!idle || dirty) schedule(FRAME_INTERVAL)
  }

  /**
   * Arms the next frame: one timer for the wait, then one animation frame, so the frame is never early and never has
   * to be armed twice. Never more than one of each.
   */
  function schedule(wait: number): void {
    if (request !== 0 || timer !== undefined || paused.size > 0 || destroyed) return
    const arm = () => {
      timer = undefined
      if (paused.size === 0 && !destroyed) request = requestAnimationFrame(frame)
    }
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
    if (paused.size > 0) still()
    else schedule(0)
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
