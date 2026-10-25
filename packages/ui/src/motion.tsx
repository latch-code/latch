import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { motionAllowed } from './changes.ts'
import { cx } from './internal.ts'

/**
 * The motion tokens of tokens.css in milliseconds, for scripts that time something to a transition. A test keeps the
 * two equal.
 */
export const MOTION = {
  fast: 120,
  base: 180,
  slow: 240,
  fastExit: 90,
  baseExit: 140,
  slowExit: 180,
  stagger: 40,
  shimmer: 1600,
  hint: 300,
} as const

/** How long a closing disclosure may take before it counts as closed even without its transitionend. */
const CLOSE_FALLBACK = MOTION.baseExit + 200

/**
 * A disclosure's body. Opening, the box grows downward under its fixed header (its grid row goes from 0fr to 1fr over
 * 180ms on the entry curve) while the content fades in over 120ms, 40ms behind; closing takes 140ms on the exit curve
 * with the content fading first. Height is animated only through the grid row, so whatever is laid out above it never
 * moves; the reading position keeps the reader's place across the frames (a resize of the content it watches).
 *
 * While closed the body stays in the document as `hidden="until-found"`, out of the focus order and the accessibility
 * tree yet reachable by the browser's find, which asks to open it (`onReveal`); while it closes it is inert. With
 * `lazy` the body is first rendered when it first opens and kept after that, for heavy content such as a tool's output.
 * Without motion it opens and closes at once.
 */
export function Collapse({
  open,
  onReveal,
  lazy = false,
  className,
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & {
  open: boolean
  /** The browser's find matched text inside the closed body: the owner should open it. */
  onReveal?: () => void
  lazy?: boolean
  children: ReactNode
}) {
  const inner = useRef<HTMLDivElement>(null)
  // The open prop as last rendered, so a change is applied during the render that receives it.
  const [shownOpen, setShownOpen] = useState(open)
  const [phase, setPhase] = useState<'open' | 'closing' | 'closed'>(open ? 'open' : 'closed')
  // Once open and still, the content may overflow the box (focus rings, rows that reach past the column).
  const [settled, setSettled] = useState(open)
  const [mounted, setMounted] = useState(open || !lazy)
  if (shownOpen !== open) {
    setShownOpen(open)
    if (open) {
      setMounted(true)
      setPhase('open')
    } else {
      setSettled(false)
      setPhase(phase === 'closed' ? 'closed' : 'closing')
    }
  }
  const reveal = useRef(onReveal)
  useLayoutEffect(() => {
    reveal.current = onReveal
  })

  // Without a transitionend (no motion, or nothing laid out) the change still completes.
  useEffect(() => {
    if (phase === 'closing') {
      const timer = setTimeout(() => {
        setPhase(current => (current === 'closing' ? 'closed' : current))
      }, CLOSE_FALLBACK)
      return () => {
        clearTimeout(timer)
      }
    }
    if (phase === 'open' && !settled) {
      const timer = setTimeout(
        () => {
          setSettled(true)
        },
        motionAllowed() ? MOTION.base + 200 : 0,
      )
      return () => {
        clearTimeout(timer)
      }
    }
    return undefined
  }, [phase, settled])

  // `hidden` and `inert` are set on the element: React does not know the until-found value.
  useLayoutEffect(() => {
    const element = inner.current
    if (!element) return
    if (phase === 'closed') element.setAttribute('hidden', 'until-found')
    else element.removeAttribute('hidden')
    element.inert = phase === 'closing'
  }, [phase])

  useEffect(() => {
    const element = inner.current
    if (!element) return undefined
    const match = () => {
      reveal.current?.()
    }
    element.addEventListener('beforematch', match)
    return () => {
      element.removeEventListener('beforematch', match)
    }
  }, [])

  return (
    <div
      {...props}
      className={cx('ui-collapse', className)}
      data-state={phase}
      data-settled={settled && phase === 'open' ? '' : undefined}
      onTransitionEnd={event => {
        if (event.target !== event.currentTarget || event.propertyName !== 'grid-template-rows') return
        if (phase === 'closing') setPhase('closed')
        else if (phase === 'open') setSettled(true)
      }}>
      <div ref={inner} className="ui-collapse-inner">
        {mounted ? children : null}
      </div>
    </div>
  )
}

/**
 * Swaps what it shows when `value` changes: the new content fades in over 120ms, scaling up from 80% for a glyph (a copy
 * icon turning into a check) or in place for words (`effect="fade"`, a label that changes its tense). The first render
 * and reduced motion show it at once.
 */
export function Swap({
  value,
  effect = 'scale',
  className,
  children,
}: {
  value: string | number | boolean
  effect?: 'scale' | 'fade'
  className?: string
  children: ReactNode
}) {
  const [first] = useState(value)
  const [changed, setChanged] = useState(false)
  if (!changed && !Object.is(value, first)) setChanged(true)
  return (
    <span key={String(value)} className={cx('ui-swap', className)} data-effect={effect} data-swapped={changed ? '' : undefined}>
      {children}
    </span>
  )
}

/**
 * Keeps something on screen while it leaves: `present` stays true for `exit` milliseconds after `show` turns false,
 * with `leaving` true meanwhile so its stylesheet can fade it out. Without motion it leaves at once.
 */
export function usePresence(show: boolean, exit: number = MOTION.fastExit): { present: boolean; leaving: boolean } {
  const [present, setPresent] = useState(show)
  if (show && !present) setPresent(true)
  useEffect(() => {
    if (show || !present) return undefined
    const timer = setTimeout(
      () => {
        setPresent(false)
      },
      motionAllowed() ? exit : 0,
    )
    return () => {
      clearTimeout(timer)
    }
  }, [show, present, exit])
  return { present: show || present, leaving: !show && present }
}

/**
 * A short live label (正在思考, a run's phase) with a narrow light crossing its words from left to right, once every
 * 1.6s, by moving the gradient behind the clipped text. It is the only text that moves; its still frame (and reduced
 * motion) is the plain label in hint ink.
 */
export function Shimmer({ className, children, ...props }: ComponentProps<'span'>) {
  return (
    <span {...props} className={cx('ui-shimmer', className)}>
      {children}
    </span>
  )
}
