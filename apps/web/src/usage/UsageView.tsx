import { useEffect, useMemo, useState } from 'react'
import {
  USAGE_SOURCES,
  type AppSnapshot,
  type ModelUsageSummary,
  type UsageGroup,
  type UsagePeriod,
  type UsageSeries,
  type UsageSource,
  type UsageSummary,
} from '@latch/protocol'
import {
  Badge,
  Popover,
  SourceSplit,
  BarChart,
  BarRows,
  Button,
  ChartLegend,
  HeatGrid,
  InlineNotice,
  LineChart,
  SegmentedControl,
  ShareBar,
  Skeleton,
  ValuePicker,
  type SharePart,
} from '@latch/ui'
import { HarnessTile } from '../components/BrandTile.tsx'
import { harnessName } from '../composerChoice.ts'
import { api, errorMessage } from '../core/api.ts'
import { exactTokens, formatTokens } from '../format.ts'
import { useModelSpend } from '../settings/ModelSpend.tsx'
import { budgetProgressText, costsText, notReported } from '../settings/modelSpend.ts'
import { LimitWindow } from './LimitWindow.tsx'
import { budgetLimit } from './limits.ts'
import type { UsageRequest } from './surface.ts'
import {
  cachePoints,
  cacheShare,
  comparedModels,
  costNote,
  harnessOf,
  mergeSources,
  projectName,
  SOURCE_NAMES,
  sourceSplit,
  tokenKinds,
  tokenColumns,
  unpricedShare,
  usageRowDetail,
  usageRowName,
  usageTotals,
  type AnyRow,
} from './usage.ts'
import { defineCopy, formatNumber, plural, useLocale } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    day: '24 小时',
    week: '7 天',
    month: '30 天',
    quarter: '90 天',
    allSources: '全部来源',
    byHarness: '按 Harness',
    byModel: '按模型',
    byService: '按服务',
    byProject: '按项目',
    byAgent: '按 Agent',
    bySession: '按会话',
    period: '统计期间',
    source: '来源',
    retry: '重试',
    stale: ' 当前显示上次读取结果。',
    tokensDetail: (value1: string | number, value2: string | number) => `输入 ${value1}
输出 ${value2}`,
    estimateBasis: '估算的依据',
    estimate: '估算',
    unpriced: (value1: string | number) => `${value1}% 未计价`,
    turns: (count: number) => plural(count, { other: '{n} 轮' }),
    requests: (count: number) => plural(count, { other: '{n} 次请求' }),
    count: (count: number) => plural(count, { other: '{n} 次' }),
    uncounted: (count: number) => plural(count, { other: '未计入 {n} 次' }),
    omitted: (count: number) => plural(count, { other: '有 {n} 行记录读不出，没有计入' }),
    tokenSplit: (input: string, output: string) => `输入 ${input} · 输出 ${output}`,
    hitRate: (rate: string) => `缓存命中 ${rate}`,
    perTurn: (tokens: string, turns: string) => `${tokens} / 轮 · ${turns}`,
    groupName: { harness: 'Harness', model: '模型', service: '服务', project: '项目', agent: 'Agent', session: '会话' },
    empty: '这个期间没有 Latch 运行的用量',
    hourly: '每小时 tokens',
    daily: '每日 tokens',
    periodSessions: '这一段的会话',
    collapse: '收起',
    noUsage: '没有用量',
    input: '输入',
    output: '输出',
    cacheHit: '缓存命中',
    allHarnesses: '全部 Harness',
    times: '时段',
    project: '项目',
    monthlyBudget: '本月预算',
    details: '明细',
    group: '分组',
    tooMany: '记录太多，只算了读到的部分',
    other: '其他',
    modelComparison: '同一模型，不同 Harness',
    noComparison: '没有在两个 Harness 上都用过的模型',
    inputPerTurn: '输入 / 轮',
    outputPerTurn: '输出 / 轮',
    usage: '用量',
    uses: '次数',
    failed: (value1: string | number) => `失败 ${value1}`,
    fallbacks: (value1: string | number) => `备选 ${value1}`,
  },
  {
    day: '24 hours',
    week: '7 days',
    month: '30 days',
    quarter: '90 days',
    allSources: 'All sources',
    byHarness: 'By Harness',
    byModel: 'By model',
    byService: 'By service',
    byProject: 'By project',
    byAgent: 'By Agent',
    bySession: 'By session',
    period: 'Period',
    source: 'Source',
    retry: 'Retry',
    stale: ' Showing the last result.',
    tokensDetail: (value1: string | number, value2: string | number) => `Input ${value1}
Output ${value2}`,
    estimateBasis: 'About the estimate',
    estimate: 'Estimated',
    unpriced: (value1: string | number) => `${value1}% unpriced`,
    turns: (count: number) => plural(count, { one: '{n} turn', other: '{n} turns' }),
    requests: (count: number) => plural(count, { one: '{n} request', other: '{n} requests' }),
    count: (count: number) => plural(count, { other: '{n}' }),
    uncounted: (count: number) => plural(count, { one: '{n} request excluded', other: '{n} requests excluded' }),
    omitted: (count: number) => plural(count, { one: '{n} unreadable record excluded', other: '{n} unreadable records excluded' }),
    tokenSplit: (input: string, output: string) => `Input ${input} · Output ${output}`,
    hitRate: (rate: string) => `Cache hits ${rate}`,
    perTurn: (tokens: string, turns: string) => `${tokens} / turn · ${turns}`,
    groupName: { harness: 'Harness', model: 'Model', service: 'Service', project: 'Project', agent: 'Agent', session: 'Session' },
    empty: 'No usage from Latch in this period',
    hourly: 'Tokens per hour',
    daily: 'Tokens per day',
    periodSessions: 'Sessions in this period',
    collapse: 'Show less',
    noUsage: 'No usage',
    input: 'Input',
    output: 'Output',
    cacheHit: 'Cache hits',
    allHarnesses: 'All Harnesses',
    times: 'Time of week',
    project: 'Project',
    monthlyBudget: 'Monthly budget',
    details: 'Details',
    group: 'Group by',
    tooMany: 'Too many records. Showing totals for the records read',
    other: 'Other',
    modelComparison: 'Same model across Harnesses',
    noComparison: 'No model was used on more than one Harness',
    inputPerTurn: 'Input per turn',
    outputPerTurn: 'Output per turn',
    usage: 'Usage',
    uses: 'Count',
    failed: (value1: string | number) => `Failed ${value1}`,
    fallbacks: (value1: string | number) => `Fallbacks ${value1}`,
  },
)

