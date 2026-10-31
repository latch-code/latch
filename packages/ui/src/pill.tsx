import { useState, type ComponentProps, type ReactNode } from 'react'
import { useLiveChange } from './changes.ts'
import { cx } from './internal.ts'
import { StatusWord, type StatusTone } from './status.tsx'

/** Neutral is a soft fill; amber means a warning, red a real risk or failure, green a success. */
export type Tone = 'neutral' | 'warn' | 'err' | 'ok'

const STATE_TONE: Record<Tone, StatusTone> = { neutral: 'neutral', warn: 'warn', err: 'failed', ok: 'done' }

/**
 * The state of a card, a row or a session in words (已取消, 不可用, 高风险), drawn as a status word: neutral muted, amber
 * words for a warning, red words after circle-alert for a risk or failure, ink words after a check for done. The
 * plugin panels' `ui` hands it to trusted panels under this name; pages use it where the state needs no glyph of
 * waiting or running (those are StatusWord's).
 */
export function StatusPill({
  tone = 'neutral',
  className,
  children,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> & { tone?: Tone; children: ReactNode }) {
  return (
    <StatusWord tone={STATE_TONE[tone]} className={className} {...props}>
      {children}
    </StatusWord>
  )
}

/**
 * A badge: an attribute that follows a name (本机, 默认, 内置, 离线), 18px with 4px corners, 11/14·500 on a soft
 * fill. Never a card's or row's state, which is a status word.
 */
export function Badge({
  tone = 'neutral',
  className,
  children,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> & { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cx('ui-badge', className)} data-tone={tone} {...props}>
      {children}
    </span>
  )
}

/**
 * neutral: a passive count, in the ink of the words around it. strong: what is new for the person (unread results), in
 * ink. warn: what waits for the person, in amber.
 */
export type CountTone = 'neutral' | 'strong' | 'warn'

/**
 * A count in tabular digits, 12/16·500; above `max` it reads 「99+」. A change the page saw happen cross-fades the new
 * number in over --m-micro; on the first render, after a resynchronization and with reduced motion it just shows. A
 * count shown only above zero takes `from`, its value before it appeared (`useLivePrevious`), so its arrival seen live
 * fades in too.
 */
export function Count({
  value,
  tone = 'neutral',
  max = 99,
  label,
  from,
}: {
  value: number
  tone?: CountTone
  max?: number
  label?: string
  from?: number
}) {
  const text = value > max ? `${max}+` : String(value)
  const [shift, setShift] = useState(0)
  useLiveChange(
    value,
    (_previous, live) => {
      setShift(current => (live ? current + 1 : 0))
    },
    from,
  )
  return (
    <span
      key={shift}
      className="ui-count"
      data-tone={tone}
      data-shift={shift > 0 ? '' : undefined}
      {...(label ? { role: 'img', 'aria-label': label } : {})}>
      {text}
    </span>
  )
}

/**
 * A status dot, 6px (8px on phones). Amber and red never stand alone: a word or a shape next to it says the same
 * thing, and `label` names it for screen readers when nothing else does. `ring` cuts it out of a tile or avatar with
 * 2px of the surface colour.
 */
export function StatusDot({ tone, ring = false, label }: { tone: 'warn' | 'err' | 'unread'; ring?: boolean; label?: string }) {
  return (
    <span
      className="ui-status-dot"
      data-tone={tone}
      data-ring={ring ? '' : undefined}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}

/** A key or shortcut: only in tooltips, menu item ends, the search row and an approval's hint line, never in a button. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>
}
