import { useSyncExternalStore } from 'react'

/**
 * Layout breakpoints in CSS pixels. The stylesheets under `styles/` use the same
 * numbers in their media queries (CSS cannot read these constants).
 */
export const BREAKPOINTS = { md: 768, lg: 1024, xl: 1280 } as const

/** phone < 768 ≤ tablet < 1024 ≤ laptop < 1280 ≤ desktop */
export type Viewport = 'phone' | 'tablet' | 'laptop' | 'desktop'

export function viewportFor(width: number): Viewport {
  if (width < BREAKPOINTS.md) return 'phone'
  if (width < BREAKPOINTS.lg) return 'tablet'
  if (width < BREAKPOINTS.xl) return 'laptop'
  return 'desktop'
}

/** Below `lg` the session list is a slide-over drawer. */
export const usesDrawer = (viewport: Viewport) => viewport === 'phone' || viewport === 'tablet'

const queries = [`(min-width: ${BREAKPOINTS.md}px)`, `(min-width: ${BREAKPOINTS.lg}px)`, `(min-width: ${BREAKPOINTS.xl}px)`]

function subscribeTo(list: string[]) {
  return (changed: () => void) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {}
    const media = list.map(query => window.matchMedia(query))
    for (const item of media) item.addEventListener('change', changed)
    return () => {
      for (const item of media) item.removeEventListener('change', changed)
    }
  }
}

const subscribeViewport = subscribeTo(queries)
function currentViewport(): Viewport {
  if (typeof window === 'undefined' || !window.matchMedia) return 'desktop'
  const [md, lg, xl] = queries.map(query => window.matchMedia(query).matches)
  return xl ? 'desktop' : lg ? 'laptop' : md ? 'tablet' : 'phone'
}

export function useViewport(): Viewport {
  return useSyncExternalStore(subscribeViewport, currentViewport, () => 'desktop')
}

const coarseQuery = '(pointer: coarse)'
const subscribeCoarse = subscribeTo([coarseQuery])
const currentCoarse = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(coarseQuery).matches

/** Touch-first devices: Enter inserts a newline and hover-only controls stay visible. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribeCoarse, currentCoarse, () => false)
}

function subscribeWidth(changed: () => void) {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('resize', changed)
  return () => {
    window.removeEventListener('resize', changed)
  }
}

/** The window's width in CSS pixels, for layouts that clamp a column against it. */
export function useWindowWidth(): number {
  return useSyncExternalStore(
    subscribeWidth,
    () => (typeof window === 'undefined' ? 1440 : window.innerWidth),
    () => 1440,
  )
}
