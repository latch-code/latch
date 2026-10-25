import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, SearchField, TextField } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { CopyButton } from '../components/ui.tsx'
import { SyntaxLine, useHighlightedTokens } from './HighlightedCode.tsx'
import { languageForPath } from './highlight-protocol.ts'
export function TextPreview({
  text,
  path,
  line = 1,
  sensitive = false,
}: {
  text: string
  path?: string
  line?: number
  sensitive?: boolean
}) {
  const lines = useMemo(() => text.split('\n'), [text])
  const tokens = useHighlightedTokens(text, languageForPath(path ?? ''), !sensitive)
  const search = useRef<HTMLInputElement>(null)
  const requestedLine = useRef(line)
  const [start, setStart] = useState(Math.max(0, line - 1)),
    [query, setQuery] = useState(''),
    [wrap, setWrap] = useState(false)
  useEffect(() => {
    const changed = requestedLine.current !== line
    requestedLine.current = line
    setStart(previous => Math.max(0, Math.min(lines.length - 1, changed ? line - 1 : previous)))
  }, [line, lines.length])
  const find = () => {
    if (!query) return
    const index = lines.findIndex((value, index) => index > start && value.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    const first = index < 0 ? lines.findIndex(value => value.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : index
    if (first >= 0) setStart(first)
  }
  return (
    <div
      className="text-preview"
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault()
          event.stopPropagation()
          search.current?.focus()
        }
      }}>
      <div className="file-preview-controls">
        <SearchField
          ref={search}
          label="查找文件内容"
          placeholder="查找"
          value={query}
          onValueChange={setQuery}
          onKeyDown={event => {
            if (event.key === 'Enter') find()
          }}
        />
        <CopyButton text={text} label="复制文件内容" size="xs" />
        <Button size="xs" variant="ghost" onClick={find}>
          下一个
        </Button>
        <Button size="xs" variant="ghost" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
          自动换行
        </Button>
        <TextField
          label={<span className="sr-only">跳到行</span>}
          className="file-line-jump"
          aria-label="跳到行"
          type="number"
          min={1}
          max={lines.length}
          value={start + 1}
          onChange={event => {
            const value = Number(event.target.value)
            if (Number.isInteger(value)) setStart(Math.max(0, Math.min(lines.length - 1, value - 1)))
          }}
        />
      </div>
      <pre className="file-text" data-wrap={wrap ? '' : undefined} tabIndex={0}>
        {lines.slice(start, start + 200).map((text, index) => (
          <span className="file-text-line" key={start + index}>
            <span className="file-line-number" aria-hidden="true">
              {start + index + 1}
            </span>
            <code>{text ? <SyntaxLine text={text} tokens={tokens?.[start + index]} /> : <VisibleText text="\n" />}</code>
          </span>
        ))}
      </pre>
      <div className="file-preview-controls">
        {lines.length > 200 && (
          <Button size="xs" disabled={start === 0} onClick={() => setStart(Math.max(0, start - 200))}>
            前 200 行
          </Button>
        )}
        <span>
          {start + 1}–{Math.min(start + 200, lines.length)} / {lines.length} 行
        </span>
        {lines.length > 200 && (
          <Button size="xs" disabled={start + 200 >= lines.length} onClick={() => setStart(start + 200)}>
            后 200 行
          </Button>
        )}
      </div>
    </div>
  )
}
