import { UserText } from './MentionedText.tsx'
import { MessageAttachments } from './MessageAttachments.tsx'
import { createContext, Fragment, memo, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { GitFork, RotateCcw } from 'lucide-react'
import { splitChangeNote, type HarnessInfo, type Message } from '@latch/protocol'
import { MessageContent, ReasoningContent } from '../MessageContent.tsx'
import { KindGlyph } from '../conversation/KindGlyph.tsx'
import { ownTextStart, reasoningSections } from '../conversation.ts'
import { hostNow, parseDuration, parseTime, useTicker } from '../core/hostClock.ts'
import { absoluteTime, formatDuration, messageTime } from '../format.ts'
import { usePacedText } from '../hooks/usePacedText.ts'
import { MarkTile } from './BrandTile.tsx'
import { AgentAvatar } from '../agents/AgentAvatar.tsx'
import { THOUGHT_WORDS } from '../agents/personWords.ts'
import type { AgentAvatar as AgentAvatarValue } from '@latch/protocol'
import { VisibleText } from './VisibleText.tsx'
import {
  Badge,
  Button,
  Collapse,
  ICON_STROKE,
  IconButton,
  Shimmer,
  Swap,
  Tooltip,
  useStreamingLayer,
  CopyButton,
  ChevronRightGlyph,
  EnterGlyph,
  HistoryGlyph,
  InfoGlyph,
  AlertGlyph,
  UndoGlyph,
  CloseGlyph,
} from '@latch/ui'

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
 *
 * A Harness that titles its thoughts (Codex's summary parts) has the current title on the live line, 「思考中 · 标题」, and
 * each title as a small heading in the body. The body is drawn through the reply's Markdown pipeline restricted to
 * emphasis, inline code and lists, as replies are while they arrive; a thought that was never open on this page (history)
 * stays plain text until it is opened, so folded thoughts cost no parsing.
 */
export function ThinkingRow({
  text,
  live,
  streaming,
  observeStream = false,
  reasoningMs,
  liveTimes,
  frozen = false,
  person = false,
}: {
  text: string
  /** Reasoning still streams and no answer text has come yet. */
  live: boolean
  /** The block is the live reply. */
  streaming: boolean
  observeStream?: boolean
  reasoningMs?: number
  liveTimes?: LiveReasoning
  /** The connection is down: nothing is known to move, so it neither shimmers nor counts. */
  frozen?: boolean
  /** A helper's turn: 「在想」 and 「想了 6 秒」. */
  person?: boolean
}) {
  const [choice, setChoice] = useState<boolean | null>(null)
  const open = choice ?? live
  const started = parseTime(liveTimes?.startedAt)
  // A reply can begin another visible reasoning span after its first prose.
  const reasoningStreaming = live || (streaming && started !== undefined && liveTimes?.ms === undefined)
  const stream = useRef<HTMLDivElement>(null)
  useStreamingLayer(stream, observeStream && reasoningStreaming && open && !frozen && !!text)
  const sections = useMemo(() => reasoningSections(text, reasoningStreaming), [text, reasoningStreaming])
  const title = live ? sections.at(-1)?.title : undefined
  // Parsed once it has been open here, and kept from then on so folding it does not redraw it.
  const [rich, setRich] = useState(false)
  if (open && !rich) setRich(true)
  // Re-renders every second while the live reasoning counts up.
  useTicker(live && !frozen && started !== undefined ? 'second' : false)
  const settledMs = streaming ? parseDuration(liveTimes?.ms) : parseDuration(reasoningMs)
  // A helper says whole seconds, as a person would: 想了 3 秒.
  const thought =
    settledMs === undefined ? undefined : formatDuration(person ? Math.max(1000, Math.round(settledMs / 1000) * 1000) : settledMs)
  const elapsed = live && !frozen && started !== undefined ? formatDuration(hostNow() - started, true) : undefined
  const liveWord = person ? THOUGHT_WORDS.live : '思考中'
  return (
    <div className={`thinking ${live && !frozen ? 'is-live' : ''}`}>
      <button
        type="button"
        className="process-row thinking-toggle"
        aria-expanded={open}
        onClick={() => {
          setChoice(!open)
        }}>
        <KindGlyph kind="think" />
        {/* When the answer starts the label cross-fades from the live one to the time it took. */}
        <Swap value={live ? 'live' : 'settled'} effect="fade" className="thinking-label">
          {live ? (
            frozen ? (
              liveWord
            ) : (
              <Shimmer>{liveWord}</Shimmer>
            )
          ) : thought ? (
            person ? (
              THOUGHT_WORDS.settled(thought)
            ) : (
              `思考了 ${thought}`
            )
          ) : person ? (
            THOUGHT_WORDS.untimed
          ) : (
            '思考过程'
          )}
        </Swap>
        {title && (
          <span className="thinking-title">
            <VisibleText text={title} />
          </span>
        )}
        <ChevronRightGlyph className="process-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
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
          <div ref={stream} className="thinking-scroll">
            <div className="thinking-sections">
              {sections.map((section, index) => (
                <Fragment key={index}>
                  {section.title !== undefined && (
                    <p className="reasoning-heading">
                      <VisibleText text={section.title} />
                    </p>
                  )}
                  {section.body
                    && (rich ? (
                      <ReasoningContent text={section.body} streaming={reasoningStreaming && index === sections.length - 1} />
                    ) : (
                      <p className="reasoning-text">
                        <VisibleText text={section.body} />
                      </p>
                    ))}
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      </Collapse>
    </div>
  )
}

/** Who answers in a conversation of 我的 Agent: the helper's face and name, which stand in for the Harness and the model. */
export interface Speaker {
  name: string
  avatar: AgentAvatarValue | 'general'
}

/** A helper's turn opens with its face and name, and nothing of the Harness or the model that ran it. */
export function SpeakerLine({ speaker, demo = false }: { speaker: Speaker; demo?: boolean }) {
  return (
    <div className="assistant-meta assistant-meta-person">
      <AgentAvatar avatar={speaker.avatar} size={16} />
      <span className="assistant-meta-name">
        <VisibleText text={speaker.name} />
      </span>
      {/* The demo model is never passed off as the helper's own answer. */}
      {demo && <span className="assistant-meta-model">演示</span>}
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
  chosen,
  fallback,
}: {
  name: string
  /** The engine's name, when it is not already the word. */
  engine?: string
  harness?: Pick<HarnessInfo, 'capabilities'> | undefined
  model?: string
  /** The model service's name, for the model's tooltip. */
  provider?: string
  /** The model the session had chosen, when `model` answered instead; `reported` when the service said so. */
  chosen?: { model: string; reported: boolean }
  /** A 「出错时改用」 service answered the turn: its name, written before the model with the 备选 tag after. */
  fallback?: string | undefined
}) {
  const detail = [engine, fallback, model].filter(Boolean).join(' · ')
  return (
    <div className="assistant-meta">
      {/* The turn's source, not the harness's state now: the tile never draws readiness here. */}
      <MarkTile mark={harness?.capabilities.display.mark} size={16} />
      <span className="assistant-meta-name">{name}</span>
      {detail && (
        <Tooltip content={provider}>
          <span className="assistant-meta-model">{detail}</span>
        </Tooltip>
      )}
      {fallback && (
        <Tooltip content={`这一轮由「${fallback}」回答`}>
          <span className="assistant-meta-fallback" tabIndex={0}>
            <Badge>备选</Badge>
          </span>
        </Tooltip>
      )}
      {chosen && model && (
        <Tooltip
          content={
            chosen.reported
              ? `选的是 ${chosen.model}，模型服务说这一轮用的是 ${model}`
              : `选的是 ${chosen.model}，这一轮 Harness 请求的是 ${model}，模型服务没有说用的是哪个`
          }>
          <span className="assistant-meta-chosen" tabIndex={0}>
            选的是 {chosen.model}
          </span>
        </Tooltip>
      )}
    </div>
  )
}

/** A bubble taller than this clamps behind a fade with 「显示全部」. */
const BUBBLE_CLAMP = 176

export const TurnEditLocked = createContext(false)

function EditTurnButton({ message, onEdit }: { message: Message; onEdit: (message: Message) => void }) {
  if (useContext(TurnEditLocked)) return null
  return <IconButton icon={UndoGlyph} size="xs" label="从这里编辑" onClick={() => onEdit(message)} />
}

function UserMessage({
  message,
  coarse,
  arrived,
  delivery,
  harness,
  voice,
  onEdit,
  onHandoff,
}: {
  message: Message
  coarse: boolean
  arrived: boolean
  delivery?: string
  harness?: string
  voice?: string | undefined
  onEdit?: (message: Message) => void
  onHandoff?: (messageIds: string[]) => void
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
  const { note, text } = splitChangeNote(message.text.slice(ownTextStart(message)))
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
            已告诉 {voice ?? 'Harness'} 改动被撤销了
          </p>
        </Tooltip>
      )}
      {message.steered && (
        <Tooltip content={`发送时这一轮还在运行，${voice ?? 'Harness'} 收到了；有没有读到，看它后面的回复`}>
          <p className="message-change-note message-steered" tabIndex={0}>
            已追加到本轮
          </p>
        </Tooltip>
      )}
      {/* The agent fetched an MCP prompt during this turn: text Latch never saw is in its context. Always said. */}
      {message.origin === 'mcp-prompt' && <p className="message-change-note">来自 MCP 提示</p>}
      <MessageAttachments attachments={message.attachments} />
      {message.text && (
        <div className="user-bubble" data-clamped={tall && !whole ? '' : undefined}>
          <div className="user-bubble-text" ref={bubble}>
            {message.forkContext && message.nativeFork && (
              // The harness forked its own record: the text record was not sent, so there is none to show.
              <p className="fork-context">
                <GitFork size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                {harness ?? 'Harness'} 带着「
                <VisibleText text={message.forkContext.title} />
                」的前 {message.forkContext.turn} 轮
              </p>
            )}
            {message.forkContext && !message.nativeFork && (
              <details className="fork-context">
                <summary>
                  <GitFork size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                  「<VisibleText text={message.forkContext.title} />
                  」的前 {message.forkContext.turn} 轮
                </summary>
                <pre>
                  <VisibleText text={message.text.slice(0, message.forkContext.prefixLength)} />
                </pre>
              </details>
            )}
            {message.importContext && (
              // A text rebuild: what went to the model with these words, folded, and named for what it is.
              <details className="fork-context">
                <summary>
                  <HistoryGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />按{' '}
                  {message.importContext.from} 会话的文字重建
                </summary>
                <pre>
                  <VisibleText text={message.text.slice(0, message.importContext.prefixLength)} />
                </pre>
              </details>
            )}
            <UserText text={text} refs={message.fileRefs} />
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
          {onEdit && <EditTurnButton message={message} onEdit={onEdit} />}
          {onHandoff && text && (
            <IconButton
              icon={EnterGlyph}
              size="xs"
              label="交给代码任务…"
              onClick={() => {
                onHandoff([message.id])
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
function SystemNote({
  message,
  onRetry,
  action,
  voice,
}: {
  message: Message
  onRetry?: () => void
  voice?: string | undefined
  /** The failure's own next step, when it is not 重试. */
  action?: { label: string; run: () => void }
}) {
  const failed = message.state === 'failed'
  // The Host's stop cut the turn off: no failure, but the person has to check what its tools did.
  const interrupted = message.interrupted === true
  const Icon = failed ? CloseGlyph : interrupted ? AlertGlyph : InfoGlyph
  return (
    <article
      className={`message message-system${failed ? ' is-failed' : interrupted ? ' is-interrupted' : ''}`}
      data-message-id={message.id}>
      <span className="process-slot" aria-hidden="true">
        <Icon size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />
      </span>
      <p>
        {failed && voice && (
          <>
            <VisibleText text={voice} /> 没能回复：
          </>
        )}
        {message.text}
      </p>
      {failed && action ? (
        <Button size="xs" variant="ghost" onClick={action.run}>
          {action.label}
        </Button>
      ) : (
        failed
        && onRetry && (
          <Button size="xs" variant="ghost" icon={RotateCcw} onClick={onRetry}>
            重试
          </Button>
        )
      )}
    </article>
  )
}

/**
 * An answer block's prose. While it is the live reply its newest text shows at an even pace (`usePacedText`); the
 * message keeps its whole text, and once it settles the whole text is what is drawn.
 */
function AssistantMessage({
  message,
  streaming,
  frozen,
  observeStream,
}: {
  message: Message
  streaming: boolean
  frozen: boolean
  observeStream: boolean
}) {
  const text = usePacedText(message.text, streaming && !frozen)
  const stream = useRef<HTMLDivElement>(null)
  useStreamingLayer(stream, observeStream && streaming && !frozen && !!message.text)
  return (
    <article
      className={`message message-assistant ${streaming && !frozen ? 'is-live' : ''}`}
      data-message-id={message.id}
      aria-label={streaming ? '正在生成的回复' : undefined}>
      <MessageAttachments attachments={message.attachments} />
      {message.text && (
        <div ref={stream} className="message-text">
          <MessageContent text={text} streaming={streaming} />
        </div>
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
    observeStream = false,
    frozen = false,
    coarse = false,
    arrived = false,
    delivery,
    harness,
    voice,
    onEdit,
    onRetry,
    action,
    onHandoff,
  }: {
    message: Message
    streaming?: boolean
    observeStream?: boolean
    /** The connection is down: the caret stops saying more is coming. */
    frozen?: boolean
    /** Touch: a tap shows a message's time and actions. */
    coarse?: boolean
    /** The page saw the prompt arrive: its bubble rises in. */
    arrived?: boolean
    /** How far this prompt has got, while the agent has not answered. */
    delivery?: string
    /** The session's Harness by name, for what its first prompt says about a fork. */
    harness?: string
    /** A helper's name: who heard an undo or a message added to the running turn, in place of 「Harness」. */
    voice?: string
    /** Forks before this prompt with its text in the composer. */
    onEdit?: (message: Message) => void
    /** Resends the turn, from a failed note. */
    onRetry?: () => void
    /** A failed note's own next step, in place of 重试. */
    action?: { label: string; run: () => void }
    /** 交给代码任务… with this message chosen. */
    onHandoff?: (messageIds: string[]) => void
  }) {
    if (message.role === 'user')
      return (
        <UserMessage
          message={message}
          coarse={coarse}
          arrived={arrived}
          delivery={delivery}
          harness={harness}
          voice={voice}
          onEdit={onEdit}
          {...(onHandoff ? { onHandoff } : {})}
        />
      )
    if (message.role === 'system') return <SystemNote message={message} onRetry={onRetry} voice={voice} {...(action ? { action } : {})} />
    return <AssistantMessage message={message} streaming={streaming} frozen={frozen} observeStream={observeStream} />
  },
  (a, b) =>
    a.streaming === b.streaming
    && a.observeStream === b.observeStream
    && a.frozen === b.frozen
    && a.coarse === b.coarse
    && a.arrived === b.arrived
    && a.delivery === b.delivery
    && a.harness === b.harness
    && a.voice === b.voice
    && a.onEdit === b.onEdit
    && a.onRetry === b.onRetry
    && a.action?.label === b.action?.label
    && a.action?.run === b.action?.run
    && a.onHandoff === b.onHandoff
    && a.message.id === b.message.id
    && a.message.interrupted === b.message.interrupted
    && a.message.errorCode === b.message.errorCode
    && a.message.text === b.message.text
    && a.message.forkContext === b.message.forkContext
    && a.message.importContext === b.message.importContext
    && a.message.nativeFork === b.message.nativeFork
    && a.message.state === b.message.state
    && a.message.role === b.message.role
    && a.message.createdAt === b.message.createdAt
    && a.message.queuedAt === b.message.queuedAt
    && a.message.completedAt === b.message.completedAt
    && a.message.model === b.message.model
    && a.message.attachments === b.message.attachments
    && a.message.fileRefs === b.message.fileRefs
    && a.message.origin === b.message.origin
    && a.message.steered === b.message.steered,
)
