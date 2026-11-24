import { createContext, useEffect, useState } from 'react'
import { Button } from '@latch/ui'
import { defineCopy } from '../core/i18n.ts'
import { quoteAtSelection, type ReplyQuote } from './replyQuote.ts'

export const QUOTE_COPY = defineCopy(
  { quote: '引用这句话', source: '查看引用原文' },
  { quote: 'Quote selection', source: 'View quoted passage' },
)
export const ReplyQuoteSource = createContext<{ id: string; open(quote: ReplyQuote): void } | undefined>(undefined)

export function ReplyQuoteControl({ sessionId, insert }: { sessionId: string; insert(quote: ReplyQuote): void }) {
  const [selected, setSelected] = useState<ReturnType<typeof quoteAtSelection>>()
  useEffect(() => {
    const update = () => setSelected(quoteAtSelection(sessionId))
    update()
    document.addEventListener('selectionchange', update)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      document.removeEventListener('selectionchange', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [sessionId])
  if (!selected || selected.quote.sessionId !== sessionId) return null
  return (
    <div
      className="reply-quote-action"
      style={{ left: Math.max(8, Math.min(selected.rect.left, window.innerWidth - 140)), top: Math.max(8, selected.rect.top - 36) }}>
      <Button
        size="xs"
        onMouseDown={event => event.preventDefault()}
        onClick={() => {
          insert(selected.quote)
          setSelected(undefined)
        }}>
        {QUOTE_COPY.quote}
      </Button>
    </div>
  )
}
