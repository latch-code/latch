import {
  AGENT_PRESETS,
  GENERAL_AGENT_ID,
  type AppSnapshot,
  type CostAmount,
  type HarnessInfo,
  type ModelUsageRow,
  type UsageCompare,
  type UsageGroup,
  type UsagePeriod,
  type UsagePoint,
  type UsageSource,
} from '@latch/protocol'
import type { BarColumn, LinePoint } from '@latch/ui'
import { harnessName } from '../composerChoice.ts'
import { exactTokens } from '../format.ts'
import { notReported, pricedNote } from '../settings/modelSpend.ts'
import { currentLocale, defineCopy, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    ownLogin: '自己登录',
    pluginService: '插件服务',
    inputLabel: '输入',
    outputLabel: '输出',
    noUsage: (count: number, turns: boolean) => plural(count, { other: turns ? '{n} 轮或请求没有报告用量' : '{n} 次请求没有报告用量' }),
    unknownCost: (count: number, turns: boolean) => plural(count, { other: turns ? '{n} 轮或请求的花费未知' : '{n} 次请求的花费未知' }),
    gateway: '经 Latch 网关',
    other: '其他',
    defaultFolder: '默认文件夹',
    general: '通用',
    deletedAgent: '已删除的 Agent',
    otherSessions: '其他会话',
    missingSession: '已不在的会话',
    input: (value1: string | number) => `输入（含缓存）${value1}`,
    output: (value1: string | number) => `输出（含推理）${value1}`,
    cacheRead: '缓存读取',
    cacheWrite: '缓存写入',
    reasoning: '推理',
    harnessEstimate: 'Harness 自己估算',
    serviceReport: '按服务报告',
  },
  {
    ownLogin: 'Own sign-in',
    pluginService: 'Plugin service',
    inputLabel: 'Input',
    outputLabel: 'Output',
    noUsage: (count: number, turns: boolean) =>
      plural(count, {
        other: turns ? '{n} turns or requests did not report usage' : '{n} requests did not report usage',
        one: turns ? '{n} turn or request did not report usage' : '{n} request did not report usage',
      }),
    unknownCost: (count: number, turns: boolean) =>
      plural(count, {
        other: turns ? 'Cost unknown for {n} turns or requests' : 'Cost unknown for {n} requests',
        one: turns ? 'Cost unknown for {n} turn or request' : 'Cost unknown for {n} request',
      }),
    gateway: 'Via Latch Gateway',
    other: 'Other',
    defaultFolder: 'Default folder',
    general: 'General',
    deletedAgent: 'Deleted Agent',
    otherSessions: 'Other sessions',
    missingSession: 'Unavailable session',
    input: (value1: string | number) => `Input (including cache) ${value1}`,
    output: (value1: string | number) => `Output (including reasoning) ${value1}`,
    cacheRead: 'Cache read',
    cacheWrite: 'Cache write',
    reasoning: 'Reasoning',
    harnessEstimate: 'Estimated by the Harness',
    serviceReport: 'Reported by the service',
  },
)

/**
 * A row of either route: a gateway row has no `by` and no `turns`. `split`: tokens by source, on a row that merges the
 * rows of one thing from several sources.
 */
export type AnyRow = ModelUsageRow & { by?: UsageSource; turns?: number; split?: Partial<Record<UsageSource, number>> }

export const SOURCE_NAMES: Readonly<Record<UsageSource, string>> = {
  get gateway() {
    return COPY.gateway
  },
  get own() {
    return COPY.ownLogin
  },
  get plugin() {
    return COPY.pluginService
  },
}

const PARTS = ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

/**
 * One row a thing whatever its sources: the rows of the same group key added up, with each source's tokens kept in
 * `split`. A part some source left out is left out of the sum, as the Host does within a source.
 */
