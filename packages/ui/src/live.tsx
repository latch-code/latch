import { useCallback, useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react'
import { TriangleAlert } from 'lucide-react'
import { motionAllowed, useLiveChange } from './changes.ts'
import { Icon } from './icon.tsx'
import { cx } from './internal.ts'
import { StatusDot } from './pill.tsx'

/*
 * Live indicators: only live states move (running, waiting for the person, newly arrived); facts at rest (a time,
 * done, cancelled, failed) never do. The still frame is the default and what reduced motion shows; every animation is
 * declared in styles/live.css under prefers-reduced-motion: no-preference.
 */

/** One turn of a comet, in milliseconds; live.css turns `.ui-comet-drift` in the same time. */
const TURN = 2400
/** The fewest and most slots of the relay; live.css has keyframes for each cycle length between them. */
const RELAY_MIN = 3
const RELAY_MAX = 8
/** One slot of the relay, in milliseconds: live.css gives each slot 1.6s. */
const SLOT = 1600

/**
 * The relay: the visible live items of the window (running comets and waiting pills), numbered from the top down and,
 * on one line, from left to right, take turns doing one small extra thing, so several sessions running at once read as
 * one computer looking after them in turn rather than a row of spinners. Each numbered item gets `--i` (its slot),
 * `--cyc` (the cycle, max(3, n) slots of 1.6s) and `data-relay` (the cycle again, which picks the keyframes); only the
 * first eight relay. An item counts as visible while it is in the window and neither it nor a container is at opacity
 * 0 (a row whose status gives way to its ⋯ button). A numbering restarts all their animations together, so the slots
 * share one start. The items are measured again at every slot boundary (a list reorders without remounting) and a new
 * numbering is applied there, when every lap and sweep is at rest, so none is cut short; only when nothing numbered is
 * still mounted does it apply at once.
 */
class Relay {
  private readonly items = new Set<HTMLElement>()
  private readonly visible = new Set<Element>()
  private observer: IntersectionObserver | null = null
  private order: HTMLElement[] = []
  private cycle = 0
  private frame = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  /** When the current numbering started, on the document timeline; its animations may start a frame later. */
  private start = 0

  add(item: HTMLElement): void {
    this.items.add(item)
    this.observer ??= new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) this.visible.add(entry.target)
        else this.visible.delete(entry.target)
      }
      this.schedule()
    })
    this.observer.observe(item)
    this.schedule()
  }

  remove(item: HTMLElement): void {
    this.items.delete(item)
    this.visible.delete(item)
    this.observer?.unobserve(item)
    clear(item)
    if (this.items.size === 0) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.schedule()
  }

  private readonly schedule = (): void => {
    if (this.frame === 0) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0
        this.number(false)
      })
    }
  }

  /** Measures the visible items; a changed numbering applies at once only if nothing numbered is still mounted. */
  private number(boundary: boolean): void {
    const placed = reading(
      [...this.items]
        .filter(item => this.visible.has(item) && item.isConnected && onScreen(item))
        .map(item => ({ item, box: item.getBoundingClientRect() })),
    )
      .slice(0, RELAY_MAX)
      .map(({ item }) => item)
    const cycle = Math.min(RELAY_MAX, Math.max(RELAY_MIN, placed.length))
    const same = cycle === this.cycle && placed.length === this.order.length && placed.every((item, index) => this.order[index] === item)
    if (!same && (boundary || !this.order.some(item => this.items.has(item)))) this.apply(placed, cycle)
    this.arm()
  }

  private apply(placed: HTMLElement[], cycle: number): void {
    for (const item of this.order) clear(item)
    // Apply the removal before numbering again, so every relay animation starts anew in the same frame.
    if (this.order.length > 0) void document.documentElement.offsetHeight
    placed.forEach((item, index) => {
      item.style.setProperty('--i', String(index))
      item.style.setProperty('--cyc', String(cycle))
      item.setAttribute('data-relay', String(cycle))
    })
    this.order = placed
    this.cycle = cycle
    this.start = timelineNow()
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Measures again at the next slot boundary of the current numbering. */
  private arm(): void {
    if (this.timer !== undefined || this.items.size === 0) return
    const turn = this.order
      .flatMap(item => item.getAnimations({ subtree: true }))
      .find(item => item instanceof CSSAnimation && item.animationName.startsWith('ui-relay-'))
    const start = typeof turn?.startTime === 'number' ? turn.startTime : this.start
    const wait = SLOT - ((((timelineNow() - start) % SLOT) + SLOT) % SLOT)
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.number(true)
      },
      // A boundary only a moment away was this one, reached a little early.
      wait < 50 ? wait + SLOT : wait,
    )
  }
}

