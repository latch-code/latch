import type { ComponentProps, ReactNode } from 'react'
import { cx } from './internal.ts'

/**
 * A card of settings: a 12px-cornered raised group under an optional heading, with rows divided by hairlines. Whatever
 * it holds has the inner padding: a `Row` brings its own, and anything else (a chart, a note, a list) gets the same.
 */
export function Group({
  title,
  description,
  action,
  className,
  children,
  ...props
}: Omit<ComponentProps<'section'>, 'title'> & {
  title?: ReactNode
  description?: ReactNode
  /** At the end of the heading's line, for one quiet control. */
  action?: ReactNode
}) {
  return (
    <section {...props} className={cx('ui-group', className)}>
      {(title !== undefined || action !== undefined) && (
        <header className="ui-group-header">
          <h3 className="ui-group-title">{title}</h3>
          {action}
        </header>
      )}
      {description !== undefined && <p className="ui-group-description">{description}</p>}
      <div className="ui-group-card">{children}</div>
    </section>
  )
}

/** One line of a `Group`: at least 52 tall with 12/16 inside, a title and quiet description, and its control at the end. */
export function Row({
  title,
  description,
  leading,
  className,
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> & {
  title: ReactNode
  description?: ReactNode
  /** A tile or a glyph before the words. */
  leading?: ReactNode
  /** The row's control. */
  children?: ReactNode
}) {
  return (
    <div {...props} className={cx('ui-row', className)}>
      {leading}
      <div className="ui-row-text">
        <div className="ui-row-title">{title}</div>
        {description !== undefined && <div className="ui-row-description">{description}</div>}
      </div>
      {children !== undefined && <div className="ui-row-control">{children}</div>}
    </div>
  )
}
