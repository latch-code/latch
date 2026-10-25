import { memo, useState, type ReactNode } from 'react'
import { ChevronRight, CircleX, Info, Lightbulb } from 'lucide-react'
import type { HarnessInfo, Message } from '@latch/protocol'
import { MessageContent } from '../MessageContent.tsx'
import { hostNow, parseDuration, parseTime, useTicker } from '../core/hostClock.ts'
import { absoluteTime, formatDuration, messageTime, separatorLabel } from '../format.ts'
import { HarnessTile } from './BrandTile.tsx'
import { CopyButton } from './ui.tsx'
import { Collapse, ICON_STROKE, Shimmer, Swap, Tooltip } from '@latch/ui'

/** Times of the live reply's reasoning, which the Host reports on the detail while it streams. */
export interface LiveReasoning {
  startedAt?: string
  ms?: number
}

/**
 * A time the Host recorded, as a `<time>` with the full date in its tooltip (or `tip`, given the time now: a turn's
 * start, end and duration); it rolls over at midnight.
 */
export function TimeLabel({
  at,
  separator,
  sameDay = false,
  tip,
}: {
  at: number
  separator?: boolean
  sameDay?: boolean
  tip?: (now: number) => ReactNode
}) {
  const now = useTicker('minute')
  const text = separator ? separatorLabel(at, now, sameDay) : messageTime(at, now)
  return (
    <Tooltip content={tip?.(now) ?? absoluteTime(at)}>
      <time dateTime={new Date(at).toISOString()} tabIndex={0}>
        {text}
      </time>
    </Tooltip>
  )
}

/**
 * Reasoning the model reported, as a row of the process: while it streams, 「正在思考」 with its light crossing it and
 * the seconds since it began; once the answer starts, 「思考了 6 秒」. The body opens by itself while the reasoning
 * streams and folds away as the answer starts; the reader's own choice wins. Without times it is 「思考过程」.
 */
