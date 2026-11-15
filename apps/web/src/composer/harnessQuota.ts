import {
  currentQuota,
  leadingQuotaWindow,
  quotaWindowState,
  type HarnessQuota,
  type QuotaGroup,
  type QuotaPlan,
  type QuotaState,
  type QuotaWindow,
} from '@latch/protocol'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A window's length in words: whole days where it is a whole number of them, else hours. */
function lengthWords(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`
  if (minutes % 60 === 0) return `${minutes / 60} 小时`
  return `${minutes} 分钟`
}

/** A window as a row of the panel names it. */
function windowName(window: QuotaWindow): string {
  switch (window.kind) {
    case 'five-hour':
      return '5 小时'
    case 'weekly':
      return '每周'
    case 'weekly-opus':
      return '每周 · Opus'
    case 'weekly-sonnet':
      return '每周 · Sonnet'
    case 'billing-period':
      return '本期'
    case 'rolling':
      return window.windowMinutes ? lengthWords(window.windowMinutes) : '额度'
  }
}

/** A window as the one line names it: the weekly ones by their length. */
function lineName(window: QuotaWindow): string {
  switch (window.kind) {
    case 'weekly':
      return '7 天'
    case 'weekly-opus':
      return '7 天 Opus '
    case 'weekly-sonnet':
      return '7 天 Sonnet '
    case 'billing-period':
      return '本期'
    default:
      return windowName(window)
  }
}

/**
 * 「5 天 23 小时后重置」: two units at most, down to the minute; `brief` keeps the larger one alone, for the mark.
 * Undefined without a reset time.
 */
export function resetWords(resetsAt: string | undefined, now: number, brief = false): string | undefined {
  if (resetsAt === undefined) return undefined
  const left = Date.parse(resetsAt) - now
  if (!Number.isFinite(left)) return undefined
  if (left < MINUTE) return '即将重置'
  const days = Math.floor(left / DAY)
  const hours = Math.floor((left % DAY) / HOUR)
  const minutes = Math.floor((left % HOUR) / MINUTE)
  const span =
    days > 0
      ? `${days} 天${hours && !brief ? ` ${hours} 小时` : ''}`
      : hours > 0
        ? `${hours} 小时${minutes && !brief ? ` ${minutes} 分钟` : ''}`
        : `${minutes} 分钟`
  return `${span}后重置`
}

/** A whole figure that never reads 100 before the window is used up. */
function shownPercent(used: number): number {
  return used >= 100 ? 100 : Math.min(99, Math.round(used))
}

const STATUS: Record<Exclude<QuotaState, 'ok'>, string> = { near: '将用尽', limited: '已用尽' }

const PLANS: Record<QuotaPlan, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  promax: 'Pro Max',
  max: 'Max',
  ultra: 'Ultra',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
  supergrok: 'SuperGrok',
  'supergrok-heavy': 'SuperGrok Heavy',
}

/** Latch's own words for a model group; never the harness's. */
const GROUPS: Record<QuotaGroup, string> = { gemini: 'Gemini 模型', 'claude-gpt': 'Claude 与 GPT 模型' }

export interface QuotaRow {
  key: string
  /** The model group the row belongs to; rows of one group follow each other under its name. */
  group?: string
  name: string
  state: QuotaState
  /** Absent: the Harness gave no figure, and the row says `status` instead of drawing a bar. */
  percent?: number
  status?: string
  reset?: string
}

export interface QuotaView {
  state: QuotaState
  /** The figure the ring draws; absent for a warning the Harness gave without one. */
  percent?: number
  /** Beside the mark: the figure, or for a warning when it resets. */
  text: string
  /** The one line of the tooltip, also the mark's accessible name. */
  line: string
  rows: QuotaRow[]
  /** Plan, masked account and prepaid balance, in that order; each only when the Harness said it. */
  facts: string[]
}

function row(window: QuotaWindow, now: number): QuotaRow {
  const state = quotaWindowState(window)
  const reset = resetWords(window.resetsAt, now)
  return {
    key: `${window.group ?? ''}:${window.kind}:${window.windowMinutes ?? ''}`,
    ...(window.group ? { group: GROUPS[window.group] } : {}),
    name: windowName(window),
    state,
    ...(window.usedPercent !== undefined ? { percent: shownPercent(window.usedPercent) } : {}),
    ...(window.usedPercent === undefined && state !== 'ok' ? { status: STATUS[state] } : {}),
    ...(reset ? { reset } : {}),
  }
}

/** What the mark and its panel show at `now`; undefined when nothing still holds, and then nothing is drawn. */
export function quotaView(quota: HarnessQuota | undefined, now: number): QuotaView | undefined {
  const held = quota && currentQuota(quota, now)
  const lead = held && leadingQuotaWindow(held.windows)
  if (!held || !lead) return undefined
  const leadState = quotaWindowState(lead)
  const reset = resetWords(lead.resetsAt, now)
  const percent = lead.usedPercent === undefined ? undefined : shownPercent(lead.usedPercent)
  // A window without a figure is only kept while the Harness warns about it.
  const warned = STATUS[leadState === 'ok' ? 'near' : leadState]
  // The Harness may say the account is at a limit that none of its windows shows.
  const account = held.state === 'limited' && leadState !== 'limited'
  const said =
    account || leadState === 'limited' ? `额度${STATUS.limited}` : percent === undefined ? `额度${warned}` : `额度已用 ${percent}%`
  return {
    state: held.state,
    ...(percent !== undefined ? { percent } : {}),
    text: percent !== undefined ? `${percent}%` : (resetWords(lead.resetsAt, now, true) ?? warned),
    line: `${account ? '' : `${lead.group ? `${GROUPS[lead.group]} · ` : ''}${lineName(lead)}`}${said}${reset && !account ? ` · ${reset}` : ''}`,
    rows: held.windows.map(window => row(window, now)),
    facts: [
      ...(held.plan ? [PLANS[held.plan]] : []),
      ...(held.account ? [held.account] : []),
      ...(held.balanceCents !== undefined ? [`余额 $${(held.balanceCents / 100).toFixed(2)}`] : []),
    ],
  }
}
