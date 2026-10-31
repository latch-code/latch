import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Icon, type LucideIcon } from './icon.tsx'
import { cx, nextIndex } from './internal.ts'

export interface TabOption<T extends string> {
  value: T
  label: string
  /** The id of the panel this tab shows. */
  controls?: string
  /** A 12px glyph before the label. */
  icon?: LucideIcon
}

/**
 * Tabs that switch the content of one area: 24px with 6px corners and 12/16·500 words after an optional 12px glyph,
 * without a track; the selected tab stands on the hover fill in ink, the others are muted. The selection moves at once
 * and never slides; the area's content cross-fades. Never underlined, never blue. One tab stop; ←/→ move and select,
 * Home and End go to the ends. `actions` sits at the end of the row, for quiet xs ghost buttons.
 */
export function Tabs<T extends string>({
  label,
  value,
  options,
  onValueChange,
  actions,
  className,
}: {
  label: string
  value: T
  options: ReadonlyArray<TabOption<T>>
  onValueChange: (value: T) => void
  actions?: ReactNode
  className?: string
}) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  const selected = options.findIndex(option => option.value === value)

  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focused = tabs.current.findIndex(tab => tab === event.target)
    const index = nextIndex(event.key, focused >= 0 ? focused : Math.max(0, selected), options.length, 'horizontal', () => true)
    if (index === undefined) return
    event.preventDefault()
    tabs.current[index]?.focus()
    const option = options[index]
    if (option && option.value !== value) onValueChange(option.value)
  }

  return (
    <div className={cx('ui-tabs', className)}>
      <div className="ui-tab-list" role="tablist" aria-label={label} onKeyDown={keydown}>
        {options.map((option, index) => (
          <button
            key={option.value}
            ref={element => {
              tabs.current[index] = element
            }}
            type="button"
            role="tab"
            className="ui-tab"
            aria-selected={index === selected}
            aria-controls={option.controls}
            tabIndex={index === Math.max(0, selected) ? 0 : -1}
            onClick={() => {
              if (option.value !== value) onValueChange(option.value)
            }}>
            {option.icon && <Icon icon={option.icon} size={12} />}
            {option.label}
          </button>
        ))}
      </div>
      {actions && <div className="ui-tabs-actions">{actions}</div>}
    </div>
  )
}

/**
 * Filters: drawn as tabs, for narrowing a list. They are toggle buttons (aria-pressed), not tabs, and share one tab
 * stop; ←/→ move and choose.
 */
export function FilterPills<T extends string>({
  label,
  value,
  options,
  onValueChange,
  className,
}: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onValueChange: (value: T) => void
  className?: string
}) {
  const pills = useRef<Array<HTMLButtonElement | null>>([])
  const selected = options.findIndex(option => option.value === value)
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focused = pills.current.findIndex(pill => pill === event.target)
    const index = nextIndex(event.key, focused >= 0 ? focused : Math.max(0, selected), options.length, 'horizontal', () => true)
    if (index === undefined) return
    event.preventDefault()
    pills.current[index]?.focus()
    const option = options[index]
    if (option && option.value !== value) onValueChange(option.value)
  }
  return (
    <div className={cx('ui-filters', className)} role="group" aria-label={label} onKeyDown={keydown}>
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={element => {
            pills.current[index] = element
          }}
          type="button"
          className="ui-tab"
          aria-pressed={index === selected}
          tabIndex={index === Math.max(0, selected) ? 0 : -1}
          onClick={() => {
            if (option.value !== value) onValueChange(option.value)
          }}>
          {option.label}
        </button>
      ))}
    </div>
  )
}
