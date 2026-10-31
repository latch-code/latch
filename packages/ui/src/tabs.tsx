import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
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

export interface PanelTab<T extends string> {
  value: T
  label: string
  /** The id of the panel this tab shows. */
  controls?: string
  /** A 12px glyph; on a closable tab it gives way to × on hover. A closable tab without one keeps its place for the ×. */
  icon?: LucideIcon
  /** A line count after the label, 「+60 −6」, in the diff's tones. */
  stat?: { added: number; removed: number }
  /** Something new in it that the person has not looked at: a 6px dot after the label, named for screen readers. */
  fresh?: boolean
  /** Makes the tab closable; its × and what Delete does say this. */
  closeLabel?: string
}

/**
 * The strip of a side panel: 24px tabs with 6px corners and 12/16·500 words, at most 160 wide. The selection moves at
 * once and never slides. A closable tab's glyph becomes × on hover, and stays × on a touch screen's selected tab;
 * Delete closes the focused tab and moves focus to its neighbour. One tab stop; ←/→ move and select, Home and End go to
 * the ends. The list scrolls sideways when it overflows, and keeps the selected tab in view. `actions` ends the row.
 */
export function PanelTabs<T extends string>({
  label,
  value,
  tabs,
  onValueChange,
  onClose,
  actions,
  className,
}: {
  label: string
  value: T
  tabs: ReadonlyArray<PanelTab<T>>
  onValueChange: (value: T) => void
  onClose?: (value: T) => void
  actions?: ReactNode
  className?: string
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const selected = tabs.findIndex(tab => tab.value === value)
  useLayoutEffect(() => {
    buttons.current[selected]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [selected])

  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focused = buttons.current.findIndex(tab => tab === event.target)
    if (focused < 0) return
    const current = tabs[focused]
    if (event.key === 'Delete' && current?.closeLabel !== undefined) {
      event.preventDefault()
      onClose?.(current.value)
      const neighbour = buttons.current[focused + 1] ?? buttons.current[focused - 1]
      neighbour?.focus()
      return
    }
    const index = nextIndex(event.key, focused, tabs.length, 'horizontal', () => true)
    if (index === undefined) return
    event.preventDefault()
    buttons.current[index]?.focus()
    const option = tabs[index]
    if (option && option.value !== value) onValueChange(option.value)
  }

  return (
    <div className={cx('ui-panel-tabs', className)}>
      <div className="ui-panel-tab-list" role="tablist" aria-label={label} onKeyDown={keydown}>
        {tabs.map((tab, index) => (
          <span key={tab.value} className="ui-panel-tab" data-closable={tab.closeLabel !== undefined ? '' : undefined}>
            <button
              ref={element => {
                buttons.current[index] = element
              }}
              type="button"
              role="tab"
              className="ui-panel-tab-face"
              aria-selected={index === selected}
              aria-controls={tab.controls}
              tabIndex={index === Math.max(0, selected) ? 0 : -1}
              onClick={() => {
                if (tab.value !== value) onValueChange(tab.value)
              }}>
              {tab.icon ? (
                <Icon icon={tab.icon} size={12} className="ui-panel-tab-glyph" />
              ) : (
                tab.closeLabel !== undefined && <span className="ui-panel-tab-slot" />
              )}
              <span className="ui-panel-tab-label">{tab.label}</span>
              {tab.stat && (
                <span className="ui-panel-tab-stat">
                  <span data-tone="add">+{tab.stat.added}</span> <span data-tone="remove">−{tab.stat.removed}</span>
                </span>
              )}
              {tab.fresh && <span className="ui-panel-tab-fresh" role="img" aria-label="有新内容" />}
            </button>
            {tab.closeLabel !== undefined && (
              <button
                type="button"
                className="ui-panel-tab-close"
                aria-label={tab.closeLabel}
                tabIndex={-1}
                onClick={() => {
                  onClose?.(tab.value)
                }}>
                <Icon icon={X} size={12} />
              </button>
            )}
          </span>
        ))}
      </div>
      {actions && <div className="ui-tabs-actions">{actions}</div>}
    </div>
  )
}
