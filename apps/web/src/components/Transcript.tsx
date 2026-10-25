import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { Approval, HarnessInfo, Message, TaskDetail } from '@latch/protocol'
import {
  foldedRows,
  foldSummary,
  isLive,
  liveMessageId,
  renderedMessages,
  resendWarning,
  separators,
  sideEffects,
  toolRowId,
  turnModel,
  turnOutcome,
  turnsOf,
  type Turn,
  type TurnOutcome,
} from '../conversation.ts'
import { FileSession } from './FileChip.tsx'
import { FileReferences } from './FileReferences.tsx'
import { MessageRow, SourceRow } from './MessageRow.tsx'
import { ToolCard, type ApprovalGateFor, type DecideHandler } from './ToolCard.tsx'
import { QuestionCard, QuestionResultCard, type QuestionActions } from './QuestionCard.tsx'
import { TurnFooter, type TurnRetry } from './TurnFooter.tsx'
import { transcriptMarkdown } from '../exportMarkdown.ts'
import { Collapse, ICON_STROKE, useLivePrevious } from '@latch/ui'

/** What resending the latest turn takes, when this device may send now. */
export interface RetryAccess {
  /** The session is a full-access one: the confirmation says it will not ask before each step. */
  fullAccess: boolean
  onResend: (prompt: string) => void
}

interface RowContext {
  detail: TaskDetail
  approvals: ReadonlyMap<string, Approval>
  busy: ReadonlyMap<string, string>
  onDecide: DecideHandler
  gateFor?: ApprovalGateFor
  liveId: string
  live: boolean
  coarse: boolean
  questionActions?: QuestionActions
}

function Row({ message, context }: { message: Message; context: RowContext }) {
  if (message.role === 'tool') {
    const question = context.detail.questions?.find(question => `tool:${question.toolCallId}` === message.id)
    if (question && context.questionActions)
      return <QuestionCard question={question} sessionId={context.detail.summary.id} actions={context.questionActions} />
    if (message.toolName === 'ask_user' && message.state === 'completed' && message.text.startsWith('{"kind":"latch.question-result"'))
      return <QuestionResultCard text={message.text} />
    const approval = context.approvals.get(message.id)
    return (
      <ToolCard
        message={message}
        approval={approval}
        busy={approval ? context.busy.get(approval.id) : undefined}
        onDecide={context.onDecide}
        gateFor={context.gateFor}
      />
    )
  }
  const streaming = context.live && message.id === context.liveId
  return (
    <MessageRow
      message={message}
      streaming={streaming}
      coarse={context.coarse}
      liveReasoning={streaming ? { startedAt: context.detail.liveReasoningStartedAt, ms: context.detail.liveReasoningMs } : undefined}
    />
  )
}

/**
 * Consecutive tool rows sit together as a quiet timeline; prose and notes break it. A reply block stays out of the
 * groups even while it only reasons, so it keeps its place in the tree when its text starts.
 */
function rowsWithGroups(messages: Message[], render: (message: Message) => ReactNode): ReactNode[] {
  const out: ReactNode[] = []
  let group: Message[] = []
  const flush = () => {
    if (group.length === 0) return
    out.push(
      <div className="process-group" key={`group:${group[0]?.id ?? ''}`}>
        {group.map(render)}
      </div>,
    )
    group = []
  }
  for (const message of messages) {
    if (message.role === 'tool') group.push(message)
    else {
      flush()
      out.push(render(message))
    }
  }
  flush()
  return out
}

/**
 * The process before an answer, folded into one row once the turn has settled: 「已处理 · 读取 4 个文件 · …」. It folds
 * with motion only when the page watched the turn settle; reopening shows the rows as they were.
 */
