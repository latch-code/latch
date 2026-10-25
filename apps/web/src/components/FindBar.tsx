import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { IconButton, SearchField } from '@latch/ui'
import { textMatches } from '../textSearch.ts'

interface Found {
  range: Range
  messageId: string
}
export function FindBar({
  sessionId,
  revision,
  onReveal,
  onClose,
}: {
  sessionId: string
  revision: number
  onReveal: (id: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(''),
    [found, setFound] = useState<Found[]>([]),
    [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const previous = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  useEffect(() => {
    input.current?.focus()
    return () => {
      previous.current?.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    const root = document.querySelector('.transcript-content')
    if (!root || !query) {
      setFound([])
      setIndex(0)
      return
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
      matches: Found[] = []
    for (let node = walker.nextNode(); node && matches.length < 500; node = walker.nextNode()) {
      const element = node.parentElement,
        row = element?.closest<HTMLElement>('[data-message-id]')
      if (!row || element?.closest('button, input, textarea, [aria-hidden="true"]')) continue
      for (const match of textMatches(node.textContent ?? '', query, 500 - matches.length)) {
        const range = document.createRange()
        range.setStart(node, match.start)
        range.setEnd(node, match.end)
        matches.push({ range, messageId: row.dataset.messageId! })
      }
    }
    setFound(matches)
    setIndex(0)
  }, [query, sessionId, revision])
  useEffect(() => {
    if ('highlights' in CSS && typeof Highlight !== 'undefined') {
      CSS.highlights.set('latch-find', new Highlight(...found.map(item => item.range)))
      CSS.highlights.set('latch-find-current', new Highlight(...(found[index] ? [found[index]!.range] : [])))
      return () => {
        CSS.highlights.delete('latch-find')
        CSS.highlights.delete('latch-find-current')
      }
    }
    return undefined
  }, [found, index])
  useEffect(() => {
    const target = found[index]
    if (target) onReveal(target.messageId)
  }, [found, index, onReveal])
  const next = (step: number) => {
    setIndex(value => (found.length ? (value + step + found.length) % found.length : 0))
  }
  return (
    <div
      className="find-bar"
      role="search"
      aria-label="会话内查找"
      onKeyDownCapture={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          next(event.shiftKey ? -1 : 1)
        }
      }}>
      <SearchField ref={input} label="查找消息内容" value={query} onValueChange={setQuery} />
      <span role="status">{found.length ? `${index + 1}/${found.length}${found.length === 500 ? '+' : ''}` : '0/0'}</span>
      <IconButton label="上一个匹配" icon={ArrowUp} disabled={!found.length} onClick={() => next(-1)} />
      <IconButton label="下一个匹配" icon={ArrowDown} disabled={!found.length} onClick={() => next(1)} />
      <IconButton label="关闭查找" icon={X} onClick={onClose} />
    </div>
  )
}
