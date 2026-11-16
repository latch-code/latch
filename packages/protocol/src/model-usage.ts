// What the Host keeps and shows of model requests it sent: counts, tokens the services reported, and what they cost when
// that is known. Never a request's or a reply's content.
import type { TokenUsage } from './sessions.ts'

/**
 * How one model request ended. `ok`: its reply ran to its end. The failure classes are the scheduler's
 * (`ModelFailureClass`). `busy`: it waited for a free place too long. `budget`: a monthly budget was used up, and nothing
 * was sent. `aborted`: the harness or the person gave up on it.
 */
export const USAGE_OUTCOMES = [
  'ok',
  'request',
  'auth',
  'forbidden',
  'quota',
  'rate',
  'server',
  'network',
  'timeout',
  'stream',
  'unavailable',
  'circuit-open',
  'busy',
  'budget',
  'aborted',
] as const
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number]

export const COST_CURRENCIES = ['USD', 'CNY'] as const
export type CostCurrency = (typeof COST_CURRENCIES)[number]
export const COST_SIGNS: Readonly<Record<CostCurrency, string>> = { USD: '$', CNY: '¥' }

/** The most a price per million tokens may be. */
export const MAX_MODEL_PRICE = 100_000
export const MAX_MODEL_PRICES = 2000
export const MAX_MODEL_BUDGETS = 200
export const MAX_TOKEN_BUDGET = 1_000_000_000_000
export const MAX_COST_BUDGET = 1_000_000

/**
 * What the person entered for one model, per million tokens. `cacheRead` and `cacheWrite` absent: those tokens count at
 * `input`.
 */
