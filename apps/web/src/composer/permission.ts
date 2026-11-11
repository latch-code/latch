import type { HarnessInfo, ModeTier, PermissionTier, SessionConfigOption, SessionPermission, TaskMode } from '@latch/protocol'
import { modeRows, type DeviceAccess, type ModeRow } from '../core/permissions.ts'
import { MODE_COPY } from '../core/securityCopy.ts'
import { contextTotals } from './sessionTotals.ts'

export type ModeIcon = 'eye' | 'shield' | 'list-checks' | 'scale' | 'shield-alert'

export interface PermissionRow extends ModeRow {
  icon: ModeIcon
  /** Latch's word for the mode, when Latch knows the harness's modes. */
  tier?: PermissionTier
  /** The agent never asks in this mode. */
  neverAsks: boolean
  line: string
  /** Shown under 更多: the menu's main rows are at most three. */
  more: boolean
}

export const TIER_ORDER: Record<PermissionTier, number> = { plan: 0, ask: 1, rule: 2, model: 3, never: 4 }
const TIER_ICONS: Record<PermissionTier, ModeIcon> = {
  plan: 'eye',
  ask: 'shield',
  rule: 'list-checks',
  model: 'scale',
  never: 'shield-alert',
}

/**
 * The menu's main rows, at most three: asking first, one middle row (the model's when there is one, else the rules'),
 * and never asking. Only reading and the other middle row go under 更多, and only when there are more than three.
 */
function mainValues(rows: ReadonlyArray<{ value: string; tier?: PermissionTier }>): Set<string> {
  if (rows.length <= 3 || !rows.some(row => row.tier)) return new Set(rows.map(row => row.value))
  const first = (tier: PermissionTier) => rows.find(row => row.tier === tier)
  const main = [first('ask'), first('model') ?? first('rule'), first('never')].flatMap(row => (row ? [row.value] : []))
  return new Set(main.length ? main : [rows[0]!.value])
}

/**
 * The agent's modes as rows. Where Latch knows its modes, each is titled by its tier with the harness's own line, in tier
 * order, and a mode Latch has no word for is left out unless it is the current one, which keeps the agent's own name.
 */
