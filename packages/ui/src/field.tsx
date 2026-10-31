import { useId, useRef, type ComponentProps, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { Icon } from './icon.tsx'
import { cx, mergeRefs } from './internal.ts'

type InputProps = Omit<ComponentProps<'input'>, 'size'>
type TextAreaProps = ComponentProps<'textarea'>

interface FieldText {
  /** Above the input, 12/16·500. */
  label: ReactNode
  /** Below the input: what to enter or what happens to it. */
  hint?: ReactNode
  /** Replaces the hint and turns the ring red: the reason and how to fix it. */
  error?: ReactNode
  className?: string
}

/** Label above, input, then the hint or error under it; wires the note to the input as its description. */
function Field({
  label,
  hint,
  error,
  className,
  describedBy,
  render,
}: FieldText & { describedBy?: string; render: (props: ControlProps) => ReactNode }) {
  const id = useId()
  const noteId = `${id}-note`
  const note = error ?? hint
  return (
    <div className={cx('ui-field', className)}>
      <label className="ui-field-label" htmlFor={id}>
        {label}
      </label>
      <div className="ui-field-control">
        {render({
          id,
          className: 'ui-input',
          'aria-invalid': error ? true : undefined,
          'aria-describedby': note ? cx(describedBy, noteId) : describedBy,
        })}
        {note && (
          <p id={noteId} className={error ? 'ui-field-error' : 'ui-field-hint'}>
            {note}
          </p>
        )}
      </div>
    </div>
  )
}

interface ControlProps {
  id: string
  className: string
  'aria-invalid': true | undefined
  'aria-describedby': string | undefined
}

/**
 * A labelled text field: raised inside a 1px line-strong ring that turns accent, with a soft halo, while focused. The
 * placeholder (in faint ink) shows an example or the purpose (「例如：工作电脑」), never 「请输入…」. 32px on desktop; 44px
 * with 16px text on phones, so iOS does not zoom on focus.
 */
export function TextField({ label, hint, error, className, ...props }: FieldText & InputProps) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      className={className}
      describedBy={props['aria-describedby']}
      render={control => <input {...props} {...control} />}
    />
  )
}

/** The multi-line text field: the same surface, ring and notes as TextField, resizable in height. */
export function TextAreaField({ label, hint, error, className, ...props }: FieldText & TextAreaProps) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      className={className}
      describedBy={props['aria-describedby']}
      render={control => <textarea {...props} {...control} />}
    />
  )
}

/**
 * A search field inside a page: a soft fill with a leading search glyph and, once there is text, a clear button;
 * focused, it rises with the accent ring of a text field. Escape clears it first. `trailing` shows while it is
 * empty, for example the key that focuses it. The `ghost` variant is a row of a column on the sidebar, such as the
 * sidebar's search: nothing at rest, the hover fill under the pointer, and the raised field with its ring only while
 * it has focus.
 */
export function SearchField({
  label,
  value,
  onValueChange,
  clearLabel = '清除搜索',
  trailing,
  variant = 'fill',
  className,
  ref,
  onKeyDown,
  ...props
}: Omit<InputProps, 'value' | 'onChange' | 'type'> & {
  /** The accessible name; the placeholder defaults to it. */
  label: string
  value: string
  onValueChange: (value: string) => void
  clearLabel?: string
  trailing?: ReactNode
  variant?: 'fill' | 'ghost'
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className={cx('ui-search', className)} data-variant={variant === 'ghost' ? 'ghost' : undefined}>
      <Icon icon={Search} size={variant === 'ghost' ? 16 : 14} className="ui-search-glyph" />
      <input
        placeholder={label}
        {...props}
        ref={mergeRefs(ref, input)}
        type="search"
        aria-label={label}
        value={value}
        onChange={event => {
          onValueChange(event.target.value)
        }}
        onKeyDown={event => {
          onKeyDown?.(event)
          if (event.key === 'Escape' && value && !event.defaultPrevented) {
            event.preventDefault()
            event.stopPropagation()
            onValueChange('')
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="ui-search-clear"
          aria-label={clearLabel}
          onClick={() => {
            onValueChange('')
            input.current?.focus()
          }}>
          <Icon icon={X} size={14} />
        </button>
      ) : (
        trailing
      )}
    </div>
  )
}
