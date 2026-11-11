import { cx } from './internal.ts'

/** sm: 3px cells a pixel apart, 8 tall (a status line); md: 14px cells two apart, 10 tall (a legend or a panel). */
export type MeterSize = 'sm' | 'md'

/**
 * How full something is (the context window), as a run of cells rather than a pill: a whole number of cells at a
 * whole-pixel pitch, so it stays crisp at every width and never shimmers. The caller gives the numbers; the filled
 * cells are the share rounded to the nearest cell, and anything above zero fills at least one. Filled cells are meter
 * ink on the track grey, never a colour, and nothing moves: a new value just shows. The meter is read as a meter with
 * its label and `valueText` (「62k / 128k」), which the caller usually also writes beside it.
 */
export function Meter({
  value,
  max,
  label,
  valueText,
  cells = 12,
  size = 'sm',
  className,
}: {
  value: number
  max: number
  /** What it measures (上下文), its accessible name. */
  label: string
  /** The value in words, as the page writes it. */
  valueText?: string
  /** A whole number of cells; 12 by default. */
  cells?: number
  size?: MeterSize
  className?: string
}) {
  const count = Math.max(1, Math.round(cells))
  const share = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0
  const filled = share > 0 ? Math.max(1, Math.round(share * count)) : 0
  return (
    <span
      className={cx('ui-meter', className)}
      data-size={size}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(Math.max(value, 0), max)}
      aria-valuetext={valueText}>
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="ui-meter-cell" data-on={index < filled ? '' : undefined} />
      ))}
    </span>
  )
}
