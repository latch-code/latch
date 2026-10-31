import { FileOutputs, type FileOutputsProps } from './FileOutputs.tsx'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Ellipsis, GitFork, Copy, RotateCcw } from 'lucide-react'
import type { TaskDetail } from '@latch/protocol'
import {
  liveFacts,
  livePhase,
  outcomeWords,
  phaseText,
  runElapsed,
  turnText,
  turnTimes,
  turnTimeTip,
  turnUsage,
  type LivePhase,
  type Turn,
  type TurnOutcome,
} from '../conversation.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { exactTokens, formatDuration, tokenAmount, tokenLines, tokenParts } from '../format.ts'
import { TimeLabel } from './MessageRow.tsx'
import { Menu } from './overlays.tsx'
import { Button, Collapse, IconButton, Shimmer, Swap, Tooltip, CopyButton } from '@latch/ui'

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

/** A live label stays at least 1200ms, so a quick run of phases does not flicker; stopping and waiting for you do not wait. */
function useHeldPhase(phase: LivePhase): LivePhase {
  const [shown, setShown] = useState(phase)
  // When the label shown now appeared; null until the first change.
  const since = useRef<number | null>(null)
  const latest = useRef(phase)
  useLayoutEffect(() => {
    latest.current = phase
  })
  const key = JSON.stringify(phase)
  const shownKey = JSON.stringify(shown)
  const urgent = phase.kind === 'approval' || phase.kind === 'question' || phase.kind === 'cancelling'
  useEffect(() => {
    if (key === shownKey) return undefined
    const now = performance.now()
    since.current ??= now
    const timer = setTimeout(
      () => {
        since.current = performance.now()
        setShown(latest.current)
      },
      urgent ? 0 : Math.max(0, 1200 - (now - since.current)),
    )
    return () => {
      clearTimeout(timer)
    }
  }, [key, shownKey, urgent])
  return shown
}

/**
 * While the turn runs: what it is doing (the phase in words with its light, 等你批准 in amber), how long it has worked on
 * the Host's clock (frozen while it waits for you), the output so far and a stall. A tool row or thinking row that is
 * itself live already says what is happening, so then the line keeps only the facts.
 */
function LiveLine({
  detail,
  turn,
  harness,
  cancelling,
  approvals,
  fallbackElapsed,
}: {
  detail: TaskDetail
  turn: Turn | undefined
  harness: string
  cancelling: boolean
  approvals: number
  fallbackElapsed?: number
}) {
  useTicker('second')
  const now = hostNow()
  const phase = useHeldPhase(livePhase(detail, { cancelling, approvals, hostNow: now }))
  const elapsedMs = runElapsed(detail, now) ?? fallbackElapsed
  const elapsed = elapsedMs === undefined ? undefined : formatDuration(elapsedMs, true)
  const facts = liveFacts(detail, turn, now)
  const rowIsLive = phase.kind === 'tool' || phase.kind === 'thinking'
  const words = phaseText(phase, harness)
  return (
    <>
      {!rowIsLive && (
        <span role="status" aria-live="polite" className={`turn-phase phase-${phase.kind}`}>
          <Swap value={words} effect="fade">
            {phase.kind === 'approval' || phase.kind === 'question' ? words : <Shimmer>{words}</Shimmer>}
          </Swap>
        </span>
      )}
      {rowIsLive && (
        <span role="status" aria-live="polite" className="sr-only">
          {words}
        </span>
      )}
      {elapsed && (
        <span className="turn-fact" aria-hidden="true">
          {rowIsLive || phase.kind === 'approval' || phase.kind === 'question' ? `已运行 ${elapsed}` : elapsed}
        </span>
      )}
      {facts.tokens && <Fact tip={facts.tokensTitle}>{facts.tokens}</Fact>}
      {facts.stalled && <span className="turn-fact">{facts.stalled}</span>}
    </>
  )
}

/**
 * The settled turn's facts: its outcome when it did not simply finish, when the reply was sent (its tooltip says when
 * the turn began and ended and how long it worked), and its tokens. Each is a segment of its own, so the dots between
 * them are spaced alike.
 */
function SettledFacts({ turn, outcome, context }: { turn: Turn; outcome: TurnOutcome; context?: number }) {
  const times = turnTimes(turn)
  const usage = turnUsage(turn)
  const [inputLine, outputLine] = usage ? tokenLines(usage) : []
  const [input, output] = usage ? tokenParts(usage) : []
  return (
    <>
      {outcomeWords(turn, outcome).map((words, index) => (
        <span key={words} className={index === 0 ? `turn-fact turn-outcome outcome-${outcome}` : 'turn-fact'}>
          {words}
        </span>
      ))}
      {times.sentAt !== undefined && (
        <span className="turn-fact">
          <TimeLabel at={times.sentAt} tip={now => turnTimeTip(times, outcome, now)} />
        </span>
      )}
      {usage && <Fact tip={inputLine}>{input}</Fact>}
      {usage && <Fact tip={outputLine}>{output}</Fact>}
      {!usage && context !== undefined && <Fact tip={`由 Agent 报告：${exactTokens(context)} tokens`}>上下文 {tokenAmount(context)}</Fact>}
    </>
  )
}