const PERIODS: Array<{ value: UsagePeriod; label: string }> = [
  {
    value: '1',
    get label() {
      return COPY.day
    },
  },
  {
    value: '7',
    get label() {
      return COPY.week
    },
  },
  {
    value: '30',
    get label() {
      return COPY.month
    },
  },
  {
    value: '90',
    get label() {
      return COPY.quarter
    },
  },
]
const SOURCES: Array<{ value: UsageSource | 'all'; label: string }> = [
  {
    value: 'all',
    get label() {
      return COPY.allSources
    },
  },
  {
    value: 'gateway',
    get label() {
      return SOURCE_NAMES.gateway
    },
  },
  {
    value: 'own',
    get label() {
      return SOURCE_NAMES.own
    },
  },
  {
    value: 'plugin',
    get label() {
      return SOURCE_NAMES.plugin
    },
  },
]
const GROUPS: Array<{ value: UsageGroup; label: string }> = [
  {
    value: 'harness',
    get label() {
      return COPY.byHarness
    },
  },
  {
    value: 'model',
    get label() {
      return COPY.byModel
    },
  },
  {
    value: 'service',
    get label() {
      return COPY.byService
    },
  },
  {
    value: 'project',
    get label() {
      return COPY.byProject
    },
  },
  {
    value: 'agent',
    get label() {
      return COPY.byAgent
    },
  },
  {
    value: 'session',
    get label() {
      return COPY.bySession
    },
  },
]

