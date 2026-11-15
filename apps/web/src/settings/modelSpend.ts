// How prices, budgets and costs are written on screen, and how what a person types becomes one. No estimates here: an
// amount is shown only when the Host has it.
import {
  COST_SIGNS,
  MAX_COST_BUDGET,
  MAX_MODEL_PRICE,
  MAX_TOKEN_BUDGET,
  type BudgetProgress,
  type CostAmount,
  type CostCurrency,
  type ModelBudget,
  type ModelPrices,
  type ModelUsageRow,
  type TurnSpend,
} from '@latch/protocol'
import { formatTokens } from '../format.ts'

export const CURRENCY_NAMES: Readonly<Record<CostCurrency, string>> = { USD: '美元', CNY: '人民币' }
export const NOT_REPORTED = '未报告'

/** 「$0.0021」, 「¥12.50」: four places under a cent's hundred, two above, so a small request never reads as nothing. */
export function costText(amount: Pick<CostAmount, 'currency' | 'micros'>): string {
  const value = amount.micros / 1_000_000
  const digits = value !== 0 && value < 1 ? 4 : 2
  return `${COST_SIGNS[amount.currency]}${value.toFixed(digits)}`
}

/** Every currency's amount, joined; undefined when no cost is known. */
export function costsText(cost: readonly CostAmount[] | undefined): string | undefined {
  return cost?.length ? cost.map(costText).join(' + ') : undefined
}

/** What a cost was worked out from, when not all of it is the service's own word. */
export const pricedNote = (cost: readonly CostAmount[] | undefined): string | undefined =>
  cost?.some(item => item.priced) ? '按你填的单价' : undefined

/** A turn's cost for its footer: 「花费 $0.0021」, with 「按你填的单价」 when prices were used. */
export function turnCostWords(spend: TurnSpend | undefined): { text: string; note?: string } | undefined {
  const text = costsText(spend?.cost)
  if (!text) return undefined
  const note = pricedNote(spend?.cost)
  return { text: `花费 ${text}`, ...(note ? { note } : {}) }
}

/** What a budget's state reads as: amber at 80%, red when used up. */
export function budgetWords(state: BudgetProgress['state']): { tone: 'warn' | 'failed'; text: string } | undefined {
  return state === 'over'
    ? { tone: 'failed', text: '本月预算已用完' }
    : state === 'near'
      ? { tone: 'warn', text: '预算已用 80%' }
      : undefined
}

const amountOf = (budget: Pick<ModelBudget, 'unit' | 'currency'>, value: number): string =>
  budget.unit === 'tokens'
    ? `${formatTokens(Math.round(value))} tokens`
    : costText({ currency: budget.currency ?? 'USD', micros: Math.round(value * 1_000_000) })

/** 「12.4k / 100k tokens」 or 「$1.20 / $5.00」. */
export function budgetProgressText(budget: BudgetProgress): string {
  const used = amountOf(budget, budget.used)
  const limit = amountOf(budget, budget.limit)
  return budget.unit === 'tokens' ? `${used.replace(/ tokens$/u, '')} / ${limit}` : `${used} / ${limit}`
}

export const budgetPercent = (budget: BudgetProgress): number => Math.min(999, Math.floor((budget.used / budget.limit) * 100))

/** A number a person typed: digits with at most six decimals, nothing else. */
export function parseAmount(text: string, max: number): number | undefined {
  const trimmed = text.trim()
  if (!/^\d{1,13}(?:\.\d{1,6})?$/u.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) && value <= max ? value : undefined
}

export interface PriceFields {
  currency: CostCurrency
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
}

export const priceFields = (saved: ModelPrices | undefined): PriceFields => ({
  currency: saved?.currency ?? 'USD',
  input: saved ? String(saved.input) : '',
  output: saved ? String(saved.output) : '',
  cacheRead: saved?.cacheRead !== undefined ? String(saved.cacheRead) : '',
  cacheWrite: saved?.cacheWrite !== undefined ? String(saved.cacheWrite) : '',
})

/** The prices a filled form says, or the field that is wrong. Input and output are needed; the cache prices may stay empty. */
export function readPrices(fields: PriceFields): { prices: ModelPrices } | { invalid: keyof Omit<PriceFields, 'currency'> } {
  const input = parseAmount(fields.input, MAX_MODEL_PRICE)
  if (input === undefined) return { invalid: 'input' }
  const output = parseAmount(fields.output, MAX_MODEL_PRICE)
  if (output === undefined) return { invalid: 'output' }
  const prices: ModelPrices = { currency: fields.currency, input, output }
  for (const name of ['cacheRead', 'cacheWrite'] as const) {
    if (!fields[name].trim()) continue
    const value = parseAmount(fields[name], MAX_MODEL_PRICE)
    if (value === undefined) return { invalid: name }
    prices[name] = value
  }
  return { prices }
}

export interface BudgetFields {
  unit: ModelBudget['unit']
  currency: CostCurrency
  limit: string
}

export const budgetFields = (saved: ModelBudget | undefined): BudgetFields => ({
  unit: saved?.unit ?? 'tokens',
  currency: saved?.currency ?? 'USD',
  limit: saved ? String(saved.limit) : '',
})

/** The budget a filled form says: whole tokens, or an amount of the chosen currency; undefined while it is not one. */
export function readBudget(fields: BudgetFields): Omit<ModelBudget, 'scope' | 'id'> | undefined {
  const limit = parseAmount(fields.limit, fields.unit === 'tokens' ? MAX_TOKEN_BUDGET : MAX_COST_BUDGET)
  if (limit === undefined || limit <= 0) return undefined
  if (fields.unit === 'tokens') return Number.isInteger(limit) ? { unit: 'tokens', limit } : undefined
  return { unit: 'cost', currency: fields.currency, limit }
}

/** A row's tokens for a column; 未报告 when no reply of the row reported any. */
export function rowTokens(row: ModelUsageRow, part: 'inputTokens' | 'outputTokens'): string {
  return row.usage ? formatTokens(row.usage[part]) : NOT_REPORTED
}

/** A row's cost; 未报告 when none of its requests has one. */
export const rowCost = (row: ModelUsageRow): string => costsText(row.cost) ?? NOT_REPORTED