function tierRows(
  option: SessionConfigOption,
  tiers: Readonly<Record<string, ModeTier>> | undefined,
  locked: string | undefined,
): PermissionRow[] {
  const known = tiers !== undefined && Object.keys(tiers).length > 0
  const rows = modeRows(option, locked).flatMap((row, index) => {
    const tier = tiers?.[row.value]
    if (known && !tier && !row.current) return []
    const icon: ModeIcon = tier ? TIER_ICONS[tier.tier] : !known && index === 0 && option.options.length > 1 ? 'eye' : 'shield'
    return [
      {
        ...row,
        ...(tier ? { name: MODE_COPY.tierTitles[tier.tier], tier: tier.tier } : {}),
        icon,
        neverAsks: tier?.tier === 'never',
        line: tier?.line ?? row.description ?? '',
        more: false,
      },
    ]
  })
  if (known) rows.sort((a, b) => (a.tier ? TIER_ORDER[a.tier] : 5) - (b.tier ? TIER_ORDER[b.tier] : 5))
  const main = mainValues(rows)
  return rows.map(row => ({ ...row, more: !row.current && !main.has(row.value) }))
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

type PermissionHarness = Pick<HarnessInfo, 'capabilities' | 'level' | 'permission'>
  & Partial<Pick<HarnessInfo, 'catalogue' | 'catalogueRead'>>

/** Before the first send, how a draft can still learn the Harness's modes without a session. */
export type DraftRead = 'reading' | 'readable'

/**
 * A read of the Harness's lists under way, here or on the Host, or one this device can start because nothing is known
 * of the Harness yet.
 */
export function draftRead(
  harness: Pick<HarnessInfo, 'catalogue' | 'catalogueRead' | 'status'> | undefined,
  access: Pick<DeviceAccess, 'scopes'>,
  reading: boolean,
): DraftRead | undefined {
  if (!harness) return undefined
  if (reading) return 'reading'
  return harness.catalogueRead && !harness.catalogue && harness.status === 'ready' && access.scopes.has('run') ? 'readable' : undefined
}

/**
 * Under a draft's one declared row: when the other modes can be chosen. A read reports them where it opens a session;
 * Codex's own model list does not, so its modes come with the first session.
 */
function modesNote(harness: PermissionHarness, read: DraftRead | undefined): { note?: string } {
  const name = harness.capabilities.display.label
  const readsModes = harness.catalogueRead?.modes === true
  // What a session or such a read reported had no modes: there is nothing to change to.
  if (harness.catalogue && (harness.catalogue.source === 'session' || readsModes)) return {}
  if (readsModes && read === 'reading') return { note: MODE_COPY.modesReading(name) }
  if (readsModes && read === 'readable')
    return { note: harness.catalogueRead?.last?.ok === false ? MODE_COPY.modesUnread(name) : MODE_COPY.changeAfterRead(name) }
  return { note: MODE_COPY.changeAfterStart(name) }
}

/** The harness's own facts, which need no session: for a draft, and for a session whose detail has not arrived. */
function declaredPermission(harness: PermissionHarness, read?: DraftRead): PermissionView {
  if (harness.level !== 'L3') return { label: MODE_COPY.askFirst, line: MODE_COPY.askBeforeWritesLine, icon: 'shield', amber: false }
  const declared = harness.permission
  if (declared?.approvals === 'none')
    return {
      label: MODE_COPY.agentDecides(harness.capabilities.display.label),
      line: MODE_COPY.agentDecidesLine(harness.capabilities.display.label),
      icon: 'shield-alert',
      amber: true,
    }
  if (declared?.readback === 'none')
    return {
      label: MODE_COPY.unverifiable,
      line: MODE_COPY.unverifiableLine(harness.capabilities.display.label),
      icon: 'shield-alert',
      amber: true,
    }
  if (declared)
    return {
      label: MODE_COPY.askFirst,
      // A profile's one `ask` mode is the one its sessions start in: the line the session's own row shows.
      line:
        Object.values(declared.modeTiers ?? {}).find(tier => tier.tier === 'ask')?.line
        ?? MODE_COPY.askFirstLine(harness.capabilities.display.label),
      icon: 'shield',
      amber: false,
      ...modesNote(harness, read),
    }
  const name = harness.capabilities.display.label
  if (read === 'reading') return { label: MODE_COPY.reading, line: MODE_COPY.readingLine(name), icon: 'shield', amber: false }
  if (read === 'readable') return { label: MODE_COPY.afterRead, line: MODE_COPY.afterReadLine(name), icon: 'shield', amber: false }
  return { label: MODE_COPY.afterStart, line: MODE_COPY.afterStartLine(name), icon: 'shield', amber: false }
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
  permission?: Partial<Pick<SessionPermission, 'approvals' | 'readback' | 'modeTiers'>>
  config: readonly SessionConfigOption[]
  access: Pick<DeviceAccess, 'legacy' | 'local'>
  locked?: string
}): PermissionView | undefined {
  const { harness, permission, config, access, locked } = input
  if (!harness) return undefined
  if (input.mode === 'chat') return chatPermission
  if (harness.level !== 'L3') return declaredPermission(harness)
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
  const rows = tierRows(option, permission?.modeTiers, locked)
  const current = rows.find(row => row.current)
  return {
    label: current?.name ?? option.currentValue,
    line: current?.line ?? '',
    icon: current?.icon ?? 'shield',
    amber: current?.neverAsks === true,
    note: MODE_COPY.agentOwnSetting(harness.capabilities.display.label),
    option,
    rows,
  }
}

/**
 * Before the first send: the modes the Harness's last session or read offered, with the one this draft picked, when one
 * has told Latch; otherwise what the harness declares, or that a read can tell (`read`).
 */
export function draftPermission(
  harness: PermissionHarness | undefined,
  mode: TaskMode,
  config?: readonly SessionConfigOption[],
  read?: DraftRead,
): PermissionView | undefined {
  if (!harness) return undefined
  if (mode === 'chat') return chatPermission
  if (!config || !modeOption(config)) return declaredPermission(harness, read)
  return permissionView({
    harness,
    mode,
    ...(harness.permission ? { permission: harness.permission } : {}),
    config,
    access: { legacy: false, local: true },
  })
}

const thousands = (value: number) => (value >= 1000 ? `${Math.round(value / 1000)}K` : String(value))

type ContextReport = { contextUsed?: number; contextSize?: number } | undefined

/** How full the context is, only from what the engine itself reported: the same share as the composer's status line. */
export function contextWords(report: ContextReport): { percent: number; words: string } | undefined {
  const context = contextTotals(report)
  if (context?.size === undefined || context.percent === undefined) return undefined
  const { used, size, percent } = context
  return { percent, words: `上下文已用 ${percent}% · ${thousands(used)} / ${thousands(size)}` }
}
