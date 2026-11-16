// What the usage view draws, worked out when it is read: the gateway's requests and the own-login turns as one kind of
// entry, grouped into rows, bucketed by day (or by hour for the last 24 hours) and by hour of the week in the Host
// computer's own time. Nothing is stored here; nothing is estimated.
import type {
  CostAmount,
  CostCurrency,
  TokenUsage,
  UsageCompare,
  UsageGroup,
  UsagePeriod,
  UsagePoint,
  UsageRow,
  UsageSeries,
  UsageSource,
  UsageOutcome,
} from '@latch/protocol'
import type { UsageLine } from './model-usage.ts'
import type { TurnLine } from './turn-usage.ts'

const HOUR_MS = 3_600_000
const PARTS = ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

/** One request through the gateway, or one own-login turn. */
export interface UsageEntry {
  at: number
  by: UsageSource
  harness: string
  sessionId?: string
  agentId?: string
  projectId?: string
  providerId?: string
  model?: string
  requests: number
  turns: number
  failed: boolean
  fallback: boolean
  /** Absent: the use reported no tokens. */
  usage?: TokenUsage
  cost?: { micros: number; currency: CostCurrency; source: 'reported' | 'prices' | 'agent' }
}

const FAILED = (outcome: UsageOutcome) => outcome !== 'ok' && outcome !== 'aborted'

const usageOf = (line: Partial<Record<keyof TokenUsage, number>>): TokenUsage | undefined => {
  if (line.inputTokens === undefined || line.outputTokens === undefined) return undefined
  const usage: TokenUsage = { inputTokens: line.inputTokens, outputTokens: line.outputTokens }
  for (const part of PARTS) if (line[part] !== undefined) usage[part] = line[part]
  return usage
}

export function ledgerEntry(line: UsageLine): UsageEntry {
  const usage = usageOf(line)
  return {
    at: Date.parse(line.at),
    by: 'gateway',
    harness: line.harness,
    ...(line.sessionId ? { sessionId: line.sessionId } : {}),
    ...(line.agentId ? { agentId: line.agentId } : {}),
    ...(line.projectId ? { projectId: line.projectId } : {}),
    providerId: line.providerId,
    model: line.model,
    requests: 1,
    turns: 0,
    failed: FAILED(line.outcome),
    fallback: line.fallback,
    ...(usage ? { usage } : {}),
    ...(line.cost ? { cost: line.cost } : {}),
  }
}

export function turnEntry(line: TurnLine): UsageEntry {
  const usage = usageOf(line)
  return {
    at: Date.parse(line.at),
    by: line.via ?? 'own',
    harness: line.harness,
    sessionId: line.sessionId,
    ...(line.providerId ? { providerId: line.providerId } : {}),
    ...(line.agentId ? { agentId: line.agentId } : {}),
    ...(line.projectId ? { projectId: line.projectId } : {}),
    ...(line.model ? { model: line.model } : {}),
    requests: 0,
    turns: 1,
    failed: false,
    fallback: false,
    ...(usage ? { usage } : {}),
    ...(line.cost ? { cost: line.cost } : {}),
  }
}

/**
 * A period's buckets in the Host computer's own time: the last 24 clock hours, the current one last; or the last N
 * calendar days, today last. Day edges come from the calendar, not from 24-hour steps, so a day across a clock change is
 * still one day.
 */
export function periodBuckets(period: UsagePeriod, now: number): number[] {
  const date = new Date(now)
  if (period === '1') {
    date.setMinutes(0, 0, 0)
    const last = date.getTime()
    return Array.from({ length: 24 }, (_, index) => last - (23 - index) * HOUR_MS)
  }
  const days = Number(period)
  return Array.from({ length: days }, (_, index) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate() - (days - 1 - index)).getTime(),
  )
}

/** The bucket `at` falls in, or -1 before the first. */
export function bucketOf(at: number, buckets: readonly number[]): number {
  let low = 0
  let high = buckets.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (buckets[middle]! <= at) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  return found
}

