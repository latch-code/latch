import type { ComponentProps, ReactNode } from 'react'
import { ChevronRightGlyph } from './glyphs/index.tsx'
import { Icon } from './icon.tsx'
import { cx } from './internal.ts'

/**
 * The header of a disclosure: a whole-width button whose 12px chevron turns 90° over --m-panel as its `Collapse` opens.
 * The caller renders the `Collapse` beneath it and passes the same `open`.
 */
export function FoldHeader({
  open,
  onOpenChange,
  meta,
  className,
  children,
  onClick,
  type = 'button',
  ...props
}: Omit<ComponentProps<'button'>, 'aria-expanded'> & {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Quiet words or a stat at the end of the line. */
  meta?: ReactNode
}) {
  return (
    <button
      {...props}
      type={type}
      className={cx('ui-fold-header', className)}
      aria-expanded={open}
      onClick={event => {
        onClick?.(event)
        if (!event.defaultPrevented) onOpenChange(!open)
      }}>
      <Icon icon={ChevronRightGlyph} size={12} className="ui-fold-chevron" />
      <span className="ui-fold-label">{children}</span>
      {meta !== undefined && <span className="ui-fold-meta">{meta}</span>}
    </button>
  )
}
