import type { ReactNode } from 'react'
import { ICON_STROKE, ModeStrip } from '@latch/ui'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { defineCopy } from '../core/i18n.ts'
import { MODE_ICONS, stripRows } from './PermissionList.tsx'
import { permissionTip, type PermissionView } from './permission.ts'

const COPY = defineCopy(
  {
    permissions: '权限',
    current: (value1: string) => `权限：${value1}`,
  },
  {
    permissions: 'Permissions',
    current: (value1: string) => `Permissions: ${value1}`,
  },
)

/** The session's permission as the input's one entry shows and sets it. */
export interface EntryPermission {
  view: PermissionView
  /** A mode chosen in the panel; the strip keeps showing the mode the Host confirmed. */
  onChoose: (value: string) => void
  /** A write of the mode is under way. */
  pending?: boolean
  /** What the last write of the mode came to when it did not settle: under the strip. */
  feedback?: ReactNode
  /** The panel opened: a draft reads its modes then, when they are first needed. */
  onOpen?: () => void
}

/**
 * The permission on the entry: the mode's glyph alone in muted ink where something asks, and the amber glyph with the
 * mode's short name where nothing asks or Latch cannot confirm the mode. That state keeps the product's own tokens
 * under any customisation (`data-lock`), as the 权限 chip did.
 */
export function EntryPermissionMark({ view }: { view: PermissionView }) {
  const Glyph = MODE_ICONS[view.icon]
  return (
    <span
      className="entry-permission"
      data-amber={view.amber ? '' : undefined}
      data-lock={view.amber ? '' : undefined}
      // The mark has no words of its own unless amber; the trigger's description says the mode either way.
      aria-hidden="true">
      <Glyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} />
      {view.amber && <span className="entry-permission-name">{escapeHiddenCharacters(view.label)}</span>}
    </span>
  )
}

/** 权限：先问你, then what it means and whose setting it is, as the 权限 chip's tooltip said it. */
export function entryPermissionTip(view: PermissionView): string {
  const tip = permissionTip(view)
  return [COPY.current(escapeHiddenCharacters(view.label)), tip].filter(Boolean).join('。')
}

/**
 * The permission in the panel's foot: the modes as a compact strip, tightest first, with the shown mode's name and its
 * line, the loosest in amber while it is chosen or previewed. Choosing keeps the panel open; a row this device may not
 * choose stays, with its reason. A Harness that reports no modes shows the one that is true now, and pressing it does
 * nothing.
 */
export function EntryPermissionPart({ permission }: { permission: EntryPermission }) {
  const { view } = permission
  const rows = stripRows(view)
  return (
    // What a session may do without asking keeps the product's own tokens under every customisation (tokens.css).
    <div className="entry-permission-part permission-panel" data-lock="">
      <ModeStrip
        compact
        label={COPY.permissions}
        pending={permission.pending === true}
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
          // The one row that is true now is no choice.
          if (view.rows) permission.onChoose(value)
        }}
      />
      {permission.feedback}
    </div>
  )
}
