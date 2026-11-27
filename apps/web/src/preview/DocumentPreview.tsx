import csvWorkerUrl from './csv.worker.ts?worker&url'
import { trustedScriptUrl } from './runtime.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { InlineNotice } from '@latch/ui'
import { isFrameEvent, type DocumentPreviewProps, type FrameCommand, type FrameOrigin, type GridCell, type SheetInfo } from './types.ts'
import { deferredComponent } from '../components/DeferredContent.tsx'
import { SheetGrid, type SheetView } from './SheetGrid.tsx'
import { openDocumentLink } from './openLink.ts'
import { DOCUMENT_PREVIEW_ERRORS } from '../core/securityCopy.ts'
import { useViewerMenu, useViewerQuote, useViewerSource } from './viewerActions.tsx'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    readFailed: '文件暂时无法读取，请重新打开后重试。',
    noQuote: '这一页没有可引用的文字。',
    trackedChanges: '显示修订',
    fitWidth: '适应宽度',
    reading: '正在读取文档…',
    pageCount: (index: number, count: number) => `${formatNumber(index)} / ${formatNumber(count)} 页`,
    delimiters: { '': '自动识别', ',': '逗号', '\t': 'Tab', ';': '分号', '|': '竖线' },
    updating: '正在更新文档…',
    retained: ' 之前读到的内容仍保留在这里。',
    truncated: '文件较大，部分行、列或单元格内容未显示。',
    sheets: '工作表',
    sheetName: (index: number) => `工作表 ${formatNumber(index)}`,
    table: '表格',
    invalidTable: '无法显示这个表格。',
    fileUnavailable: '文件暂时无法读取。',
    delimiter: (value1: string) => `分隔符：${value1}`,
    tableTruncated: '表格较大，部分行、列或文字未显示。',
    replaced: '部分字符无法识别，已用替代字符显示。',
    tableUpdating: '正在更新表格…',
    tableReading: '正在读取表格…',
    notSupported: '这个文件不能在应用内预览。',
    unavailable: '暂时无法预览这个文件。',
  },
  {
    readFailed: 'Could not read the file right now. Reopen it and try again.',
    noQuote: 'There is no text to quote on this page.',
    trackedChanges: 'Show tracked changes',
    fitWidth: 'Fit width',
    reading: 'Reading document…',
    pageCount: (index: number, count: number) => `${formatNumber(index)} / ${plural(count, { one: '{n} page', other: '{n} pages' })}`,
    delimiters: { '': 'Detect', ',': 'Comma', '\t': 'Tab', ';': 'Semicolon', '|': 'Pipe' },
    updating: 'Updating document…',
    retained: ' The previously read content stays here.',
    truncated: 'Large file. Some rows, columns or cells are not shown.',
    sheets: 'Sheets',
    sheetName: (index: number) => `Sheet ${formatNumber(index)}`,
    table: 'Table',
    invalidTable: 'Could not show this table.',
    fileUnavailable: 'Could not read the file right now.',
    delimiter: (value1: string) => `Delimiter – ${value1}`,
    tableTruncated: 'Large table. Some rows, columns or text are not shown.',
    replaced: 'Some characters could not be read and were replaced.',
    tableUpdating: 'Updating table…',
    tableReading: 'Reading table…',
    notSupported: 'This file cannot be previewed in the app.',
    unavailable: 'This file cannot be previewed right now.',
  },
)

const PdfPreview = deferredComponent(() => import('./PdfPreview.tsx'), 'PDF')
const sheetLabel = (sheet: SheetInfo) => (sheet.unnamed ? COPY.sheetName(sheet.id + 1) : sheet.name)
type Pending = { resolve: (rows: GridCell[][]) => void; reject: () => void; timer: ReturnType<typeof setTimeout> }
/** `system` pins no attribute on the page, so the frame reads what the media query decided. */
const documentTheme = () =>
  document.documentElement.dataset.theme ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
