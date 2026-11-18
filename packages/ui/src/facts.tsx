import {
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { LiveChanges, motionAllowed, useLiveChange } from './changes.ts'
import { cx } from './internal.ts'
import { MOTION, usePausedOffscreen, usePresence } from './motion.tsx'
import { UI_COPY, useUiLocale } from './locale.ts'
import { keyGlyphs } from './pill.tsx'

/*
 * The small parts of the v9 workbench. Each shows a fact it is given and nothing of its own: a count that rolls when
 * it changes, a reading in the mono face, the segments of a PR's checks, the strip of how this window reaches the
 * Host, a section's title on its rule, the corner ticks round what the keys act on, a key hint that lights while its
 * key is down, the edge of a running row and the dot of a live connection.
 */

/**
 * A fact: a duration, a count, +/−, a branch, a path, a time. Mono with tabular figures, so a column of them lines up
 * and a ticking one keeps its width. `tone` colours it only where the fact itself is a state (added and removed lines).
 */
export function Fact({
  tone,
  className,
  children,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> & { tone?: 'add' | 'del' | 'warn'; children: ReactNode }) {
  return (
    <span className={cx('ui-fact', className)} data-tone={tone} {...props}>
      {children}
    </span>
  )
}

/**
 * A count that rolls when the page sees it change: the old figure rolls out and the new one in over 240ms, upward when
 * the count rises and downward when it falls. On a first render, after a resynchronization (`LiveChanges`) and with
 * reduced motion the new figure is simply there. Only for counts: a duration that ticks every second just changes.
 * A change during a roll restarts it from the figure that was arriving.
 */
export function Roll({ value, label, className }: { value: number; label?: string; className?: string }) {
  const [roll, setRoll] = useState<{ from: number; turn: number; up: boolean } | null>(null)
  useLiveChange(value, (previous, live) => {
    setRoll(current => (live ? { from: previous, turn: (current?.turn ?? 0) + 1, up: value > previous } : null))
  })
  return (
    <span
      className={cx('ui-roll', className)}
      data-roll={roll ? (roll.up ? 'up' : 'down') : undefined}
      {...(label ? { role: 'img', 'aria-label': label } : {})}>
      {roll && (
        <span
          key={`out-${roll.turn}`}
          className="ui-roll-out"
          aria-hidden="true"
          onAnimationEnd={() => {
            setRoll(null)
          }}>
          {roll.from}
        </span>
      )}
      <span key={roll ? `in-${roll.turn}` : 'still'} className="ui-roll-in">
        {value}
      </span>
    </span>
  )
}

/** Above this many checks the bar is not drawn: the figures beside it say it, and the segments would be a ruler. */
const MOST_CHECKS = 12

/**
 * The checks of a pull request as segments, one per check it really has: passed ones green, failed ones red, the rest
 * the track. It draws nothing without real counts (a total of zero, or numbers that are not whole) or above twelve
 * checks; the caller writes 「检查 4/6」 beside it, and the bar repeats that for a screen reader in `label`.
 */
export function ChecksBar({
  passed,
  failed = 0,
  total,
  label,
  className,
}: {
  passed: number
  failed?: number
  total: number
  /** What a screen reader hears; by default 「检查 4/6 通过」 and, with failures, 「，1 项失败」. */
  label?: string
  className?: string
}) {
  useUiLocale()
  const whole = [passed, failed, total].every(count => Number.isInteger(count) && count >= 0)
  if (!whole || total === 0 || total > MOST_CHECKS || passed + failed > total) return null
  return (
    <span className={cx('ui-checks', className)} role="img" aria-label={label ?? UI_COPY.checks(passed, total, failed)}>
      {Array.from({ length: total }, (_, index) => (
        <i key={index} data-state={index < passed ? 'passed' : index < passed + failed ? 'failed' : undefined} />
      ))}
    </span>
  )
}

/** One fact of the status strip. */
export interface StripFact {
  id: string
  /** The fact as the Host or the window reports it (this computer's name, `host.sock`, 「2 台在线」). */
  text: string
  /** A 12px glyph or the live dot before the words. */
  lead?: ReactNode
  /** Pushed to the end of the strip (the palette's key). */
  end?: boolean
}

/**
 * The status strip along the bottom of the window: how this window reaches the Host, in mono. It renders the facts it
 * is given and nothing else (no clock, no version, no placeholder); with none it is not there.
 */
export function StatusStrip({ facts, label, className }: { facts: readonly StripFact[]; label: string; className?: string }) {
  const shown = facts.filter(fact => fact.text.trim() !== '')
  if (shown.length === 0) return null
  return (
    <div className={cx('ui-status-strip', className)} role="group" aria-label={label}>
      {shown.map(fact => (
        <span key={fact.id} className="ui-status-strip-fact" data-end={fact.end ? '' : undefined}>
          {fact.lead}
          {fact.text}
        </span>
      ))}
    </div>
  )
}

/** The resynchronization epochs a section title has been drawn under, so a title can tell arriving from being loaded. */
const epochsSeen = new Set<string | number>()

/**
 * A section's title on its rule: a glyph, the title, its count as a fact, and an action at the end (全部会话 ›). The
 * rule under it is drawn from the start edge (420ms on the settle curve) only for a section the page saw appear: one
 * mounted while the page's `LiveChanges` epoch is one that titles were already shown under. On a first load, after a
 * resynchronization, without a provider and with reduced motion the rule is simply there. A section whose count is
 * zero goes faint and says nothing more.
 */
export function SectionTitle({
  title,
  count,
  lead,
  action,
  level = 2,
  className,
}: {
  title: string
  /** The real number of items; omitted while it is not known. */
  count?: number
  lead?: ReactNode
  action?: ReactNode
  level?: 2 | 3
  className?: string
}) {
  const Heading = `h${level}` as const
  const epoch = useContext(LiveChanges)
  // Decided once, when the title mounts.
  const [draw] = useState(() => epoch !== null && epochsSeen.has(epoch) && motionAllowed())
  useLayoutEffect(() => {
    if (epoch === null) return
    // After the frame that mounted them: every title of one load sees the epoch as new.
    const frame = requestAnimationFrame(() => {
      epochsSeen.clear()
      epochsSeen.add(epoch)
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [epoch])
  return (
    <div className={cx('ui-section-title', className)} data-zero={count === 0 ? '' : undefined} data-draw={draw ? '' : undefined}>
      {lead}
      <Heading className="ui-section-title-words">{title}</Heading>
      {count !== undefined && <Roll value={count} className="ui-section-title-count" />}
      {action && <span className="ui-section-title-action">{action}</span>}
    </div>
  )
}

/**
 * The corner ticks round the card or input the keys act on right now. `on` shows them; when they appear because the
 * target has just landed (`lock`), each closes in 6px (260ms on the settle curve, after 180ms). They stand outside
 * the frame's edge, never over its content, and are decoration: what the keys do is written on the controls.
 */
export function TickFrame({
  on,
  lock = false,
  className,
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & { on: boolean; lock?: boolean; children: ReactNode }) {
  return (
    <div className={cx('ui-tick-frame', className)} {...props}>
      {children}
      {on && (
        <span className="ui-ticks" data-lock={lock ? '' : undefined} aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
      )}
    </div>
  )
}

/** The keys held down right now, by name (letters in upper case; ⌘ and Ctrl are one key, `Mod`). */
const down = new Set<string>()
/** Who shows which key: a hint is told only about the keys it shows. */
const watchers = new Map<string, Set<() => void>>()

const keyName = (key: string) => (key === 'Meta' || key === 'Control' ? 'Mod' : key.length === 1 ? key.toUpperCase() : key)
const tell = (name: string) => {
  for (const notify of watchers.get(name) ?? []) notify()
}

function keyDown(event: KeyboardEvent): void {
  const name = keyName(event.key)
  if (down.has(name)) return
  down.add(name)
  tell(name)
}
function releaseAll(): void {
  const held = [...down]
  down.clear()
  for (const name of held) tell(name)
}
function keyUp(event: KeyboardEvent): void {
  const name = keyName(event.key)
  // macOS sends no keyup for a key released while ⌘ is held, so letting go of ⌘ lets go of everything.
  if (name === 'Mod') releaseAll()
  else if (down.delete(name)) tell(name)
}

/** The window is listened to only while some hint is mounted. */
function listen(on: boolean): void {
  const change = on ? 'addEventListener' : 'removeEventListener'
  window[change]('keydown', keyDown as EventListener, true)
  window[change]('keyup', keyUp as EventListener, true)
  window[change]('blur', releaseAll)
  document[change]('visibilitychange', releaseAll)
  if (!on) down.clear()
}

function watchKeys(names: readonly string[], notify: () => void): () => void {
  if (watchers.size === 0) listen(true)
  for (const name of names) {
    const set = watchers.get(name) ?? new Set()
    set.add(notify)
    watchers.set(name, set)
  }
  return () => {
    for (const name of names) {
      const set = watchers.get(name)
      set?.delete(notify)
      if (set?.size === 0) watchers.delete(name)
    }
    if (watchers.size === 0) listen(false)
  }
}

/** How many key hints listen right now; a test checks the window is let go with the last one. */
export const keyHintWatchers = (): number => watchers.size

const HINT_KEYS: Record<string, string> = {
  mod: 'Mod',
  cmd: 'Mod',
  ctrl: 'Mod',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  esc: 'Escape',
  tab: 'Tab',
  space: ' ',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
}

/**
 * A key hint that lights while its key is down: 「⌘」「⏎」 in quiet mono without a box, and for as long as the person
 * holds the key, ink on the press fill. It shows that the key is down and that it acts here; it performs nothing.
 * `keys` names them as `keyGlyphs` does (`['mod', 'enter']`, `['1']`); each lights by itself. A hint renders again
 * only when one of its own keys goes down or up, and the window is listened to only while a hint is mounted.
 */
export function KeyHint({ keys, className }: { keys: readonly string[]; className?: string }) {
  const names = keys.map(key => HINT_KEYS[key.toLowerCase()] ?? keyName(key))
  const signature = names.join('\n')
  const subscribe = useCallback((notify: () => void) => watchKeys(signature.split('\n'), notify), [signature])
  const held = useSyncExternalStore(
    subscribe,
    () => names.map(name => (down.has(name) ? '1' : '0')).join(''),
    () => '',
  )
  return (
    <kbd className={cx('ui-key-hint', className)}>
      {keys.map((key, index) => (
        <span key={key} className="ui-key-hint-key" data-down={held[index] === '1' ? '' : undefined}>
          {keyGlyphs(key)}
        </span>
      ))}
    </kbd>
  )
}

/**
 * The edge of a running row: one thin light travelling along its bottom while the Host reports the row as running.
 * The row holds it (`position: relative`). It pauses out of view and while a reply streams in view, and is not drawn
 * with reduced motion; the row's spinner and its words say the same.
 */
export function RunningEdge({ className }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  usePausedOffscreen(ref)
  return (
    <span ref={ref} className={cx('ui-running-edge', className)} aria-hidden="true">
      <i />
    </span>
  )
}

/**
 * The dot before a computer's name: green with a slow ring while its connection is live, faint and still when it is
 * not. The name and the word beside it (在线, 离线) say it; `label` names the dot where nothing else does.
 */
export function LiveDot({ live, label, className }: { live: boolean; label?: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  usePausedOffscreen(ref)
  return (
    <span
      ref={ref}
      className={cx('ui-live-dot', className)}
      data-live={live ? '' : undefined}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}

/**
 * What comes up from below when there is something new out of sight (回到最新): it rises 8px on the spring as it fades
 * in and leaves on the exit curve, staying in the document until it has left. Reduced motion only fades.
 */
export function PillMove({ show, className, children }: { show: boolean; className?: string; children: ReactNode }) {
  const { present, leaving } = usePresence(show, MOTION.enterExit)
  const ref = useRef<HTMLSpanElement>(null)
  // What is leaving takes no focus and no clicks.
  useLayoutEffect(() => {
    if (ref.current) ref.current.inert = leaving
  }, [leaving])
  if (!present) return null
  return (
    <span ref={ref} className={cx('ui-pill-move', className)} data-leaving={leaving ? '' : undefined}>
      {children}
    </span>
  )
}
