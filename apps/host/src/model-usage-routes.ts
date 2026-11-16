// The usage page's and the budget settings' routes. Reading needs `view`; changing a price or a budget needs `admin` and
// no local confirmation: it is the person's own money, not a security boundary. Every change is on the audit trail
// before it is made: one that lets more be spent is not made when the record cannot be written, one that lets less be
// spent is made anyway and the answer says the record failed. Nothing here returns a key.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  USAGE_GROUPS,
  USAGE_PERIODS,
  type DeviceScope,
  type ModelBudget,
  type ModelFallback,
  type ModelPrices,
  type ModelSpend,
  type ModelSpendWrite,
  type ModelUsageSummary,
  type TaskSummary,
  type UsagePeriod,
  type UsageSummary,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import type { AuditActor, AuditLog } from './audit.ts'
import { json, jsonBody } from './http-util.ts'
import { budgetSchema, pricesSchema, type ModelSpendStore, type createModelMeter } from './model-budgets.ts'
import { hostTimeZone, type UsageLedger } from './model-usage.ts'
import type { TurnLog } from './turn-usage.ts'
import { compareOf, ledgerEntry, periodBuckets, projectsOf, seriesOf, summarizeEntries, turnEntry, type UsageEntry } from './usage-stats.ts'

const daySchema = z.string().datetime().optional()
const usageSchema = z.strictObject({ period: z.enum(USAGE_PERIODS), group: z.enum(USAGE_GROUPS), day: daySchema })
const allUsageSchema = z.strictObject({
  period: z.enum(USAGE_PERIODS),
  group: z.enum(USAGE_GROUPS),
  by: z.enum(['gateway', 'own', 'plugin', 'all']),
  day: daySchema,
})
const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/u)
const writeRequest = { requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u), baseRevision: z.number().int().nonnegative() }
const priceInput = z.strictObject({
  ...writeRequest,
  providerId: opaque,
  model: z.string().min(1).max(200),
  prices: pricesSchema.nullable(),
})
const budgetInput = z.strictObject({
  ...writeRequest,
  scope: z.enum(['service', 'agent']),
  id: opaque,
  budget: z
    .strictObject({ unit: z.enum(['tokens', 'cost']), currency: z.enum(['USD', 'CNY']).optional(), limit: z.number().positive() })
    .nullable(),
})

interface Options<Caller> {
  ledger: UsageLedger
  turns: TurnLog
  store: ModelSpendStore
  meter: Pick<ReturnType<typeof createModelMeter>, 'progress'>
  now: () => number
  authorize(caller: Caller, scope: DeviceScope): void
  recheck(caller: Caller, scope: DeviceScope): void
  /** Whether the caller may read what Agents' sessions did; without it no request is named by its Agent, and no Agent's budget is shown. */
  seesAgents(caller: Caller): boolean
  requireAgentData(caller: Caller): void
  /**
   * The sessions the caller may read now, by ID. A request of any other session (a private one, one deleted since, one
   * the Host no longer lists) is counted without saying whose it was.
   */
  sessions(): Promise<TaskSummary[]>
  sessionVisible(summary: TaskSummary, seesAgents: boolean): boolean
  /** The projects every device may see now, by ID; a use of any other project is counted without saying which. */
  projects(): ReadonlySet<string>
  /** A saved service's models; undefined when there is no such service. */
  models(providerId: string): readonly string[] | undefined
  /** The configured primary and fallbacks when this Agent uses a saved service model. */
  agentModels(agentId: string): readonly ModelFallback[]
  /** Whether a saved service has this model. */
  hasModel(providerId: string, model: string): boolean
  hasService(providerId: string): boolean
  hasAgent(agentId: string): boolean
  changed(): void
  actorOf(caller: Caller): AuditActor
  /** Writes an audit record. With `tolerant`, a failed write marks that response and resolves instead of throwing. */
  audited(event: Parameters<AuditLog['append']>[0], tolerant?: ServerResponse): Promise<number | undefined>
  /** Marks an audited change whose write then failed. */
  auditFailed(refSeq: number | undefined, caller: Caller): void
}

const PRICE_FIELDS = ['currency', 'input', 'output', 'cacheRead', 'cacheWrite'] as const
const BUDGET_FIELDS = ['unit', 'currency', 'limit'] as const

/** The fields of `names` that differ between what is saved and what is asked for; all that either has when one is absent. */
function differing<T extends object, K extends keyof T & string>(names: readonly K[], before: T | undefined, after: T | null): K[] {
  return names.filter(name => (before?.[name] ?? null) !== (after?.[name] ?? null))
}

/**
 * Whether a budget change lets more be spent than before: taking a budget away, raising its limit, or counting it in
 * another unit or currency. A first budget, or a lower limit, only ever lets less be spent.
 */
function widens(before: ModelBudget | undefined, after: Omit<ModelBudget, 'scope' | 'id'> | null): boolean {
  if (!before) return false
  return !after || after.unit !== before.unit || after.currency !== before.currency || after.limit > before.limit
}

