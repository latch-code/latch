import { memo, useMemo, useRef, useState } from 'react'
import { ChevronRight, FileSearch, RotateCcw, X } from 'lucide-react'
import { splitChangeNote, type Approval, type HarnessInfo, type Message, type TaskDetail, type TurnChanges } from '@latch/protocol'
import {
  deliveryWords,
  foldWords,
  isLive,
  liveMessageId,
  outcomeWords,
  renderedMessages,
  resendWarning,
  runEndLine,
  sameData,
  sideEffects,
  stableTurns,
  toolRowId,
  turnBlocks,
  turnModel,
  turnOutcome,
  turnsOf,
  turnTimes,
  workFolds,
  type Turn,
  type TurnOutcome,
  type WorkItem,
} from '../conversation.ts'
import { TurnCards } from '../conversation/TurnCards.tsx'
import { RunEndNote, StatusLine, type StatusLineProps } from '../conversation/StatusLine.tsx'
import { PlanRow } from '../conversation/PlanRow.tsx'
import { TurnSummaryOptions, type TurnSummaryOptionsValue } from '../conversation/summaryOptions.ts'
import { announceChangesWrite, useChangesRevision, useTurnChanges } from '../conversation/useTurnChanges.ts'
import { messageTime } from '../format.ts'
import { FileSession } from './FileChip.tsx'
import { FileReferences } from './FileReferences.tsx'
import { AuthorLine, MessageRow, ThinkingRow, type LiveReasoning } from './MessageRow.tsx'
import { ToolCard } from './ToolCard.tsx'
import { QuestionResultCard } from '../composer/QuestionDrawer.tsx'
import { TurnFooter, type TurnRetry } from './TurnFooter.tsx'
import { VisibleText } from './VisibleText.tsx'
import { transcriptMarkdown } from '../exportMarkdown.ts'
import { useStableCallback } from '../hooks/useStableCallback.ts'
import { Button, Collapse, ICON_STROKE, useLivePrevious } from '@latch/ui'

/** What resending the latest turn takes, when this device may send now. */
export interface RetryAccess {
  /** The session is a full-access one: the confirmation says it will not ask before each step. */
  fullAccess: boolean
  onResend: (prompt: string) => void
}

type Question = NonNullable<TaskDetail['questions']>[number]

/** What a row needs beyond its message; for a turn with no approval or question of its own it never changes. */
interface RowContext {
  sessionId: string
  approvals: readonly Approval[]
  questions: readonly Question[]
  /** The reply streaming in this turn, under the ID it keeps once committed. */
  streamingId?: string
  liveReasoning?: LiveReasoning
  coarse: boolean
  /** The connection is down: rows stop spinning and ticking. */
  frozen: boolean
}

function ToolRow({ message, context, onRetry }: { message: Message; context: RowContext; onRetry?: (() => void) | undefined }) {
  const approval = context.approvals.find(item => toolRowId(item) === message.id)
  return <ToolCard message={message} approval={approval} onRetry={onRetry} frozen={context.frozen} />
}

/** A question in reading order: it is answered in the drawer above the composer, and then this is the record of what was chosen. */
function QuestionRow({ message, context }: { message: Message; context: RowContext }) {
  const question = context.questions.find(item => `tool:${item.toolCallId}` === message.id)
  if (question) return null
  if (message.state === 'completed' && message.text.startsWith('{"kind":"latch.question-result"'))
    return <QuestionResultCard text={message.text} />
  return <ToolRow message={message} context={context} />
}

/** A settled turn's finished reads as one row; opening it lists them as the rows they were. */
function ReadsRow({ messages, context }: { messages: Message[]; context: RowContext }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="reads-row" data-open={open ? '' : undefined}>
      <button
        type="button"
        className="process-row"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
        }}>
        <span className="process-slot" aria-hidden="true">
          <FileSearch size={16} strokeWidth={ICON_STROKE[16]} />
        </span>
        <span className="process-label">读取 {messages.length} 个文件</span>
        <ChevronRight className="process-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
      </button>
      <Collapse
        open={open}
        onReveal={() => {
          setOpen(true)
        }}>
        <div className="reads-rows">
          {messages.map(message => (
            <ToolRow key={message.id} message={message} context={context} />
          ))}
        </div>
      </Collapse>
    </div>
  )
}

