import { builtinMode, modeScopes } from '@latch/protocol'
import type {
  DeviceScope,
  HarnessInfo,
  ModeGlyph,
  ModeTier,
  PermissionTier,
  SessionConfigOption,
  SessionPermission,
  TaskMode,
} from '@latch/protocol'
import { modeRows, type DeviceAccess, type ModeRow } from '../core/permissions.ts'
import { MODE_COPY, type Brief } from '../core/securityCopy.ts'

/**
 * A mode's glyph. The first five are the tiers'; `plan` and `question` are what a harness documents a mode does where two
 * share a tier (`ModeTier.glyph`); the shapes are for modes Latch knows nothing of, so each segment stays its own and
 * the name under the strip says which it is.
 */
export type ModeIcon =
  | 'eye'
  | 'shield'
  | 'list-checks'
  | 'scale'
  | 'shield-alert'
  | 'plan'
  | 'question'
  | 'circle'
  | 'square'
  | 'triangle'
  | 'diamond'
  | 'hexagon'
  | 'pentagon'
  | 'octagon'
const UNKNOWN_ICONS: readonly ModeIcon[] = ['circle', 'square', 'triangle', 'diamond', 'hexagon', 'pentagon', 'octagon']

export interface PermissionRow extends ModeRow {
  icon: ModeIcon
  /** Latch's word for the mode, when Latch knows the harness's modes. */
  tier?: PermissionTier
  /** The agent never asks in this mode. */
  neverAsks: boolean
  line: string
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
 * The agent's modes as rows. Where Latch knows its modes, each is titled by its tier with the harness's own line, in tier
 * order. Unclassified native choices keep their own names and descriptions without acquiring a permission rank.
 */
function tierRows(
  option: SessionConfigOption,
  tiers: Readonly<Record<string, ModeTier>> | undefined,
  glyphs: Readonly<Record<string, ModeGlyph>> | undefined,
  locked: string | undefined,
): PermissionRow[] {
  const known = tiers !== undefined && Object.keys(tiers).length > 0
  // Every row draws a glyph of its own: the one the Harness's profile documents for it, else its tier's; the first mode
  // with neither the plain shield of a Harness's own setting, unless a tier took it; any other a plain shape. Nothing is
  // guessed from a mode's name.
  const taken = new Set<ModeIcon>()
  const unknown = [...UNKNOWN_ICONS]
  const all = modeRows(option, locked)
  const ranked = new Set(all.flatMap(row => (tiers?.[row.value] ? [TIER_ICONS[tiers[row.value]!.tier]] : [])))
  const rows = all.flatMap(row => {
    const tier = tiers?.[row.value]
    const glyph = glyphs?.[row.value]
    const wanted: ModeIcon | undefined = glyph ?? (tier ? TIER_ICONS[tier.tier] : ranked.has('shield') ? undefined : 'shield')
    const icon: ModeIcon = wanted && !taken.has(wanted) ? wanted : (unknown.shift() ?? 'circle')
    taken.add(icon)
    return [
      {
        ...row,
        ...(tier ? { name: tier.name ?? MODE_COPY.tierTitles[tier.tier], tier: tier.tier } : {}),
        icon,
        neverAsks: tier?.tier === 'never',
        line: tier?.line ?? row.description ?? '',
      },
    ]
  })
  if (known) rows.sort((a, b) => (a.tier ? TIER_ORDER[a.tier] : 5) - (b.tier ? TIER_ORDER[b.tier] : 5))
  return rows
}

/** What the composer says about who decides, and the rows when the engine has modes to choose from. */
export interface PermissionView {
  label: string
  /** A few words on what this means: the row's line. */
  line: string
  icon: ModeIcon
  /** A mode in which the agent never asks, or one Latch cannot confirm. */
  amber: boolean
  /** Nothing can ask, so the menu has no question to put at its head. */
  asksNothing?: boolean
  /** The one honest limit, under the rows: a short label, the fine print behind its ⓘ. */
  note?: Brief
  option?: SessionConfigOption
  rows?: PermissionRow[]
  /** What the Harness's own settings decide beside the mode for this session (OpenCode's 「总是允许」, pi's `.pi`). */
  inEffect?: string[]
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
 * Under a draft's one declared row: a read of the modes under way, or one that failed. A read reports them where it opens
 * a session; Codex's own model list does not, so its modes come with the first session.
 */
function modesNote(harness: PermissionHarness, read: DraftRead | undefined): { note?: Brief } {
  const name = harness.capabilities.display.label
  const readsModes = harness.catalogueRead?.modes === true
  // What a session or such a read reported had no modes: there is nothing to change to.
  if (harness.catalogue && (harness.catalogue.source === 'session' || readsModes)) return {}
  if (readsModes && read === 'reading') return { note: MODE_COPY.modesReading(name) }
  if (readsModes && read === 'readable' && harness.catalogueRead?.last?.ok === false) return { note: MODE_COPY.modesUnread(name) }
  // Nothing more to say before they are known: the one row is what the session starts in.
  return {}
}

/**
 * The 权限 chip's tooltip: the current row's line, then the note (whose setting it is, that Latch does not isolate the
 * agent, when the rows can change), each as one short sentence.
 */
export function permissionTip(view: PermissionView): string | undefined {
  const note = view.note && [view.note.label, view.note.detail].filter(Boolean).join('：')
  const parts = [view.line, note].filter(Boolean)
  return parts.length ? parts.join('。') : undefined
}

/** A Latch 内置 level this device may choose: it holds the approvals the level answers for the person. */
function choosable(value: string, scopes: ReadonlySet<DeviceScope> | undefined): boolean {
  const mode = builtinMode(value)
  if (!mode) return false
  return scopes === undefined || modeScopes(mode).every(scope => scopes.has(scope))
}

/** The harness's own facts, which need no session: for a draft, and for a session whose detail has not arrived. */
function declaredPermission(harness: PermissionHarness, read?: DraftRead): PermissionView {
  if (harness.level !== 'L3') {
    const initial = Object.values(harness.permission?.modeTiers ?? {}).find(tier => tier.tier === 'ask')
    return {
      label: initial?.name ?? MODE_COPY.askFirst,
      line: initial?.line ?? MODE_COPY.askBeforeWritesLine,
      icon: 'shield',
      amber: false,
    }
  }
  const declared = harness.permission
  if (declared?.approvals === 'none')
    return {
      label: MODE_COPY.agentDecides(harness.capabilities.display.label),
      line: MODE_COPY.agentDecidesRow,
      icon: 'shield-alert',
      amber: true,
      note: {
        ...MODE_COPY.agentDecidesNote(harness.capabilities.display.label),
        ...(harness.capabilities.display.mark ? { mark: harness.capabilities.display.mark } : {}),
      },
    }
  if (declared?.readback === 'none')
    return {
      label: MODE_COPY.unverifiable,
      line: MODE_COPY.unverifiableLine,
      icon: 'shield-alert',
      amber: true,
    }
  if (declared) {
    const initial = Object.values(declared.modeTiers ?? {}).find(tier => tier.tier === 'ask')
    return {
      label: initial?.name ?? MODE_COPY.askFirst,
      // A profile's one `ask` mode is the one its sessions start in: the line the session's own row shows.
      line: initial?.line ?? MODE_COPY.askFirstLine,
      icon: 'shield',
      amber: false,
      ...modesNote(harness, read),
    }
  }
  // The title says when the rows come; a line under it would only repeat it.
  if (read === 'reading') return { label: MODE_COPY.reading, line: '', icon: 'shield', amber: false }
  if (read === 'readable') return { label: MODE_COPY.afterRead, line: '', icon: 'shield', amber: false }
  return { label: MODE_COPY.afterStart, line: '', icon: 'shield', amber: false }
}

/** No tools run, so nothing can be asked and no mode applies. */
const chatPermission = (): PermissionView => ({
  label: MODE_COPY.noFiles,
  line: MODE_COPY.noFilesLine,
  icon: 'shield',
  amber: false,
  asksNothing: true,
})

/** What the footer says about a session's permissions. It always says something: the mode with its rows when the agent reports modes. */
export function permissionView(input: {
  harness: PermissionHarness | undefined
  mode?: TaskMode | undefined
  permission?: Partial<Pick<SessionPermission, 'approvals' | 'readback' | 'modeTiers' | 'modeGlyphs' | 'inEffect'>>
  config: readonly SessionConfigOption[]
  access: Pick<DeviceAccess, 'legacy' | 'local'> & { scopes?: ReadonlySet<DeviceScope> }
  locked?: string
}): PermissionView | undefined {
  const view = baseView(input)
  const inEffect = input.permission?.inEffect?.slice(0, 24)
  return view && inEffect?.length ? { ...view, inEffect } : view
}

function baseView(input: Parameters<typeof permissionView>[0]): PermissionView | undefined {
  const { harness, permission, config, access, locked } = input
  if (!harness) return undefined
  if (input.mode === 'chat') return chatPermission()
  // Latch 内置's levels are Latch's own: no Harness setting to note, and only those this device may choose.
  if (harness.level !== 'L3') {
    const option = modeOption(config)
    if (!option || !permission?.modeTiers) return declaredPermission(harness)
    const rows = tierRows(option, permission.modeTiers, undefined, locked).filter(row => row.current || choosable(row.value, access.scopes))
    const current = rows.find(row => row.current)
    return {
      label: current?.name ?? MODE_COPY.askFirst,
      line: current?.line ?? '',
      icon: current?.icon ?? 'shield',
      amber: current?.neverAsks === true,
      option,
      rows,
    }
  }
  const option = modeOption(config)
  if (!option) {
    // The session's own report outranks the declaration, and once it started the agent has said what modes it has.
    if (!permission) return declaredPermission(harness)
    const declared = declaredPermission({
      ...harness,
      permission: { approvals: permission.approvals ?? 'prompts', readback: permission.readback ?? 'none' },
    })
    // When the rows can be changed is a draft's note; who decides stays.
    if (declared.amber) return declared
    const { note: _beforeStart, ...started } = declared
    return started
  }
  const rows = tierRows(option, permission?.modeTiers, permission?.modeGlyphs, locked)
  const current = rows.find(row => row.current)
  return {
    label: current?.name ?? option.currentValue,
    line: current?.line ?? '',
    // A mode Latch knows nothing of is still the Harness's setting: the chip keeps the shield; its shape is the strip's.
    icon: current?.tier ? current.icon : 'shield',
    amber: current?.neverAsks === true,
    note:
      option.source === 'launch'
        ? MODE_COPY.launchSetting
        : {
            ...MODE_COPY.agentOwnSetting(harness.capabilities.display.label),
            ...(harness.capabilities.display.mark ? { mark: harness.capabilities.display.mark } : {}),
          },
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
  scopes?: ReadonlySet<DeviceScope>,
): PermissionView | undefined {
  if (!harness) return undefined
  if (mode === 'chat') return chatPermission()
  if (!config || !modeOption(config)) return declaredPermission(harness, read)
  return permissionView({
    harness,
    mode,
    ...(harness.permission ? { permission: harness.permission } : {}),
    config,
    access: { legacy: false, local: true, ...(scopes ? { scopes } : {}) },
  })
}
