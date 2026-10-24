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

/** Phones (below 768px): menus and pickers become bottom sheets there. */
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
  /** Preferred side; the layer flips when the other side has more room. */
  side: 'bottom' | 'top'
  gap: number
}

/** Keeps a layer 8px inside the window. */
const WINDOW_MARGIN = 8

/**
 * Places `layer` (a fixed-position element, usually in the top layer) next to `anchor` now and on every resize until
 * the returned function is called. It writes the position straight onto the element and sets `data-side` to the side
 * it chose, which the entrance animation reads. Call it once the layer is shown: a hidden layer has no size.
 */
export function pinLayer(anchor: Element, layer: HTMLElement, { align, side, gap }: AnchorOptions): () => void {
  const place = () => {
    const target = anchor.getBoundingClientRect()
    layer.style.maxHeight = ''
    const height = layer.scrollHeight
    const width = layer.offsetWidth
    const below = innerHeight - target.bottom - gap - WINDOW_MARGIN
    const above = target.top - gap - WINDOW_MARGIN
    const needed = Math.min(height, 240)
    const up = side === 'top' ? !(above < needed && below > above) : below < needed && above > below
    const room = Math.max(120, up ? above : below)
    const top = up ? target.top - gap - Math.min(height, room) : target.bottom + gap
    const preferred = align === 'end' ? target.right - width : align === 'center' ? target.left + (target.width - width) / 2 : target.left
    const left = Math.min(Math.max(WINDOW_MARGIN, preferred), Math.max(WINDOW_MARGIN, innerWidth - width - WINDOW_MARGIN))
    layer.style.top = `${Math.round(top)}px`
    layer.style.left = `${Math.round(left)}px`
    if (height > room) layer.style.maxHeight = `${Math.floor(room)}px`
    layer.dataset.side = up ? 'top' : 'bottom'
  }
  place()
  addEventListener('resize', place)
  return () => {
    removeEventListener('resize', place)
  }
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
