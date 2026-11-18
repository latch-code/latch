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
import { api, errorMessage } from '../core/api.ts'
import { defineCopy, formatNumber } from '../core/i18n.ts'
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

const COPY = defineCopy(
  {
    badReply: '内容搜索的响应无效。',
    line: (file: string, number: number) => `${file} 第 ${formatNumber(number)} 行`,
    search: '搜索内容',
    matchCase: '区分大小写',
    wholeWord: '全字匹配',
    back: '返回文件树',
    searching: '正在搜索',
    more: '更多结果未显示',
    skipped: '有跳过',
    results: '搜索结果',
  },
  {
    badReply: 'The file search response was invalid.',
    line: (file: string, number: number) => `${file}, line ${formatNumber(number)}`,
    search: 'Search file contents',
    matchCase: 'Match case',
    wholeWord: 'Match whole word',
    back: 'Back to file tree',
    searching: 'Searching',
    more: 'More matches are available',
    skipped: 'Some files were skipped',
    results: 'Search results',
  },
)

type State =
  | { phase: 'idle' }
  | { phase: 'searching'; previous?: ContentResults }
  | { phase: 'done'; results: ContentResults }
  | { phase: 'failed'; error: 'invalid-reply' | { cause: unknown } }

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
          if (!controller.signal.aborted) setState(results ? { phase: 'done', results } : { phase: 'failed', error: 'invalid-reply' })
        })
        .catch(cause => {
          if (!controller.signal.aborted) setState({ phase: 'failed', error: { cause } })
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
                aria-label={COPY.line(file.name, item.line)}
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
    <div className="content-search" role="search" aria-label={COPY.search} data-searching={state.phase === 'searching' ? '' : undefined}>
      <div className="content-search-head">
        <SearchField
          ref={field}
          label={COPY.search}
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
          label={COPY.matchCase}
          pressed={caseSensitive}
          onClick={() => setCaseSensitive(value => !value)}
        />
        <IconButton size="xs" icon={WholeWord} label={COPY.wholeWord} pressed={wholeWord} onClick={() => setWholeWord(value => !value)} />
        <IconButton size="xs" icon={CloseGlyph} label={COPY.back} onClick={onClose} />
      </div>
      <div className="content-search-status" role="status">
        {state.phase === 'searching' && (
          <span className="content-search-busy">
            <Spinner size={12} />
            {COPY.searching}
          </span>
        )}
        {summary && (
          <>
            <span className="content-search-summary">{summary.text}</span>
            {summary.partial && (
              <Hint className="content-search-partial" label={COPY.more}>
                {summary.partial}
              </Hint>
            )}
            {summary.skipped && (
              <Hint className="content-search-skipped" label={COPY.skipped}>
                {summary.skipped}
              </Hint>
            )}
            {summary.unchecked && (
              <Hint className="content-search-skipped" label={summary.unchecked.label}>
                {summary.unchecked.detail}
              </Hint>
            )}
          </>
        )}
      </div>
      {state.phase === 'failed' && (
        <InlineNotice tone="error">{state.error === 'invalid-reply' ? COPY.badReply : errorMessage(state.error.cause)}</InlineNotice>
      )}
      {results && results.files.length > 0 && (
        <ul className="content-search-results" aria-label={COPY.results} data-stale={state.phase === 'searching' ? '' : undefined}>
          {results.files.map(file => (
            <FileResults key={`${file.root}:${file.path}`} file={file} context={context} roots={roots} />
          ))}
        </ul>
      )}
    </div>
  )
}
