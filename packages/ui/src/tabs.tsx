import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { CloseGlyph } from './glyphs/index.tsx'
import { Icon, type IconComponent } from './icon.tsx'
import { cx, nextIndex } from './internal.ts'
import { Menu, type MenuItem } from './menu.tsx'
import { fitTabs } from './tabFit.ts'

export interface TabOption<T extends string> {
  value: T
  label: string
  /** The id of the panel this tab shows. */
  controls?: string
  /** A 12px glyph before the label. */
  icon?: IconComponent
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
  /** A 12px glyph before the label: what the tab holds (a terminal, a file's kind), never the close control. */
  icon?: IconComponent
  /** A line count after the label, 「+60 −6」, in the diff's tones. */
  stat?: { added: number; removed: number }
  /** Something new in it that the person has not looked at: a 6px dot after the label, named for screen readers. */
  fresh?: boolean
  /** Makes the tab closable; its × and what Delete does say this. */
  closeLabel?: string
  /** More of the tab's own actions, in its context menu before 关闭. */
  menu?: MenuItem[]
}

/** The overflow button's width and the space between two tabs, as tabs.css draws them. */
const MORE_WIDTH = 40
const TAB_GAP = 2

/**
 * The strip of a side panel: 24px tabs with 6px corners and 12/16·500 words, at most 160 wide. The selection moves at
 * once and never slides. A closable tab is `glyph · label · ×`: the × has its own slot at the end, shown on hover, while
 * focus is in the tab, and always on a touch screen's selected tab, so nothing moves when it appears (its slot counts in
 * the tab's width). Delete, a middle click and the tab's context menu (right click, press and hold, the context-menu
 * key) close it; Delete moves focus to its neighbour. One tab stop; ←/→ move and select through every tab,
 * Home and End go to the ends. Tabs that do not fit go into one menu at the row's end (`fitTabs`); the selected tab
 * always stands in the row. `add` follows the tabs (and the +N menu) at once, for what opens a new tab; `actions` ends
 * the row.
 */
