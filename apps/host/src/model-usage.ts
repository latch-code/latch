// The usage ledger: one line of metadata per model request the Host sent or refused, for the gateway and the built-in
// harness alike. A line says who asked, which service was asked for which model, how it ended, how long it took, the
// tokens the service reported and what it cost when that is known. It never holds a request, a reply, a header or a key.
// It is usage metadata, not audit: nothing here grants or records a permission.
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import {
  COST_CURRENCIES,
  USAGE_OUTCOMES,
  type CostAmount,
  type CostCurrency,
  type ModelPrices,
  type ModelUsageRow,
  type TokenUsage,
  type UsageGroup,
  type UsageOutcome,
} from '@latch/protocol'
import { redactKnownSecrets, writeFileAtomic } from '@latch/core/node-kit'

const DAY_MS = 86_400_000
/** How long a request stays in the ledger. */
const USAGE_KEEP_DAYS = 90
/** Lines read for one summary; a period with more says so. The month's sums for budgets have no such limit. */
const MAX_READ_LINES = 400_000
const MAX_LINE_CHARS = 4096
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

/** `YYYY-MM` of a time, in the Host computer's own time: where a month begins and ends for the ledger and for budgets. */
export function monthOf(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/** The first instant of a month, and of the month after it, in the Host computer's own time. */
export function monthBounds(month: string): { start: number; end: number } {
  const [year, index] = month.split('-').map(Number) as [number, number]
  return { start: new Date(year, index - 1, 1).getTime(), end: new Date(year, index, 1).getTime() }
}

export const hostTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

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

const missing = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'

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

  /** A file whose last line a crash cut short gets its newline, so the next line is a line of its own. */
  private async closeLastLine(path: string): Promise<void> {
    if (this.ended.has(path)) return
    let handle
    try {
      handle = await open(path, 'r+')
    } catch (error) {
      if (missing(error)) this.ended.add(path)
      return
    }
    try {
      // A file from before, or one somebody copied in: the ledger's own mode again before it is read or added to.
      await handle.chmod(0o600)
      const { size } = await handle.stat()
      if (size > 0) {
        const last = Buffer.alloc(1)
        await handle.read(last, 0, 1, size - 1)
        if (last[0] !== 0x0a) await handle.write('\n', size)
      }
      this.ended.add(path)
    } finally {
      await handle.close()
    }
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
        const handle = await open(path, 'a', 0o600)
        let size: number
        try {
          await handle.appendFile(`${JSON.stringify(line)}\n`)
          size = (await handle.stat()).size
        } finally {
          await handle.close()
        }
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
    const oldest = this.now() - USAGE_KEEP_DAYS * DAY_MS
    for (const name of await readdir(this.directory).catch(() => [])) {
      const match = FILE.exec(name)
      if (!match) continue
      const month = `${match[1] ?? match[3]}-${match[2] ?? match[4]}`
      if (monthBounds(month).end > oldest) continue
      await unlink(join(this.directory, name)).catch(() => {})
      this.months.delete(month)
      this.persistedMonths.delete(month)
    }
  }

  /** Every readable line of a month's file, one at a time; resolves with how many could not be read. */
  private async scan(month: string, each: (line: UsageLine) => boolean | void): Promise<number> {
    let skipped = 0
    const stream = createReadStream(this.path(month), { encoding: 'utf8' })
    try {
      for await (const text of createInterface({ input: stream, crlfDelay: Infinity })) {
        if (!text) continue
        let parsed: unknown
        try {
          parsed = text.length > MAX_LINE_CHARS ? undefined : JSON.parse(text)
        } catch {
          parsed = undefined
        }
        const line = usageLineSchema.safeParse(parsed)
        if (!line.success) skipped++
        else if (each(line.data) === false) break
      }
    } catch (error) {
      if (!missing(error)) skipped++
    } finally {
      stream.destroy()
    }
    return skipped
  }

  /** The lines of requests that arrived in `[from, to]`, never older than 90 days, with how many could not be read. */
  async read(from: number, to: number): Promise<{ lines: UsageLine[]; skipped: number; truncated: boolean }> {
    await this.tail
    const start = Math.max(from, this.now() - USAGE_KEEP_DAYS * DAY_MS)
    const months: string[] = []
    for (let month = monthOf(start); month <= monthOf(to);) {
      months.push(month)
      month = monthOf(monthBounds(month).end)
    }
    const result = { lines: [] as UsageLine[], skipped: 0, truncated: false }
    for (const month of months) {
      result.skipped += await this.scan(month, line => {
        const at = Date.parse(line.at)
        if (at < start || at > to) return true
        if (result.lines.length >= MAX_READ_LINES) {
          result.truncated = true
          return false
        }
        result.lines.push(line)
        return true
      })
    }
    return result
  }
}

