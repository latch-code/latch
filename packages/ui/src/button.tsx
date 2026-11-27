import { Component, useRef, type ComponentProps, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { CheckGlyph, ChevronDownGlyph } from './glyphs/index.tsx'
import { Icon, Spinner, type IconSize, type IconComponent } from './icon.tsx'
import { cx, mergeRefs } from './internal.ts'
import { Swap } from './motion.tsx'
import { Kbd, ariaKeyShortcuts } from './pill.tsx'
import { Tooltip } from './tooltip.tsx'

/**
 * primary: the one blue action of a card, dialog or page, only for something that executes or creates.
 * secondary: a soft neutral fill with no ring; inside a warning or a risk (`data-tint` on the container) it is
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
  icon?: IconComponent
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
  /** A shortcut named only in the tooltip (`mod+k`), for a button whose key is not drawn on it. */
  shortcut?: string
  /**
   * The keys that press this button right now, one cap each after the words (`['mod', 'enter']` draws ⌘ ⏎ on a Mac,
   * Ctrl ⏎ elsewhere): only on a control whose key does that thing at this moment. Touch screens hide them; the
   * accessible name stays the words, the keys go to aria-keyshortcuts, and the tooltip does not repeat them.
   */
  keys?: readonly string[]
  /** Keep an active shortcut accessible without drawing key caps inside the button. */
  showKeys?: boolean
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

interface ButtonWidthProps {
  target: RefObject<HTMLButtonElement | null>
  held: boolean
  block: boolean
  minimum: string
  children: ReactNode
}

/** Convert an observed box to the physical CSS width that min-width constrains. */
function measuredWidth(element: HTMLElement, entry?: ResizeObserverEntry): number {
  const style = getComputedStyle(element)
  const borderBox = style.boxSizing === 'border-box'
  if (entry && !borderBox) return entry.contentRect.width
  const box = entry?.borderBoxSize?.[0]
  if (box) return style.writingMode.startsWith('horizontal') ? box.inlineSize : box.blockSize
  if (!entry && borderBox) return element.offsetWidth
  const extra =
    Number.parseFloat(style.paddingLeft)
    + Number.parseFloat(style.paddingRight)
    + Number.parseFloat(style.borderLeftWidth)
    + Number.parseFloat(style.borderRightWidth)
  return entry ? entry.contentRect.width + extra : element.offsetWidth - extra
}

/** Snapshot the idle button before React replaces its words, even when no resize has been delivered yet. */
class ButtonWidth extends Component<ButtonWidthProps> {
  private observer?: ResizeObserver
  private idleSize: ResizeObserverEntry | undefined
  private widest = 0

  private hold(element: HTMLElement): void {
    let { minimum } = this.props
    // A block already follows its container, including when the container gets narrower while it runs.
    if (this.props.held && !this.props.block && this.widest > 0) {
      const held = `${this.widest}px`
      const combined = minimum ? `max(${minimum}, ${held})` : held
      if (!minimum || CSS.supports('min-width', combined)) minimum = combined
    }
    if (element.style.minWidth !== minimum) element.style.minWidth = minimum
  }

  componentDidMount(): void {
    const element = this.props.target.current
    if (!element) return
    if (this.props.held) {
      this.widest = measuredWidth(element)
      this.hold(element)
    }
    this.observer = new ResizeObserver(([entry]) => {
      // A hidden button has no box. Keep its last visible size until it is shown again.
      const border = entry.borderBoxSize?.[0]
      if (entry.contentRect.width === 0 && ((!border?.inlineSize && !border?.blockSize) || measuredWidth(element, entry) <= 0)) return
      if (!this.props.held) {
        this.idleSize = entry
        return
      }
      const width = measuredWidth(element, entry)
      if (width > this.widest) {
        this.widest = width
        this.hold(element)
      }
    })
    this.observer.observe(element, { box: 'border-box' })
  }

  getSnapshotBeforeUpdate(previous: ButtonWidthProps): number | null {
    const element = this.props.target.current
    if (!element || !this.props.held || previous.held) return null
    return measuredWidth(element, this.idleSize)
  }

  componentDidUpdate(previous: ButtonWidthProps, _state: unknown, width: number | null): void {
    if (previous.held === this.props.held && previous.block === this.props.block && previous.minimum === this.props.minimum) return
    if (width !== null && width > 0) this.widest = width
    if (previous.held && !this.props.held) this.idleSize = undefined
    if (this.props.target.current) this.hold(this.props.target.current)
  }

  componentWillUnmount(): void {
    this.observer?.disconnect()
  }

  render(): ReactNode {
    return this.props.children
  }
}

/**
 * A text button. Pressing scales it to .97 for a moment (not a button that opens a menu). Keep to two visible buttons
 * per card, dialog footer or panel header (the quieter one first, the primary last); a third action goes into a ⋯
 * menu. A key that presses it right now is drawn on it as key caps after the words (`keys`); any other shortcut goes in
 * the tooltip.
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
  keys,
  showKeys = true,
  block = false,
  type = 'button',
  className,
  children,
  onClick,
  ref,
  style,
  ...props
}: ButtonProps) {
  const capped = keys !== undefined && keys.length > 0
  const own = useRef<HTMLButtonElement>(null)
  const held = loading || pending || done
  const minimum = typeof style?.minWidth === 'number' ? `${style.minWidth}px` : (style?.minWidth ?? '')
  // Words alone keep their place under the spinner, so a button without a glyph does not grow when it waits.
  const over = pending && !loading && !icon
  const glyph = loading || (pending && icon) ? <Spinner size={GLYPH[size]} /> : icon ? <Icon icon={icon} size={GLYPH[size]} /> : null
  const lead = done ? (
    <Swap value="done" className="ui-button-tick">
      <Icon icon={CheckGlyph} size={GLYPH[size]} />
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
      aria-keyshortcuts={capped ? ariaKeyShortcuts(keys) : undefined}
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
      {capped && showKeys && (
        <span className="ui-button-keys" aria-hidden="true">
          <Kbd keys={keys.join('+')} />
        </span>
      )}
      {menu && <Icon icon={ChevronDownGlyph} size={12} className="ui-button-chevron" />}
    </button>
  )
  // Keys drawn on the button are not repeated in its tooltip.
  const tip = capped ? undefined : shortcut
  // Always inside the tooltip, which renders nothing more without content: the button keeps its place in the tree.
  return (
    <ButtonWidth target={own} held={held} block={block} minimum={minimum}>
      <Tooltip content={tooltip ?? (tip ? children : undefined)} shortcut={tip}>
        {button}
      </Tooltip>
    </ButtonWidth>
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
}: ComponentProps<'a'> & { variant?: ButtonVariant; size?: ButtonSize; icon?: IconComponent }) {
  return (
    <a {...props} className={cx('ui-button', className)} data-variant={variant} data-size={size} data-leading={icon ? '' : undefined}>
      {icon && <Icon icon={icon} size={GLYPH[size]} />}
      {children}
    </a>
  )
}

/** Square icon buttons: 24, 28, 32 and a 44 circle, with 14, 16, 16 and 20 glyphs. */
export type IconButtonSize = ButtonSize
const ICON_GLYPH: Record<IconButtonSize, Exclude<IconSize, 24>> = { xs: 14, sm: 16, md: 16, lg: 20 }

type IconButtonProps = Omit<ComponentProps<'button'>, 'children' | 'disabled'> & {
  /** The accessible name and the tooltip. */
  label: string
  icon: IconComponent
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
  /** Running: a spinner stands where the glyph was, at its size, and the button says it is busy. */
  busy?: boolean
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
  busy = false,
  type = 'button',
  className,
  onClick,
  ...props
}: IconButtonProps) {
  const glyph = busy ? <Spinner size={ICON_GLYPH[size]} /> : <Icon icon={icon} size={ICON_GLYPH[size]} />
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
        aria-busy={busy || undefined}
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