export interface ModelPrices {
  currency: CostCurrency
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export interface ModelPrice extends ModelPrices {
  providerId: string
  model: string
}

/**
 * A monthly limit of one service or one Agent: tokens (input and output together), or cost in one currency, which
 * counts only requests whose cost is known in it. `limit` is tokens, or an amount of `currency`.
 */
export interface ModelBudget {
  scope: 'service' | 'agent'
  id: string
  unit: 'tokens' | 'cost'
  /** With `cost`. */
  currency?: CostCurrency
  limit: number
}

/** A budget with what this month used of it, in the budget's own unit. */
export interface BudgetProgress extends ModelBudget {
  used: number
  state?: BudgetState
  /** A cost budget only: this month's requests that reached a service and have no cost in its currency, so are not in `used`. */
  uncounted?: number
}

/** `near`: 80% or more is used. `over`: all of it; new requests are refused until next month. */
export type BudgetState = 'near' | 'over'
const BUDGET_NEAR = 0.8

export function budgetState(used: number, limit: number): BudgetState | undefined {
  if (!(limit > 0)) return undefined
  return used >= limit ? 'over' : used >= limit * BUDGET_NEAR ? 'near' : undefined
}

/**
 * An amount in millionths of `currency`. `priced`: some of it was worked out from prices the person entered.
 * `estimated`: some of it is what a Harness said its own login cost, at list prices of its own.
 */
export interface CostAmount {
  currency: CostCurrency
  micros: number
  priced?: true
  estimated?: true
}

/** What a turn's model requests cost, when known, and where a budget that covers them stood when the turn ended. */
export interface TurnSpend {
  cost?: CostAmount[]
  budget?: BudgetState
}

/** `GET /link/api/model-spend`: prices and budgets as saved, with this month's use. */
export interface ModelSpend {
  revision: number
  prices: ModelPrice[]
  budgets: BudgetProgress[]
  /** The month budgets count, `YYYY-MM` in the Host computer's own time. */
  month: string
  /** The Host computer's time zone, as it names it. */
  timeZone: string
}

export interface ModelSpendWrite {
  requestId: string
  baseRevision: number
}

export interface ModelSpendReceipt {
  ok: true
  revision: number
  replayed?: true
}

/** The last 24 hours (by the hour), or the last 7, 30 or 90 days (by the day, in the Host computer's own time). */
export const USAGE_PERIODS = ['1', '7', '30', '90'] as const
export type UsagePeriod = (typeof USAGE_PERIODS)[number]
export const USAGE_GROUPS = ['harness', 'service', 'model', 'project', 'agent', 'session'] as const
export type UsageGroup = (typeof USAGE_GROUPS)[number]
/**
 * Where a use was counted: a model service's request through Latch (`gateway`), a turn on a Harness's own login
 * (`own`), or a built-in turn on a plugin's own provider (`plugin`), which the gateway does not meter.
 */
export const USAGE_SOURCES = ['gateway', 'own', 'plugin'] as const
export type UsageSource = (typeof USAGE_SOURCES)[number]

export interface ModelUsageRow {
  /** What the row is of, by the grouping: a Harness, a service, a service's model, a project, an Agent or a session. */
  harness?: string
  sessionId?: string
  agentId?: string
  providerId?: string
  model?: string
  projectId?: string
  requests: number
  /** Of `requests`, those that did not get a whole reply, the ones somebody gave up on aside. */
  failed: number
  /** Of `requests`, those a 「出错时改用」 service answered. */
  fallbacks: number
  /** Of `requests` (and of `turns`), those that reported tokens; `usage` sums those. Absent `usage`: none did. */
  measured: number
  usage?: TokenUsage
  /** A part some measured reply did not report: left out of `usage` rather than shown as a partial sum. */
  partial: Record<'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens', boolean>
  /** By currency; empty when no request's cost is known. */
  cost: CostAmount[]
  /** Of the measured requests, those whose cost is not known. */
  uncosted: number
}

/**
 * One bucket's use by one Harness from one source (and, through the gateway, one service). Sessions are never named
 * here. `cacheBase` is the input of the measured uses that reported cache reads: the cache-hit share is
 * `cacheReadTokens / cacheBase`, never a guess over uses that did not say.
 */
export interface UsagePoint {
  /** Index into `buckets`. */
  bucket: number
  by: UsageSource
  harness: string
  providerId?: string
  requests: number
  turns: number
  measured: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheBase: number
}

/** Days (or, for `1`, hours) of a period with their uses, and the uses by hour of the week, all in the Host's time. */
export interface UsageSeries {
  /** Each bucket's first instant, oldest first, every bucket of the period present. */
  buckets: string[]
  series: UsagePoint[]
  /** 168 counts, Monday 00:00 first: requests that arrived and turns that ended in each hour of the week. */
  hours: number[]
}

/** `POST /link/api/model-usage`: the ledger's requests of a period (or of one of its buckets, `day`), grouped. */
export interface ModelUsageSummary extends UsageSeries {
  period: UsagePeriod
  group: UsageGroup
  /** The bucket the answer is narrowed to, when one was asked for. */
  day?: string
  from: string
  to: string
  timeZone: string
  rows: ModelUsageRow[]
  /** Ledger lines that could not be read and were left out. */
  skipped: number
  /** The period held more lines than are read at once. */
  truncated: boolean
}

/** A row of `POST /link/api/usage`: one group's use from one source. */
export interface UsageRow extends ModelUsageRow {
  by: UsageSource
  /** Turns of the own-login and plugin records; gateway requests are counted in `requests`. */
  turns: number
}

/** Tokens a turn took on a Harness's own login, by model and Harness: what the same model costs in tokens on each. */
export interface UsageCompare {
  model: string
  harness: string
  turns: number
  /** Of `turns`, those that reported tokens; the sums below are of those. */
  measured: number
  inputTokens: number
  outputTokens: number
}

/**
 * `POST /link/api/usage`: every use Latch ran over a period, from the gateway's ledger and the record of own-login turns
 * (`by` says which; `all` both), grouped, with the series the charts draw, the share by project and the per-turn
 * comparison of models across Harnesses.
 */
export interface UsageSummary extends UsageSeries {
  period: UsagePeriod
  group: UsageGroup
  by: UsageSource | 'all'
  day?: string
  from: string
  to: string
  timeZone: string
  rows: UsageRow[]
  /** Tokens by project, largest first; a use of no project this device sees has no `projectId`. */
  projects: Array<{ projectId?: string; turns: number; requests: number; tokens: number }>
  compare: UsageCompare[]
  skipped: number
  truncated: boolean
}
