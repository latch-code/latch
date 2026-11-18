import { useState } from 'react'
import { Button, StatusWord } from '@latch/ui'
import type { CustomizationActions } from '../core/customization.ts'
import { CustomizationRecovery } from './CustomizationRecovery.tsx'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    restoreOn: (computer: string) => `在 ${computer} 上恢复`,
    appearance: '默认外观',
    reset: '恢复默认',
  },
  {
    restoreOn: (computer: string) => `Restore on ${computer}`,
    appearance: 'Default appearance',
    reset: 'Restore defaults',
  },
)

/** The row stays above the page and shares its recovery request with appearance settings. */
export function SafeModeBanner({
  admin,
  computer,
  onChanged,
  baseRevision,
  writer,
}: {
  admin: boolean
  computer: string
  onChanged: () => void
  baseRevision?: number | undefined
  writer: CustomizationActions
}) {
  const [error, setError] = useState('')
  const reset = async (revision: number) => {
    setError('')
    const outcome = await writer.submit({ kind: 'reset' }, revision)
    if (outcome.kind === 'done' || outcome.kind === 'conflict') onChanged()
    if (outcome.kind === 'conflict' || outcome.kind === 'refused') setError(outcome.text)
  }
  return (
    <div className="safe-banner" data-lock="" role="status" aria-label={COPY.appearance}>
      <span className="safe-banner-words">{COPY.appearance}</span>
      {!writer.pending && error && <StatusWord tone="failed">{error}</StatusWord>}
      {writer.pending ? (
        <CustomizationRecovery writer={writer} admin={admin} onDone={onChanged} size="xs" />
      ) : admin && baseRevision !== undefined ? (
        <Button
          size="xs"
          variant="secondary"
          onClick={() => {
            void reset(baseRevision)
          }}>
          {COPY.reset}
        </Button>
      ) : (
        <span className="safe-banner-where">{COPY.restoreOn(computer)}</span>
      )}
    </div>
  )
}