function WorkRow({ item, context, onRetry }: { item: WorkItem; context: RowContext; onRetry?: (() => void) | undefined }) {
  if (item.kind === 'reads') return <ReadsRow messages={item.messages} context={context} />
  if (item.kind === 'tool') return <ToolRow message={item.message} context={context} onRetry={onRetry} />
  const streaming = item.message.id === context.streamingId
  return (
    <ThinkingRow
      text={item.message.reasoning ?? ''}
      live={streaming && !item.message.text}
      streaming={streaming}
      reasoningMs={item.message.reasoningMs}
      liveTimes={streaming ? context.liveReasoning : undefined}
      frozen={context.frozen}
    />
  )
}

interface TurnViewProps {
  turn: Turn
  context: RowContext
  /** The word of the author line: the Agent. */
  author: string
  /** The engine behind it, in the author line's secondary text and in what the status says. */
  engine?: string
  harnessName: string
  harness?: Pick<HarnessInfo, 'id' | 'source'>
  /** The model that answered, or that the run uses before its first step records one, and its service's name. */
  model?: string
  provider?: string
  trailingLive: boolean
  latest: boolean
  outcome?: TurnOutcome
  /** The page saw this turn arrive: its prompt rises in. */
  arrived: boolean
  status?: StatusLineProps
  /** How far the prompt has got, while the agent has not answered. */
  delivery?: string
  summary?: TaskDetail['summary']
  plan?: TaskDetail['plan']
  retry?: TurnRetry
  reportedContext?: number
  /** Fork from, and copy the record up to, the turn's last row; only a settled turn offers them. */
  onForkFrom?: (messageId: string) => void
  onCopyUpTo?: (messageId: string) => void
  /** Forks before this turn with the prompt in the composer. */
  onEdit?: (message: Message) => void
  onContinue?: () => void
  changes?: TurnChanges
  /** A turn of this session runs, so no turn's undo can. */
  sessionActive: boolean
  changesRevision: string
  changesEnabled: boolean
  onChangesError?: (error: unknown) => void
}

/**
 * A settled turn draws only when its own data changes, so a streaming frame costs the turn that is streaming. Every prop
 * counts unless named here, so a new one can only cost a render, never leave a turn stale.
 */
function sameTurnProps(a: TurnViewProps, b: TurnViewProps): boolean {
  const keys = Object.keys(a) as Array<keyof TurnViewProps>
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => {
    if (Object.is(a[key], b[key])) return true
    if (key === 'harness' || key === 'changes' || key === 'plan') return sameData(a[key], b[key])
    if (key !== 'context') return false
    const left = a.context,
      right = b.context
    const fields = Object.keys(left) as Array<keyof RowContext>
    if (fields.length !== Object.keys(right).length) return false
    return fields.every(
      field =>
        Object.is(left[field], right[field])
        || ((field === 'approvals' || field === 'questions' || field === 'liveReasoning') && sameData(left[field], right[field])),
    )
  })
}

const NONE: readonly never[] = []

/** Why a turn did not simply finish, on a line that stays: a failed one in red with 重试, a stopped one quietly. */
function OutcomeRecord({ turn, outcome, onRetry }: { turn: Turn; outcome: TurnOutcome; onRetry?: (() => void) | undefined }) {
  const words = outcomeWords(turn, outcome)
  if (words.length === 0) return null
  const at = turnTimes(turn).sentAt
  return (
    <p className={`turn-record outcome-${outcome}`}>
      {outcome === 'failed' && (
        <span className="process-slot" aria-hidden="true">
          <X size={12} strokeWidth={ICON_STROKE[12]} />
        </span>
      )}
      <span>{[...words.slice(0, 1), ...(at !== undefined ? [messageTime(at, Date.now())] : []), ...words.slice(1)].join(' · ')}</span>
      {outcome === 'failed' && onRetry && (
        <Button size="xs" variant="ghost" icon={RotateCcw} onClick={onRetry}>
          重试
        </Button>
      )}
    </p>
  )
}

