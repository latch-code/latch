import { useLayoutEffect, useRef, type ComponentProps, type MouseEvent, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Icon, Spinner, type IconSize, type LucideIcon } from './icon.tsx'
import { cx, mergeRefs } from './internal.ts'
import { Swap } from './motion.tsx'
import { Tooltip } from './tooltip.tsx'

/**
 * primary: the one blue action of a card, dialog or page, only for something that executes or creates.
 * secondary: a soft neutral fill with no ring; inside an amber or red tint (`data-tint` on the container) it is
 * outlined instead. outline: raised with a line-strong ring, the quiet partner of a primary (拒绝 beside 允许).
 * ghost: no fill until hovered, for toolbars, row ends and quiet actions such as 重置. link: accent text, only for
 * going to another page or place. danger: an action with consequences on a page, an outline button with red words.
 * destroy: the solid red confirmation, only inside a confirmation dialog.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'link' | 'danger' | 'destroy'
/** xs 24 (notices, tray rows, inspector), sm 28 (the desktop default), md 32 (dialog and panel footers), lg 44 (phones). */
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

const GLYPH: Record<ButtonSize, Exclude<IconSize, 24>> = { xs: 12, sm: 14, md: 14, lg: 20 }

type ButtonProps = Omit<ComponentProps<'button'>, 'disabled'> & {
  variant?: ButtonVariant
  size?: ButtonSize
  /** One leading icon at most. */
  icon?: LucideIcon
  /** Ends with chevron-down: the button opens a menu of actions. Nothing else may trail a label. */
  menu?: boolean
  /** Running: the width stays, a spinner replaces the leading icon and `loadingLabel` (「检测中…」) the label. */
  loading?: boolean
  loadingLabel?: ReactNode
  /**
   * The action has opened something of the system's (Touch ID, a file dialog): a spinner stands in place of the leading
   * glyph, or over the words of a button without one, while the width stays. It takes no clicks until it is lowered.
   */
  pending?: boolean
  /** It worked: a green tick morphs in where the glyph stood and `doneLabel` replaces the words. It takes no clicks. */
  done?: boolean
  doneLabel?: ReactNode
  /** Stays focusable (aria-disabled) so its tooltip can say why; a click does nothing. */
  disabled?: boolean
  /** Shown on hover and keyboard focus: a shortcut's action, or the reason a disabled button cannot be used. */
  tooltip?: ReactNode
  shortcut?: string
  block?: boolean
}

/** Swallows the click of a disabled or running control, so even a submit button does nothing. */
function guard(inactive: boolean, onClick: ((event: MouseEvent<HTMLButtonElement>) => void) | undefined) {
  return (event: MouseEvent<HTMLButtonElement>) => {
    if (inactive) {
      event.preventDefault()
      return
    }
    onClick?.(event)
  }
}

/**
 * A text button. Pressing scales it to .97 for a moment (not a button that opens a menu). Keep to two visible buttons
 * per card, dialog footer or panel header (the quieter one first, the primary last); a third action goes into a ⋯
 * menu. Keyboard shortcuts go in the tooltip, never inside the button.
 */
