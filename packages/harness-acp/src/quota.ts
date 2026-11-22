/**
 * What a harness's own program says about the limits of the subscription it is logged in to. Latch listens to the
 * program it already runs; the one exception, a vendor balance the Host reads with a preset CLI's own key, is the Host's
 * (`apps/host/src/cli-quota.ts`) and arrives here as an ordinary report. Everything kept is a number or a value of the
 * protocol's fixed sets; an account's address is masked the moment it is read.
 */
import { z } from 'zod'
import {
  QUOTA_CURRENCIES,
  QUOTA_GROUPS,
  QUOTA_PLANS,
  QUOTA_WINDOW_KINDS,
  quotaWindowState,
  type HarnessQuota,
  type QuotaCurrency,
  type QuotaPlan,
  type QuotaState,
  type QuotaWindow,
  type QuotaWindowKind,
} from '@latch/protocol'
import { isoTime } from '@latch/core/node-kit'

/** The session update a wire that reads limits itself (Codex's app-server) sends: a `QuotaReport` beside `sessionUpdate`. */
export const QUOTA_UPDATE = '_latch_quota'

/** One thing a program said. Windows it names replace the ones known; `whole` says the rest are gone. */
export interface QuotaReport {
  windows: QuotaWindow[]
  /** A full reading rather than a rolling update. */
  whole?: true
  plan?: QuotaPlan
  /** Already masked. */
  account?: string
  balanceCents?: number
  /** Of `balanceCents`; absent: US dollars. */
  currency?: QuotaCurrency
  /** The program said the account is, or is not, at a limit. Absent: it said neither. */
  limited?: boolean
}

const first = (text: string) => [...text][0] ?? ''
const MASKED_ACCOUNT = /^[\p{L}\p{N}]•••@[\p{L}\p{N}]•••(?:\.[a-z]{2,10})?$/u
const MAX_WINDOWS = 8
const DAY_MS = 86_400_000

const instant = z
  .string()
  .max(32)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u)
  .refine(value => Number.isFinite(Date.parse(value)))

const quotaWindow = z.object({
  kind: z.enum(QUOTA_WINDOW_KINDS),
  group: z.enum(QUOTA_GROUPS).optional(),
  usedPercent: z.number().min(0).max(100).optional().catch(undefined),
  resetsAt: instant.optional().catch(undefined),
  windowMinutes: z
    .number()
    .int()
    .positive()
    .max(366 * 24 * 60)
    .optional()
    .catch(undefined),
  state: z.enum(['near', 'limited']).optional().catch(undefined),
})

/** A window of a kind Latch does not know is left out, never passed through; so is one that is malformed. */
const windowList = z
  .array(z.unknown())
  .max(64)
  .transform(items =>
    items
      .flatMap(item => {
        const parsed = quotaWindow.safeParse(item)
        return parsed.success ? [parsed.data as QuotaWindow] : []
      })
      .slice(0, MAX_WINDOWS),
  )

const facts = {
  plan: z.enum(QUOTA_PLANS).optional().catch(undefined),
  account: z.string().max(64).regex(MASKED_ACCOUNT).optional().catch(undefined),
  balanceCents: z.number().int().min(0).max(1_000_000_000).optional().catch(undefined),
  currency: z.enum(QUOTA_CURRENCIES).optional().catch(undefined),
}

/** What a client may be sent. Anything else a driver put beside these fields is dropped. */
export const harnessQuota = z
  .object({
    windows: windowList,
    ...facts,
    state: z.enum(['ok', 'near', 'limited']),
    observedAt: instant,
  })
  .refine(quota => quota.windows.length > 0 || quota.balanceCents !== undefined)

/** A wire's report as the runtime takes it. */
export const quotaReport = z.object({
  windows: windowList,
  whole: z.literal(true).optional().catch(undefined),
  ...facts,
  limited: z.boolean().optional().catch(undefined),
})

/**
 * `name@example.com` as `n•••@e•••.com`: the first character of each side and the last label. Undefined for anything
 * that is not plainly one address, so that nothing else is ever shown in its place.
 */
