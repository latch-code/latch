import { Fragment, useEffect, useState } from 'react'
import {
  GENERAL_AGENT_ID,
  type AppSnapshot,
  type BudgetProgress,
  type HarnessInfo,
  type ModelUsageSummary,
  type UsageGroup,
  type UsagePeriod,
} from '@latch/protocol'
import { Badge, Button, Dialog, InlineNotice, SegmentedControl, Skeleton, ValuePicker } from '@latch/ui'
import { HarnessTile } from '../components/BrandTile.tsx'
import { harnessName } from '../composerChoice.ts'
import { api, errorMessage } from '../core/api.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { hostView, type DeviceAccess } from '../core/permissions.ts'
import { exactTokens, formatTokens } from '../format.ts'
import { useModelSpend } from '../settings/ModelSpend.tsx'
import { budgetProgressText, costsText, NOT_REPORTED, pricedNote } from '../settings/modelSpend.ts'
import { LimitWindow } from './LimitWindow.tsx'
import { budgetLimit, harnessLimits, LIMIT_WORDS, type HarnessLimits } from './limits.ts'
import { closeUsage, openUsage, useUsageRequest, type UsageRequest, type UsageView } from './surface.ts'
import { unpricedShare, usageRowDetail, usageRowName, usageTotals } from './usage.ts'

const VIEWS: ReadonlyArray<{ value: UsageView; label: string }> = [
  { value: 'limits', label: '额度' },
  { value: 'usage', label: '用量' },
]
const PERIODS: Array<{ value: UsagePeriod; label: string }> = [
  { value: 'month', label: '本月' },
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
]
const GROUPS: Array<{ value: UsageGroup; label: string }> = [
  { value: 'service', label: '按服务' },
  { value: 'model', label: '按模型' },
  { value: 'agent', label: '按 Agent' },
  { value: 'session', label: '按会话' },
]

const chosen: { period: UsagePeriod; group: UsageGroup } = { period: 'month', group: 'service' }

/** Who is asking: Host, device, data scope and scopes. */
function audienceOf(snapshot: AppSnapshot, access: DeviceAccess): string {
  return JSON.stringify([
    hostView(snapshot)?.hostId,
    snapshot.instanceId,
    snapshot.device.id,
    snapshot.device.dataScope,
    [...access.scopes].toSorted(),
  ])
}

/**
 * The Harnesses the 额度 view lists: those that run on their own login (a subscription can have limits), and any that
 * reported limits; the ones with limits first.
 */
function limitHarnesses(harnesses: readonly HarnessInfo[], now: number): Array<{ harness: HarnessInfo; limits?: HarnessLimits }> {
  return harnesses
    .filter(harness => harness.quota || (harness.capabilities.models.owner === 'harness' && harness.status === 'ready'))
    .map(harness => {
      const limits = harnessLimits(harness.quota, now)
      return limits ? { harness, limits } : { harness }
    })
    .toSorted((a, b) => Number(!a.limits) - Number(!b.limits))
}

/**
 * 额度与用量: one surface for a Harness's subscription limits and for what model requests through Latch used. Opened by
 * click from the composer's chip (scoped to that Harness or service), from the global entry and by its shortcut; a
 * dialog of a fixed size on a wide window and a sheet on a phone. Mounted once by the shell.
 */
export function UsageSurface({ snapshot, access, offline }: { snapshot: AppSnapshot; access: DeviceAccess; offline: boolean }) {
  const request = useUsageRequest()
  // What it last showed stays while it fades out, so a closing surface does not empty first.
  const [shown, setShown] = useState(request)
  if (request && request !== shown) setShown(request)
  // A new audience starts the body afresh: nothing read for the last one is shown while the new reads are on their way.
  const audience = audienceOf(snapshot, access)
  const viewing = access.scopes.has('view')
  // A device that may no longer view has nothing here: the surface closes rather than waiting to come back.
  useEffect(() => {
    if (!viewing) closeUsage()
  }, [viewing])
  if (!viewing) return null
  return (
    <Dialog open={request !== null} onClose={closeUsage} title="额度与用量" size="lg" className="usage-surface">
      {shown && <UsageBody key={audience} request={shown} snapshot={snapshot} offline={offline} />}
    </Dialog>
  )
}

function UsageBody({ request, snapshot, offline }: { request: UsageRequest; snapshot: AppSnapshot; offline: boolean }) {
  const usageOffered = snapshot.catalog?.features?.modelUsage === true
  const view: UsageView = usageOffered ? request.view : 'limits'
  // Opened on one Harness or one service, the way back to all of them stands beside the views.
  const back =
    view === 'limits' && request.harnessId
      ? { label: '全部 Harness', request: { view: 'limits' } as const }
      : view === 'usage' && request.providerId
        ? { label: '全部服务', request: { view: 'usage' } as const }
        : undefined
  return (
    <div className="usage-body" data-view={view}>
      <div className="usage-views">
        {usageOffered && (
          <SegmentedControl
            label="视图"
            value={view}
            options={VIEWS}
            onValueChange={next => {
              openUsage({ view: next })
            }}
          />
        )}
        {back && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              openUsage(back.request)
            }}>
            {back.label}
          </Button>
        )}
      </div>
      {view === 'limits' ? (
        <LimitsView request={request} harnesses={snapshot.catalog?.harnesses ?? []} offline={offline} />
      ) : (
        <UsageView request={request} snapshot={snapshot} />
      )}
    </div>
  )
}

