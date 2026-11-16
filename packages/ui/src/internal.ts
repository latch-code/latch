import { useCallback, useRef, useSyncExternalStore, type Ref, type RefCallback } from 'react'

declare module 'react' {
  // Components pass their geometry to their stylesheet as custom properties (--count, --index, --progress).
  interface CSSProperties {
    [variable: `--${string}`]: string | number | undefined
  }
}

/** Joins the class names that are set. */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ')
}

/** One callback ref that feeds every given ref, so a component can keep its own ref and still pass the caller's on. */
export function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return value => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(value)
      else if (ref) ref.current = value
    }
  }
}

/** Phones (below 768px): popovers, menus, pickers and suggestions become bottom sheets there. */
export const PHONE_QUERY = '(max-width: 767.98px)'

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      const list = matchMedia(query)
      list.addEventListener('change', notify)
      return () => {
        list.removeEventListener('change', notify)
      }
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => matchMedia(query).matches,
    () => false,
  )
}

export type Orientation = 'horizontal' | 'vertical'

/**
 * Where a key moves the focus in a one-dimensional group (arrows wrap, Home and End go to the ends), skipping the
 * items `usable` rejects; undefined for any other key or when no item is usable.
 */
export function nextIndex(
  key: string,
  current: number,
  count: number,
  orientation: Orientation,
  usable: (index: number) => boolean,
): number | undefined {
  const forward = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
  const backward = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
  if (key === 'Home' || key === 'End') {
    const step = key === 'Home' ? 1 : -1
    for (let index = key === 'Home' ? 0 : count - 1; index >= 0 && index < count; index += step) if (usable(index)) return index
    return undefined
  }
  if (key !== forward && key !== backward) return undefined
  const step = key === forward ? 1 : -1
  for (let offset = 1; offset <= count; offset++) {
    const index = (((current + step * offset) % count) + count) % count
    if (usable(index)) return index
  }
  return undefined
}

/**
 * Typeahead for lists: printable keys typed within half a second form a prefix, and the next item (from `from`,
 * wrapping) whose label starts with it is returned. A space only extends a prefix already being typed, so on its own
 * it still activates the focused item.
 */
export function useTypeahead(): (key: string, labels: readonly string[], from: number) => number | undefined {
  const buffer = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  return useCallback((key, labels, from) => {
    if (key.length !== 1 || (key === ' ' && buffer.current === '')) return undefined
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      buffer.current = ''
    }, 500)
    buffer.current += key.toLocaleLowerCase()
    const prefix = buffer.current
    // A repeated single letter cycles through the items that start with it.
    const repeated = prefix.length > 1 && Array.from(prefix).every(letter => letter === prefix[0])
    const start = prefix.length === 1 || repeated ? from + 1 : from
    for (let offset = 0; offset < labels.length; offset++) {
      const index = (start + offset) % labels.length
      const label = labels[index]?.toLocaleLowerCase() ?? ''
      if (label.startsWith(repeated ? prefix.slice(0, 1) : prefix)) return index
    }
    return undefined
  }, [])
}

export interface AnchorOptions {
  /** Which edge of the trigger the layer lines up with: the start (left) or the end (right). */
  align: 'start' | 'end' | 'center'
  /** Preferred side; the layer flips when the other side has more room. `auto` opens toward the side with more room. */
  side: 'bottom' | 'top' | 'auto'
  gap: number
  /** Scrolls within past this height. */
  maxHeight?: number
  /**
   * The layer's own width (the default), the trigger's (a suggestion list under its input), or the whole visible
   * window's, edge to edge (the same list drawn as a sheet on a phone).
   */
  width?: 'own' | 'anchor' | 'window'
}

/** Keeps a layer 8px inside the window. */
const WINDOW_MARGIN = 8

/**
 * Which side of its trigger a layer `height` tall goes: the preferred side when it fits there whole, else the other
 * side when it fits there whole, else the preferred side unless that has less than 240 (or the layer's height) and the
 * other side has more. Exported for its test.
 */
