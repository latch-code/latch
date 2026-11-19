import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { cx } from './internal.ts'
import { UI_COPY, useUiLocale } from './locale.ts'

export type ResizePhase = 'drag' | 'commit'

/**
 * The edge of a pane: an invisible 6px hit zone which shows a 1px line in line-strong after a 300ms hover (at once while dragging,
 * and with the focus ring from the keyboard). It never moves the layout and is never blue.
 *
 * It reports dimensions and leaves the rules to its owner: a drag reports the raw size under the pointer as it moves and
 * once more when it ends; arrows step 8px (32 with
 * Shift), Home and End go to `min` and `max`. Enter toggles a collapsible column or resets the other panes. A double click resets it. The
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
  orientation = 'vertical',
  onResize,
  onReset,
  onToggle,
  className,
  style,
}: {
  /** What the handle resizes, for example 「调整侧栏宽度」. */
  label: string
  /** The pane's width or height in px (0 while shut). */
  value: number
  min: number
  max: number
  collapsed?: boolean
  edge?: 'start' | 'end'
  orientation?: 'vertical' | 'horizontal'
  onResize: (size: number, phase: ResizePhase) => void
  onReset: () => void
  onToggle?: () => void
  className?: string
  style?: CSSProperties
}) {
  useUiLocale()
  const drag = useRef<{ pointer: number; position: number; from: number; last: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const report = useRef(onResize)
  report.current = onResize
  // Removed in the middle of a drag (the window crossed a breakpoint): the page must not keep the resize cursor and
  // its text unselectable, and the owner ends the drag at the last size it was told, as a release there would.
  useEffect(
    () => () => {
      const current = drag.current
      if (!current) return
      drag.current = null
      delete document.documentElement.dataset.resizing
      report.current(current.last, 'commit')
    },
    [],
  )
  const direction = edge === 'end' ? 1 : -1
  const horizontal = orientation === 'horizontal'
  const position = (event: PointerEvent<HTMLDivElement>) => (horizontal ? event.clientY : event.clientX)
  const sizeAt = (at: number) => (drag.current ? drag.current.from + (at - drag.current.position) * direction : value)

  const end = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointer !== event.pointerId) return
    // Only a release says where the pointer is; a cancelled or lost capture ends at the last size reported.
    const size = event.type === 'pointerup' ? sizeAt(position(event)) : current.last
    drag.current = null
    setDragging(false)
    delete document.documentElement.dataset.resizing
    onResize(size, 'commit')
  }

  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8
    const before = horizontal ? 'ArrowUp' : 'ArrowLeft'
    const after = horizontal ? 'ArrowDown' : 'ArrowRight'
    const grow = direction === 1 ? after : before
    const shrink = direction === 1 ? before : after
    const from = collapsed ? min : value
    let next: number | undefined
    if (event.key === grow) next = Math.min(max, from + step)
    else if (event.key === shrink) next = Math.max(min, from - step)
    else if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max
    else if (event.key === 'Enter') {
      event.preventDefault()
      if (onToggle) onToggle()
      else onReset()
      return
    }
    if (next === undefined) return
    event.preventDefault()
    onResize(next, 'commit')
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={collapsed ? min : value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={collapsed ? UI_COPY.collapsed : UI_COPY.pixels(value)}
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
        const from = collapsed ? 0 : value
        drag.current = { pointer: event.pointerId, position: position(event), from, last: from }
        document.documentElement.dataset.resizing = horizontal ? 'horizontal' : ''
        setDragging(true)
      }}
      onPointerMove={event => {
        if (drag.current?.pointer !== event.pointerId) return
        drag.current.last = sizeAt(position(event))
        onResize(drag.current.last, 'drag')
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
