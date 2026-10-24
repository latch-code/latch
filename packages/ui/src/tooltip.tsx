import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { pinLayer, setPopover } from './internal.ts'

/** Hovering waits this long before a tooltip appears. */
const HOVER_DELAY = 500
/** After a tooltip hides, another one within this window appears at once: moving along a toolbar switches instantly. */
const WARM_WINDOW = 300
const warm = { until: 0 }
const isWarm = () => performance.now() < warm.until
const markWarm = () => {
  warm.until = performance.now() + WARM_WINDOW
}

/**
 * A tooltip on its trigger, the element just before it: the action's name, a shortcut after it, or why a disabled
 * control cannot be used. It appears after 500ms of hover, at once on keyboard focus or when the pointer moves on from
 * a neighbour's tooltip, and goes as soon as the pointer leaves, the trigger is pressed or Escape is pressed. It
 * follows the theme (raised surface, never inverted) and never takes the pointer. Its text describes the trigger for
 * screen readers unless `describe` is false, as for an icon button whose name is already the same text. Touch never
 * shows it.
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

  // Shown before it is placed: a hidden popover has no size to measure.
  useLayoutEffect(() => {
    const element = layer.current
    setPopover(element, open)
    const anchor = element?.previousElementSibling
    if (!open || !element || !anchor) return undefined
    return pinLayer(anchor, element, { align: 'center', side, gap: 6 })
  }, [open, side])

  useEffect(() => {
    const element = layer.current
    const anchor = element?.previousElementSibling
    if (!active || !element || !(anchor instanceof HTMLElement)) return undefined
    if (describe) anchor.setAttribute('aria-describedby', [anchor.getAttribute('aria-describedby'), id].filter(Boolean).join(' '))
    let timer: ReturnType<typeof setTimeout> | undefined
    const show = (immediate: boolean) => {
      clearTimeout(timer)
      if (immediate || isWarm()) setOpen(true)
      else
        timer = setTimeout(() => {
          setOpen(true)
        }, HOVER_DELAY)
    }
    const hide = () => {
      clearTimeout(timer)
      if (element.matches(':popover-open')) markWarm()
      setOpen(false)
    }
    const enter = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') show(false)
    }
    const focus = () => {
      if (anchor.matches(':focus-visible')) show(true)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    anchor.addEventListener('pointerenter', enter)
    anchor.addEventListener('pointerleave', hide)
    anchor.addEventListener('pointerdown', hide)
    anchor.addEventListener('focus', focus)
    anchor.addEventListener('blur', hide)
    anchor.addEventListener('keydown', key)
    return () => {
      clearTimeout(timer)
      anchor.removeEventListener('pointerenter', enter)
      anchor.removeEventListener('pointerleave', hide)
      anchor.removeEventListener('pointerdown', hide)
      anchor.removeEventListener('focus', focus)
      anchor.removeEventListener('blur', hide)
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
      {shortcut && <kbd>{shortcut}</kbd>}
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
