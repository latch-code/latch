import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { IconButton, SearchField } from '@latch/ui'
import type { Message } from '@latch/protocol'
import { textMatches } from '../textSearch.ts'
import { elementRanges, lazyOutputMatches, outputRange } from './transcriptFind.ts'

interface Found {
  range?: Range
  messageId: string
  outputIndex?: number
  row: HTMLElement
}
export function FindBar({
  sessionId,
  revision,
  messages,
  onReveal,
  onClose,
}: {
  sessionId: string
  revision: number
  messages: readonly Message[]
  onReveal: (id: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(''),
    [found, setFound] = useState<Found[]>([]),
    [index, setIndex] = useState(0),
    [materialized, setMaterialized] = useState<Array<{ match: Found; range: Range }>>([]),
    [recoloured, setRecoloured] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const previous = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  // A rescan after code was coloured finds the same matches over the new text nodes: the reader stays where they are.
  const keepPlace = useRef(false)
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
      setMaterialized([])
      return
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
      matches: Found[] = [],
      codes = new Set<Element>()
    for (let node = walker.nextNode(); node && matches.length < 500; node = walker.nextNode()) {
      const element = node.parentElement,
        row = element?.closest<HTMLElement>('[data-message-id]')
      if (!row || element?.closest('button, input, textarea, [aria-hidden="true"], .tool-output')) continue
      // Code is searched as one text: colouring it splits its text into tokens, which must not change what matches.
      const code = element?.closest('.message-code code')
      if (code) {
        if (!codes.has(code)) {
          codes.add(code)
          for (const range of elementRanges(code, query, 500 - matches.length))
            matches.push({ range, messageId: row.dataset.messageId!, row })
        }
        continue
      }
      for (const match of textMatches(node.textContent ?? '', query, 500 - matches.length)) {
        const range = document.createRange()
        range.setStart(node, match.start)
        range.setEnd(node, match.end)
        matches.push({ range, messageId: row.dataset.messageId!, row })
      }
    }
    for (const match of lazyOutputMatches(messages, query)) {
      const row = root.querySelector<HTMLElement>('.tool-card[data-message-id="' + CSS.escape(match.messageId) + '"]')
      if (row && !row.classList.contains('has-approval')) matches.push({ ...match, row })
    }
    matches.sort((left, right) => {
      if (left.row === right.row) return Number(left.outputIndex !== undefined) - Number(right.outputIndex !== undefined)
      return left.row.compareDocumentPosition(right.row) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    })
    setFound(matches.slice(0, 500))
    if (keepPlace.current) setIndex(value => Math.min(value, Math.max(0, matches.length - 1)))
    else {
      setIndex(0)
      setMaterialized([])
    }
  }, [query, sessionId, revision, messages, recoloured])
  useEffect(() => {
    const root = document.querySelector('.transcript-content')
    if (!root || !query) return
    // Colouring a block as it nears the view replaces its text nodes, which empties the ranges found in them. Expanding
    // an uncoloured block changes the text of the one node it has.
    let frame = 0
    const inCode = ({ target }: MutationRecord) =>
      (target instanceof Element ? target : target.parentElement)?.closest('.message-code code')
    const observer = new MutationObserver(changes => {
      if (frame || !changes.some(inCode)) return
      frame = requestAnimationFrame(() => {
        frame = 0
        keepPlace.current = true
        setRecoloured(value => value + 1)
      })
    })
    observer.observe(root, { childList: true, characterData: true, subtree: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [query])
  useEffect(() => {
    if ('highlights' in CSS && typeof Highlight !== 'undefined') {
      const ranges = [...found.flatMap(item => (item.range ? [item.range] : [])), ...materialized.map(item => item.range)]
      const target = found[index]
      // A rescan builds new matches, so the one materialized for this place is told by where it is.
      const current =
        target?.range
        ?? materialized.find(item => item.match.messageId === target?.messageId && item.match.outputIndex === target?.outputIndex)?.range
      CSS.highlights.set('latch-find', new Highlight(...ranges))
      CSS.highlights.set('latch-find-current', new Highlight(...(current ? [current] : [])))
      return () => {
        CSS.highlights.delete('latch-find')
        CSS.highlights.delete('latch-find-current')
      }
    }
    return undefined
  }, [found, index, materialized])
  useEffect(() => {
    const target = found[index]
    const kept = keepPlace.current
    keepPlace.current = false
    if (!target || kept) return
    onReveal(target.messageId)
    const inner =
      target.outputIndex === undefined
        ? target.range?.startContainer.parentElement
        : target.row.querySelector('.tool-tray > .ui-collapse > .ui-collapse-inner')
    for (let hidden = inner?.closest('[hidden="until-found"]'); hidden; hidden = hidden.parentElement?.closest('[hidden="until-found"]'))
      hidden.dispatchEvent(new Event('beforematch'))
    const frame = requestAnimationFrame(() => {
      setMaterialized(
        found.flatMap(match => {
          if (match.outputIndex === undefined) return []
          const output = match.row.querySelector('.tool-output'),
            range = output ? outputRange(output, query, match.outputIndex) : undefined
          return range ? [{ match, range }] : []
        }),
      )
      onReveal(target.messageId)
    })
    return () => cancelAnimationFrame(frame)
  }, [found, index, onReveal, query])
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
