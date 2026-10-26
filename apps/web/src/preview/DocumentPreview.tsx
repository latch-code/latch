import csvWorkerUrl from './csv.worker.ts?worker&url'
import { trustedScriptUrl } from './runtime.ts'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Button, IconButton, InlineNotice } from '@latch/ui'
import { isFrameEvent, type DocumentPreviewProps, type FrameCommand, type GridCell, type SheetInfo } from './types.ts'
import { SheetGrid } from './SheetGrid.tsx'
import { openDocumentLink } from './openLink.ts'
const PdfPreview = lazy(() => import('./PdfPreview.tsx'))
type Pending = { resolve: (rows: GridCell[][]) => void; reject: () => void; timer: ReturnType<typeof setTimeout> }
function OfficePreview({ file, versionKey, read, renderFrame }: DocumentPreviewProps) {
  const [data, setData] = useState<ArrayBuffer>(),
    [loadedKey, setLoadedKey] = useState(''),
    [error, setError] = useState(''),
    [sheets, setSheets] = useState<SheetInfo[]>([]),
    [selected, setSelected] = useState(0),
    [page, setPage] = useState({ index: 0, count: 0 }),
    [fit, setFit] = useState(true),
    [truncated, setTruncated] = useState(false),
    [changes, setChanges] = useState(false)
  const view = useRef({ pageIndex: 0, fit: true, zoomPercent: 100 })
  const identity = `${file.root}\n${file.path}\n${file.attachmentId ?? ''}`
  const loadKey = `${identity}\n${versionKey}\n${changes}`
  const channel = useRef<((command: FrameCommand) => void) | undefined>(undefined),
    pending = useRef(new Map<string, Pending>())
  useEffect(() => {
    const controller = new AbortController()
    setData(undefined)
    setError('')
    void read(undefined, undefined, controller.signal).then(
      value => {
        if (!controller.signal.aborted) {
          setLoadedKey(loadKey)
          setData(value)
        }
      },
      () => {
        if (!controller.signal.aborted) setError('文件暂时无法读取，请重新打开后重试。')
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
  const message = useCallback((value: unknown) => {
    if (!isFrameEvent(value)) return
    if (value.type === 'error')
      setError(value.code === 'zip-refused' ? '文档压缩结构超出安全上限，无法在此预览。' : '无法显示这个文档，请下载或在执行端电脑上打开。')
    if (value.type === 'rendered') {
      if (value.sheets) {
        setSheets(value.sheets)
        setSelected(value.sheets.find(sheet => !sheet.hidden)?.id ?? 0)
      }
      setTruncated(value.truncated === true)
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
        setSheets(previous =>
          previous.map(sheet =>
            sheet.id === value.sheet ? { ...sheet, rows: Math.min(sheet.rows, value.start + value.rows.length) } : sheet,
          ),
        )
      }
    }
  }, [])
  const onChannel = useCallback((send: ((command: FrameCommand) => void) | undefined) => {
    channel.current = send
  }, [])
  if (error) return <InlineNotice tone="error">{error}</InlineNotice>
  if (!data || loadedKey !== loadKey) return <p role="status">正在读取文档…</p>
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
      <div className="document-preview-controls document-paged-controls">
        {page.count > 0 && (
          <>
            <IconButton
              label="上一页"
              icon={ArrowLeft}
              disabled={page.index === 0}
              onClick={() => channel.current?.({ type: 'page', index: page.index - 1 })}
            />
            <span role="status">
              {page.index + 1} / {page.count} 页
            </span>
            <IconButton
              label="下一页"
              icon={ArrowRight}
              disabled={page.index + 1 === page.count}
              onClick={() => channel.current?.({ type: 'page', index: page.index + 1 })}
            />
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={fit}
              onClick={() => {
                view.current.fit = !fit
                if (!fit) view.current.zoomPercent = 100
                setFit(!fit)
                channel.current?.({ type: 'fit', value: !fit })
              }}>
              适应
            </Button>
          </>
        )}
        {file.kind === 'docx' && (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={changes}
            onClick={() => {
              setChanges(!changes)
            }}>
            显示修订（实验）
          </Button>
        )}
      </div>
      <span className="document-preview-caption">只读预览，排版可能与原应用不同。</span>
      {truncated && <InlineNotice>文件较大，部分行、列或单元格内容未显示。</InlineNotice>}
      <div className={file.kind === 'xlsx' ? 'document-parser-frame' : 'document-frame'}>
        {renderFrame({
          kind: file.kind as 'pptx' | 'docx' | 'xlsx',
          data,
          versionKey: `${versionKey}:${changes}`,
          options: { ...view.current, showChanges: changes, theme: document.documentElement.dataset.theme ?? 'light' },
          onMessage: message,
          onChannel,
        })}
      </div>
      {file.kind === 'xlsx' && (
        <>
          {sheet && <SheetGrid key={`${versionKey}:${selected}`} sheet={sheet} load={load} />}
          <div className="sheet-tabs" role="tablist" aria-label="工作表">
            {sheets
              .filter(item => !item.hidden)
              .map(item => (
                <button type="button" role="tab" key={item.id} aria-selected={item.id === selected} onClick={() => setSelected(item.id)}>
                  {item.name}
                </button>
              ))}
          </div>
          {sheets.some(item => item.hidden) && <span className="document-preview-caption">隐藏的工作表未显示。</span>}
        </>
      )}
    </div>
  )
}
function CsvPreview({ read, versionKey }: DocumentPreviewProps) {
  const [info, setInfo] = useState<SheetInfo>(),
    [error, setError] = useState(''),
    [truncated, setTruncated] = useState(false),
    [replacement, setReplacement] = useState(false),
    [delimiter, setDelimiter] = useState(''),
    [source, setSource] = useState(false),
    [text, setText] = useState('')
  const worker = useRef<Worker | undefined>(undefined),
    pending = useRef(new Map<number, Pending>())
  useEffect(() => {
    const controller = new AbortController(),
      instance = new Worker(trustedScriptUrl(csvWorkerUrl), { type: 'module' })
    worker.current = instance
    setInfo(undefined)
    setError('')
    instance.onmessage = event => {
      if (controller.signal.aborted) return
      const value = event.data as Record<string, unknown>
      if (value?.type === 'rendered' && Array.isArray(value.sheets) && value.sheets.length === 1) {
        const metadata = { type: 'rendered', kind: 'xlsx', sheets: value.sheets, truncated: value.truncated }
        if (isFrameEvent(metadata) && metadata.type === 'rendered') {
          setInfo(metadata.sheets?.[0])
          setTruncated(value.truncated === true)
          setReplacement(value.replacement === true)
        }
      } else if (isFrameEvent(value) && value.type === 'sheet-page') {
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
      } else if (value?.type === 'error') setError('无法显示这个表格。')
    }
    instance.onerror = () => setError('无法显示这个表格。')
    void read(undefined, undefined, controller.signal).then(
      bytes => {
        if (controller.signal.aborted) return
        const prefix = new Uint8Array(bytes)
        const encoding = prefix[0] === 255 && prefix[1] === 254 ? 'utf-16le' : prefix[0] === 254 && prefix[1] === 255 ? 'utf-16be' : 'utf-8'
        setText(new TextDecoder(encoding).decode(bytes).slice(0, 2_000_000))
        instance.postMessage({ type: 'init', data: bytes, ...(delimiter ? { delimiter } : {}) }, [bytes])
      },
      () => {
        if (!controller.signal.aborted) setError('文件暂时无法读取。')
      },
    )
    return () => {
      controller.abort()
      instance.terminate()
      worker.current = undefined
      for (const value of pending.current.values()) {
        clearTimeout(value.timer)
        value.reject()
      }
      pending.current.clear()
    }
  }, [read, versionKey, delimiter])
  const load = useCallback(
    (start: number, count: number, signal?: AbortSignal) =>
      new Promise<GridCell[][]>((resolve, reject) => {
        if (!worker.current || signal?.aborted) {
          reject(new Error('not-ready'))
          return
        }
        const timer = setTimeout(() => {
          pending.current.delete(start)
          reject(new Error('timeout'))
        }, 10_000)
        pending.current.set(start, { resolve, reject: () => reject(new Error('cancelled')), timer })
        worker.current.postMessage({ type: 'sheet-page', sheet: 0, start, count })
      }),
    [],
  )
  return (
    <div className="document-preview">
      <div className="document-preview-controls">
        <Button size="sm" variant="ghost" aria-pressed={!source} onClick={() => setSource(false)}>
          预览
        </Button>
        <Button size="sm" variant="ghost" aria-pressed={source} onClick={() => setSource(true)}>
          源码
        </Button>
        <label>
          分隔符
          <select value={delimiter} onChange={event => setDelimiter(event.target.value)}>
            <option value="">自动识别</option>
            <option value=",">逗号</option>
            <option value={'\t'}>Tab</option>
            <option value=";">分号</option>
            <option value="|">竖线</option>
          </select>
        </label>
      </div>
      {truncated && <InlineNotice>表格较大，部分行、列或文字未显示。</InlineNotice>}
      {replacement && <InlineNotice>部分字符无法识别，已用替代字符显示。</InlineNotice>}
      {error ? (
        <InlineNotice tone="error">{error}</InlineNotice>
      ) : source ? (
        <pre className="document-source">{text}</pre>
      ) : info ? (
        <SheetGrid key={`${versionKey}:${delimiter}`} sheet={info} load={load} />
      ) : (
        <p role="status">正在读取表格…</p>
      )}
    </div>
  )
}
export function DocumentPreview(props: DocumentPreviewProps) {
  const identity = `${props.file.root}\n${props.file.path}\n${props.file.attachmentId ?? ''}`
  if (props.file.secret || !props.file.actions.preview) return <InlineNotice>这个文件不能在应用内预览。</InlineNotice>
  if (props.file.kind === 'pdf')
    return (
      <Suspense fallback={<p role="status">正在加载 PDF…</p>}>
        <PdfPreview key={identity} {...props} />
      </Suspense>
    )
  if (props.file.kind === 'csv') return <CsvPreview key={identity} {...props} />
  if (['pptx', 'docx', 'xlsx'].includes(props.file.kind) && props.file.size <= 50 * 1024 * 1024)
    return <OfficePreview key={identity} {...props} />
  return <InlineNotice>暂时无法预览这个文件。</InlineNotice>
}
