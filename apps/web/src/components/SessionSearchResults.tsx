import type { SearchHit } from '@latch/protocol'
import type { SessionSearchState } from '../hooks/useSessionSearch.ts'

export function SessionSearchResults({ state, onSelect }: { state: SessionSearchState; onSelect: (hit: SearchHit) => void }) {
  return (
    <section className="content-search" aria-label="内容中包含" aria-busy={state.loading}>
      <h3>内容中包含</h3>
      {state.loading && <p role="status">正在搜索正文…</p>}
      {state.error && <p role="status">{state.error}</p>}
      {!state.loading && !state.error && state.hits.length === 0 && <p>没有匹配的正文</p>}
      {state.hits.map(hit => (
        <button type="button" key={`${hit.sessionId}:${hit.messageId}`} onClick={() => onSelect(hit)}>
          <span>
            {hit.title || '未命名会话'}
            {hit.archived && <small>已归档</small>}
          </span>
          <span className="search-snippet">
            {hit.snippet.slice(0, hit.match.start)}
            <mark>{hit.snippet.slice(hit.match.start, hit.match.end)}</mark>
            {hit.snippet.slice(hit.match.end)}
          </span>
        </button>
      ))}
      {state.truncated && <p>已显示部分结果，请缩小搜索范围。</p>}
    </section>
  )
}