const TurnView = memo(function TurnView({
  turn,
  author,
  engine,
  harnessName,
  harness,
  model,
  provider,
  trailingLive,
  latest,
  outcome,
  arrived,
  status,
  delivery,
  summary,
  plan,
  context: rowContext,
  retry,
  reportedContext,
  onForkFrom,
  onCopyUpTo,
  onEdit,
  onContinue,
  changes,
  sessionActive,
  changesRevision,
  changesEnabled,
  onChangesError,
}: TurnViewProps) {
  const [tapped, setTapped] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [foldChoice, setFoldChoice] = useState<boolean | null>(null)
  const blocks = useMemo(() => turnBlocks(turn, !trailingLive), [turn, trailingLive])
  const folds = !trailingLive && workFolds(turn, outcome)
  const hasWork = blocks.some(block => block.kind === 'work' && block.items.some(item => item.kind !== 'thinking'))
  // The rows stay in one tree from the first to the last, so the fold is seen to happen when the turn settles.
  const workOpen = trailingLive || (foldChoice ?? !folds)
  const end = turn.replies.at(-1) ?? turn.user
  const recorded = [...(turn.user ? [turn.user] : []), ...turn.replies].findLast(
    message => message.outputs !== undefined || message.outputsTruncated || message.outputsUnavailable,
  )
  const outputs = recorded && !recorded.outputsPending ? recorded : undefined
  const hasOutputs = !!(recorded?.outputs?.length || recorded?.outputsTruncated || recorded?.outputsUnavailable)
  const hasReply = turn.replies.length > 0 || trailingLive || hasOutputs
  // The reply's author line and first block fade in when the page saw them appear, not after a load or a switch.
  const replyBefore = useLivePrevious(hasReply)
  const replyArrived = hasReply && (arrived || replyBefore === false)
  const runEnd = summary && !trailingLive && latest ? runEndLine(summary, engine ?? harnessName) : undefined
  const pressRetry = useStableCallback(() => {
    if (retry?.warning) setConfirming(true)
    else retry?.onResend()
  })
  const onRetry = retry ? pressRetry : undefined
  // One 重试 in the turn's reading order: on what failed last.
  const lastFailed = turn.replies.findLast(
    message => (message.role === 'tool' || message.role === 'system') && message.state === 'failed',
  )?.id
  // A failure says itself once: a failed note or row already has the words, and the run's end note has its own.
  const speaksFailure = turn.replies.some(message => (message.role === 'system' || message.role === 'tool') && message.state === 'failed')
  const showOutcome = outcome !== undefined && outcome !== 'completed' && !runEnd && !(outcome === 'failed' && speaksFailure)
  return (
    <div className="turn" data-turn={turn.key} data-settled={latest ? undefined : ''}>
      {turn.user && (
        <MessageRow
          message={turn.user}
          coarse={rowContext.coarse}
          arrived={arrived}
          {...(delivery ? { delivery } : {})}
          {...(onEdit ? { onEdit } : {})}
        />
      )}
      {hasReply && (
        <div
          className="turn-reply"
          data-arrived={replyArrived ? '' : undefined}
          data-shown={tapped ? '' : undefined}
          onClick={
            rowContext.coarse && !latest
              ? event => {
                  // On touch a tap on the reply shows its footer, a second tap hides it.
                  if (!(event.target instanceof Element && event.target.closest('button, a, [tabindex], pre, summary'))) setTapped(!tapped)
                }
              : undefined
          }>
          <AuthorLine name={author} engine={engine} harness={harness} model={model} provider={provider} />
          {!trailingLive && hasWork && (
            <button
              type="button"
              className="work-fold"
              aria-expanded={workOpen}
              onClick={() => {
                setFoldChoice(!workOpen)
              }}>
              <span>{foldWords(turn)}</span>
              <ChevronRight className="process-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
            </button>
          )}
          {plan && plan.length > 0 && <PlanRow plan={plan} active={trailingLive} />}
          {blocks.map(block => {
            if (block.kind === 'prose') {
              const streaming = block.message.id === rowContext.streamingId
              return (
                <MessageRow
                  key={block.message.id}
                  message={block.message}
                  streaming={streaming}
                  frozen={rowContext.frozen}
                  coarse={rowContext.coarse}
                />
              )
            }
            if (block.kind === 'note') {
              if (block.message.role === 'tool') return <QuestionRow key={block.message.id} message={block.message} context={rowContext} />
              return (
                <MessageRow key={block.message.id} message={block.message} coarse={rowContext.coarse} {...(onRetry ? { onRetry } : {})} />
              )
            }
            return (
              <Collapse
                key={block.key}
                className="work-group"
                open={workOpen}
                onReveal={() => {
                  setFoldChoice(true)
                }}>
                <div className="work-rows">
                  {block.items.map(item => (
                    <WorkRow
                      key={item.kind === 'reads' ? `reads:${item.messages[0]!.id}` : `${item.kind}:${item.message.id}`}
                      item={item}
                      context={rowContext}
                      onRetry={item.kind === 'tool' && item.message.id === lastFailed ? onRetry : undefined}
                    />
                  ))}
                </div>
              </Collapse>
            )
          })}
          {!trailingLive && (
            <TurnCards
              sessionId={rowContext.sessionId}
              turn={turn}
              record={changes}
              revision={changesRevision}
              enabled={changesEnabled}
              engine={engine ?? harnessName}
              active={sessionActive}
              outputs={outputs}
              onError={onChangesError}
            />
          )}
          {status && <StatusLine {...status} />}
          {runEnd && summary && <RunEndNote summary={summary} harness={engine ?? harnessName} onRetry={onRetry} onContinue={onContinue} />}
          {showOutcome && <OutcomeRecord turn={turn} outcome={outcome} onRetry={onRetry} />}
          {retry?.warning && (
            <Collapse open={confirming}>
              <div
                className="turn-retry-confirm"
                role="group"
                aria-label="重试"
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
                    重试
                  </Button>
                </div>
              </div>
            </Collapse>
          )}
          {!trailingLive && (
            <TurnFooter
              key={turn.key}
              turn={turn}
              outcome={outcome}
              pinned={tapped || (latest && rowContext.coarse)}
              context={reportedContext}
              {...(onRetry ? { onRetry } : {})}
              actions={
                end && onCopyUpTo
                  ? {
                      ...(onForkFrom
                        ? {
                            onFork: () => {
                              onForkFrom(end.id)
                            },
                          }
                        : {}),
                      onCopy: () => {
                        onCopyUpTo(end.id)
                      },
                    }
                  : undefined
              }
            />
          )}
        </div>
      )}
    </div>
  )
}, sameTurnProps)