/** The choices last made stay made while the page lives, across a new audience or a reopening. */
const chosen: { period: UsagePeriod; group: UsageGroup; by: UsageSource | 'all' } = { period: '30', group: 'harness', by: 'all' }

/** What either route answers, as the view draws it. */
interface Shown extends UsageSeries {
  period: UsagePeriod
  /** The grouping the rows are of: while another is read, the last answer is named by its own. */
  group: UsageGroup
  /** The sources asked for; a service's own view reads the ledger alone. */
  by: UsageSource | 'all'
  timeZone: string
  rows: AnyRow[]
  projects?: UsageSummary['projects']
  compare?: UsageSummary['compare']
  skipped: number
  truncated: boolean
}

/**
 * One read of the records, kept by what was asked: the last answer stays on screen, marked busy, while the next is on
 * its way, so a change of period or grouping never empties the view.
 */
function useUsageRead(key: string | undefined, read: (signal: AbortSignal) => Promise<Shown>) {
  const [answers, setAnswers] = useState<{ key: string; value: Shown }>()
  const [failure, setFailure] = useState<{ key: string; text: () => string }>()
  const [turn, setTurn] = useState(0)
  useEffect(() => {
    if (key === undefined) return undefined
    const controller = new AbortController()
    read(controller.signal).then(
      value => {
        if (controller.signal.aborted) return
        setAnswers({ key, value })
        setFailure(undefined)
      },
      cause => {
        if (!controller.signal.aborted) setFailure({ key, text: () => errorMessage(cause) })
      },
    )
    return () => controller.abort()
    // `read` is rebuilt every render; `key` says everything it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, turn])
  return {
    shown: answers?.value,
    stale: answers !== undefined && answers.key !== key,
    error: failure && failure.key === key ? failure.text() : undefined,
    retry: () => setTurn(count => count + 1),
  }
}

function fromModelUsage(summary: ModelUsageSummary): Shown {
  return { ...summary, by: 'gateway', rows: summary.rows }
}

function UsageSkeleton() {
  return (
    <div className="usage-skeleton" aria-hidden="true">
      <div className="usage-total">
        <Skeleton width={140} height={28} />
        <Skeleton width={260} height={16} />
      </div>
      <div className="usage-panel">
        <Skeleton width={96} height={16} />
        <Skeleton width="100%" height={176} />
      </div>
    </div>
  )
}

function Panel({
  title,
  aside,
  children,
  className,
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`usage-panel${className ? ` ${className}` : ''}`} aria-label={title}>
      <header className="usage-panel-head">
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  )
}

const tokens = (value: number) => (value === 0 ? '0' : formatTokens(value))
const percent = (value: number) => formatNumber(value, { style: 'percent' })

export function UsageView({ request, snapshot }: { request: UsageRequest; snapshot: AppSnapshot }) {
  useLocale()
  const [period, choosePeriod] = useState<UsagePeriod>(chosen.period)
  const [chosenGroup, chooseGroup] = useState<UsageGroup>(chosen.group)
  const [by, chooseBy] = useState<UsageSource | 'all'>(chosen.by)
  const [day, setDay] = useState<string>()
  const setPeriod = (next: UsagePeriod) => {
    chosen.period = next
    choosePeriod(next)
    setDay(undefined)
  }
  const setBy = (next: UsageSource | 'all') => {
    chosen.by = next
    chooseBy(next)
    setDay(undefined)
  }
  const setGroup = (next: UsageGroup) => {
    chosen.group = next
    chooseGroup(next)
  }
  const [cacheHarness, setCacheHarness] = useState('')
  // One service's use (a session on it asked): its models from the gateway's ledger, and its own budget.
  const scope = request.providerId
  const group: UsageGroup = scope ? 'model' : chosenGroup
  const key = scope ? `model-usage:${period}` : `usage:${period}:${group}:${by}`
  const main = useUsageRead(key, async signal =>
    scope
      ? fromModelUsage(await api<ModelUsageSummary>('model-usage', { method: 'POST', body: { period, group }, signal }))
      : await api<UsageSummary>('usage', { method: 'POST', body: { period, group, by }, signal }),
  )
  const dayKey = day === undefined ? undefined : `${key}:${day}`
  const daily = useUsageRead(dayKey, signal =>
    api<UsageSummary>('usage', { method: 'POST', body: { period, group: 'session', by, day }, signal }),
  )
  const spending = useModelSpend(true, snapshot.revision)
  const shown = main.shown
  const points = useMemo(
    () => (shown ? (scope ? shown.series.filter(point => point.providerId === scope) : shown.series) : []),
    [shown, scope],
  )
  const rows = shown ? (scope ? shown.rows.filter(row => row.providerId === scope) : shown.rows) : undefined
  // Every source at once: one row a thing, its sources split inside the row.
  const tableRows = rows && !scope && shown?.by === 'all' ? mergeSources(rows) : rows
  const totals = rows ? usageTotals(rows) : undefined
  const harnessIds = [...new Set(points.filter(point => point.cacheBase > 0).map(point => point.harness))]
  const cacheOf = cacheHarness && harnessIds.includes(cacheHarness) ? points.filter(point => point.harness === cacheHarness) : points
  const hit = cacheShare(points)
  const cost = costsText(totals?.cost)
  const unpriced = rows ? unpricedShare(rows) : 0
  const budgets = (spending.spend?.budgets ?? []).filter(budget => !scope || (budget.scope === 'service' && budget.id === scope))
  const harness = (id: string) => harnessOf(snapshot, id)
  const nothing = rows !== undefined && rows.length === 0
  const dayRows = daily.shown?.rows
  const columns = shown ? tokenColumns(shown.buckets, points, shown.period, shown.timeZone) : []
  return (
    <div className="usage-usage">
      <div className="usage-controls">
        <SegmentedControl label={COPY.period} size="sm" value={period} options={PERIODS} onValueChange={setPeriod} />
        {!scope && <ValuePicker label={COPY.source} value={by} options={SOURCES} onValueChange={setBy} menuChevron width="xs" />}
      </div>
      {main.error && (
        <InlineNotice
          tone="error"
          action={
            <Button size="sm" onClick={main.retry}>
              {COPY.retry}
            </Button>
          }>
          {main.error}
          {shown && COPY.stale}
        </InlineNotice>
      )}
      {!shown && !main.error && <UsageSkeleton />}
      {shown && totals && (
        <div className="usage-shown" aria-busy={main.stale}>
          <div className="usage-total">
            <p className="usage-total-tokens">
              <strong title={totals.tokens === undefined ? undefined : exactTokens(totals.tokens)}>
                {totals.tokens === undefined ? (nothing ? '0' : notReported()) : formatTokens(totals.tokens)}
              </strong>
              <span>tokens</span>
            </p>
            <p className="usage-total-facts">
              {totals.turns > 0 && <span>{COPY.turns(totals.turns)}</span>}
              {(totals.requests > 0 || totals.turns === 0) && <span>{COPY.requests(totals.requests)}</span>}
              {totals.tokens !== undefined && (
                <span title={COPY.tokensDetail(exactTokens(totals.inputTokens), exactTokens(totals.outputTokens))}>
                  {COPY.tokenSplit(formatTokens(totals.inputTokens), formatTokens(totals.outputTokens))}
                </span>
              )}
              {hit !== undefined && <span>{COPY.hitRate(percent(hit / 100))}</span>}
              {cost && (
                // What the estimate is worked out from, on a tap as well as a hover: nothing more is written on the line.
                <Popover
                  label={COPY.estimateBasis}
                  size="sm"
                  trigger={props => (
                    <button {...props} type="button" className="usage-total-cost">
                      <Badge>{COPY.estimate}</Badge>
                      {cost}
                    </button>
                  )}>
                  <ul className="usage-cost-basis">
                    {[...(costNote(totals.cost)?.split(' · ') ?? []), unpriced > 0 ? COPY.unpriced(formatNumber(unpriced)) : '']
                      .filter(Boolean)
                      .map(line => (
                        <li key={line}>{line}</li>
                      ))}
                  </ul>
                </Popover>
              )}
            </p>
          </div>
          {nothing ? (
            <p className="usage-empty">{COPY.empty}</p>
          ) : (
            <>
              <Panel title={shown.period === '1' ? COPY.hourly : COPY.daily} aside={<ChartLegend series={tokenKinds()} />}>
                <BarChart
                  label={shown.period === '1' ? COPY.hourly : COPY.daily}
                  series={tokenKinds()}
                  columns={columns}
                  format={tokens}
                  // A day's sessions come grouped by session, which a service's own view cannot narrow to it.
                  {...(scope ? {} : { selected: day, onSelect: setDay })}
                />
                {day !== undefined && (
                  <div className="usage-day" aria-label={COPY.periodSessions}>
                    <header className="usage-panel-head">
                      <h4>{columns.find(column => column.key === day)?.title}</h4>
                      <Button size="sm" variant="ghost" onClick={() => setDay(undefined)}>
                        {COPY.collapse}
                      </Button>
                    </header>
                    {daily.error && <p className="usage-muted">{daily.error}</p>}
                    {!dayRows && !daily.error && <Skeleton width="100%" height={56} />}
                    {dayRows && dayRows.length === 0 && <p className="usage-muted">{COPY.noUsage}</p>}
                    {dayRows && dayRows.length > 0 && (
                      <BarRows
                        label={COPY.periodSessions}
                        series={[COPY.input, COPY.output]}
                        from={1}
                        format={tokens}
                        rows={sessionsOf(dayRows)
                          .slice(0, 8)
                          .map(session => {
                            const { name } = usageRowName({ ...session.row, sessionId: session.sessionId }, 'session', snapshot)
                            const uses = [
                              session.turns ? COPY.turns(session.turns) : '',
                              session.requests ? COPY.requests(session.requests) : '',
                            ]
                            return {
                              key: session.sessionId ?? 'other',
                              name,
                              label: name,
                              values: [session.input, session.output],
                              figure: [session.measured ? formatTokens(session.input + session.output) : notReported(), ...uses]
                                .filter(Boolean)
                                .join(' · '),
                            }
                          })}
                      />
                    )}
                  </div>
                )}
              </Panel>
              <div className="usage-pair">
                <Panel
                  title={COPY.cacheHit}
                  aside={
                    harnessIds.length > 1 ? (
                      <ValuePicker
                        label="Harness"
                        value={cacheHarness && harnessIds.includes(cacheHarness) ? cacheHarness : ''}
                        options={[
                          { value: '', label: COPY.allHarnesses },
                          ...harnessIds.map(id => ({ value: id, label: harnessName(harness(id)) })),
                        ]}
                        onValueChange={setCacheHarness}
                        menuChevron
                        width="xs"
                        size="sm"
                      />
                    ) : undefined
                  }>
                  <LineChart
                    label={COPY.cacheHit}
                    points={cachePoints(shown.buckets, cacheOf, shown.period, shown.timeZone)}
                    format={percent}
                    max={1}
                    {...(day !== undefined ? { active: day } : {})}
                  />
                </Panel>
                {!scope && (
                  <Panel title={COPY.times}>
                    <HeatGrid label={COPY.times} values={shown.hours} format={value => COPY.count(value)} />
                  </Panel>
                )}
              </div>
              {!scope && (
                <div className="usage-pair">
                  <Panel title={COPY.source}>
                    <SourceShare points={points} />
                  </Panel>
                  <Panel title={COPY.project}>
                    <ShareBar label={COPY.project} parts={projectParts(shown.projects ?? [], snapshot)} format={tokens} />
                  </Panel>
                </div>
              )}
              {!scope && <Compare compare={shown.compare ?? []} snapshot={snapshot} />}
            </>
          )}
          {budgets.length > 0 && spending.spend && (
            <section className="usage-budgets" aria-label={COPY.monthlyBudget}>
              <h3>{COPY.monthlyBudget}</h3>
              {budgets.map(budget => (
                <LimitWindow
                  key={`${budget.scope}:${budget.id}`}
                  view={budgetLimit(budget, budgetName(budget, snapshot), spending.spend!.month)}
                  detail={`${budgetProgressText(budget)}${budget.uncounted ? ` · ${COPY.uncounted(budget.uncounted)}` : ''}`}
                />
              ))}
            </section>
          )}
          {!nothing && (
            <Panel
              title={COPY.details}
              aside={
                !scope && (
                  <ValuePicker
                    label={COPY.group}
                    value={group}
                    options={GROUPS}
                    onValueChange={setGroup}
                    menuChevron
                    width="xs"
                    size="sm"
                  />
                )
              }>
              {rows && rows.length > 0 && <UsageTable rows={tableRows ?? []} group={shown.group} snapshot={snapshot} scoped={!!scope} />}
              {shown.skipped > 0 && <p className="usage-muted">{COPY.omitted(shown.skipped)}</p>}
              {shown.truncated && <p className="usage-muted">{COPY.tooMany}</p>}
            </Panel>
          )}
        </div>
      )}
    </div>
  )
}

/** A day's rows by session, the gateway's requests and the own-login turns of one session together, largest first. */
function sessionsOf(rows: readonly AnyRow[]) {
  const sessions = new Map<
    string,
    { sessionId?: string; row: AnyRow; turns: number; requests: number; measured: number; input: number; output: number }
  >()
  for (const row of rows) {
    const key = row.sessionId ?? ''
    let session = sessions.get(key)
    if (!session)
      sessions.set(
        key,
        (session = {
          ...(row.sessionId ? { sessionId: row.sessionId } : {}),
          row,
          turns: 0,
          requests: 0,
          measured: 0,
          input: 0,
          output: 0,
        }),
      )
    session.turns += row.turns ?? 0
    session.requests += row.requests
    session.measured += row.measured
    session.input += row.usage?.inputTokens ?? 0
    session.output += row.usage?.outputTokens ?? 0
  }
  return [...sessions.values()].toSorted((a, b) => b.input + b.output - (a.input + a.output))
}

function budgetName(budget: { scope: 'service' | 'agent'; id: string }, snapshot: AppSnapshot): string {
  if (budget.scope === 'service') return snapshot.catalog?.providers.find(item => item.id === budget.id)?.name ?? budget.id
  return usageRowName({ agentId: budget.id } as AnyRow, 'agent', snapshot).name
}

function SourceShare({ points }: { points: UsageSeries['series'] }) {
  const split = sourceSplit(points)
  return (
    <ShareBar
      label={COPY.source}
      format={tokens}
      parts={[
        { key: 'gateway', name: SOURCE_NAMES.gateway, label: SOURCE_NAMES.gateway, value: split.gateway, series: 0 },
        { key: 'own', name: SOURCE_NAMES.own, label: SOURCE_NAMES.own, value: split.own, series: 1 },
        // Only once a plugin's provider was used: most Hosts never have one.
        ...(split.plugin > 0
          ? [{ key: 'plugin', name: SOURCE_NAMES.plugin, label: SOURCE_NAMES.plugin, value: split.plugin, series: 2 }]
          : []),
      ]}
    />
  )
}

/** The three largest projects, and everything else together. */
function projectParts(projects: UsageSummary['projects'], snapshot: AppSnapshot): SharePart[] {
  const named = projects.filter(project => project.projectId && project.tokens > 0)
  const top = named.slice(0, 3)
  const rest = projects.filter(project => !top.includes(project)).reduce((sum, project) => sum + project.tokens, 0)
  return [
    ...top.map(project => {
      const name = projectName(snapshot, project.projectId)
      return { key: project.projectId!, name, label: name, value: project.tokens }
    }),
    ...(rest > 0 || top.length === 0 ? [{ key: 'rest', name: COPY.other, label: COPY.other, value: rest, series: 'rest' as const }] : []),
  ]
}

/** The same model on different Harnesses: tokens a turn, input and output, on one scale. */
function Compare({ compare, snapshot }: { compare: UsageSummary['compare']; snapshot: AppSnapshot }) {
  const models = comparedModels(compare).slice(0, 4)
  return (
    <Panel title={COPY.modelComparison} aside={models.length > 0 ? <ChartLegend series={[COPY.input, COPY.output]} from={1} /> : undefined}>
      {models.length === 0 ? (
        <p className="usage-muted">{COPY.noComparison}</p>
      ) : (
        <div className="usage-compare">
          {models.map(({ model, rows }) => (
            <div key={model} className="usage-compare-model">
              <h4>{model}</h4>
              <BarRows
                label={model}
                series={[COPY.inputPerTurn, COPY.outputPerTurn]}
                from={1}
                format={tokens}
                rows={rows.map(row => {
                  const harness = harnessOf(snapshot, row.harness)
                  const input = Math.round(row.inputTokens / row.measured)
                  const output = Math.round(row.outputTokens / row.measured)
                  return {
                    key: row.harness,
                    name: harnessName(harness),
                    label: (
                      <>
                        <HarnessTile harness={harness} size={16} />
                        {harnessName(harness)}
                      </>
                    ),
                    values: [input, output],
                    figure: COPY.perTurn(formatTokens(input + output), COPY.turns(row.measured)),
                  }
                })}
              />
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

function UsageTable({ rows, group, snapshot, scoped }: { rows: AnyRow[]; group: UsageGroup; snapshot: AppSnapshot; scoped: boolean }) {
  return (
    <table className="usage-rows" aria-label={COPY.usage}>
      <thead>
        <tr>
          <th scope="col">{COPY.groupName[group]}</th>
          <th scope="col">{COPY.uses}</th>
          <th scope="col">tokens</th>
          <th scope="col">{COPY.estimate}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => {
          const sources = new Set(rows.flatMap(item => (item.split ? Object.keys(item.split) : [item.by ?? 'gateway'])))
          const { name, detail, harness } = usageRowName(row, group, snapshot)
          const tokenCount = row.usage ? row.usage.inputTokens + row.usage.outputTokens : undefined
          const split = row.split && Object.keys(row.split).length > 1 ? row.split : undefined
          const source =
            !split && sources.size > 1 && group !== 'service' && group !== 'model' ? SOURCE_NAMES[row.by ?? 'gateway'] : undefined
          const notes = [
            scoped ? undefined : detail,
            source,
            row.failed ? COPY.failed(formatNumber(row.failed)) : undefined,
            row.fallbacks ? COPY.fallbacks(formatNumber(row.fallbacks)) : undefined,
          ].filter(Boolean)
          const turns = row.turns ?? 0
          const uses = [turns ? COPY.turns(turns) : '', row.requests || !turns ? COPY.count(row.requests) : ''].filter(Boolean).join(' · ')
          return (
            <tr key={index} title={usageRowDetail(row) || undefined}>
              <th scope="row">
                <span className="usage-row-name">
                  {harness && <HarnessTile harness={harnessOf(snapshot, harness)} size={16} />}
                  {name}
                </span>
                {notes.length > 0 && <small>{notes.join(' · ')}</small>}
                {split && (
                  <SourceSplit
                    className="usage-row-split"
                    format={formatTokens}
                    parts={USAGE_SOURCES.flatMap((by, series) =>
                      split[by] === undefined ? [] : [{ name: SOURCE_NAMES[by], value: split[by], series }],
                    )}
                  />
                )}
              </th>
              <td>{uses}</td>
              <td title={tokenCount === undefined ? undefined : exactTokens(tokenCount)}>
                {tokenCount === undefined ? notReported() : formatTokens(tokenCount)}
              </td>
              <td>{costsText(row.cost) ?? '—'}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