const timelineNow = (): number => {
  const time = document.timeline.currentTime
  return typeof time === 'number' ? time : performance.now()
}

/** Whether the item shows: not hidden, and neither it nor a container at opacity 0. */
const onScreen = (item: HTMLElement): boolean =>
  typeof item.checkVisibility !== 'function' || item.checkVisibility({ opacityProperty: true, visibilityProperty: true })

/** How far apart two vertical centres may be and still stand on one line, in pixels. */
const LINE = 8

/**
 * Puts items in reading order: lines from the top down, each from left to right. A line gathers the items whose
 * vertical centres lie within LINE of its first one, so a 16px comet beside a 12px one (or a pill beside a comet) is on
 * the same line although its top is higher.
 */
function reading<T extends { box: DOMRect }>(items: T[]): T[] {
  const lines: T[][] = []
  const centre = ({ box }: T) => box.top + box.height / 2
  for (const item of items.toSorted((a, b) => centre(a) - centre(b))) {
    const line = lines.at(-1)
    if (line?.[0] && centre(item) - centre(line[0]) <= LINE) line.push(item)
    else lines.push([item])
  }
  return lines.flatMap(line => line.toSorted((a, b) => a.box.left - b.box.left))
}

function clear(item: HTMLElement): void {
  item.removeAttribute('data-relay')
  item.style.removeProperty('--i')
  item.style.removeProperty('--cyc')
}

let relay: Relay | undefined

/** Enters `ref`'s element in the window's relay while it is mounted. */
function useRelay(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useLayoutEffect(() => {
    const element = ref.current
    if (!enabled || !element || typeof IntersectionObserver !== 'function') return undefined
    relay ??= new Relay()
    const current = relay
    current.add(element)
    return () => {
      current.remove(element)
    }
  }, [ref, enabled])
}

/**
 * Puts a comet's turn in the shared phase: its delay is minus the start of the turn modulo one turn, so at any moment
 * every comet stands where the document timeline puts it, whenever it started. At mount the turn has not started yet
 * and starts in the coming frame, so the current time stands in for its start.
 */
function align(drift: HTMLElement): void {
  const turn = drift.getAnimations().find(item => item instanceof CSSAnimation && item.animationName === 'ui-comet-turn')
  const start = typeof turn?.startTime === 'number' ? turn.startTime : document.timeline.currentTime
  if (typeof start === 'number') drift.style.animationDelay = `${-(start % TURN)}ms`
}

export type CometSize = 12 | 14 | 16
/** The track's width at each size; the tail is as wide and its round head 1.24 times as wide. */
const COMET_STROKE: Record<CometSize, number> = { 12: 1.5, 14: 1.6, 16: 1.75 }
/** The tail reaches 160° back from the head, along the left side. */
const TAIL = (160 * Math.PI) / 180
/** The tail brightens towards the head: [offset, opacity] from the head down. */
const TAIL_STOPS = [
  [0, 1],
  [0.121, 0.772],
  [0.426, 0.536],
  [0.773, 0.287],
  [1, 0],
] as const

const round = (value: number) => Math.round(value * 1000) / 1000

/** The comet drawn in a 24-unit box: head at 12 o'clock, its tail fading along the left, on the CSS track ring. */
function CometArc({ size }: { size: CometSize }) {
  const id = `ui-comet-${useId().replace(/[^\w-]/gu, '')}`
  const width = (COMET_STROKE[size] * 24) / size
  const radius = 12 - width / 2
  const top = round(12 - radius)
  const end = [round(12 - radius * Math.sin(TAIL)), round(12 - radius * Math.cos(TAIL))] as const
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1={top} x2="0" y2={end[1]}>
          {TAIL_STOPS.map(([offset, opacity]) => (
            <stop key={offset} offset={offset} stopColor="currentColor" stopOpacity={opacity} />
          ))}
        </linearGradient>
      </defs>
      <path
        d={`M12 ${top}A${round(radius)} ${round(radius)} 0 0 0 ${end[0]} ${end[1]}`}
        stroke={`url(#${id})`}
        strokeWidth={round(width)}
      />
      <circle cx="12" cy={top} r={round((width * 1.24) / 2)} fill="currentColor" />
    </svg>
  )
}

