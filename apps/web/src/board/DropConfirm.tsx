import { useLayoutEffect, useRef } from 'react'
import { Button } from '@latch/ui'

/** Space kept between the confirm and the window's edges. */
const MARGIN = 8

/**
 * The small confirm a drop asks for where it landed (a running session on 已结束 is a stop): the question, 取消 and the
 * action. Esc, 取消 or a press outside close it without doing anything.
 */
export function DropConfirm({
  label,
  question,
  confirmLabel,
  point,
  onConfirm,
  onClose,
}: {
  label: string
  question: string
  confirmLabel: string
  point: { x: number; y: number }
  onConfirm: () => void
  onClose: () => void
}) {
  const layer = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const element = layer.current
    if (!element) return undefined
    element.showPopover()
    const { width, height } = element.getBoundingClientRect()
    element.style.left = `${Math.max(MARGIN, Math.min(point.x, innerWidth - width - MARGIN))}px`
    element.style.top = `${Math.max(MARGIN, Math.min(point.y + MARGIN, innerHeight - height - MARGIN))}px`
    element.querySelector<HTMLElement>('[data-confirm]')?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && element.contains(event.target)) return
      close.current()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      if (element.matches(':popover-open')) element.hidePopover()
    }
  }, [point.x, point.y])
  return (
    <div
      ref={layer}
      popover="manual"
      className="ui-popover work-board-drop-confirm"
      data-size="xs"
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}>
      <p>{question}</p>
      <div className="work-board-drop-confirm-actions">
        <Button size="xs" variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button size="xs" variant="danger" data-confirm="" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}
