import { createContext, useContext, useEffect, useLayoutEffect, useState, type RefObject } from 'react'

/**
 * How far the footer has folded, in the order things give way: 1 the branch, 2 the thinking level, 3 Agent, 4 a plain
 * 权限 down to its icon, 5 (under 420) one 「⋯」 for 权限, the branch, usage and other options.
 */
export type FooterFold = 0 | 1 | 2 | 3 | 4 | 5

const NARROW_FOOTER = 420

export const FooterFoldContext = createContext<FooterFold>(0)
export const useFooterFoldLevel = () => useContext(FooterFoldContext)

/** The smallest fold that fits: it measures after each render, before paint, and starts over when the width changes. */
export function useFooterFold(footer: RefObject<HTMLElement | null>): FooterFold {
  const [fold, setFold] = useState<FooterFold>(0)
  useEffect(() => {
    const element = footer.current
    if (!element || typeof ResizeObserver !== 'function') return undefined
    let width = element.clientWidth
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return
      width = element.clientWidth
      setFold(width > 0 && width < NARROW_FOOTER ? 5 : 0)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [footer])
  useLayoutEffect(() => {
    const element = footer.current
    if (!element || element.clientWidth === 0) return
    if (element.clientWidth < NARROW_FOOTER) {
      if (fold !== 5) setFold(5)
    } else if (fold < 4 && element.scrollWidth > element.clientWidth) setFold((fold + 1) as FooterFold)
  })
  return fold
}
