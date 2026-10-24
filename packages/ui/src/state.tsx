import type { ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Icon, Spinner } from './icon.tsx'
import { cx } from './internal.ts'

/**
 * An empty list or area: a short noun phrase (「还没有会话」) in text-2, one line of text-3 and at most one xs action,
 * left-aligned. No illustration.
 */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cx('ui-empty', className)}>
      <p className="ui-empty-title">{title}</p>
      {description && <p className="ui-empty-description">{description}</p>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  )
}

/**
 * Loading. inline: a 14px spinner in text-3 next to what loads. page: the 20px spinner and its line centred in the
 * area, as while the first connection to the host computer is made (「正在连接执行端…」). Announced politely.
 */
export function Loading({ label, variant = 'inline', className }: { label: ReactNode; variant?: 'inline' | 'page'; className?: string }) {
  return (
    <div className={cx('ui-loading', className)} data-variant={variant} role="status">
      <Spinner size={variant === 'page' ? 20 : 14} />
      <span>{label}</span>
    </div>
  )
}

/**
 * A placeholder block while a list loads: it breathes (opacity .55 to 1 over 1.6s) and never sweeps. Give it the size
 * of what it stands for, so the content replaces it without a jump.
 */
export function Skeleton({
  width,
  height = 16,
  round = false,
  className,
}: {
  width?: number | string
  height?: number
  round?: boolean
  className?: string
}) {
  return <span className={cx('ui-skeleton', className)} data-round={round ? '' : undefined} style={{ width, height }} aria-hidden="true" />
}

/**
 * The card that stands in for a part of the page that failed to render: a red triangle, the title, one line on what
 * is safe and why reloading loses nothing, then at most two buttons.
 */
export function ErrorState({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cx('ui-error-state', className)} role="alert">
      <Icon icon={TriangleAlert} size={20} className="ui-error-state-glyph" />
      <h2 className="ui-error-state-title">{title}</h2>
      {description && <p className="ui-error-state-description">{description}</p>}
      {actions && <div className="ui-error-state-actions">{actions}</div>}
    </div>
  )
}
