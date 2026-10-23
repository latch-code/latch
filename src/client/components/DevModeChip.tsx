import { DEV_MODE_TEXT } from '../permissions.ts'

/** A neutral, always-present marker that this Host build is unsigned and locally modifiable. */
export function DevModeChip({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={`dev-chip${compact ? ' is-compact' : ''}`}
      data-testid="dev-mode"
      role="note"
      aria-label={DEV_MODE_TEXT}
      title={DEV_MODE_TEXT}>
      开发版
    </span>
  )
}