function LimitsView({ request, harnesses, offline }: { request: UsageRequest; harnesses: readonly HarnessInfo[]; offline: boolean }) {
  useTicker('minute')
  // A window past its reset is gone at once, not at the next minute.
  const [, expire] = useState(0)
  const now = hostNow()
  const nextReset = Math.min(
    ...harnesses.flatMap(
      harness =>
        harness.quota?.windows.flatMap(window => {
          const at = Date.parse(window.resetsAt ?? '')
          return at > now && at <= now + 61_000 ? [at] : []
        }) ?? [],
    ),
  )
  useEffect(() => {
    if (!Number.isFinite(nextReset)) return undefined
    const timer = setTimeout(() => expire(version => version + 1), Math.max(0, nextReset - hostNow()) + 1)
    return () => clearTimeout(timer)
  }, [nextReset])
  const all = limitHarnesses(harnesses, now)
  const scoped = request.harnessId ? all.filter(item => item.harness.id === request.harnessId) : all
  return (
    <div className="usage-limits">
      {offline && <p className="usage-muted">连接中断，显示上次收到的额度</p>}
      {scoped.length === 0 && <p className="usage-muted">没有用自己登录的 Harness</p>}
      {scoped.map(({ harness, limits }) => (
        <section className="usage-harness" key={harness.id} aria-label={harnessName(harness)}>
          <header className="usage-harness-head">
            <HarnessTile harness={harness} size={20} />
            <h3>{harnessName(harness)}</h3>
            {limits && limits.facts.length > 0 && <span className="usage-facts">{limits.facts.join(' · ')}</span>}
          </header>
          {limits ? (
            <div className="usage-windows">
              {limits.account && (
                <p className="usage-account" data-state="limited">
                  额度{LIMIT_WORDS.limited}
                </p>
              )}
              {limits.windows.map((window, index) => (
                <Fragment key={window.key}>
                  {window.group && window.group !== limits.windows[index - 1]?.group && <p className="usage-group">{window.group}</p>}
                  <LimitWindow view={window} />
                </Fragment>
              ))}
            </div>
          ) : (
            <p className="usage-muted">尚未报告额度</p>
          )}
        </section>
      ))}
    </div>
  )
}

function budgetName(budget: BudgetProgress, snapshot: AppSnapshot): string {
  if (budget.scope === 'service') return snapshot.catalog?.providers.find(item => item.id === budget.id)?.name ?? budget.id
  if (budget.id === GENERAL_AGENT_ID) return '通用'
  return snapshot.customAgents?.find(agent => agent.id === budget.id)?.name ?? budget.id
}

