import { ChevronDown } from 'lucide-react'
import type { SessionConfigOption } from '@latch/protocol'
import { ICON_STROKE, Popover, Tooltip } from '@latch/ui'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { MODE_ICONS, PermissionList } from './PermissionList.tsx'
import type { PermissionView } from './permission.ts'

/**
 * 权限, always drawn and always opening, so touch reads what a hover would: the agent's own modes when it reports them,
 * otherwise the one row that is true now and why it cannot change yet. Amber only where the agent never asks or Latch
 * cannot confirm.
 */
export function PermissionChip({
  view,
  onChoose,
  onOpenChange,
}: {
  view: PermissionView
  onChoose: (option: SessionConfigOption, value: string) => void
  onOpenChange?: ((open: boolean) => void) | undefined
}) {
  const Glyph = MODE_ICONS[view.icon]
  const label = escapeHiddenCharacters(view.label)
  return (
    <Popover
      label="权限"
      width={400}
      side="top"
      {...(onOpenChange ? { onOpenChange } : {})}
      trigger={props => (
        <Tooltip content={escapeHiddenCharacters(view.line)} describe={false}>
          <button {...props} type="button" className={`chip chip-permission${view.amber ? ' is-amber' : ''}`} aria-label={`权限：${label}`}>
            <Glyph size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
            <span className="chip-text">{label}</span>
            <ChevronDown className="chip-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
          </button>
        </Tooltip>
      )}>
      <PermissionList
        view={view}
        onChoose={value => {
          if (view.option) onChoose(view.option, value)
        }}
      />
    </Popover>
  )
}
