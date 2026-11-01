import { Eye, Shield, ShieldAlert } from 'lucide-react'
import { ChoiceList, useLayerClose } from '@latch/ui'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { MODE_COPY } from '../core/securityCopy.ts'
import type { ModeIcon, PermissionRow, PermissionView } from './permission.ts'

export const MODE_ICONS: Record<ModeIcon, typeof Shield> = { eye: Eye, shield: Shield, 'shield-alert': ShieldAlert }

/** The rows as the list shows them: the agent's modes, strictest first, or the one that is true now. */
function shownRows(view: PermissionView): Array<Pick<PermissionRow, 'value' | 'name' | 'line' | 'icon' | 'disabledReason'>> {
  return view.rows ?? [{ value: 'current', name: view.label, line: view.line, icon: view.icon }]
}

/** A wider row asks on the Mac; another device sees why it cannot. */
export function PermissionList({ view, onChoose }: { view: PermissionView; onChoose: (value: string) => void }) {
  const close = useLayerClose()
  const rows = shownRows(view)
  return (
    <div className="permission-list">
      {!view.asksNothing && <p className="permission-list-title">{MODE_COPY.menuTitle}</p>}
      <ChoiceList
        label="权限"
        value={view.rows ? view.rows.find(row => row.current)?.value : 'current'}
        options={rows.map(row => {
          const Glyph = MODE_ICONS[row.icon]
          return {
            value: row.value,
            title: escapeHiddenCharacters(row.name),
            ...(row.line ? { description: escapeHiddenCharacters(row.line) } : {}),
            media: <Glyph size={16} aria-hidden="true" />,
            ...(row.disabledReason ? { disabledReason: row.disabledReason } : {}),
          }
        })}
        onValueChange={value => {
          close()
          onChoose(value)
        }}
      />
      {view.note && <p className="permission-list-note">{view.note}</p>}
    </div>
  )
}
