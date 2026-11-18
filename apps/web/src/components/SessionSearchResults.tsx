import type { SearchHit } from '@latch/protocol'
import type { SessionSearchState } from '../hooks/useSessionSearch.ts'
import { defineCopy } from '../core/i18n.ts'

const CONTENT_SEARCH_COPY = defineCopy(
  {
    title: '内容中包含',
    loading: '正在搜索正文…',
    none: '没有匹配的正文',
    untitled: '未命名会话',
    archived: '已归档',
    truncated: '已显示部分结果，请缩小搜索范围。',
  },
  {
    title: 'In messages',
    loading: 'Searching messages…',
    none: 'No matching messages',
    untitled: 'Untitled session',
    archived: 'Archived',
    truncated: 'Showing some results only. Narrow the search.',
  },
)

export function SessionSearchResults({ state, onSelect }: { state: SessionSearchState; onSelect: (hit: SearchHit) => void }) {
  return (
    <section className="content-search" aria-label={CONTENT_SEARCH_COPY.title} aria-busy={state.loading}>
      <h3>{CONTENT_SEARCH_COPY.title}</h3>
      {state.loading && <p role="status">{CONTENT_SEARCH_COPY.loading}</p>}
      {state.error && <p role="status">{state.error}</p>}
      {!state.loading && !state.error && state.hits.length === 0 && <p>{CONTENT_SEARCH_COPY.none}</p>}
      {state.hits.map(hit => (
        <button type="button" key={`${hit.sessionId}:${hit.messageId}`} onClick={() => onSelect(hit)}>
          <span>
            {hit.title || CONTENT_SEARCH_COPY.untitled}
            {hit.archived && <small>{CONTENT_SEARCH_COPY.archived}</small>}
          </span>
          <span className="search-snippet">
            {hit.snippet.slice(0, hit.match.start)}
            <mark>{hit.snippet.slice(hit.match.start, hit.match.end)}</mark>
            {hit.snippet.slice(hit.match.end)}
          </span>
        </button>
      ))}
      {state.truncated && <p>{CONTENT_SEARCH_COPY.truncated}</p>}
    </section>
  )
}
