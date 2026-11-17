import type { ReactNode } from 'react'
import { Hint } from '@latch/ui'
import { MarkTile } from '../components/BrandTile.tsx'
import type { Brief } from '../core/securityCopy.ts'

/**
 * A `Brief` as the menus and notices show it: its few words always, led by the Harness's mark where the fact is about
 * that Harness (else `lead`), and its fine print as the words' tooltip.
 */
export function BriefHint({ brief, lead, className, tone }: { brief: Brief; lead?: ReactNode; className?: string; tone?: 'warn' }) {
  const shown = brief.mark ? <MarkTile mark={brief.mark} size={14} /> : lead
  return (
    <Hint
      label={brief.label}
      {...(shown ? { lead: shown } : {})}
      {...(className || tone ? { className: [className, tone ? `is-${tone}` : ''].filter(Boolean).join(' ') } : {})}>
      {brief.detail}
    </Hint>
  )
}
