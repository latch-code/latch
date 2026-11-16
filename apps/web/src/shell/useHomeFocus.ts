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
    const element = composer.current
    const input = element?.querySelector('textarea')
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
      && !element?.querySelector(`[data-secure], ${HOME_FOCUS_LAYER}`)
    from.current = movable ? element?.getBoundingClientRect() : undefined
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
    if (
      !first?.width
      || !first.height
      || !motionAllowed()
      || captureStill()
      || element.querySelector('textarea[aria-controls], [data-secure]')
    )
      return
    const last = element.getBoundingClientRect()
    const x = first.left + first.width / 2 - last.left - last.width / 2
    const y = first.top - last.top
    if (!last.width || !last.height) return
    const width = first.width / last.width
    const height = first.height / last.height
    if (!x && !y && width === 1 && height === 1) return
    const parent = slot.current
    // Returning to the dock starts above its scroll box, so keep the moving card visible until it lands.
    if (parent) parent.dataset.focusMoving = ''
    const animation = element.animate(
      [
        { transform: `translate(${x}px, ${y}px) scale(${width}, ${height})`, transformOrigin: 'center top' },
        { transform: 'none', transformOrigin: 'center top' },
      ],
      { duration: active ? MOTION.sheet : MOTION.sheetExit, easing: EASING.settle },
    )
    move.current = animation
    const settle = () => {
      if (move.current !== animation) return
      move.current = undefined
      if (parent) delete parent.dataset.focusMoving
      if (element.isConnected) repositionPinnedLayers(element)
    }
    void animation.finished.then(settle, settle)
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
