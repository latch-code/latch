import type { SessionConfigOption } from '@latch/protocol'
import { ICON_STROKE, Popover, Tooltip, ChevronDownGlyph } from '@latch/ui'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { MODE_ICONS, PermissionList } from './PermissionList.tsx'
import { permissionTip, type PermissionView } from './permission.ts'

/**
 * 权限, always drawn and always opening: the agent's own modes when it reports them, otherwise the one row that is true
 * now. What the current row means, whose setting it is and that Latch does not isolate the agent are the chip's tooltip
 * on hover and focus; on touch the timeline's first row says it. Amber only where the agent never asks or Latch cannot
 * confirm.
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
      size="md"
      side="top"
      onOpenChange={open => {
        onOpenChange?.(open)
      }}
      trigger={props => (
        <Tooltip content={permissionTip(view)}>
          <button
            {...props}
            type="button"
            className={`chip chip-permission${view.amber ? ' is-amber' : ''}`}
            data-lock={view.amber ? '' : undefined}
            aria-label={`权限：${label}`}>
            <Glyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
            <span className="chip-text">{label}</span>
            <ChevronDownGlyph className="chip-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
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
