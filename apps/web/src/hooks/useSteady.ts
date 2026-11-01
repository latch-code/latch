import { useEffect, useRef, useState } from 'react'

/** How long to hold what is shown before `next` may replace it: nothing when the last change is at least `gap` old. */
export function steadyHold(lastChange: number, now: number, gap: number): number {
  return Math.max(0, lastChange + gap - now)
}

/**
 * The value, changing at most once per `gap` milliseconds: a run that flips between states faster than that shows the
 * latest one when the gap is over, not every step. `key` says whether two values are the same.
 */
export function useSteady<T>(value: T, key: string, gap = 1000): T {
  const [shown, setShown] = useState({ value, key })
  const lastChange = useRef(0)
  useEffect(() => {
    if (key === shown.key) return undefined
    const hold = steadyHold(lastChange.current, Date.now(), gap)
    const timer = setTimeout(() => {
      lastChange.current = Date.now()
      setShown({ value, key })
    }, hold)
    return () => {
      clearTimeout(timer)
    }
  }, [value, key, shown.key, gap])
  return key === shown.key ? value : shown.value
}
