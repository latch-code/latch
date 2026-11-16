import { GENERAL_AGENT_ID, type AppSnapshot, type CostAmount, type ModelUsageRow, type UsageGroup } from '@latch/protocol'
import { exactTokens } from '../format.ts'
import { NOT_REPORTED, pricedNote } from '../settings/modelSpend.ts'

/** What a row is of, and a second line when the first alone would not tell it apart. */
export function usageRowName(row: ModelUsageRow, group: UsageGroup, snapshot: AppSnapshot): { name: string; detail?: string } {
  const service = (id: string | undefined) => snapshot.catalog?.providers.find(item => item.id === id)?.name ?? id ?? ''
  if (group === 'service') return { name: service(row.providerId) }
  if (group === 'model') return { name: row.model ?? '', detail: service(row.providerId) }
  if (group === 'agent') {
    // Requests of no Agent, and to a device that may not read Agents, every Agent's.
    if (!row.agentId) return { name: '其他' }
    if (row.agentId === GENERAL_AGENT_ID) return { name: '通用' }
    return { name: snapshot.customAgents?.find(agent => agent.id === row.agentId)?.name ?? '已删除的 Agent' }
  }
  // Sessions this device cannot read, ones deleted since, and requests of no session: counted, not named.
  if (!row.sessionId) return { name: '其他会话' }
  return { name: snapshot.tasks.find(task => task.id === row.sessionId)?.title || '已不在的会话' }
}

/** The fine print of a row, one fact a line: the exact counts, what was left out and why. */
export function usageRowDetail(row: ModelUsageRow): string {
  const lines: string[] = []
  if (row.usage) {
    lines.push(`输入（含缓存）${exactTokens(row.usage.inputTokens)}`, `输出（含推理）${exactTokens(row.usage.outputTokens)}`)
    for (const [name, part] of [
      ['缓存读取', 'cacheReadTokens'],
      ['缓存写入', 'cacheWriteTokens'],
      ['推理', 'reasoningTokens'],
    ] as const) {
      const value = row.usage[part]
      lines.push(`${name} ${value === undefined ? NOT_REPORTED : exactTokens(value)}`)
    }
  }
  if (row.measured < row.requests) lines.push(`${row.requests - row.measured} 次请求没有报告用量`)
  if (row.uncosted > 0 && row.cost.length > 0) lines.push(`${row.uncosted} 次请求的花费未知`)
  const note = pricedNote(row.cost)
  if (note) lines.push(note)
  return lines.join('\n')
}

/** Sums over the rows shown: requests, the tokens that were reported, and cost by currency. */
export function usageTotals(rows: readonly ModelUsageRow[]): { requests: number; tokens: number | undefined; cost: CostAmount[] } {
  let tokens: number | undefined
  const cost = new Map<string, CostAmount>()
  let requests = 0
  for (const row of rows) {
    requests += row.requests
    if (row.usage) tokens = (tokens ?? 0) + row.usage.inputTokens + row.usage.outputTokens
    for (const item of row.cost) {
      const same = cost.get(item.currency)
      if (!same) cost.set(item.currency, { ...item })
      else {
        same.micros += item.micros
        if (item.priced) same.priced = true
      }
    }
  }
  return { requests, tokens, cost: [...cost.values()] }
}

/**
 * Of the requests that reported tokens, the share whose cost is not known (no price entered, none reported), as a whole
 * percent; 0 when every one is priced or none reported tokens.
 */
export function unpricedShare(rows: readonly ModelUsageRow[]): number {
  const measured = rows.reduce((sum, row) => sum + row.measured, 0)
  const uncosted = rows.reduce((sum, row) => sum + row.uncosted, 0)
  return measured > 0 ? Math.ceil((uncosted / measured) * 100) : 0
}
