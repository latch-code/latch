import { memo, useState } from 'react'
import { Brain, ChevronRight, Info } from 'lucide-react'
import type { Message, TokenUsage } from '../../shared/types.ts'
import { MessageContent } from '../MessageContent.tsx'
import { usageText, usageTitle } from '../format.ts'
import { ICON_STROKE } from '../icons.tsx'
import { BrandMark, CopyButton } from './ui.tsx'

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
        <Brain size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {live ? '思考中…' : '思考过程'}
        <ChevronRight className="chevron" size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
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
    footer = true,
    usage = message.usage,
  }: {
    message: Message
    streaming?: boolean
    /** Shown once per turn on the first assistant block, e.g. the harness name. */
    meta?: string
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
      return (
        <article className="message message-system" data-message-id={message.id}>
          <Info size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
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
            <BrandMark size={16} />
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
    && a.footer === b.footer
    && a.message.id === b.message.id
    && a.message.text === b.message.text
    && a.message.state === b.message.state
    && a.message.role === b.message.role
    && a.message.reasoning === b.message.reasoning
    && (a.usage ?? a.message.usage)?.inputTokens === (b.usage ?? b.message.usage)?.inputTokens
    && (a.usage ?? a.message.usage)?.outputTokens === (b.usage ?? b.message.usage)?.outputTokens,
)
