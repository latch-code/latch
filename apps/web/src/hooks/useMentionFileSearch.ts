import { useCallback, useEffect, useRef, useState } from 'react'
import { isFileMention, type FileContext, type FileMention } from '@latch/protocol'
import { api, ApiError, errorMessage, MessageError } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'
import { fileRoute } from '../preview/fileContext.ts'

const COPY = defineCopy({ invalid: '文件搜索响应无效。' }, { invalid: 'The file search response was invalid.' })
const PAGE_SIZE = 12
export const MAX_LISTED_FILES = 240

type MentionFile = FileMention & { name: string; ignored?: boolean }
interface FilePage {
  files: MentionFile[]
  truncated: boolean
  nextCursor?: string
}
interface Search extends FilePage {
  loading: boolean
  error: string
  emptyPages: number
}
const EMPTY: Search = { files: [], truncated: false, loading: false, error: '', emptyPages: 0 }

export function useMentionFileSearch(context: FileContext | undefined, query: string) {
  const path = context && fileRoute(context, 'search')
  const harnessId = context?.kind === 'workspace' ? context.harnessId : undefined
  const key = path && JSON.stringify([path, harnessId, query])
  const [result, setResult] = useState<{ key: string; search: Search }>()
  const request = useRef<{ key: string; read(cursor?: string): void } | undefined>(undefined)
  useEffect(() => {
    if (!key || !path) {
      setResult(undefined)
      return undefined
    }
    const controller = new AbortController()
    const seen = new Set<string>()
    let search = EMPTY
    const publish = (next: Search) => {
      search = next
      setResult({ key, search })
    }
    let started = false
    const read = async (cursor?: string) => {
      if (controller.signal.aborted || search.loading || cursor !== search.nextCursor || (started && !cursor && !search.error)) return
      started = true
      publish({ ...search, loading: true, error: '' })
      try {
        const page = await api<FilePage>(path, {
          method: 'POST',
          body: {
            ...(harnessId === undefined ? {} : { harnessId }),
            q: query,
            page: true,
            limit: PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          },
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        if (
          !Array.isArray(page.files)
          || page.files.length > PAGE_SIZE
          || typeof page.truncated !== 'boolean'
          || (page.nextCursor !== undefined && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor === cursor))
        )
          throw new MessageError(COPY.invalid)
        const added = page.files.filter(file => {
          if (!file || typeof file.name !== 'string' || file.name.length > 200 || !isFileMention({ root: file.root, path: file.path }))
            return false
          const fileKey = `${file.root}:${file.path}`
          if (seen.has(fileKey)) return false
          seen.add(fileKey)
          return true
        })
        const files = [...search.files, ...added]
        const full = files.length >= MAX_LISTED_FILES
        publish({
          files: full ? files.slice(0, MAX_LISTED_FILES) : files,
          ...(!full && page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          truncated: page.truncated || (full && (!!page.nextCursor || files.length > MAX_LISTED_FILES)),
          loading: false,
          error: '',
          emptyPages: added.length ? 0 : search.emptyPages + 1,
        })
      } catch (cause) {
        if (controller.signal.aborted) return
        // Expiry, changed folders and withdrawn access invalidate the names already displayed. Transient failures can retry the same page.
        if (cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status)) {
          seen.clear()
          search = EMPTY
        }
        publish({ ...search, error: errorMessage(cause), loading: false })
      }
    }
    request.current = { key, read: cursor => void read(cursor) }
    // Opening the picker is an explicit request. Only debounce changes to the words being searched.
    const timer = query ? setTimeout(() => void read(), 100) : undefined
    if (!query) void read()
    return () => {
      clearTimeout(timer)
      controller.abort()
      request.current = undefined
    }
  }, [path, harnessId, query, key])
  const readMore = useCallback(
    (cursor?: string) => {
      if (request.current && request.current.key === key) request.current.read(cursor)
    },
    [key],
  )
  const search = result && result.key === key ? result.search : { ...EMPTY, loading: !!key }
  return { ...search, readMore }
}