function ProcessFold({ rows, settledLive, children }: { rows: Message[]; settledLive: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(settledLive)
  useEffect(() => {
    if (!settledLive) return undefined
    // The rows are shown first and fold a frame later, so the fold is seen to happen.
    const frame = requestAnimationFrame(() => {
      setOpen(false)
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [settledLive])
  return (
    <div className="process-fold" data-open={open ? '' : undefined}>
      <button
        type="button"
        className="process-row fold-toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
        }}>
        <span className="fold-summary">{foldSummary(rows)}</span>
        <ChevronRight className="process-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
      </button>
      <Collapse
        open={open}
        onReveal={() => {
          setOpen(true)
        }}>
        <div className="fold-rows">{children}</div>
      </Collapse>
    </div>
  )
}

function TurnView({
  turn,
  harnessName,
  harness,
  providerName,
  separator,
  latest,
  trailingLive,
  outcome,
  settledLive,
  arrived,
  runModel,
  standalone,
  liveFooter,
  context: rowContext,
  retry,
  reportedContext,
  actions,
}: {
  turn: Turn
  context: RowContext
  harnessName: string
  harness?: Pick<HarnessInfo, 'id' | 'source'>
  providerName?: (id: string) => string | undefined
  separator?: { at: number; sameDay: boolean }
  latest: boolean
  trailingLive: boolean
  outcome?: TurnOutcome
  settledLive: boolean
  /** The page saw this turn arrive: its prompt rises in. */
  arrived: boolean
  /** The model the run uses, for the source row of a running turn before its first step records one. */
  runModel?: { model: string; providerId?: string }
  standalone: Approval[]
  liveFooter?: Parameters<typeof TurnFooter>[0]['live']
  retry?: TurnRetry
  reportedContext?: number
  actions?: Parameters<typeof TurnFooter>[0]['actions']
}) {
  const [tapped, setTapped] = useState(false)
  const folded = trailingLive ? [] : foldedRows(turn, outcome)
  const foldedIds = new Set(folded.map(message => message.id))
  const rest = turn.replies.filter(message => !foldedIds.has(message.id))
  const render = (message: Message) => <Row key={message.id} message={message} context={rowContext} />
  const stamped = turnModel(turn)
  const model = stamped?.model ? { model: stamped.model, providerId: stamped.providerId } : trailingLive ? runModel : undefined
  const observed = latest ? rowContext.detail.fileChanges : undefined
  const hasOutputs = !!(
    turn.user?.outputs?.length
    || turn.user?.outputsTruncated
    || turn.user?.outputsUnavailable
    || observed?.files.length
    || observed?.truncated
    || observed?.unavailable
  )
  const hasReply = turn.replies.length > 0 || trailingLive || standalone.length > 0 || hasOutputs
  // The reply's source line and first block fade in when the page saw them appear, not after a load or a switch.
  const replyBefore = useLivePrevious(hasReply)
  const replyArrived = hasReply && (arrived || replyBefore === false)
  return (
    <div className="turn" data-turn={turn.key}>
      {turn.user && <MessageRow message={turn.user} separator={separator} coarse={rowContext.coarse} arrived={arrived} />}
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
          <SourceRow
            name={harnessName}
            harness={harness}
            model={model?.model}
            provider={model?.providerId ? providerName?.(model.providerId) : undefined}
          />
          {folded.length > 0 && (
            <ProcessFold rows={folded} settledLive={settledLive}>
              {rowsWithGroups(folded, render)}
            </ProcessFold>
          )}
          {rowsWithGroups(rest, render)}
          {standalone.map(approval => (
            <ToolCard
              key={approval.id}
              message={null}
              approval={approval}
              busy={rowContext.busy.get(approval.id)}
              onDecide={rowContext.onDecide}
              gateFor={rowContext.gateFor}
            />
          ))}
          <TurnFooter
            key={turn.key}
            turn={turn}
            fileChanges={
              latest && rowContext.detail.fileChanges?.runId === rowContext.detail.summary.runId ? rowContext.detail.fileChanges : undefined
            }
            live={trailingLive ? liveFooter : undefined}
            outcome={outcome}
            pinned={tapped || (latest && rowContext.coarse)}
            settledLive={settledLive}
            context={latest ? reportedContext : undefined}
            retry={retry}
            actions={actions}
          />
        </div>
      )}
    </div>
  )
}

/**
 * The conversation as turns: each prompt (with its time separator when one is due), then what answered it under one
 * source line, the process before a settled answer folded into a row, and the turn's footer after its last row. The
 * latest turn of a running session ends with the live line instead, after any approval card that has no tool row.
 */
