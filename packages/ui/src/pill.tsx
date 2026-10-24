import { useState, type ComponentProps, type ReactNode } from 'react'
import { useLiveChange } from './changes.ts'
import { cx } from './internal.ts'

/** Neutral is a fill; amber means waiting or a warning, red a real risk or failure, green an added line or a success. */
export type Tone = 'neutral' | 'warn' | 'err' | 'ok'

/**
 * A 20px status pill: the state of a card, a row or a session (待批准, 失败, 已取消). A pill means a state, a view or
 * an identity and a rounded rectangle an action, so pills and buttons never share a shape. No leading dot, no blue.
 */
export function StatusPill({
  tone = 'neutral',
  className,
  children,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> & { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cx('ui-status-pill', className)} data-tone={tone} {...props}>
      {children}
    </span>
  )
}

/** A 16px small badge: an attribute that follows a name (本机, 默认, 内置, 离线), never a card's or row's state. */
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

/** neutral: a passive count. strong: unread messages on phones. warn: what waits for the person. */
export type CountTone = 'neutral' | 'strong' | 'warn'

/**
 * A count in a 16px pill with tabular digits; above `max` it reads 「99+」. A change the page saw happen moves once: a
 * step of one rolls the digits (up for +1, down for −1, 240ms), and a rise of a waiting (amber) count sends out one
 * 1px ripple. On the first render, after a resynchronization and with reduced motion the new value just shows. A count
 * shown only above zero takes `from`, its value before it appeared (`useLivePrevious`), so the first arrival seen live
 * ripples too; it does not roll, since the old value was not on screen.
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
  const [shot, setShot] = useState<{ key: number; from: string; roll: 'up' | 'down' | null; ripple: boolean } | null>(null)
  useLiveChange(
    value,
    (previous, live, appeared) => {
      const step = value - previous
      const roll = !appeared && Math.abs(step) === 1 && Math.max(value, previous) <= max ? (step > 0 ? 'up' : 'down') : null
      const ripple = step > 0 && tone === 'warn'
      if (!live || (roll === null && !ripple)) {
        setShot(null)
        return
      }
      setShot(current => ({ key: (current?.key ?? 0) + 1, from: String(previous), roll, ripple }))
    },
    from,
  )
  return (
    <span
      className="ui-count"
      data-tone={tone}
      data-wide={text.length > 1 ? '' : undefined}
      {...(label ? { role: 'img', 'aria-label': label } : {})}>
      {shot?.roll ? (
        <>
          {/* The stack holds the old and the new digits; its resting place shows the new one. */}
          <span key={shot.key} className="ui-count-roll" data-direction={shot.roll} aria-hidden="true">
            <span>
              <span>{shot.roll === 'up' ? shot.from : text}</span>
              <span>{shot.roll === 'up' ? text : shot.from}</span>
            </span>
          </span>
          <span className="sr-only">{text}</span>
        </>
      ) : (
        text
      )}
      {shot?.ripple && (
        <svg key={`ripple-${shot.key}`} className="ui-count-ripple" aria-hidden="true">
          <rect x="0" y="0" width="100%" height="100%" rx="8" />
        </svg>
      )}
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

/** A key or shortcut: only in tooltips, menu item ends, the search row and an approval card's hint line, never in a button. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>
}
