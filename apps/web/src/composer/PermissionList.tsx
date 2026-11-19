import type { ReactNode } from 'react'
import {
  Circle,
  ClipboardList,
  Diamond,
  Hexagon,
  ListChecks,
  MessageCircleQuestion,
  Octagon,
  Pentagon,
  Scale,
  Square,
  Triangle,
} from 'lucide-react'
import { ModeStrip, useLayerClose, EyeGlyph, ShieldGlyph, ShieldAlertGlyph } from '@latch/ui'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { MODE_COPY } from '../core/securityCopy.ts'
import { controlKeyCaps } from './modelReasoning.ts'
import { capsText } from '../workbenchShortcuts.ts'
import type { ModeIcon, PermissionRow, PermissionView } from './permission.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    permissions: '权限',
  },
  {
    permissions: 'Permissions',
  },
)

/** The one map from a mode's glyph name to what is drawn (permission.ts says which name a mode gets). */
export const MODE_ICONS: Record<ModeIcon, typeof ShieldGlyph> = {
  eye: EyeGlyph,
  shield: ShieldGlyph,
  'list-checks': ListChecks,
  scale: Scale,
  'shield-alert': ShieldAlertGlyph,
  plan: ClipboardList,
  question: MessageCircleQuestion,
  circle: Circle,
  square: Square,
  triangle: Triangle,
  diamond: Diamond,
  hexagon: Hexagon,
  pentagon: Pentagon,
  octagon: Octagon,
}

type StripRow = Pick<PermissionRow, 'value' | 'name' | 'icon' | 'line' | 'disabledReason' | 'neverAsks' | 'current'>

/**
 * The modes as segments, for every Harness: its reported modes in order (each with a glyph of its own, permission.ts),
 * or, before it reports any, the one that is true now. More than one row of segments holds wrap onto a second.
 */
export function stripRows(view: PermissionView): StripRow[] {
  return view.rows ?? [{ value: 'current', name: view.label, icon: view.icon, line: view.line, neverAsks: view.amber, current: true }]
}

/**
 * What the 权限 control opens: the heading with its key (none where nothing can ask), one segment per mode from tightest
 * to loosest, and the chosen (or previewed) mode's name with its one line. A row this device cannot choose stays, with
 * why as its tooltip. `keepOpen` (the input's control) keeps it open on a choice, with a write under way turning by the
 * heading and what a write came to that did not settle under the strip.
 */
export function PermissionPanel({
  view,
  onChoose,
  keepOpen = false,
  pending = false,
  feedback,
}: {
  view: PermissionView
  onChoose: (value: string) => void
  keepOpen?: boolean
  pending?: boolean
  feedback?: ReactNode
}) {
  const close = useLayerClose()
  const rows = stripRows(view)
  const keys = controlKeyCaps('permission')
  return (
    // What a session may do without asking keeps the product's own tokens under every customisation (tokens.css).
    <div className="permission-panel" data-lock="">
      <ModeStrip
        label={view.asksNothing ? COPY.permissions : MODE_COPY.menuTitle}
        keys={keys && capsText(keys)}
        pending={pending}
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
          if (!keepOpen) close()
          // The one row that is true now is no choice: pressing it changes nothing.
          if (view.rows) onChoose(value)
        }}
      />
      {feedback}
    </div>
  )
}
