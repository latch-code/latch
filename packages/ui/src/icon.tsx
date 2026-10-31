import { useLayoutEffect, useRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cx } from './internal.ts'
import { usePausedOffscreen } from './motion.tsx'

export type { LucideIcon }

/**
 * Lucide (ISC) line icons come in five sizes, all at stroke 1.75 except the two smallest, which take 2 so they do not
 * thin out. A size off the scale is a type error.
 */
export const ICON_STROKE = { 12: 2, 14: 2, 16: 1.75, 20: 1.75, 24: 1.75 } as const
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

/** One turn of the spinner, in milliseconds (icon.css turns it in the same time). */
const TURN = 800

/** The spinner's sizes: 12 beside status words and in rows, 14 in buttons and loading lines, 16 and 20 on a page. */
export type SpinnerSize = Exclude<IconSize, 24>

/**
 * The spinner: a ring of its colour at 22% with one quarter in full, turning once every 800ms. It takes the colour of
 * the text around it (ink beside 运行中, muted in a loading line, the button's text inside a button), never blue.
 * Every spinner on the page turns in step: the delay set after mount puts it at the document timeline's phase, so two
 * spinners side by side never drift apart. It pauses out of view; reduced motion stops it on its still frame, which
 * still reads as waiting.
 */
export function Spinner({ size = 14, label, className }: { size?: SpinnerSize; label?: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const now = document.timeline.currentTime
    if (ref.current && typeof now === 'number') ref.current.style.animationDelay = `${-(now % TURN)}ms`
  }, [])
  usePausedOffscreen(ref)
  return (
    <span
      ref={ref}
      className={cx('ui-spinner', className)}
      data-size={size}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}
