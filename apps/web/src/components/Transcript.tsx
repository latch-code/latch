import { Fragment, memo, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Eraser, RotateCcw } from 'lucide-react'
import { type Approval, type HarnessInfo, type HarnessLogin, type Message, type TaskDetail, type TurnChanges } from '@latch/protocol'
import {
  deliveryWords,
  foldWords,
  quietGroupWords,
  rowKind,
  isBlocked,
  isLive,
  liveMessageId,
  outcomeWords,
  liveTurn,
  resendText,
  resendWarning,
  runEndLine,
  sameData,
  sideEffects,
  toolRowId,
  turnBlocks,
  turnModel,
  turnRoute,
  turnOutcome,
  turnTimes,
  workFolds,
  type TranscriptProjection,
  type Turn,
  type TurnOutcome,
  type WorkItem,
} from '../conversation.ts'
import { useTranscriptProjection } from '../conversation/useTranscriptProjection.ts'
import { ReplyViewport } from '../MessageContent.tsx'
import type { LoginSurface } from '../panel/terminal/loginRuns.ts'
import { TurnCards } from '../conversation/TurnCards.tsx'
import { RunEndNote, StatusLine, type StatusLineProps } from '../conversation/StatusLine.tsx'
import { FAILURE_ACTION_LABEL, failureAction, type FailureStep } from '../conversation/failureAction.ts'
import { PlanRow } from '../conversation/PlanRow.tsx'
import { TurnSummaryOptions, type TurnSummaryOptionsValue } from '../conversation/summaryOptions.ts'
import { announceChangesWrite, useChangesRevision, useTurnChanges } from '../conversation/useTurnChanges.ts'
import { messageTime } from '../format.ts'
import { usePreferences } from '../preferences.ts'
import { FileSession } from './FileChip.tsx'
import { FileReferences } from './FileReferences.tsx'
import { AuthorLine, MessageRow, SpeakerLine, ThinkingRow, TurnEditLocked, type LiveReasoning, type Speaker } from './MessageRow.tsx'
import { ToolCard } from './ToolCard.tsx'
import { KindGlyph } from '../conversation/KindGlyph.tsx'
import { SubagentGroup, SubagentRow, SubagentStop } from './SubagentRow.tsx'
import { QuestionResultCard } from '../composer/QuestionDrawer.tsx'
import { TurnFooter, type TurnRetry } from './TurnFooter.tsx'
import { VisibleText } from './VisibleText.tsx'
import { transcriptMarkdown } from '../exportMarkdown.ts'
import { useStableCallback } from '../hooks/useStableCallback.ts'
import { Button, Collapse, ICON_STROKE, StatusWord, useLivePrevious, ChevronRightGlyph, CloseGlyph, writeClipboard } from '@latch/ui'
import { ThinkingLine } from './SessionStatus.tsx'
import { defineCopy, formatNumber, plural, useLocale } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    forkBegin: '从「',
    forkEnd: (turn: number) => `」第 ${formatNumber(turn)} 轮分叉`,
    steps: (count: number) => `工作过程 · ${formatNumber(count)} 步`,
    trace: '工作过程',
    retry: '重试',
    cleared: '清空了上下文',
    cancel: '取消',
    demo: '演示',
    speakerStarted: (value1: string | number) => `${value1} 已开始`,
    otherService: '另一个模型服务',
    sourceSession: '返回来源会话',
  },
  {
    forkBegin: 'Forked from “',
    forkEnd: (turn: number) => `”, turn ${formatNumber(turn)}`,
    steps: (count: number) => `Work trace · ${plural(count, { one: '{n} step', other: '{n} steps' })}`,
    trace: 'Work trace',
    retry: 'Retry',
    cleared: 'Context cleared',
    cancel: 'Cancel',
    demo: 'Demo',
    speakerStarted: (value1: string | number) => `${value1} started`,
    otherService: 'Another model service',
    sourceSession: 'Back to source session',
  },
)

