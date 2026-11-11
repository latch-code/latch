import { useLayoutEffect, type RefObject } from 'react'

/**
 * A phone page that follows the visible viewport: its height and top track `visualViewport`, so the keyboard never
 * covers the field being typed in or the bar under it. The page's own stylesheet places it (`position: fixed`, 100dvh).
 */
export function useVisualViewportFit(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useLayoutEffect(() => {
    const view = window.visualViewport
    const page = ref.current
    if (!enabled || !view || !page) return undefined
    const fit = () => {
      page.style.height = `${Math.round(view.height)}px`
      page.style.top = `${Math.round(view.offsetTop)}px`
    }
    fit()
    view.addEventListener('resize', fit)
    view.addEventListener('scroll', fit)
    return () => {
      view.removeEventListener('resize', fit)
      view.removeEventListener('scroll', fit)
      page.style.removeProperty('height')
      page.style.removeProperty('top')
    }
  }, [ref, enabled])
}
