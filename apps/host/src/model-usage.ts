// The usage ledger: one line of metadata per model request the Host sent or refused, for the gateway and the built-in
// harness alike. A line says who asked, which service was asked for which model, how it ended, how long it took, the
// tokens the service reported and what it cost when that is known. It never holds a request, a reply, a header or a key.
// It is usage metadata, not audit: nothing here grants or records a permission.
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  COST_CURRENCIES,
  USAGE_OUTCOMES,
  type CostCurrency,
  type ModelPrices,
  type ModelUsageRow,
  type TokenUsage,
  type UsageGroup,
} from '@latch/protocol'
import { redactKnownSecrets, writeFileAtomic } from '@latch/core/node-kit'
import { ledgerEntry, summarizeEntries } from './usage-stats.ts'
import { appendLine, closeLastLine, DAY_MS, monthOf, pruneMonths, readMonths, scanLines } from './usage-log.ts'

export { hostTimeZone, monthOf } from './usage-log.ts'

const FILE = /^(?:usage-(\d{4})-(\d{2})\.jsonl|totals-(\d{4})-(\d{2})\.json)$/u

const tokens = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const duration = z
  .number()
  .int()
  .min(0)
  .max(7 * DAY_MS)
/**
 * Every field a line may have. Strict: a line with anything else is not the ledger's and is not read. `model` is the
 * model asked of `providerId` (the service that answered, or the last one asked), `used` what its reply named.
 */
export const usageLineSchema = z.strictObject({
  at: z.string().datetime(),
  sessionId: z.string().min(1).max(256).optional(),
  agentId: z.string().min(1).max(128).optional(),
  /** The session's project, from the Host's records when the request was made. */
  projectId: z.string().min(1).max(128).optional(),
  harness: z.string().min(1).max(128),
  providerId: z.string().min(1).max(128),
  model: z.string().min(1).max(200),
  used: z.string().min(1).max(200).optional(),
  outcome: z.enum(USAGE_OUTCOMES),
  attempts: z.number().int().min(0).max(64),
  fallback: z.boolean(),
  firstByteMs: duration.optional(),
  totalMs: duration,
  inputTokens: tokens.optional(),
  outputTokens: tokens.optional(),
  cacheReadTokens: tokens.optional(),
  cacheWriteTokens: tokens.optional(),
  reasoningTokens: tokens.optional(),
  cost: z.strictObject({ micros: tokens, currency: z.enum(COST_CURRENCIES), source: z.enum(['reported', 'prices']) }).optional(),
})
export type UsageLine = z.infer<typeof usageLineSchema>

/**
 * What a month used so far under one key: a service or an Agent. Cost by currency, in millionths. `sent` counts the
 * requests that reached a service, `costed` those of them whose cost is known in each currency, so a cost budget can say
 * how many it could not count.
 */
export interface MonthUse {
  tokens: number
  cost: Partial<Record<CostCurrency, number>>
  sent: number
  costed: Partial<Record<CostCurrency, number>>
}
const noUse = (): MonthUse => ({ tokens: 0, cost: {}, sent: 0, costed: {} })

export const serviceKey = (providerId: string): string => `service:${providerId}`
export const agentKey = (agentId: string): string => `agent:${agentId}`

/** Whole tokens a service reported, or undefined when either count is not one. */
export function reportedTokens(usage: TokenUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined
  const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  if (!whole(usage.inputTokens) || !whole(usage.outputTokens)) return undefined
  const result: TokenUsage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
  for (const part of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    const value = usage[part]
    if (whole(value)) result[part] = value
  }
  return result
}

/**
 * The most one request may be said to have cost by a service's own word, in dollars. A reply is the service's to write:
 * a number above this is not believed, and the request's cost stays unknown.
 */
export const MAX_REPORTED_COST = 100

/**
 * What a request cost, in the only two cases it is known. Prices the person entered for this model of this service come
 * first: they are the person's own word. Without them, what the service said in its reply (taken as US dollars, as
 * OpenRouter's `usage.cost` is), when it is a plain amount within reason. Nothing is estimated from a price list of
 * Latch's own; there is none.
 */
export function costOf(
  usage: TokenUsage | undefined,
  reportedCost: number | undefined,
  prices: ModelPrices | undefined,
): UsageLine['cost'] | undefined {
  if (prices) {
    const counted = reportedTokens(usage)
    if (!counted) return undefined
    const read = counted.cacheReadTokens ?? 0
    const written = counted.cacheWriteTokens ?? 0
    // `inputTokens` is all input: the cached parts are priced on their own and the rest at the input price.
    const plain = Math.max(0, counted.inputTokens - read - written)
    const micros = Math.round(
      plain * prices.input
        + read * (prices.cacheRead ?? prices.input)
        + written * (prices.cacheWrite ?? prices.input)
        + counted.outputTokens * prices.output,
    )
    return Number.isSafeInteger(micros) ? { micros, currency: prices.currency, source: 'prices' } : undefined
  }
  if (typeof reportedCost !== 'number' || !Number.isFinite(reportedCost) || reportedCost < 0 || reportedCost > MAX_REPORTED_COST)
    return undefined
  return { micros: Math.round(reportedCost * 1_000_000), currency: 'USD', source: 'reported' }
}

