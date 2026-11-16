import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

/** What makes a page frame inert: a security surface, a dialog, the approval drawer or a toast the shell shows. */
const COVERS = '[data-secure], dialog[open], .ui-toast'

interface Surface {
  closest(selector: string): unknown
  getClientRects(): { length: number }
}

/**
 * Whether the shell shows a security surface, a dialog or a toast right now. One behind an inert part of the shell (the
 * conversation under a page, say) is not on screen and does not count. A settings preview is inside its settings dialog,
 * which is already its focus boundary. Other open dialogs and security surfaces still cover the preview.
 */
export function secureSurfaceOpen(root: { querySelectorAll(selector: string): Iterable<Surface> }, preview?: Surface | null): boolean {
  if (preview?.closest('[inert]')) return true
  const settings = preview?.closest('dialog.settings-overlay[open]:not([data-secure])')
  for (const element of root.querySelectorAll(COVERS)) {
    if (element !== settings && !element.closest('[inert]') && element.getClientRects().length > 0) return true
  }
  return false
}

/**
 * Tracks `secureSurfaceOpen` over the whole document. While it is true the page frame is inert: the page cannot take
 * the focus, a click or a key from an approval, a confirmation or a toast drawn over or beside it.
 */
export function useSecureCover(preview?: RefObject<HTMLElement | null>): boolean {
  const [covered, setCovered] = useState(() => secureSurfaceOpen(document))
  useEffect(() => {
    const measure = () => {
      setCovered(secureSurfaceOpen(document, preview?.current))
    }
    // Measured as the change lands, before the next paint: the frame is inert before the surface can be reached.
    const observer = new MutationObserver(measure)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open', 'data-secure', 'class', 'inert', 'hidden'],
    })
    measure()
    return () => {
      observer.disconnect()
    }
  }, [preview])
  return covered
}
