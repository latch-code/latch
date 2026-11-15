import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { createBackdropEngine, type BackdropEngine, type BackdropKind, type BackdropStats, type Hole } from './backdrop-engine.ts'
import { captureStill, motionAllowed, watchMotion } from './changes.ts'
import { cx, PHONE_QUERY } from './internal.ts'
import { streamingInView, watchStreaming } from './stream.ts'

export type { BackdropKind, BackdropStats } from './backdrop-engine.ts'

/** 背景效果: 关, 轻 or 标准. */
export type BackdropLevel = 'off' | 'light' | 'standard'

/** The regions nothing is drawn in: security surfaces always, and regions whose words sit straight on the canvas. */
const HOLES = '[data-secure], [data-backdrop-clear]'
const HOLE_ATTRIBUTES = ['data-secure', 'data-backdrop-clear']

interface BatteryLike extends EventTarget {
  charging: boolean
  level: number
}

/**
 * Low power. Where the platform reports its battery: on battery at 20% or less. Where it does not, a phone is taken
 * to be on battery and the layer holds its still frame; a desktop or tablet that reports nothing never pauses for it.
 */
function watchLowPower(report: (low: boolean) => void): () => void {
  const source = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }
  if (typeof source.getBattery !== 'function') {
    const phone = matchMedia(PHONE_QUERY)
    const read = () => {
      report(phone.matches)
    }
    phone.addEventListener('change', read)
    read()
    return () => {
      phone.removeEventListener('change', read)
    }
  }
  let battery: BatteryLike | null = null
  let stopped = false
  const read = () => {
    if (battery) report(!battery.charging && battery.level <= 0.2)
  }
  void source.getBattery().then(
    found => {
      if (stopped) return
      battery = found
      found.addEventListener('chargingchange', read)
      found.addEventListener('levelchange', read)
      read()
    },
    () => {},
  )
  return () => {
    stopped = true
    battery?.removeEventListener('chargingchange', read)
    battery?.removeEventListener('levelchange', read)
  }
}

/** The background ink of the theme as `r, g, b`, or null where the token is not set: then nothing is drawn. */
function inkOf(element: Element): string | null {
  const ink = getComputedStyle(element).getPropertyValue('--fx-ink').trim()
  // The bundled stylesheet can express the same token in hex.
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu.exec(ink)
  if (hex)
    return hex
      .slice(1)
      .map(channel => Number.parseInt(channel, 16))
      .join(', ')
  const parts = /(\d+)[,\s]+(\d+)[,\s]+(\d+)/u.exec(ink)
  return parts ? `${parts[1]}, ${parts[2]}, ${parts[3]}` : null
}

/** Whether a node that joined or left the document is, or holds, a region the layer must keep clear. */
const holdsHole = (node: Node): boolean => node instanceof Element && (node.matches(HOLES) || node.querySelector(HOLES) !== null)

/**
 * The background layer: 点阵 (`grid`: a fine dot grid that drifts, with a slow band of light), 粒子场 (`field`: points
 * at several depths, the near ones linked by thin lines) or 柔光 (`glow`: one faint light), on a single canvas that is
 * its own layer behind the content of the element it is placed in (which gets `ui-backdrop-host`, or any positioned
 * element that isolates its stacking). It is decoration and says nothing by itself. It is given three real states,
 * each also written in the foreground:
 *
 * - `running`: how many sessions the Host reports as running; with more, the field moves a little faster (up to 5),
 *   and with none it comes to rest after a few seconds.
 * - `focus`: the input holds the focus (专注输入); the field gathers round `focusTarget` and everything else quiets.
 * - `resolved`: a decision was just resolved at this point of the window; one ring widens from there. A new `id` is
 *   a new ring.
 *
 * It never draws under or over a security surface (`[data-secure]`), is not rendered inside one, and keeps clear of
 * regions marked `data-backdrop-clear` (words set straight on the canvas), with a 56px feather. Where those regions
 * are is measured again whenever they can have moved: a region appears, leaves or changes size, the page scrolls or
 * the window resizes; also while the layer is paused, so a surface that arrives during a stream is cut out of the
 * still frame. It draws at most 30 frames a second with a point count capped by the viewport, and holds one still
 * frame while the tab is hidden or the window is in the background, a reply is streaming in view, motion is reduced
 * (the system's preference or 减弱), the page is frozen for a capture, or power is low. `level` off renders nothing.
 */