export interface TurnRetry {
  /** The confirmation shown first when the turn may have changed something; resends at once without it. */
  warning?: string
  onResend: () => void
}

/**
 * A turn's footer, drawn after its last row: one element from the moment the turn starts to its end, so the live line
 * becomes the settled facts in place (a 120ms cross-fade, nothing moves). Settled, it rests hidden on desktop and
 * fades in while the pointer or focus is in the turn; it stays visible for 3s after a turn the page watched settle, on
 * the newest turn of a touch screen and after a tap on the turn. Copy takes the whole turn's prose; 重新发送 sends the
 * same prompt again as a new turn and never replays a tool.
 */
export function TurnFooter({
  turn,
  live,
  outcome = 'completed',
  pinned = false,
  settledLive = false,
  context,
  retry,
  actions,
  fileChanges,
}: {
  turn: Turn
  fileChanges?: TaskDetail['fileChanges']
  live?: { detail: TaskDetail; harness: string; cancelling: boolean; approvals: number; fallbackElapsed?: number }
  outcome?: TurnOutcome
  /** Always visible: the newest turn on a touch screen, or one the person tapped. */
  pinned?: boolean
  /** The page watched this turn settle: it stays visible for a moment. */
  settledLive?: boolean
  /** The context an agent last reported, for the newest turn of a session without per-turn tokens. */
  context?: number
  retry?: TurnRetry
  actions?: { onFork?: () => void; onCopy: () => void }
}) {
  // A turn the page watched settle keeps its footer shown for 3s; the change is taken during the render that sees it.
  const [watched, setWatched] = useState(settledLive)
  const [lingering, setLingering] = useState(settledLive)
  if (watched !== settledLive) {
    setWatched(settledLive)
    setLingering(settledLive)
  }
  useEffect(() => {
    if (!lingering) return undefined
    const timer = setTimeout(() => {
      setLingering(false)
    }, 3000)
    return () => {
      clearTimeout(timer)
    }
  }, [lingering])
  const [confirming, setConfirming] = useState(false)
  const text = turnText(turn)
  const visible = live !== undefined || pinned || lingering
  const recorded = [...(turn.user ? [turn.user] : []), ...turn.replies].findLast(
    message => message.outputs !== undefined || message.outputsTruncated || message.outputsUnavailable,
  )
  const outputs: FileOutputsProps | undefined = fileChanges
    ? { ...fileChanges, pending: true }
    : recorded
      ? {
          files: recorded.outputs ?? [],
          pending: recorded.outputsPending,
          truncated: recorded.outputsTruncated,
          unavailable: recorded.outputsUnavailable,
        }
      : undefined
  return (
    <>
      {outputs && <FileOutputs {...outputs} />}
      <div className={`turn-footer ${live ? 'is-live' : ''}`} data-pinned={visible ? '' : undefined}>
        <div className="turn-footer-row">
          <Swap value={live ? 'live' : 'settled'} effect="fade" className="turn-facts">
            {live ? (
              <LiveLine
                detail={live.detail}
                turn={turn}
                harness={live.harness}
                cancelling={live.cancelling}
                approvals={live.approvals}
                fallbackElapsed={live.fallbackElapsed}
              />
            ) : (
              <SettledFacts turn={turn} outcome={outcome} context={context} />
            )}
          </Swap>
          {!live && text && <CopyButton text={text} label="复制回复" size="xs" />}
          {!live && actions && (
            <Menu
              label="这一轮的操作"
              placement="top-end"
              sections={[
                {
                  id: 'turn-actions',
                  items: [
                    ...(actions.onFork
                      ? [{ id: 'fork', label: '从这里分叉', leading: <GitFork size={14} />, onSelect: actions.onFork }]
                      : []),
                    { id: 'copy-history', label: '复制到这里为止的记录', leading: <Copy size={14} />, onSelect: actions.onCopy },
                  ],
                },
              ]}
              trigger={props => <IconButton {...props} icon={Ellipsis} size="xs" label="这一轮的更多操作" />}
            />
          )}
          {!live && retry && (
            <Button
              size="xs"
              variant="ghost"
              icon={RotateCcw}
              className="turn-retry"
              onClick={() => {
                if (retry.warning) setConfirming(true)
                else retry.onResend()
              }}>
              重新发送
            </Button>
          )}
        </div>
        {!live && retry?.warning && (
          <Collapse open={confirming}>
            <div
              className="turn-retry-confirm"
              role="group"
              aria-label="重新发送"
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  setConfirming(false)
                }
              }}>
              <p>{retry.warning}</p>
              <div className="turn-retry-actions">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setConfirming(false)
                  }}>
                  取消
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    setConfirming(false)
                    retry.onResend()
                  }}>
                  重新发送
                </Button>
              </div>
            </div>
          </Collapse>
        )}
      </div>
    </>
  )
}
