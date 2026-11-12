import { useState } from 'react'

import type { SessionConfigOption } from '@latch/protocol'
import { ICON_STROKE, Popover, ChevronDownGlyph } from '@latch/ui'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { MODE_ICONS, PermissionList } from './PermissionList.tsx'
import type { PermissionView } from './permission.ts'

/**
 * 权限, always drawn and always opening, with no tooltip: the menu shows each row's line, by touch too: the agent's own modes when it reports them,
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
  // The list stays mounted while closed: starting it again on closing opens it next time with 更多 folded. On opening
  // it would drop the row the popover has just focused.
  const [closings, setClosings] = useState(0)
  return (
    <Popover
      label="权限"
      width={400}
      side="top"
      onOpenChange={open => {
        if (!open) setClosings(count => count + 1)
        onOpenChange?.(open)
      }}
      trigger={props => (
        <button {...props} type="button" className={`chip chip-permission${view.amber ? ' is-amber' : ''}`} aria-label={`权限：${label}`}>
          <Glyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
          <span className="chip-text">{label}</span>
          <ChevronDownGlyph className="chip-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        </button>
      )}>
      <PermissionList
        key={closings}
        view={view}
        onChoose={value => {
          if (view.option) onChoose(view.option, value)
        }}
      />
    </Popover>
  )
}
