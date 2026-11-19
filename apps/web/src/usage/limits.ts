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
import { currentLocale, defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    used: (percent: string) => `已用 ${percent}`,
    days: (count: number) => plural(count, { other: '{n} 天' }),
    hours: (count: number) => plural(count, { other: '{n} 小时' }),
    minutes: (count: number) => plural(count, { other: '{n} 分钟' }),
    limitReached: '额度已用尽',
    limitNear: '额度将用尽',
    chip: (name: string, figure: string) => `${name}${figure}`,
    monthlyReset: (month: number) => `${month} 月 1 日重置`,
    balance: (amount: string) => `余额 ${amount}`,
    near: '将用尽',
    limited: '已用尽',
    weekly: '每周',
    opus: '每周 · Opus',
    sonnet: '每周 · Sonnet',
    currentWindow: '本期',
    quota: '额度',
    resetSoon: '即将重置',
    resetAfter: (value1: string | number) => `${value1}后重置`,
    gemini: 'Gemini 模型',
    claudeGpt: 'Claude 与 GPT 模型',
    shortFiveHour: '5 小时',
    shortWeekly: '周',
    shortOpus: '周 Opus',
    shortSonnet: '周 Sonnet',
    shortDays: (count: number) => `${count} 天`,
    shortHours: (count: number) => `${count} 小时`,
    shortMinutes: (count: number) => `${count} 分钟`,
    part: (name: string, figure: string) => `${name} ${figure}`,
    reads: (part: string, reset: string) => `${part}，${reset}`,
  },
  {
    used: (percent: string) => `${percent} used`,
    days: (count: number) => plural(count, { one: '{n} day', other: '{n} days' }),
    hours: (count: number) => plural(count, { one: '{n} hour', other: '{n} hours' }),
    minutes: (count: number) => plural(count, { one: '{n} minute', other: '{n} minutes' }),
    limitReached: 'Limit reached',
    limitNear: 'Near limit',
    chip: (name: string, figure: string) => [name, figure].filter(Boolean).join(' '),
    monthlyReset: (month: number) =>
      `Resets ${new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.UTC(2024, month - 1, 1))}`,
    balance: (amount: string) => `Balance ${amount}`,
    near: 'Nearly reached',
    limited: 'Reached',
    weekly: 'Weekly',
    opus: 'Weekly · Opus',
    sonnet: 'Weekly · Sonnet',
    currentWindow: 'Current period',
    quota: 'Limit',
    resetSoon: 'Resets soon',
    resetAfter: (value1: string | number) => `Resets in ${value1}`,
    gemini: 'Gemini models',
    claudeGpt: 'Claude and GPT models',
    shortFiveHour: '5h',
    shortWeekly: 'wk',
    shortOpus: 'wk Opus',
    shortSonnet: 'wk Sonnet',
    shortDays: (count: number) => `${count}d`,
    shortHours: (count: number) => `${count}h`,
    shortMinutes: (count: number) => `${count}m`,
    part: (name: string, figure: string) => `${name} ${figure}`,
    reads: (part: string, reset: string) => `${part}, ${reset}`,
  },
)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A limit without a figure, as its program said it: nearly used up, or used up. */
export const LIMIT_WORDS: Record<Exclude<QuotaState, 'ok'>, string> = {
  get near() {
    return COPY.near
  },
  get limited() {
    return COPY.limited
  },
}

/** One limit window as every place shows it: a Harness's window or a monthly budget. */
export interface LimitView {
  key: string
  /** The model group the window belongs to; windows of one group follow each other under its name. */
  group?: string
  /** 「5 小时」「每周」「本期」「本月预算」. */
  name: string
  /** The name as the composer's mark says it beside another window: 「5 小时」「周」. */
  short?: string
  state: QuotaState
  /** 0–100, shown whole; absent when the source gave no figure, and then `status` says the state. */
  percent?: number
  status?: string
  /** 「2 小时 5 分钟后重置」; absent for a window that has not started, whose reset would only follow the clock. */
  reset?: string
}

