import type { Message, SearchResults, TaskDetail, TaskSummary } from '@latch/protocol'

interface SearchSource {
  list(): Promise<TaskSummary[]>
  detail(id: string): Promise<TaskDetail>
  /** Applied to every search, including cached text. */
  visible?(summary: TaskSummary): boolean
  now?: () => number
  budgetMs?: number
}
interface CachedText {
  updatedAt: string
  messages: Array<Pick<Message, 'id' | 'text'>>
}

/** Session text is bounded and private to the Host. Queries never become URLs or cache keys. */
export class SessionSearch {
  private readonly cache = new Map<string, CachedText>()
  private readonly now: () => number
  private readonly budget: number
  constructor(private readonly source: SearchSource) {
    this.now = source.now ?? Date.now
    this.budget = source.budgetMs ?? 1000
  }

  async search(query: string, limit = 30): Promise<SearchResults> {
    const q = query.trim().toLocaleLowerCase()
    if (!q) return { hits: [], truncated: false }
    const started = this.now()
    const hits: SearchResults['hits'] = []
    let listTimer: ReturnType<typeof setTimeout> | undefined
    const summaries = await Promise.race([
      this.source.list(),
      new Promise<null>(done => {
        listTimer = setTimeout(() => done(null), this.budget)
      }),
    ]).finally(() => clearTimeout(listTimer))
    if (!summaries) return { hits: [], truncated: true }
    const existing = new Set(summaries.map(summary => summary.id))
    for (const id of this.cache.keys()) if (!existing.has(id)) this.cache.delete(id)
    let truncated = false
    for (const summary of summaries) {
      if (this.source.visible && !this.source.visible(summary)) continue
      if (this.now() - started >= this.budget) {
        truncated = true
        break
      }
      const running = summary.status === 'running' || summary.status === 'waiting-approval'
      let cached = this.cache.get(summary.id)
      if (!cached || cached.updatedAt !== summary.updatedAt || running) {
        const remaining = Math.max(1, this.budget - (this.now() - started))
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const detail = await Promise.race([
            this.source.detail(summary.id),
            new Promise<null>(done => {
              timer = setTimeout(() => done(null), remaining)
            }),
          ])
          if (!detail) {
            truncated = true
            break
          }
          cached = {
            updatedAt: summary.updatedAt,
            messages: detail.messages
              .filter(message => message.role === 'user' || message.role === 'assistant')
              .map(({ id, text }) => ({ id, text })),
          }
          this.cache.delete(summary.id)
          const characters = (entry: CachedText) => entry.messages.reduce((sum, item) => sum + item.text.length, 0)
          if (!running && characters(cached) <= 1_000_000) this.cache.set(summary.id, cached)
          let total = [...this.cache.values()].reduce((sum, entry) => sum + characters(entry), 0)
          while (this.cache.size > 500 || total > 10_000_000) {
            const oldest = this.cache.keys().next().value!
            total -= characters(this.cache.get(oldest)!)
            this.cache.delete(oldest)
          }
        } catch {
          // A removed or unavailable session must not prevent searches in the rest.
          continue
        } finally {
          clearTimeout(timer)
        }
      }
      for (const message of cached.messages) {
        if (this.now() - started >= this.budget) {
          truncated = true
          break
        }
        const index = message.text.toLocaleLowerCase().indexOf(q)
        if (index < 0) continue
        if (hits.length === limit) {
          truncated = true
          break
        }
        const start = Math.max(0, index - 48)
        const snippet = message.text.slice(start, start + 160)
        hits.push({
          sessionId: summary.id,
          messageId: message.id,
          title: summary.title,
          snippet,
          match: { start: index - start, end: Math.min(snippet.length, index - start + q.length) },
          updatedAt: summary.updatedAt,
          archived: summary.archived === true,
        })
      }
      if (truncated) break
    }
    return { hits, truncated }
  }
}
