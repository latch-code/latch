import { useEffect, useState } from 'react'
import { isFileMention, type FileContext } from '@latch/protocol'
import { api, errorMessage, MessageError } from '../core/api.ts'
import { fileContextBody, fileContextKey, fileRoute } from '../preview/fileContext.ts'
interface FileResults {
  files: Array<{ name: string; path: string; root: string }>
  truncated: boolean
  /** Entries whose ignore check the Host cut short (treated as ignored). */
  unchecked?: { files: number; directories: number }
}
const isCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export function useFileSearch(query: string, context: FileContext | undefined) {
  const [state, setState] = useState<FileResults & { loading: boolean; error: string }>({
    files: [],
    truncated: false,
    loading: false,
    error: '',
  })
  const key = context ? fileContextKey(context) : undefined
  useEffect(() => {
    if (!context) {
      setState({ files: [], truncated: false, loading: false, error: '' })
      return
    }
    const controller = new AbortController()
    setState({ files: [], truncated: false, loading: true, error: '' })
    const timer = setTimeout(() => {
      void api<FileResults>(fileRoute(context, 'search'), {
        method: 'POST',
        body: { ...fileContextBody(context), q: query.trim(), limit: 100 },
        signal: controller.signal,
      })
        .then(result => {
          if (
            !Array.isArray(result.files)
            || result.files.length > 100
            || typeof result.truncated !== 'boolean'
            || result.files.some(file => typeof file.name !== 'string' || !isFileMention({ root: file.root, path: file.path }))
            || (result.unchecked !== undefined && (!isCount(result.unchecked.files) || !isCount(result.unchecked.directories)))
          )
            throw new MessageError('文件搜索响应无效。')
          if (!controller.signal.aborted)
            setState({
              files: result.files,
              truncated: result.truncated,
              ...(result.unchecked ? { unchecked: { files: result.unchecked.files, directories: result.unchecked.directories } } : {}),
              loading: false,
              error: '',
            })
        })
        .catch(cause => {
          if (!controller.signal.aborted) setState({ files: [], truncated: false, loading: false, error: errorMessage(cause) })
        })
    }, 180)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, key])
  return state
}
