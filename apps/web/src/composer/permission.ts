import type { HarnessInfo, SessionConfigOption, SessionPermission, TaskMode } from '@latch/protocol'
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
  /** One sentence on what this means: the row's line, and the chip's tooltip. */
  line: string
  icon: ModeIcon
  /** A mode in which the agent never asks, or one Latch cannot confirm. */
  amber: boolean
  /** Nothing can ask, so the menu has no question to put at its head. */
  asksNothing?: boolean
  /** The one honest limit, under the rows. */
  note?: string
  option?: SessionConfigOption
  rows?: PermissionRow[]
}

const modeOption = (config: readonly SessionConfigOption[]) => config.find(option => option.category === 'mode')

type PermissionHarness = Pick<HarnessInfo, 'name' | 'source' | 'level' | 'permission'>

/** The harness's own facts, which need no session: for a draft, and for a session whose detail has not arrived. */
function declaredPermission(harness: PermissionHarness): PermissionView {
  if (harnessLevel(harness) !== 'L3')
    return { label: MODE_COPY.askFirst, line: MODE_COPY.askBeforeWritesLine, icon: 'shield', amber: false }
  const declared = harness.permission
  if (declared?.approvals === 'none')
    return {
      label: MODE_COPY.agentDecides(harness.name),
      line: MODE_COPY.agentDecidesLine(harness.name),
      icon: 'shield-alert',
      amber: true,
    }
  if (declared?.readback === 'none')
    return { label: MODE_COPY.unverifiable, line: MODE_COPY.unverifiableLine(harness.name), icon: 'shield-alert', amber: true }
  if (declared)
    return {
      label: MODE_COPY.askFirst,
      line: MODE_COPY.askFirstLine(harness.name),
      icon: 'shield',
      amber: false,
      note: MODE_COPY.changeAfterStart(harness.name),
    }
  return { label: MODE_COPY.afterStart, line: MODE_COPY.afterStartLine(harness.name), icon: 'shield', amber: false }
}

/** No tools run, so nothing can be asked and no mode applies. */
const chatPermission: PermissionView = {
  label: MODE_COPY.noFiles,
  line: MODE_COPY.noFilesLine,
  icon: 'shield',
  amber: false,
  asksNothing: true,
}

/** What the footer says about a session's permissions. It always says something: the mode with its rows when the agent reports modes. */
export function permissionView(input: {
  harness: PermissionHarness | undefined
  mode?: TaskMode | undefined
  permission?: SessionPermission
  config: readonly SessionConfigOption[]
  access: Pick<DeviceAccess, 'legacy' | 'local'>
  locked?: string
}): PermissionView | undefined {
  const { harness, permission, config, access, locked } = input
  if (!harness) return undefined
  if (input.mode === 'chat') return chatPermission
  if (harnessLevel(harness) !== 'L3') return declaredPermission(harness)
  const option = modeOption(config)
  if (!option) {
    // The session's own report outranks the declaration, and once it started the agent has said what modes it has.
    if (!permission) return declaredPermission(harness)
    const { note: _beforeStart, ...started } = declaredPermission({
      ...harness,
      permission: { approvals: permission.approvals ?? 'prompts', readback: permission.readback ?? 'none' },
    })
    return started
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
  return {
    label: current?.name ?? option.currentValue,
    line: current?.line ?? '',
    icon: current?.icon ?? 'shield',
    amber: current?.neverAsks === true,
    note: MODE_COPY.agentOwnSetting(harness.name),
    option,
    rows,
  }
}

/** Before the first send only what the harness declares is known, and the agent's own modes are not. */
export function draftPermission(harness: PermissionHarness | undefined, mode: TaskMode): PermissionView | undefined {
  return harness && (mode === 'chat' ? chatPermission : declaredPermission(harness))
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
