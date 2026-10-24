import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cx, nextIndex } from './internal.ts'

export interface TabOption<T extends string> {
  value: T
  label: string
  /** The id of the panel this tab shows. */
  controls?: string
}

/**
 * Text tabs that switch the content of one area: pills without a track, the selected one a neutral fill that slides to
 * its place. Never underlined, never blue. One tab stop; ←/→ move and select, Home and End go to the ends. `actions`
 * sits at the end of the row, for quiet xs ghost buttons.
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
  const list = useRef<HTMLDivElement>(null)
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  const selected = options.findIndex(option => option.value === value)

  // The fill is one element that moves between tabs of different widths, so it is measured from the selected tab.
  useLayoutEffect(() => {
    const tab = tabs.current[selected]
    const element = list.current
    if (!element) return
    if (!tab) {
      element.style.removeProperty('--tab-x')
      element.style.removeProperty('--tab-width')
      return
    }
    element.style.setProperty('--tab-x', `${tab.offsetLeft}px`)
    element.style.setProperty('--tab-width', `${tab.offsetWidth}px`)
  })

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
      <div ref={list} className="ui-tab-list" role="tablist" aria-label={label} onKeyDown={keydown}>
        {selected >= 0 && <span className="ui-tab-fill" aria-hidden="true" />}
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
            {option.label}
          </button>
        ))}
      </div>
      {actions && <div className="ui-tabs-actions">{actions}</div>}
    </div>
  )
}

/**
 * Filter pills: the same pills as tabs, for narrowing a list. They are toggle buttons (aria-pressed), not tabs, and
 * share one tab stop; ←/→ move and choose.
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
