import { useLayoutEffect, useRef, type RefObject } from 'react'
import { EASING, MOTION, motionAllowed } from '@latch/ui'

/**
 * Fades the element in over --m-micro when the session it shows changes (`key`, null while nothing is shown yet): a switch
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
    target.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.micro, easing: EASING.micro })
  }, [element, key])
}
