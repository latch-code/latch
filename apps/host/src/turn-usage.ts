// The record of turns the gateway did not meter: one line of metadata per turn Latch ran on a Harness's own login, or
// of the built-in harness on a plugin's own provider (`via: plugin`). The gateway's requests are in the ledger, request by
// request; the demo model is counted nowhere. A line says when, which session,
// Agent, project and Harness, the model as the Harness named it, how many tool calls and how long, and the tokens and
// cost the Harness reported for the turn. It never holds a prompt, a reply or a tool's output.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { COST_CURRENCIES } from '@latch/protocol'
import type { HarnessTurnRecord } from '@latch/sdk'
import { appendLine, closeLastLine, DAY_MS, monthOf, pruneMonths, readMonths } from './usage-log.ts'
import { ledgerName, MAX_REPORTED_COST, reportedTokens } from './model-usage.ts'

const FILE = /^turns-(\d{4})-(\d{2})\.jsonl$/u
const tokens = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const at = z.string().datetime()

/** Every field a line may have. Strict: a line with anything else is not the record's and is not read. */
export const turnLineSchema = z.strictObject({
  at,
  startedAt: at,
  sessionId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(128).optional(),
  projectId: z.string().min(1).max(128).optional(),
  harness: z.string().min(1).max(128),
  /** A built-in turn on a plugin's own provider, which the gateway does not meter; absent: a Harness's own login. */
  via: z.literal('plugin').optional(),
  providerId: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(200).optional(),
  steps: z.number().int().min(0).max(1_000_000),
  activeMs: z
    .number()
    .int()
    .min(0)
    .max(7 * DAY_MS)
    .optional(),
  inputTokens: tokens.optional(),
  outputTokens: tokens.optional(),
  cacheReadTokens: tokens.optional(),
  cacheWriteTokens: tokens.optional(),
  reasoningTokens: tokens.optional(),
  /** The turn's part of what the Harness said its login cost, at its own list prices: an estimate. */
  cost: z.strictObject({ micros: tokens, currency: z.enum(COST_CURRENCIES), source: z.literal('agent') }).optional(),
})
export type TurnLine = z.infer<typeof turnLineSchema>

/**
 * A driver's settled turn as a line: names cut to length and stripped of anything that looks like a secret, tokens
 * only when whole, cost only in a currency the record keeps and within reason. Undefined when the times are not times.
 */
export function turnLine(
  turn: HarnessTurnRecord,
  owner: { harness: string; agentId?: string; projectId?: string; via?: 'plugin' },
): TurnLine | undefined {
  const end = Date.parse(turn.endedAt)
  const start = Date.parse(turn.startedAt)
  if (!Number.isFinite(end) || !Number.isFinite(start)) return undefined
  const counted = reportedTokens(turn.usage)
  const currency = COST_CURRENCIES.find(item => item === turn.cost?.currency)
  const amount = turn.cost?.amount
  const cost =
    currency && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && amount <= MAX_REPORTED_COST
      ? { micros: Math.round(amount * 1_000_000), currency, source: 'agent' as const }
      : undefined
  const activeMs = turn.activeMs === undefined ? undefined : Math.min(Math.max(0, Math.round(turn.activeMs)), 7 * DAY_MS)
  const projectId = owner.projectId ?? turn.projectId
  return {
    at: new Date(end).toISOString(),
    startedAt: new Date(Math.min(start, end)).toISOString(),
    sessionId: turn.sessionId.slice(0, 256),
    ...(owner.agentId ? { agentId: owner.agentId.slice(0, 128) } : {}),
    ...(projectId ? { projectId: projectId.slice(0, 128) } : {}),
    harness: owner.harness.slice(0, 128),
    ...(owner.via && turn.providerId ? { via: owner.via, providerId: turn.providerId.slice(0, 128) } : {}),
    ...(turn.model ? { model: ledgerName(turn.model) } : {}),
    steps: Math.min(Math.max(0, Math.round(turn.steps)), 1_000_000),
    ...(activeMs !== undefined ? { activeMs } : {}),
    ...counted,
    ...(cost ? { cost } : {}),
  }
}

/**
 * `usage/turns-YYYY-MM.jsonl` in the data directory: 0600, appended to, one file per month of the Host computer's own
 * time, removed once its whole month is more than 90 days back, as the ledger's are. Deleting a session leaves its
 * lines: they are counted without its name.
 */
export class TurnLog {
  private tail: Promise<void> = Promise.resolve()
  private readonly ended = new Set<string>()
  private month: string

  private constructor(
    private readonly directory: string,
    private readonly deps: { now: () => number; log(text: string): void },
  ) {
    this.month = monthOf(deps.now())
  }

  static async open(dataDir: string, deps: { now?: () => number; log(text: string): void }): Promise<TurnLog> {
    const directory = join(dataDir, 'usage')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const log = new TurnLog(directory, { now: deps.now ?? (() => Date.now()), log: text => deps.log(text) })
    await log.prune()
    return log
  }

  private path(month: string): string {
    return join(this.directory, `turns-${month}.jsonl`)
  }

  /** Writes a line in order; one that is not the record's is dropped, a failed write is logged. */
  append(input: TurnLine): void {
    const parsed = turnLineSchema.safeParse(input)
    if (!parsed.success) {
      this.deps.log('轮次用量记录格式无效，没有写入。')
      return
    }
    const line = parsed.data
    const path = this.path(monthOf(Date.parse(line.at)))
    const current = monthOf(this.deps.now())
    const rolled = current !== this.month
    this.month = current
    this.tail = this.tail
      .then(async () => {
        if (rolled) await this.prune()
        await closeLastLine(path, this.ended)
        await appendLine(path, line)
        this.ended.add(path)
      })
      .catch(error => {
        // A write that failed part way may have left a line cut short: the file's end is looked at again next time.
        this.ended.delete(path)
        this.deps.log(`轮次用量记录写入失败：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /** Resolves once every line appended so far is written. */
  flushed(): Promise<void> {
    return this.tail
  }

  async prune(): Promise<void> {
    await pruneMonths(
      this.directory,
      name => {
        const match = FILE.exec(name)
        return match ? `${match[1]}-${match[2]}` : undefined
      },
      this.deps.now(),
    )
  }

  /** The turns that ended in `[from, to]`, never older than 90 days, with how many lines could not be read. */
  async read(from: number, to: number): Promise<{ lines: TurnLine[]; skipped: number; truncated: boolean }> {
    await this.tail
    return readMonths(month => this.path(month), turnLineSchema, from, to, this.deps.now())
  }
}
