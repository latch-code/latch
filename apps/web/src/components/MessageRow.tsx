import { MentionedText } from './MentionedText.tsx'
import { MessageAttachments } from './MessageAttachments.tsx'
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Brain, ChevronRight, Info, RotateCcw, Undo2, X } from 'lucide-react'
import { splitChangeNote, type HarnessInfo, type Message } from '@latch/protocol'
import { MessageContent } from '../MessageContent.tsx'
import { hostNow, parseDuration, parseTime, useTicker } from '../core/hostClock.ts'
import { absoluteTime, formatDuration, messageTime } from '../format.ts'
import { HarnessTile } from './BrandTile.tsx'
import { VisibleText } from './VisibleText.tsx'
import { Button, Collapse, ICON_STROKE, IconButton, Shimmer, Swap, Tooltip, CopyButton } from '@latch/ui'

/** Times of the live reply's reasoning, which the Host reports on the detail while it streams. */
export interface LiveReasoning {
  startedAt?: string
  ms?: number
}

/**
 * A time the Host recorded, as a `<time>` with the full date in its tooltip (or `tip`, given the time now: a turn's
 * start, end and duration); it rolls over at midnight.
 */
export function TimeLabel({ at, tip }: { at: number; tip?: (now: number) => ReactNode }) {
  const now = useTicker('minute')
  return (
    <Tooltip content={tip?.(now) ?? absoluteTime(at)}>
      <time dateTime={new Date(at).toISOString()} tabIndex={0}>
        {messageTime(at, now)}
      </time>
    </Tooltip>
  )
}

/**
 * Reasoning the model reported, as a work row: while it streams, 「思考中」 with its light crossing it and the seconds
 * since it began; once the answer starts, 「思考了 6 秒」. The body opens by itself while the reasoning streams and folds
 * away as the answer starts; the reader's own choice wins. Without times it is 「思考过程」.
 */
export function ThinkingRow({
  text,
  live,
  streaming,
  reasoningMs,
  liveTimes,
  frozen = false,
}: {
  text: string
  /** Reasoning still streams and no answer text has come yet. */
  live: boolean
  /** The block is the live reply. */
  streaming: boolean
  reasoningMs?: number
  liveTimes?: LiveReasoning
  /** The connection is down: nothing is known to move, so it neither shimmers nor counts. */
  frozen?: boolean
}) {
  const [choice, setChoice] = useState<boolean | null>(null)
  const open = choice ?? live
  const started = parseTime(liveTimes?.startedAt)
  // Re-renders every second while the live reasoning counts up.
  useTicker(live && !frozen && started !== undefined ? 'second' : false)
  const settledMs = streaming ? parseDuration(liveTimes?.ms) : parseDuration(reasoningMs)
  const thought = settledMs === undefined ? undefined : formatDuration(settledMs)
  const elapsed = live && !frozen && started !== undefined ? formatDuration(hostNow() - started, true) : undefined
  return (
    <div className={`thinking ${live && !frozen ? 'is-live' : ''}`}>
      <button
        type="button"
        className="process-row thinking-toggle"
        aria-expanded={open}
        onClick={() => {
          setChoice(!open)
        }}>
        <span className="process-slot" aria-hidden="true">
          <Brain size={16} strokeWidth={ICON_STROKE[16]} />
        </span>
        {/* When the answer starts the label cross-fades from the live one to the time it took. */}
        <Swap value={live ? 'live' : 'settled'} effect="fade" className="thinking-label">
          {live ? frozen ? '思考中' : <Shimmer>思考中</Shimmer> : thought ? `思考了 ${thought}` : '思考过程'}
        </Swap>
        <ChevronRight className="process-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        {elapsed && (
          <span className="process-time" aria-hidden="true">
            {elapsed}
          </span>
        )}
      </button>
      <Collapse
        open={open}
        onReveal={() => {
          setChoice(true)
        }}>
        <div className="thinking-body">
          <div className="thinking-scroll">
            <p className="reasoning-text">{text}</p>
          </div>
        </div>
      </Collapse>
    </div>
  )
}

/**
 * The line that opens every agent turn. The word is the Agent, and the engine that ran it follows as secondary text with
 * the model that answered, when the Host recorded one.
 */
export function AuthorLine({
  name,
  engine,
  harness,
  model,
  provider,
}: {
  name: string
  /** The engine's name, when it is not already the word. */
  engine?: string
  harness?: Pick<HarnessInfo, 'id' | 'source'>
  model?: string
  /** The model service's name, for the model's tooltip. */
  provider?: string
}) {
  const detail = [engine, model].filter(Boolean).join(' · ')
  return (
    <div className="assistant-meta">
      {/* The turn's source, not the harness's state now: the tile never draws readiness here. */}
      <HarnessTile harness={harness ? { id: harness.id, source: harness.source } : { id: 'standard', source: 'builtin' }} size={16} />
      <span className="assistant-meta-name">{name}</span>
      {detail && (
        <Tooltip content={provider}>
          <span className="assistant-meta-model">{detail}</span>
        </Tooltip>
      )}
    </div>
  )
}

/** A bubble taller than this clamps behind a fade with 「显示全部」. */
const BUBBLE_CLAMP = 176

