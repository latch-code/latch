import type { HarnessInfo, SessionConfigOption, SessionPermission } from '@latch/protocol'
import { harnessLevel, modeRows, type DeviceAccess, type ModeRow } from '../core/permissions.ts'
import { MODE_COPY } from '../core/securityCopy.ts'

export type ModeIcon = 'eye' | 'shield' | 'shield-alert'

export interface PermissionRow extends ModeRow {
  icon: ModeIcon
  /** The agent never asks in this mode. */
  neverAsks: boolean
  line: string
}

/** What the composer says about who decides, and the rows when the engine has modes to choose from. */
export interface PermissionView {
  label: string
  tooltip: string
  icon: ModeIcon
  /** A mode in which the agent never asks: amber, and it stays at every width. */
  amber: boolean
  /** Whether the footer draws a chip: anything but the engine's default. */
  chip: boolean
  option?: SessionConfigOption
  rows?: PermissionRow[]
}

const modeOption = (config: readonly SessionConfigOption[]) => config.find(option => option.category === 'mode')

const askTooltip = (harness: Pick<HarnessInfo, 'source'>) =>
  harness.source === 'builtin' ? MODE_COPY.askBeforeWritesTooltip : MODE_COPY.askWhenNeededTooltip

/**
 * What the footer says about a session's permissions. The engine's default mode draws nothing, and the choice stays in
 * the model control. A mode away from it always shows, and so does an engine Latch cannot read back or limit, since
 * there is no default to fall back on.
 */
export function permissionView(input: {
  harness: Pick<HarnessInfo, 'name' | 'source' | 'level'> | undefined
  permission?: SessionPermission
  config: readonly SessionConfigOption[]
  access: Pick<DeviceAccess, 'legacy' | 'local'>
  locked?: string
}): PermissionView | undefined {
  const { harness, permission, config, access, locked } = input
  if (!harness) return undefined
  if (harnessLevel(harness) !== 'L3')
    return { label: MODE_COPY.askWhenNeeded, tooltip: askTooltip(harness), icon: 'shield', amber: false, chip: false }
  const option = modeOption(config)
  if (!option) {
    // A session whose detail has not arrived yet says nothing rather than something wrong.
    if (!permission) return undefined
    if (permission.approvals === 'none')
      return {
        label: MODE_COPY.agentDecides(harness.name),
        tooltip: MODE_COPY.agentDecidesTooltip(harness.name),
        icon: 'shield',
        amber: false,
        chip: true,
      }
    if (permission.readback !== 'mode')
      return {
        label: MODE_COPY.unverifiable,
        tooltip: MODE_COPY.unverifiableTooltip(harness.name),
        icon: 'shield',
        amber: false,
        chip: true,
      }
    return undefined
  }
  const never = new Set(permission?.neverAskModes)
  const rows = modeRows(option, access, locked).map((row, index): PermissionRow => {
    const neverAsks = never.has(row.value)
    return {
      ...row,
      neverAsks,
      icon: neverAsks ? 'shield-alert' : index === 0 && option.options.length > 1 ? 'eye' : 'shield',
      line: neverAsks ? MODE_COPY.neverAsksLine(harness.name) : (row.description ?? ''),
    }
  })
  const current = rows.find(row => row.current)
  const standing = permission?.defaultMode ?? permission?.expectedMode
  const amber = current?.neverAsks === true
  return {
    label: current?.name ?? option.currentValue,
    tooltip: current?.line ?? '',
    icon: current?.icon ?? 'shield',
    amber,
    chip: amber || option.currentValue !== standing,
    option,
    rows,
  }
}

/** Before the first send nothing has told Latch an external engine's modes, so the popover says when they appear. */
export function draftPermission(harness: Pick<HarnessInfo, 'name' | 'source' | 'level'> | undefined): PermissionView | undefined {
  if (!harness) return undefined
  if (harnessLevel(harness) !== 'L3')
    return { label: MODE_COPY.askWhenNeeded, tooltip: askTooltip(harness), icon: 'shield', amber: false, chip: false }
  return { label: MODE_COPY.afterStart, tooltip: MODE_COPY.afterStartTooltip(harness.name), icon: 'shield', amber: false, chip: false }
}

const thousands = (value: number) => (value >= 1000 ? `${Math.round(value / 1000)}K` : String(value))

type ContextReport = { contextUsed?: number; contextSize?: number } | undefined

/** How full the context is, only from what the engine itself reported. */
export function contextWords(report: ContextReport): { percent: number; words: string } | undefined {
  const used = report?.contextUsed
  const size = report?.contextSize
  if (used === undefined || !size || size <= 0) return undefined
  const percent = Math.min(100, Math.round((used / size) * 100))
  return { percent, words: `上下文已用 ${percent}% · ${thousands(used)} / ${thousands(size)}` }
}

/** The footer's ring appears from half full. */
export function contextUse(report: ContextReport): { percent: number; words: string } | undefined {
  const use = contextWords(report)
  return use && use.percent >= 50 ? use : undefined
}
