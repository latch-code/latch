import { ListChecks, Scale } from 'lucide-react'
import { ChoiceList, Kbd, useLayerClose, EyeGlyph, ShieldGlyph, ShieldAlertGlyph, ICON_STROKE } from '@latch/ui'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { MODE_COPY } from '../core/securityCopy.ts'
import { controlKeyCaps } from './modelReasoning.ts'
import { capsText } from '../workbenchShortcuts.ts'
import type { ModeIcon, PermissionRow, PermissionView } from './permission.ts'

export const MODE_ICONS: Record<ModeIcon, typeof ShieldGlyph> = {
  eye: EyeGlyph,
  shield: ShieldGlyph,
  'list-checks': ListChecks,
  scale: Scale,
  'shield-alert': ShieldAlertGlyph,
}

type ShownRow = Pick<PermissionRow, 'value' | 'name' | 'icon' | 'disabledReason' | 'neverAsks'>

/** The rows as the list shows them: the agent's modes, strictest first, or the one that is true now. */
function shownRows(view: PermissionView): ShownRow[] {
  return view.rows ?? [{ value: 'current', name: view.label, icon: view.icon, neverAsks: false }]
}

/**
 * Every row, always: its glyph and name, the current one checked, amber where the agent never asks. What a row means
 * and whose setting it is are the chip's tooltip (`permissionTip`), not lines in the list. Any row applies at once, on
 * any device that may run the session.
 */
export function PermissionList({ view, onChoose }: { view: PermissionView; onChoose: (value: string) => void }) {
  const close = useLayerClose()
  const rows = shownRows(view)
  const current = view.rows ? view.rows.find(row => row.current)?.value : 'current'
  const keys = controlKeyCaps('permission')
  return (
    // What a session may do without asking keeps the product's own tokens under every customisation (tokens.css).
    <div className="permission-list" data-lock="">
      {!view.asksNothing && (
        <p className="permission-list-title">
          <span>{MODE_COPY.menuTitle}</span>
          {keys && (
            <span className="menu-title-keys" aria-hidden="true">
              <Kbd>{capsText(keys)}</Kbd>
            </span>
          )}
        </p>
      )}
      <ChoiceList
        label="权限"
        value={current}
        options={rows.map(row => {
          const Glyph = MODE_ICONS[row.icon]
          return {
            value: row.value,
            title: escapeHiddenCharacters(row.name),
            media: (
              <Glyph
                size={16}
                nonScalingStroke
                strokeWidth={ICON_STROKE[16]}
                aria-hidden="true"
                className={row.neverAsks ? 'permission-never' : undefined}
              />
            ),
            ...(row.disabledReason ? { disabledReason: row.disabledReason } : {}),
          }
        })}
        // Pressing the mode already chosen closes the list too, as any picker does.
        reselect
        onValueChange={value => {
          close()
          onChoose(value)
        }}
      />
    </div>
  )
}