export function layerSide(height: number, above: number, below: number, side: 'bottom' | 'top'): 'bottom' | 'top' {
  const [preferred, other] = side === 'top' ? [above, below] : [below, above]
  const flip = side === 'top' ? 'bottom' : 'top'
  if (height <= preferred) return side
  if (height <= other) return flip
  return preferred < Math.min(height, 240) && other > preferred ? flip : side
}

/** The part of the window the person sees: on a phone with the keyboard up, the visual viewport above it. */
function visibleWindow(): { top: number; left: number; width: number; height: number } {
  const viewport = window.visualViewport
  return viewport
    ? { top: viewport.offsetTop, left: viewport.offsetLeft, width: viewport.width, height: viewport.height }
    : { top: 0, left: 0, width: innerWidth, height: innerHeight }
}

/**
 * The one placement routine of every layer pinned to a trigger (menus, pickers, popovers, suggestions, tooltips).
 * Places `layer` (a fixed-position element, usually in the top layer) next to `anchor` now, on every resize or scroll
 * of the window or its visible part, and whenever the layer itself changes size (its content turns into a taller panel,
 * or it widens), until the returned function is called. It writes the position straight onto the element and sets
 * `data-side` to the side it chose and `data-align` to the edge it lines up with, which the entrance reads to grow out
 * of the trigger's corner. Collisions: it flips to the side with room, slides along the edge to stay 8px inside the
 * window, and a layer taller than the room on its side keeps inside with a max-height and scrolls within. Call it once
 * the layer is shown: a hidden layer has no size. When it is no longer called the layer stays where it was, so a
 * closing layer fades out in place.
 */
export function pinLayer(
  anchor: Element | PointAnchor,
  layer: HTMLElement,
  { align, side, gap, maxHeight = Infinity, width: sizing = 'own' }: AnchorOptions,
): () => void {
  // Once placed, the layer prefers the side it is on, so content that changes height does not make it jump across.
  const box = anchor.getBoundingClientRect()
  const start = visibleWindow()
  let chosen: 'bottom' | 'top' = side !== 'auto' ? side : box.top - start.top > start.top + start.height - box.bottom ? 'top' : 'bottom'
  const place = () => {
    const target = anchor.getBoundingClientRect()
    const view = visibleWindow()
    const margin = sizing === 'window' ? 0 : WINDOW_MARGIN
    if (sizing === 'anchor') layer.style.width = `${Math.min(target.width, Math.max(0, view.width - 2 * WINDOW_MARGIN))}px`
    else if (sizing === 'window') layer.style.width = `${view.width}px`
    // The whole height, past any max-height it has now: a layer that scrolls in a list of its own reports only the
    // clamped height while clamped, so the clamp comes off for the measurement.
    const clamp = layer.style.maxHeight
    if (clamp) layer.style.maxHeight = ''
    const height = layer.scrollHeight
    layer.style.maxHeight = clamp
    const width = layer.offsetWidth
    const below = view.top + view.height - target.bottom - gap - WINDOW_MARGIN
    const above = target.top - view.top - gap - WINDOW_MARGIN
    chosen = layerSide(height, above, below, chosen)
    const up = chosen === 'top'
    const room = Math.min(maxHeight, Math.max(120, up ? above : below))
    const top = up ? target.top - gap - Math.min(height, room) : target.bottom + gap
    const preferred = align === 'end' ? target.right - width : align === 'center' ? target.left + (target.width - width) / 2 : target.left
    const left = Math.min(Math.max(view.left + margin, preferred), Math.max(view.left + margin, view.left + view.width - width - margin))
    layer.style.top = `${Math.round(top)}px`
    layer.style.left = `${Math.round(left)}px`
    layer.style.maxHeight = height > room ? `${Math.floor(room)}px` : ''
    layer.dataset.side = up ? 'top' : 'bottom'
    layer.dataset.align = align
  }
  place()
  pinnedLayers.set(layer, place)
  addEventListener('resize', place)
  // A scroll that moves the trigger moves the layer with it; one elsewhere (inside the layer) leaves both in place.
  const scrolled = (event: Event) => {
    if (anchor instanceof Element && event.target instanceof Node && event.target.contains(anchor)) place()
  }
  addEventListener('scroll', scrolled, true)
  window.visualViewport?.addEventListener('resize', place)
  window.visualViewport?.addEventListener('scroll', place)
  // What the layer holds, not the layer: placing changes only the layer's own box (its max-height), which is not
  // watched, so a placement never reports itself back. Content swapped in is watched from its first report.
  // A frame later: placing can resize what is watched (a list as wide as its input), which must not loop back at once.
  let frame = 0
  const resized = new ResizeObserver(() => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(place)
  })
  if (sizing === 'anchor' && anchor instanceof Element) resized.observe(anchor)
  const watch = () => {
    for (const child of layer.children) resized.observe(child)
  }
  watch()
  const swapped = new MutationObserver(watch)
  swapped.observe(layer, { childList: true })
  return () => {
    if (pinnedLayers.get(layer) === place) pinnedLayers.delete(layer)
    removeEventListener('resize', place)
    removeEventListener('scroll', scrolled, true)
    window.visualViewport?.removeEventListener('resize', place)
    window.visualViewport?.removeEventListener('scroll', place)
    cancelAnimationFrame(frame)
    resized.disconnect()
    swapped.disconnect()
  }
}

