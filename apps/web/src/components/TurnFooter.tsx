import type { ReactNode } from 'react'
import { GitFork, RotateCcw } from 'lucide-react'
import { modelIdKey, type RoutedModel } from '@latch/protocol'
import { turnRoute, turnText, turnTimes, turnTimeTip, turnUsage, type Turn, type TurnOutcome, type TurnRoute } from '../conversation.ts'
import { formatDuration, formatTokens, tokenAmount, tokenParts } from '../format.ts'
import { TimeLabel } from './MessageRow.tsx'
import { Menu } from './overlays.tsx'
import { budgetWords, turnCostWords } from '../settings/modelSpend.ts'
import { Button, Icon, IconButton, Tooltip, Popover, StatusWord, InfoGlyph, CopyButton, CopyGlyph, EnterGlyph, MoreGlyph } from '@latch/ui'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    throughGateway: (count: number) => `经 Latch 网关 ${formatNumber(count)} 次请求`,
    modelRequests: (value1: string, count: number) => `${value1}：${formatNumber(count)} 次`,
    incomplete: (count: number) => `${formatNumber(count)} 次没有完成`,
    stillRunning: (count: number) => `${formatNumber(count)} 次在这一轮结束时还在进行`,
    fallback: (count: number) => `${formatNumber(count)} 次由备选回答`,
    used: (value1: string | number) => `服务说用的是 ${value1}`,
    source: '由模型服务在回复里报告，Latch 转发时读取',
    unmeasured: (count: number) => `另有 ${formatNumber(count)} 次回复没有报告用量，没有计入`,
    open: (count: number) => `另有 ${formatNumber(count)} 次请求在这一轮结束时还在进行，没有计入`,
    gatewayRequests: (count: number) => `这一轮经 Latch 网关 ${formatNumber(count)} 次请求`,
    adjusted: '思考档位：已按服务声明调整',
    input: (value1: string | number) => `输入 ${value1}`,
    output: (value1: string | number) => `输出 ${value1}`,
    partial: '用量不完整',
    requests: '请求记录',
    context: '上下文 ',
    copy: '复制',
    retry: '重试',
    fork: '从这里分叉',
    actions: '这一轮的操作',
    handoff: '交给代码任务…',
    transcript: '复制到这里为止的记录',
    moreActions: '这一轮的更多操作',
  },
  {
    throughGateway: (count: number) =>
      plural(count, { one: '{n} request through the Latch gateway', other: '{n} requests through the Latch gateway' }),
    modelRequests: (value1: string, count: number) => `${value1}: ${plural(count, { one: '{n} request', other: '{n} requests' })}`,
    incomplete: (count: number) => `${formatNumber(count)} incomplete`,
    stillRunning: (count: number) => `${formatNumber(count)} still running at the end of this turn`,
    fallback: (count: number) => `${formatNumber(count)} answered by the fallback`,
    used: (value1: string | number) => `The service reported using ${value1}`,
    source: 'Reported by the model service as Latch forwarded its replies',
    unmeasured: (count: number) => `${formatNumber(count)} other replies didn’t report usage and aren’t counted`,
    open: (count: number) => `${formatNumber(count)} other requests were still running at the end of this turn and aren’t counted`,
    gatewayRequests: (count: number) =>
      `${plural(count, { one: '{n} request', other: '{n} requests' })} through the Latch gateway this turn`,
    adjusted: 'Thinking level adjusted to the service’s supported levels',
    input: (value1: string | number) => `Input ${value1}`,
    output: (value1: string | number) => `Output ${value1}`,
    partial: 'Incomplete usage',
    requests: 'Request log',
    context: 'Context ',
    copy: 'Copy',
    retry: 'Retry',
    fork: 'Fork from here',
    actions: 'Turn actions',
    handoff: 'Hand off to a coding task…',
    transcript: 'Copy transcript up to here',
    moreActions: 'More turn actions',
  },
)

