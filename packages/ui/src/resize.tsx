import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { cx } from './internal.ts'

export type ResizePhase = 'drag' | 'commit'

/**
 * The edge of a side column that changes its width, as in a code editor: an invisible 6px hit zone straddling the
 * edge with the col-resize cursor, which shows a 1px line in line-strong after a 300ms hover (at once while dragging,
 * and with the focus ring from the keyboard). It never moves the layout and is never blue.
 *
 * It reports widths and leaves the rules to its owner: a drag reports the raw width under the pointer as it moves and
 * once more when it ends (the owner clamps it, may snap the column shut, and remembers it); ←/→ step 8px (32 with
 * Shift), Home and End go to `min` and `max`; Enter toggles the column shut and open; a double click resets it. The
 * pointer is captured while dragging, so text is not selected and no frame takes the pointer. `edge` is the side of
 * the column the handle is on: `end` for a column on the left (the sidebar), `start` for one on the right.
 */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  collapsed = false,
  edge = 'end',
  onResize,
  onReset,
  onToggle,
  className,
  style,
}: {
  /** What the handle resizes, for example 「调整侧栏宽度」. */
  label: string
  /** The column's width in px (0 while shut). */
  value: number
  min: number
  max: number
  collapsed?: boolean
  edge?: 'start' | 'end'
  onResize: (width: number, phase: ResizePhase) => void
  onReset: () => void
  onToggle?: () => void
  className?: string
  style?: CSSProperties
}) {
  const drag = useRef<{ pointer: number; x: number; from: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  // Removed in the middle of a drag (the window crossed a breakpoint): the page must not keep the resize cursor and
  // its text unselectable.
  useEffect(
    () => () => {
      if (drag.current) delete document.documentElement.dataset.resizing
    },
    [],
  )
  const direction = edge === 'end' ? 1 : -1
  const widthAt = (x: number) => (drag.current ? drag.current.from + (x - drag.current.x) * direction : value)

  const end = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointer !== event.pointerId) return
    const width = widthAt(event.clientX)
    drag.current = null
    setDragging(false)
    delete document.documentElement.dataset.resizing
    onResize(width, 'commit')
  }

  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8
    const grow = edge === 'end' ? 'ArrowRight' : 'ArrowLeft'
    const shrink = edge === 'end' ? 'ArrowLeft' : 'ArrowRight'
    const from = collapsed ? min : value
    let next: number | undefined
    if (event.key === grow) next = Math.min(max, from + step)
    else if (event.key === shrink) next = Math.max(min, from - step)
    else if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max
    else if (event.key === 'Enter' && onToggle) {
      event.preventDefault()
      onToggle()
      return
    }
    if (next === undefined) return
    event.preventDefault()
    onResize(next, 'commit')
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={collapsed ? min : value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={collapsed ? '已收起' : `${value} 像素`}
      tabIndex={0}
      className={cx('ui-resize-handle', className)}
      data-edge={edge}
      data-dragging={dragging ? '' : undefined}
      style={style}
      onKeyDown={keydown}
      onDoubleClick={() => {
        onReset()
      }}
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return
        // No text selection starts, and the pointer stays with the handle over frames and other elements.
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { pointer: event.pointerId, x: event.clientX, from: collapsed ? 0 : value }
        document.documentElement.dataset.resizing = ''
        setDragging(true)
      }}
      onPointerMove={event => {
        if (drag.current?.pointer === event.pointerId) onResize(widthAt(event.clientX), 'drag')
      }}
      onPointerUp={event => {
        end(event)
      }}
      onPointerCancel={event => {
        end(event)
      }}
      onLostPointerCapture={event => {
        end(event)
      }}
    />
  )
}
