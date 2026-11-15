import type { ReactNode } from 'react'
import { Hint, ICON_STROKE, type IconComponent } from '@latch/ui'
import { VisibleText } from '../../components/VisibleText.tsx'

/** One line of the 交付 tab: an icon and short words in a tone, the fine print behind a Hint, and an action. */
export function Line({
  tone = 'plain',
  icon: Glyph,
  children,
  detail,
  action,
  locked = false,
}: {
  tone?: 'plain' | 'muted' | 'amber' | 'red'
  icon?: IconComponent
  children: ReactNode
  detail?: string | undefined
  action?: ReactNode
  /** A line that says a result is unknown: the product's own tokens under every customisation (tokens.css). */
  locked?: boolean
}) {
  const glyph = Glyph ? <Glyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" /> : undefined
  return (
    <div className="delivery-line" data-tone={tone} data-lock={locked ? '' : undefined}>
      {detail ? (
        <Hint {...(glyph ? { lead: glyph } : {})} label={children}>
          {detail}
        </Hint>
      ) : (
        <>
          {glyph}
          <span className="delivery-line-text">{children}</span>
        </>
      )}
      {action}
    </div>
  )
}

/** Output a person reads (already redacted by the Host): monospaced, scrollable, reachable by keyboard. */
export function Output({ text, label }: { text: string; label: string }) {
  return (
    <pre className="delivery-output" tabIndex={0} aria-label={label}>
      <VisibleText text={text} />
    </pre>
  )
}
