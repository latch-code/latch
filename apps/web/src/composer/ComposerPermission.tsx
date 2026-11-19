import type { ReactNode } from 'react'
import { ICON_STROKE, Popover, Spinner, Tooltip } from '@latch/ui'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { defineCopy } from '../core/i18n.ts'
import { MODE_ICONS, PermissionPanel } from './PermissionList.tsx'
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

/** The session's permission as the input's line shows and sets it. */
export interface ComposerPermissionState {
  view: PermissionView
  /** A mode chosen in the popover; the strip keeps showing the mode the Host confirmed. */
  onChoose: (value: string) => void
  /** A write of the mode is under way. */
  pending?: boolean
  /** What the last write of the mode came to when it did not settle: under the strip. */
  feedback?: ReactNode
  /** The popover opened: a draft reads its modes then, when they are first needed. */
  onOpen?: () => void
}

/** 「权限：先问你。」 then what it means and whose setting it is: the control's hover. */
export function permissionControlTip(view: PermissionView): string {
  const tip = permissionTip(view)
  return [COPY.current(escapeHiddenCharacters(view.label)), tip].filter(Boolean).join('。')
}

/**
 * 权限 on the input's line, right after the Harness: the mode's glyph alone, at the line's glyph size, where something
 * asks; the amber glyph with the mode's short name where nothing asks or Latch cannot confirm the mode, under the
 * product's own tokens whatever the customisation (`data-lock`). It always opens, to the modes as segments
 * (`PermissionPanel`): a row this device may not choose stays, with its reason; a Harness that reports no modes shows the
 * one that is true now. Choosing keeps the popover open, so a write under way and what it came to show where it was made.
 */
export function ComposerPermission({ permission }: { permission: ComposerPermissionState | undefined }) {
  if (!permission)
    return (
      <button type="button" className="chip composer-permission" aria-label={COPY.permissions} disabled>
        <span className="chip-text">{COPY.permissions}</span>
      </button>
    )
  const { view, pending = false } = permission
  const Glyph = MODE_ICONS[view.icon]
  const label = escapeHiddenCharacters(view.label)
  return (
    <Popover
      label={COPY.permissions}
      size="sm"
      side="auto"
      onOpenChange={open => {
        if (open) permission.onOpen?.()
      }}
      trigger={props => (
        <Tooltip content={permissionControlTip(view)}>
          <button
            {...props}
            type="button"
            className="chip composer-permission"
            data-amber={view.amber ? '' : undefined}
            data-lock={view.amber ? '' : undefined}
            aria-label={COPY.current(label)}
            aria-busy={pending || undefined}>
            {pending ? <Spinner size={16} /> : <Glyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />}
            {view.amber && <span className="chip-text composer-permission-name">{label}</span>}
          </button>
        </Tooltip>
      )}>
      <PermissionPanel view={view} onChoose={permission.onChoose} keepOpen pending={pending} feedback={permission.feedback} />
    </Popover>
  )
}
