import { useEffect, useState } from 'react'
import { api, errorMessage } from '../core/api.ts'
export interface FileSearchTarget {
  sessionId: string
  reference: string
  rootId: string
}
interface FileResults {
  files: Array<{ name: string; path: string; root: string }>
  truncated: boolean
}
export function useFileSearch(query: string, sessionId: string | undefined) {
  const [state, setState] = useState<FileResults & { loading: boolean; error: string }>({
    files: [],
    truncated: false,
    loading: false,
    error: '',
  })
  useEffect(() => {
    if (!sessionId || !query.trim()) {
      setState({ files: [], truncated: false, loading: false, error: '' })
      return
    }
    const controller = new AbortController()
    setState({ files: [], truncated: false, loading: true, error: '' })
    const timer = setTimeout(() => {
      void api<FileResults>(`tasks/${encodeURIComponent(sessionId)}/files/search`, {
        method: 'POST',
        body: { q: query.trim(), limit: 100 },
        signal: controller.signal,
      }).then(
        result => {
          if (!controller.signal.aborted) setState({ ...result, loading: false, error: '' })
        },
        error => {
          if (!controller.signal.aborted) setState({ files: [], truncated: false, loading: false, error: errorMessage(error) })
        },
      )
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, sessionId])
  return state
}
