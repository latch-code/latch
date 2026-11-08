import { useContext, type ReactNode } from 'react'
import { Copy, Ellipsis, GitCompare, GitFork, RotateCcw } from 'lucide-react'
import { modelIdKey, type RoutedModel } from '@latch/protocol'
import { turnRoute, turnText, turnTimes, turnTimeTip, turnUsage, type Turn, type TurnOutcome, type TurnRoute } from '../conversation.ts'
import { ChangesLinkContext } from '../conversation/changesLink.ts'
import { exactTokens, formatDuration, formatTokens, tokenAmount, tokenLines, tokenParts } from '../format.ts'
import { TimeLabel } from './MessageRow.tsx'
import { Menu } from './overlays.tsx'
import { IconButton, Tooltip, CopyButton } from '@latch/ui'

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
  const parts = [`${entry.model}：${entry.requests} 次`]
  if (entry.failed) parts.push(`${entry.failed} 次没有完成`)
  if (entry.open) parts.push(`${entry.open} 次在这一轮结束时还在进行`)
  if (entry.used && modelIdKey(entry.used) !== modelIdKey(entry.model)) parts.push(`服务说用的是 ${entry.used}`)
  return parts.join('，') + (entry.usage ? ` · ${tokenParts(entry.usage).join(' · ')}` : '')
}

/** Where the tokens of a turn through Latch come from, and what they leave out. */
function routedSource(route: TurnRoute): string[] {
  return [
    '由模型服务在回复里报告，Latch 转发时读取',
    ...(route.unmeasured ? [`另有 ${route.unmeasured} 次回复没有报告用量，没有计入`] : []),
    ...(route.open ? [`另有 ${route.open} 次请求在这一轮结束时还在进行，没有计入`] : []),
  ]
}

/**
 * The settled turn's facts: when the reply was sent (its tooltip says when the turn began and ended), how long it worked
 * and its tokens. A turn through Latch has the tokens the service's replies reported, with its requests by model in their
 * tooltips; with no tokens to show, the requests are a fact of their own. How it ended, when it did not simply finish,
 * has its own line that stays. Each is a segment of its own, so the dots between them are spaced alike.
 */
function SettledFacts({ turn, outcome, context, worked }: { turn: Turn; outcome: TurnOutcome; context?: number; worked: boolean }) {
  const times = turnTimes(turn)
  const route = turnRoute(turn)
  // Steps the harness reported come first; a turn through Latch without them has the tokens its replies reported.
  const stepUsage = turnUsage(turn)
  const usage = stepUsage ?? route?.usage
  const routedUsage = !stepUsage && route?.usage ? route : undefined
  const requests = route ? [`这一轮经 Latch ${route.requests} 次请求`, ...route.models.map(modelLine)] : []
  const [inputLine, outputLine] = usage ? tokenLines(usage) : []
  const tip = (line: string) => (routedUsage ? <Lines lines={[line, ...routedSource(routedUsage), ...requests]} /> : line)
  const spent = outcome === 'interrupted' || times.activeMs === undefined ? undefined : formatDuration(times.activeMs)
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
        <Fact tip={tip(inputLine!)}>
          {`输入 ${formatTokens(usage.inputTokens)}`}
          <span className="turn-fact-unit"> tokens</span>
        </Fact>
      )}
      {usage && (
        <Fact tip={tip(outputLine!)} className="turn-fact-last">
          {`输出 ${formatTokens(usage.outputTokens)}`}
          <span className="turn-fact-unit"> tokens</span>
        </Fact>
      )}
      {route && !routedUsage && <Fact tip={<Lines lines={requests} />}>经 Latch {route.requests} 次请求</Fact>}
      {!usage && context !== undefined && (
        <Fact tip={`由 Harness 报告：${exactTokens(context)} tokens`}>上下文 {tokenAmount(context)}</Fact>
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
 * A settled turn's footer, after its last row: the facts and 复制, 重试 and 从这里分叉. It overlays the gap under the turn,
 * so it takes no room of its own; it rests hidden on desktop and fades in while the pointer or focus is in the turn, and
 * stays on the newest turn of a touch screen or after a tap on the turn. Copy takes the whole turn's prose; 重试 sends
 * the same prompt again as a new turn and never replays a tool.
 */
export function TurnFooter({
  turn,
  outcome = 'completed',
  pinned = false,
  context,
  worked = false,
  onRetry,
  actions,
}: {
  turn: Turn
  outcome?: TurnOutcome
  /** The turn shows its 「已工作 …」 fold, which says how long it worked. */
  worked?: boolean
  /** Always visible: the newest turn on a touch screen, or one the person tapped. */
  pinned?: boolean
  /** The context an agent last reported, for the newest turn of a session without per-turn tokens. */
  context?: number
  onRetry?: () => void
  actions?: { onFork?: () => void; onCopy: () => void }
}) {
  const text = turnText(turn)
  const changes = useContext(ChangesLinkContext)
  const turnId = turn.user?.turnId
  return (
    <div className="turn-footer" data-pinned={pinned ? '' : undefined}>
      <div className="turn-footer-row">
        <span className="turn-facts">
          <SettledFacts turn={turn} outcome={outcome} context={context} worked={worked} />
        </span>
        {text && <CopyButton text={text} label="复制" size="xs" />}
        {onRetry && <IconButton icon={RotateCcw} size="xs" label="重试" className="turn-retry" onClick={onRetry} />}
        {actions?.onFork && <IconButton icon={GitFork} size="xs" label="从这里分叉" onClick={actions.onFork} />}
        {actions && (
          <Menu
            label="这一轮的操作"
            placement="top-end"
            sections={[
              {
                id: 'turn-actions',
                items: [
                  ...(changes?.turns && turnId
                    ? [
                        {
                          id: 'changes',
                          label: '查看这一轮的改动',
                          leading: <GitCompare size={14} />,
                          onSelect: () => {
                            changes.open({ turnId })
                          },
                        },
                      ]
                    : []),
                  { id: 'copy-history', label: '复制到这里为止的记录', leading: <Copy size={14} />, onSelect: actions.onCopy },
                ],
              },
            ]}
            trigger={props => <IconButton {...props} icon={Ellipsis} size="xs" label="这一轮的更多操作" />}
          />
        )}
      </div>
    </div>
  )
}
