import { ListChecks, Scale } from 'lucide-react'
import { ChoiceList, Kbd, ModeStrip, useLayerClose, EyeGlyph, ShieldGlyph, ShieldAlertGlyph, ICON_STROKE } from '@latch/ui'
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

/** The most modes one row of segments holds; more take the list. */
const STRIP_MAX = 5

/**
 * The modes as one row of segments: two to five, each with a tier Latch knows and so an icon of its own, in tier
 * order. Otherwise (one row, more than five, or modes whose meaning Latch does not know, which would all draw the same
 * shield) undefined, and the list is shown.
 */
export function stripRows(view: PermissionView): PermissionRow[] | undefined {
  const rows = view.rows
  if (!rows || rows.length < 2 || rows.length > STRIP_MAX) return undefined
  if (rows.some(row => row.tier === undefined)) return undefined
  return new Set(rows.map(row => row.icon)).size === rows.length ? rows : undefined
}

/**
 * What the 权限 chip opens: the heading with its key, one segment per mode from tightest to loosest, and the chosen
 * (or previewed) mode's name with its one line. Modes the strip cannot hold keep the list.
 */
export function PermissionPanel({ view, onChoose }: { view: PermissionView; onChoose: (value: string) => void }) {
  const close = useLayerClose()
  const rows = stripRows(view)
  if (!rows) return <PermissionList view={view} onChoose={onChoose} />
  const keys = controlKeyCaps('permission')
  return (
    // What a session may do without asking keeps the product's own tokens under every customisation (tokens.css).
    <div className="permission-panel" data-lock="">
      <ModeStrip
        label={MODE_COPY.menuTitle}
        keys={keys && capsText(keys)}
        value={rows.find(row => row.current)?.value}
        options={rows.map(row => ({
          value: row.value,
          label: escapeHiddenCharacters(row.name),
          ...(row.line ? { line: escapeHiddenCharacters(row.line) } : {}),
          icon: MODE_ICONS[row.icon],
          ...(row.neverAsks ? { risk: true } : {}),
          ...(row.disabledReason ? { disabledReason: row.disabledReason } : {}),
        }))}
        onChoose={value => {
          close()
          onChoose(value)
        }}
      />
    </div>
  )
}