const PARTS = ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

function keyOf(line: UsageLine, group: UsageGroup): Pick<ModelUsageRow, 'sessionId' | 'agentId' | 'providerId' | 'model'> {
  if (group === 'session') return line.sessionId ? { sessionId: line.sessionId } : {}
  if (group === 'agent') return line.agentId ? { agentId: line.agentId } : {}
  if (group === 'service') return { providerId: line.providerId }
  return { providerId: line.providerId, model: line.model }
}

const FAILED: ReadonlySet<UsageOutcome> = new Set(USAGE_OUTCOMES.filter(outcome => outcome !== 'ok' && outcome !== 'aborted'))

/**
 * Groups ledger lines. Only what the services reported is summed: a row none of whose requests reported tokens has no
 * `usage` at all, and a part some measured request left out is dropped from the row instead of being shown short.
 */
export function summarizeUsage(lines: readonly UsageLine[], group: UsageGroup): ModelUsageRow[] {
  const rows = new Map<string, ModelUsageRow & { costs: Map<CostCurrency, CostAmount> }>()
  for (const line of lines) {
    const key = keyOf(line, group)
    const id = JSON.stringify([key.sessionId ?? null, key.agentId ?? null, key.providerId ?? null, key.model ?? null])
    let row = rows.get(id)
    if (!row) {
      row = {
        ...key,
        requests: 0,
        failed: 0,
        fallbacks: 0,
        measured: 0,
        partial: { cacheReadTokens: false, cacheWriteTokens: false, reasoningTokens: false },
        cost: [],
        uncosted: 0,
        costs: new Map(),
      }
      rows.set(id, row)
    }
    row.requests++
    if (FAILED.has(line.outcome)) row.failed++
    if (line.fallback) row.fallbacks++
    if (line.inputTokens !== undefined && line.outputTokens !== undefined) {
      const first = row.usage === undefined
      const usage = (row.usage ??= { inputTokens: 0, outputTokens: 0 })
      row.measured++
      usage.inputTokens += line.inputTokens
      usage.outputTokens += line.outputTokens
      for (const part of PARTS) {
        const value = line[part]
        if (value === undefined || row.partial[part]) {
          row.partial[part] = true
          delete usage[part]
        } else if (first || usage[part] !== undefined) usage[part] = (usage[part] ?? 0) + value
      }
      if (!line.cost) row.uncosted++
    }
    if (line.cost) {
      let amount = row.costs.get(line.cost.currency)
      if (!amount) row.costs.set(line.cost.currency, (amount = { currency: line.cost.currency, micros: 0 }))
      amount.micros += line.cost.micros
      if (line.cost.source === 'prices') amount.priced = true
    }
  }
  return [...rows.values()]
    .map(({ costs, ...row }) => ({ ...row, cost: [...costs.values()] }))
    .toSorted(
      (a, b) =>
        (b.usage ? b.usage.inputTokens + b.usage.outputTokens : -1) - (a.usage ? a.usage.inputTokens + a.usage.outputTokens : -1)
        || b.requests - a.requests,
    )
}

/** A model's name as a line keeps it: without anything that looks like a secret, cut to length. */
export const ledgerName = (name: string): string => redactKnownSecrets(name).slice(0, 200) || '-'