/** Rows of the skeleton: the same boxes as the total, the budgets and the rows that replace them, so nothing moves. */
function UsageSkeleton() {
  return (
    <div className="usage-skeleton" aria-hidden="true">
      <div className="usage-total">
        <Skeleton width={120} height={28} />
        <Skeleton width={200} height={16} />
      </div>
      <table className="usage-rows">
        <tbody>
          {[0, 1, 2].map(row => (
            <tr key={row}>
              <th scope="row">
                <Skeleton width="60%" height={16} />
              </th>
              <td>
                <Skeleton width={24} height={16} />
              </td>
              <td>
                <Skeleton width={40} height={16} />
              </td>
              <td>
                <Skeleton width={48} height={16} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function UsageView({ request, snapshot }: { request: UsageRequest; snapshot: AppSnapshot }) {
  // The period and grouping last chosen stay chosen while the page lives, across a new audience or a reopening.
  const [period, choosePeriod] = useState<UsagePeriod>(chosen.period)
  const [chosenGroup, chooseGroup] = useState<UsageGroup>(chosen.group)
  const setPeriod = (next: UsagePeriod) => {
    chosen.period = next
    choosePeriod(next)
  }
  const setGroup = (next: UsageGroup) => {
    chosen.group = next
    chooseGroup(next)
  }
  // One service's use (a session on it asked): its models, and its own budget.
  const scope = request.providerId
  const group: UsageGroup = scope ? 'model' : chosenGroup
  const query = `${period}:${group}`
  const [summaries, setSummaries] = useState(() => new Map<string, ModelUsageSummary>())
  const [failure, setFailure] = useState<{ query: string; text: string }>()
  const [turn, setTurn] = useState(0)
  const spending = useModelSpend(true, snapshot.revision)
  useEffect(() => {
    const controller = new AbortController()
    void api<ModelUsageSummary>('model-usage', { method: 'POST', body: { period, group }, signal: controller.signal }).then(
      result => {
        if (controller.signal.aborted) return
        if (result.period !== period || result.group !== group) {
          setFailure({ query, text: '收到的用量与所选期间不符。' })
          return
        }
        setSummaries(previous => new Map(previous).set(query, result))
        setFailure(undefined)
      },
      cause => {
        if (!controller.signal.aborted) setFailure({ query, text: errorMessage(cause) })
      },
    )
    return () => {
      controller.abort()
    }
  }, [period, group, query, turn])
  const shown = summaries.get(query)
  const rows = shown ? (scope ? shown.rows.filter(row => row.providerId === scope) : shown.rows) : undefined
  const totals = rows ? usageTotals(rows) : undefined
  const cost = costsText(totals?.cost)
  const unpriced = rows ? unpricedShare(rows) : 0
  const spend = spending.spend
  const budgets = (spend?.budgets ?? []).filter(budget => !scope || (budget.scope === 'service' && budget.id === scope))
  const serviceName = scope ? (snapshot.catalog?.providers.find(item => item.id === scope)?.name ?? scope) : undefined
  const error = failure?.query === query ? failure.text : undefined
  return (
    <div className="usage-usage">
      <div className="usage-controls">
        <ValuePicker label="统计期间" value={period} options={PERIODS} onValueChange={setPeriod} menuChevron width="xs" />
        {scope ? (
          <span className="usage-scope-name">{serviceName}</span>
        ) : (
          <ValuePicker label="分组" value={group} options={GROUPS} onValueChange={setGroup} menuChevron width="xs" />
        )}
      </div>
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
      {!rows && !error && <UsageSkeleton />}
      {rows && totals && rows.length > 0 && (
        <div className="usage-total">
          <p className="usage-total-tokens">
            <strong>{totals.tokens === undefined ? NOT_REPORTED : formatTokens(totals.tokens)}</strong>
            {totals.tokens !== undefined && ' tokens'}
            <span className="usage-muted"> · {totals.requests} 次请求</span>
          </p>
          <p className="usage-total-cost">
            <Badge>估算</Badge>
            <span>{cost ?? NOT_REPORTED}</span>
            <span className="usage-muted">
              {cost ? (pricedNote(totals.cost) ?? '按服务报告') : ''}
              {unpriced > 0 ? `${cost ? ' · ' : ''}${unpriced}% 未计价` : ''}
            </span>
          </p>
        </div>
      )}
      {budgets.length > 0 && spend && (
        <section className="usage-budgets" aria-label="本月预算">
          <h3>本月预算</h3>
          {budgets.map(budget => (
            <LimitWindow
              key={`${budget.scope}:${budget.id}`}
              view={budgetLimit(budget, budgetName(budget, snapshot), spend.month)}
              detail={`${budgetProgressText(budget)}${budget.uncounted ? ` · 未计入 ${budget.uncounted} 次` : ''}`}
            />
          ))}
        </section>
      )}
      {rows && rows.length === 0 && <p className="usage-muted">这个期间还没有经 Latch 的请求</p>}
      {rows && rows.length > 0 && (
        <>
          <table className="usage-rows" aria-label="用量">
            <thead>
              <tr>
                <th scope="col">{GROUPS.find(item => item.value === group)!.label.replace(/^按 ?/u, '')}</th>
                <th scope="col">请求</th>
                <th scope="col">tokens</th>
                <th scope="col">估算</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const { name, detail } = usageRowName(row, group, snapshot)
                const notes = [
                  scope ? undefined : detail,
                  row.failed ? `失败 ${row.failed}` : undefined,
                  row.fallbacks ? `备选 ${row.fallbacks}` : undefined,
                ].filter(Boolean)
                const tokens = row.usage ? row.usage.inputTokens + row.usage.outputTokens : undefined
                return (
                  <tr key={index} title={usageRowDetail(row) || undefined}>
                    <th scope="row">
                      <span>{name}</span>
                      {notes.length > 0 && <small>{notes.join(' · ')}</small>}
                    </th>
                    <td>{row.requests}</td>
                    <td title={tokens === undefined ? undefined : exactTokens(tokens)}>
                      {tokens === undefined ? NOT_REPORTED : formatTokens(tokens)}
                    </td>
                    <td>{costsText(row.cost) ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {shown && shown.skipped > 0 && <p className="usage-muted">有 {shown.skipped} 行记录读不出，没有计入</p>}
          {shown?.truncated && <p className="usage-muted">这个期间的请求太多，只算了读到的部分</p>}
        </>
      )}
      <p className="usage-foot usage-muted">只算经 Latch 的模型请求</p>
    </div>
  )
}