export function maskAccount(address: unknown): string | undefined {
  if (typeof address !== 'string' || address.length > 320) return undefined
  const match = /^([^\s@\p{C}]+)@([^\s@\p{C}]+)$/u.exec(address.trim())
  if (!match) return undefined
  const local = first(match[1]!)
  const labels = match[2]!.toLowerCase().split('.')
  const domain = first(labels[0]!)
  const last = labels.length > 1 ? labels.at(-1)! : ''
  const masked = `${local}•••@${domain}•••${/^[a-z]{2,10}$/u.test(last) ? `.${last}` : ''}`
  return MASKED_ACCOUNT.test(masked) ? masked : undefined
}

function planOf(text: unknown): QuotaPlan | undefined {
  if (typeof text !== 'string' || text.length > 64) return undefined
  const name = text
    .trim()
    .toLowerCase()
    .replaceAll(/[_\s]+/gu, '-')
  return (QUOTA_PLANS as readonly string[]).includes(name) ? (name as QuotaPlan) : undefined
}

const percent = (value: number) => Math.round(Math.min(Math.max(value, 0), 100) * 10) / 10

/**
 * A reset time as a program gives it: an ISO string, or a number of seconds or milliseconds told apart by size. Only a
 * time from a day ago up to `aheadDays` from now is one; anything else is left out rather than shown wrong.
 */
function resetTime(value: unknown, now: number, aheadDays: number): string | undefined {
  const ms =
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value < 100_000_000_000
        ? value * 1000
        : value
      : typeof value === 'string' && value.length <= 64
        ? Date.parse(value)
        : Number.NaN
  return Number.isFinite(ms) && ms > now - DAY_MS && ms < now + aheadDays * DAY_MS ? isoTime(ms) : undefined
}

// ---- Codex (app-server `account/rateLimits/read` and `account/rateLimits/updated`) -------------------------------

const finite = z.number().finite()
const codexWindow = z.object({
  usedPercent: finite,
  windowDurationMins: finite.nullish().catch(undefined),
  resetsAt: finite.nullish().catch(undefined),
})
const codexLimits = z.object({
  limitId: z.string().max(256).nullish().catch(undefined),
  primary: codexWindow.nullish().catch(undefined),
  secondary: codexWindow.nullish().catch(undefined),
  planType: z.string().max(64).nullish().catch(undefined),
  rateLimitReachedType: z.string().max(128).nullish().catch(undefined),
})
const codexAnswer = z.object({
  rateLimits: z.unknown(),
  rateLimitsByLimitId: z.record(z.string(), z.unknown()).nullish().catch(undefined),
})
const codexAccount = z.object({
  account: z
    .object({
      type: z.string().max(64),
      email: z.string().max(320).nullish().catch(undefined),
      planType: z.string().max(64).nullish().catch(undefined),
    })
    .nullish()
    .catch(undefined),
})
/** The bucket a plan's own usage is metered in; the other buckets are per-model aliases with names of Codex's choosing. */
const CODEX_BUCKET = 'codex'
const FIVE_HOURS = 300
const WEEK = 7 * 24 * 60

