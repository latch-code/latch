import { useEffect, useRef, useState, type RefObject } from 'react'

import { IconButton, SearchField, ChevronDownGlyph, ChevronUpGlyph, CloseGlyph } from '@latch/ui'
import type { Message } from '@latch/protocol'
import { textMatches } from '../textSearch.ts'
import { overlayDismissed } from '../escapeGrace.ts'
import {
  carriedIndex,
  elementRanges,
  findClearance,
  lazyOutputMatches,
  matchPlacement,
  outputRange,
  withMatchKeys,
} from './transcriptFind.ts'

const CLEARANCE = 'margin-block-start'
const clearanceOn = (content: HTMLElement) => Number.parseFloat(content.style.getPropertyValue(CLEARANCE)) || 0

interface Scanned {
  range?: Range
  messageId: string
  outputIndex?: number
  row: HTMLElement
}
type Found = Scanned & { key: string }
/** Floats over the conversation, which keeps its width. */
export function FindBar({
  sessionId,
  revision,
  messages,
  focusRequest = 0,
  fallbackFocus,
  onReveal,
  onClose,
}: {
  sessionId: string
  revision: number
  messages: readonly Message[]
  /** A new value takes focus back to the field, with what it holds selected. */
  focusRequest?: number
  /** Where focus goes on closing when what had it is gone, as a palette that opened this is. */
  fallbackFocus?: RefObject<HTMLElement | null>
  onReveal: (id: string, offset?: number) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(''),
    [found, setFound] = useState<Found[]>([]),
    [index, setIndex] = useState(0),
    [materialized, setMaterialized] = useState<Array<{ match: Found; range: Range }>>([]),
    [recoloured, setRecoloured] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const previous = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  // A rescan of the same search (code was coloured, a running turn added text) finds the same matches: the reader stays
  // where they are. Only a match that has not been shown yet moves the view, so a rescan landing before the frame that
  // shows it does not lose the step.
  const shownMatch = useRef<string | null>(null)
  const scanned = useRef({ query: '', sessionId })
  useEffect(() => {
    const fallback = fallbackFocus?.current
    return () => {
      document.querySelector<HTMLElement>('.transcript-content')?.style.removeProperty(CLEARANCE)
      const back = previous.current?.isConnected ? previous.current : fallback
      back?.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusRequest])
  useEffect(() => {
    const root = document.querySelector('.transcript-content')
    const same = scanned.current.query === query && scanned.current.sessionId === sessionId
    scanned.current = { query, sessionId }
    if (!same) shownMatch.current = null
    if (!root || !query) {
      setFound([])
      setIndex(0)
      setMaterialized([])
      return
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
      matches: Scanned[] = [],
      codes = new Set<Element>()
    for (let node = walker.nextNode(); node && matches.length < 500; node = walker.nextNode()) {
      const element = node.parentElement,
        row = element?.closest<HTMLElement>('[data-message-id]')
      if (!row || element?.closest('button, input, textarea, [aria-hidden="true"], .tool-output')) continue
      // Code and a command line are searched as one text: colouring splits their text into tokens, which must not change
      // what matches.
      const code = element?.closest('.message-code code, .command-line')
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
    const keyed = withMatchKeys(matches.slice(0, 500))
    setFound(keyed)
    if (same) setIndex(carriedIndex(found[index]?.key, keyed, index))
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
    if (!target) document.querySelector<HTMLElement>('.transcript-content')?.style.removeProperty(CLEARANCE)
    if (!target || shownMatch.current === target.key) return
    const inner =
      target.outputIndex === undefined
        ? target.range?.startContainer.parentElement
        : target.row.querySelector('.tool-tray > .ui-collapse > .ui-collapse-inner')
    for (const start of [inner, target.row])
      for (let hidden = start?.closest('[hidden="until-found"]'); hidden; hidden = hidden.parentElement?.closest('[hidden="until-found"]'))
        hidden.dispatchEvent(new Event('beforematch'))
    const frame = requestAnimationFrame(() => {
      shownMatch.current = target.key
      const shown = found.flatMap(match => {
        if (match.outputIndex === undefined) return []
        const output = match.row.querySelector('.tool-output'),
          range = output ? outputRange(output, query, match.outputIndex) : undefined
        return range ? [{ match, range }] : []
      })
      setMaterialized(shown)
      const range = target.range ?? shown.find(item => item.match === target)?.range
      const pane = target.row.closest('.transcript')
      if (!range || !pane) {
        onReveal(target.messageId)
        return
      }
      const content = target.row.closest<HTMLElement>('.transcript-content')
      if (content && bar.current) {
        const clearance = findClearance(
          range.getBoundingClientRect(),
          bar.current.getBoundingClientRect(),
          { top: pane.getBoundingClientRect().top, scrollTop: pane.scrollTop },
          clearanceOn(content),
        )
        if (clearance) content.style.setProperty(CLEARANCE, `${String(clearance)}px`)
        else content.style.removeProperty(CLEARANCE)
      }
      const place = matchPlacement(range.getBoundingClientRect(), target.row.getBoundingClientRect(), pane.getBoundingClientRect())
      if (place.move) onReveal(target.messageId, place.offset)
    })
    return () => cancelAnimationFrame(frame)
  }, [found, index, onReveal, query])
  const next = (step: number) => {
    setIndex(value => (found.length ? (value + step + found.length) % found.length : 0))
  }
  return (
    <div
      ref={bar}
      className="find-bar"
      role="search"
      aria-label="会话内查找"
      onKeyDownCapture={event => {
        // These keys belong to the input method while it composes: Enter commits the text, Esc drops it.
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          if (event.key === 'Escape') event.preventDefault()
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          overlayDismissed()
          onClose()
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          next(event.shiftKey ? -1 : 1)
        }
      }}>
      <SearchField ref={input} variant="ghost" label="查找消息内容" placeholder="在会话中查找" value={query} onValueChange={setQuery} />
      <span role="status">{query ? (found.length ? `${index + 1}/${found.length}${found.length === 500 ? '+' : ''}` : '0/0') : ''}</span>
      <IconButton
        label="上一个匹配"
        tooltip="上一个"
        shortcut="⇧⏎"
        size="xs"
        icon={ChevronUpGlyph}
        disabled={!found.length}
        onClick={() => {
          next(-1)
        }}
      />
      <IconButton
        label="下一个匹配"
        tooltip="下一个"
        shortcut="⏎"
        size="xs"
        icon={ChevronDownGlyph}
        disabled={!found.length}
        onClick={() => {
          next(1)
        }}
      />
      <IconButton label="关闭查找" tooltip="关闭" shortcut="esc" size="xs" icon={CloseGlyph} onClick={onClose} />
    </div>
  )
}
