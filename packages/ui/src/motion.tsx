import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react'
import { motionAllowed } from './changes.ts'
import { cx, mergeRefs } from './internal.ts'

/**
 * The motion tokens of tokens.css in milliseconds, for scripts that time something to a transition, with each exit at
 * 70% of its entrance. A test keeps them equal to the stylesheet.
 */
export const MOTION = {
  micro: 120,
  enter: 160,
  panel: 200,
  sheet: 260,
  push: 320,
  microExit: 84,
  enterExit: 112,
  panelExit: 140,
  sheetExit: 182,
  pushExit: 224,
  /** A control going down; its release settles over `settle`. */
  press: 80,
  /** The cover that crosses a resolved card. */
  wipe: 140,
  /** A spring coming to rest. */
  settle: 420,
  /** A count's figure rolling to its new value. */
  roll: 240,
  /** The step between a menu's items as they arrive. */
  stagger: 18,
  /** One pass of a running row's light, and one pulse of the live dot. */
  edge: 2400,
  breath: 2400,
  /** The light that crosses a finished action once. */
  sheen: 480,
} as const

/** The easing tokens of tokens.css, for animations started from scripts (the Web Animations API). */
export const EASING = {
  micro: 'cubic-bezier(0.2, 0, 0, 1)',
  enter: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  panel: 'cubic-bezier(0.32, 0.72, 0, 1)',
  sheet: 'cubic-bezier(0.32, 0.72, 0, 1)',
  push: 'cubic-bezier(0.32, 0.72, 0, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
  /** What a person set off and lands: damping 0.72, 3.8% past its target. */
  spring:
    'linear(0, 0.088, 0.277, 0.487, 0.675, 0.822, 0.925, 0.989, 1.023, 1.037, 1.038, 1.032, 1.025, 1.017, 1.01, 1.005, 1.002, 1, 0.999, 0.999, 1)',
  /** What must arrive exactly: damping 0.85, 0.6% past its target. */
  settle:
    'linear(0, 0.064, 0.203, 0.364, 0.519, 0.652, 0.76, 0.841, 0.901, 0.943, 0.97, 0.988, 0.998, 1.003, 1.006, 1.006, 1.005, 1.003, 1.001, 1)',
} as const

/** The working label's sweep; ui-working in motion.css runs the same length. */
const WORKING_SWEEP = 2200

/** How long a closing disclosure may take before it counts as closed even without its transitionend. */
const CLOSE_FALLBACK = MOTION.panelExit + 200

/**
 * A disclosure's body. Opening, the box grows downward under its fixed header (its grid row goes from 0fr to 1fr) while
 * its content fades in, both over --m-panel; closing takes 70% of that on the exit curve. Height is animated only
 * through the grid row, so whatever is laid out above it never moves; the reading position keeps the reader's place
 * across the frames (a resize of the content it watches).
 *
 * The first render shows the state it is given at once, so a restored page never animates. While closed the body
 * stays in the document as `hidden="until-found"`, out of the focus
 * order and the accessibility tree yet reachable by the browser's find, which asks to open it (`onReveal`); while it
 * closes it is inert. With `lazy` the body is first rendered when it first opens and kept after that, for heavy
 * content such as a tool's output. Without motion it only fades, within 120ms.
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
        motionAllowed() ? MOTION.panel + 200 : 0,
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
        // On a busy frame the browser can move a transition's start later after it began: it reports an end that took
        // no time and then runs the whole transition. Only the end that took its time is the end.
        if (event.elapsedTime === 0) return
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
 * Swaps what it shows when `value` changes, over --m-micro: a glyph scales up from 80% as it fades in (a copy icon
 * turning into a check), words fade in place (`effect="fade"`, a label that changes its tense). The first render
 * shows it at once; reduced motion only fades.
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
export function usePresence(show: boolean, exit: number = MOTION.microExit): { present: boolean; leaving: boolean } {
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

/** The loops on the page that are out of view, paused by their stylesheets through `data-offscreen`. */
let offscreen: IntersectionObserver | undefined

/**
 * Pauses a loop (a spinner, the thinking shimmer, a skeleton, a tile's arc) while it is out of the window, so nothing loops where nobody sees it.
 * A loop keeps its phase while paused.
 */
export function usePausedOffscreen(ref: RefObject<Element | null>): void {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver !== 'function') return undefined
    offscreen ??= new IntersectionObserver(entries => {
      for (const entry of entries) entry.target.toggleAttribute('data-offscreen', !entry.isIntersecting)
    })
    const observer = offscreen
    observer.observe(element)
    return () => {
      observer.unobserve(element)
      element.removeAttribute('data-offscreen')
    }
  }, [ref])
}

/**
 * Live words that are thinking (正在思考, a run's phase): after 600ms a light crosses them once over 1s, then they
 * rest until the next 4s cycle; only the gradient behind the clipped text moves, and it pauses out of view. Its still
 * frame, and what reduced motion shows, is the plain words in muted ink.
 */
export function Shimmer({
  variant = 'thinking',
  className,
  children,
  ref,
  style,
  ...props
}: ComponentProps<'span'> & {
  /** working: the label of running work, a 2.2s sweep in 30 steps with no rest, on one clock shared across the page. */
  variant?: 'thinking' | 'working'
}) {
  const own = useRef<HTMLSpanElement>(null)
  usePausedOffscreen(own)
  // Started part-way through by the page's clock, so every working label in view sweeps together.
  const [phase] = useState(() => (typeof performance === 'undefined' ? 0 : performance.now() % WORKING_SWEEP))
  return (
    <span
      {...props}
      ref={mergeRefs(ref, own)}
      className={cx('ui-shimmer', className)}
      data-variant={variant === 'working' ? variant : undefined}
      style={variant === 'working' ? { ...style, '--shimmer-phase': `${-Math.round(phase)}ms` } : style}>
      {children}
    </span>
  )
}
