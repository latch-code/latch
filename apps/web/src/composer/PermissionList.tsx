import { useState } from 'react'
import { ChevronDown, ChevronUp, Eye, ListChecks, Scale, Shield, ShieldAlert } from 'lucide-react'
import { Button, ChoiceList, Hint, Kbd, useLayerClose } from '@latch/ui'
import { MarkTile } from '../components/BrandTile.tsx'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { MODE_COPY } from '../core/securityCopy.ts'
import { controlKeyCaps } from './modelReasoning.ts'
import type { ModeIcon, PermissionRow, PermissionView } from './permission.ts'

export const MODE_ICONS: Record<ModeIcon, typeof Shield> = {
  eye: Eye,
  shield: Shield,
  'list-checks': ListChecks,
  scale: Scale,
  'shield-alert': ShieldAlert,
}

type ShownRow = Pick<PermissionRow, 'value' | 'name' | 'line' | 'icon' | 'disabledReason' | 'neverAsks' | 'more'>

/** The rows as the list shows them: the agent's modes, strictest first, or the one that is true now. */
function shownRows(view: PermissionView): ShownRow[] {
  return view.rows ?? [{ value: 'current', name: view.label, line: view.line, icon: view.icon, neverAsks: false, more: false }]
}

/**
 * At most three rows, each with one line, and the current one wherever it is; the rest under 更多. Any row applies at
 * once, on any device that may run the session.
 */
export function PermissionList({ view, onChoose }: { view: PermissionView; onChoose: (value: string) => void }) {
  const close = useLayerClose()
  const rows = shownRows(view)
  const current = view.rows ? view.rows.find(row => row.current)?.value : 'current'
  const hidden = rows.filter(row => row.more)
  const [more, setMore] = useState(false)
  const shown = more ? rows : rows.filter(row => !row.more)
  const keys = controlKeyCaps('permission')
  return (
    <div className="permission-list">
      {!view.asksNothing && (
        <p className="permission-list-title">
          <span>{MODE_COPY.menuTitle}</span>
          {keys && (
            <span className="menu-title-keys" aria-hidden="true">
              {keys.map(key => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </span>
          )}
        </p>
      )}
      <ChoiceList
        label="权限"
        value={current}
        options={shown.map(row => {
          const Glyph = MODE_ICONS[row.icon]
          return {
            value: row.value,
            title: escapeHiddenCharacters(row.name),
            ...(row.line ? { description: escapeHiddenCharacters(row.line) } : {}),
            media: <Glyph size={16} aria-hidden="true" className={row.neverAsks ? 'permission-never' : undefined} />,
            ...(row.disabledReason ? { disabledReason: row.disabledReason } : {}),
          }
        })}
        onValueChange={value => {
          close()
          onChoose(value)
        }}
      />
      {hidden.length > 0 && (
        <Button
          size="xs"
          variant="ghost"
          icon={more ? ChevronUp : ChevronDown}
          className="permission-list-more"
          aria-expanded={more}
          onClick={() => {
            setMore(!more)
          }}>
          {more ? MODE_COPY.fewer : MODE_COPY.more}
        </Button>
      )}
      {view.note && (
        <Hint
          className="permission-list-note"
          label={view.note.label}
          {...(view.note.mark ? { lead: <MarkTile mark={view.note.mark} size={14} /> } : {})}>
          {view.note.detail}
        </Hint>
      )}
    </div>
  )
}