function UserMessage({
  message,
  coarse,
  arrived,
  delivery,
  onEdit,
}: {
  message: Message
  coarse: boolean
  arrived: boolean
  delivery?: string
  onEdit?: (message: Message) => void
}) {
  const at = parseTime(message.createdAt)
  const queuedAt = parseTime(message.queuedAt)
  const [shown, setShown] = useState(false)
  const bubble = useRef<HTMLDivElement>(null)
  const [tall, setTall] = useState(false)
  const [whole, setWhole] = useState(false)
  useLayoutEffect(() => {
    const element = bubble.current
    if (element) setTall(element.scrollHeight > BUBBLE_CLAMP + 1)
  }, [message.text])
  // What an undo told the engine sits in front of the words the person wrote; it is a record, not part of the bubble.
  const { note, text } = splitChangeNote(message.text.slice(message.forkContext?.prefixLength ?? 0))
  return (
    <article
      className="message message-user"
      data-message-id={message.id}
      data-arrived={arrived ? '' : undefined}
      data-shown={shown ? '' : undefined}
      onClick={
        coarse
          ? event => {
              // A tap on the bubble shows its time and copy, a second tap hides them.
              if (!(event.target instanceof Element && event.target.closest('button, a, time'))) setShown(!shown)
            }
          : undefined
      }>
      {note && (
        <Tooltip content={note}>
          <p className="message-change-note" tabIndex={0}>
            已告诉 Harness 改动被撤销了
          </p>
        </Tooltip>
      )}
      <MessageAttachments attachments={message.attachments} />
      {message.text && (
        <div className="user-bubble" data-clamped={tall && !whole ? '' : undefined}>
          <div className="user-bubble-text" ref={bubble}>
            {message.forkContext && (
              <details className="fork-context">
                <summary>
                  以下是会话「
                  <VisibleText text={message.forkContext.title} />
                  」到第 {message.forkContext.turn} 轮为止的记录
                </summary>
                <pre>
                  <VisibleText text={message.text.slice(0, message.forkContext.prefixLength)} />
                </pre>
              </details>
            )}
            <MentionedText text={text} refs={message.fileRefs} />
          </div>
          {tall && (
            <button
              type="button"
              className="user-bubble-more"
              onClick={() => {
                setWhole(!whole)
              }}>
              {whole ? '收起' : '显示全部'}
            </button>
          )}
        </div>
      )}
      {delivery ? (
        <p className="message-delivery" role="status">
          {delivery}
        </p>
      ) : (
        <div className="message-meta">
          {at !== undefined && (
            <TimeLabel at={at} tip={queuedAt !== undefined ? () => `${absoluteTime(at)} · 排队于 ${absoluteTime(queuedAt)}` : undefined} />
          )}
          {text && <CopyButton text={text} label="复制" size="xs" />}
          {onEdit && (
            <IconButton
              icon={Undo2}
              size="xs"
              label="从这里编辑"
              onClick={() => {
                onEdit(message)
              }}
            />
          )}
        </div>
      )}
    </article>
  )
}

/**
 * A note: a quiet record line (「已停止」, a model switch). One that reports a failure (a model-service error, an interrupted
 * run) is a failed row: a red ✕, its reason, and 重试 when this device may resend the turn.
 */
function SystemNote({ message, onRetry }: { message: Message; onRetry?: () => void }) {
  const failed = message.state === 'failed'
  const Icon = failed ? X : Info
  return (
    <article className={`message message-system${failed ? ' is-failed' : ''}`} data-message-id={message.id}>
      <span className="process-slot" aria-hidden="true">
        <Icon size={12} strokeWidth={ICON_STROKE[12]} />
      </span>
      <p>{message.text}</p>
      {failed && onRetry && (
        <Button size="xs" variant="ghost" icon={RotateCcw} onClick={onRetry}>
          重试
        </Button>
      )}
    </article>
  )
}

/**
 * One message row: the person's bubble (with its time, copy and 从这里编辑), an answer block's prose, or a note. The
 * author line opens the reply, a block's reasoning is a work row and the footer follows the last row (Transcript).
 */
export const MessageRow = memo(
  function MessageRow({
    message,
    streaming = false,
    frozen = false,
    coarse = false,
    arrived = false,
    delivery,
    onEdit,
    onRetry,
  }: {
    message: Message
    streaming?: boolean
    /** The connection is down: the caret stops saying more is coming. */
    frozen?: boolean
    /** Touch: a tap shows a message's time and actions. */
    coarse?: boolean
    /** The page saw the prompt arrive: its bubble rises in. */
    arrived?: boolean
    /** How far this prompt has got, while the agent has not answered. */
    delivery?: string
    /** Forks before this prompt with its text in the composer. */
    onEdit?: (message: Message) => void
    /** Resends the turn, from a failed note. */
    onRetry?: () => void
  }) {
    if (message.role === 'user')
      return <UserMessage message={message} coarse={coarse} arrived={arrived} delivery={delivery} onEdit={onEdit} />
    if (message.role === 'system') return <SystemNote message={message} onRetry={onRetry} />
    return (
      <article
        className={`message message-assistant ${streaming && !frozen ? 'is-live' : ''}`}
        data-message-id={message.id}
        aria-label={streaming ? '正在生成的回复' : undefined}>
        <MessageAttachments attachments={message.attachments} />
        {message.text && (
          <div className="message-text">
            <MessageContent text={message.text} streaming={streaming} />
          </div>
        )}
      </article>
    )
  },
  (a, b) =>
    a.streaming === b.streaming
    && a.frozen === b.frozen
    && a.coarse === b.coarse
    && a.arrived === b.arrived
    && a.delivery === b.delivery
    && a.onEdit === b.onEdit
    && a.onRetry === b.onRetry
    && a.message.id === b.message.id
    && a.message.text === b.message.text
    && a.message.forkContext === b.message.forkContext
    && a.message.state === b.message.state
    && a.message.role === b.message.role
    && a.message.createdAt === b.message.createdAt
    && a.message.queuedAt === b.message.queuedAt
    && a.message.completedAt === b.message.completedAt
    && a.message.model === b.message.model
    && a.message.attachments === b.message.attachments
    && a.message.fileRefs === b.message.fileRefs,
)
