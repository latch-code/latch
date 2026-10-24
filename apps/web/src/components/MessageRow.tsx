import { memo, useState } from 'react'
import { Brain, ChevronRight, CircleX, Info } from 'lucide-react'
import type { HarnessInfo, Message, TokenUsage } from '@latch/protocol'
import { MessageContent } from '../MessageContent.tsx'
import { usageText, usageTitle } from '../format.ts'
import { HarnessTile } from './BrandTile.tsx'
import { CopyButton } from './ui.tsx'
import { ICON_STROKE } from '@latch/ui'

/** Reported reasoning only; it follows the live reply and folds away once the answer starts. */
export function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [choice, setChoice] = useState<boolean | null>(null)
  const open = choice ?? live
  return (
    <div className={`reasoning ${live ? 'is-live' : ''}`}>
      <button
        type="button"
        className="reasoning-toggle"
        aria-expanded={open}
        onClick={() => {
          setChoice(!open)
        }}>
        <Brain size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        {live ? '思考中…' : '思考过程'}
        <ChevronRight className="chevron" size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
      </button>
      {open && (
        <div className="reasoning-scroll">
          <p className="reasoning-text">{text}</p>
        </div>
      )}
    </div>
  )
}

export const MessageRow = memo(
  function MessageRow({
    message,
    streaming = false,
    meta,
    metaHarness,
    footer = true,
    usage = message.usage,
  }: {
    message: Message
    streaming?: boolean
    /** Shown once per turn on the first assistant block, e.g. the harness name. */
    meta?: string
    /** The harness the turn came from, for the tile before `meta`; the built-in one shows Latch's icon. */
    metaHarness?: Pick<HarnessInfo, 'id' | 'source'>
    /** Copy and usage; only the block that ends a turn shows them. An outcome always shows. */
    footer?: boolean
    /** Usage of the whole turn; defaults to this block's own. */
    usage?: TokenUsage
  }) {
    if (message.role === 'user') {
      return (
        <article className="message message-user" data-message-id={message.id}>
          <div className="user-bubble">{message.text}</div>
          <div className="message-actions">
            <CopyButton text={message.text} label="复制消息" />
          </div>
        </article>
      )
    }
    if (message.role === 'system') {
      // A note that reports a failure (a model-service error, an interrupted run, a stopped session) is red; any
      // other note is neutral information.
      const failed = message.state === 'failed'
      const Icon = failed ? CircleX : Info
      return (
        <article className={`message message-system${failed ? ' is-failed' : ''}`} data-message-id={message.id}>
          <Icon size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <p>{message.text}</p>
        </article>
      )
    }
    const outcome = streaming
      ? ''
      : message.state === 'cancelled'
        ? '已停止 · 保留了部分回复'
        : message.state === 'failed'
          ? '回复中断 · 保留了部分内容'
          : ''
    return (
      <article
        className={`message message-assistant ${streaming ? 'is-live' : ''}`}
        data-message-id={message.id}
        aria-label={streaming ? '正在生成的回复' : undefined}>
        {meta !== undefined && (
          <div className="assistant-meta">
            {/* The turn's source, not the harness's state now: the tile never draws readiness here. */}
            <HarnessTile
              harness={metaHarness ? { id: metaHarness.id, source: metaHarness.source } : { id: 'standard', source: 'builtin' }}
              size={16}
            />
            <span>{meta}</span>
          </div>
        )}
        {message.reasoning && <Reasoning text={message.reasoning} live={streaming && !message.text} />}
        {message.text && (
          <div className="message-text">
            <MessageContent text={message.text} streaming={streaming} />
          </div>
        )}
        {!streaming && (outcome || (footer && (usage || message.text))) && (
          <div className="message-footer">
            {outcome && <span className="message-outcome">{outcome}</span>}
            {footer && usage && (
              <span className="message-usage" title={usageTitle(usage)}>
                {usageText(usage)}
              </span>
            )}
            {footer && message.text && (
              <span className="message-actions">
                <CopyButton text={message.text} label="复制回复" />
              </span>
            )}
          </div>
        )}
      </article>
    )
  },
  (a, b) =>
    a.streaming === b.streaming
    && a.meta === b.meta
    && a.metaHarness?.id === b.metaHarness?.id
    && a.metaHarness?.source === b.metaHarness?.source
    && a.footer === b.footer
    && a.message.id === b.message.id
    && a.message.text === b.message.text
    && a.message.state === b.message.state
    && a.message.role === b.message.role
    && a.message.reasoning === b.message.reasoning
    && (a.usage ?? a.message.usage)?.inputTokens === (b.usage ?? b.message.usage)?.inputTokens
    && (a.usage ?? a.message.usage)?.outputTokens === (b.usage ?? b.message.usage)?.outputTokens,
)
