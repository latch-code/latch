import type { ReactNode } from 'react'
import { Hint, ICON_STROKE, type LucideIcon } from '@latch/ui'
import { VisibleText } from '../../components/VisibleText.tsx'

/** One line of the 交付 tab: an icon and short words in a tone, the fine print behind a Hint, and an action. */
export function Line({
  tone = 'plain',
  icon: Glyph,
  children,
  detail,
  action,
}: {
  tone?: 'plain' | 'muted' | 'amber' | 'red'
  icon?: LucideIcon
  children: ReactNode
  detail?: string | undefined
  action?: ReactNode
}) {
  const glyph = Glyph ? <Glyph size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" /> : undefined
  return (
    <div className="delivery-line" data-tone={tone}>
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
