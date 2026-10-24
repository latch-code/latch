import { useId, type ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { Icon } from './icon.tsx'
import { cx } from './internal.ts'
import { Tooltip } from './tooltip.tsx'

interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** The accessible name when no visible label names the switch (a SwitchRow names it with its title). */
  label?: string
  disabled?: boolean
  /** The tooltip, also read as the switch's description: for example why it is disabled. */
  title?: string
  id?: string
  className?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
}

/**
 * A switch, only for something that turns on or off at once. 32×18 with a 14px thumb on desktop, 44×26 with 22 on
 * touch. Off is the solid track with a 1px ring in the icon colour, which reaches 3:1 against the paper; on is the
 * accent. The thumb is raised white and stretches 4px toward where it is going while pressed. Space toggles it.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  title,
  id,
  className,
  'aria-labelledby': labelledBy,
  'aria-describedby': describedBy,
}: SwitchProps) {
  return (
    <Tooltip content={title}>
      <button
        id={id}
        type="button"
        role="switch"
        className={cx('ui-switch', className)}
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        aria-describedby={describedBy}
        onClick={() => {
          if (!disabled) onCheckedChange(!checked)
        }}>
        <span className="ui-switch-thumb" aria-hidden="true" />
      </button>
    </Tooltip>
  )
}

/**
 * A settings row whose whole line is the switch's label: clicking the title toggles it too, and the row itself does
 * not respond to hover. A switch locked by policy is off and dimmed, with a lock before it and the reason as the
 * description; the person's own choice is kept by the caller and comes back once the lock lifts.
 */
export function SwitchRow({
  title,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  locked,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  /** Why policy keeps it off; shown in place of the description. */
  locked?: ReactNode
  className?: string
}) {
  const id = useId()
  const note = locked ?? description
  return (
    <label className={cx('ui-switch-row', className)} htmlFor={id} data-locked={locked ? '' : undefined}>
      <span className="ui-switch-row-text">
        <span id={`${id}-title`} className="ui-switch-row-title">
          {title}
        </span>
        {note && (
          <span id={`${id}-note`} className="ui-switch-row-description">
            {note}
          </span>
        )}
      </span>
      {locked && <Icon icon={Lock} size={12} className="ui-switch-row-lock" />}
      <Switch
        id={id}
        checked={locked ? false : checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled || locked !== undefined}
        aria-labelledby={`${id}-title`}
        aria-describedby={note ? `${id}-note` : undefined}
      />
    </label>
  )
}