/** What resending the latest turn takes, when this device may send now. */
export interface RetryAccess {
  /** The session is a full-access one: the confirmation says it will not ask before each step. */
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
  observeStream?: boolean
  liveReasoning?: LiveReasoning
  coarse: boolean
  /** The connection is down: rows stop spinning and ticking. */
  frozen: boolean
  /** A helper's conversation: its reasoning reads 「在想」 and 「想了 N 秒」. */
  person: boolean
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

/** A run of finished reads, listings and searches as one row; opening it lists them as the rows they were. */
function ReadsRow({ messages, context }: { messages: Message[]; context: RowContext }) {
  const [open, setOpen] = useState(false)
  const locale = useLocale()
  const words = useMemo(() => quietGroupWords(messages), [locale, messages])
  return (
    <div className="reads-row" data-open={open ? '' : undefined}>
      <button
        type="button"
        className="process-row"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
        }}>
        <KindGlyph kind={messages.every(message => rowKind(message) === 'read') ? 'read' : 'search'} />
        <span className="process-label">
          <span className="process-object">{words}</span>
        </span>
        <ChevronRightGlyph className="process-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
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

const workItemKey = (item: WorkItem): string =>
  item.kind === 'reads'
    ? `reads:${item.messages[0]!.id}`
    : item.kind === 'steps'
      ? `steps:${workItemKey(item.items[0]!)}`
      : `${item.kind}:${item.message.id}`

/** The work a reader keeps folded: one row that says how many steps it holds and opens to them. */
function StepsRow({ items, count, context }: { items: WorkItem[]; count: number; context: RowContext }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="reads-row steps-row" data-open={open ? '' : undefined}>
      <button
        type="button"
        className="process-row"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
        }}>
        <KindGlyph kind="steps" />
        <span className="process-label">
          {/* Only tool steps are counted; a fold that holds nothing but thoughts says no number. */}
          <span className="process-object">{count > 0 ? COPY.steps(count) : COPY.trace}</span>
        </span>
        <ChevronRightGlyph className="process-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
      </button>
      <Collapse
        open={open}
        onReveal={() => {
          setOpen(true)
        }}>
        <div className="reads-rows">
          {items.map(item => (
            <WorkRow key={workItemKey(item)} item={item} context={context} />
          ))}
        </div>
      </Collapse>
    </div>
  )
}

/** Work items in order, with subagents a turn started one after another gathered into one block. */
function gathered(items: WorkItem[]): Array<WorkItem | { kind: 'team'; messages: Message[] }> {
  const rows: Array<WorkItem | { kind: 'team'; messages: Message[] }> = []
  for (const item of items) {
    const last = rows.at(-1)
    if (item.kind !== 'tool' || !item.message.subagent) rows.push(item)
    else if (last?.kind === 'team') last.messages.push(item.message)
    else rows.push({ kind: 'team', messages: [item.message] })
  }
  // One alone is a row like any other: a block of one says nothing more than its row.
  return rows.map(row => (row.kind === 'team' && row.messages.length === 1 ? { kind: 'tool' as const, message: row.messages[0]! } : row))
}

function WorkRow({ item, context, onRetry }: { item: WorkItem; context: RowContext; onRetry?: (() => void) | undefined }) {
  if (item.kind === 'steps') return <StepsRow items={item.items} count={item.count} context={context} />
  if (item.kind === 'reads') return <ReadsRow messages={item.messages} context={context} />
  if (item.kind === 'tool' && item.message.subagent) return <SubagentRow message={item.message} frozen={context.frozen} />
  if (item.kind === 'tool') return <ToolRow message={item.message} context={context} onRetry={onRetry} />
  const streaming = item.message.id === context.streamingId
  return (
    <ThinkingRow
      text={item.message.reasoning ?? ''}
      live={streaming && !item.message.text}
      streaming={streaming}
      observeStream={context.observeStream === true}
      reasoningMs={item.message.reasoningMs}
      liveTimes={streaming ? context.liveReasoning : undefined}
      frozen={context.frozen}
      person={context.person}
    />
  )
}

