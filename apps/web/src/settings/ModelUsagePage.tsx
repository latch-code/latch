import { useEffect, useState } from 'react'
import {
  GENERAL_AGENT_ID,
  type AppSnapshot,
  type BudgetProgress,
  type CostAmount,
  type ModelUsageRow,
  type ModelUsageSummary,
  type UsageGroup,
  type UsagePeriod,
} from '@latch/protocol'
import { Button, InlineNotice, Loading, SegmentedControl } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { exactTokens, formatTokens } from '../format.ts'
import { NoteLine, SettingsGroup, SettingsRow } from './common.tsx'
import { BudgetProgressLine, useModelSpend } from './ModelSpend.tsx'
import { NOT_REPORTED, costsText, pricedNote, rowCost, rowTokens } from './modelSpend.ts'
import { readDenied, type ModelSettingsReads } from './modelSettingsReads.ts'

const PERIODS: ReadonlyArray<{ value: UsagePeriod; label: string }> = [
  { value: 'month', label: '本月' },
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
]
const GROUPS: ReadonlyArray<{ value: UsageGroup; label: string }> = [
  { value: 'service', label: '服务' },
  { value: 'model', label: '模型' },
  { value: 'agent', label: 'Agent' },
  { value: 'session', label: '会话' },
]

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

function budgetName(budget: BudgetProgress, snapshot: AppSnapshot): string {
  if (budget.scope === 'service') return snapshot.catalog?.providers.find(item => item.id === budget.id)?.name ?? budget.id
  if (budget.id === GENERAL_AGENT_ID) return '通用'
  return snapshot.customAgents?.find(agent => agent.id === budget.id)?.name ?? budget.id
}

/**
 * 设置 › 用量: what the model requests this Mac sent used, from the usage ledger, by service, model, Agent or session.
 * Every device that may view reads it; nothing here is changed. A number no service reported reads 未报告, never 0.
 */
export function ModelUsagePage({ snapshot, access, reads }: { snapshot: AppSnapshot; access: DeviceAccess; reads: ModelSettingsReads }) {
  const [period, setPeriod] = useState(reads.period)
  const [group, setGroup] = useState(reads.group)
  if (!access.scopes.has('view')) return null
  // A new device or scope must never render a previous view's rows while its requests are being replaced.
  return (
    <ModelUsageView
      key={reads.audience}
      snapshot={snapshot}
      access={access}
      reads={reads}
      period={period}
      group={group}
      setPeriod={next => {
        reads.keepUsageChoice(next, group)
        setPeriod(next)
      }}
      setGroup={next => {
        reads.keepUsageChoice(period, next)
        setGroup(next)
      }}
    />
  )
}

