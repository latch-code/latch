import { useId, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Ellipsis, Info, Lock } from 'lucide-react'
import { usePresence } from '../hooks/useListMotion.ts'
import { Button, Icon, IconButton, Loading as InlineLoading, type LucideIcon, type MenuTriggerProps } from '@latch/ui'

/**
 * The page's own layout for settings: groups of rows in a well sunk into the panel, divided by hairlines. Controls
 * inside are the design system's primitives; these only place them.
 */

/** The page head: an 18/26 title, one paragraph under it and at most one page action (a sm secondary button). */
export function SectionHeading({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <header className="settings-heading">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action}
    </header>
  )
}

/**
 * A group: its heading (with meta text or an action on the right), its rows, and at most one caption under them. A
 * secure group is a security surface (data-secure, security.css).
 */
export function SettingsGroup({
  title,
  meta,
  caption,
  captionIcon = 'info',
  bare = false,
  secure = false,
  children,
}: {
  title?: string
  meta?: ReactNode
  caption?: ReactNode
  captionIcon?: 'info' | 'lock' | null
  /** The children lay out themselves instead of as rows. */
  bare?: boolean
  secure?: boolean
  children: ReactNode
}) {
  const id = useId()
  return (
    <section
      className="settings-group"
      data-secure={secure ? '' : undefined}
      data-bare={bare ? '' : undefined}
      aria-labelledby={title ? id : undefined}>
      {(title || meta) && (
        <div className="settings-group-head">
          {title && <h3 id={id}>{title}</h3>}
          {meta && <span className="settings-group-meta">{meta}</span>}
        </div>
      )}
      {bare ? children : <div className="settings-card">{children}</div>}
      {caption && (
        <p className="settings-caption">
          {captionIcon && <Icon icon={captionIcon === 'lock' ? Lock : Info} size={14} />}
          <span>{caption}</span>
        </p>
      )}
    </section>
  )
}

/** A 32px tile for a row that leads with an icon instead of a brand: the hover fill, a 16px glyph in ink-2. */
export function IconTile({ icon }: { icon: LucideIcon }) {
  return (
    <span className="settings-icon-tile" aria-hidden="true">
      <Icon icon={icon} size={16} />
    </span>
  )
}

interface RowContent {
  leading?: ReactNode
  title: ReactNode
  /** One sentence: the consequence of a preference, or the state of a record. */
  description?: ReactNode
  /** Record names are 500; preferences 400. */
  record?: boolean
  /** Offline or unavailable: the tile dims and the name turns ink-2; the state is in the description. */
  dim?: boolean
  className?: string
}

function RowText({ title, description, record, ids }: Pick<RowContent, 'title' | 'description' | 'record'> & { ids?: string }) {
  return (
    <span className="settings-row-text">
      <span id={ids ? `${ids}-title` : undefined} className="settings-row-title" data-record={record ? '' : undefined}>
        {title}
      </span>
      {description && (
        <span id={ids ? `${ids}-description` : undefined} className="settings-row-description">
          {description}
        </span>
      )}
    </span>
  )
}

/** A row of a group, 52px or 60px with a description, with one trailing element (a picker, a switch, a button or a value) on the card's 16px line. */
export function SettingsRow({ leading, title, description, record, dim, className, trailing }: RowContent & { trailing?: ReactNode }) {
  return (
    <div
      className={className ? `settings-row ${className}` : 'settings-row'}
      data-leading={leading ? '' : undefined}
      data-dim={dim ? '' : undefined}>
      {leading && <span className="settings-row-lead">{leading}</span>}
      <RowText title={title} description={description} record={record} />
      {trailing !== undefined && <span className="settings-row-end">{trailing}</span>}
    </div>
  )
}

/**
 * A row that is an object with its own actions: the tile and words open it, and what stands at the end (a status, a ⋯
 * menu) stays separate, because a button cannot hold other buttons.
 */