export function Transcript({
  detail,
  approvals,
  busy,
  onDecide,
  gateFor,
  harnessName,
  harness,
  active = false,
  cancelling = false,
  coarse = false,
  providerName,
  fallbackElapsed,
  retry,
  onFork,
  onCopyError,
  questionActions,
}: {
  detail: TaskDetail
  approvals: Approval[]
  busy: ReadonlyMap<string, string>
  onDecide: DecideHandler
  /** This device's approval buttons; omitted, every offered option is shown. */
  gateFor?: ApprovalGateFor
  harnessName: string
  /** The session's harness, for the tile on each turn's source row. */
  harness?: Pick<HarnessInfo, 'id' | 'source'>
  /** The session is running; its latest turn is not finished. */
  active?: boolean
  /** A stop was requested from this page. */
  cancelling?: boolean
  /** Touch: no hover, so the newest turn's footer stays shown and a tap shows another's. */
  coarse?: boolean
  providerName?: (id: string) => string | undefined
  /** An older Host's run: the time since this page saw it start. */
  fallbackElapsed?: number
  /** Present when this device may send now: the latest turn that failed or stopped offers 重新发送. */
  retry?: RetryAccess
  onFork?: (upToMessageId: string) => void
  onCopyError?: (error: unknown) => void
  questionActions?: QuestionActions
}) {
  const messages = renderedMessages(detail)
  const turns = turnsOf(messages)
  const marks = separators(messages)
  const byTool = new Map(
    approvals.flatMap(approval => {
      const id = toolRowId(approval)
      return id ? [[id, approval] as const] : []
    }),
  )
  const ids = new Set(messages.map(message => message.id))
  const standalone = approvals.filter(approval => {
    const id = toolRowId(approval)
    return id === undefined || !ids.has(id)
  })
  const rowContext: RowContext = {
    detail,
    approvals: byTool,
    busy,
    onDecide,
    gateFor,
    liveId: liveMessageId(detail),
    live: isLive(detail),
    coarse,
    questionActions,
  }
  const trailingKey = active ? (turns.at(-1)?.key ?? 'empty') : null
  // The turn the page watched run until the previous render: when it settles, its footer lingers and its process folds.
  const previouslyLive = useLivePrevious(trailingKey)
  // The latest turn before the last change the page saw happen ('' for none): a different latest turn arrived live.
  const lastKey = turns.at(-1)?.key ?? ''
  const previousLast = useLivePrevious(lastKey)
  const runModel = detail.summary.model
    ? { model: detail.summary.model, ...(detail.summary.providerId ? { providerId: detail.summary.providerId } : {}) }
    : undefined
  const liveFooter = {
    detail,
    harness: harnessName,
    cancelling,
    approvals: approvals.length,
    ...(fallbackElapsed !== undefined ? { fallbackElapsed } : {}),
  }
  const reportedContext = detail.usageReport?.contextUsed
  const { id: sessionId, cwd, folders } = detail.summary
  const fileSession = useMemo(
    () => ({ id: sessionId, ...(cwd ? { folder: cwd } : {}), ...(folders ? { folders } : {}) }),
    [sessionId, cwd, folders],
  )
  return (
    <FileSession.Provider value={fileSession}>
      <FileReferences sessionId={sessionId} active={active}>
        {turns.map((turn, index) => {
          const latest = index === turns.length - 1
          const trailingLive = latest && active
          const outcome = trailingLive ? undefined : turnOutcome(turn, latest ? detail.summary.status : undefined)
          const settledLive = !trailingLive && trailingKey === null && previouslyLive === turn.key
          const resend =
            latest && !trailingLive && retry && turn.user && outcome !== 'completed'
              ? {
                  warning: resendWarning(sideEffects(turn), retry.fullAccess),
                  onResend: () => {
                    retry.onResend(turn.user!.text)
                  },
                }
              : undefined
          return (
            <TurnView
              key={turn.key}
              turn={turn}
              context={rowContext}
              harnessName={harnessName}
              harness={harness}
              providerName={providerName}
              separator={turn.user ? marks.get(turn.user.id) : undefined}
              latest={latest}
              trailingLive={trailingLive}
              outcome={outcome}
              settledLive={settledLive}
              arrived={latest && previousLast !== undefined && previousLast !== lastKey}
              runModel={runModel}
              standalone={latest ? standalone : []}
              liveFooter={liveFooter}
              retry={resend}
              reportedContext={reportedContext}
              actions={
                !trailingLive
                  ? {
                      ...(onFork
                        ? {
                            onFork: () => {
                              const end = turn.replies.at(-1) ?? turn.user
                              if (end) onFork(end.id)
                            },
                          }
                        : {}),
                      onCopy: () => {
                        const end = turn.replies.at(-1) ?? turn.user
                        const index = detail.messages.findIndex(message => message.id === end?.id)
                        void (async () => {
                          if (!navigator.clipboard?.writeText) throw new Error('此浏览器不能复制，请手动选择记录')
                          await navigator.clipboard.writeText(
                            transcriptMarkdown({ ...detail, messages: detail.messages.slice(0, index + 1), liveText: '' }),
                          )
                        })().catch(error => onCopyError?.(error))
                      },
                    }
                  : undefined
              }
            />
          )
        })}
        {turns.length === 0 && standalone.length > 0 && (
          <div className="turn">
            <div className="turn-reply">
              {standalone.map(approval => (
                <ToolCard
                  key={approval.id}
                  message={null}
                  approval={approval}
                  busy={busy.get(approval.id)}
                  onDecide={onDecide}
                  gateFor={gateFor}
                />
              ))}
            </div>
          </div>
        )}
      </FileReferences>
    </FileSession.Provider>
  )
}
