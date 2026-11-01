import { ChevronDown } from 'lucide-react'
import type { SessionConfigOption } from '@latch/protocol'
import { ICON_STROKE, Popover, Tooltip } from '@latch/ui'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { MODE_ICONS, PermissionList } from './PermissionList.tsx'
import type { PermissionView } from './permission.ts'

/**
 * 权限, drawn only away from the engine's default: the mode with its own list, or, for an engine Latch cannot limit, a
 * static chip whose tooltip says why. Amber only on a mode in which the agent never asks.
 */
export function PermissionChip({
  view,
  onChoose,
}: {
  view: PermissionView
  onChoose: (option: SessionConfigOption, value: string) => void
}) {
  const Glyph = MODE_ICONS[view.icon]
  const label = escapeHiddenCharacters(view.label)
  if (!view.rows || !view.option)
    return (
      <Tooltip content={view.tooltip}>
        <span className="chip chip-static chip-permission" tabIndex={0}>
          <Glyph size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
          <span className="chip-text">{label}</span>
        </span>
      </Tooltip>
    )
  const { rows, option } = view
  return (
    <Popover
      label="权限"
      width={400}
      side="top"
      trigger={props => (
        <Tooltip content={escapeHiddenCharacters(view.tooltip)} describe={false}>
          <button {...props} type="button" className={`chip chip-permission${view.amber ? ' is-amber' : ''}`} aria-label={`权限：${label}`}>
            <Glyph size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
            <span className="chip-text">{label}</span>
            <ChevronDown className="chip-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
          </button>
        </Tooltip>
      )}>
      <PermissionList
        rows={rows}
        onChoose={value => {
          onChoose(option, value)
        }}
      />
    </Popover>
  )
}