export function ObjectRow({
  leading,
  title,
  description,
  dim,
  className,
  label,
  trailing,
  onOpen,
}: RowContent & { label: string; trailing?: ReactNode; onOpen?: () => void }) {
  const body = (
    <>
      {leading && <span className="settings-row-lead">{leading}</span>}
      <RowText title={title} description={description} record />
    </>
  )
  return (
    <div
      className={className ? `settings-row ${className}` : 'settings-row'}
      data-leading={leading ? '' : undefined}
      data-dim={dim ? '' : undefined}>
      {onOpen ? (
        <button type="button" className="settings-row-main" aria-label={label} onClick={onOpen}>
          {body}
        </button>
      ) : (
        body
      )}
      {trailing !== undefined && <span className="settings-row-end">{trailing}</span>}
    </div>
  )
}

/** A row that goes into an object or a list: the whole row is the button, ending in a quiet value and chevron-right. */
export function NavRow({
  leading,
  title,
  description,
  record,
  dim,
  className,
  value,
  label,
  onClick,
}: RowContent & { value?: ReactNode; label?: string; onClick: () => void }) {
  const id = useId()
  return (
    <button
      type="button"
      className={className ? `settings-row ${className}` : 'settings-row'}
      data-nav=""
      data-leading={leading ? '' : undefined}
      data-dim={dim ? '' : undefined}
      aria-label={label}
      aria-describedby={label === undefined && description ? `${id}-description` : undefined}
      onClick={onClick}>
      {leading && <span className="settings-row-lead">{leading}</span>}
      <RowText title={title} description={description} record={record} ids={id} />
      <span className="settings-row-end">
        {value !== undefined && <span className="settings-row-value">{value}</span>}
        <Icon icon={ChevronRight} size={12} className="settings-row-chevron" />
      </span>
    </button>
  )
}

/**
 * Rows of a card that come and go while the page is open (an allow-list entry, a project): a row that arrives opens
 * its height and fades in (180ms), one that leaves folds away and fades (140ms). Rows already there when the card
 * first shows do not move. The fold is a grid row going between 0fr and 1fr, so nothing but the height changes.
 */
export function FoldRows<T>({
  items,
  keyOf,
  className,
  children,
}: {
  items: readonly T[]
  keyOf: (item: T) => string
  className?: string
  children: (item: T) => ReactNode
}) {
  const shown = usePresence(items, keyOf, 'rows')
  return (
    <div
      className={className ? `settings-folds ${className}` : 'settings-folds'}
      ref={element => {
        // Only rows added after the first paint open from nothing.
        if (element) requestAnimationFrame(() => element.setAttribute('data-ready', ''))
      }}>
      {shown.map(({ item, leaving }) => (
        <div key={keyOf(item)} className="settings-fold" data-leaving={leaving ? '' : undefined} inert={leaving || undefined}>
          <div className="settings-fold-inner">{children(item)}</div>
        </div>
      ))}
    </div>
  )
}

/** Where a path or command is cut: before its last two parts when they are short, else before the last one. */
function tailStart(text: string): number {
  const parts = text.split('/')
  const two = parts.slice(-2).join('/')
  const tail = two.length <= 24 && parts.length > 2 ? two : (parts.at(-1) ?? '')
  return Math.max(0, text.length - Math.min(tail.length + 1, 24))
}

/**
 * A path or command on one line that keeps its end in view: when the line is too narrow, the middle gives way to an
 * ellipsis. The whole text is the tooltip and is what assistive technology reads.
 */
export function MiddleEllipsis({ text, className }: { text: string; className?: string }) {
  const cut = tailStart(text)
  return (
    <span className={className ? `middle-ellipsis ${className}` : 'middle-ellipsis'} title={text}>
      <span className="middle-ellipsis-head">{text.slice(0, cut)}</span>
      <span className="middle-ellipsis-tail">{text.slice(cut)}</span>
    </span>
  )
}

/** The way back from a page inside a section to the section (or from a list page to 电脑); from 768px only. */
export function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" icon={ChevronLeft} className="settings-back" onClick={onClick}>
      {label}
    </Button>
  )
}

/** The ⋯ button that opens a row's menu of actions; `label` names the row's object, as the menu does. */
export function moreButton(label: string) {
  return (props: MenuTriggerProps) => <IconButton {...props} label={label} icon={Ellipsis} />
}

/** Settings sections loading their data: the design system's inline loading line. */
export function Loading({ label = '正在读取…' }: { label?: string }) {
  return <InlineLoading label={label} />
}