/** A fact of the footer with its details in a tooltip; it takes keyboard focus so the details are reachable. */
function Fact({ tip, className, children }: { tip?: ReactNode; className?: string; children: ReactNode }) {
  if (!tip) return <span className={className ? `turn-fact ${className}` : 'turn-fact'}>{children}</span>
  return (
    <Tooltip content={tip}>
      <span className={className ? `turn-fact ${className}` : 'turn-fact'} tabIndex={0}>
        {children}
      </span>
    </Tooltip>
  )
}

/** Lines of a tooltip, one under another. */
const Lines = ({ lines }: { lines: string[] }) => (
  <span className="turn-tip-lines">
    {lines.map((line, index) => (
      <span key={index}>{line}</span>
    ))}
  </span>
)

/** 「fake-model：3 次，1 次没有完成，服务说用的是 fake-model-2 · 输入 30 · 输出 15」 */
function modelLine(entry: RoutedModel): string {
  const parts = [COPY.modelRequests(entry.model, entry.requests)]
  if (entry.failed) parts.push(COPY.incomplete(entry.failed))
  if (entry.open) parts.push(COPY.stillRunning(entry.open))
  if (entry.fallback) parts.push(COPY.fallback(entry.fallback))
  if (entry.used && modelIdKey(entry.used) !== modelIdKey(entry.model)) parts.push(COPY.used(entry.used))
  return parts.join('，') + (entry.usage ? ` · ${tokenParts(entry.usage).join(' · ')}` : '')
}

/** Where the tokens of a turn through Latch come from, and what they leave out. */
function routedSource(route: TurnRoute): string[] {
  return [COPY.source, ...(route.unmeasured ? [COPY.unmeasured(route.unmeasured)] : []), ...(route.open ? [COPY.open(route.open)] : [])]
}

/**
 * The settled turn's facts: when the reply was sent (its tooltip says when the turn began and ended), how long it worked
 * and its tokens. A turn through Latch has the tokens the service's replies reported, with its requests by model one
 * press away; with no tokens to show, the requests are a fact of their own. How it ended, when it did not simply finish,
 * has its own line that stays. Each is a segment of its own, so the dots between them are spaced alike.
 */
function SettledFacts({
  turn,
  outcome,
  context,
  worked,
  person,
}: {
  turn: Turn
  outcome: TurnOutcome
  context?: number
  worked: boolean
  /** A helper's turn: when and how long only; tokens, requests and the context are the model's, kept to 额度与用量. */
  person: boolean
}) {
  const times = turnTimes(turn)
  // The built-in harness's turns went through no gateway: their record only says which service answered.
  const routed = person ? undefined : turnRoute(turn)
  const route = routed?.direct ? undefined : routed
  // Steps the harness reported come first; a turn through Latch without them has the tokens its replies reported.
  const stepUsage = person ? undefined : turnUsage(turn)
  const usage = person ? undefined : (stepUsage ?? route?.usage)
  const routedUsage = !stepUsage && route?.usage ? route : undefined
  const requests = route
    ? [COPY.gatewayRequests(route.requests), ...route.models.map(modelLine), ...(route.thinkingAdjusted ? [COPY.adjusted] : [])]
    : []
  const incomplete = routedUsage && (routedUsage.unmeasured > 0 || routedUsage.open > 0)
  const spent = outcome === 'interrupted' || times.activeMs === undefined ? undefined : formatDuration(times.activeMs)
  // What the Host knows the turn's model requests cost, and a monthly budget of theirs at 80% or used up.
  const spend = person ? undefined : (turn.user?.turn?.routed?.spend ?? turn.user?.turn?.spend)
  const cost = turnCostWords(spend)
  const budget = budgetWords(spend?.budget)
  return (
    <>
      {times.sentAt !== undefined && (
        <span className="turn-fact">
          <TimeLabel at={times.sentAt} tip={now => turnTimeTip(times, outcome, now)} />
        </span>
      )}
      {/* A phone leaves out how long it worked when the fold above says it. */}
      {spent && <span className={worked ? 'turn-fact turn-fact-worked' : 'turn-fact'}>{spent}</span>}
      {/* A phone drops the unit, which 输入 and 输出 already imply, so the pair fits beside the buttons. */}
      {usage && (
        <Fact>
          {COPY.input(formatTokens(usage.inputTokens))}
          <span className="turn-fact-unit"> tokens</span>
        </Fact>
      )}
      {usage && (
        <Fact className="turn-fact-last">
          {COPY.output(formatTokens(usage.outputTokens))}
          <span className="turn-fact-unit"> tokens</span>
        </Fact>
      )}
      {cost && <Fact tip={cost.note}>{cost.text}</Fact>}
      {budget && (
        <span className="turn-fact">
          <StatusWord tone={budget.tone}>{budget.text}</StatusWord>
        </span>
      )}
      {/* What stands behind a number is its hover, never something to press. */}
      {incomplete && (
        <Fact tip={<Lines lines={[...routedSource(routedUsage), ...requests]} />}>
          <Icon icon={InfoGlyph} size={12} />
          {COPY.partial}
        </Fact>
      )}
      {routedUsage && !incomplete && (
        <Tooltip content={<Lines lines={requests} />}>
          <span className="turn-fact turn-fact-more" tabIndex={0} role="img" aria-label={COPY.requests}>
            <Icon icon={InfoGlyph} size={12} />
          </span>
        </Tooltip>
      )}
      {route && !routedUsage && <Fact tip={<Lines lines={requests} />}>{COPY.throughGateway(route.requests)}</Fact>}
      {!usage && !person && context !== undefined && (
        <Fact>
          {COPY.context}
          {tokenAmount(context)}
        </Fact>
      )}
    </>
  )
}