export function Backdrop({
  kind = 'field',
  level,
  running = 0,
  focus = false,
  focusTarget,
  resolved = null,
  fixed = false,
  className,
  onStats,
}: {
  kind?: BackdropKind
  level: BackdropLevel
  running?: number
  focus?: boolean
  /** The focused input, which the field gathers round; without it, the middle of the layer. */
  focusTarget?: RefObject<Element | null>
  resolved?: { id: string | number; x: number; y: number } | null
  /** Fills the window instead of the element it is placed in. */
  fixed?: boolean
  className?: string
  /** For measurement and tests: receives a function that reads the engine's counters. */
  onStats?: (read: (() => BackdropStats) | null) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const engine = useRef<BackdropEngine | null>(null)
  /** Asks for the regions to be measured again, on the next frame. */
  const remeasure = useRef<() => void>(() => {})
  /** A point of the window in the canvas's own coordinates, whatever scales or moves its ancestors. */
  const toCanvas = useRef<(x: number, y: number) => { x: number; y: number }>((x, y) => ({ x, y }))
  const inputs = useRef({ running, focus, focusTarget })
  useLayoutEffect(() => {
    inputs.current = { running, focus, focusTarget }
  })
  const stats = useRef(onStats)
  useLayoutEffect(() => {
    stats.current = onStats
  })

  useEffect(() => {
    const element = canvas.current
    // Never inside a security surface, whatever a caller passes.
    if (level === 'off' || !element || element.closest('[data-secure]')) return undefined
    const created = createBackdropEngine(element, kind, level)
    engine.current = created
    created.setRunning(inputs.current.running)
    stats.current?.(() => created.stats())
    const regions = new Set<Element>()
    let frame = 0

    const sizes = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target !== element) continue
        created.resize(entry.contentRect.width, entry.contentRect.height, Math.min(window.devicePixelRatio || 1, 2))
      }
      schedule()
    })

    /**
     * Reads the theme's ink, where the canvas is and what it must keep clear of, once, at the start of a frame. A
     * transformed ancestor scales what the browser reports, so every distance is divided by that scale.
     */
    const measure = () => {
      frame = 0
      const box = element.getBoundingClientRect()
      const sx = element.clientWidth > 0 && box.width > 0 ? box.width / element.clientWidth : 1
      const sy = element.clientHeight > 0 && box.height > 0 ? box.height / element.clientHeight : 1
      const place = (at: DOMRect) => ({
        left: (at.left - box.left) / sx,
        top: (at.top - box.top) / sy,
        right: (at.right - box.left) / sx,
        bottom: (at.bottom - box.top) / sy,
      })
      toCanvas.current = (x, y) => ({ x: (x - box.left) / sx, y: (y - box.top) / sy })
      created.setInk(inkOf(element), getComputedStyle(element).colorScheme !== 'dark')
      const holes: Hole[] = []
      const found = new Set<Element>()
      for (const region of document.querySelectorAll(HOLES)) {
        if (region.contains(element)) continue
        found.add(region)
        const at = region.getBoundingClientRect()
        if (at.width === 0 || at.height === 0 || at.right < box.left || at.left > box.right || at.bottom < box.top || at.top > box.bottom)
          continue
        holes.push({ ...place(at), hard: region.matches('[data-secure]') })
      }
      // A region that grows or shrinks is measured again.
      for (const region of found) if (!regions.has(region)) sizes.observe(region)
      for (const region of regions) if (!found.has(region)) sizes.unobserve(region)
      regions.clear()
      for (const region of found) regions.add(region)
      created.setHoles(holes)
      if (inputs.current.focus) created.setFocus(place(inputs.current.focusTarget?.current?.getBoundingClientRect() ?? box))
    }
    function schedule(): void {
      if (frame === 0) frame = requestAnimationFrame(measure)
    }
    remeasure.current = schedule
    sizes.observe(element)

    // A region that appears, leaves, or is marked later.
    const marks = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes' || [...record.addedNodes].some(holdsHole) || [...record.removedNodes].some(holdsHole)) {
          schedule()
          return
        }
      }
    })
    marks.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: HOLE_ATTRIBUTES })
    // Any scroller on the page moves what is in it: scroll does not bubble, so it is caught on the way down.
    window.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', schedule)

    // The display's pixel ratio changes when the window moves to another screen or the page is zoomed.
    let density: MediaQueryList | undefined
    const densityChanged = () => {
      density?.removeEventListener('change', densityChanged)
      density = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      density.addEventListener('change', densityChanged)
      created.resize(element.clientWidth, element.clientHeight, Math.min(window.devicePixelRatio || 1, 2))
      schedule()
    }
    density = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    density.addEventListener('change', densityChanged)

    const gate = (reason: string, held: boolean) => {
      if (held) created.pause(reason)
      else created.resume(reason)
    }
    const hidden = () => {
      gate('hidden', document.visibilityState === 'hidden')
    }
    document.addEventListener('visibilitychange', hidden)
    hidden()
    // A window in the background is not being looked at.
    const blurred = () => {
      gate('blur', true)
    }
    const focused = () => {
      gate('blur', false)
    }
    window.addEventListener('blur', blurred)
    window.addEventListener('focus', focused)
    gate('blur', !document.hasFocus())
    const unwatchStream = watchStreaming(streaming => {
      gate('streaming', streaming)
    })
    gate('streaming', streamingInView())
    const motion = () => {
      gate('reduced', !motionAllowed())
      gate('capture', captureStill())
    }
    const unwatchMotion = watchMotion(motion)
    motion()
    // A change of theme changes the ink.
    const theme = new MutationObserver(schedule)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const scheme = matchMedia('(prefers-color-scheme: dark)')
    scheme.addEventListener('change', schedule)
    const unwatchPower = watchLowPower(low => {
      gate('power', low)
    })
    schedule()

    return () => {
      cancelAnimationFrame(frame)
      sizes.disconnect()
      marks.disconnect()
      theme.disconnect()
      scheme.removeEventListener('change', schedule)
      density?.removeEventListener('change', densityChanged)
      window.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      window.removeEventListener('blur', blurred)
      window.removeEventListener('focus', focused)
      document.removeEventListener('visibilitychange', hidden)
      unwatchStream()
      unwatchMotion()
      unwatchPower()
      created.destroy()
      engine.current = null
      remeasure.current = () => {}
      stats.current?.(null)
    }
  }, [kind, level])

  useEffect(() => {
    engine.current?.setRunning(running)
  }, [running])

  useEffect(() => {
    if (!focus) engine.current?.setFocus(null)
    // Where the input is gets read on the next frame, never inside the keystroke that moved the focus.
    else remeasure.current()
  }, [focus, focusTarget])

  // Only a new id is a new ring: the point is read when the id changes.
  const ring = resolved?.id
  const point = useRef(resolved)
  useLayoutEffect(() => {
    point.current = resolved
  })
  useEffect(() => {
    const at = point.current
    if (ring === undefined || !at) return
    const { x, y } = toCanvas.current(at.x, at.y)
    engine.current?.ripple(x, y)
  }, [ring])

  if (level === 'off') return null
  return (
    <canvas ref={canvas} className={cx('ui-backdrop', className)} data-kind={kind} data-fixed={fixed ? '' : undefined} aria-hidden="true" />
  )
}