interface UsageLedgerDeps {
  now?: () => number
  log(text: string): void
}

const perCurrency = z.strictObject({ USD: tokens.optional(), CNY: tokens.optional() })
const TOTALS_VERSION = 2
/** A month's sums beside its ledger file, so a start does not read the whole month again. Strict, like the ledger. */
const totalsSchema = z.strictObject({
  version: z.literal(TOTALS_VERSION),
  month: z.string().regex(/^\d{4}-\d{2}$/u),
  /** The ledger file's size these sums cover; another size means they are not of this file. */
  bytes: tokens,
  use: z.record(z.string().min(1).max(160), z.strictObject({ tokens, cost: perCurrency, sent: tokens, costed: perCurrency })),
})

/** Adds one line to a month's sums. */
function countLine(use: Map<string, MonthUse>, line: UsageLine): void {
  const total = line.inputTokens !== undefined && line.outputTokens !== undefined ? line.inputTokens + line.outputTokens : 0
  const sent = line.attempts > 0 && line.outcome !== 'budget'
  for (const key of [serviceKey(line.providerId), ...(line.agentId ? [agentKey(line.agentId)] : [])]) {
    let entry = use.get(key)
    if (!entry) use.set(key, (entry = noUse()))
    entry.tokens += total
    if (sent) entry.sent++
    if (line.cost) {
      entry.cost[line.cost.currency] = (entry.cost[line.cost.currency] ?? 0) + line.cost.micros
      if (sent) entry.costed[line.cost.currency] = (entry.costed[line.cost.currency] ?? 0) + 1
    }
  }
}

function addUse(into: Map<string, MonthUse>, from: Iterable<[string, MonthUse]>): void {
  for (const [key, value] of from) {
    let entry = into.get(key)
    if (!entry) into.set(key, (entry = noUse()))
    entry.tokens += value.tokens
    entry.sent += value.sent
    for (const currency of COST_CURRENCIES) {
      if (value.cost[currency] !== undefined) entry.cost[currency] = (entry.cost[currency] ?? 0) + value.cost[currency]
      if (value.costed[currency] !== undefined) entry.costed[currency] = (entry.costed[currency] ?? 0) + value.costed[currency]
    }
  }
}

/**
 * `gateway/usage-YYYY-MM.jsonl` in the data directory: 0600, appended to, one file per month of the Host computer's
 * own time, removed once its whole month is more than 90 days back. A line that cannot be read is passed over and
 * counted, never a reason to fail. Beside each month's file, `totals-YYYY-MM.json` holds its sums by service and by
 * Agent, rewritten with every line; it is trusted only while it covers exactly the ledger file's size, and is rebuilt
 * from the ledger otherwise, however long the month is.
 */
export class UsageLedger {
  private tail: Promise<void> = Promise.resolve()
  private month: string
  /** The sums of the months this process has counted in, by month. Never zeroed: a month come back to is still there. */
  private readonly months = new Map<string, Map<string, MonthUse>>()
  /** The sums of each file's written prefix, separate from the live budget that also counts queued writes. */
  private readonly persistedMonths = new Map<string, Map<string, MonthUse>>()
  /** Ledger files whose end this process has looked at: a line cut short by a crash is closed before the next begins. */
  private readonly ended = new Set<string>()
  private readonly now: () => number

  private constructor(
    private readonly directory: string,
    private readonly deps: UsageLedgerDeps,
  ) {
    this.now = deps.now ?? Date.now
    this.month = monthOf(this.now())
  }

  static async open(dataDir: string, deps: UsageLedgerDeps): Promise<UsageLedger> {
    const directory = join(dataDir, 'gateway')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const ledger = new UsageLedger(directory, deps)
    await ledger.prune()
    ledger.sums(ledger.month)
    await ledger.tail
    return ledger
  }

  private path(month: string): string {
    return join(this.directory, `usage-${month}.jsonl`)
  }

  private totalsPath(month: string): string {
    return join(this.directory, `totals-${month}.json`)
  }

  /**
   * A month's sums in memory. The first time a month is asked for, what its files already hold is read in behind the
   * writes queued so far, so nothing appended since is counted twice.
   */
  private sums(month: string): Map<string, MonthUse> {
    let use = this.months.get(month)
    if (use) return use
    this.months.set(month, (use = new Map()))
    const live = use
    this.tail = this.tail
      .then(async () => {
        const persisted = await this.stored(month)
        this.persistedMonths.set(month, persisted)
        addUse(live, persisted)
      })
      .catch(error => {
        this.deps.log(`用量记录读取失败：${error instanceof Error ? error.message : String(error)}`)
      })
    return use
  }

