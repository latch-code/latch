import { DevMark } from '@latch/ui'
import { DEV_MODE_TEXT } from '../core/permissions.ts'

/** The design system's development-build mark with this page's sentence; always present, never an alarm. */
export function DevModeChip({ compact = false }: { compact?: boolean }) {
  return <DevMark description={DEV_MODE_TEXT} data-testid="dev-mode" className={compact ? 'dev-chip is-compact' : 'dev-chip'} />
}
