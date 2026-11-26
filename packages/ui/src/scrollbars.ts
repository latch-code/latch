import { captureStill, motionAllowed } from './changes.ts'
import { EASING, MOTION } from './motion.tsx'

const SCROLLING = 'ui-scrolling'
const ALPHA = '--ui-scroll-alpha'
const ANIMATION_ID = 'ui-scrollbar'
const IDLE_MS = 700
const FADE_IN_MS = MOTION.press
const FADE_OUT_MS = MOTION.push
/** Overlay scrollbars reserve no layout space. Use the styled track's 10px width only in that case. */
const trackSize = (gutter: number) => (gutter > 0 ? gutter : 10)

let alphaRegistered = false

/** Registers `--ui-scroll-alpha` as an animatable `<number>` so WAAPI can fade `::-webkit-scrollbar-thumb` cleanly. */
function registerAlphaProperty(): boolean {
  if (alphaRegistered) return true
  if (typeof CSS === 'undefined' || typeof CSS.registerProperty !== 'function') return false
  try {
    CSS.registerProperty({
      name: ALPHA,
      syntax: '<number>',
      inherits: true,
      initialValue: '0',
    })
    alphaRegistered = true
  } catch (error) {
    if (error instanceof DOMException && error.name === 'InvalidModificationError') alphaRegistered = true
  }
  return alphaRegistered
}

/** Whether `(x, y)` lies over `el`'s own vertical or horizontal scrollbar strip. */
function pointerOnScrollbar(el: Element, x: number, y: number): boolean {
  if (!el.isConnected) return false
  const hasVertical = el.scrollHeight > el.clientHeight
  const hasHorizontal = el.scrollWidth > el.clientWidth
  if (!hasVertical && !hasHorizontal) return false
  if (el === document.scrollingElement) {
    const vZone = trackSize(window.innerWidth - el.clientWidth)
    const hZone = trackSize(window.innerHeight - el.clientHeight)
    const rtl = getComputedStyle(el).direction === 'rtl'
    const onVertical = hasVertical && (rtl ? x >= 0 && x <= vZone : x >= window.innerWidth - vZone && x <= window.innerWidth)
    const onHorizontal = hasHorizontal && y >= window.innerHeight - hZone && y <= window.innerHeight
    return onVertical || onHorizontal
  }
  const rect = el.getBoundingClientRect()
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false
  const style = getComputedStyle(el)
  const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0
  const borderRight = Number.parseFloat(style.borderRightWidth) || 0
  const borderTop = Number.parseFloat(style.borderTopWidth) || 0
  const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0
  const offsetWidth = el instanceof HTMLElement ? el.offsetWidth : rect.width
  const offsetHeight = el instanceof HTMLElement ? el.offsetHeight : rect.height
  const vZone = trackSize(offsetWidth - el.clientWidth - borderLeft - borderRight)
  const hZone = trackSize(offsetHeight - el.clientHeight - borderTop - borderBottom)
  const onVertical =
    hasVertical
    && (style.direction === 'rtl'
      ? x >= rect.left + borderLeft && x <= rect.left + borderLeft + vZone
      : x >= rect.right - borderRight - vZone && x <= rect.right - borderRight)
  const onHorizontal = hasHorizontal && y >= rect.bottom - borderBottom - hZone && y <= rect.bottom - borderBottom
  return onVertical || onHorizontal
}

/** Reads the element's current animated `--ui-scroll-alpha`, falling back to its steady class state. */
function readAlpha(el: Element): number {
  const raw = Number.parseFloat(getComputedStyle(el).getPropertyValue(ALPHA))
  if (!Number.isFinite(raw)) return el.classList.contains(SCROLLING) ? 1 : 0
  return Math.max(0, Math.min(1, raw))
}

/**
 * Scrollbar thumbs stay invisible until their element scrolls (scrollbar.css). Once scrolling pauses, the thumb fades
 * out smoothly—even while the pointer rests over the element's content—and stays visible only while the pointer is on
 * the scrollbar track itself or dragging the thumb.
 */
export function revealScrollbarsWhileScrolling(): () => void {
  const media = matchMedia('(hover: hover) and (pointer: fine) and (forced-colors: none)')
  let stop: (() => void) | undefined
  const sync = () => {
    stop?.()
    stop = media.matches ? trackScrollbars() : undefined
  }
  sync()
  media.addEventListener('change', sync)
  return () => {
    media.removeEventListener('change', sync)
    stop?.()
  }
}

