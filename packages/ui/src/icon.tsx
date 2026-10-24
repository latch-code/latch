import { useLayoutEffect, useRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cx } from './internal.ts'

export type { LucideIcon }

/**
 * Lucide (ISC) line icons come in five sizes, each with its own stroke so the drawn line keeps one weight: about
 * 1.25px up to 16 and 1.5px at 20 and 24. A size off the scale is a type error.
 */
export const ICON_STROKE = { 12: 2.5, 14: 2.15, 16: 1.9, 20: 1.8, 24: 1.5 } as const
export type IconSize = keyof typeof ICON_STROKE

/** A Lucide glyph at one of the five sizes. It is decorative unless it has a label, which names it for screen readers. */
export function Icon({
  icon: Glyph,
  size = 16,
  label,
  className,
}: {
  icon: LucideIcon
  size?: IconSize
  label?: string
  className?: string
}) {
  return (
    <Glyph
      className={cx('ui-icon', className)}
      size={size}
      strokeWidth={ICON_STROKE[size]}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}

/** One turn of the spinner, in milliseconds (base.css and spinner styles use the same value). */
const TURN = 900

/**
 * The running spinner: a faint track and a quarter arc, turning once every 900ms. Running work is ink (text-2), never
 * blue; inside a button it takes the button's text colour. Every spinner on the page turns in step: the delay set
 * after mount puts each one at the document timeline's phase, so two spinners side by side never drift apart.
 */
export function Spinner({ size = 14, label, className }: { size?: Exclude<IconSize, 24>; label?: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const now = document.timeline.currentTime
    if (ref.current && typeof now === 'number') ref.current.style.animationDelay = `${-(now % TURN)}ms`
  }, [])
  return (
    <span
      ref={ref}
      className={cx('ui-spinner', className)}
      data-size={size}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={ICON_STROKE[size]}
        strokeLinecap="round">
        <circle cx="12" cy="12" r="9" strokeOpacity="0.2" />
        <path d="M21 12a9 9 0 0 0-9-9" />
      </svg>
    </span>
  )
}