export function PanelTabs<T extends string>({
  label,
  value,
  tabs,
  onValueChange,
  onClose,
  add,
  actions,
  className,
}: {
  label: string
  value: T
  tabs: ReadonlyArray<PanelTab<T>>
  onValueChange: (value: T) => void
  onClose?: (value: T) => void
  /** Right after the tabs: the control that opens another one. */
  add?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  const row = useRef<HTMLDivElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const adder = useRef<HTMLDivElement>(null)
  const faces = useRef<Array<HTMLButtonElement | null>>([])
  const boxes = useRef<Array<HTMLSpanElement | null>>([])
  const base = useId()
  const selected = tabs.findIndex(tab => tab.value === value)
  const [shown, setShown] = useState<readonly number[] | null>(null)
  const signature = tabs.map(tab => `${tab.value}:${tab.label}:${tab.stat ? `${tab.stat.added}/${tab.stat.removed}` : ''}`).join('|')
  const fit = useCallback(() => {
    const element = row.current
    if (!element) return
    const style = getComputedStyle(element)
    const gap = parseFloat(style.columnGap) || 0
    const ending = (end.current ? end.current.offsetWidth + gap : 0) + (adder.current ? adder.current.offsetWidth + gap : 0)
    const available = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - ending
    const widths = boxes.current.slice(0, tabs.length).map(box => box?.offsetWidth ?? 0)
    const next = fitTabs({ widths, selected, available, gap: TAB_GAP, more: MORE_WIDTH })
    setShown(previous => {
      const all = next.length === tabs.length
      if (all) return previous === null ? previous : null
      return previous && previous.length === next.length && previous.every((index, at) => index === next[at]) ? previous : next
    })
  }, [selected, tabs.length])
  useLayoutEffect(fit, [fit, signature])
  useEffect(() => {
    const element = row.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => fit())
    observer.observe(element)
    return () => observer.disconnect()
  }, [fit])
  const standing = (index: number) => shown === null || shown.includes(index)
  const hidden = tabs.flatMap((tab, index) => (standing(index) ? [] : [{ tab, index }]))

  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focused = faces.current.findIndex(tab => tab === event.target)
    if (focused < 0) return
    const current = tabs[focused]
    if (event.key === 'Delete' && current?.closeLabel !== undefined) {
      event.preventDefault()
      onClose?.(current.value)
      const neighbour = faces.current[focused + 1] ?? faces.current[focused - 1]
      neighbour?.focus()
      return
    }
    const index = nextIndex(event.key, focused, tabs.length, 'horizontal', () => true)
    if (index === undefined) return
    event.preventDefault()
    const option = tabs[index]
    if (option && option.value !== value) onValueChange(option.value)
    // A tab from the menu stands in the row once selected: it takes the focus there.
    if (standing(index)) faces.current[index]?.focus()
    else requestAnimationFrame(() => faces.current[index]?.focus())
  }

  return (
    <div ref={row} className={cx('ui-panel-tabs', className)}>
      <div className="ui-panel-tab-list" role="tablist" aria-label={label} onKeyDown={keydown}>
        {tabs.map((tab, index) => (
          <span
            key={tab.value}
            id={`${base}-${index}`}
            ref={element => {
              boxes.current[index] = element
            }}
            className="ui-panel-tab"
            data-closable={tab.closeLabel !== undefined ? '' : undefined}
            data-overflow={standing(index) ? undefined : ''}>
            <button
              ref={element => {
                faces.current[index] = element
              }}
              type="button"
              role="tab"
              className="ui-panel-tab-face"
              aria-selected={index === selected}
              aria-controls={tab.controls}
              tabIndex={index === Math.max(0, selected) ? 0 : -1}
              onClick={() => {
                if (tab.value !== value) onValueChange(tab.value)
              }}
              onAuxClick={event => {
                if (event.button !== 1 || tab.closeLabel === undefined) return
                event.preventDefault()
                onClose?.(tab.value)
              }}>
              {tab.icon && <Icon icon={tab.icon} size={12} className="ui-panel-tab-glyph" />}
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
                <Icon icon={CloseGlyph} size={12} />
              </button>
            )}
            {((tab.closeLabel !== undefined && onClose) || tab.menu?.length) && (
              <Menu
                label={tab.label}
                context={() => document.getElementById(`${base}-${index}`)}
                sections={[
                  { id: 'actions', items: tab.menu ?? [] },
                  {
                    id: 'tab',
                    items:
                      tab.closeLabel !== undefined && onClose
                        ? [{ id: 'close', label: '关闭', icon: CloseGlyph, onSelect: () => onClose(tab.value) }]
                        : [],
                  },
                ].filter(section => section.items.length > 0)}
              />
            )}
          </span>
        ))}
      </div>
      {hidden.length > 0 && (
        <Menu
          label={`其余 ${hidden.length} 个标签`}
          align="end"
          size="sm"
          sections={[
            {
              id: 'tabs',
              items: hidden.map(({ tab }) => ({
                id: tab.value,
                label: tab.label,
                ...(tab.icon ? { icon: tab.icon } : {}),
                ...(tab.stat ? { meta: `+${tab.stat.added} −${tab.stat.removed}` } : {}),
                onSelect: () => onValueChange(tab.value),
              })),
            },
          ]}
          trigger={props => (
            <button {...props} type="button" className="ui-panel-tabs-more" aria-label={`其余 ${hidden.length} 个标签`}>
              +{hidden.length}
              {hidden.some(({ tab }) => tab.fresh) && <span className="ui-panel-tab-fresh" role="img" aria-label="有新内容" />}
            </button>
          )}
        />
      )}
      {add && (
        <div ref={adder} className="ui-panel-tabs-add">
          {add}
        </div>
      )}
      {actions && (
        <div ref={end} className="ui-tabs-actions">
          {actions}
        </div>
      )}
    </div>
  )
}
