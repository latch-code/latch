import { useLayoutEffect, useRef, type RefObject } from 'react'
import { MOTION } from '@latch/ui'

/** The entry curve of tokens.css (`--ease`). */
const EASE = 'cubic-bezier(0.2, 0, 0, 1)'

const motionAllowed = () => typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: no-preference)').matches

/**
 * Fades the element in over 120ms when the session it shows changes (`key`, null while nothing is shown yet): a switch
 * of session, or a session's record arriving after it loaded. Only opacity moves, so the reading position is untouched;
 * the first render and reduced motion show it at once.
 */
export function useSwitchFade(element: RefObject<HTMLElement | null>, key: string | null): void {
  const shown = useRef(key)
  useLayoutEffect(() => {
    if (shown.current === key) return
    shown.current = key
    const target = element.current
    if (key === null || !target || typeof target.animate !== 'function' || !motionAllowed()) return
    target.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.fast, easing: EASE })
  }, [element, key])
}
