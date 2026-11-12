import { useLayoutEffect, useRef } from 'react'
import { ICON_STROKE, type IconComponent, type IconSize } from './glyphs/glyph.tsx'
import { cx } from './internal.ts'
import { usePausedOffscreen } from './motion.tsx'

export { ICON_STROKE, type IconComponent, type IconSize }

/**
 * An icon at one of the five sizes, from either set: Latch's own glyphs (`./glyphs`, drawn on a 16 grid) or Lucide (ISC)
 * for the long tail, both at the same on-screen line (`ICON_STROKE`). `solid` shows a Latch glyph's solid variant, for the
 * selected or current item; a Lucide glyph has none and stays as it is. It is decorative unless it has a label, which
 * names it for screen readers. A size off the scale is a type error.
 */
export function Icon({
  icon,
  size = 16,
  solid = false,
  label,
  className,
}: {
  icon: IconComponent
  size?: IconSize
  solid?: boolean
  label?: string
  className?: string
}) {
  const Glyph = (solid && icon.solid) || icon
  return (
    <Glyph
      className={cx('ui-icon', className)}
      size={size}
      strokeWidth={ICON_STROKE[size]}
      nonScalingStroke
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
 * Every spinner on the page turns in step: once its turn has started, its start time is moved back to a whole number
 * of turns on the document timeline, so two spinners side by side share one phase however many frames each took to
 * start. It pauses out of view; reduced motion stops it on its still frame, which still reads as waiting.
 */
export function Spinner({ size = 14, label, className }: { size?: SpinnerSize; label?: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const turn = ref.current
      ?.getAnimations()
      .find((item): item is CSSAnimation => item instanceof CSSAnimation && item.animationName === 'ui-spin')
    if (!turn) return undefined
    let mounted = true
    // The start time is only known once the turn is ready, a frame or more after mount (more on a busy page); a turn
    // already paused out of view is left alone, since giving it a start time would set it running.
    turn.ready.then(
      started => {
        const start = started.startTime
        if (mounted && started.playState === 'running' && typeof start === 'number') started.startTime = Math.floor(start / TURN) * TURN
      },
      () => undefined,
    )
    return () => {
      mounted = false
    }
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