export function Button({
  variant = 'secondary',
  size = 'sm',
  icon,
  menu = false,
  loading = false,
  loadingLabel,
  pending = false,
  done = false,
  doneLabel,
  disabled = false,
  tooltip,
  shortcut,
  block = false,
  type = 'button',
  className,
  children,
  onClick,
  ref,
  style,
  ...props
}: ButtonProps) {
  const own = useRef<HTMLButtonElement>(null)
  const width = useRef(0)
  // While it runs the button keeps at least the width it had before: the running label may be wider, never narrower.
  const held = loading || pending || done
  useLayoutEffect(() => {
    const element = own.current
    if (!element) return
    if (held) element.style.minWidth = `${width.current}px`
    else {
      element.style.removeProperty('min-width')
      width.current = element.offsetWidth
    }
  })
  // Words alone keep their place under the spinner, so a button without a glyph does not grow when it waits.
  const over = pending && !loading && !icon
  const glyph = loading || (pending && icon) ? <Spinner size={GLYPH[size]} /> : icon ? <Icon icon={icon} size={GLYPH[size]} /> : null
  const lead = done ? (
    <Swap value="done" className="ui-button-tick">
      <Icon icon={Check} size={GLYPH[size]} />
    </Swap>
  ) : (
    glyph
  )
  const words = done && doneLabel !== undefined ? doneLabel : loading && loadingLabel !== undefined ? loadingLabel : children
  const button = (
    <button
      {...props}
      ref={mergeRefs(ref, own)}
      type={type}
      className={cx('ui-button', className)}
      data-variant={variant}
      data-size={size}
      data-leading={lead ? '' : undefined}
      data-block={block ? '' : undefined}
      data-menu={menu ? '' : undefined}
      // A running button is busy, not disabled: it keeps its colours (the primary its blue) even when the caller also
      // disables it for the duration, and it still takes no clicks.
      aria-disabled={(disabled && !held) || undefined}
      aria-busy={loading || pending || undefined}
      data-pending={over ? '' : undefined}
      style={style}
      onClick={guard(disabled || held, onClick)}>
      {lead}
      {over ? (
        <>
          <span className="ui-button-words">{words}</span>
          <Spinner size={GLYPH[size]} className="ui-button-over" />
        </>
      ) : (
        words
      )}
      {menu && <Icon icon={ChevronDown} size={12} className="ui-button-chevron" />}
    </button>
  )
  // Always inside the tooltip, which renders nothing more without content: the button keeps its place in the tree.
  return (
    <Tooltip content={tooltip ?? (shortcut ? children : undefined)} shortcut={shortcut}>
      {button}
    </Tooltip>
  )
}

/**
 * A link drawn as a button: the link variant by default, for going to another page or place (an external page opens
 * in a new tab when the caller says so with `target`).
 */
export function ButtonLink({
  variant = 'link',
  size = 'sm',
  icon,
  className,
  children,
  ...props
}: ComponentProps<'a'> & { variant?: ButtonVariant; size?: ButtonSize; icon?: LucideIcon }) {
  return (
    <a {...props} className={cx('ui-button', className)} data-variant={variant} data-size={size} data-leading={icon ? '' : undefined}>
      {icon && <Icon icon={icon} size={GLYPH[size]} />}
      {children}
    </a>
  )
}

/** Square icon buttons: 24, 28, 32 and a 44 circle, with 14, 16, 16 and 20 glyphs. */
export type IconButtonSize = ButtonSize
const ICON_GLYPH: Record<IconButtonSize, IconSize> = { xs: 14, sm: 16, md: 16, lg: 20 }

type IconButtonProps = Omit<ComponentProps<'button'>, 'children' | 'disabled'> & {
  /** The accessible name and the tooltip. */
  label: string
  icon: LucideIcon
  size?: IconButtonSize
  /** A toggle: on is the hover fill with ink, never blue. */
  pressed?: boolean
  /** A circle, for the composer's send and stop. */
  round?: boolean
  disabled?: boolean
  /** Replaces the label in the tooltip, for example the reason a disabled button cannot be used. */
  tooltip?: ReactNode
  shortcut?: string
  /** A count past the face's top-right corner; the label must say the same thing, since it is hidden from screen readers. */
  badge?: ReactNode
  /** A change of glyph (copy turning into a check) swaps in: it scales up from 80% as it fades in. */
  swap?: boolean
}

/**
 * An icon-only button. Its label is its accessible name and its tooltip. Its face (the fills and the focus ring) keeps
 * the button's size everywhere; on touch screens the box around it grows to 44×44, and where a dense row keeps the
 * box small the tap target still reaches 44×44 around the face.
 */
export function IconButton({
  label,
  icon,
  size = 'sm',
  pressed,
  round = false,
  disabled = false,
  tooltip,
  shortcut,
  badge,
  swap = false,
  type = 'button',
  className,
  onClick,
  ...props
}: IconButtonProps) {
  const glyph = <Icon icon={icon} size={ICON_GLYPH[size]} />
  return (
    <Tooltip content={tooltip ?? label} shortcut={shortcut} describe={tooltip !== undefined && tooltip !== label}>
      <button
        {...props}
        type={type}
        className={cx('ui-icon-button', className)}
        data-size={size}
        data-round={round ? '' : undefined}
        aria-label={label}
        aria-pressed={pressed}
        aria-disabled={disabled || undefined}
        onClick={guard(disabled, onClick)}>
        {swap ? <Swap value={icon.displayName ?? String(icon)}>{glyph}</Swap> : glyph}
        {badge !== undefined && (
          <span className="ui-icon-button-badge" aria-hidden="true">
            {badge}
          </span>
        )}
      </button>
    </Tooltip>
  )
}
