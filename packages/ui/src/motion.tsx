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
} as const

/** The easing tokens of tokens.css, for animations started from scripts (the Web Animations API). */
export const EASING = {
  micro: 'cubic-bezier(0.2, 0, 0, 1)',
  enter: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  panel: 'cubic-bezier(0.32, 0.72, 0, 1)',
  sheet: 'cubic-bezier(0.32, 0.72, 0, 1)',
  push: 'cubic-bezier(0.32, 0.72, 0, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
} as const

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
export function Shimmer({ className, children, ref, ...props }: ComponentProps<'span'>) {
  const own = useRef<HTMLSpanElement>(null)
  usePausedOffscreen(own)
  return (
    <span {...props} ref={mergeRefs(ref, own)} className={cx('ui-shimmer', className)}>
      {children}
    </span>
  )
}
