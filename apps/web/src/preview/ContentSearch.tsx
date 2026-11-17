import { useContext, useEffect, useRef, useState } from 'react'
import { CaseSensitive, WholeWord } from 'lucide-react'
import type { FileContext } from '@latch/protocol'
import {
  ChevronDownGlyph,
  ChevronRightGlyph,
  CloseGlyph,
  Hint,
  ICON_STROKE,
  IconButton,
  InlineNotice,
  SearchField,
  Spinner,
} from '@latch/ui'
import { api, errorMessage, MessageError } from '../core/api.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { fileContextBody, fileContextKey, fileRoute, FileOpenContext, targetIn } from './fileContext.ts'
import {
  folderOf,
  highlightParts,
  parseContentResults,
  resultSummary,
  type ContentFile,
  type ContentQuery,
  type ContentResults,
} from './contentSearch.ts'

type State =
  | { phase: 'idle' }
  | { phase: 'searching'; previous?: ContentResults }
  | { phase: 'done'; results: ContentResults }
  | { phase: 'failed'; message: string }

/**
 * Asks the Host once the typing pauses; a new query or option aborts the request before, which ends that search on the
 * Host too. Nothing is sent for an empty field.
 */
function useContentSearch(context: FileContext, query: ContentQuery): State {
  const [state, setState] = useState<State>({ phase: 'idle' })
  const key = fileContextKey(context)
  useEffect(() => {
    if (!query.q) {
      setState({ phase: 'idle' })
      return undefined
    }
    const controller = new AbortController()
    setState(previous => ({ phase: 'searching', ...(previous.phase === 'done' ? { previous: previous.results } : {}) }))
    const timer = setTimeout(() => {
      void api<unknown>(fileRoute(context, 'grep'), {
        method: 'POST',
        body: { ...fileContextBody(context), q: query.q, caseSensitive: query.caseSensitive, wholeWord: query.wholeWord },
        signal: controller.signal,
      })
        .then(reply => {
          const results = parseContentResults(reply)
          if (!results) throw new MessageError('内容搜索的响应无效。')
          if (!controller.signal.aborted) setState({ phase: 'done', results })
        })
        .catch(cause => {
          if (!controller.signal.aborted) setState({ phase: 'failed', message: errorMessage(cause) })
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // The context object changes identity on every render; its key does not.
  }, [key, query.q, query.caseSensitive, query.wholeWord])
  return state
}

function Line({ text, ranges, before, after }: { text: string; ranges: Array<[number, number]>; before?: true; after?: true }) {
  return (
    <span className="content-search-text">
      {before && <span className="content-search-cut">…</span>}
      {highlightParts(text, ranges).map((part, index) =>
        part.match ? (
          <mark key={index}>
            <VisibleText text={part.text} />
          </mark>
        ) : (
          <VisibleText key={index} text={part.text} />
        ),
      )}
      {after && <span className="content-search-cut">…</span>}
    </span>
  )
}

function FileResults({ file, context, roots }: { file: ContentFile; context: FileContext; roots: boolean }) {
  const open = useContext(FileOpenContext)
  const [folded, setFolded] = useState(false)
  const folder = folderOf(file.path)
  return (
    <li className="content-search-file" data-content-file={`${file.root}:${file.path}`}>
      <button
        type="button"
        className="content-search-file-head"
        aria-expanded={!folded}
        title={file.path}
        onClick={() => {
          setFolded(value => !value)
        }}>
        {folded ? (
          <ChevronRightGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        ) : (
          <ChevronDownGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        )}
        <span className="content-search-name">
          <VisibleText text={file.name} />
        </span>
        {(folder || roots) && (
          <span className="content-search-folder">
            <VisibleText text={roots ? [file.root === 'default' ? '' : file.root, folder].filter(Boolean).join(' · ') : folder} />
          </span>
        )}
        <span className="content-search-count">{file.more ? `${file.lines.length}+` : file.lines.length}</span>
      </button>
      {!folded && (
        <ul className="content-search-lines">
          {file.lines.map(item => (
            <li key={item.line}>
              <button
                type="button"
                className="content-search-line"
                data-line={item.line}
                aria-label={`${file.name} 第 ${item.line} 行`}
                onClick={() => open?.({ ...targetIn(context, file.path, file.root), line: item.line })}>
                <span className="content-search-number">{item.line}</span>
                <Line {...item} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * 搜索内容 in the files panel: one field, 区分大小写 and 全字匹配, and the matching lines grouped by file. Choosing a line
 * opens that file at the line through the same preview as the tree. Esc in an empty field goes back to the tree.
 */
export function ContentSearch({ context, focus = 0, onClose }: { context: FileContext; focus?: number; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const state = useContentSearch(context, { q, caseSensitive, wholeWord })
  useEffect(() => {
    field.current?.focus({ preventScroll: true })
    field.current?.select()
  }, [focus])
  const results = state.phase === 'done' ? state.results : state.phase === 'searching' ? state.previous : undefined
  const summary = state.phase === 'done' ? resultSummary(state.results) : undefined
  const roots = new Set(results?.files.map(file => file.root)).size > 1
  return (
    <div className="content-search" role="search" aria-label="搜索内容" data-searching={state.phase === 'searching' ? '' : undefined}>
      <div className="content-search-head">
        <SearchField
          ref={field}
          label="搜索内容"
          value={q}
          maxLength={256}
          onValueChange={value => {
            setQ(value.replace(/[\r\n]/gu, ' '))
          }}
          onKeyDown={event => {
            if (event.key === 'Escape' && !q) {
              event.preventDefault()
              event.stopPropagation()
              onClose()
            }
          }}
        />
        <IconButton
          size="xs"
          icon={CaseSensitive}
          label="区分大小写"
          pressed={caseSensitive}
          onClick={() => setCaseSensitive(value => !value)}
        />
        <IconButton size="xs" icon={WholeWord} label="全字匹配" pressed={wholeWord} onClick={() => setWholeWord(value => !value)} />
        <IconButton size="xs" icon={CloseGlyph} label="返回文件树" onClick={onClose} />
      </div>
      <div className="content-search-status" role="status">
        {state.phase === 'searching' && (
          <span className="content-search-busy">
            <Spinner size={12} />
            正在搜索
          </span>
        )}
        {summary && (
          <>
            <span className="content-search-summary">{summary.text}</span>
            {summary.partial && (
              <Hint className="content-search-partial" label="更多结果未显示">
                {summary.partial}
              </Hint>
            )}
            {summary.skipped && (
              <Hint className="content-search-skipped" label="有跳过">
                {summary.skipped}
              </Hint>
            )}
          </>
        )}
      </div>
      {state.phase === 'failed' && <InlineNotice tone="error">{state.message}</InlineNotice>}
      {results && results.files.length > 0 && (
        <ul className="content-search-results" aria-label="搜索结果" data-stale={state.phase === 'searching' ? '' : undefined}>
          {results.files.map(file => (
            <FileResults key={`${file.root}:${file.path}`} file={file} context={context} roots={roots} />
          ))}
        </ul>
      )}
    </div>
  )
}