export function mergeSources(rows: readonly AnyRow[]): AnyRow[] {
  const merged = new Map<string, AnyRow>()
  for (const row of rows) {
    const key = JSON.stringify([row.harness, row.providerId, row.model, row.projectId, row.agentId, row.sessionId])
    const tokens = row.usage ? row.usage.inputTokens + row.usage.outputTokens : 0
    const by = row.by ?? 'gateway'
    const into = merged.get(key)
    if (!into) {
      merged.set(key, {
        ...row,
        ...(row.usage ? { usage: { ...row.usage } } : {}),
        cost: row.cost.map(item => ({ ...item })),
        split: { [by]: tokens },
      })
      continue
    }
    into.split = { ...into.split, [by]: (into.split?.[by] ?? 0) + tokens }
    into.requests += row.requests
    into.turns = (into.turns ?? 0) + (row.turns ?? 0)
    into.failed += row.failed
    into.fallbacks += row.fallbacks
    into.measured += row.measured
    into.uncosted += row.uncosted
    for (const part of PARTS) into.partial[part] = into.partial[part] || row.partial[part]
    if (row.usage) {
      if (!into.usage) into.usage = { ...row.usage }
      else {
        const usage = into.usage
        usage.inputTokens += row.usage.inputTokens
        usage.outputTokens += row.usage.outputTokens
        for (const part of PARTS) {
          const value = row.usage[part]
          if (usage[part] !== undefined && value !== undefined) usage[part] += value
          else delete usage[part]
        }
      }
    }
    for (const item of row.cost) {
      const same = into.cost.find(amount => amount.currency === item.currency)
      if (!same) into.cost.push({ ...item })
      else {
        same.micros += item.micros
        if (item.priced) same.priced = true
        if (item.estimated) same.estimated = true
      }
    }
  }
  return [...merged.values()].toSorted(
    (a, b) => (b.usage ? b.usage.inputTokens + b.usage.outputTokens : -1) - (a.usage ? a.usage.inputTokens + a.usage.outputTokens : -1),
  )
}

/** A Harness by its ID, as the catalogue lists it; one no longer listed by its ID alone. */
export function harnessOf(snapshot: AppSnapshot, id: string): Pick<HarnessInfo, 'capabilities'> & Partial<HarnessInfo> {
  const listed = snapshot.catalog?.harnesses.find(harness => harness.id === id)
  if (listed) return listed
  // One not set up on this Host now (removed since): its preset's name and mark, when it was one.
  const preset = AGENT_PRESETS.find(item => item.id === id)
  return { id, capabilities: { display: { label: preset?.name ?? id, ...(preset ? { mark: preset.id } : {}) } } } as unknown as HarnessInfo
}

/** A project's name; one this device does not see, or no project, is 其他. */
export function projectName(snapshot: AppSnapshot, id: string | undefined): string {
  const project = snapshot.catalog?.workspaces.find(workspace => workspace.id === id)
  if (project?.id === 'default') return COPY.defaultFolder
  return project?.name || COPY.other
}

/** What a row is of, a second line when the first alone would not tell it apart, and the Harness it is of when it is one. */
export function usageRowName(row: AnyRow, group: UsageGroup, snapshot: AppSnapshot): { name: string; detail?: string; harness?: string } {
  const service = (id: string | undefined) => snapshot.catalog?.providers.find(item => item.id === id)?.name ?? id ?? ''
  const harness = (id: string) => harnessName(harnessOf(snapshot, id))
  if (group === 'harness' && row.harness) return { name: harness(row.harness), harness: row.harness }
  if (group === 'service')
    return row.providerId
      ? { name: service(row.providerId) }
      : { name: harness(row.harness ?? ''), detail: SOURCE_NAMES.own, harness: row.harness }
  if (group === 'model')
    return {
      name: row.model ?? notReported(),
      detail: row.providerId ? service(row.providerId) : row.harness ? `${harness(row.harness)} · ${SOURCE_NAMES.own}` : undefined,
    }
  if (group === 'project') return { name: projectName(snapshot, row.projectId) }
  if (group === 'agent') {
    // Uses of no Agent, and to a device that may not read Agents, every Agent's.
    if (!row.agentId) return { name: COPY.other }
    if (row.agentId === GENERAL_AGENT_ID) return { name: COPY.general }
    return { name: snapshot.customAgents?.find(agent => agent.id === row.agentId)?.name ?? COPY.deletedAgent }
  }
  // Sessions this device cannot read, ones deleted since, and requests of no session: counted, not named.
  if (!row.sessionId) return { name: COPY.otherSessions }
  return { name: snapshot.tasks.find(task => task.id === row.sessionId)?.title || COPY.missingSession }
}

