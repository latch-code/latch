import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EASING, MOTION, captureStill, motionAllowed, repositionPinnedLayers, watchMotion } from '@latch/ui'

export const HOME_FOCUS_LAYER = ':popover-open:not([role="tooltip"]), dialog[open]'

export function useHomeFocus() {
  const [active, setActive] = useState(false)
  const requested = useRef(false)
  const slot = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLDivElement>(null)
  const from = useRef<DOMRect | undefined>(undefined)
  const move = useRef<Animation | undefined>(undefined)

  const change = useCallback((next: boolean, animate: boolean) => {
    if (requested.current === next) return
    const input = composer.current?.querySelector('textarea')
    if (next && input?.disabled) return
    requested.current = next
    const movable =
      animate
      && input
      && motionAllowed()
      && !captureStill()
      && innerWidth >= 768
      && innerHeight >= 480
      && !input.hasAttribute('aria-controls')
      && !composer.current?.querySelector(`[data-secure], ${HOME_FOCUS_LAYER}`)
    from.current = movable ? composer.current?.getBoundingClientRect() : undefined
    move.current?.cancel()
    // Keep the retained queue's viewport fixed while the same composer leaves its normal position.
    if (next && slot.current) slot.current.style.minHeight = `${slot.current.offsetHeight}px`
    else slot.current?.style.removeProperty('min-height')
    setActive(next)
  }, [])

  useLayoutEffect(() => {
    const first = from.current
    from.current = undefined
    const element = composer.current
    if (!element) return
    if (element.querySelector(HOME_FOCUS_LAYER)) {
      repositionPinnedLayers(element)
      return
    }
    if (!first || !motionAllowed() || captureStill() || element.querySelector('textarea[aria-controls], [data-secure]')) return
    const last = element.getBoundingClientRect()
    const x = first.left + first.width / 2 - last.left - last.width / 2
    const y = first.top - last.top
    if (!last.width || !last.height || (!x && !y)) return
    move.current = element.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'none' }], {
      duration: active ? MOTION.sheet : MOTION.sheetExit,
      easing: EASING.settle,
    })
  }, [active])

  useEffect(() => {
    const unwatch = watchMotion(() => {
      if (!motionAllowed() || captureStill()) move.current?.cancel()
    })
    return () => {
      unwatch()
      move.current?.cancel()
    }
  }, [])

  return {
    active,
    slot,
    frame,
    composer,
    enter: useCallback(() => change(true, true), [change]),
    leave: useCallback(() => change(false, true), [change]),
    reset: useCallback(() => change(false, false), [change]),
  }
}
