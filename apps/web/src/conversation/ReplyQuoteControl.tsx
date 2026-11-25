import { createContext, useEffect, useRef, useState } from 'react'
import { Button } from '@latch/ui'
import { defineCopy } from '../core/i18n.ts'
import { quoteAtSelection, replyTextAt, type ReplyQuote } from './replyQuote.ts'

export const QUOTE_COPY = defineCopy(
  { quote: '引用这句话', source: '查看引用原文' },
  { quote: 'Quote selection', source: 'View quoted passage' },
)
export const ReplyQuoteSource = createContext<{ id: string; open(quote: ReplyQuote): void } | undefined>(undefined)

function samePassage(a: ReplyQuote | undefined, b: ReplyQuote | undefined): boolean {
  return !!a && !!b && a.messageId === b.messageId && a.offset === b.offset && a.text === b.text
}

export function ReplyQuoteControl({ sessionId, insert }: { sessionId: string; insert(quote: ReplyQuote): void }) {
  const [selected, setSelected] = useState<ReturnType<typeof quoteAtSelection>>()
  const action = useRef<HTMLDivElement>(null)
  useEffect(() => {
    type Gesture = number | 'touch' | 'Shift' | 'a'
    let selecting: Gesture | undefined
    let initial: ReplyQuote | undefined
    const dismiss = () => {
      selecting = undefined
      initial = undefined
      setSelected(undefined)
    }
    const begin = (target: EventTarget | null, gesture: Gesture | undefined) => {
      if (target instanceof Node && action.current?.contains(target)) return
      dismiss()
      if (gesture !== undefined && replyTextAt(target)) {
        selecting = gesture
        initial = quoteAtSelection(sessionId)?.quote
      }
    }
    const finish = (gesture: Gesture) => {
      if (selecting !== gesture) return
      const next = quoteAtSelection(sessionId)
      selecting = undefined
      setSelected(samePassage(initial, next?.quote) ? undefined : next)
      initial = undefined
    }
    const refresh = () => {
      if (selecting !== undefined) {
        // Selecting the same passage again counts once the gesture has moved off its original range.
        if (initial && !samePassage(initial, quoteAtSelection(sessionId)?.quote)) initial = undefined
        return
      }
      setSelected(previous => {
        if (!previous) return undefined
        const next = quoteAtSelection(sessionId)
        return samePassage(previous.quote, next?.quote) ? next : undefined
      })
    }
    const listeners = new AbortController()
    const events = { capture: true, passive: true, signal: listeners.signal }
    window.addEventListener(
      'pointerdown',
      event => begin(event.target, event.isPrimary && event.button === 0 ? event.pointerId : undefined),
      events,
    )
    window.addEventListener('pointerup', event => finish(event.pointerId), events)
    window.addEventListener(
      'pointercancel',
      event => {
        if (selecting === event.pointerId) dismiss()
      },
      events,
    )
    // On touch screens the browser can cancel the pointer when it takes over a long press, before the finger lifts.
    window.addEventListener('touchstart', event => begin(event.target, event.touches.length === 1 ? 'touch' : undefined), events)
    window.addEventListener(
      'touchend',
      event => {
        if (!event.touches.length) finish('touch')
      },
      events,
    )
    window.addEventListener('touchcancel', dismiss, events)
    window.addEventListener(
      'keydown',
      event => {
        if (selecting !== undefined || event.isComposing) return
        if (event.target instanceof Element && event.target.closest('input, textarea, button, a[href], [contenteditable="true"]')) return
        const extend = event.shiftKey && /^(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/u.test(event.key)
        const all = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a'
        if (extend || all) begin(document.getSelection()?.anchorNode ?? event.target, extend ? 'Shift' : 'a')
      },
      events,
    )
    window.addEventListener(
      'keyup',
      event => {
        if (event.key === 'Shift') finish('Shift')
        if (event.key.toLowerCase() === 'a') finish('a')
      },
      events,
    )
    window.addEventListener('blur', dismiss, { signal: listeners.signal })
    document.addEventListener('selectionchange', refresh, events)
    window.addEventListener('resize', refresh, events)
    window.addEventListener('scroll', refresh, events)
    return () => listeners.abort()
  }, [sessionId])
  if (!selected || selected.quote.sessionId !== sessionId) return null
  return (
    <div
      ref={action}
      className="reply-quote-action"
      style={{ left: Math.max(8, Math.min(selected.rect.left, window.innerWidth - 140)), top: Math.max(8, selected.rect.top - 36) }}>
      <Button
        variant="outline"
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
