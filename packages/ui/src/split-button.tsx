import type { ComponentProps, ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button, type ButtonSize } from './button.tsx'
import { Icon, type LucideIcon } from './icon.tsx'
import { cx } from './internal.ts'
import { Menu, type MenuSection } from './menu.tsx'
import { Tooltip } from './tooltip.tsx'

/**
 * An action with the rest of its family behind a chevron (提交 ⌄): one face, two controls and two tab stops. The menu
 * lines up with the button's right edge. Disabling it says why in `tooltip`, and the chevron stays usable unless
 * `menuDisabled` says otherwise, since the menu can hold what is still possible.
 */
export function SplitButton({
  variant = 'outline',
  size = 'sm',
  menuLabel,
  sections,
  menuWidth,
  menuDisabled = false,
  className,
  children,
  ...button
}: Omit<ComponentProps<typeof Button>, 'variant' | 'size' | 'menu' | 'block'> & {
  variant?: 'outline' | 'primary'
  size?: Exclude<ButtonSize, 'lg'>
  /** The chevron's accessible name, its tooltip and the menu's name: 更多 Git 操作. */
  menuLabel: string
  sections: MenuSection[]
  menuWidth?: number
  menuDisabled?: boolean
}) {
  return (
    <span className={cx('ui-split', className)} data-variant={variant} data-size={size}>
      <Button {...button} variant={variant} size={size}>
        {children}
      </Button>
      <Menu
        label={menuLabel}
        sections={sections}
        width={menuWidth}
        align="end"
        trigger={menu => (
          <Tooltip content={menuLabel} describe={false}>
            <button
              ref={menu.ref}
              type="button"
              className="ui-split-more"
              aria-label={menuLabel}
              aria-haspopup={menu['aria-haspopup']}
              aria-expanded={menu['aria-expanded']}
              aria-disabled={menuDisabled || undefined}
              onClick={menuDisabled ? undefined : menu.onClick}
              onKeyDown={menuDisabled ? undefined : menu.onKeyDown}>
              <Icon icon={ChevronDown} size={size === 'xs' ? 12 : 14} />
            </button>
          </Tooltip>
        )}
      />
    </span>
  )
}

/**
 * A value in a settings row that opens its picker: a tile or glyph, the value and a chevron. It draws only the button;
 * spread a `Menu`'s or `ValuePicker`'s trigger props on it, or give it an `onClick`.
 */
export function SelectButton({
  leading,
  icon,
  tone,
  disabled = false,
  className,
  children,
  onClick,
  onKeyDown,
  ...props
}: Omit<ComponentProps<'button'>, 'disabled'> & {
  /** A 16px tile. */
  leading?: ReactNode
  /** A 14px glyph, where there is no tile. */
  icon?: LucideIcon
  /** warn: the value needs attention, for example a model that is gone; the words beside it say so. */
  tone?: 'warn'
  disabled?: boolean
}) {
  const lead = leading ?? (icon ? <Icon icon={icon} size={14} /> : null)
  return (
    <button
      type="button"
      {...props}
      className={cx('ui-select-button', className)}
      data-leading={lead ? '' : undefined}
      data-tone={tone}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      onKeyDown={disabled ? undefined : onKeyDown}>
      {lead}
      <span className="ui-select-button-label">{children}</span>
      <Icon icon={ChevronDown} size={14} className="ui-select-button-chevron" />
    </button>
  )
}
