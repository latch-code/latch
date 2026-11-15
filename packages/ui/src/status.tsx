import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { CheckGlyph, AlertGlyph, ShieldGlyph } from './glyphs/index.tsx'
import { useLiveChange } from './changes.ts'
import { Icon, Spinner, type SpinnerSize } from './icon.tsx'
import { cx } from './internal.ts'

/*
 * The status vocabulary: a state is a few words with at most one 12px glyph, in the colour of what it means. Only
 * running work moves (its spinner); a change of state that the page sees happen cross-fades the words over --m-micro.
 * There is no idle animation and no pill.
 */

/**
 * waiting: 等你处理, amber with a shield. running: 运行中, ink with the spinner. failed: 失败, red with circle-alert.
 * done: 已完成, ink with a check. warn: amber words without a glyph, for a warning (不可用, 演示). neutral: muted words
 * (已取消, 已停用).
 */
export type StatusTone = 'neutral' | 'waiting' | 'running' | 'failed' | 'done' | 'warn'

/**
 * The tones that speak of safety or of something the person must look at (等你处理, 不先问你, 来自外部内容, 结果未知, 失败)
 * keep the product's own tokens under every customisation (`data-lock`, tokens.css).
 */
const LOCKED_TONES: ReadonlySet<StatusTone> = new Set(['waiting', 'warn', 'failed'])

function Glyph({ tone }: { tone: StatusTone }) {
  if (tone === 'waiting') return <Icon icon={ShieldGlyph} size={12} className="ui-status-word-glyph" />
  if (tone === 'running') return <Spinner size={12} className="ui-status-word-glyph" />
  if (tone === 'failed') return <Icon icon={AlertGlyph} size={12} className="ui-status-word-glyph" />
  if (tone === 'done') return <Icon icon={CheckGlyph} size={12} className="ui-status-word-glyph" />
  return null
}

/**
 * A state in words, 12/16·500 with tabular digits (运行中 1:12 keeps its width as the timer ticks), led by the tone's
 * 12px glyph. The words say the state on their own; the glyph is decorative.
 */