function trackScrollbars(): () => void {
  const canFade = registerAlphaProperty()
  const timers = new Map<Element, number>()
  const held = new Set<Element>()
  const animations = new Map<Element, { animation: Animation; target: 0 | 1 }>()
  let pointer: { x: number; y: number } | null = null
  let dragging: Element | null = null

  const stopAnimation = (el: Element): number => {
    const running = animations.get(el)
    if (!running) return el.classList.contains(SCROLLING) ? 1 : 0
    const current = readAlpha(el)
    animations.delete(el)
    running.animation.cancel()
    return current
  }

  const playAlpha = (el: Element, from: number, to: 0 | 1, fullDuration: number, easing: string) => {
    if (!canFade || !el.isConnected || typeof el.animate !== 'function') return
    if (!motionAllowed() || captureStill()) return
    const distance = Math.abs(to - from)
    if (distance <= 0.01) return
    const animation = el.animate([{ [ALPHA]: from }, { [ALPHA]: to }], {
      duration: Math.max(16, Math.round(fullDuration * distance)),
      easing,
      id: ANIMATION_ID,
    })
    const entry = { animation, target: to }
    animations.set(el, entry)
    void animation.finished
      .catch(() => {})
      .then(() => {
        if (animations.get(el) === entry) animations.delete(el)
      })
  }

  const reveal = (el: Element) => {
    const running = animations.get(el)
    if (el.classList.contains(SCROLLING) && (!running || running.target === 1)) return
    const from = stopAnimation(el)
    el.classList.add(SCROLLING)
    playAlpha(el, from, 1, FADE_IN_MS, EASING.micro)
  }

  const clearTimer = (el: Element) => {
    const pending = timers.get(el)
    if (pending === undefined) return
    clearTimeout(pending)
    timers.delete(el)
  }

  const reset = (el: Element) => {
    if (dragging === el) dragging = null
    held.delete(el)
    clearTimer(el)
    stopAnimation(el)
    el.classList.remove(SCROLLING)
  }

  const fadeOut = (el: Element) => {
    held.delete(el)
    clearTimer(el)
    const running = animations.get(el)
    if (!el.classList.contains(SCROLLING) && (!running || running.target === 0)) return
    const from = stopAnimation(el)
    el.classList.remove(SCROLLING)
    playAlpha(el, from, 0, FADE_OUT_MS, EASING.panel)
  }

  const hold = (el: Element) => {
    held.add(el)
    // A stationary pointer may get no event when layout moves its track or the element is detached.
    scheduleHide(el)
  }

  const hide = (el: Element) => {
    timers.delete(el)
    if (!el.isConnected) {
      reset(el)
      return
    }
    if (el === dragging || (pointer !== null && pointerOnScrollbar(el, pointer.x, pointer.y))) {
      hold(el)
      return
    }
    fadeOut(el)
  }

  const scheduleHide = (el: Element) => {
    clearTimer(el)
    timers.set(
      el,
      window.setTimeout(() => hide(el), IDLE_MS),
    )
  }

  const onScroll = (event: Event) => {
    const target = event.target
    const el = target instanceof Document ? target.scrollingElement : target
    if (!(el instanceof Element)) return
    reveal(el)
    held.delete(el)
    scheduleHide(el)
  }

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return
    pointer = { x: event.clientX, y: event.clientY }
    if (held.size > 0) {
      for (const el of Array.from(held)) {
        if (!el.isConnected) {
          reset(el)
          continue
        }
        if (el !== dragging && !pointerOnScrollbar(el, pointer.x, pointer.y)) fadeOut(el)
      }
    }
    if (animations.size > 0) {
      for (const [el, entry] of Array.from(animations)) {
        if (entry.target !== 0) continue
        if (!el.isConnected) {
          reset(el)
          continue
        }
        if (pointerOnScrollbar(el, pointer.x, pointer.y)) {
          reveal(el)
          hold(el)
        }
      }
    }
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || event.button !== 0) return
    pointer = { x: event.clientX, y: event.clientY }
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const scroller = target === document.documentElement || target === document.body ? (document.scrollingElement ?? target) : target
    if (pointerOnScrollbar(scroller, pointer.x, pointer.y)) {
      dragging = scroller
      reveal(scroller)
      hold(scroller)
    }
  }

  const releaseDrag = (event?: PointerEvent) => {
    if (event && event.pointerType !== 'touch') pointer = { x: event.clientX, y: event.clientY }
    const el = dragging
    dragging = null
    if (!el) return
    if (!el.isConnected) {
      reset(el)
      return
    }
    held.delete(el)
    scheduleHide(el)
  }

  const onPointerLeave = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return
    const el = event.target
    if (el === document.documentElement) {
      pointer = null
      for (const item of held) if (item !== dragging) fadeOut(item)
    } else if (el instanceof Element && el !== dragging && held.has(el)) {
      // Scrolling an ancestor can move the track away from a stationary pointer.
      fadeOut(el)
    }
  }

  const onWindowBlur = () => {
    pointer = null
    const dragged = dragging
    dragging = null
    if (dragged) held.add(dragged)
    for (const el of Array.from(held)) fadeOut(el)
  }

  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
  document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  document.addEventListener('pointerup', releaseDrag, { capture: true, passive: true })
  document.addEventListener('pointercancel', releaseDrag, { capture: true, passive: true })
  document.addEventListener('pointerleave', onPointerLeave, { capture: true, passive: true })
  window.addEventListener('blur', onWindowBlur, { passive: true })

  return () => {
    document.removeEventListener('scroll', onScroll, { capture: true })
    document.removeEventListener('pointermove', onPointerMove, { capture: true })
    document.removeEventListener('pointerdown', onPointerDown, { capture: true })
    document.removeEventListener('pointerup', releaseDrag, { capture: true })
    document.removeEventListener('pointercancel', releaseDrag, { capture: true })
    document.removeEventListener('pointerleave', onPointerLeave, { capture: true })
    window.removeEventListener('blur', onWindowBlur)
    const tracked = new Set<Element>([...timers.keys(), ...held, ...animations.keys()])
    if (dragging) tracked.add(dragging)
    for (const el of tracked) reset(el)
  }
}
