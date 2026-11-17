import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { HOLD_MS, HOLD_SLOP, pinLayer, setPopover } from './internal.ts'

/** Hovering waits this long before a tooltip appears. */
const HOVER_DELAY = 400
/**
 * After a tooltip hides, another one within this window appears at once and glides from where the last one stood:
 * moving along a toolbar carries one tooltip from button to button.
 */
const WARM_WINDOW = 300
const warm = { until: 0, left: 0, top: 0 }
const isWarm = () => performance.now() < warm.until
const markWarm = (element: HTMLElement) => {
  const box = element.getBoundingClientRect()
  Object.assign(warm, { until: performance.now() + WARM_WINDOW, left: box.left, top: box.top })
}

/**
 * A tooltip on its trigger, the element just before it: the action's name with its shortcut after it (标签 (⌘X)), or why
 * a disabled control cannot be used. It appears after 400ms of hover with a fade from a scale of .98 (--m-enter), at once on
 * keyboard focus, and when the pointer moves on from a neighbour's tooltip it glides there from where that one stood
 * (--m-micro). It goes as soon as the pointer leaves, the trigger is pressed or Escape is pressed. It is inverted (ink
 * on light, a lifted grey on dark), 12/16 with 6px corners, and never takes the pointer. Its text describes the
 * trigger for screen readers unless `describe` is false, as for an icon button whose name is already the same text.
 * Touch has no hover: a press and hold on the trigger shows it (the click that ends the hold does not also press the
 * trigger), and the next touch anywhere or a scroll takes it away. A trigger inside a row whose press and hold opens a
 * menu (`data-context-gesture`) leaves the hold to that menu.
 */