function ModelUsageView({
  snapshot,
  access,
  reads,
  period,
  group,
  setPeriod,
  setGroup,
}: {
  snapshot: AppSnapshot
  access: DeviceAccess
  reads: ModelSettingsReads
  period: UsagePeriod
  group: UsageGroup
  setPeriod: (period: UsagePeriod) => void
  setGroup: (group: UsageGroup) => void
}) {
  const query = `${period}:${group}` as const
  const [settled, settle] = useState<{ query: typeof query; turn: number; error: string }>()
  const [turn, setTurn] = useState(0)
  const spending = useModelSpend(true, snapshot.revision, reads)
  const spend = spending.spend
  useEffect(() => {
    const controller = new AbortController()
    void api<ModelUsageSummary>('model-usage', { method: 'POST', body: { period, group }, signal: controller.signal }).then(
      result => {
        if (controller.signal.aborted) return
        if (result.period !== period || result.group !== group) {
          settle({ query, turn, error: '收到的用量数据与所选期间或分组不符。' })
          return
        }
        reads.usage.set(query, result)
        settle({ query, turn, error: '' })
      },
      cause => {
        if (controller.signal.aborted) return
        if (readDenied(cause)) reads.usage.clear()
        settle({ query, turn, error: errorMessage(cause) })
      },
    )
    return () => {
      controller.abort()
    }
  }, [period, group, query, reads, turn])
  const shown = reads.usage.get(query)
  const current = settled?.query === query && settled.turn === turn ? settled : undefined
  const error = current?.error
  const totals = shown ? usageTotals(shown.rows) : undefined
  const totalCost = costsText(totals?.cost)
  const totalNote = pricedNote(totals?.cost)
  const budgets = spend?.budgets ?? []
  return (
    <>
      <SettingsGroup
        title="用量"
        bare
        meta={
          <SegmentedControl
            label="统计期间"
            value={period}
            options={PERIODS}
            onValueChange={next => {
              setPeriod(next)
            }}
          />
        }
        note={
          <NoteLine
            brief={{
              label: '不是账单',
              detail: '令牌数由服务报告。花费按你填写的单价计算，未填单价时使用服务报告的花费。',
            }}
          />
        }>
        <div className="model-usage-bar">
          <SegmentedControl
            label="分组"
            value={group}
            options={GROUPS}
            onValueChange={next => {
              setGroup(next)
            }}
          />
        </div>
        {!current && !shown && <Loading label="正在读取用量…" />}
        {error && (
          <InlineNotice
            tone="error"
            action={
              <Button
                size="sm"
                onClick={() => {
                  setTurn(count => count + 1)
                }}>
                重试
              </Button>
            }>
            {error}
            {shown && ' 当前显示上次读取结果。'}
          </InlineNotice>
        )}
        {shown && shown.rows.length === 0 && <p className="settings-empty">这个期间还没有请求。</p>}
        {shown && totals && shown.rows.length > 0 && (
          <p className="usage-total">
            <strong>{totals.tokens === undefined ? NOT_REPORTED : formatTokens(totals.tokens)}</strong>
            {totals.tokens === undefined ? '' : ' tokens'} · {totals.requests} 次请求
            {totalCost ? ` · ${totalCost}` : ''}
            {totalNote ? `（${totalNote}）` : ''}
          </p>
        )}
        {shown && shown.rows.length > 0 && (
          <div className="usage-table model-usage-table">
            <table>
              <thead>
                <tr>
                  <th>{GROUPS.find(item => item.value === group)!.label}</th>
                  <th>请求</th>
                  <th>失败</th>
                  <th>备选</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>花费</th>
                </tr>
              </thead>
              <tbody>
                {shown.rows.map((row, index) => {
                  const { name, detail } = usageRowName(row, group, snapshot)
                  const cost = rowCost(row)
                  return (
                    <tr key={index} title={usageRowDetail(row) || undefined}>
                      <th scope="row">
                        {name}
                        {detail && <small>{detail}</small>}
                      </th>
                      <td>{row.requests}</td>
                      <td>{row.failed}</td>
                      <td>{row.fallbacks}</td>
                      <td>{rowTokens(row, 'inputTokens')}</td>
                      <td>{rowTokens(row, 'outputTokens')}</td>
                      <td>
                        {cost}
                        {pricedNote(row.cost) && <small>{pricedNote(row.cost)}</small>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {shown && shown.skipped > 0 && <InlineNotice>有 {shown.skipped} 行记录读不出，没有计入。</InlineNotice>}
        {shown?.truncated && <InlineNotice>这个期间的请求太多，只算了读到的部分。</InlineNotice>}
      </SettingsGroup>
      {(budgets.length > 0 || spending.error) && (
        <SettingsGroup
          title="本月预算"
          note={
            spend && (
              <NoteLine
                brief={{
                  label: '按这台 Mac 的时间算月',
                  detail: `${spend.month}，${spend.timeZone}。${access.admin ? '在 设置 › 模型 的服务页和 Agent 的设置里改。' : '改预算要能管理这台 Mac。'}`,
                }}
              />
            )
          }>
          {spending.error && (
            <InlineNotice
              tone="error"
              action={
                <Button size="sm" onClick={() => void spending.reload()}>
                  重试
                </Button>
              }>
              {spending.error}
              {budgets.length > 0 && ' 当前显示上次读取结果。'}
            </InlineNotice>
          )}
          {budgets.map(budget => (
            <SettingsRow
              key={`${budget.scope}:${budget.id}`}
              title={budgetName(budget, snapshot)}
              description={budget.scope === 'service' ? '服务' : 'Agent'}
              trailing={<BudgetProgressLine budget={budget} />}
            />
          ))}
        </SettingsGroup>
      )}
    </>
  )
}