/**
 * Running: the comet, 12 in rows, the run bar and process rows, 14 in a tool card, 16 on phones. A faint track carries
 * a tail that brightens into a round head, in ink; it turns once every 2.4s, and every comet on the page turns in one
 * phase (its delay, set at mount and again whenever its turn starts, puts it at the document timeline's phase). Unless
 * `relay` is false it also takes its turn in the window's relay, one extra lap. Its still frame (the head at 12
 * o'clock) is what reduced motion shows and still reads as running; next to words that say it, it is decorative unless
 * `label` names it. A `held` comet no longer runs: it stands where the shared turn had it when it mounted, without
 * motion or a place in the relay, which is what leaves when a run settles.
 */
export function Comet({
  size = 12,
  label,
  relay: relayed = true,
  held = false,
  className,
}: {
  size?: CometSize
  label?: string
  relay?: boolean
  held?: boolean
  className?: string
}) {
  const root = useRef<HTMLSpanElement>(null)
  // Aligned as soon as its turn's element is attached, before the first paint.
  const drift = useCallback((element: HTMLSpanElement | null) => {
    if (element) align(element)
  }, [])
  const [turn] = useState(() => {
    if (!held || typeof document === 'undefined' || !motionAllowed()) return 0
    const now = document.timeline.currentTime
    return typeof now === 'number' ? (now % TURN) / TURN : 0
  })
  useRelay(root, relayed && !held)
  return (
    <span
      ref={root}
      className={cx('ui-comet', className)}
      data-size={size}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
      {held ? (
        <span className="ui-comet-held" style={{ rotate: `${round(turn * 360)}deg` }}>
          <CometArc size={size} />
        </span>
      ) : (
        <span
          ref={drift}
          className="ui-comet-drift"
          onAnimationStart={event => {
            // A turn that starts again (shown after display: none, or once motion is allowed) is put back in phase.
            if (event.target === event.currentTarget && event.animationName === 'ui-comet-turn') align(event.currentTarget)
          }}>
          <span className="ui-comet-lap">
            <CometArc size={size} />
          </span>
        </span>
      )}
    </span>
  )
}

/**
 * Waiting for the person: the amber status pill, such as 待批准 for an approval. When its turn in the window's relay
 * comes, a warm band crosses behind its text from left to right; the rest of the time it is still. The pill and its
 * words say the state on their own.
 */
