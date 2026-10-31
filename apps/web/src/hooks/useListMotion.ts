import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { EASING, MOTION } from '@latch/ui'

/** How long a leaving row takes to fold away (--m-micro in the stylesheets, plus a frame). */
const LEAVE_MS = MOTION.micro + 20

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Motion for a list the Host reorders: a row that moves slides from where it was and a row that arrives fades in while
 * the rows it pushes slide down, both over --m-enter. Each `[data-flip-id]` element is measured against its scope (the nearest
 * `[data-flip-scope]` above it, else the list), so a row that moves with its group does not slide twice. Measures again
 * whenever `signature` (the rendered order) changes. A change of `context` (a new filter or search) and the first render
 * only measure: the list is redrawn, not moved. Rows never move while reduced motion is on.
 */
export function useListMotion(root: RefObject<HTMLElement | null>, context: string, signature: string): () => void {
  const positions = useRef<{ context: string; signature: string; tops: Map<string, number> } | null>(null)
  useLayoutEffect(() => {
    const last = positions.current
    if (last?.context === context && last.signature === signature) return
    const previous = last?.context === context && !reducedMotion() ? last.tops : null
    positions.current = { context, signature, tops: measureRows(root.current, previous) }
  }, [root, context, signature])
  // Rows that folded away left the others where they already are: measure again without moving anything.
  return useCallback(() => {
    const last = positions.current
    if (last) positions.current = { ...last, tops: measureRows(root.current, null) }
  }, [root])
}

/** Where each row stands in its scope; with the positions from before, the rows that moved slide from there. */
function measureRows(container: HTMLElement | null, previous: Map<string, number> | null): Map<string, number> {
  const tops = new Map<string, number>()
  if (!container) return tops
  const containerTop = container.getBoundingClientRect().top - container.scrollTop
  for (const element of container.querySelectorAll<HTMLElement>('[data-flip-id]')) {
    const scope = element.parentElement?.closest<HTMLElement>('[data-flip-scope]')
    const top = element.getBoundingClientRect().top - (scope ? scope.getBoundingClientRect().top : containerTop)
    const id = element.dataset.flipId ?? ''
    tops.set(id, top)
    if (previous === null) continue
    const before = previous.get(id)
    if (before === undefined) element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.enter, easing: EASING.enter })
    else if (Math.abs(before - top) >= 1)
      element.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], {
        duration: MOTION.enter,
        easing: EASING.enter,
      })
  }
  return tops
}

/**
 * Keeps items that left the list for one fold (--m-micro) at the place they had, marked `leaving`, so the list can fold
 * them away instead of dropping them; `settled` runs once they are gone. When `context` changed (a filter or search)
 * they go at once.
 */
export function usePresence<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  context: string,
  settled?: () => void,
): Array<{ item: T; leaving: boolean }> {
  const [state, setState] = useState<{ items: readonly T[]; context: string; leaving: Array<{ item: T; index: number }> }>({
    items,
    context,
    leaving: [],
  })
  let current = state
  if (state.items !== items || state.context !== context) {
    const keys = new Set(items.map(keyOf))
    const gone =
      state.context === context && !reducedMotion()
        ? state.items.flatMap((item, index) => (keys.has(keyOf(item)) ? [] : [{ item, index }]))
        : []
    const kept = state.context === context ? state.leaving.filter(entry => !keys.has(keyOf(entry.item))) : []
    current = { items, context, leaving: [...kept, ...gone] }
    setState(current)
  }
  useEffect(() => {
    if (state.leaving.length === 0) return undefined
    const timer = setTimeout(() => {
      setState(previous => ({ ...previous, leaving: [] }))
    }, LEAVE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [state.leaving])
  const hadLeaving = useRef(false)
  useLayoutEffect(() => {
    if (hadLeaving.current && state.leaving.length === 0) settled?.()
    hadLeaving.current = state.leaving.length > 0
  }, [state.leaving, settled])
  const merged: Array<{ item: T; leaving: boolean }> = current.items.map(item => ({ item, leaving: false }))
  for (const entry of current.leaving.toSorted((a, b) => a.index - b.index))
    merged.splice(Math.min(entry.index, merged.length), 0, { item: entry.item, leaving: true })
  return merged
}
