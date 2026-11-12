import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../core/api.ts'
import { lockedRead } from './model.ts'

/** A paged read: the pages so far, whether more can be read, and why a read failed. */
export interface PagedRead<T> {
  state: 'loading' | 'ready' | 'locked' | 'failed'
  items: T[]
  /** Another page exists. */
  more: boolean
  /** A further page is being read. */
  loadingMore: boolean
  message?: string
}

/**
 * Reads `path` page by page (`before` is the page's `next`), starting again from the first page whenever `version`
 * changes. `null` reads nothing. What was shown stays while it reads again.
 */
export function usePaged<P extends { next?: string }, T>(path: string | null, version: string, items: (page: P) => T[]) {
  const [read, setRead] = useState<PagedRead<T>>({ state: 'loading', items: [], more: false, loadingMore: false })
  const next = useRef<string | undefined>(undefined)
  /** The first-page load the shown pages belong to: a later page from an earlier load is dropped, never appended. */
  const load = useRef(0)
  const pick = useRef(items)
  pick.current = items
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (path === null) return undefined
    const controller = new AbortController()
    const token = ++load.current
    next.current = undefined
    api<P>(path, { signal: controller.signal })
      .then(page => {
        if (token !== load.current) return
        next.current = page.next
        setRead({ state: 'ready', items: pick.current(page), more: page.next !== undefined, loadingMore: false })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setRead(previous => ({
          ...previous,
          state: lockedRead(error) ? 'locked' : 'failed',
          loadingMore: false,
          message: errorMessage(error),
        }))
      })
    return () => {
      controller.abort()
    }
  }, [path, version, attempt])
  const loadMore = useCallback(() => {
    if (path === null || next.current === undefined) return
    const cursor = next.current
    const token = load.current
    // One further page at a time.
    next.current = undefined
    setRead(previous => ({ ...previous, loadingMore: true }))
    api<P>(`${path}?before=${encodeURIComponent(cursor)}`)
      .then(page => {
        if (token !== load.current) return
        next.current = page.next
        setRead(previous => ({
          state: 'ready',
          items: [...previous.items, ...pick.current(page)],
          more: page.next !== undefined,
          loadingMore: false,
        }))
      })
      .catch((error: unknown) => {
        if (token !== load.current) return
        next.current = cursor
        setRead(previous => ({ ...previous, loadingMore: false, message: errorMessage(error) }))
      })
  }, [path])
  const reload = useCallback(() => {
    setAttempt(value => value + 1)
  }, [])
  return { read, loadMore, reload }
}
