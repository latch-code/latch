import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Below the drawer breakpoint the session list is a modal slide-over: the rest of
 * the shell is inert while it is open, focus stays inside, and Escape returns
 * focus to the opener. Dialogs and popovers opened above it handle their own keys.
 */
export function useDrawer({
  enabled,
  navigation,
  inertWhenOpen,
  shut = false,
}: {
  enabled: boolean
  navigation: RefObject<HTMLElement | null>
  inertWhenOpen: Array<{ ref: RefObject<HTMLElement | null>; base?: boolean }>
  /** Wide layouts: the sidebar is collapsed, so it is inert as a closed drawer is. */
  shut?: boolean
}) {
  const [open, setOpen] = useState(false)
  const inertBase = inertWhenOpen.map(target => !!target.base).join(':')
  const initialFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!enabled) setOpen(false)
  }, [enabled])
  /** Opens the drawer, optionally focusing a specific control (e.g. search) instead of the first one. */
  const show = useCallback((focus?: HTMLElement | null) => {
    initialFocus.current = focus ?? null
    setOpen(true)
  }, [])

  useEffect(() => {
    const sidebar = navigation.current
    const others = inertWhenOpen.flatMap(({ ref, base }) => (ref.current ? [{ element: ref.current, base: !!base }] : []))
    const modalOpen = enabled && open
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    for (const { element, base } of others) element.inert = modalOpen || base
    if (sidebar === null) return
    sidebar.inert = enabled ? !open : shut
    if (!modalOpen)
      return () => {
        sidebar.inert = false
        for (const { element, base } of others) element.inert = base
      }

    const focusable = () =>
      Array.from(
        sidebar.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'),
      ).filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible')
    // A visibility transition can still be hidden on its first animation frame.
    // Focus only after the browser makes the drawer focusable; closing cancels it.
    let focusFrame = 0
    const preferred = initialFocus.current
    initialFocus.current = null
    const enterDrawer = () => {
      if (getComputedStyle(sidebar).visibility !== 'visible') {
        focusFrame = requestAnimationFrame(enterDrawer)
        return
      }
      if (preferred?.isConnected && sidebar.contains(preferred)) preferred.focus({ preventScroll: true })
      else if (!sidebar.contains(document.activeElement)) (focusable()[0] ?? sidebar).focus({ preventScroll: true })
    }
    focusFrame = requestAnimationFrame(enterDrawer)
    const keydown = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('dialog, .popover, :popover-open:not([role="tooltip"])')) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const targets = focusable()
      const first = targets[0]
      const last = targets.at(-1)
      if (first === undefined || last === undefined) {
        event.preventDefault()
        sidebar.focus()
        return
      }
      if (!sidebar.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', keydown, true)
    return () => {
      cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', keydown, true)
      sidebar.inert = false
      for (const { element, base } of others) element.inert = base
      if (previousFocus?.isConnected && (sidebar.contains(document.activeElement) || document.activeElement === document.body))
        previousFocus.focus()
    }
    // The refs are stable for the shell's lifetime.
  }, [open, enabled, shut, inertBase])

  return { open, setOpen, show }
}