function codexWindowOf(window: z.infer<typeof codexWindow> | null | undefined, now: number): QuotaWindow | undefined {
  const minutes = window?.windowDurationMins
  // Codex names no window: its length is what tells them apart, and one without a length cannot be labelled.
  if (!window || typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes <= 0 || minutes > 366 * 24 * 60) return undefined
  const kind: QuotaWindowKind = minutes === FIVE_HOURS ? 'five-hour' : minutes === WEEK ? 'weekly' : 'rolling'
  const resetsAt = resetTime(window.resetsAt, now, 400)
  return {
    kind,
    usedPercent: percent(window.usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
    ...(kind === 'rolling' ? { windowMinutes: minutes } : {}),
  }
}

/** One `RateLimitSnapshot`. `whole`: from a read, so what it leaves out is gone; a rolling update only adds. */
function codexLimitsReport(limits: unknown, whole: boolean, now: number): QuotaReport | undefined {
  const parsed = codexLimits.safeParse(limits)
  if (!parsed.success) return undefined
  if (parsed.data.limitId != null && parsed.data.limitId !== CODEX_BUCKET) return undefined
  const windows = [codexWindowOf(parsed.data.primary, now), codexWindowOf(parsed.data.secondary, now)].filter(
    (window): window is QuotaWindow => window !== undefined,
  )
  const plan = planOf(parsed.data.planType)
  const reached = typeof parsed.data.rateLimitReachedType === 'string'
  if (!whole && !windows.length && !plan && !reached) return undefined
  return {
    windows,
    ...(whole ? { whole: true as const } : {}),
    ...(plan ? { plan } : {}),
    // A rolling update that names no limit says nothing about one reached before.
    ...(reached ? { limited: true } : whole ? { limited: false } : {}),
  }
}

/** The answer to `account/rateLimits/read`, with the answer to `account/read` for the plan and the masked address. */
export function codexQuota(answer: unknown, account: unknown, now: number): QuotaReport | undefined {
  const read = codexAnswer.safeParse(answer)
  if (!read.success) return undefined
  const report = codexLimitsReport(read.data.rateLimitsByLimitId?.[CODEX_BUCKET] ?? read.data.rateLimits, true, now)
  if (!report) return undefined
  const who = codexAccount.safeParse(account)
  const signedIn = who.success && who.data.account?.type === 'chatgpt' ? who.data.account : undefined
  const masked = maskAccount(signedIn?.email)
  const plan = report.plan ?? planOf(signedIn?.planType)
  return { ...report, ...(plan ? { plan } : {}), ...(masked ? { account: masked } : {}) }
}

/** The params of `account/rateLimits/updated`: a sparse update of the plan's own bucket. */
export function codexQuotaUpdate(params: unknown, now: number): QuotaReport | undefined {
  const parsed = z.object({ rateLimits: z.unknown() }).safeParse(params)
  return parsed.success ? codexLimitsReport(parsed.data.rateLimits, false, now) : undefined
}

// ---- Claude Agent (`usage_update._meta["_claude/rateLimit"]`, and the copy on a turn refused for the limit) ------

const CLAUDE_META = '_claude/rateLimit'
const CLAUDE_KINDS: Readonly<Record<string, QuotaWindowKind>> = {
  five_hour: 'five-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly-opus',
  seven_day_sonnet: 'weekly-sonnet',
}
const claudeStatus = z.enum(['allowed', 'allowed_warning', 'rejected'])
const claudeWindow = z.object({
  status: claudeStatus.optional().catch(undefined),
  utilization: finite.min(0).max(1).optional().catch(undefined),
  resetsAt: finite.optional().catch(undefined),
})
const claudeInfo = z.object({
  status: claudeStatus,
  rateLimitType: z.string().max(64).optional().catch(undefined),
  resetsAt: finite.optional().catch(undefined),
  unifiedWindows: z.record(z.string().max(64), z.unknown()).optional().catch(undefined),
})

const claudeState = (status: z.infer<typeof claudeStatus> | undefined) =>
  status === 'rejected' ? ('limited' as const) : status === 'allowed_warning' ? ('near' as const) : undefined

/**
 * One `SDKRateLimitInfo`. Its `unifiedWindows` give each window's share used as a fraction (`utilization`, 0 to 1:
 * claude-agent-acp 0.x, checked 2026-11-16 against Claude Code's own `/usage` for the same account) and its reset;
 * without them, only the named window's status. `allowed` with no figure clears what was said of that window before.
 */
export function claudeRateLimit(info: unknown, now: number): QuotaReport | undefined {
  const parsed = claudeInfo.safeParse(info)
  if (!parsed.success) return undefined
  const windows: QuotaWindow[] = []
  for (const [name, value] of Object.entries(parsed.data.unifiedWindows ?? {})) {
    const kind = Object.hasOwn(CLAUDE_KINDS, name) ? CLAUDE_KINDS[name] : undefined
    const window = claudeWindow.safeParse(value)
    if (!kind || !window.success) continue
    const resetsAt = resetTime(window.data.resetsAt, now, 62)
    const state = claudeState(window.data.status)
    windows.push({
      kind,
      ...(window.data.utilization !== undefined ? { usedPercent: percent(window.data.utilization * 100) } : {}),
      ...(resetsAt ? { resetsAt } : {}),
      ...(state ? { state } : {}),
    })
  }
  if (windows.length) return { windows: windows.slice(0, MAX_WINDOWS) }
  const kind = Object.hasOwn(CLAUDE_KINDS, parsed.data.rateLimitType ?? '') ? CLAUDE_KINDS[parsed.data.rateLimitType!] : undefined
  if (!kind) return undefined
  const resetsAt = resetTime(parsed.data.resetsAt, now, 62)
  const state = claudeState(parsed.data.status)
  return { windows: [{ kind, ...(state && resetsAt ? { resetsAt } : {}), ...(state ? { state } : {}) }] }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** A `usage_update` as the adapter sent it. */
export function claudeUsageQuota(update: Record<string, unknown>, now: number): QuotaReport | undefined {
  const meta = record(update._meta)
  return meta && Object.hasOwn(meta, CLAUDE_META) ? claudeRateLimit(meta[CLAUDE_META], now) : undefined
}

const claudeUsageWindow = z
  .object({ utilization: finite.min(0).max(100).nullish().catch(undefined), resets_at: z.string().max(64).nullish().catch(undefined) })
  .nullish()
  .catch(undefined)
const claudeUsage = z.object({
  subscription_type: z.string().max(64).nullish().catch(undefined),
  rate_limits_available: z.boolean(),
  rate_limits: z.record(z.string().max(64), claudeUsageWindow).nullish().catch(undefined),
})

/**
 * Claude Code's answer to its experimental `get_usage` control request (SDK 0.3.322, `SDKControlGetUsageResponse`):
 * each plan window's share used, 0 to 100, and its reset. `null` when Claude says plan limits do not apply (an API key,
 * Bedrock, Vertex) or names no window Latch knows: there is nothing to show outside a turn. Only the shape it knows:
 * anything else says nothing, so what was shown stays.
 */
export function claudeUsageRead(result: unknown, now: number): QuotaReport | null | undefined {
  const parsed = claudeUsage.safeParse(result)
  if (!parsed.success) return undefined
  if (!parsed.data.rate_limits_available || !parsed.data.rate_limits) return null
  const windows: QuotaWindow[] = []
  for (const [name, value] of Object.entries(parsed.data.rate_limits)) {
    const kind = Object.hasOwn(CLAUDE_KINDS, name) ? CLAUDE_KINDS[name] : undefined
    if (!kind || !value || typeof value.utilization !== 'number') continue
    const resetsAt = resetTime(value.resets_at, now, 62)
    windows.push({ kind, usedPercent: percent(value.utilization), ...(resetsAt ? { resetsAt } : {}) })
  }
  if (!windows.length) return null
  const plan = planOf(parsed.data.subscription_type)
  return { windows: windows.slice(0, MAX_WINDOWS), ...(plan ? { plan } : {}) }
}

/** The `data` of the error a turn refused for the limit ends with. */
export function claudeErrorQuota(data: unknown, now: number): QuotaReport | undefined {
  const fields = record(data)
  return fields?.errorKind === 'rate_limit' ? claudeRateLimit(fields.rateLimit, now) : undefined
}

// ---- Grok Build (ACP extension request `_x.ai/billing`) ----------------------------------------------------------

export const GROK_BILLING_METHOD = '_x.ai/billing'
const moment = z
  .union([z.string().max(64), finite])
  .nullish()
  .catch(undefined)
const grokBilling = z.object({
  config: z.object({
    creditUsagePercent: finite.nullish().catch(undefined),
    currentPeriod: z.object({ end: moment }).nullish().catch(undefined),
    billingPeriodEnd: moment,
    prepaidBalance: z.object({ val: finite }).nullish().catch(undefined),
  }),
  subscriptionTier: z.string().max(64).nullish().catch(undefined),
  subscription_tier: z.string().max(64).nullish().catch(undefined),
})

/** The plan's billing period: one figure for the period, not a five-hour or weekly window. */
export function grokQuota(result: unknown, now: number): QuotaReport | undefined {
  const parsed = grokBilling.safeParse(result)
  if (!parsed.success || typeof parsed.data.config.creditUsagePercent !== 'number') return undefined
  const { config } = parsed.data
  const resetsAt = resetTime(config.currentPeriod?.end ?? config.billingPeriodEnd, now, 400)
  const plan = planOf(parsed.data.subscriptionTier ?? parsed.data.subscription_tier)
  const balance = config.prepaidBalance?.val
  return {
    windows: [{ kind: 'billing-period', usedPercent: percent(config.creditUsagePercent!), ...(resetsAt ? { resetsAt } : {}) }],
    whole: true,
    ...(plan ? { plan } : {}),
    ...(typeof balance === 'number' && balance >= 0 && balance <= 1_000_000_000 ? { balanceCents: Math.round(balance) } : {}),
  }
}

// ---- What is known -------------------------------------------------------------------------------------------------

interface Said {
  windows: Map<string, { window: QuotaWindow; at: number }>
  plan?: QuotaPlan
  account?: string
  balanceCents?: number
  currency?: QuotaCurrency
  limited?: boolean
  /** A whole report of a balance and no windows (the Host's own read): kept after it is gone, having no reset. */
  balanceOnly?: true
  at: number
  gone?: true
}

const MAX_SOURCES = 32
const RANK: Record<QuotaState, number> = { ok: 0, near: 1, limited: 2 }
const keyOf = (window: QuotaWindow) => `${window.group ?? ''}:${window.kind}:${window.windowMinutes ?? ''}`
const groupOrder = (window: QuotaWindow) => (window.group ? QUOTA_GROUPS.indexOf(window.group) : -1)

/**
 * One definition's limits as its processes said them, in memory only. A window holds until it resets, even after the
 * process that reported it is gone, since it is the account's and not the process's; one without a reset time holds
 * only while that process runs. For each window the newest word counts, whichever process said it.
 */
export class QuotaFacts {
  private readonly said = new Map<object, Said>()

  /** `source`: the process that said it. */
  note(source: object, report: QuotaReport, now: number): void {
    const entry: Said = this.said.get(source) ?? { windows: new Map(), at: now }
    if (report.whole) entry.windows.clear()
    if (report.whole && !report.windows.length && report.balanceCents !== undefined) entry.balanceOnly = true
    else delete entry.balanceOnly
    for (const window of report.windows.slice(0, MAX_WINDOWS)) {
      const key = keyOf(window)
      // A word on a window without a figure (Claude's status-only `allowed`) says nothing of how much is used: the
      // figure last said for it stays, with the time it was said, and takes the new status.
      const figure = !report.whole && window.usedPercent === undefined ? this.lastFigure(key, now) : undefined
      entry.windows.set(
        key,
        figure ? { window: { ...figure.window, ...window, usedPercent: figure.window.usedPercent! }, at: figure.at } : { window, at: now },
      )
    }
    if (report.plan) entry.plan = report.plan
    if (report.account) entry.account = report.account
    if (report.balanceCents !== undefined) {
      entry.balanceCents = report.balanceCents
      if (report.currency) entry.currency = report.currency
      else delete entry.currency
    }
    if (report.limited !== undefined) entry.limited = report.limited
    entry.at = now
    delete entry.gone
    this.said.delete(source)
    this.said.set(source, entry)
    if (this.said.size > MAX_SOURCES) this.said.delete(this.said.keys().next().value!)
  }

  /** The newest figure any source said for a window that has not reset yet. */
  private lastFigure(key: string, now: number): { window: QuotaWindow; at: number } | undefined {
    let found: { window: QuotaWindow; at: number } | undefined
    for (const entry of this.said.values()) {
      const item = entry.windows.get(key)
      if (item?.window.usedPercent === undefined) continue
      const resets = item.window.resetsAt === undefined ? undefined : Date.parse(item.window.resetsAt)
      if (resets !== undefined && resets <= now) continue
      if (!found || item.at >= found.at) found = item
    }
    if (!found) return undefined
    // Its own reset time stays when the new word gives none; its status is the new word's.
    const { state: _state, ...window } = found.window
    return { window, at: found.at }
  }

  /**
   * What was known before a restart, as a process that has gone away: each window holds until it resets, with the time
   * it was said.
   */
  restore(quota: HarnessQuota): void {
    const source = {}
    const { windows, plan, account, balanceCents, currency, state } = quota
    this.note(
      source,
      {
        windows,
        ...(plan ? { plan } : {}),
        ...(account ? { account } : {}),
        ...(balanceCents !== undefined ? { balanceCents, ...(currency ? { currency } : {}) } : {}),
        ...(!windows.length && balanceCents !== undefined ? { whole: true as const } : {}),
        // Only the account's own word stays: a window at its limit says so itself, and stops once it resets.
        limited: state === 'limited' && !windows.some(window => quotaWindowState(window) === 'limited'),
      },
      Date.parse(quota.observedAt),
    )
    this.gone(source)
  }

  /** The process went away: what it said of a window holds until that window resets. */
  gone(source: object): void {
    const entry = this.said.get(source)
    if (entry) entry.gone = true
  }

  /** Another account may be signed in from here on. */
  clear(): void {
    this.said.clear()
  }

  /** What still holds at `now`, as a client is sent it; undefined when nothing does. */
  snapshot(now: number): HarnessQuota | undefined {
    const newest = new Map<string, { window: QuotaWindow; at: number }>()
    let latest: Said | undefined
    for (const [source, entry] of this.said) {
      let held = 0
      for (const [key, item] of entry.windows) {
        const resets = item.window.resetsAt === undefined ? undefined : Date.parse(item.window.resetsAt)
        if (resets === undefined ? entry.gone : resets <= now) {
          entry.windows.delete(key)
          continue
        }
        held++
        const known = newest.get(key)
        if (!known || item.at >= known.at) newest.set(key, item)
      }
      // A balance reported alone belongs to the account and has no reset: it stays with its time until a newer word.
      if (!held && entry.gone && !entry.balanceOnly) this.said.delete(source)
      else if (!latest || entry.at >= latest.at) latest = entry
    }
    // A window with neither a figure nor a status only records that the program said it is fine.
    const windows = [...newest.values()]
      .map(item => item.window)
      .filter(window => window.usedPercent !== undefined || window.state !== undefined)
      .sort(
        (a, b) =>
          groupOrder(a) - groupOrder(b)
          || QUOTA_WINDOW_KINDS.indexOf(a.kind) - QUOTA_WINDOW_KINDS.indexOf(b.kind)
          || (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0),
      )
    if (!latest || (!windows.length && latest.balanceCents === undefined)) return undefined
    const worst = windows.reduce<QuotaState>((state, window) => {
      const own = quotaWindowState(window)
      return RANK[own] > RANK[state] ? own : state
    }, 'ok')
    const parsed = harnessQuota.safeParse({
      windows,
      plan: latest.plan,
      account: latest.account,
      balanceCents: latest.balanceCents,
      currency: latest.currency,
      state: latest.limited ? 'limited' : worst,
      observedAt: isoTime(Math.max(latest.at, ...[...newest.values()].map(item => item.at))),
    })
    if (!parsed.success) return undefined
    const { plan, account, balanceCents, currency, ...rest } = parsed.data
    return {
      ...rest,
      ...(plan ? { plan } : {}),
      ...(account ? { account } : {}),
      ...(balanceCents !== undefined ? { balanceCents, ...(currency ? { currency } : {}) } : {}),
    }
  }
}
