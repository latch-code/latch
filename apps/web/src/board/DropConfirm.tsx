import { useLayoutEffect, useRef } from 'react'
import { Button } from '@latch/ui'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy({ cancel: '取消' }, { cancel: 'Cancel' })

/** Space kept between the confirm and the window's edges: the board's own gutter, so it never sits on the edge. */
const MARGIN = 16

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
    // Its layout size: the entrance scales the box, which the bounding rectangle would include.
    const { offsetWidth: width, offsetHeight: height } = element
    const { clientWidth, clientHeight } = document.documentElement
    element.style.left = `${Math.max(MARGIN, Math.min(point.x, clientWidth - width - MARGIN))}px`
    element.style.top = `${Math.max(MARGIN, Math.min(point.y + 8, clientHeight - height - MARGIN))}px`
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
          {COPY.cancel}
        </Button>
        <Button size="xs" variant="danger" data-confirm="" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}
