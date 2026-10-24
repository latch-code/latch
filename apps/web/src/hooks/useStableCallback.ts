import { useCallback, useLayoutEffect, useRef } from 'react'

/** A callback with a stable identity that always runs the latest render's function, so memoized rows do not re-render. */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}