function OfficePreview({ file, versionKey, read, renderFrame, onQuote }: DocumentPreviewProps) {
  const [data, setData] = useState<ArrayBuffer>(),
    [loadedKey, setLoadedKey] = useState(''),
    [problem, setProblem] = useState<keyof typeof DOCUMENT_PREVIEW_ERRORS | 'read-failed'>(),
    [sheets, setSheets] = useState<SheetInfo[]>([]),
    [selected, setSelected] = useState(0),
    [page, setPage] = useState({ index: 0, count: 0 }),
    [fit, setFit] = useState(true),
    [truncated, setTruncated] = useState(false),
    [changes, setChanges] = useState(false),
    [emptyQuote, setEmptyQuote] = useState(false)
  const [renderedKey, setRenderedKey] = useState('')
  const error = problem === 'read-failed' ? COPY.readFailed : problem && DOCUMENT_PREVIEW_ERRORS[problem]
  const quoteCallback = useRef(onQuote),
    quoteRequest = useRef<{ id: string; version: string; source: 'selection' | 'page' } | undefined>(undefined)
  quoteCallback.current = onQuote
  const sheetViews = useRef<Record<number, SheetView>>({})
  const view = useRef({ pageIndex: 0, fit: true, zoomPercent: 100 })
  const identity = `${file.root}\n${file.path}\n${file.attachmentId ?? ''}`
  const loadKey = `${identity}\n${versionKey}\n${changes}`
  const liveKey = useRef(loadKey),
    displayedKey = useRef(loadedKey)
  liveKey.current = loadKey
  displayedKey.current = loadedKey
  const shown = useRef<{ data?: ArrayBuffer; key: string }>({ key: '' })
  shown.current = { data, key: loadedKey }
  const prior = useRef<{ data: ArrayBuffer; key: string } | undefined>(undefined)
  const rendered = useRef(renderedKey)
  rendered.current = renderedKey
  const channel = useRef<((command: FrameCommand) => void) | undefined>(undefined),
    pending = useRef(new Map<string, Pending>())
  useEffect(() => {
    const controller = new AbortController()
    quoteRequest.current = undefined
    setProblem(undefined)
    void read(undefined, undefined, controller.signal).then(
      value => {
        if (!controller.signal.aborted) {
          if (shown.current.data && shown.current.key !== loadKey) prior.current = { data: shown.current.data, key: shown.current.key }
          setRenderedKey('')
          setLoadedKey(loadKey)
          setData(value)
        }
      },
      () => {
        if (!controller.signal.aborted) setProblem('read-failed')
      },
    )
    return () => {
      controller.abort()
      for (const request of pending.current.values()) {
        clearTimeout(request.timer)
        request.reject()
      }
      pending.current.clear()
    }
  }, [read, loadKey])
  const load = useCallback(
    (start: number, count: number, signal?: AbortSignal) =>
      new Promise<GridCell[][]>((resolve, reject) => {
        if (!channel.current || signal?.aborted) {
          reject(new Error('not-ready'))
          return
        }
        const key = `${selected}:${start}`
        const existing = pending.current.get(key)
        if (existing) {
          reject(new Error('duplicate-page'))
          return
        }
        const finish = () => {
          const value = pending.current.get(key)
          if (value) {
            clearTimeout(value.timer)
            pending.current.delete(key)
            value.reject()
          }
        }
        const timer = setTimeout(finish, 15_000)
        pending.current.set(key, {
          resolve: rows => {
            signal?.removeEventListener('abort', finish)
            resolve(rows)
          },
          reject: () => {
            signal?.removeEventListener('abort', finish)
            reject(new Error('page-unavailable'))
          },
          timer,
        })
        signal?.addEventListener('abort', finish, { once: true })
        channel.current({ type: 'sheet-page', sheet: selected, start, count })
      }),
    [selected],
  )
  const message = useCallback((value: unknown, origin: FrameOrigin) => {
    if (!origin || origin.versionKey !== displayedKey.current || origin.data !== shown.current.data) return
    if (!isFrameEvent(value)) return
    if (value.type === 'error') {
      setProblem(value.code === 'zip-refused' || value.code === 'document-too-complex' ? value.code : 'fallback')
      const previous = prior.current
      prior.current = undefined
      if (previous && previous.key !== displayedKey.current) {
        setRenderedKey('')
        setData(previous.data)
        setLoadedKey(previous.key)
      } else if (rendered.current !== displayedKey.current) setData(undefined)
    }
    if (value.type === 'rendered') {
      prior.current = undefined
      setRenderedKey(displayedKey.current)
      if (value.sheets) {
        setSheets(value.sheets)
        setSelected(previous =>
          value.sheets?.some(sheet => !sheet.hidden && sheet.id === previous)
            ? previous
            : (value.sheets?.find(sheet => !sheet.hidden)?.id ?? 0),
        )
      }
      setTruncated(value.truncated === true)
    }
    if (value.type === 'quote' && quoteRequest.current?.id === value.id && quoteRequest.current.version === liveKey.current) {
      const asked = quoteRequest.current.source
      quoteRequest.current = undefined
      // With nothing selected, the same button quotes the page in view.
      if (!value.text.trim() && asked === 'selection') quoteFrame.current('page')
      else if (value.text.trim()) {
        setEmptyQuote(false)
        quoteCallback.current?.({ text: value.text, ...(value.page === undefined ? {} : { page: value.page }) })
      } else setEmptyQuote(true)
    }
    if (value.type === 'page') {
      setPage({ index: value.index, count: value.count })
      view.current.pageIndex = value.index
    }
    if (value.type === 'view') {
      view.current.fit = value.fit
      view.current.zoomPercent = value.zoomPercent
      setFit(value.fit)
    }
    if (value.type === 'link') openDocumentLink(value.href)
    if (value.type === 'sheet-page') {
      const key = `${value.sheet}:${value.start}`,
        request = pending.current.get(key)
      if (request) {
        clearTimeout(request.timer)
        pending.current.delete(key)
        request.resolve(value.rows)
      }
      if (value.truncated) {
        setTruncated(true)
      }
    }
  }, [])
  const onChannel = useCallback((send: ((command: FrameCommand) => void) | undefined) => {
    channel.current = send
  }, [])
  const requestQuote = (source: 'selection' | 'page') => {
    if (loadedKey !== loadKey || renderedKey !== loadedKey || !channel.current || !onQuote) return
    const id = crypto.randomUUID().replaceAll('-', '')
    setEmptyQuote(false)
    quoteRequest.current = { id, version: loadKey, source }
    channel.current({ type: 'quote', id, source })
  }
  const quoteFrame = useRef(requestQuote)
  quoteFrame.current = requestQuote
  const paged = page.count > 0
  useViewerMenu([
    ...(file.kind === 'docx'
      ? [
          {
            id: 'changes',
            label: COPY.trackedChanges,
            checked: changes,
            onSelect: () => {
              setChanges(!changes)
            },
          },
        ]
      : []),
    ...(paged
      ? [
          {
            id: 'fit',
            label: COPY.fitWidth,
            checked: fit,
            onSelect: () => {
              view.current.fit = !fit
              if (!fit) view.current.zoomPercent = 100
              setFit(!fit)
              channel.current?.({ type: 'fit', value: !fit })
            },
          },
        ]
      : []),
  ])
  useViewerQuote(onQuote && file.kind !== 'xlsx' ? loadedKey === loadKey && renderedKey === loadedKey : undefined, () => {
    requestQuote('selection')
  })
  if (!data) return error ? <InlineNotice tone="error">{error}</InlineNotice> : <p role="status">{COPY.reading}</p>
  const sheet = sheets.find(item => item.id === selected)
  return (
    <div
      className="document-preview"
      onKeyDown={event => {
        if (
          !(event.metaKey || event.ctrlKey)
          || !['+', '=', '-', '0'].includes(event.key)
          || (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable=true]'))
        )
          return
        event.preventDefault()
        event.stopPropagation()
        channel.current?.(
          event.key === '0'
            ? { type: 'fit', value: true }
            : { type: 'zoom', percent: Math.min(400, Math.max(10, view.current.zoomPercent + (event.key === '-' ? -10 : 10))) },
        )
      }}>
      {paged && (
        <span className="document-page-count" data-kind={file.kind} role="status">
          {COPY.pageCount(page.index + 1, page.count)}
        </span>
      )}
      {loadedKey !== loadKey && !error && (
        <span className="document-preview-caption" role="status">
          {COPY.updating}
        </span>
      )}
      {error && (
        <InlineNotice tone="warn">
          {error}
          {COPY.retained}
        </InlineNotice>
      )}
      {emptyQuote && (
        <span className="document-preview-caption" role="status">
          {COPY.noQuote}
        </span>
      )}
      {truncated && <InlineNotice>{COPY.truncated}</InlineNotice>}
      <div className={file.kind === 'xlsx' ? 'document-parser-frame' : 'document-frame'}>
        {renderFrame({
          kind: file.kind as 'pptx' | 'docx' | 'xlsx',
          data,
          versionKey: loadedKey,
          options: { ...view.current, showChanges: changes, theme: documentTheme() },
          onMessage: message,
          onChannel,
        })}
      </div>
      {file.kind === 'xlsx' && (
        <>
          {sheet && renderedKey === loadedKey && (
            <SheetGrid
              key={`${loadedKey}:${selected}`}
              sheet={sheet}
              label={sheetLabel(sheet)}
              load={load}
              view={sheetViews.current[selected]}
              onView={view => {
                sheetViews.current[selected] = view
              }}
              onQuote={loadedKey === loadKey ? onQuote : undefined}
            />
          )}
          <div className="sheet-tabs" role="tablist" aria-label={COPY.sheets}>
            {sheets
              .filter(item => !item.hidden)
              .map(item => (
                <button type="button" role="tab" key={item.id} aria-selected={item.id === selected} onClick={() => setSelected(item.id)}>
                  {sheetLabel(item)}
                </button>
              ))}
          </div>
        </>
      )}
    </div>
  )
}
const DELIMITERS = ['', ',', '\t', ';', '|'] as const
function CsvPreview({ read, versionKey, onQuote }: DocumentPreviewProps) {
  const [info, setInfo] = useState<SheetInfo>(),
    [error, setError] = useState<'invalidTable' | 'fileUnavailable'>(),
    [truncated, setTruncated] = useState(false),
    [replacement, setReplacement] = useState(false),
    [delimiter, setDelimiter] = useState(''),
    [source, setSource] = useState(false),
    [text, setText] = useState('')
  const [loadedVersion, setLoadedVersion] = useState('')
  const gridVersion = versionKey + ':' + delimiter
  const sheetView = useRef<SheetView | undefined>(undefined)
  const worker = useRef<Worker | undefined>(undefined),
    pending = useRef(new Map<number, Pending>())
  const rejectPending = () => {
    for (const value of pending.current.values()) {
      clearTimeout(value.timer)
      value.reject()
    }
    pending.current.clear()
  }
  useEffect(
    () => () => {
      worker.current?.terminate()
      worker.current = undefined
      rejectPending()
    },
    [],
  )
  useEffect(() => {
    const controller = new AbortController(),
      instance = new Worker(trustedScriptUrl(csvWorkerUrl), { type: 'module' })
    setError(undefined)
    instance.onmessage = event => {
      if (controller.signal.aborted && instance !== worker.current) return
      const value = event.data as Record<string, unknown>
      if (value?.type === 'rendered' && Array.isArray(value.sheets) && value.sheets.length === 1) {
        const metadata = { type: 'rendered', kind: 'xlsx', sheets: value.sheets, truncated: value.truncated }
        if (isFrameEvent(metadata) && metadata.type === 'rendered') {
          rejectPending()
          if (worker.current !== instance) worker.current?.terminate()
          worker.current = instance
          setLoadedVersion(gridVersion)
          setInfo(metadata.sheets?.[0])
          setTruncated(value.truncated === true)
          setReplacement(value.replacement === true)
        }
      } else if (isFrameEvent(value) && value.type === 'sheet-page') {
        if (worker.current !== instance) return
        const request = pending.current.get(value.start)
        if (request) {
          clearTimeout(request.timer)
          pending.current.delete(value.start)
          request.resolve(value.rows)
        }
        if (value.truncated) {
          setTruncated(true)
          setInfo(previous => (previous ? { ...previous, rows: Math.min(previous.rows, value.start + value.rows.length) } : previous))
        }
      } else if (value?.type === 'error') setError('invalidTable')
    }
    instance.onerror = () => {
      if (!controller.signal.aborted || worker.current === instance) setError('invalidTable')
    }
    void read(undefined, undefined, controller.signal).then(
      bytes => {
        if (controller.signal.aborted) return
        const prefix = new Uint8Array(bytes)
        const encoding = prefix[0] === 255 && prefix[1] === 254 ? 'utf-16le' : prefix[0] === 254 && prefix[1] === 255 ? 'utf-16be' : 'utf-8'
        setText(new TextDecoder(encoding).decode(bytes).slice(0, 2_000_000))
        instance.postMessage({ type: 'init', data: bytes, ...(delimiter ? { delimiter } : {}) }, [bytes])
      },
      () => {
        if (!controller.signal.aborted) setError('fileUnavailable')
      },
    )
    return () => {
      controller.abort()
      if (worker.current !== instance) instance.terminate()
    }
  }, [read, versionKey, delimiter])
  const load = useCallback(
    (start: number, count: number, signal?: AbortSignal) =>
      new Promise<GridCell[][]>((resolve, reject) => {
        if (!worker.current || signal?.aborted) {
          reject(new Error('not-ready'))
          return
        }
        if (pending.current.has(start)) {
          reject(new Error('duplicate-page'))
          return
        }
        const cancel = () => {
          const value = pending.current.get(start)
          if (value) {
            pending.current.delete(start)
            clearTimeout(value.timer)
            value.reject()
          }
        }
        const timer = setTimeout(cancel, 10_000)
        pending.current.set(start, {
          resolve: rows => {
            signal?.removeEventListener('abort', cancel)
            resolve(rows)
          },
          reject: () => {
            signal?.removeEventListener('abort', cancel)
            reject(new Error('cancelled'))
          },
          timer,
        })
        signal?.addEventListener('abort', cancel, { once: true })
        worker.current.postMessage({ type: 'sheet-page', sheet: 0, start, count })
      }),
    [],
  )
  useViewerSource(source, () => {
    setSource(!source)
  })
  useViewerMenu(
    DELIMITERS.map((value, index) => ({
      id: `delimiter-${index}`,
      label: COPY.delimiter(COPY.delimiters[value]),
      checked: delimiter === value,
      onSelect: () => {
        setDelimiter(value)
      },
    })),
  )
  return (
    <div className="document-preview">
      {truncated && <InlineNotice>{COPY.tableTruncated}</InlineNotice>}
      {replacement && <InlineNotice>{COPY.replaced}</InlineNotice>}
      {error && (
        <InlineNotice tone={info ? 'warn' : 'error'}>
          {COPY[error]}
          {info ? COPY.retained : ''}
        </InlineNotice>
      )}
      {loadedVersion !== gridVersion && info && !error && (
        <span role="status" className="document-preview-caption">
          {COPY.tableUpdating}
        </span>
      )}
      {source ? (
        <pre className="document-source">{text}</pre>
      ) : info ? (
        <SheetGrid
          key={loadedVersion}
          sheet={info}
          label={COPY.table}
          load={load}
          view={sheetView.current}
          onView={value => {
            sheetView.current = value
          }}
          onQuote={loadedVersion === gridVersion ? onQuote : undefined}
        />
      ) : (
        <p role="status">{COPY.tableReading}</p>
      )}
    </div>
  )
}
export function DocumentPreview(props: DocumentPreviewProps) {
  const identity = `${props.file.root}\n${props.file.path}\n${props.file.attachmentId ?? ''}`
  if (props.file.secret || !props.file.actions.preview) return <InlineNotice>{COPY.notSupported}</InlineNotice>
  if (props.file.kind === 'pdf') return <PdfPreview key={identity} {...props} />
  if (props.file.kind === 'csv') return <CsvPreview key={identity} {...props} />
  if (['pptx', 'docx', 'xlsx'].includes(props.file.kind) && props.file.size <= 50 * 1024 * 1024)
    return <OfficePreview key={identity} {...props} />
  return <InlineNotice>{COPY.unavailable}</InlineNotice>
}
