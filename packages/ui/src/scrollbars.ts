const SCROLLING = 'ui-scrolling'
const IDLE_MS = 900

/**
 * Scrollbar thumbs stay invisible until their element scrolls (scrollbar.css). A scrolled element keeps its thumb while
 * the pointer is over it and loses it once the pointer leaves, or after a short idle when the pointer is elsewhere.
 */
export function revealScrollbarsWhileScrolling(): () => void {
  const timers = new Map<Element, number>()
  const hide = (el: Element) => {
    timers.delete(el)
    if (el.matches(':hover')) {
      el.addEventListener('pointerleave', () => el.classList.remove(SCROLLING), { once: true })
      return
    }
    el.classList.remove(SCROLLING)
  }
  const onScroll = (event: Event) => {
    const target = event.target
    const el = target instanceof Document ? target.scrollingElement : target
    if (!(el instanceof Element)) return
    el.classList.add(SCROLLING)
    const pending = timers.get(el)
    if (pending !== undefined) clearTimeout(pending)
    timers.set(
      el,
      window.setTimeout(() => hide(el), IDLE_MS),
    )
  }
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => {
    document.removeEventListener('scroll', onScroll, { capture: true })
    for (const [el, timer] of timers) {
      clearTimeout(timer)
      el.classList.remove(SCROLLING)
    }
    timers.clear()
  }
}