/** A window's length in words: whole days where it is a whole number of them, else hours. */
function lengthWords(minutes: number): string {
  if (minutes % 1440 === 0) return COPY.days(minutes / 1440)
  if (minutes % 60 === 0) return COPY.hours(minutes / 60)
  return COPY.minutes(minutes)
}

function windowName(window: QuotaWindow): string {
  switch (window.kind) {
    case 'five-hour':
      return COPY.hours(5)
    case 'weekly':
      return COPY.weekly
    case 'weekly-opus':
      return COPY.opus
    case 'weekly-sonnet':
      return COPY.sonnet
    case 'billing-period':
      return COPY.currentWindow
    case 'rolling':
      return window.windowMinutes ? lengthWords(window.windowMinutes) : COPY.quota
  }
}

/** The name the composer's mark gives a window beside another: 「5 小时」「周」「周 Opus」. */
function windowShort(window: QuotaWindow): string {
  switch (window.kind) {
    case 'five-hour':
      return COPY.shortFiveHour
    case 'weekly':
      return COPY.shortWeekly
    case 'weekly-opus':
      return COPY.shortOpus
    case 'weekly-sonnet':
      return COPY.shortSonnet
    case 'billing-period':
      return COPY.currentWindow
    case 'rolling': {
      const minutes = window.windowMinutes
      if (!minutes) return COPY.quota
      if (minutes % 1440 === 0) return COPY.shortDays(minutes / 1440)
      if (minutes % 60 === 0) return COPY.shortHours(minutes / 60)
      return COPY.shortMinutes(minutes)
    }
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
  if (left < MINUTE) return COPY.resetSoon
  const days = Math.floor(left / DAY)
  const hours = Math.floor((left % DAY) / HOUR)
  const minutes = Math.floor((left % HOUR) / MINUTE)
  const span =
    days > 0
      ? [COPY.days(days), hours && !brief ? COPY.hours(hours) : ''].filter(Boolean).join(' ')
      : hours > 0
        ? [COPY.hours(hours), minutes && !brief ? COPY.minutes(minutes) : ''].filter(Boolean).join(' ')
        : COPY.minutes(minutes)
  return COPY.resetAfter(span)
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
const GROUPS: Record<QuotaGroup, string> = {
  get gemini() {
    return COPY.gemini
  },
  get 'claude-gpt'() {
    return COPY.claudeGpt
  },
}

function windowView(window: QuotaWindow, now: number): LimitView {
  const state = quotaWindowState(window)
  const reset = windowReset(window, now)
  return {
    key: `${window.group ?? ''}:${window.kind}:${window.windowMinutes ?? ''}`,
    ...(window.group ? { group: GROUPS[window.group] } : {}),
    name: windowName(window),
    short: windowShort(window),
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
  /** The window the composer stands for: the worst, then the fullest (`leadingQuotaWindow`). Absent: only a balance. */
  tightest?: LimitView
  /**
   * The windows the composer's mark names, shortest first: the shortest window of the tightest one's group and its
   * longer one (the weekly, or the tightest where that is longer), so the tightest is always among them. One where the
   * Harness reports one.
   */
  shown: LimitView[]
  /** The Harness said the account is at a limit that none of its windows shows. */
  account: boolean
  /** Plan, masked account and a prepaid balance above zero, each only when the Harness said it. */
  facts: string[]
  /** Of `facts`, the masked account: the one that gives way when the line is short. */
  who?: string
}

export function harnessLimits(quota: HarnessQuota | undefined, now: number): HarnessLimits | undefined {
  const held = quota && currentQuota(quota, now)
  const lead = held && leadingQuotaWindow(held.windows)
  if (!held || (!lead && held.balanceCents === undefined)) return undefined
  return {
    state: held.state,
    windows: held.windows.map(window => windowView(window, now)),
    ...(lead ? { tightest: windowView(lead, now) } : {}),
    shown: lead ? markWindows(held.windows, lead).map(window => windowView(window, now)) : [],
    account: held.state === 'limited' && (!lead || quotaWindowState(lead) !== 'limited'),
    ...(held.account ? { who: held.account } : {}),
    facts: [
      ...(held.plan ? [PLANS[held.plan]] : []),
      ...(held.account ? [held.account] : []),
      // A balance beside windows shows only with money in it; a balance reported alone always shows.
      ...(held.balanceCents !== undefined && (held.balanceCents > 0 || !lead)
        ? [
            COPY.balance(
              formatNumber(held.balanceCents / 100, {
                style: 'currency',
                currencyDisplay: currentLocale() === 'zh-CN' ? 'narrowSymbol' : 'symbol',
                currency: held.currency ?? 'USD',
              }),
            ),
          ]
        : []),
    ],
  }
}

/** 「已用 68%」, or the state's words for a limit without a figure. */
export function usedWords(view: Pick<LimitView, 'percent' | 'status'>): string {
  return view.percent !== undefined ? COPY.used(formatNumber(view.percent / 100, { style: 'percent' })) : (view.status ?? '')
}

/**
 * The windows of `lead`'s group the composer names: the shortest, then a longer one, the general weekly window unless
 * `lead` is the longer one. `lead` is always one of them: never two calm windows while a third is at its limit.
 */
function markWindows(windows: readonly QuotaWindow[], lead: QuotaWindow): QuotaWindow[] {
  const group = windows.filter(window => window.group === lead.group)
  const length = (window: QuotaWindow) => windowLength(window) ?? Number.POSITIVE_INFINITY
  const shortest = group.reduce((best, window) => (length(window) < length(best) ? window : best), lead)
  const longer = group.filter(window => length(window) > length(shortest))
  const long = longer.includes(lead)
    ? lead
    : (longer.find(window => window.kind === 'weekly')
      ?? longer.reduce<QuotaWindow | undefined>((best, window) => (best && length(best) >= length(window) ? best : window), undefined))
  return long ? [shortest, long] : [shortest]
}

/** One part of the composer's mark: a window's short name and its figure (「周 68%」), in its own state. */
export interface MarkPart {
  key: string
  text: string
  state: QuotaState
  reset?: string
}

/**
 * The composer's mark: each shown window as its short name and the share used (「5 小时 12%」「周 68%」), or, without a
 * figure, its state (「5 小时 将用尽」); an account at a limit no window shows reads 「额度已用尽」 alone.
 */
export function markParts(limits: Pick<HarnessLimits, 'shown' | 'account'>): MarkPart[] {
  if (limits.account || !limits.shown.length) return [{ key: 'account', text: COPY.limitReached, state: 'limited' }]
  return limits.shown.map(view => ({
    key: view.key,
    text: COPY.part(
      view.short ?? view.name,
      view.percent !== undefined ? formatNumber(view.percent / 100, { style: 'percent' }) : (view.status ?? COPY.quota),
    ),
    state: view.state,
    ...(view.reset ? { reset: view.reset } : {}),
  }))
}

/** The same words in one run (「5 小时 12% · 周 68%」), for reading out. */
export function chipWords(limits: Pick<HarnessLimits, 'shown' | 'account'>): string {
  return markParts(limits)
    .map(part => part.text)
    .join(' · ')
}

/** A part as a screen reader hears it, with when its window resets. */
export const partReads = (part: MarkPart): string => (part.reset ? COPY.reads(part.text, part.reset) : part.text)

/** A monthly budget's words on the mark, its name and 「已用 N%」 in one run (「本月预算已用 40%」). */
export const limitWords = (name: string, figure: string): string => COPY.chip(name, figure)

/** The first day of the month after `month` (`YYYY-MM`), as 「12 月 1 日重置」. */
function monthReset(month: string): string | undefined {
  const match = /^(\d{4})-(\d{2})$/u.exec(month)
  if (!match) return undefined
  const next = (Number(match[2]) % 12) + 1
  return COPY.monthlyReset(next)
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