interface TurnViewProps {
  turn: Turn
  context: RowContext
  replyViewport?: RefObject<Element | null>
  /** Stands in for the Harness in what the status says, and beside it on the author line: only the demo model does. */
  engine?: string
  harnessName: string
  /** 我的 Agent's conversation: the helper answers, and the Harness and model are not named. */
  speaker?: Speaker
  /** How to log in to this session's harness, shown when a turn ends for want of it. */
  login?: { harnessId: string; login: HarnessLogin; surface: LoginSurface } | undefined
  harness?: Pick<HarnessInfo, 'capabilities' | 'level' | 'permission'> | undefined
  /** The model that answered, or that the run uses before its first step records one, and its service's name. */
  model?: string
  provider?: string
  /** The model the session had chosen, when another one answered: the author line says both. */
  chosen?: { model: string; reported: boolean }
  /** A 「出错时改用」 service answered this turn: its name. */
  fallback?: string
  trailingLive: boolean
  latest: boolean
  outcome?: TurnOutcome
  /** The page saw this turn arrive: its prompt rises in. */
  arrived: boolean
  /** The model or thinking changed from the turn before: what changed, as `from → to`. */
  switched?: string
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
  /** 交给代码任务… with the chosen messages. */
  onHandoff?: (messageIds: string[]) => void
  onContinue?: () => void
  /** 已核对 on the run's end line. */
  checkUnknown?: boolean
  /** The failure steps this device can take, and how. */
  onFailureStep?: FailureSteps
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
    if (key === 'harness' || key === 'changes' || key === 'plan' || key === 'login' || key === 'speaker') return sameData(a[key], b[key])
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

/** Only body-frame fields are omitted; a new detail or summary field remains part of the history key. */
function historyDetail(detail: TaskDetail): Record<string, unknown> {
  const { liveText: _text, liveReasoning: _reasoning, cursor: _cursor, sync: _sync, lastOutputAt: _output, ...rest } = detail
  const { updatedAt: _updated, live, ...summary } = detail.summary
  const { lastEventAt: _event, lastOutputAt: _liveOutput, ...phase } = live ?? {}
  return { ...rest, summary: { ...summary, ...(live ? { live: phase } : {}) } }
}

const HISTORY_DATA = new Set(['detail', 'approvals', 'harness', 'login', 'speaker', 'changes', 'failureSteps', 'retry'])

/** New props compare by identity unless they are one of the JSON values whose every field we already read. */
function sameHistoryInputs(before: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const keys = Object.keys(before)
  return (
    keys.length === Object.keys(next).length
    && keys.every(
      key => Object.hasOwn(next, key) && (Object.is(before[key], next[key]) || (HISTORY_DATA.has(key) && sameData(before[key], next[key]))),
    )
  )
}

const TURNS_PER_GROUP = 24

interface TurnGroups {
  byTurn: Map<string, number>
  nextId: number
  starts: { id: number; index: number }[]
}

function groupTurns(turns: readonly Turn[], previous: TurnGroups | undefined): TurnGroups {
  const known = turns.map(turn => previous?.byTurn.get(turn.key))
  const upcoming = [...known]
  for (let index = upcoming.length - 2; index >= 0; index--) upcoming[index] ??= upcoming[index + 1]

  const byTurn = new Map<string, number>()
  const starts: TurnGroups['starts'] = []
  const used = new Set<number>()
  let nextId = previous?.nextId ?? 0
  for (const [index, turn] of turns.entries()) {
    const last = starts.at(-1)
    const oldId = known[index]
    // Keep newly inserted content between members of the same group inside it, even when it was already full.
    if (last && (oldId === last.id || (oldId === undefined && (last.id === upcoming[index] || index - last.index < TURNS_PER_GROUP)))) {
      byTurn.set(turn.key, last.id)
      continue
    }
    // A reordered snapshot can split an old group into multiple runs. Its key can only be used once.
    const id = oldId !== undefined && !used.has(oldId) ? oldId : nextId++
    starts.push({ id, index })
    used.add(id)
    byTurn.set(turn.key, id)
  }
  return { byTurn, nextId, starts }
}

// A stable group lets React skip its children on body-only frames. It adds no DOM parent to the turn list.
const TurnGroup = memo(function TurnGroup({ rows }: { rows: ReactNode[] }) {
  return rows
})

/** A line across the conversation where the session itself changed between two turns. */
function TimelineDivider({ icon: Glyph, text }: { icon?: typeof Eraser; text: string }) {
  return (
    <div className="timeline-divider" role="note">
      <span>
        {Glyph && <Glyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />}
        {text}
      </span>
    </div>
  )
}

/**
 * A failed note's own next step, when its code names one this device can take: 设置 › Harness or 模型服务, or a new session
 * from this one's record. `none`: no button at all (the project recovery panel already offers the way on).
 */
interface FailureSteps {
  has(step: FailureStep): boolean
  take(step: FailureStep): void
}

function failureStep(
  message: Message,
  onStep: FailureSteps | undefined,
  onContinue: (() => void) | undefined,
): { kind: string; label: string; run: () => void } | undefined {
  if (message.role !== 'system' || message.state !== 'failed') return undefined
  const kind = failureAction(message.errorCode)
  if (kind === 'none') return { kind, label: '', run: () => {} }
  if (kind === 'continue') return onContinue ? { kind, label: FAILURE_ACTION_LABEL.continue, run: onContinue } : undefined
  if (kind === 'retry' || !onStep?.has(kind)) return undefined
  return { kind, label: FAILURE_ACTION_LABEL[kind], run: () => onStep.take(kind) }
}

/** Why a turn did not simply finish, on a line that stays: a failed one in red with 重试, a stopped one quietly. */
function OutcomeRecord({ turn, outcome, onRetry }: { turn: Turn; outcome: TurnOutcome; onRetry?: (() => void) | undefined }) {
  const words = outcomeWords(turn, outcome)
  if (words.length === 0) return null
  const at = turnTimes(turn).sentAt
  return (
    <p className={`turn-record outcome-${outcome}`}>
      {outcome === 'failed' && (
        <span className="process-slot" aria-hidden="true">
          <CloseGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />
        </span>
      )}
      <span>{[...words.slice(0, 1), ...(at !== undefined ? [messageTime(at, Date.now())] : []), ...words.slice(1)].join(' · ')}</span>
      {outcome === 'failed' && onRetry && (
        <Button size="xs" variant="ghost" icon={RotateCcw} onClick={onRetry}>
          {COPY.retry}
        </Button>
      )}
    </p>
  )
}

const TurnView = memo(function TurnView({
  login,
  turn,
  replyViewport,
  engine,
  harnessName,
  speaker,
  harness,
  model,
  provider,
  chosen,
  fallback,
  trailingLive,
  latest,
  outcome,
  arrived,
  status,
  delivery,
  summary,
  plan,
  context: rowContext,
  switched,
  retry,
  reportedContext,
  onForkFrom,
  onCopyUpTo,
  onEdit,
  onHandoff,
  onContinue,
  checkUnknown,
  onFailureStep,
  changes,
  sessionActive,
  changesRevision,
  changesEnabled,
  onChangesError,
}: TurnViewProps) {
  useLocale()
  const [tapped, setTapped] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [foldChoice, setFoldChoice] = useState<boolean | null>(null)
  // 工作过程, this device's choice: what always shows (approvals, failures, unknown results) is never among what it hides.
  const level = usePreferences().workDisplay
  const blocks = useMemo(() => turnBlocks(turn, level), [turn, level])
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
  // A helper speaks for itself; only a login, which the person must do in the Harness, names the Harness.
  // Until the live turn's text arrives, one quiet mark stands where it will be; then the text speaks for itself.
  const writing = trailingLive && turn.replies.some(reply => reply.id === rowContext.streamingId && reply.text !== '')
  const thinking = trailingLive && !writing && summary?.status === 'running' && summary.live ? summary.live : undefined
  const voice = speaker?.name ?? engine ?? harnessName
  const endVoice = summary?.runEnd?.reason === 'login-required' ? harnessName : voice
  const runEnd = summary && !trailingLive && latest ? runEndLine(summary, endVoice) : undefined
  const pressRetry = useStableCallback(() => {
    if (retry?.warning) setConfirming(true)
    else retry?.onResend()
  })
  const onRetry = retry ? pressRetry : undefined
  // One 重试 in the turn's reading order: on what failed last. A call the harness refused itself did not fail.
  const failedHere = (message: Message) =>
    (message.role === 'tool' || message.role === 'system') && message.state === 'failed' && !isBlocked(message)
  const lastFailed = turn.replies.findLast(failedHere)?.id
  // A failure says itself once: a failed note or row already has the words, and the run's end note has its own.
  const speaksFailure = turn.replies.some(failedHere)
  const showOutcome = outcome !== undefined && outcome !== 'completed' && !runEnd && !(outcome === 'failed' && speaksFailure)
  return (
    <div className="turn" data-turn={turn.key} data-settled={latest ? undefined : ''}>
      {turn.user?.freshContext && <TimelineDivider icon={Eraser} text={COPY.cleared} />}
      {switched && !speaker && <TimelineDivider text={switched} />}
      {turn.user && (
        <MessageRow
          message={turn.user}
          coarse={rowContext.coarse}
          arrived={arrived}
          harness={speaker ? speaker.name : harnessName}
          {...(speaker ? { voice: speaker.name } : {})}
          {...(delivery ? { delivery } : {})}
          {...(onEdit ? { onEdit } : {})}
          {...(onHandoff ? { onHandoff } : {})}
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
          {speaker ? (
            <SpeakerLine speaker={speaker} demo={engine !== undefined} />
          ) : (
            <AuthorLine
              name={harnessName}
              engine={engine}
              harness={harness}
              model={model}
              provider={provider}
              chosen={chosen}
              fallback={fallback}
            />
          )}
          {!trailingLive && hasWork && (
            <button
              type="button"
              className="work-fold"
              aria-expanded={workOpen}
              onClick={() => {
                setFoldChoice(!workOpen)
              }}>
              <span>{foldWords(turn)}</span>
              <ChevronRightGlyph className="process-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
            </button>
          )}
          {plan && plan.length > 0 && <PlanRow plan={plan} active={trailingLive} />}
          {blocks.map(block => {
            if (block.kind === 'prose') {
              const streaming = block.message.id === rowContext.streamingId
              return (
                <ReplyViewport.Provider key={block.message.id} value={replyViewport}>
                  <MessageRow
                    message={block.message}
                    streaming={streaming}
                    observeStream={rowContext.observeStream === true}
                    frozen={rowContext.frozen}
                    coarse={rowContext.coarse}
                  />
                </ReplyViewport.Provider>
              )
            }
            if (block.kind === 'note') {
              if (block.message.role === 'tool') return <QuestionRow key={block.message.id} message={block.message} context={rowContext} />
              // The run's end line says the same and offers the same 重试; the note is the record once a later turn replaces it.
              if (runEnd && (block.message.state === 'failed' || block.message.interrupted)) return null
              const action = failureStep(block.message, onFailureStep, onContinue)
              return (
                <MessageRow
                  key={block.message.id}
                  message={block.message}
                  coarse={rowContext.coarse}
                  {...(speaker ? { voice: speaker.name } : {})}
                  {...(onRetry && action?.kind !== 'none' ? { onRetry } : {})}
                  {...(action && action.kind !== 'none' ? { action } : {})}
                />
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
                  {gathered(block.items).map(item =>
                    item.kind === 'team' ? (
                      <SubagentGroup key={`team:${item.messages[0]!.id}`} messages={item.messages} frozen={rowContext.frozen} />
                    ) : (
                      <WorkRow
                        key={workItemKey(item)}
                        item={item}
                        context={rowContext}
                        onRetry={!runEnd && item.kind === 'tool' && item.message.id === lastFailed ? onRetry : undefined}
                      />
                    ),
                  )}
                </div>
              </Collapse>
            )
          })}
          {thinking && <ThinkingLine live={thinking} />}
          {!trailingLive && (
            <TurnCards
              sessionId={rowContext.sessionId}
              turn={turn}
              record={changes}
              revision={changesRevision}
              enabled={changesEnabled}
              engine={voice}
              active={sessionActive}
              outputs={outputs}
              onError={onChangesError}
            />
          )}
          {status && <StatusLine {...status} />}
          {runEnd && summary && (
            <RunEndNote
              summary={summary}
              harness={endVoice}
              onRetry={onRetry}
              onContinue={onContinue}
              login={login}
              shown={new Set(turn.replies.map(message => message.id))}
              canCheck={checkUnknown === true}
              {...(onChangesError ? { onError: onChangesError } : {})}
            />
          )}
          {showOutcome && <OutcomeRecord turn={turn} outcome={outcome} onRetry={onRetry} />}
          {retry?.warning && (
            <Collapse open={confirming}>
              <div
                className="turn-retry-confirm"
                role="group"
                aria-label={COPY.retry}
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
                    {COPY.cancel}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      setConfirming(false)
                      retry.onResend()
                    }}>
                    {COPY.retry}
                  </Button>
                </div>
              </div>
            </Collapse>
          )}
          <TurnFooter
            key={turn.key}
            turn={turn}
            live={trailingLive}
            outcome={outcome}
            pinned={tapped || (latest && rowContext.coarse)}
            context={reportedContext}
            worked={hasWork}
            person={speaker !== undefined}
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
                    ...(onHandoff && turn.replies.some(message => message.role === 'assistant' && message.text.trim())
                      ? {
                          onHandoff: () => {
                            onHandoff(
                              turn.replies
                                .filter(message => message.role === 'assistant' && message.text.trim())
                                .map(message => message.id),
                            )
                          },
                        }
                      : {}),
                  }
                : undefined
            }
          />
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
interface TranscriptProps {
  detail: TaskDetail
  projection?: TranscriptProjection
  /** The known nearest scrollport for ordinary reply Markdown. */
  replyViewport?: RefObject<Element | null>
  approvals: Approval[]
  /** This device's approval buttons; omitted, every offered option is shown. */
  harnessName: string
  /**
   * A conversation of 我的 Agent: each turn opens with the helper's face and name, and the Harness, the model and the
   * turn's tokens are not shown. Code's sessions pass none.
   */
  speaker?: Speaker
  /** How to log in to this session's harness, shown when a turn ends for want of it. */
  login?: { harnessId: string; login: HarnessLogin; surface: LoginSurface } | undefined
  /** The session's harness, for the tile on each turn's author line. */
  harness?: Pick<HarnessInfo, 'capabilities' | 'level' | 'permission'> | undefined
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
  /** The reply is exposed on the front conversation surface, even when the session is retained under another page. */
  observeStream?: boolean
  /** Present when this device may send now: the latest turn offers 重试. */
  retry?: RetryAccess
  /** Forks up to a message, with a draft in the composer. */
  onFork?: (upToMessageId: string, draft?: string) => void
  /**
   * 从这里编辑 on one of the person's messages: `before` is the message it follows (none for the first), where the
   * conversation goes on from with the edited message.
   */
  onEditFrom?: (message: Message, before: string | undefined) => void
  /** This device may mark a run's unknown results checked (已核对). */
  checkUnknown?: boolean
  /** Takes a failure's next step: 设置 › Harness or 模型服务 (only where this device can change them), or the model menu. */
  failureSteps?: readonly FailureStep[]
  onFailureStep?: (step: FailureStep) => void
  /** Opens the session a fork came from. */
  onSource?: (sessionId: string) => void
  onCopyError?: (error: unknown) => void
  onStop?: () => void
  /** Stops one subagent that can be stopped alone, by its row's ID; rejects when that failed, after saying so. */
  onStopSubagent?: (subagentId: string) => Promise<void>
  /** Brings a row into view, for what the status line points at. */
  onReveal?: (messageId: string) => void
  /** The Host's per-turn records and what this device may do with them. */
  changes?: Pick<TurnSummaryOptionsValue, 'undo' | 'offline'> & { enabled: boolean }
  /** 交给代码任务… from a message or a turn's reply. */
  onHandoff?: (messageIds: string[]) => void
  /**
   * Records that sit in the timeline by when they arrived (a handoff's returned result): each after the last turn that
   * began before it, '' before every turn. Given the turns' keys and start times, it answers what goes where.
   */
  placed?: (turns: ReadonlyArray<{ key: string; at: number | undefined }>) => ReadonlyMap<string, ReactNode>
}

export function Transcript(props: TranscriptProps) {
  const locale = useLocale()
  const {
    login,
    detail,
    replyViewport,
    approvals,
    harnessName,
    speaker,
    harness,
    demo = false,
    active = false,
    cancelling = false,
    coarse = false,
    providerName,
    fallbackElapsed,
    frozenAt,
    observeStream,
    retry,
    onFork,
    onEditFrom,
    onSource,
    onCopyError,
    onStop,
    onStopSubagent,
    onReveal,
    changes,
    onHandoff,
    placed,
    failureSteps,
    onFailureStep,
    checkUnknown,
  } = props
  const ownProjection = useTranscriptProjection(props.projection ? null : detail)
  const projection = props.projection ?? ownProjection
  const tail = liveTurn(projection, detail)
  const switches = projection.switches
  const liveId = isLive(detail) ? liveMessageId(detail) : undefined
  const forkFrom = useStableCallback((messageId: string) => onFork?.(messageId))
  const copyUpTo = useStableCallback((messageId: string) => {
    const index = detail.messages.findIndex(message => message.id === messageId)
    writeClipboard(transcriptMarkdown({ ...detail, messages: detail.messages.slice(0, index + 1), liveText: '' })).catch(error =>
      onCopyError?.(error),
    )
  })
  const editFrom = useStableCallback((message: Message) => {
    if (active) return
    const index = detail.messages.findIndex(item => item.id === message.id)
    if (index >= 0) onEditFrom?.(message, detail.messages[index - 1]?.id)
  })
  const continueRun = useStableCallback(() => {
    const last = detail.messages.at(-1)
    if (last) onFork?.(last.id, '请接着这个会话继续。')
  })
  const changesError = useStableCallback((error: unknown) => onCopyError?.(error))
  // Stable, so a settled turn does not draw again when the shell hands down a new function.
  const failureStepTaken = useStableCallback((step: FailureStep) => onFailureStep?.(step))
  const steps = useMemo(
    (): FailureSteps | undefined =>
      failureSteps?.length ? { has: step => failureSteps.includes(step), take: failureStepTaken } : undefined,
    [failureSteps, failureStepTaken],
  )
  const handoff = useStableCallback((messageIds: string[]) => onHandoff?.(messageIds))
  const leadKey = projection.turns.length ? undefined : tail?.key
  const turnIndex = useMemo(() => (leadKey ? [{ key: leadKey, at: undefined }] : projection.index), [projection, leadKey])
  // Legacy/plugin details may settle a synthetic reply before committing any message; keep its run-record target.
  const recordTurns = useMemo<Turn[]>(() => (leadKey ? [{ key: leadKey, replies: [] }] : projection.turns), [projection, leadKey])
  const inserts = useMemo(() => placed?.(turnIndex), [placed, turnIndex])
  // Stable, so the subagent rows under it do not draw again with every render of the page.
  const stopSubagent = useStableCallback((subagentId: string) => onStopSubagent!(subagentId))
  const lastKey = tail?.key ?? ''
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
  const records = useTurnChanges(sessionId, recordTurns, {
    enabled: changes?.enabled === true,
    revision: changesRevision,
    active,
    ...(detail.summary.runId ? { latestRunId: detail.summary.runId } : {}),
  })
  // Until the Host has recorded the run that just ended, every turn's undo reads 运行中: the session's one poll of its
  // records (above) sees them move on, and each card in view reads its own list again.
  const recordsRead = useRef({ records, count: 0 })
  if (recordsRead.current.records !== records) recordsRead.current = { records, count: recordsRead.current.count + 1 }
  const cardsRevision = `${changesRevision}\n${recordsRead.current.count}`
  const summaryOptions = useMemo<TurnSummaryOptionsValue>(
    () => ({
      undo: changes?.undo ?? 'read-only',
      offline: changes?.offline === true,
      refresh: () => {
        refreshChanges()
        announceChangesWrite(sessionId, 'conversation')
      },
    }),
    [changes?.undo, changes?.offline, refreshChanges, sessionId],
  )
  const frozen = frozenAt !== undefined
  const engine = demo ? COPY.demo : undefined
  const statusProps: StatusLineProps = {
    detail,
    messageFacts: projection.messageFacts,
    harness: speaker?.name ?? engine ?? harnessName,
    ...(speaker ? { person: true } : {}),
    cancelling,
    approvals: approvals.length,
    ...(fallbackElapsed !== undefined ? { fallbackElapsed } : {}),
    ...(frozenAt !== undefined ? { frozenAt } : {}),
    ...(onStop ? { onStop } : {}),
    ...(onReveal ? { onView: onReveal } : {}),
    onError: changesError,
  }
  const renderTurn = (turn: Turn, index: number, latest: boolean) => {
    const trailingLive = latest && active
    const outcome = trailingLive ? undefined : turnOutcome(turn, latest ? detail.summary.status : undefined)
    const resend =
      latest && !trailingLive && retry && turn.user
        ? {
            warning: resendWarning(sideEffects(turn)),
            onResend: () => {
              retry.onResend(resendText(turn.user!))
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
    const route = trailingLive ? undefined : turnRoute(turn)
    const providerId = stamped?.model ? stamped.providerId : trailingLive ? detail.summary.providerId : undefined
    const said = trailingLive && !frozen ? deliveryWords(detail, turn) : undefined
    // A helper has begun on it, not a Harness.
    const delivery = speaker && said && detail.summary.live?.activity !== 'starting' ? COPY.speakerStarted(speaker.name) : said
    const record = records.get(turn.key)
    const hasChangeRecord = changes?.enabled === true && record !== undefined
    return (
      <Fragment key={turn.key}>
        <TurnView
          key={turn.key}
          turn={turn}
          replyViewport={replyViewport}
          context={{
            sessionId,
            approvals: ownApprovals,
            questions: ownQuestions,
            ...(streaming ? { streamingId: liveId } : {}),
            ...(streaming && observeStream ? { observeStream: true } : {}),
            ...(streaming ? { liveReasoning: { startedAt: detail.liveReasoningStartedAt, ms: detail.liveReasoningMs } } : {}),
            coarse,
            frozen: frozen && trailingLive,
            person: speaker !== undefined,
          }}
          {...(engine ? { engine } : {})}
          harnessName={harnessName}
          {...(speaker ? { speaker } : {})}
          login={login}
          harness={harness}
          model={
            route?.fallback?.model
            ?? (route?.differs && !route.direct ? route.answered : (stamped?.model ?? (trailingLive ? detail.summary.model : undefined)))
          }
          provider={providerId ? providerName?.(providerId) : undefined}
          {...(route?.differs && !route.fallback && !route.direct ? { chosen: { model: route.chosen!, reported: route.reported } } : {})}
          {...(route?.fallback ? { fallback: providerName?.(route.fallback.providerId) ?? COPY.otherService } : {})}
          latest={latest}
          trailingLive={trailingLive}
          outcome={outcome}
          arrived={latest && previousLast !== undefined && previousLast !== lastKey}
          {...(switches.has(turn.key) ? { switched: switches.get(turn.key)! } : {})}
          {...(trailingLive ? { status: statusProps } : {})}
          {...(delivery ? { delivery } : {})}
          {...(latest ? { summary: detail.summary } : {})}
          {...(latest && detail.plan?.length ? { plan: detail.plan } : {})}
          retry={resend}
          reportedContext={latest ? detail.usageReport?.contextUsed : undefined}
          onForkFrom={!trailingLive && onFork ? forkFrom : undefined}
          onCopyUpTo={!trailingLive ? copyUpTo : undefined}
          {...(onEditFrom ? { onEdit: editFrom } : {})}
          {...(onFork ? { onContinue: continueRun } : {})}
          {...(latest && checkUnknown ? { checkUnknown: true } : {})}
          {...(steps ? { onFailureStep: steps } : {})}
          {...(record ? { changes: record } : {})}
          sessionActive={active && hasChangeRecord}
          changesRevision={hasChangeRecord ? cardsRevision : ''}
          changesEnabled={changes?.enabled === true}
          onChangesError={changesError}
          {...(onHandoff && !trailingLive ? { onHandoff: handoff } : {})}
        />
        {inserts?.get(turn.key)}
      </Fragment>
    )
  }
  const historyInputs = {
    ...props,
    locale,
    detail: historyDetail(detail),
    fallbackElapsed: undefined,
    onFork: !!onFork,
    onEditFrom: !!onEditFrom,
    onSource: !!onSource,
    onCopyError: !!onCopyError,
    onStop: !!onStop,
    onStopSubagent: !!onStopSubagent,
    onReveal: !!onReveal,
    onHandoff: !!onHandoff,
    onFailureStep: !!onFailureStep,
    retry: retry ? { ...retry, onResend: true } : undefined,
    projection,
    currentLiveId: liveId,
    records,
    inserts,
    cardsRevision,
    steps,
  }
  const history = useRef<
    | {
        inputs: Record<string, unknown>
        sessionId: string
        grouping: TurnGroups
        groups: ReactNode[]
        remainder: ReactNode[]
      }
    | undefined
  >(undefined)
  if (!history.current || !sameHistoryInputs(history.current.inputs, historyInputs)) {
    const grouping = groupTurns(projection.turns, history.current?.sessionId === sessionId ? history.current.grouping : undefined)
    const elements = projection.history.map((turn, index) => renderTurn(turn, index, false))
    const groups = grouping.starts
      .slice(0, -1)
      .map(({ id, index }, group) => <TurnGroup key={id} rows={elements.slice(index, grouping.starts[group + 1]!.index)} />)
    history.current = { inputs: historyInputs, sessionId, grouping, groups, remainder: elements.slice(grouping.starts.at(-1)?.index ?? 0) }
  }
  const { groups, remainder, grouping } = history.current
  const rows = tail
    ? [
        ...groups,
        <TurnGroup key={grouping.starts.at(-1)?.id ?? 0} rows={[...remainder, renderTurn(tail, projection.history.length, true)]} />,
      ]
    : groups

  return (
    <FileSession.Provider value={fileSession}>
      <SubagentStop.Provider value={onStopSubagent ? stopSubagent : undefined}>
        <TurnSummaryOptions.Provider value={summaryOptions}>
          <FileReferences sessionId={sessionId} active={active}>
            {/* A conversation that moved shows its earlier record itself, above its line: no note of a fork. */}
            {detail.summary.forkOf && !detail.summary.forkOf.moved && (
              <p className="fork-origin">
                {COPY.forkBegin}
                {onSource ? (
                  <button type="button" aria-label={COPY.sourceSession} onClick={() => onSource(detail.summary.forkOf!.taskId)}>
                    <VisibleText text={detail.summary.forkOf.title} />
                  </button>
                ) : (
                  <VisibleText text={detail.summary.forkOf.title} />
                )}
                {COPY.forkEnd(detail.summary.forkOf.turn)}
              </p>
            )}
            {inserts?.get('')}
            <TurnEditLocked.Provider value={active}>{rows}</TurnEditLocked.Provider>
          </FileReferences>
        </TurnSummaryOptions.Provider>
      </SubagentStop.Provider>
    </FileSession.Provider>
  )
}
