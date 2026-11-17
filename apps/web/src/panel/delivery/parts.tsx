import type { ReactNode } from 'react'
import { Hint, ICON_STROKE, type IconComponent } from '@latch/ui'
import { VisibleText } from '../../components/VisibleText.tsx'

/**
 * One line of the 交付 tab: an icon and short words in a tone, the fine print, and an action. A failure or an unknown
 * result keeps its fine print on the line, behind an ⓘ, since it says what happened and what to do next; a state's fine
 * print (`hover`) is the words' tooltip.
 */
export function Line({
  tone = 'plain',
  icon: Glyph,
  children,
  detail,
  hover = false,
  action,
  locked = false,
}: {
  tone?: 'plain' | 'muted' | 'amber' | 'red'
  icon?: IconComponent
  children: ReactNode
  detail?: string | undefined
  /** The detail explains a state rather than a failure: it is the words' tooltip, not an ⓘ on the line. */
  hover?: boolean
  action?: ReactNode
  /** A line that says a result is unknown: the product's own tokens under every customisation (tokens.css). */
  locked?: boolean
}) {
  const glyph = Glyph ? <Glyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" /> : undefined
  return (
    <div className="delivery-line" data-tone={tone} data-lock={locked ? '' : undefined}>
      {detail ? (
        <Hint {...(glyph ? { lead: glyph } : {})} inline={!hover} label={children}>
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