/** The fine print of a row, one fact a line: the exact counts, what was left out and why. */
export function usageRowDetail(row: AnyRow): string {
  const lines: string[] = []
  if (row.usage) {
    lines.push(COPY.input(exactTokens(row.usage.inputTokens)), COPY.output(exactTokens(row.usage.outputTokens)))
    for (const [name, part] of [
      [COPY.cacheRead, 'cacheReadTokens'],
      [COPY.cacheWrite, 'cacheWriteTokens'],
      [COPY.reasoning, 'reasoningTokens'],
    ] as const) {
      const value = row.usage[part]
      lines.push(`${name} ${value === undefined ? notReported() : exactTokens(value)}`)
    }
  }
  const uses = row.requests + (row.turns ?? 0)
  if (row.measured < uses) lines.push(COPY.noUsage(uses - row.measured, !!row.turns))
  if (row.uncosted > 0 && row.cost.length > 0) lines.push(COPY.unknownCost(row.uncosted, !!row.turns))
  const note = costNote(row.cost)
  if (note) lines.push(note)
  return lines.join('\n')
}

/** Where a cost came from: the prices the person entered, a Harness's own estimate, or the service's word. */
export function costNote(cost: readonly CostAmount[] | undefined): string | undefined {
  if (!cost?.length) return undefined
  const notes = [pricedNote(cost), cost.some(item => item.estimated) ? COPY.harnessEstimate : undefined].filter(Boolean)
  if (cost.some(item => !item.priced && !item.estimated) || notes.length === 0) notes.push(COPY.serviceReport)
  return notes.join(' · ')
}

export interface UsageTotals {
  turns: number
  requests: number
  /** Input and output of the uses that reported tokens; undefined when none did. */
  tokens?: number
  inputTokens: number
  outputTokens: number
  /** Only when every measured use reported it. */
  cacheReadTokens?: number
  cost: CostAmount[]
}

/** Sums over the rows shown: turns, requests, the tokens that were reported by kind, and cost by currency. */
export function usageTotals(rows: readonly AnyRow[]): UsageTotals {
  const totals: UsageTotals = { turns: 0, requests: 0, inputTokens: 0, outputTokens: 0, cost: [] }
  const cost = new Map<string, CostAmount>()
  let cache: number | undefined = 0
  for (const row of rows) {
    totals.turns += row.turns ?? 0
    totals.requests += row.requests
    if (row.usage) {
      totals.tokens = (totals.tokens ?? 0) + row.usage.inputTokens + row.usage.outputTokens
      totals.inputTokens += row.usage.inputTokens
      totals.outputTokens += row.usage.outputTokens
      cache = cache === undefined || row.usage.cacheReadTokens === undefined ? undefined : cache + row.usage.cacheReadTokens
    }
    for (const item of row.cost) {
      const same = cost.get(item.currency)
      if (!same) cost.set(item.currency, { ...item })
      else {
        same.micros += item.micros
        if (item.priced) same.priced = true
        if (item.estimated) same.estimated = true
      }
    }
  }
  if (totals.tokens !== undefined && cache !== undefined) totals.cacheReadTokens = cache
  totals.cost = [...cost.values()]
  return totals
}

/**
 * Of the uses that reported tokens, the share whose cost is not known (no price entered, none reported), as a whole
 * percent; 0 when every one is priced or none reported tokens.
 */