export function Tooltip({
  content,
  shortcut,
  side = 'top',
  describe = true,
  children,
}: {
  /** Nothing to show: the trigger renders alone, in the same place, so adding a tooltip later never remounts it. */
  content: ReactNode | undefined
  shortcut?: string
  side?: 'top' | 'bottom'
  describe?: boolean
  /** One element; the tooltip listens to it and places itself next to it. */
  children: ReactElement
}) {
  const active = content !== undefined
  const id = useId()
  const [open, setOpen] = useState(false)
  const layer = useRef<HTMLSpanElement>(null)
  // Shown because a neighbour's tooltip had just gone: it glides from where that one stood.
  const glide = useRef(false)

  // Shown before it is placed: a hidden popover has no size to measure.
  useLayoutEffect(() => {
    const element = layer.current
    setPopover(element, open)
    const anchor = element?.previousElementSibling
    if (!open || !element || !anchor) return undefined
    if (glide.current) {
      element.dataset.glide = ''
      element.style.left = `${warm.left}px`
      element.style.top = `${warm.top}px`
      // Laid out where the last one stood, so placing it next to its own trigger transitions from there.
      void element.offsetWidth
    }
    const unpin = pinLayer(anchor, element, { align: 'center', side, gap: 6 })
    return () => {
      unpin()
      delete element.dataset.glide
    }
  }, [open, side])

  useEffect(() => {
    const element = layer.current
    const anchor = element?.previousElementSibling
    if (!active || !element || !(anchor instanceof HTMLElement)) return undefined
    if (describe) anchor.setAttribute('aria-describedby', [anchor.getAttribute('aria-describedby'), id].filter(Boolean).join(' '))
    let timer: ReturnType<typeof setTimeout> | undefined
    let holdTimer: ReturnType<typeof setTimeout> | undefined
    let start: { x: number; y: number } | null = null
    // Shown by a press and hold: lifting the finger keeps it, and the click that ends the hold is swallowed.
    let held = false
    const show = (immediate: boolean) => {
      clearTimeout(timer)
      glide.current = !immediate && isWarm()
      if (immediate || glide.current) setOpen(true)
      else
        timer = setTimeout(() => {
          setOpen(true)
        }, HOVER_DELAY)
    }
    const hide = () => {
      clearTimeout(timer)
      if (element.matches(':popover-open')) markWarm(element)
      setOpen(false)
      stopDismissing()
    }
    const enter = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') show(false)
    }
    const leave = (event: PointerEvent) => {
      // A finger leaves the trigger as it lifts: a tooltip it held open stays until the next touch.
      if (event.pointerType === 'touch' && held) return
      hide()
    }
    const outside = (event: Event) => {
      if (event.type === 'pointerdown' && anchor.contains(event.target as Node)) return
      hide()
    }
    const stopDismissing = () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('scroll', outside, true)
    }
    const cancelHold = () => {
      clearTimeout(holdTimer)
      start = null
    }
    const down = (event: PointerEvent) => {
      hide()
      held = false
      if (event.pointerType === 'mouse' || anchor.closest('[data-context-gesture]')) return
      start = { x: event.clientX, y: event.clientY }
      clearTimeout(holdTimer)
      holdTimer = setTimeout(() => {
        held = true
        start = null
        // A held word would otherwise start a text selection under the tooltip.
        window.getSelection()?.removeAllRanges()
        show(true)
        document.addEventListener('pointerdown', outside, true)
        document.addEventListener('scroll', outside, true)
      }, HOLD_MS)
    }
    const move = (event: PointerEvent) => {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > HOLD_SLOP) cancelHold()
    }
    const click = (event: MouseEvent) => {
      if (!held) return
      held = false
      event.preventDefault()
      event.stopPropagation()
    }
    const contextmenu = (event: MouseEvent) => {
      // A touch browser's own menu for a held trigger would cover the tooltip.
      if (held || start) event.preventDefault()
    }
    const focus = () => {
      if (anchor.matches(':focus-visible')) show(true)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    const blur = () => {
      if (!held) hide()
    }
    anchor.addEventListener('pointerenter', enter)
    anchor.addEventListener('pointerleave', leave)
    anchor.addEventListener('pointerdown', down)
    anchor.addEventListener('pointermove', move)
    anchor.addEventListener('pointerup', cancelHold)
    anchor.addEventListener('pointercancel', cancelHold)
    anchor.addEventListener('click', click, true)
    anchor.addEventListener('contextmenu', contextmenu)
    anchor.addEventListener('focus', focus)
    anchor.addEventListener('blur', blur)
    anchor.addEventListener('keydown', key)
    return () => {
      clearTimeout(timer)
      cancelHold()
      stopDismissing()
      anchor.removeEventListener('pointerenter', enter)
      anchor.removeEventListener('pointerleave', leave)
      anchor.removeEventListener('pointerdown', down)
      anchor.removeEventListener('pointermove', move)
      anchor.removeEventListener('pointerup', cancelHold)
      anchor.removeEventListener('pointercancel', cancelHold)
      anchor.removeEventListener('click', click, true)
      anchor.removeEventListener('contextmenu', contextmenu)
      anchor.removeEventListener('focus', focus)
      anchor.removeEventListener('blur', blur)
      anchor.removeEventListener('keydown', key)
      const others =
        anchor
          .getAttribute('aria-describedby')
          ?.split(' ')
          .filter(token => token !== id) ?? []
      if (others.length > 0) anchor.setAttribute('aria-describedby', others.join(' '))
      else anchor.removeAttribute('aria-describedby')
    }
  }, [active, describe, id])

  return (
    <>
      {children}
      {active && (
        <span ref={layer} id={id} popover="manual" role="tooltip" className="ui-tooltip">
          <TooltipText content={content} shortcut={shortcut} />
        </span>
      )}
    </>
  )
}

function TooltipText({ content, shortcut }: { content: ReactNode; shortcut?: string }) {
  return (
    <>
      <span>{content}</span>
      {shortcut && (
        <span>
          (<kbd>{shortcut}</kbd>)
        </span>
      )}
    </>
  )
}

/** The tooltip's surface on its own, laid out in place: for a static sheet of the design system. */
export function TooltipSurface({ content, shortcut }: { content: ReactNode; shortcut?: string }) {
  return (
    <span className="ui-tooltip" data-static="">
      <TooltipText content={content} shortcut={shortcut} />
    </span>
  )
}