/** Monday 00:00 is 0: the hour of the week in the Host computer's own time. */
export const hourOfWeek = (at: number): number => {
  const date = new Date(at)
  return ((date.getDay() + 6) % 7) * 24 + date.getHours()
}

/** The series the charts draw. Built from entries already stripped of what the caller may not read: it names no session. */
export function seriesOf(entries: readonly UsageEntry[], buckets: readonly number[]): UsageSeries {
  const points = new Map<string, UsagePoint>()
  const hours = Array.from({ length: 168 }, () => 0)
  for (const entry of entries) {
    const bucket = bucketOf(entry.at, buckets)
    if (bucket < 0) continue
    hours[hourOfWeek(entry.at)]! += entry.requests + entry.turns
    const key = JSON.stringify([bucket, entry.by, entry.harness, entry.providerId ?? null])
    let point = points.get(key)
    if (!point) {
      point = {
        bucket,
        by: entry.by,
        harness: entry.harness,
        ...(entry.providerId ? { providerId: entry.providerId } : {}),
        requests: 0,
        turns: 0,
        measured: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheBase: 0,
      }
      points.set(key, point)
    }
    point.requests += entry.requests
    point.turns += entry.turns
    if (!entry.usage) continue
    point.measured++
    point.inputTokens += entry.usage.inputTokens
    point.outputTokens += entry.usage.outputTokens
    if (entry.usage.cacheReadTokens !== undefined) {
      // Never more cached than the input it is part of: a report that says otherwise counts its whole input as read.
      point.cacheReadTokens += Math.min(entry.usage.cacheReadTokens, entry.usage.inputTokens)
      point.cacheBase += entry.usage.inputTokens
    }
  }
  return {
    buckets: buckets.map(start => new Date(start).toISOString()),
    series: [...points.values()].toSorted((a, b) => a.bucket - b.bucket),
    hours,
  }
}

function keyOf(
  entry: UsageEntry,
  group: UsageGroup,
): Partial<Pick<UsageRow, 'harness' | 'sessionId' | 'agentId' | 'providerId' | 'model' | 'projectId'>> {
  if (group === 'harness') return { harness: entry.harness }
  if (group === 'session') return entry.sessionId ? { sessionId: entry.sessionId } : {}
  if (group === 'agent') return entry.agentId ? { agentId: entry.agentId } : {}
  if (group === 'project') return entry.projectId ? { projectId: entry.projectId } : {}
  // An own-login turn has no service: it is grouped under its Harness.
  if (group === 'service') return entry.providerId ? { providerId: entry.providerId } : { harness: entry.harness }
  return entry.providerId
    ? { providerId: entry.providerId, ...(entry.model ? { model: entry.model } : {}) }
    : { harness: entry.harness, ...(entry.model ? { model: entry.model } : {}) }
}

/**
 * Groups entries, one row per group and source. Only what was reported is summed: a row none of whose uses reported
 * tokens has no `usage` at all, and a part some measured use left out is dropped from the row instead of being shown short.
 */