export function StatusWord({
  tone = 'neutral',
  className,
  children,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> & { tone?: StatusTone; children: ReactNode }) {
  return (
    <span className={cx('ui-status-word', className)} data-tone={tone} data-lock={LOCKED_TONES.has(tone) ? '' : undefined} {...props}>
      <Glyph tone={tone} />
      {children}
    </span>
  )
}

/**
 * What a list row shows in its status slot, one thing at a time: none, running (the spinner and its words), waiting
 * for the person, attention (amber words without the shield, where the row's shelf already says it waits), failed,
 * unread (a check that goes once the session is read), ended (muted words) or the time. The page chooses.
 */
export type SlotStatus = 'none' | 'running' | 'waiting' | 'attention' | 'failed' | 'unread' | 'ended' | 'time'

/**
 * A row's status slot, right-aligned on the row's first line. When the page sees the status change, the new one
 * cross-fades in over --m-micro as the old one fades out in the same place; otherwise it just shows. The slot is
 * decorative: the row says its status in words for assistive technology.
 */
export function StatusSlot({
  status,
  running = '运行中',
  waiting = '等你处理',
  attention,
  failed = '失败',
  ended,
  time,
  dateTime,
  actions,
  className,
}: {
  status: SlotStatus
  /** The running words, with the elapsed time when the page has it (运行中 1:12). */
  running?: ReactNode
  /** The waiting words. */
  waiting?: ReactNode
  /** The attention words. */
  attention?: ReactNode
  /** The failure's words. */
  failed?: ReactNode
  /** How the run ended when that was not an answer: 已停止. */
  ended?: ReactNode
  /** The time shown at rest, such as 09:15, 2 分钟 or 昨天. */
  time?: ReactNode
  dateTime?: string
  /**
   * What the row offers (归档, ⋯). On a row marked `data-status-row`, hover or focus inside it lets the status give way
   * to these in the same place. A touch screen has no hover: the status stays, and the row reaches them another way.
   */
  actions?: ReactNode
  className?: string
}) {
  const content = (shown: SlotStatus) =>
    shown === 'running' ? (
      <StatusWord tone="running">{running}</StatusWord>
    ) : shown === 'waiting' ? (
      <StatusWord tone="waiting">{waiting}</StatusWord>
    ) : shown === 'attention' ? (
      <StatusWord tone="warn">{attention}</StatusWord>
    ) : shown === 'ended' ? (
      <StatusWord tone="neutral">{ended}</StatusWord>
    ) : shown === 'failed' ? (
      <StatusWord tone="failed">{failed}</StatusWord>
    ) : shown === 'unread' ? (
      <Icon icon={CheckGlyph} size={12} className="ui-status-unread" />
    ) : shown === 'time' ? (
      <time className="ui-status-time" dateTime={dateTime}>
        {time}
      </time>
    ) : null
  // What left with the last change seen live, until its fade has played (null after that).
  const [shift, setShift] = useState<{ key: number; leaving: SlotStatus | null } | null>(null)
  useLiveChange(status, (previous, live) => {
    setShift(current => (live ? { key: (current?.key ?? 0) + 1, leaving: previous } : null))
  })
  const key = shift?.key ?? 0
  const slot = (
    <span className={cx('ui-status-slot', className)} data-status={status} data-shift={shift ? '' : undefined} aria-hidden="true">
      {shift?.leaving != null && (
        <span
          key={`leaving-${key}`}
          className="ui-status-leaving"
          onAnimationEnd={event => {
            // Gone once faded: nothing that left (a spinner) keeps running unseen.
            if (event.target === event.currentTarget) setShift(current => (current?.key === key ? { key, leaving: null } : current))
          }}>
          {content(shift.leaving)}
        </span>
      )}
      <span key={`shown-${key}`} className="ui-status-shown">
        {content(status)}
      </span>
    </span>
  )
  if (actions === undefined) return slot
  return (
    <span className="ui-status-swap">
      {slot}
      <span className="ui-status-swap-actions">{actions}</span>
    </span>
  )
}

/**
 * A process row's status glyph (a tool's row, a step of a plan): the spinner while it runs, otherwise the row's icon.
 * `state` names what the glyph shows and defaults to running or not; when the page sees it change, the old glyph
 * fades out as the new one scales in from 80% in the same cell, over --m-micro. A change after a resynchronization or
 * a switch of session, the first render and reduced motion show the new glyph at once or only fade. Decorative: the
 * row says its state in words.
 */
export function StatusGlyph({
  running = false,
  state = running ? 'running' : 'rest',
  size = 12,
  className,
  children,
}: {
  running?: boolean
  state?: string
  /** The spinner's size: 12 in rows, 14 in a tool card. */
  size?: SpinnerSize
  className?: string
  /** The icon shown when not running. */
  children?: ReactNode
}) {
  const shown = useRef<{ running: boolean; icon: ReactNode }>({ running, icon: children })
  // What left with the last change seen live, until its fade has played (null after that).
  const [shift, setShift] = useState<{ key: number; leaving: ReactNode } | null>(null)
  useLiveChange(state, (_previous, live) => {
    // Runs before the effect below, so it still holds what the last render showed.
    const before = shown.current
    const leaving = before.running ? <Spinner size={size} /> : before.icon
    setShift(current => (live ? { key: (current?.key ?? 0) + 1, leaving } : null))
  })
  useLayoutEffect(() => {
    shown.current = { running, icon: children }
  })
  return (
    <span className={cx('ui-status-glyph', className)} data-shift={shift ? '' : undefined} aria-hidden="true">
      {shift?.leaving != null && (
        <span
          key={`leaving-${shift.key}`}
          className="ui-status-glyph-leaving"
          onAnimationEnd={event => {
            const key = shift.key
            if (event.target === event.currentTarget) setShift(current => (current?.key === key ? { key, leaving: null } : current))
          }}>
          {shift.leaving}
        </span>
      )}
      <span key={`glyph-${shift?.key ?? 0}`} className="ui-status-glyph-current">
        {running ? <Spinner size={size} /> : children}
      </span>
    </span>
  )
}

/**
 * The words of a process row's state (执行中, 完成, 失败…). When the page sees `state` change, the new words fade in
 * over --m-micro; otherwise they just show.
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