  /** What a month's files hold: its sums file while it covers the ledger file exactly, else the ledger counted again. */
  private async stored(month: string): Promise<Map<string, MonthUse>> {
    const path = this.path(month)
    await this.closeLastLine(path)
    const size = await stat(path).then(
      info => info.size,
      () => 0,
    )
    try {
      const totals = totalsSchema.parse(JSON.parse(await readFile(this.totalsPath(month), 'utf8')))
      if (totals.month === month && totals.bytes === size) return new Map(Object.entries(totals.use))
    } catch {
      // Missing, unreadable or of another shape: counted again below.
    }
    const use = new Map<string, MonthUse>()
    await this.scan(month, line => countLine(use, line))
    if (size > 0) await this.writeTotals(month, use, size)
    return use
  }

  private async writeTotals(month: string, use: Map<string, MonthUse>, bytes: number): Promise<void> {
    await writeFileAtomic(this.totalsPath(month), JSON.stringify({ version: TOTALS_VERSION, month, bytes, use: Object.fromEntries(use) }))
  }

  private closeLastLine(path: string): Promise<void> {
    return closeLastLine(path, this.ended)
  }

  /** Moves on once the Host computer's own time is in another month: that month's own sums, read from its files. */
  private roll(): void {
    const month = monthOf(this.now())
    if (month === this.month) return
    this.month = month
    this.sums(month)
    this.tail = this.tail.then(() => this.prune()).catch(() => {})
  }

  /** What this month used so far under `key`, requests still being written included. */
  used(key: string): MonthUse {
    this.roll()
    return this.sums(this.month).get(key) ?? noUse()
  }

  currentMonth(): string {
    this.roll()
    return this.month
  }

  /** Counts a line at once and writes it in order; a line that is not the ledger's is dropped, a failed write is logged. */
  append(input: UsageLine): void {
    const parsed = usageLineSchema.safeParse(input)
    if (!parsed.success) {
      this.deps.log('用量记录格式无效，没有写入。')
      return
    }
    const line = parsed.data
    this.roll()
    const month = monthOf(Date.parse(line.at))
    const use = this.sums(month)
    countLine(use, line)
    const path = this.path(month)
    this.tail = this.tail
      .then(async () => {
        const persisted = this.persistedMonths.get(month) ?? (await this.stored(month))
        await this.closeLastLine(path)
        const size = await appendLine(path, line)
        this.ended.add(path)
        countLine(persisted, line)
        await this.writeTotals(month, persisted, size)
        this.persistedMonths.set(month, persisted)
      })
      .catch(error => {
        // A write that failed part way may have left a line cut short: the file's end is looked at again next time.
        this.ended.delete(path)
        this.persistedMonths.delete(month)
        this.deps.log(`用量记录写入失败：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /** Resolves once every line appended so far is written. */
  flushed(): Promise<void> {
    return this.tail
  }

  /** Removes the files of months that ended more than 90 days ago; a file that is not the ledger's is left alone. */
  async prune(): Promise<void> {
    const removed = await pruneMonths(
      this.directory,
      name => {
        const match = FILE.exec(name)
        return match ? `${match[1] ?? match[3]}-${match[2] ?? match[4]}` : undefined
      },
      this.now(),
    )
    for (const month of removed) {
      this.months.delete(month)
      this.persistedMonths.delete(month)
    }
  }

  /** Every readable line of a month's file, one at a time; resolves with how many could not be read. */
  private scan(month: string, each: (line: UsageLine) => boolean | void): Promise<number> {
    return scanLines(this.path(month), usageLineSchema, each)
  }

  /** The lines of requests that arrived in `[from, to]`, never older than 90 days, with how many could not be read. */
  async read(from: number, to: number): Promise<{ lines: UsageLine[]; skipped: number; truncated: boolean }> {
    await this.tail
    return readMonths(month => this.path(month), usageLineSchema, from, to, this.now())
  }
}

/**
 * Groups ledger lines. Only what the services reported is summed: a row none of whose requests reported tokens has no
 * `usage` at all, and a part some measured request left out is dropped from the row instead of being shown short.
 */
export function summarizeUsage(lines: readonly UsageLine[], group: UsageGroup): ModelUsageRow[] {
  return summarizeEntries(lines.map(ledgerEntry), group).map(({ by: _by, turns: _turns, ...row }) => row)
}

/** A model's name as a line keeps it: without anything that looks like a secret, cut to length. */
export const ledgerName = (name: string): string => redactKnownSecrets(name).slice(0, 200) || '-'
