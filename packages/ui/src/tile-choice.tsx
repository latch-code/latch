import { useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react'
import { BlockedGlyph } from './glyphs/index.tsx'
import { cx, nextIndex } from './internal.ts'
import { Icon, type IconComponent } from './icon.tsx'
import { Collapse } from './motion.tsx'
import { Tooltip } from './tooltip.tsx'

export interface TileChoiceOption<T extends string> {
  value: T
  /** The name under the tile. */
  label: string
  /** One short line under the name: a variant (只对话), a property (完全访问) or, when it cannot be chosen, why. */
  note?: string
  /** The value's tile (40), drawn by the caller. */
  tile: ReactNode
  /** What choosing it means, in a sentence: the tooltip and what is read after the name. */
  description?: string
  /** Why it cannot be chosen here: the item dims and stays focusable, the reason is its tooltip and description. */
  disabledReason?: string
}

/**
 * Picks one of a few peers shown by their tiles, as a row of items (a tile, its name and one short line): the agent of
 * a new session. The chosen item is the selected card (white with a hairline ring, a soft fill in dark) with its name
 * in ink at 500, never blue; it cross-fades in over --m-micro. One tab stop (the chosen item, else the first that can be
 * chosen); the arrow keys move and choose, skipping items that cannot be chosen, Home and End go to the ends. An item
 * that cannot be chosen dims its tile and name, keeps its line at full strength and says why in its tooltip; pressed
 * (touch screens have no tooltip) it says why in a line that opens under the row like a disclosure. The row
 * wraps and centres; on phones it is one line that scrolls sideways. `children` follow the items in the row (an action
 * such as adding another), outside the group.
 */
export function TileChoice<T extends string>({
  label,
  value,
  options,
  onValueChange,
  children,
  className,
  variant = 'tiles',
}: {
  /** The group's accessible name (Agent). */
  label: string
  value: T | undefined
  options: ReadonlyArray<TileChoiceOption<T>>
  onValueChange: (value: T) => void
  children?: ReactNode
  className?: string
  /** Compact peers keep their small icon, label and note on one line. */
  variant?: 'tiles' | 'compact'
}) {
  const items = useRef<Array<HTMLButtonElement | null>>([])
  const [explained, setExplained] = useState<T | null>(null)
  const selected = options.findIndex(option => option.value === value)
  const usable = (index: number) => options[index] !== undefined && options[index].disabledReason === undefined
  const stop = selected >= 0 ? selected : options.findIndex((_, index) => usable(index))
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focused = items.current.findIndex(item => item === event.target)
    if (focused < 0) return
    // The row reads left to right and wraps, so both pairs of arrows step through it.
    const index =
      nextIndex(event.key, focused, options.length, 'horizontal', usable)
      ?? nextIndex(event.key, focused, options.length, 'vertical', usable)
    if (index === undefined) return
    event.preventDefault()
    items.current[index]?.focus()
    const option = options[index]
    if (option && option.value !== value) onValueChange(option.value)
  }
  const reason = options.find(option => option.value === explained)?.disabledReason
  // The last reason given, which the line keeps while it folds away.
  const [said, setSaid] = useState(reason)
  if (reason !== undefined && reason !== said) setSaid(reason)
  return (
    <div className={cx('ui-tile-choice', className)} data-variant={variant}>
      <div className="ui-tile-choice-row">
        <div className="ui-tile-choice-group" role="radiogroup" aria-label={label} onKeyDown={keydown}>
          {options.map((option, index) => {
            const disabled = option.disabledReason !== undefined
            const checked = index === selected
            return (
              // The tooltip's words are also the item's description for screen readers.
              <Tooltip key={option.value} content={option.disabledReason ?? option.description}>
                <button
                  ref={element => {
                    items.current[index] = element
                  }}
                  type="button"
                  role="radio"
                  className="ui-tile-choice-item"
                  aria-checked={checked}
                  aria-disabled={disabled || undefined}
                  tabIndex={index === stop ? 0 : -1}
                  onClick={() => {
                    if (disabled) setExplained(option.value)
                    else {
                      setExplained(null)
                      if (!checked) onValueChange(option.value)
                    }
                  }}>
                  <span className="ui-tile-choice-tile">{option.tile}</span>
                  <span className="ui-tile-choice-label">{option.label}</span>
                  {option.note && <span className="ui-tile-choice-note">{option.note}</span>}
                </button>
              </Tooltip>
            )
          })}
        </div>
        {children}
      </div>
      <p className="sr-only" role="status">
        {reason}
      </p>
      {/* The line opens under the row like a disclosure and keeps its words while it folds away. */}
      <Collapse open={reason !== undefined}>
        <p className="ui-tile-choice-reason" aria-hidden="true">
          <Icon icon={BlockedGlyph} size={12} />
          {said}
        </p>
      </Collapse>
    </div>
  )
}

/**
 * An action at the end of a row of tiles, drawn like an item: a dashed plate with a glyph, a name and a short line
 * (添加 Agent). A popover's trigger props pass straight through.
 */
export function TileAction({
  icon,
  label,
  note,
  className,
  variant = 'tiles',
  ...props
}: Omit<ComponentProps<'button'>, 'children'> & { icon: IconComponent; label: string; note?: string; variant?: 'tiles' | 'compact' }) {
  return (
    <button {...props} type="button" data-variant={variant} className={cx('ui-tile-choice-item', 'ui-tile-action', className)}>
      <span className="ui-tile-choice-tile">
        <span className="ui-tile-action-plate">
          <Icon icon={icon} size={variant === 'compact' ? 16 : 20} />
        </span>
      </span>
      <span className="ui-tile-choice-label">{label}</span>
      {note && <span className="ui-tile-choice-note">{note}</span>}
    </button>
  )
}