/**
 * The conversation as turns: each prompt, then what answered it under one author line. The work folds into one line once
 * the turn has settled, but prose never does; a footer follows the last row. The latest turn of a running session ends
 * with the status line instead.
 */
export function Transcript({
  detail,
  approvals,
  harnessName,
  harness,
  personal = false,
  demo = false,
  active = false,
  cancelling = false,
  coarse = false,
  providerName,
  fallbackElapsed,
  frozenAt,
  retry,
  onFork,
  onSource,
  onCopyError,
  onStop,
  onReveal,
  changes,
}: {
  detail: TaskDetail
  approvals: Approval[]
  /** This device's approval buttons; omitted, every offered option is shown. */
  harnessName: string
  /** The session's harness, for the tile on each turn's author line. */
  harness?: Pick<HarnessInfo, 'id' | 'source'>
  /** A personal agent's session: its name is the word of the author line. */
  personal?: boolean
  /** The demo model answers, and every turn says so. */
  demo?: boolean
  /** The session is running; its latest turn is not finished. */
  active?: boolean
  /** A stop was requested from this page. */
  cancelling?: boolean
  /** Touch: no hover, so the newest turn's footer stays shown and a tap shows another's. */
  coarse?: boolean
  providerName?: (id: string) => string | undefined
  /** An older Host's run: the time since this page saw it start. */
  fallbackElapsed?: number
  /** When the connection was last known to be up, while it is down. */
  frozenAt?: number
  /** Present when this device may send now: the latest turn offers 重试. */
  retry?: RetryAccess
  /** Forks up to a message, with a draft in the composer. */
  onFork?: (upToMessageId: string, draft?: string) => void
  /** Opens the session a fork came from. */
  onSource?: (sessionId: string) => void
  onCopyError?: (error: unknown) => void
  onStop?: () => void
  /** Brings a row into view, for what the status line points at. */
  onReveal?: (messageId: string) => void
  /** The Host's per-turn records and what this device may do with them. */
  changes?: Pick<TurnSummaryOptionsValue, 'undo'> & { enabled: boolean }
}) {
  const messages = renderedMessages(detail)
  // Kept from the previous render even if React discards it: a turn only ever stands in for one with the same data.
  const lastTurns = useRef<Turn[]>([])
  const turns = stableTurns(lastTurns.current, turnsOf(messages))
  lastTurns.current = turns
  const ids = new Set(messages.map(message => message.id))
  const liveId = isLive(detail) ? liveMessageId(detail) : undefined
  const forkFrom = useStableCallback((messageId: string) => onFork?.(messageId))
  const copyUpTo = useStableCallback((messageId: string) => {
    const index = detail.messages.findIndex(message => message.id === messageId)
    void (async () => {
      if (!navigator.clipboard?.writeText) throw new Error('此浏览器不能复制，请手动选择记录')
      await navigator.clipboard.writeText(transcriptMarkdown({ ...detail, messages: detail.messages.slice(0, index + 1), liveText: '' }))
    })().catch(error => onCopyError?.(error))
  })
  const editFrom = useStableCallback((message: Message) => {
    const index = detail.messages.findIndex(item => item.id === message.id)
    const before = detail.messages[index - 1]
    if (before) onFork?.(before.id, splitChangeNote(message.text.slice(message.forkContext?.prefixLength ?? 0)).text)
  })
  const continueRun = useStableCallback(() => {
    const last = detail.messages.at(-1)
    if (last) onFork?.(last.id, '请接着这个会话继续。')
  })
  const changesError = useStableCallback((error: unknown) => onCopyError?.(error))
  const lastKey = turns.at(-1)?.key ?? ''
  // The latest turn before the last change the page saw happen ('' for none): a different latest turn arrived live.
  const previousLast = useLivePrevious(lastKey)
  const { id: sessionId, cwd, folders, updatedAt } = detail.summary
  const fileSession = useMemo(
    () => ({ id: sessionId, ...(cwd ? { folder: cwd } : {}), ...(folders ? { folders } : {}) }),
    [sessionId, cwd, folders],
  )
  const { revision: changesRevision, refresh: refreshChanges } = useChangesRevision({
    sessionId,
    enabled: changes?.enabled === true,
    active,
    updatedAt,
  })
  const records = useTurnChanges(sessionId, turns, {
    enabled: changes?.enabled === true,
    revision: changesRevision,
    active,
    ...(detail.summary.runId ? { latestRunId: detail.summary.runId } : {}),
  })
  const summaryOptions = useMemo<TurnSummaryOptionsValue>(
    () => ({
      undo: changes?.undo ?? 'read-only',
      refresh: () => {
        refreshChanges()
        announceChangesWrite(sessionId, 'conversation')
      },
    }),
    [changes?.undo, refreshChanges, sessionId],
  )
  const frozen = frozenAt !== undefined
  const author = personal ? harnessName : '通用'
  const engine = demo ? '演示' : personal ? undefined : harness?.source === 'builtin' ? 'Latch' : harnessName
  const statusProps: StatusLineProps = {
    detail,
    harness: engine ?? harnessName,
    cancelling,
    approvals: approvals.length,
    ...(fallbackElapsed !== undefined ? { fallbackElapsed } : {}),
    ...(frozenAt !== undefined ? { frozenAt } : {}),
    ...(onStop ? { onStop } : {}),
    ...(onReveal ? { onView: onReveal } : {}),
    onError: changesError,
  }
  return (
    <FileSession.Provider value={fileSession}>
      <TurnSummaryOptions.Provider value={summaryOptions}>
        <FileReferences sessionId={sessionId} active={active}>
          {detail.summary.forkOf && (
            <p className="fork-origin">
              从「
              {onSource ? (
                <button type="button" aria-label="返回来源会话" onClick={() => onSource(detail.summary.forkOf!.taskId)}>
                  <VisibleText text={detail.summary.forkOf.title} />
                </button>
              ) : (
                <VisibleText text={detail.summary.forkOf.title} />
              )}
              」第 {detail.summary.forkOf.turn} 轮分叉
            </p>
          )}
          {turns.map((turn, index) => {
            const latest = index === turns.length - 1
            const trailingLive = latest && active
            const outcome = trailingLive ? undefined : turnOutcome(turn, latest ? detail.summary.status : undefined)
            const resend =
              latest && !trailingLive && retry && turn.user
                ? {
                    warning: resendWarning(sideEffects(turn), retry.fullAccess),
                    onResend: () => {
                      retry.onResend(splitChangeNote(turn.user!.text).text)
                    },
                  }
                : undefined
            const rowIds = turn.replies.filter(message => message.role === 'tool').map(message => message.id)
            const ownApprovals = approvals.length ? approvals.filter(approval => rowIds.includes(toolRowId(approval) ?? '')) : NONE
            const ownQuestions = detail.questions?.length
              ? detail.questions.filter(question => rowIds.includes(`tool:${question.toolCallId}`))
              : NONE
            const streaming = liveId !== undefined && turn.replies.some(message => message.id === liveId)
            const stamped = turnModel(turn)
            const providerId = stamped?.model ? stamped.providerId : trailingLive ? detail.summary.providerId : undefined
            const delivery = trailingLive && !frozen ? deliveryWords(detail, turn) : undefined
            const record = records.get(turn.key)
            return (
              <TurnView
                key={turn.key}
                turn={turn}
                context={{
                  sessionId,
                  approvals: ownApprovals,
                  questions: ownQuestions,
                  ...(streaming ? { streamingId: liveId } : {}),
                  ...(streaming ? { liveReasoning: { startedAt: detail.liveReasoningStartedAt, ms: detail.liveReasoningMs } } : {}),
                  coarse,
                  frozen: frozen && trailingLive,
                }}
                author={author}
                {...(engine ? { engine } : {})}
                harnessName={harnessName}
                harness={harness}
                model={stamped?.model ?? (trailingLive ? detail.summary.model : undefined)}
                provider={providerId ? providerName?.(providerId) : undefined}
                latest={latest}
                trailingLive={trailingLive}
                outcome={outcome}
                arrived={latest && previousLast !== undefined && previousLast !== lastKey}
                {...(trailingLive ? { status: statusProps } : {})}
                {...(delivery ? { delivery } : {})}
                {...(latest ? { summary: detail.summary } : {})}
                {...(latest && detail.plan?.length ? { plan: detail.plan } : {})}
                retry={resend}
                reportedContext={latest ? detail.usageReport?.contextUsed : undefined}
                onForkFrom={!trailingLive && onFork ? forkFrom : undefined}
                onCopyUpTo={!trailingLive ? copyUpTo : undefined}
                {...(!active && onFork && index > 0 ? { onEdit: editFrom } : {})}
                {...(onFork ? { onContinue: continueRun } : {})}
                {...(record ? { changes: record } : {})}
                sessionActive={active}
                changesRevision={changesRevision}
                changesEnabled={changes?.enabled === true}
                onChangesError={changesError}
              />
            )
          })}
        </FileReferences>
      </TurnSummaryOptions.Provider>
    </FileSession.Provider>
  )
}