function ThinkingRow({
  text,
  live,
  streaming,
  reasoningMs,
  liveTimes,
}: {
  text: string
  /** Reasoning still streams and no answer text has come yet. */
  live: boolean
  /** The block is the live reply. */
  streaming: boolean
  reasoningMs?: number
  liveTimes?: LiveReasoning
}) {
  const [choice, setChoice] = useState<boolean | null>(null)
  const open = choice ?? live
  const started = parseTime(liveTimes?.startedAt)
  // Re-renders every second while the live reasoning counts up.
  useTicker(live && started !== undefined ? 'second' : false)
  const settledMs = streaming ? parseDuration(liveTimes?.ms) : parseDuration(reasoningMs)
  const thought = settledMs === undefined ? undefined : formatDuration(settledMs)
  const elapsed = live && started !== undefined ? formatDuration(hostNow() - started, true) : undefined
  return (
    <div className={`thinking ${live ? 'is-live' : ''}`}>
      <button
        type="button"
        className="process-row thinking-toggle"
        aria-expanded={open}
        onClick={() => {
          setChoice(!open)
        }}>
        <span className="process-slot" aria-hidden="true">
          <Lightbulb size={14} strokeWidth={ICON_STROKE[14]} />
        </span>
        {/* When the answer starts the label cross-fades from the live one to the time it took. */}
        <Swap value={live ? 'live' : 'settled'} effect="fade" className="thinking-label">
          {live ? <Shimmer>正在思考</Shimmer> : thought ? `思考了 ${thought}` : '思考过程'}
        </Swap>
        {elapsed && (
          <span className="process-time" aria-hidden="true">
            · {elapsed}
          </span>
        )}
        <ChevronRight className="process-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
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

/** The once-per-turn source line: the harness's tile and name, and the model that answered when the Host recorded it. */
export function SourceRow({
  name,
  harness,
  model,
  provider,
}: {
  name: string
  harness?: Pick<HarnessInfo, 'id' | 'source'>
  model?: string
  /** The model service's name, for the model's tooltip. */
  provider?: string
}) {
  return (
    <div className="assistant-meta">
      {/* The turn's source, not the harness's state now: the tile never draws readiness here. */}
      <HarnessTile harness={harness ? { id: harness.id, source: harness.source } : { id: 'standard', source: 'builtin' }} size={16} />
      <span className="assistant-meta-name">{name}</span>
      {model && (
        <Tooltip content={provider}>
          <span className="assistant-meta-model">· {model}</span>
        </Tooltip>
      )}
    </div>
  )
}

function UserMessage({
  message,
  separator,
  coarse,
  arrived,
}: {
  message: Message
  separator?: { at: number; sameDay: boolean }
  coarse: boolean
  arrived: boolean
}) {
  const at = parseTime(message.createdAt)
  const [shown, setShown] = useState(false)
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
      {separator && (
        <p className="time-separator">
          <TimeLabel at={separator.at} separator sameDay={separator.sameDay} />
        </p>
      )}
      <div className="user-bubble">{message.text}</div>
      <div className="message-meta">
        {at !== undefined && <TimeLabel at={at} />}
        <CopyButton text={message.text} label="复制消息" size="xs" />
      </div>
    </article>
  )
}

function SystemNote({ message }: { message: Message }) {
  // A note that reports a failure (a model-service error, an interrupted run, a stopped session) is drawn like an error
  // notice; any other note is a quiet line centred in the column.
  const failed = message.state === 'failed'
  const Icon = failed ? CircleX : Info
  return (
    <article className={`message message-system${failed ? ' is-failed' : ''}`} data-message-id={message.id}>
      <Icon size={failed ? 14 : 12} strokeWidth={ICON_STROKE[failed ? 14 : 12]} aria-hidden="true" />
      <p>{message.text}</p>
    </article>
  )
}

/**
 * One message row: the person's bubble (with its separator and its time and copy), a reply block (the thinking row and
 * the prose) or a system note. The turn's source line is drawn once at the top of its reply (Transcript). The turn's footer is drawn after its last row
 * (Transcript), so a block carries no footer of its own.
 */
export const MessageRow = memo(
  function MessageRow({
    message,
    streaming = false,
    separator,
    liveReasoning,
    coarse = false,
    arrived = false,
  }: {
    message: Message
    streaming?: boolean
    /** A prompt that opens a time separator. */
    separator?: { at: number; sameDay: boolean }
    liveReasoning?: LiveReasoning
    /** Touch: a tap shows a message's time and actions. */
    coarse?: boolean
    /** The page saw the prompt arrive: its bubble rises in. */
    arrived?: boolean
  }) {
    if (message.role === 'user') return <UserMessage message={message} separator={separator} coarse={coarse} arrived={arrived} />
    if (message.role === 'system') return <SystemNote message={message} />
    return (
      <article
        className={`message message-assistant ${streaming ? 'is-live' : ''}`}
        data-message-id={message.id}
        aria-label={streaming ? '正在生成的回复' : undefined}>
        {message.reasoning && (
          <ThinkingRow
            text={message.reasoning}
            live={streaming && !message.text}
            streaming={streaming}
            reasoningMs={message.reasoningMs}
            liveTimes={liveReasoning}
          />
        )}
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
    && a.coarse === b.coarse
    && a.arrived === b.arrived
    && a.separator?.at === b.separator?.at
    && a.separator?.sameDay === b.separator?.sameDay
    && a.liveReasoning?.startedAt === b.liveReasoning?.startedAt
    && a.liveReasoning?.ms === b.liveReasoning?.ms
    && a.message.id === b.message.id
    && a.message.text === b.message.text
    && a.message.state === b.message.state
    && a.message.role === b.message.role
    && a.message.reasoning === b.message.reasoning
    && a.message.createdAt === b.message.createdAt
    && a.message.completedAt === b.message.completedAt
    && a.message.reasoningMs === b.message.reasoningMs
    && a.message.model === b.message.model,
)
