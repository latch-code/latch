import { useEffect, useLayoutEffect, useRef } from 'react'
import type { OpenLayer } from '@latch/ui'

/**
 * Phones stack their pages and sheets; each open one holds an entry of the browser's history, so the platform's back
 * (the Android back button, the iOS edge swipe, the browser's back) closes the top one instead of leaving Latch. The
 * entries carry their depth in `history.state`. A workspace page may also give its entry a URL.
 *
 * - Opening a layer pushes an entry, unless the entry the page is on is held by no open layer (a reload, or a layer that
 *   has just closed): the new layer takes that one, so entries never pile up.
 * - Going back closes every layer above the entry reached, the top one first. Entries no layer holds any more (left by
 *   a reload, or reached going forward) are skipped on the way.
 * - A layer closed on the page (取消, its back button, a choice) gives its entry back: the page goes back over the
 *   entries above the highest open layer in one traversal. A layer that opens while that traversal is on its way takes
 *   its entry once it lands, so the traversal never closes it.
 */

/** What the stack needs of the browser's session history. */
export interface SessionHistory {
  readonly state: unknown
  pushState: (state: unknown, unused: string, url?: string) => void
  replaceState: (state: unknown, unused: string, url?: string) => void
  go: (delta: number) => void
}

interface Layer {
  /** The depth of its entry; null while it waits for the page's own traversal to land. */
  depth: number | null
  /** `instant`: the browser has already drawn the way back (its own swipe), so the page does not animate it again. */
  close: (instant: boolean) => void
  url?: string | undefined
}

const KEY = 'latchLayer'
/** How long the page waits for its own traversal to land before it reads where it is. */
const LANDING_MS = 1000

const depthOf = (state: unknown): number => {
  const depth: unknown = typeof state === 'object' && state !== null ? Reflect.get(state, KEY) : undefined
  return typeof depth === 'number' && Number.isInteger(depth) && depth > 0 ? depth : 0
}

export class BackStack {
  private readonly layers: Layer[] = []
  /** The depth of the entry the page is on: 0 for the one it loaded on, or any it does not know. */
  private depth: number
  /** The page has gone back over entries no layer holds; it has not landed yet. */
  private traversing = false
  private scheduled = false
  private landing: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly history: SessionHistory) {
    this.depth = depthOf(history.state)
  }

  /** A layer opens with the way to close it; the call returned says it has closed some other way. */
  open(close: (instant: boolean) => void, url?: string): () => void {
    const layer: Layer = { depth: null, close, url }
    this.layers.push(layer)
    if (!this.traversing) this.place(layer)
    return () => {
      this.release(layer)
    }
  }

  /** The browser moved to another entry (popstate); `visual` when it drew the move itself. */
  moved(state: unknown, visual: boolean): void {
    this.depth = depthOf(state)
    if (this.traversing) {
      this.land()
      return
    }
    for (let index = this.layers.length - 1; index >= 0; index--) {
      const layer = this.layers[index]
      if (layer.depth !== null && layer.depth <= this.depth) continue
      this.layers.splice(index, 1)
      layer.close(visual)
    }
    const top = this.top()
    if (this.depth > top) this.traverse(top - this.depth)
  }

  /** The depth of the highest layer that holds an entry. */
  private top(): number {
    for (let index = this.layers.length - 1; index >= 0; index--) {
      const depth = this.layers[index].depth
      if (depth !== null) return depth
    }
    return 0
  }

  private place(layer: Layer): void {
    try {
      if (this.depth > this.top()) {
        if (layer.url !== undefined) this.history.replaceState(this.history.state, '', layer.url)
      } else {
        this.history.pushState({ [KEY]: this.depth + 1 }, '', layer.url)
        this.depth += 1
      }
    } catch {
      // The browser refused another entry (too many in a short time): the layer shares the one it is on.
    }
    layer.depth = this.depth
  }

  private release(layer: Layer): void {
    const index = this.layers.indexOf(layer)
    // Gone already: it closed because the person went back.
    if (index < 0) return
    this.layers.splice(index, 1)
    if (this.scheduled) return
    this.scheduled = true
    // Whatever else the same change closes and opens settles first, so one traversal covers it all.
    queueMicrotask(() => {
      this.scheduled = false
      this.settle()
    })
  }

  /** Goes back over the entries above the highest open layer, if there are any. */
  private settle(): void {
    if (this.traversing) return
    const top = this.top()
    if (this.depth > top) this.traverse(top - this.depth)
  }

  private traverse(delta: number): void {
    this.traversing = true
    this.history.go(delta)
    clearTimeout(this.landing)
    // Should the traversal never report back, the page reads where it is and carries on.
    this.landing = setTimeout(() => {
      if (!this.traversing) return
      this.depth = depthOf(this.history.state)
      this.land()
    }, LANDING_MS)
  }

  /** The page's own traversal has landed: the layers that opened meanwhile take their entries now. */
  private land(): void {
    this.traversing = false
    clearTimeout(this.landing)
    for (const layer of this.layers) {
      if (layer.depth !== null && layer.depth <= this.depth) continue
      layer.depth = null
      this.place(layer)
    }
    this.settle()
  }
}

let shared: BackStack | null = null
/** The page's one stack, listening to the browser from its first use. */
function backStack(): BackStack {
  if (shared) return shared
  const stack = new BackStack(history)
  addEventListener('popstate', event => {
    stack.moved(event.state, event.hasUAVisualTransition)
  })
  shared = stack
  return stack
}

/** How a sheet of the design system takes its place in the stack (`LayerHistory`). */
export const openLayer: OpenLayer = close =>
  backStack().open(() => {
    close()
  })

/** While `open`, a page holds its place in the stack; going back to before it calls `close`. */
export function useBackLayer(open: boolean, close: (instant: boolean) => void, url?: string): void {
  const latest = useRef(close)
  useLayoutEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    if (!open) return undefined
    return backStack().open(instant => {
      latest.current(instant)
    }, url)
  }, [open, url])
}