export function createModelUsageRoutes<Caller>(options: Options<Caller>) {
  const { ledger, store, meter } = options
  let busy = false
  /** One read of the records at a time: a second is told to come back. */
  async function exclusive(work: () => Promise<void>): Promise<void> {
    if (busy) throw new AppError(429, 'rate-limited', '正在读取用量，请稍后再试。', { retryAfter: 1 })
    busy = true
    try {
      await work()
    } finally {
      busy = false
    }
  }
  /** The period's buckets and the instants it spans; narrowed to one bucket of it when `day` names one. */
  function windowOf(period: UsagePeriod, day: string | undefined): { from: number; to: number; buckets: number[] } {
    const to = options.now()
    const buckets = periodBuckets(period, to)
    if (day === undefined) return { from: buckets[0]!, to, buckets }
    const index = buckets.indexOf(Date.parse(day))
    if (index < 0) throw new AppError(400, 'usage-day-unknown', '这一天不在所选期间里。')
    return { from: buckets[index]!, to: index + 1 < buckets.length ? buckets[index + 1]! - 1 : to, buckets }
  }
  /**
   * What the caller may be told of each use. Only a session the caller may read now keeps its name; every other use is
   * still counted, in sums that say neither which session nor, to a device that may not read Agents, which Agent. A
   * project no longer listed is not named. Asked again right before the answer, so a device whose access just narrowed
   * gets the narrower answer.
   */
  async function visible(caller: Caller, entries: UsageEntry[]): Promise<UsageEntry[]> {
    const sessions = await options.sessions()
    options.recheck(caller, 'view')
    const agents = options.seesAgents(caller)
    const shown = new Set(sessions.filter(summary => options.sessionVisible(summary, agents)).map(summary => summary.id))
    const projects = options.projects()
    return entries.map(entry => {
      const { sessionId, agentId, projectId, ...rest } = entry
      const known = sessionId !== undefined && shown.has(sessionId)
      return {
        ...rest,
        ...(known && (agents || !agentId) ? { sessionId } : {}),
        ...(agents && agentId ? { agentId } : {}),
        ...(projectId && projects.has(projectId) ? { projectId } : {}),
      }
    })
  }
  function requestIdentity<T extends ModelSpendWrite>(caller: Caller, path: string, input: T) {
    const { requestId, ...value } = input
    return {
      key: sha256Hex(canonicalJson([options.actorOf(caller).deviceId, requestId])),
      hash: sha256Hex(canonicalJson([path, value])),
      baseRevision: input.baseRevision,
    }
  }
  async function auditWrite(event: Parameters<AuditLog['append']>[0], tolerant?: ServerResponse) {
    try {
      return await options.audited(event, tolerant)
    } catch {
      throw new AppError(503, 'model-spend-audit-unavailable', '无法写入审计，本次修改没有提交。')
    }
  }
  function reply(res: ServerResponse, receipt: Awaited<ReturnType<ModelSpendStore['setPrice']>>): void {
    const { auditFailed, ...result } = receipt
    if (auditFailed) res.setHeader('x-latch-audit', 'failed')
    if (!result.replayed) options.changed()
    json(res, result)
  }
  return {
    async handle(req: IncomingMessage, res: ServerResponse, caller: Caller, path: string, method: string): Promise<boolean> {
      if (path === '/link/api/model-usage' && method === 'POST') {
        options.authorize(caller, 'view')
        const input = usageSchema.parse(await jsonBody(req))
        options.recheck(caller, 'view')
        await exclusive(async () => {
          const window = windowOf(input.period, input.day)
          const read = await ledger.read(window.from, window.to)
          const entries = await visible(caller, read.lines.map(ledgerEntry))
          const result: ModelUsageSummary = {
            period: input.period,
            group: input.group,
            ...(input.day ? { day: input.day } : {}),
            from: new Date(window.from).toISOString(),
            to: new Date(window.to).toISOString(),
            timeZone: hostTimeZone(),
            rows: summarizeEntries(entries, input.group).map(({ by: _by, turns: _turns, ...row }) => row),
            ...seriesOf(entries, window.buckets),
            skipped: read.skipped,
            truncated: read.truncated,
          }
          json(res, result)
        })
        return true
      }
      if (path === '/link/api/usage' && method === 'POST') {
        options.authorize(caller, 'view')
        const input = allUsageSchema.parse(await jsonBody(req))
        options.recheck(caller, 'view')
        await exclusive(async () => {
          const window = windowOf(input.period, input.day)
          const none = { lines: [], skipped: 0, truncated: false }
          const requests = input.by === 'own' ? none : await ledger.read(window.from, window.to)
          const turns = input.by === 'gateway' ? none : await options.turns.read(window.from, window.to)
          const kept = turns.lines.map(turnEntry).filter(entry => input.by === 'all' || entry.by === input.by)
          const entries = await visible(caller, [...requests.lines.map(ledgerEntry), ...kept])
          const result: UsageSummary = {
            period: input.period,
            group: input.group,
            by: input.by,
            ...(input.day ? { day: input.day } : {}),
            from: new Date(window.from).toISOString(),
            to: new Date(window.to).toISOString(),
            timeZone: hostTimeZone(),
            rows: summarizeEntries(entries, input.group),
            ...seriesOf(entries, window.buckets),
            projects: projectsOf(entries),
            compare: compareOf(entries),
            skipped: requests.skipped + turns.skipped,
            truncated: requests.truncated || turns.truncated,
          }
          json(res, result)
        })
        return true
      }
      if (path === '/link/api/model-spend' && method === 'GET') {
        options.authorize(caller, 'view')
        const agents = options.seesAgents(caller)
        const result: ModelSpend = {
          revision: store.revision(),
          prices: store.prices(),
          budgets: store
            .budgets()
            .filter(budget => agents || budget.scope === 'service')
            .map(budget => meter.progress(budget)),
          month: ledger.currentMonth(),
          timeZone: hostTimeZone(),
        }
        json(res, result)
        return true
      }
      if (path === '/link/api/model-prices' && method === 'PUT') {
        options.authorize(caller, 'admin')
        const input = priceInput.parse(await jsonBody(req))
        let seq: number | undefined
        try {
          const receipt = await store.setPrice(input.providerId, input.model, input.prices, {
            ...requestIdentity(caller, path, input),
            authorize: () => options.recheck(caller, 'admin'),
            prepare: async before => {
              // A new price needs a saved model. A completed replay can still be answered after that model is gone.
              if (input.prices && !options.hasModel(input.providerId, input.model))
                throw new AppError(404, 'model-unavailable', '模型服务里没有这个模型。')
              const fields = differing(PRICE_FIELDS, before, input.prices)
              if (fields.length === 0) return { changed: false }
              // Any price change can let more be spent.
              seq = await auditWrite({
                action: 'model.prices.changed',
                actor: options.actorOf(caller),
                target: input.providerId,
                detail: { providerId: input.providerId, modelHash: sha256Hex(input.model), fields, removed: input.prices === null },
              })
              return { changed: true }
            },
          })
          reply(res, receipt)
        } catch (error) {
          if (!(error instanceof AppError && error.code === 'model-spend-write-unknown')) options.auditFailed(seq, caller)
          throw error
        }
        return true
      }
      if (path === '/link/api/model-budgets' && method === 'PUT') {
        options.authorize(caller, 'admin')
        const input = budgetInput.parse(await jsonBody(req))
        const authorize = () => {
          options.recheck(caller, 'admin')
          if (input.scope === 'agent') options.requireAgentData(caller)
        }
        authorize()
        if (input.budget) budgetSchema.parse({ ...input.budget, scope: input.scope, id: input.id })
        let seq: number | undefined
        try {
          const receipt = await store.setBudget(input.scope, input.id, input.budget, {
            ...requestIdentity(caller, path, input),
            authorize,
            prepare: async before => {
              if (input.budget) {
                if (!(input.scope === 'service' ? options.hasService(input.id) : options.hasAgent(input.id)))
                  throw new AppError(404, 'budget-target-missing', input.scope === 'service' ? '没有这个模型服务。' : '没有这个 Agent。')
                if (input.budget.unit === 'cost') {
                  const currency = input.budget.currency!
                  const covered =
                    input.scope === 'service'
                      ? (options.models(input.id) ?? []).map(model => ({ providerId: input.id, model }))
                      : options.agentModels(input.id)
                  if (covered.length === 0)
                    throw new AppError(
                      400,
                      'budget-cost-unknown',
                      '这个 Agent 没有固定用某个服务的模型，花费算不出来；请按 tokens 设预算。',
                    )
                  const unpriced = covered.filter(item => store.priceOf(item.providerId, item.model)?.currency !== currency)
                  if (unpriced.length > 0)
                    throw new AppError(
                      400,
                      'budget-cost-unknown',
                      `按花费的预算要先给这些模型填这个币种的单价：${unpriced
                        .slice(0, 5)
                        .map(item => item.model)
                        .join('、')}${unpriced.length > 5 ? ` 等 ${unpriced.length} 个` : ''}`,
                    )
                }
              }
              const fields = differing(BUDGET_FIELDS, before, input.budget)
              if (fields.length === 0) return { changed: false }
              // Audit against the actual preceding budget write while holding the same write queue.
              const widening = widens(before, input.budget)
              seq = await auditWrite(
                {
                  action: 'model.budget.changed',
                  actor: options.actorOf(caller),
                  target: input.id,
                  detail: { scope: input.scope, id: input.id, fields, removed: input.budget === null, widening },
                },
                widening ? undefined : res,
              )
              return { changed: true, ...(seq === undefined ? { auditFailed: true as const } : {}) }
            },
          })
          reply(res, receipt)
        } catch (error) {
          if (!(error instanceof AppError && error.code === 'model-spend-write-unknown')) options.auditFailed(seq, caller)
          throw error
        }
        return true
      }
      return false
    },
  }
}
