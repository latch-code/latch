import { useId, useRef, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react'
import { BlockedGlyph, ShieldAlertGlyph } from './glyphs/index.tsx'
import { Icon } from './icon.tsx'
import { cx, nextIndex } from './internal.ts'

type CheckProps = Omit<ComponentProps<'input'>, 'type' | 'size'> & {
  /** Next to the box, in a label that toggles it as well. */
  label?: ReactNode
  description?: ReactNode
}

/** The box (or circle) with its label beside it; the description under the label describes the input. */
function CheckField({ type, label, description, className, ...props }: CheckProps & { type: 'checkbox' | 'radio' }) {
  const id = useId()
  const inputClass = type === 'checkbox' ? 'ui-checkbox' : 'ui-radio'
  if (label === undefined) return <input {...props} type={type} className={cx(inputClass, className)} />
  return (
    <div className={cx('ui-check', className)}>
      <input
        id={id}
        {...props}
        type={type}
        className={inputClass}
        aria-describedby={description ? `${id}-description` : props['aria-describedby']}
      />
      <span className="ui-check-text">
        <label className="ui-check-label" htmlFor={id}>
          {label}
        </label>
        {description && (
          <span id={`${id}-description`} className="ui-check-description">
            {description}
          </span>
        )}
      </span>
    </div>
  )
}

/** A 16px checkbox: a 1.5px line-strong ring; checked, the accent with a white tick. A native input. */
export function Checkbox(props: CheckProps) {
  return <CheckField {...props} type="checkbox" />
}

/** A 16px radio: a 1.5px line-strong ring; selected, a 5px accent ring. A native input; group it by `name`. */
export function Radio(props: CheckProps) {
  return <CheckField {...props} type="radio" />
}

export interface ChoiceOption<T extends string> {
  value: T
  title: string
  /** One sentence: what choosing it means. */
  description?: string
  /** Right after the title, for example the 默认 small badge; read with the title. */
  tag?: ReactNode
  /** A level with real risk: once it is the selected one, a shield-alert follows its description. */
  risk?: boolean
  /** Why it cannot be chosen; the row dims and the reason stays readable under it. */
  disabledReason?: string
  /** The value's own picture (a tile) between the radio and the title. */
  media?: ReactNode
}

/**
 * A single-choice list in a card: every option with its consequence laid out, for detail pages and for every picker on
 * a phone. Rows are 48px (56 on phones) with a leading radio; the selected title is 500. Choosing takes effect at once.
 * A radio group with one tab stop, the selected option (else the first that can be chosen): ↑/↓ move and select,
 * skipping options that cannot be chosen.
 */
export function ChoiceList<T extends string>({
  label,
  value,
  options,
  onValueChange,
  autoFocus = false,
  reselect = false,
  className,
}: {
  label: string
  value: T | undefined
  options: ReadonlyArray<ChoiceOption<T>>
  onValueChange: (value: T) => void
  /** Pressing the chosen option reports it too: a picker's sheet closes on it, as it does on any other choice. */
  reselect?: boolean
  /** A dialog or sheet that opens on this list puts focus on its tab stop (data-autofocus). */
  autoFocus?: boolean
  className?: string
}) {
  const id = useId()
  const rows = useRef<Array<HTMLButtonElement | null>>([])
  const selected = options.findIndex(option => option.value === value)
  const usable = (index: number) => options[index] !== undefined && options[index].disabledReason === undefined
  const stop = selected >= 0 ? selected : options.findIndex((_, index) => usable(index))
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focused = rows.current.findIndex(item => item === event.target)
    const index = nextIndex(event.key, focused >= 0 ? focused : Math.max(0, selected), options.length, 'vertical', usable)
    if (index === undefined) return
    event.preventDefault()
    rows.current[index]?.focus()
    const option = options[index]
    if (option && option.value !== value) onValueChange(option.value)
  }
  return (
    <div className={cx('ui-choice-list', className)} role="radiogroup" aria-label={label} onKeyDown={keydown}>
      {options.map((option, index) => {
        const checked = index === selected
        const disabled = option.disabledReason !== undefined
        const noteId = `${id}-${index}`
        return (
          <button
            key={option.value}
            ref={element => {
              rows.current[index] = element
            }}
            type="button"
            role="radio"
            className="ui-choice"
            aria-checked={checked}
            aria-disabled={disabled || undefined}
            aria-labelledby={`${noteId}-title`}
            aria-describedby={option.description || disabled ? noteId : undefined}
            tabIndex={index === stop ? 0 : -1}
            data-autofocus={autoFocus && index === stop ? '' : undefined}
            onClick={() => {
              if (!disabled && (!checked || reselect)) onValueChange(option.value)
            }}>
            <span className="ui-choice-radio" aria-hidden="true" />
            {option.media && <span className="ui-choice-media">{option.media}</span>}
            <span className="ui-choice-text">
              <span id={`${noteId}-title`} className="ui-choice-label">
                <span className="ui-choice-title">{option.title}</span>
                {option.tag}
              </span>
              <span id={noteId} className="ui-choice-notes">
                {option.description && (
                  <span className="ui-choice-description">
                    {option.description}
                    {checked && option.risk && <Icon icon={ShieldAlertGlyph} size={12} className="ui-choice-risk" />}
                  </span>
                )}
                {disabled && (
                  <span className="ui-choice-reason">
                    <Icon icon={BlockedGlyph} size={12} />
                    {option.disabledReason}
                  </span>
                )}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