export function unpricedShare(rows: readonly ModelUsageRow[]): number {
  const measured = rows.reduce((sum, row) => sum + row.measured, 0)
  const uncosted = rows.reduce((sum, row) => sum + row.uncosted, 0)
  return measured > 0 ? Math.ceil((uncosted / measured) * 100) : 0
}

/** Cache reads over the input of the uses that reported them, in whole percent; undefined when none did. */
export function cacheShare(points: readonly UsagePoint[]): number | undefined {
  const base = points.reduce((sum, point) => sum + point.cacheBase, 0)
  const read = points.reduce((sum, point) => sum + point.cacheReadTokens, 0)
  return base > 0 ? Math.round((read / base) * 100) : undefined
}

/** The labels of a bucket in the Host's time zone: short under the axis, whole in the hover card. */
function bucketLabels(start: string, period: UsagePeriod, timeZone: string): { label: string; title: string } {
  const at = new Date(start)
  const zone = (() => {
    try {
      return new Intl.DateTimeFormat('zh-CN', { timeZone }).resolvedOptions().timeZone
    } catch {
      return undefined
    }
  })()
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(currentLocale(), { ...options, ...(zone ? { timeZone: zone } : {}) }).format(at)
  const day = part({ month: 'numeric', day: 'numeric' })
  const weekday = part({ weekday: 'short' })
  if (period === '1') {
    const hour = part({ hour: '2-digit', hour12: false }).replace(/\D/gu, '').padStart(2, '0')
    return { label: `${hour}:00`, title: `${day} ${weekday} ${hour}:00` }
  }
  return { label: part({ month: 'numeric', day: 'numeric' }).replace(/月/u, '/').replace(/日/u, ''), title: `${day} ${weekday}` }
}

export const tokenKinds = () => [COPY.cacheRead, COPY.inputLabel, COPY.outputLabel] as const

/** One column a bucket: cache reads, the rest of the input, output; summed over the points given. */
export function tokenColumns(
  buckets: readonly string[],
  points: readonly UsagePoint[],
  period: UsagePeriod,
  timeZone: string,
): BarColumn[] {
  const columns = buckets.map(start => ({ key: start, ...bucketLabels(start, period, timeZone), values: [0, 0, 0] }))
  for (const point of points) {
    const column = columns[point.bucket]
    if (!column) continue
    column.values[0]! += point.cacheReadTokens
    column.values[1]! += Math.max(0, point.inputTokens - point.cacheReadTokens)
    column.values[2]! += point.outputTokens
  }
  return columns
}

/** The cache-hit share of each bucket, over the points given; a gap where none reported cache reads. */
export function cachePoints(buckets: readonly string[], points: readonly UsagePoint[], period: UsagePeriod, timeZone: string): LinePoint[] {
  return buckets.map((start, index) => {
    const here = points.filter(point => point.bucket === index)
    const share = cacheShare(here)
    return {
      key: start,
      ...bucketLabels(start, period, timeZone),
      ...(share !== undefined ? { value: share / 100 } : {}),
    }
  })
}

/** Tokens by where they were counted: through Latch's services, and on a Harness's own login. */
export function sourceSplit(points: readonly UsagePoint[]): Record<UsageSource, number> {
  const split: Record<UsageSource, number> = { gateway: 0, own: 0, plugin: 0 }
  for (const point of points) split[point.by] += point.inputTokens + point.outputTokens
  return split
}

/** Models that ran on two Harnesses or more, each with its Harnesses' measured turns, the most used first. */
export function comparedModels(compare: readonly UsageCompare[]): Array<{ model: string; rows: UsageCompare[] }> {
  const models = new Map<string, UsageCompare[]>()
  for (const row of compare) if (row.measured > 0) models.set(row.model, [...(models.get(row.model) ?? []), row])
  return [...models].filter(([, rows]) => rows.length > 1).map(([model, rows]) => ({ model, rows }))
}
