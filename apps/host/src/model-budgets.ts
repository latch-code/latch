// Prices the person entered for models and the monthly budgets of services and Agents, with the meter both the gateway
// and the built-in harness go through: it says whether a budget still has room before a request is sent, and writes the
// request's line into the usage ledger when it is over. A budget is the person's own money, not a security boundary:
// changing one needs `admin` and no local confirmation.
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  COST_CURRENCIES,
  MAX_COST_BUDGET,
  MAX_MODEL_BUDGETS,
  MAX_MODEL_PRICE,
  MAX_MODEL_PRICES,
  MAX_TOKEN_BUDGET,
  budgetState,
  type BudgetProgress,
  type BudgetState,
  type CostAmount,
  type ModelBudget,
  type ModelPrice,
  type ModelPrices,
  type ModelSpendReceipt,
  type TokenUsage,
  type TurnSpend,
  type UsageOutcome,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { writeFileAtomic } from '@latch/core/node-kit'
import { agentKey, costOf, ledgerName, reportedTokens, serviceKey, type UsageLedger, type UsageLine } from './model-usage.ts'

const price = z.number().min(0).max(MAX_MODEL_PRICE)
const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/u)
const model = z
  .string()
  .min(1)
  .max(200)
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value))
export const pricesSchema = z.strictObject({
  currency: z.enum(COST_CURRENCIES),
  input: price,
  output: price,
  cacheRead: price.optional(),
  cacheWrite: price.optional(),
})
const priceSchema = pricesSchema.extend({ providerId: opaque, model })
export const budgetSchema = z
  .strictObject({
    scope: z.enum(['service', 'agent']),
    id: opaque,
    unit: z.enum(['tokens', 'cost']),
    currency: z.enum(COST_CURRENCIES).optional(),
    limit: z.number().positive(),
  })
  .superRefine((value, context) => {
    if (value.unit === 'cost' ? value.currency === undefined : value.currency !== undefined)
      context.addIssue({ code: 'custom', path: ['currency'], message: '只有按花费的预算带币种' })
    if (value.unit === 'tokens' ? !Number.isSafeInteger(value.limit) || value.limit > MAX_TOKEN_BUDGET : value.limit > MAX_COST_BUDGET)
      context.addIssue({ code: 'custom', path: ['limit'], message: '预算上限无效' })
  })
export const MAX_MODEL_SPEND_RECEIPTS = 256
const revision = z.number().int().nonnegative()
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const receiptSchema = z.strictObject({ key: hash, hash, revision, auditFailed: z.literal(true).optional() })
/** Strict, with defaults for files saved before the receipts existed. */
const fileSchema = z.strictObject({
  version: z.literal(1),
  revision: revision.default(0),
  prices: z.array(priceSchema).max(MAX_MODEL_PRICES),
  budgets: z.array(budgetSchema).max(MAX_MODEL_BUDGETS),
  receipts: z.array(receiptSchema).max(MAX_MODEL_SPEND_RECEIPTS).default([]),
})
type SpendFile = z.infer<typeof fileSchema>
type SavedReceipt = z.infer<typeof receiptSchema>
interface SpendPreparation {
  changed: boolean
  auditFailed?: true
}
interface SpendRequest {
  key: string
  hash: string
  baseRevision: number
  authorize: () => void
}
export interface SpendMutation<Before> extends SpendRequest {
  prepare(before: Before): Promise<SpendPreparation>
}
interface SpendResult extends ModelSpendReceipt {
  auditFailed?: true
}

/**
 * `gateway/budgets.json` in the data directory, 0600, replaced whole. A stable key and a full value on every write make
 * the accepted value and its receipt one durable write. Memory changes only after the file is in place.
 */
export class ModelSpendStore {
  private tail: Promise<unknown> = Promise.resolve()
  private pending?: { receipt: SavedReceipt; state: SpendFile }

  private constructor(
    private readonly path: string,
    private data: SpendFile,
  ) {}