export interface TurnRetry {
  /** The confirmation shown first when the turn may have changed something; resends at once without it. */
  warning?: string
  onResend: () => void
}

/**
 * A turn's footer, after its last row: live prose can be copied; settled turns also show facts, retry and fork. It rests
 * hidden on desktop and fades in while the pointer or focus is in the turn, and stays on the newest turn of a touch
 * screen or after a tap on the turn. Copy takes the whole turn's prose; 重试 sends the same prompt again as a new turn
 * and never replays a tool.
 */
export function TurnFooter({
  turn,
  live = false,
  outcome = 'completed',
  pinned = false,
  context,
  worked = false,
  person = false,
  onRetry,
  actions,
}: {
  turn: Turn
  live?: boolean
  outcome?: TurnOutcome
  /** A helper's turn: no tokens. */
  person?: boolean
  /** The turn shows its 「已工作 …」 fold, which says how long it worked. */
  worked?: boolean
  /** Always visible: the newest turn on a touch screen, or one the person tapped. */
  pinned?: boolean
  /** The context an agent last reported, for the newest turn of a session without per-turn tokens. */
  context?: number
  onRetry?: () => void
  actions?: { onFork?: () => void; onCopy: () => void; onHandoff?: () => void }
}) {
  const text = turnText(turn)
  if (live && !text) return null
  return (
    <div className="turn-footer" data-pinned={pinned ? '' : undefined}>
      <div className="turn-footer-row">
        {!live && (
          <span className="turn-facts">
            <SettledFacts turn={turn} outcome={outcome} context={context} worked={worked} person={person} />
          </span>
        )}
        {text && <CopyButton text={text} label={COPY.copy} size="xs" />}
        {!live && onRetry && <IconButton icon={RotateCcw} size="xs" label={COPY.retry} className="turn-retry" onClick={onRetry} />}
        {!live && actions?.onFork && <IconButton icon={GitFork} size="xs" label={COPY.fork} onClick={actions.onFork} />}
        {!live && actions && (
          <Menu
            label={COPY.actions}
            placement="top-end"
            sections={[
              {
                id: 'turn-actions',
                items: [
                  ...(actions.onHandoff
                    ? [{ id: 'handoff', label: COPY.handoff, leading: <EnterGlyph size={14} />, onSelect: actions.onHandoff }]
                    : []),
                  { id: 'copy-history', label: COPY.transcript, leading: <CopyGlyph size={14} />, onSelect: actions.onCopy },
                ],
              },
            ]}
            trigger={props => <IconButton {...props} icon={MoreGlyph} size="xs" label={COPY.moreActions} data-turn-actions="" />}
          />
        )}
      </div>
    </div>
  )
}
