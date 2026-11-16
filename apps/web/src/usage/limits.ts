import {
  QUOTA_NEAR_PERCENT,
  currentQuota,
  leadingQuotaWindow,
  quotaWindowState,
  type BudgetProgress,
  type HarnessQuota,
  type QuotaGroup,
  type QuotaPlan,
  type QuotaState,
  type QuotaWindow,
} from '@latch/protocol'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The one word for how much of a limit is gone, wherever a limit is shown. */
export const USED = '已用'
/** A limit without a figure, as its program said it: nearly used up, or used up. */
export const LIMIT_WORDS: Record<Exclude<QuotaState, 'ok'>, string> = { near: '将用尽', limited: '已用尽' }

/** One limit window as every place shows it: a Harness's window or a monthly budget. */
export interface LimitView {
  key: string
  /** The model group the window belongs to; windows of one group follow each other under its name. */
  group?: string
  /** 「5 小时」「每周」「本期」「本月预算」. */
  name: string
  state: QuotaState
  /** 0–100, shown whole; absent when the source gave no figure, and then `status` says the state. */
  percent?: number
  status?: string
  /** 「2 小时 5 分钟后重置」; absent for a window that has not started, whose reset would only follow the clock. */
  reset?: string
}

/** A window's length in words: whole days where it is a whole number of them, else hours. */
function lengthWords(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`
  if (minutes % 60 === 0) return `${minutes / 60} 小时`
  return `${minutes} 分钟`
}

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

function windowLength(window: QuotaWindow): number | undefined {
  switch (window.kind) {
    case 'five-hour':
      return 5 * HOUR
    case 'weekly':
    case 'weekly-opus':
    case 'weekly-sonnet':
      return 7 * DAY
    case 'rolling':
      return window.windowMinutes ? window.windowMinutes * MINUTE : undefined
    case 'billing-period':
      return undefined
  }
}

/**
 * 「5 天 23 小时后重置」: two units at most, down to the minute; `brief` keeps the larger one alone. Undefined without a
 * reset time.
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

/**
 * When a window resets, unless it has not started: nothing used of it and a whole window still to go, so its reset time
 * would only move with the clock.
 */
function windowReset(window: QuotaWindow, now: number): string | undefined {
  const length = windowLength(window)
  const left = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt) - now
  if (window.usedPercent === 0 && length !== undefined && Math.abs(left - length) <= MINUTE) return undefined
  return resetWords(window.resetsAt, now)
}

/** A whole figure that never reads 100 before the limit is reached. */
export function shownPercent(used: number): number {
  return used >= 100 ? 100 : Math.max(0, Math.min(99, Math.round(used)))
}

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

/** Latch's own words for a model group; never the Harness's. */
const GROUPS: Record<QuotaGroup, string> = { gemini: 'Gemini 模型', 'claude-gpt': 'Claude 与 GPT 模型' }

function windowView(window: QuotaWindow, now: number): LimitView {
  const state = quotaWindowState(window)
  const reset = windowReset(window, now)
  return {
    key: `${window.group ?? ''}:${window.kind}:${window.windowMinutes ?? ''}`,
    ...(window.group ? { group: GROUPS[window.group] } : {}),
    name: windowName(window),
    state,
    ...(window.usedPercent !== undefined ? { percent: shownPercent(window.usedPercent) } : {}),
    ...(window.usedPercent === undefined && state !== 'ok' ? { status: LIMIT_WORDS[state] } : {}),
    ...(reset ? { reset } : {}),
  }
}

/** What a Harness's limits show at `now`; undefined when nothing it said still holds. */
export interface HarnessLimits {
  state: QuotaState
  windows: LimitView[]
  /** The window the composer stands for: the worst, then the fullest (`leadingQuotaWindow`). */
  tightest: LimitView
  /** The Harness said the account is at a limit that none of its windows shows. */
  account: boolean
  /** Plan, masked account and a prepaid balance above zero, each only when the Harness said it. */
  facts: string[]
}

export function harnessLimits(quota: HarnessQuota | undefined, now: number): HarnessLimits | undefined {
  const held = quota && currentQuota(quota, now)
  const lead = held && leadingQuotaWindow(held.windows)
  if (!held || !lead) return undefined
  return {
    state: held.state,
    windows: held.windows.map(window => windowView(window, now)),
    tightest: windowView(lead, now),
    account: held.state === 'limited' && quotaWindowState(lead) !== 'limited',
    facts: [
      ...(held.plan ? [PLANS[held.plan]] : []),
      ...(held.account ? [held.account] : []),
      ...(held.balanceCents !== undefined && held.balanceCents > 0 ? [`余额 $${(held.balanceCents / 100).toFixed(2)}`] : []),
    ],
  }
}

/** 「已用 68%」, or the state's words for a limit without a figure. */
export function usedWords(view: Pick<LimitView, 'percent' | 'status'>): string {
  return view.percent !== undefined ? `${USED} ${view.percent}%` : (view.status ?? '')
}

/**
 * The composer's words for a limit, in two parts so a narrow row can shorten the name and never the figure: the window's
 * name and how much of it is used (「每周」「已用 68%」), or, without a figure, that it is the limit (「5 小时」「额度将用尽」);
 * an account at a limit no window shows reads 「额度已用尽」 alone.
 */
export function chipParts(limits: Pick<HarnessLimits, 'tightest' | 'account'>): { name: string; figure: string } {
  if (limits.account) return { name: '', figure: `额度${LIMIT_WORDS.limited}` }
  const { tightest } = limits
  return { name: tightest.name, figure: tightest.percent !== undefined ? usedWords(tightest) : `额度${tightest.status ?? ''}` }
}

/** The same words in one run (「每周已用 68%」), for reading out. */
export function chipWords(limits: Pick<HarnessLimits, 'tightest' | 'account'>): string {
  const { name, figure } = chipParts(limits)
  return `${name}${figure}`
}

/** The first day of the month after `month` (`YYYY-MM`), as 「12 月 1 日重置」. */
function monthReset(month: string): string | undefined {
  const match = /^(\d{4})-(\d{2})$/u.exec(month)
  if (!match) return undefined
  const next = (Number(match[2]) % 12) + 1
  return `${next} 月 1 日重置`
}

/** A monthly budget as a limit window: the same bar, the same word, amber from 80% and red when used up. */
export function budgetLimit(budget: BudgetProgress, name: string, month: string): LimitView {
  const share = budget.limit > 0 ? (budget.used / budget.limit) * 100 : 0
  const percent = shownPercent(share)
  const state: QuotaState =
    budget.state === 'over' || share >= 100 ? 'limited' : budget.state === 'near' || share >= QUOTA_NEAR_PERCENT ? 'near' : 'ok'
  const reset = monthReset(month)
  return { key: `${budget.scope}:${budget.id}`, name, state, percent, ...(reset ? { reset } : {}) }
}
