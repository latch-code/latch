import { useEffect, useState, type RefObject } from 'react'

/** Far enough ahead of a scroll that a block is coloured before it arrives. */
const AHEAD = '800px 0px'

/**
 * The nearest ancestor that scrolls. An observer's margin applies only to its own root, and a scroller between the
 * element and an implicit root clips the margin away.
 */
function scrollParent(element: Element): Element | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/^(?:auto|scroll)$/u.test(getComputedStyle(parent).overflowY)) return parent
  }
  return null
}

const observers = new Map<Element | null, { observer: IntersectionObserver; waiting: Map<Element, () => void> }>()

function onceSeen(element: Element, seen: () => void): () => void {
  const root = scrollParent(element)
  let entry = observers.get(root)
  if (!entry) {
    const waiting = new Map<Element, () => void>()
    const observer = new IntersectionObserver(
      changes => {
        for (const change of changes) {
          if (!change.isIntersecting) continue
          observer.unobserve(change.target)
          const run = waiting.get(change.target)
          waiting.delete(change.target)
          run?.()
        }
      },
      { root, rootMargin: AHEAD },
    )
    entry = { observer, waiting }
    observers.set(root, entry)
  }
  const { observer, waiting } = entry
  waiting.set(element, seen)
  observer.observe(element)
  return () => {
    waiting.delete(element)
    observer.unobserve(element)
    if (waiting.size === 0) {
      observer.disconnect()
      observers.delete(root)
    }
  }
}

/** Whether the element has come near the view; it stays true once it has. */
export function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (seen || !ref.current) return
    return onceSeen(ref.current, () => {
      setSeen(true)
    })
  }, [seen, ref])
  return seen
}
