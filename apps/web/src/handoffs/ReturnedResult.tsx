import { TextQuote } from 'lucide-react'
import type { Handoff } from '@latch/protocol'
import { Button, ICON_STROKE, EnterGlyph, FileGlyph, LockGlyph, MessageGlyph } from '@latch/ui'
import { MessageContent } from '../MessageContent.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { evidenceRow } from './model.ts'

/**
 * 交回的结果 in the source's timeline, built from the handoff record, never a message: the summary, each piece of evidence
 * as a link (or 无权查看 when this reader may not read it), and 带入输入框, which only puts the summary in the draft. The
 * Host never sends it to this session's Agent.
 */
export function ReturnedResult({
  handoff,
  targetTitle,
  onOpenTarget,
  onOpenFile,
  onOpenMessage,
  onQuote,
}: {
  handoff: Handoff
  targetTitle?: string | undefined
  onOpenTarget?: (() => void) | undefined
  onOpenFile?: ((file: { root: string; path: string }) => void) | undefined
  onOpenMessage?: ((messageId: string) => void) | undefined
  /** Absent when this device may not write here now. */
  onQuote?: ((summary: string) => void) | undefined
}) {
  const result = handoff.result
  return (
    <section className="handoff-result" role="group" aria-label="交回的结果" data-handoff-id={handoff.id}>
      <header className="handoff-result-head">
        <EnterGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <strong>交回的结果</strong>
        {targetTitle && (
          <span className="handoff-muted">
            <VisibleText text={targetTitle} />
          </span>
        )}
      </header>
      <div className="handoff-result-body">
        {handoff.contentRemoved ? (
          <p className="handoff-muted">内容已随会话删除</p>
        ) : !result ? null : result.summaryWithheld ? (
          <p className="handoff-withheld">
            <LockGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
            无权查看
          </p>
        ) : (
          <div className="message-text">
            <MessageContent text={result.summary ?? ''} />
          </div>
        )}
        {result && !handoff.contentRemoved && result.evidence.length > 0 && (
          <ul className="handoff-evidence-list" aria-label="证据">
            {result.evidence.map((item, index) => {
              const row = evidenceRow(item)
              if (row.kind === 'withheld' || item.kind === 'withheld')
                return (
                  <li key={index} className="handoff-withheld">
                    <LockGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
                    无权查看
                  </li>
                )
              const Glyph = item.kind === 'file' ? FileGlyph : MessageGlyph
              const open =
                item.kind === 'file' ? onOpenFile && (() => onOpenFile(item.file)) : onOpenMessage && (() => onOpenMessage(item.messageId))
              return (
                <li key={index}>
                  <Glyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                  {open ? (
                    <button type="button" className={item.kind === 'file' ? 'handoff-link is-mono' : 'handoff-link'} onClick={open}>
                      <VisibleText text={row.label} />
                    </button>
                  ) : (
                    <span className={item.kind === 'file' ? 'is-mono' : undefined}>
                      <VisibleText text={row.label} />
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <div className="handoff-result-actions">
          {onOpenTarget && (
            <Button size="xs" variant="ghost" onClick={onOpenTarget}>
              打开代码会话
            </Button>
          )}
          {onQuote && result?.summary && !handoff.contentRemoved && (
            <Button size="xs" icon={TextQuote} onClick={() => onQuote(result.summary!)}>
              带入输入框
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
