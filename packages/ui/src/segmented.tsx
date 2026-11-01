import { useRef, type KeyboardEvent } from 'react'
import { cx, nextIndex } from './internal.ts'
import { Tooltip } from './tooltip.tsx'

export interface SegmentOption<T extends string> {
  value: T
  /** Four Chinese characters or twelve Latin ones at most; text only, no icons. */
  label: string
  disabled?: boolean
  /** The segment's tooltip, also read as its description: what it does, or why it cannot be chosen. */
  title?: string
}

/**
 * Two or three equal views or modes (对话 / Agent; 跟随系统 / 浅色 / 深色), and only those: an ordered level, a choice
 * with consequences or four or more options take a value picker or a single-choice list. The type allows two or three
 * options. A radio group with one tab stop: ←/→ move and select at once, Home and End go to the ends. The track is a
 * soft fill; the selected segment stands on it as a raised white face (a lifted grey in the dark theme), which
 * cross-fades to its new place over --m-micro and never slides.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onValueChange,
  size = 'sm',
  disabled = false,
  className,
}: {
  label: string
  value: T
  options: ReadonlyArray<SegmentOption<T>>
  onValueChange: (value: T) => void
  /**
   * xs: 24 overall (20px segments, 11/14), for a panel's strip. sm: 28 overall (24px segments, 12/16), md: 32 (28px
   * segments, 13/18); phones are 36 (32px segments) at any size.
   */
  size?: 'xs' | 'sm' | 'md'
  disabled?: boolean
  className?: string
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const selected = options.findIndex(option => option.value === value)
  const usable = (index: number) => !disabled && options[index]?.disabled !== true
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focused = buttons.current.findIndex(item => item === event.target)
    const index = nextIndex(event.key, focused >= 0 ? focused : Math.max(0, selected), options.length, 'horizontal', usable)
    if (index === undefined) return
    event.preventDefault()
    buttons.current[index]?.focus()
    const option = options[index]
    if (option && option.value !== value) onValueChange(option.value)
  }
  // The one tab stop is the selected segment, or the first usable one when nothing is selected.
  const stop = selected >= 0 ? selected : options.findIndex((_, index) => usable(index))
  return (
    <div
      className={cx('ui-segmented', className)}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-size={size}
      onKeyDown={keydown}>
      {options.map((option, index) => (
        <Tooltip key={option.value} content={option.title}>
          <button
            ref={element => {
              buttons.current[index] = element
            }}
            type="button"
            role="radio"
            className="ui-segmented-option"
            aria-checked={index === selected}
            aria-disabled={!usable(index) || undefined}
            tabIndex={index === stop ? 0 : -1}
            onClick={() => {
              if (usable(index) && option.value !== value) onValueChange(option.value)
            }}>
            {option.label}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}