/** Where a layer opened at the pointer stands: a zero-size box at that point (a context menu). */
export interface PointAnchor {
  getBoundingClientRect(): DOMRect
}
export const pointAnchor = (x: number, y: number): PointAnchor => ({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) })

const pinnedLayers = new WeakMap<Element, () => void>()

/** Keep an open layer with a trigger whose surface moved without a resize. */
export function repositionPinnedLayers(surface: Element): void {
  for (const layer of surface.querySelectorAll(':popover-open:not([role="tooltip"])')) pinnedLayers.get(layer)?.()
}

/**
 * Calls `onMove` when a scroll moves `anchor` by a pixel or more from where it was when this was called (the moment a
 * layer pinned to it opened), until the returned function is called. A scroll elsewhere (the transcript following a
 * stream) leaves the anchor in place. So does a scroll that happened as the layer opened, such as focus or a click
 * scrolling an off-screen trigger into view: the browser reports it a frame later, after the anchor has settled.
 */
export function onAnchorScrolled(anchor: Element, onMove: () => void): () => void {
  const origin = anchor.getBoundingClientRect()
  const scroll = (event: Event) => {
    // Only a scroll of the page or of a container around the anchor can move it.
    if (!(event.target instanceof Node) || !event.target.contains(anchor)) return
    const now = anchor.getBoundingClientRect()
    if (Math.abs(now.top - origin.top) >= 1 || Math.abs(now.left - origin.left) >= 1) onMove()
  }
  addEventListener('scroll', scroll, true)
  return () => {
    removeEventListener('scroll', scroll, true)
  }
}

/** Shows or hides an element with the popover attribute, tolerating a call in the state it is already in. */
export function setPopover(element: HTMLElement | null, open: boolean): void {
  if (!element) return
  const shown = element.matches(':popover-open')
  if (open && !shown) element.showPopover()
  else if (!open && shown) element.hidePopover()
}

/**
 * Descendants that Tab reaches, in document order: not disabled, not hidden, and not taken out of the Tab order with
 * tabindex -1 (the items of a menu, the rows of a radio group other than its one tab stop).
 */
export function focusables(container: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]'
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    element => element.tabIndex >= 0 && element.getClientRects().length > 0,
  )
}

/** The first control a layer should hand focus to on opening: never its close button, which only ends it. */
export function firstMeaningful(container: HTMLElement): HTMLElement | null {
  const controls = Array.from(
    container.querySelectorAll<HTMLElement>('[data-autofocus], a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
  ).filter(element => !element.closest('[data-layer-close]') && !element.matches(':disabled') && element.getClientRects().length > 0)
  return controls.find(element => element.hasAttribute('data-autofocus')) ?? controls[0] ?? null
}
