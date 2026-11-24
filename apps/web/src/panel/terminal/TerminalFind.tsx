import { useEffect, useRef, useState } from 'react'
import { SearchField, IconButton, ChevronUpGlyph, ChevronDownGlyph, CloseGlyph } from '@latch/ui'
import { defineCopy } from '../../core/i18n.ts'
import type { TerminalMatch } from './find.ts'

const COPY = defineCopy(
  { find: '查找终端输出', previous: '上一处', next: '下一处', close: '关闭查找', none: '没有匹配行' },
  { find: 'Find terminal output', previous: 'Previous match', next: 'Next match', close: 'Close find', none: 'No matching lines' },
)

export function TerminalFind({
  find,
  close,
}: {
  find(query: string, previous: number | undefined, direction: 1 | -1): TerminalMatch | undefined
  close(): void
}) {
  const [query, setQuery] = useState('')
  const [match, setMatch] = useState<TerminalMatch>()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  const step = (direction: 1 | -1) => setMatch(find(query, match?.row, direction))
  return (
    <div className="terminal-find" role="search" aria-label={COPY.find}>
      <SearchField
        ref={input}
        label={COPY.find}
        value={query}
        maxLength={512}
        onValueChange={value => {
          setQuery(value)
          setMatch(find(value, undefined, 1))
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') {
            event.preventDefault()
            step(event.shiftKey ? -1 : 1)
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
        }}
      />
      <span role="status">{query && match && (match.total ? `${match.current}/${match.total}` : COPY.none)}</span>
      <IconButton size="xs" label={COPY.previous} icon={ChevronUpGlyph} disabled={!query} onClick={() => step(-1)} />
      <IconButton size="xs" label={COPY.next} icon={ChevronDownGlyph} disabled={!query} onClick={() => step(1)} />
      <IconButton size="xs" label={COPY.close} icon={CloseGlyph} onClick={close} />
    </div>
  )
}
