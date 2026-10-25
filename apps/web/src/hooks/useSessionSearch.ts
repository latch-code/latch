import { useEffect, useState } from 'react'
import type { SearchResults } from '@latch/protocol'
import { api, errorMessage } from '../core/api.ts'

export interface SessionSearchState extends SearchResults {
  loading: boolean
  error: string
}
const empty: SessionSearchState = { hits: [], truncated: false, loading: false, error: '' }

/** A response belongs to the exact query and is discarded when it changes or the view closes. */
export function useSessionSearch(query: string, enabled: boolean): SessionSearchState {
  const [state, setState] = useState<SessionSearchState>(empty)
  useEffect(() => {
    const q = query.trim()
    if (!enabled || !q) {
      setState(empty)
      return
    }
    const controller = new AbortController()
    setState({ ...empty, loading: true })
    const timer = setTimeout(() => {
      void api<SearchResults>('search', { method: 'POST', body: { q, limit: 30 }, signal: controller.signal }).then(
        result => {
          if (!controller.signal.aborted) setState({ ...result, loading: false, error: '' })
        },
        error => {
          if (!controller.signal.aborted) setState({ ...empty, error: errorMessage(error) })
        },
      )
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, enabled])
  return state
}
