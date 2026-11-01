import { useContext, type ReactNode } from 'react'
import { Copy, Ellipsis, GitCompare, GitFork, RotateCcw } from 'lucide-react'
import { turnText, turnTimes, turnTimeTip, turnUsage, type Turn, type TurnOutcome } from '../conversation.ts'
import { ChangesLinkContext } from '../conversation/changesLink.ts'
import { exactTokens, formatDuration, tokenAmount, tokenLines, tokenParts } from '../format.ts'
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

/**
 * The settled turn's facts: when the reply was sent (its tooltip says when the turn began and ended), how long it worked
 * and its tokens. How it ended, when it did not simply finish, has its own line that stays. Each is a segment of its own, so the dots between them are
 * spaced alike.
 */
function SettledFacts({ turn, outcome, context }: { turn: Turn; outcome: TurnOutcome; context?: number }) {
  const times = turnTimes(turn)
  const usage = turnUsage(turn)
  const [inputLine, outputLine] = usage ? tokenLines(usage) : []
  const [input, output] = usage ? tokenParts(usage) : []
  const spent = outcome === 'interrupted' || times.activeMs === undefined ? undefined : formatDuration(times.activeMs)
  return (
    <>
      {times.sentAt !== undefined && (
        <span className="turn-fact">
          <TimeLabel at={times.sentAt} tip={now => turnTimeTip(times, outcome, now)} />
        </span>
      )}
      {spent && <span className="turn-fact">{spent}</span>}
      {usage && <Fact tip={inputLine}>{input}</Fact>}
      {usage && <Fact tip={outputLine}>{output}</Fact>}
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
  onRetry,
  actions,
}: {
  turn: Turn
  outcome?: TurnOutcome
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
          <SettledFacts turn={turn} outcome={outcome} context={context} />
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