export function summarizeEntries(entries: readonly UsageEntry[], group: UsageGroup): UsageRow[] {
  const rows = new Map<string, UsageRow & { costs: Map<CostCurrency, CostAmount> }>()
  for (const entry of entries) {
    const key = keyOf(entry, group)
    const id = JSON.stringify([
      entry.by,
      key.harness ?? null,
      key.sessionId ?? null,
      key.agentId ?? null,
      key.providerId ?? null,
      key.model ?? null,
      key.projectId ?? null,
    ])
    let row = rows.get(id)
    if (!row) {
      row = {
        ...key,
        by: entry.by,
        requests: 0,
        turns: 0,
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
    row.requests += entry.requests
    row.turns += entry.turns
    if (entry.failed) row.failed++
    if (entry.fallback) row.fallbacks++
    if (entry.usage) {
      const first = row.usage === undefined
      const usage = (row.usage ??= { inputTokens: 0, outputTokens: 0 })
      row.measured++
      usage.inputTokens += entry.usage.inputTokens
      usage.outputTokens += entry.usage.outputTokens
      for (const part of PARTS) {
        const value = entry.usage[part]
        if (value === undefined || row.partial[part]) {
          row.partial[part] = true
          delete usage[part]
        } else if (first || usage[part] !== undefined) usage[part] = (usage[part] ?? 0) + value
      }
      if (!entry.cost) row.uncosted++
    }
    if (entry.cost) {
      let amount = row.costs.get(entry.cost.currency)
      if (!amount) row.costs.set(entry.cost.currency, (amount = { currency: entry.cost.currency, micros: 0 }))
      amount.micros += entry.cost.micros
      if (entry.cost.source === 'prices') amount.priced = true
      if (entry.cost.source === 'agent') amount.estimated = true
    }
  }
  return [...rows.values()]
    .map(({ costs, ...row }) => ({ ...row, cost: [...costs.values()] }))
    .toSorted(
      (a, b) =>
        (b.usage ? b.usage.inputTokens + b.usage.outputTokens : -1) - (a.usage ? a.usage.inputTokens + a.usage.outputTokens : -1)
        || b.requests + b.turns - (a.requests + a.turns),
    )
}

/** Tokens by project, largest first. */
export function projectsOf(entries: readonly UsageEntry[]): Array<{ projectId?: string; turns: number; requests: number; tokens: number }> {
  const projects = new Map<string, { projectId?: string; turns: number; requests: number; tokens: number }>()
  for (const entry of entries) {
    const id = entry.projectId ?? ''
    let project = projects.get(id)
    if (!project)
      projects.set(id, (project = { ...(entry.projectId ? { projectId: entry.projectId } : {}), turns: 0, requests: 0, tokens: 0 }))
    project.turns += entry.turns
    project.requests += entry.requests
    if (entry.usage) project.tokens += entry.usage.inputTokens + entry.usage.outputTokens
  }
  return [...projects.values()].toSorted((a, b) => b.tokens - a.tokens || b.turns + b.requests - (a.turns + a.requests))
}

/** A model's name as two Harnesses may spell it: without a vendor prefix, case or a date suffix. */
const modelKey = (model: string): string =>
  model
    .toLowerCase()
    .replace(/^.*\//u, '')
    .replace(/[-@](?:\d{8}|\d{4}-\d{2}-\d{2})$/u, '')

/** Turns outside the gateway (own login, plugin providers) by model and Harness, models in the order of their turns; turns that named no model are left out. */
export function compareOf(entries: readonly UsageEntry[]): UsageCompare[] {
  const rows = new Map<string, UsageCompare & { key: string }>()
  for (const entry of entries) {
    if (entry.by === 'gateway' || !entry.model) continue
    const key = modelKey(entry.model)
    const id = JSON.stringify([key, entry.harness])
    let row = rows.get(id)
    if (!row)
      rows.set(id, (row = { key, model: entry.model, harness: entry.harness, turns: 0, measured: 0, inputTokens: 0, outputTokens: 0 }))
    row.turns += entry.turns
    if (!entry.usage) continue
    row.measured += entry.turns
    row.inputTokens += entry.usage.inputTokens
    row.outputTokens += entry.usage.outputTokens
  }
  const byModel = new Map<string, number>()
  const names = new Map<string, string>()
  for (const row of rows.values()) {
    byModel.set(row.key, (byModel.get(row.key) ?? 0) + row.turns)
    names.set(row.key, names.get(row.key) ?? row.model)
  }
  // One name per model, so the same model on two Harnesses reads as one.
  return [...rows.values()]
    .toSorted((a, b) => byModel.get(b.key)! - byModel.get(a.key)! || a.key.localeCompare(b.key) || b.turns - a.turns)
    .map(({ key, ...row }) => ({ ...row, model: names.get(key)! }))
}
