import { fencedParts } from './fencedParts.ts'

/** Plain text survives native Harness histories, draft recovery and message copying. Offsets address visible DOM text. */
export interface ReplyQuote {
  sessionId: string
  messageId: string
  offset: number
  text: string
}

export function writeReplyQuote(quote: ReplyQuote): string {
  const from = `[引用回复 ${encodeURIComponent(quote.sessionId)}/${encodeURIComponent(quote.messageId)}@${quote.offset}]`
  return (
    from
    + '\n'
    + quote.text
      .split('\n')
      .map(line => '> ' + line)
      .join('\n')
  )
}

export function replyQuotes(text: string): Array<{ from: number; to: number; quote: ReplyQuote }> {
  if (!text.includes('[引用回复 ')) return []
  const found: Array<{ from: number; to: number; quote: ReplyQuote }> = []
  const pattern = /^\[引用回复 ([^/\s\]]{1,768})\/([^/\s\]]{1,768})@(\d{1,8})\]\n(> [^\n]*(?:\n> [^\n]*)*)/gmu
  for (const part of fencedParts(text)) {
    if (part.kind !== 'text') continue
    for (const match of part.text.matchAll(pattern)) {
      try {
        const quote = {
          sessionId: decodeURIComponent(match[1]!),
          messageId: decodeURIComponent(match[2]!),
          offset: Number(match[3]),
          text: match[4]!
            .split('\n')
            .map(line => line.slice(2))
            .join('\n'),
        }
        const from = part.from + match.index
        if (quote.text.length && quote.text.length <= 4000) found.push({ from, to: from + match[0].length, quote })
      } catch {
        // A hand-edited marker with an invalid escape stays ordinary text.
      }
    }
  }
  return found
}

export function quoteAtSelection(sessionId: string): { quote: ReplyQuote; rect: DOMRect } | undefined {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return
  const range = selection.getRangeAt(0)
  const host = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest('.transcript .message-assistant:not(.is-live) .message-text')
  const body = host(range.startContainer)
  if (!body || host(range.endContainer) !== body || body.closest('[inert], [hidden]')) return
  const messageId = body.closest<HTMLElement>('[data-message-id]')?.dataset.messageId
  const text = range.toString()
  if (!messageId || !text.trim() || text.length > 4000) return
  const before = range.cloneRange()
  before.selectNodeContents(body)
  before.setEnd(range.startContainer, range.startOffset)
  return { quote: { sessionId, messageId, offset: before.toString().length, text }, rect: range.getBoundingClientRect() }
}

/** A changed source is never marked as the original words. */
export function revealQuote(quote: ReplyQuote, reveal: (messageId: string) => void): void {
  reveal(quote.messageId)
  requestAnimationFrame(() => {
    const content = document.querySelector(`.transcript .message-assistant[data-message-id="${CSS.escape(quote.messageId)}"] .message-text`)
    const text = content?.textContent
    if (!content || !text) return
    let offset = quote.offset
    if (text.slice(offset, offset + quote.text.length) !== quote.text) {
      offset = text.indexOf(quote.text)
      if (offset < 0 || text.indexOf(quote.text, offset + 1) >= 0) return
    }
    const nodes = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let index = 0
    let started = false
    for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
      const end = index + (node.textContent?.length ?? 0)
      if (!started && offset < end) {
        range.setStart(node, offset - index)
        started = true
      }
      if (started && offset + quote.text.length <= end) {
        range.setEnd(node, offset + quote.text.length - index)
        const selection = document.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        range.startContainer.parentElement?.scrollIntoView({ block: 'center' })
        break
      }
      index = end
    }
  })
}