export function WaitingPill({
  relay: relayed = true,
  className,
  children,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> & { relay?: boolean; children: ReactNode }) {
  const root = useRef<HTMLSpanElement>(null)
  useRelay(root, relayed)
  return (
    <span ref={root} className={cx('ui-status-pill', 'ui-waiting-pill', className)} data-tone="warn" {...props}>
      {children}
    </span>
  )
}

/**
 * What a list row shows in its status slot, one thing at a time: none, a running comet, the waiting pill, failed (the
 * triangle and its words, in red), unread (the ink dot) or the time. The page chooses by priority (waiting, failed,
 * running, unread, the time) and leaves the open session's running comet out, since its run bar says so.
 */
export type SlotStatus = 'none' | 'running' | 'waiting' | 'failed' | 'unread' | 'time'

/**
 * A row's status slot, right-aligned. Two changes settle in place when the page saw them happen: a run that ends with
 * something new draws its comet in as the unread dot appears, and a session that has been read lets its dot sink as
 * the time fades in. The slot is decorative: the row says its status in words for assistive technology.
 */
export function StatusSlot({
  status,
  size = 12,
  waiting = '待批准',
  failed = '失败',
  time,
  dateTime,
  relay: relayed = true,
  className,
}: {
  status: SlotStatus
  /** The comet's size: 12 in desktop rows, 16 on phones. */
  size?: CometSize
  /** Whether its comet or pill takes its turn in the window's relay. */
  relay?: boolean
  /** The waiting pill's words. */
  waiting?: string
  /** The failure's words. */
  failed?: string
  /** The time shown at rest, such as 09:15 or 周三. */
  time?: ReactNode
  dateTime?: string
  className?: string
}) {
  const [settle, setSettle] = useState<{ key: number; kind: 'ring-dot' | 'dot-time' } | null>(null)
  useLiveChange(status, (previous, live) => {
    const kind = previous === 'running' && status === 'unread' ? 'ring-dot' : previous === 'unread' && status === 'time' ? 'dot-time' : null
    if (!live || kind === null) {
      setSettle(null)
      return
    }
    setSettle(current => ({ key: (current?.key ?? 0) + 1, kind }))
  })
  const key = settle?.key ?? 0
  return (
    <span className={cx('ui-status-slot', className)} data-settle={settle?.kind} aria-hidden="true">
      {settle && (
        <span key={`leaving-${key}`} className="ui-status-leaving">
          {settle.kind === 'ring-dot' ? <Comet size={size} held /> : <StatusDot tone="unread" />}
        </span>
      )}
      {status === 'running' ? (
        <Comet size={size} relay={relayed} />
      ) : status === 'waiting' ? (
        <WaitingPill relay={relayed}>{waiting}</WaitingPill>
      ) : status === 'failed' ? (
        <span className="ui-status-failed">
          <Icon icon={TriangleAlert} size={12} />
          {failed}
        </span>
      ) : status === 'unread' ? (
        <StatusDot key={`unread-${key}`} tone="unread" />
      ) : status === 'time' ? (
        <time key={`time-${key}`} className="ui-status-time" dateTime={dateTime}>
          {time}
        </time>
      ) : null}
    </span>
  )
}

/**
 * A process row's status glyph (a tool card, a step of a timeline or a plan): the comet while it runs, otherwise the
 * row's icon. `state` names what the glyph shows and defaults to running or not; when the page sees it change, the old
 * glyph leaves as the new one arrives in the same cell: the old one (a held comet, if it was running) fades out over
 * 120ms on the exit curve while the new one fades in from 80% over 120ms. A change after a resynchronization or a
 * switch of session, the first render and reduced motion show the new glyph at once. Decorative: the row says its
 * state in words.
 */
export function StatusGlyph({
  running = false,
  state = running ? 'running' : 'rest',
  size = 12,
  relay: relayed = true,
  className,
  children,
}: {
  running?: boolean
  state?: string
  /** The comet's size: 12 in rows, 14 in a tool card. */
  size?: CometSize
  /** Whether the running comet takes its turn in the window's relay. */
  relay?: boolean
  className?: string
  /** The icon shown when not running. */
  children?: ReactNode
}) {
  const shown = useRef<{ running: boolean; icon: ReactNode }>({ running, icon: children })
  const [shift, setShift] = useState<{ key: number; leaving: ReactNode } | null>(null)
  useLiveChange(state, (_previous, live) => {
    // Runs before the effect below, so it still holds what the last render showed.
    const before = shown.current
    const leaving = before.running ? <Comet size={size} held /> : before.icon
    setShift(current => (live ? { key: (current?.key ?? 0) + 1, leaving } : null))
  })
  useLayoutEffect(() => {
    shown.current = { running, icon: children }
  })
  return (
    <span className={cx('ui-status-glyph', className)} data-shift={shift ? '' : undefined} aria-hidden="true">
      {shift && (
        <span key={`leaving-${shift.key}`} className="ui-status-glyph-leaving">
          {shift.leaving}
        </span>
      )}
      <span key={`glyph-${shift?.key ?? 0}`} className="ui-status-glyph-current">
        {running ? <Comet size={size} relay={relayed} /> : children}
      </span>
    </span>
  )
}

/**
 * The words of a process row's state (执行中, 完成, 失败…). When the page sees `state` change, the new words rise 4px
 * into place as they fade in, over 120ms; otherwise they just show.
 */
export function StatusWords({ state, className, children, ...props }: ComponentProps<'span'> & { state: string }) {
  const [shift, setShift] = useState(0)
  useLiveChange(state, (_previous, live) => {
    setShift(current => (live ? current + 1 : 0))
  })
  return (
    <span key={shift} className={cx('ui-status-words', className)} data-shift={shift > 0 ? '' : undefined} {...props}>
      {children}
    </span>
  )
}