  static async open(dataDir: string): Promise<ModelSpendStore> {
    const directory = join(dataDir, 'gateway')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'budgets.json')
    try {
      return new ModelSpendStore(path, fileSchema.parse(JSON.parse(await readFile(path, 'utf8'))))
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return new ModelSpendStore(path, { version: 1, revision: 0, prices: [], budgets: [], receipts: [] })
      throw new AppError(500, 'model-budgets-invalid', '单价与预算文件无法读取，请在运行 Latch 的电脑上检查。')
    }
  }

  revision(): number {
    return this.data.revision
  }

  prices(): ModelPrice[] {
    return structuredClone(this.data.prices)
  }

  priceOf(providerId: string, name: string): ModelPrices | undefined {
    const found = this.data.prices.find(item => item.providerId === providerId && item.model === name)
    if (!found) return undefined
    const { providerId: _providerId, model: _model, ...prices } = found
    return prices
  }

  budgets(): ModelBudget[] {
    return structuredClone(this.data.budgets) as ModelBudget[]
  }

  budgetOf(scope: ModelBudget['scope'], id: string): ModelBudget | undefined {
    return this.data.budgets.find(item => item.scope === scope && item.id === id) as ModelBudget | undefined
  }

  /** Saves the prices of one model, or with `null` forgets them. */
  setPrice(
    providerId: string,
    name: string,
    prices: ModelPrices | null,
    request?: SpendMutation<ModelPrices | undefined>,
  ): Promise<SpendResult> {
    return this.change(
      data => {
        const rest = data.prices.filter(item => !(item.providerId === providerId && item.model === name))
        if (prices) {
          if (rest.length >= MAX_MODEL_PRICES) throw new AppError(409, 'model-price-limit', '保存的单价太多了。')
          rest.push(priceSchema.parse({ ...prices, providerId, model: name }))
        }
        data.prices = rest
      },
      request && { ...request, prepare: () => request.prepare(this.priceOf(providerId, name)) },
    )
  }

  /** Saves or removes a budget. `prepare` sees its current value in the write queue and may skip the write. */
  setBudget(
    scope: ModelBudget['scope'],
    id: string,
    budget: Omit<ModelBudget, 'scope' | 'id'> | null,
    request?: SpendMutation<ModelBudget | undefined>,
  ): Promise<SpendResult> {
    return this.change(
      data => {
        const rest = data.budgets.filter(item => !(item.scope === scope && item.id === id))
        if (budget) {
          if (rest.length >= MAX_MODEL_BUDGETS) throw new AppError(409, 'model-budget-limit', '保存的预算太多了。')
          rest.push(budgetSchema.parse({ ...budget, scope, id }))
        }
        data.budgets = rest
      },
      request && { ...request, prepare: () => request.prepare(this.budgetOf(scope, id)) },
    )
  }

  /** Drops what was kept for a service or an Agent that is gone: its budget, and a service's prices. */
  forget(scope: ModelBudget['scope'], id: string): Promise<void> {
    const kept = (data: SpendFile) =>
      data.budgets.some(item => item.scope === scope && item.id === id)
      || (scope === 'service' && data.prices.some(item => item.providerId === id))
    if (!kept(this.data)) return Promise.resolve()
    return this.change(data => {
      data.budgets = data.budgets.filter(item => !(item.scope === scope && item.id === id))
      if (scope === 'service') data.prices = data.prices.filter(item => item.providerId !== id)
    }).then(() => {})
  }

  private change(mutate: (data: SpendFile) => void, request?: SpendMutation<void>): Promise<SpendResult> {
    const run = this.tail.then(async (): Promise<SpendResult> => {
      request?.authorize()
      const receipt = request && this.data.receipts.find(item => item.key === request.key)
      if (receipt) {
        if (receipt.hash !== request?.hash) throw spendRequestConflict()
        return { ok: true, revision: receipt.revision, replayed: true, ...(receipt.auditFailed ? { auditFailed: true } : {}) }
      }
      if (this.pending) {
        const { state, receipt: waiting } = this.pending
        if (waiting.key !== request?.key) throw new AppError(503, 'model-spend-write-pending', '上一项修改结果尚未确认，本次没有提交。')
        if (waiting.hash !== request.hash) throw spendRequestConflict()
        await this.publish(state, waiting)
        return { ok: true, revision: waiting.revision, ...(waiting.auditFailed ? { auditFailed: true } : {}) }
      }
      if (request && request.baseRevision !== this.data.revision)
        throw new AppError(409, 'model-spend-conflict', '单价与预算已变化，请重新读取后再试。', { revision: this.data.revision })
      const prepared: SpendPreparation = request ? await request.prepare() : { changed: true }
      const next = structuredClone(this.data)
      if (prepared.changed) mutate(next)
      next.revision++
      const saved = request && {
        key: request.key,
        hash: request.hash,
        revision: next.revision,
        ...(prepared.auditFailed ? { auditFailed: true as const } : {}),
      }
      if (saved) next.receipts = [...next.receipts, saved].slice(-MAX_MODEL_SPEND_RECEIPTS)
      const checked = fileSchema.parse(next)
      request?.authorize()
      await this.publish(checked, saved)
      return { ok: true, revision: checked.revision, ...(prepared.auditFailed ? { auditFailed: true } : {}) }
    })
    this.tail = run.catch(() => {})
    return run
  }

  private async publish(state: SpendFile, receipt: SavedReceipt | undefined): Promise<void> {
    try {
      await writeFileAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`)
    } catch (error) {
      if (!receipt) throw error
      this.pending = { state, receipt }
      throw new AppError(503, 'model-spend-write-unknown', '修改结果尚未确认，请重试同一请求。')
    }
    this.data = state
    this.pending = undefined
  }
}

const spendRequestConflict = () => new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')

/** One model request as its sender saw it end. Names and numbers only. */
export interface UsageRecord {
  /** When the request arrived. */
  at: number
  sessionId?: string
  /** The service that answered, or the last one asked; the session's own when none was. */
  providerId: string
  /** The model asked of that service. */
  model: string
  /** The model its reply named. */
  used?: string
  outcome: UsageOutcome
  /** Requests actually sent to a service for this one. */
  attempts: number
  fallback: boolean
  firstByteMs?: number
  totalMs: number
  usage?: TokenUsage
  /** What the reply itself said the request cost. */
  reportedCost?: number
}

/** What the gateway and the built-in harness ask of budgets and tell the ledger. */
export interface ModelMeter {
  /** The session's Agent has a monthly budget and it is used up: nothing of the session is sent anywhere. */
  agentOver(sessionId: string): boolean
  /** The service's monthly budget is used up: a request goes to the next candidate, as after a 402. */
  serviceOver(providerId: string): boolean
  /** Writes the request's line; returns what it cost, when known, and where a budget that covers it stands now. */
  record(record: UsageRecord): TurnSpend | undefined
}

interface ModelMeterDeps {
  ledger: UsageLedger
  store: ModelSpendStore
  /** The Agent a session belongs to, when it has one, its project and the Harness that runs it, from the Host's own records. */
  session(sessionId: string): { agentId?: string; harness?: string; projectId?: string }
  /** The Harness a request without a session is counted under. */
  builtIn: string
}

const whole = (ms: number | undefined): number | undefined =>
  ms === undefined || !Number.isFinite(ms) ? undefined : Math.min(Math.max(0, Math.round(ms)), 7 * 86_400_000)

export function createModelMeter(deps: ModelMeterDeps): ModelMeter & { progress(budget: ModelBudget): BudgetProgress } {
  const { ledger, store } = deps
  const progress = (budget: ModelBudget): BudgetProgress => {
    const use = ledger.used(budget.scope === 'service' ? serviceKey(budget.id) : agentKey(budget.id))
    const used = budget.unit === 'tokens' ? use.tokens : (use.cost[budget.currency!] ?? 0) / 1_000_000
    const state = budgetState(used, budget.limit)
    // A cost budget counts only what has a cost in its currency: the requests it could not count are said, not hidden.
    const uncounted = budget.unit === 'cost' ? use.sent - (use.costed[budget.currency!] ?? 0) : 0
    return { ...budget, used, ...(state ? { state } : {}), ...(uncounted > 0 ? { uncounted } : {}) }
  }
  const stateOf = (scope: ModelBudget['scope'], id: string | undefined): BudgetState | undefined => {
    const budget = id === undefined ? undefined : store.budgetOf(scope, id)
    return budget && progress(budget).state
  }
  return {
    progress,
    agentOver: sessionId => stateOf('agent', deps.session(sessionId).agentId) === 'over',
    serviceOver: providerId => stateOf('service', providerId) === 'over',
    record(record) {
      const owner = record.sessionId ? deps.session(record.sessionId) : {}
      const model = ledgerName(record.model)
      const cost =
        record.outcome === 'budget' ? undefined : costOf(record.usage, record.reportedCost, store.priceOf(record.providerId, record.model))
      const counted = reportedTokens(record.usage)
      const firstByteMs = whole(record.firstByteMs)
      const line: UsageLine = {
        at: new Date(record.at).toISOString(),
        ...(record.sessionId ? { sessionId: record.sessionId.slice(0, 256) } : {}),
        ...(owner.agentId ? { agentId: owner.agentId.slice(0, 128) } : {}),
        ...(owner.projectId ? { projectId: owner.projectId.slice(0, 128) } : {}),
        harness: (owner.harness ?? deps.builtIn).slice(0, 128),
        providerId: record.providerId.slice(0, 128),
        model,
        ...(record.used ? { used: ledgerName(record.used) } : {}),
        outcome: record.outcome,
        attempts: Math.min(Math.max(0, Math.round(record.attempts)), 64),
        fallback: record.fallback,
        ...(firstByteMs !== undefined ? { firstByteMs } : {}),
        totalMs: whole(record.totalMs) ?? 0,
        ...counted,
        ...(cost ? { cost } : {}),
      }
      ledger.append(line)
      const amount: CostAmount | undefined = cost
        ? { currency: cost.currency, micros: cost.micros, ...(cost.source === 'prices' ? { priced: true as const } : {}) }
        : undefined
      // The nearer of the two budgets that cover the request, after it is counted.
      const states = [stateOf('service', record.providerId), stateOf('agent', owner.agentId)]
      const budget = states.includes('over') ? 'over' : states.includes('near') ? 'near' : undefined
      return amount || budget ? { ...(amount ? { cost: [amount] } : {}), ...(budget ? { budget } : {}) } : undefined
    },
  }
}

/** Adds one request's spend to a turn's: cost by currency, and the nearer budget state of the two. */
export function addSpend(total: TurnSpend | undefined, next: TurnSpend | undefined): TurnSpend | undefined {
  if (!next) return total
  const cost = (total?.cost ?? []).map(item => ({ ...item }))
  for (const item of next.cost ?? []) {
    const same = cost.find(entry => entry.currency === item.currency)
    if (!same) cost.push({ ...item })
    else {
      same.micros += item.micros
      if (item.priced) same.priced = true
    }
  }
  const budget = total?.budget === 'over' || next.budget === 'over' ? 'over' : (next.budget ?? total?.budget)
  return { ...(cost.length ? { cost } : {}), ...(budget ? { budget } : {}) }
}
