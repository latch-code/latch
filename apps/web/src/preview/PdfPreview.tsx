import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Button, IconButton, InlineNotice, SearchField, TextField } from '@latch/ui'
import { getDocument, PDFDataRangeTransport, PDFWorker, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&url'
import { trustedScriptUrl } from './runtime.ts'
import type { DocumentPreviewProps } from './types.ts'
import { boundedQuoteText, selectedQuote } from './quote.ts'
import { useViewerQuote } from './viewerActions.tsx'
import { PDF_CSS_SCALE, pdfPageAt, pdfPercent, pdfScale, pdfZoomKey } from './pdfZoom.ts'
class SafeBinaryData {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const directory =
      kind === 'cMapUrl' && /^[A-Za-z0-9_-]{1,100}\.bcmap$/u.test(filename)
        ? 'cmaps'
        : kind === 'standardFontDataUrl' && /^[A-Za-z0-9_-]{1,100}\.(?:pfb|ttf)$/u.test(filename)
          ? 'fonts'
          : undefined
    if (!directory) throw new Error('resource-refused')
    const response = await fetch(`/link/preview-assets/pdf/${directory}/${filename}`, { credentials: 'same-origin', cache: 'force-cache' })
    if (!response.ok) throw new Error('resource-unavailable')
    return new Uint8Array(await response.arrayBuffer())
  }
}
function PdfPage({
  document: pdf,
  index,
  width,
  fit,
  percent,
  query,
  onRendered,
  onDimensions,
}: {
  document: PDFDocumentProxy
  index: number
  width: number
  fit: boolean
  percent: number
  query: string
  onRendered(index: number, view: string): void
  onDimensions(width: number, height: number): void
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null),
    [height, setHeight] = useState(1000),
    [error, setError] = useState('')
  const callbacks = useRef({ onRendered, onDimensions })
  callbacks.current = { onRendered, onDimensions }
  useEffect(() => {
    setError('')
    let disposed = false,
      page: PDFPageProxy | undefined,
      render: ReturnType<PDFPageProxy['render']> | undefined,
      layer: TextLayer | undefined
    void pdf
      .getPage(index + 1)
      .then(async loaded => {
        if (disposed) return
        page = loaded
        const intrinsic = loaded.getViewport({ scale: 1 }),
          ratio = Math.min(devicePixelRatio || 1, 2),
          scale = pdfScale(intrinsic.width, intrinsic.height, width, { fit, percent }, ratio),
          viewport = loaded.getViewport({ scale })
        if (!canvas.current || !text.current) return
        if (index === 0) callbacks.current.onDimensions(intrinsic.width, intrinsic.height)
        setHeight(viewport.height)
        canvas.current.dataset.pdfScale = String(scale)
        canvas.current.width = Math.ceil(viewport.width * ratio)
        canvas.current.height = Math.ceil(viewport.height * ratio)
        canvas.current.style.width = `${viewport.width}px`
        canvas.current.style.height = `${viewport.height}px`
        text.current.style.width = `${viewport.width}px`
        text.current.style.height = `${viewport.height}px`
        render = loaded.render({
          canvas: canvas.current,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
          annotationMode: 0,
        })
        await render.promise
        if (disposed) return
        // PDF selection spans use document-space line boxes rather than UI text metrics.
        text.current.style.lineHeight = '1'
        const content = await loaded.getTextContent()
        if (disposed || !text.current) return
        layer = new TextLayer({ textContentSource: content, container: text.current, viewport })
        await layer.render()
        if (disposed) return
        if (query && 'highlights' in CSS && typeof Highlight !== 'undefined') {
          const walker = document.createTreeWalker(text.current, NodeFilter.SHOW_TEXT),
            ranges: Range[] = []
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const value = node.textContent ?? '',
              at = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
            if (at >= 0) {
              const range = document.createRange()
              range.setStart(node, at)
              range.setEnd(node, Math.min(value.length, at + query.length))
              ranges.push(range)
            }
          }
          CSS.highlights.set(`latch-pdf-${index}`, new Highlight(...ranges))
        }
        const annotations = await loaded.getAnnotations({ intent: 'display' })
        if (disposed || !text.current) return
        for (const annotation of annotations) {
          const href = typeof annotation.url === 'string' ? annotation.url : undefined
          if (
            !href
            || href.length > 4096
            || !/^https?:\/\//iu.test(href)
            || !Array.isArray(annotation.rect)
            || annotation.rect.length !== 4
            || !annotation.rect.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))
          )
            continue
          const rectangle = [
              ...viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]),
              ...viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]),
            ],
            link = document.createElement('a')
          link.href = href
          link.target = '_blank'
          link.rel = 'noopener noreferrer'
          link.setAttribute('aria-label', href)
          link.className = 'pdf-link'
          Object.assign(link.style, {
            left: `${Math.min(rectangle[0], rectangle[2])}px`,
            top: `${Math.min(rectangle[1], rectangle[3])}px`,
            width: `${Math.abs(rectangle[2] - rectangle[0])}px`,
            height: `${Math.abs(rectangle[3] - rectangle[1])}px`,
          })
          text.current.append(link)
        }
        if (!disposed) callbacks.current.onRendered(index, `${fit}:${percent}:${width}`)
      })
      .catch(() => {
        if (!disposed) setError('这一页无法显示。')
      })
    return () => {
      disposed = true
      render?.cancel()
      layer?.cancel()
      page?.cleanup()
      text.current?.replaceChildren()
      if (canvas.current) {
        canvas.current.width = 0
        canvas.current.height = 0
      }
      if ('highlights' in CSS) CSS.highlights.delete(`latch-pdf-${index}`)
    }
  }, [pdf, index, width, fit, percent, query])
  return (
    <div className="pdf-page" style={{ height }} aria-label={`第 ${index + 1} 页`}>
      {error ? (
        <InlineNotice tone="error">{error}</InlineNotice>
      ) : (
        <>
          <canvas ref={canvas} />
          <div ref={text} className="pdf-text-layer" />
        </>
      )}
    </div>
  )
}
interface PdfResource {
  released?: boolean
  controller: AbortController
  worker: PDFWorker
  nativeWorker: Worker
  loading?: ReturnType<typeof getDocument>
}
function releasePdf(value: PdfResource) {
  if (value.released) return
  value.released = true
  value.controller.abort()
  void value.loading?.destroy().catch(() => {})
  value.worker.destroy()
  value.nativeWorker.terminate()
}
export default function PdfPreview({ file, read, versionKey, onQuote }: DocumentPreviewProps) {
  const [document, setDocument] = useState<PDFDocumentProxy>(),
    [error, setError] = useState(''),
    [password, setPassword] = useState(''),
    [passwordRequest, setPasswordRequest] = useState<(text: string) => void>(),
    [fit, setFit] = useState(true),
    [percent, setPercent] = useState(100),
    [width, setWidth] = useState(480),
    [query, setQuery] = useState(''),
    [matches, setMatches] = useState<number[]>([]),
    [finding, setFinding] = useState(false),
    [matchIndex, setMatchIndex] = useState(0),
    [outline, setOutline] = useState<Array<{ title: string; page: number }>>([])
  const [loadedVersion, setLoadedVersion] = useState(''),
    [quoteHint, setQuoteHint] = useState('')
  const resource = useRef<PdfResource | undefined>(undefined),
    generation = useRef(0)
  const reading = useRef({ page: 0, offset: 0 })
  const [dimensions, setDimensions] = useState({ width: 612, height: 792 })
  const zoomState = useRef({ fit, percent })
  zoomState.current = { fit, percent }
  const currentWidth = useRef(width)
  currentWidth.current = width
  const zoomAnchor = useRef<{ page: number; x: number; y: number; pointX: number; pointY: number } | undefined>(undefined)
  const scroll = useRef<HTMLDivElement>(null),
    virtual = useVirtualizer({
      count: document?.numPages ?? 0,
      getScrollElement: () => scroll.current,
      estimateSize: () =>
        dimensions.height * pdfScale(dimensions.width, dimensions.height, width, { fit, percent }, devicePixelRatio || 1) + 16,
      overscan: 1,
    })
  const currentPercent = () => {
    if (!zoomState.current.fit) return zoomState.current.percent
    const node = scroll.current
    const canvas = Array.from(node?.querySelectorAll<HTMLCanvasElement>('.pdf-page canvas') ?? []).find(canvas => {
      const rect = canvas.getBoundingClientRect(),
        bounds = node!.getBoundingClientRect()
      return rect.bottom > bounds.top && rect.top < bounds.bottom
    })
    const scale = Number(canvas?.dataset.pdfScale)
    return pdfPercent(Number.isFinite(scale) && scale > 0 ? (scale / PDF_CSS_SCALE) * 100 : percent)
  }
  const changeZoom = (next: number | 'fit', pointX?: number, pointY?: number) => {
    const node = scroll.current
    if (!node) return
    const value = next === 'fit' ? { fit: true, percent: zoomState.current.percent } : { fit: false, percent: pdfPercent(next) }
    if (value.fit === zoomState.current.fit && value.percent === zoomState.current.percent) return
    const bounds = node.getBoundingClientRect(),
      x = pointX ?? node.clientWidth / 2,
      y = pointY ?? node.clientHeight / 2
    const slots = Array.from(node.querySelectorAll<HTMLElement>('.pdf-page-slot'))
    const slot =
      slots.find(slot => {
        const rect = slot.getBoundingClientRect()
        return rect.top <= bounds.top + y && rect.bottom > bounds.top + y
      }) ?? slots.find(slot => slot.getBoundingClientRect().bottom > bounds.top)
    const page = slot?.querySelector('.pdf-page'),
      rect = page?.getBoundingClientRect()
    if (slot && rect?.width && rect.height)
      zoomAnchor.current = {
        page: Number(slot.dataset.index),
        x: Math.max(0, Math.min(1, (bounds.left + x - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (bounds.top + y - rect.top) / rect.height)),
        pointX: x,
        pointY: y,
      }
    zoomState.current = value
    setFit(value.fit)
    setPercent(value.percent)
  }
  const zoom = useRef({ changeZoom, currentPercent })
  zoom.current = { changeZoom, currentPercent }
  const restoreZoomAnchor = (index: number, view: string) => {
    if (view !== `${zoomState.current.fit}:${zoomState.current.percent}:${currentWidth.current}`) return
    const anchor = zoomAnchor.current
    if (!anchor || anchor.page !== index) return
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (zoomAnchor.current !== anchor) return
        const node = scroll.current,
          page = node?.querySelector<HTMLElement>(`[data-index="${index}"] .pdf-page`)
        if (!node || !page) return
        const bounds = node.getBoundingClientRect(),
          rect = page.getBoundingClientRect()
        node.scrollTop += rect.top - bounds.top + anchor.y * rect.height - anchor.pointY
        node.scrollLeft += rect.left - bounds.left + anchor.x * rect.width - anchor.pointX
        zoomAnchor.current = undefined
      }),
    )
  }
  const goToPage = (index: number) => {
    // An explicit reading action supersedes a zoom render that may still finish on the previous page.
    zoomAnchor.current = undefined
    virtual.scrollToIndex(index, { align: 'start' })
  }
  useLayoutEffect(() => {
    virtual.measure()
    if (zoomAnchor.current) virtual.scrollToIndex(zoomAnchor.current.page, { align: 'start' })
  }, [fit, percent, width, dimensions, virtual])
  useEffect(() => {
    const node = scroll.current
    if (!node) return
    let pinch: { distance: number; percent: number } | undefined
    const distance = (touches: TouchList) =>
      Math.hypot(touches[0]!.clientX - touches[1]!.clientX, touches[0]!.clientY - touches[1]!.clientY)
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const bounds = node.getBoundingClientRect()
      zoom.current.changeZoom(
        zoom.current.currentPercent() * Math.exp(-event.deltaY / 400),
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      )
    }
    const start = (event: TouchEvent) => {
      pinch = event.touches.length === 2 ? { distance: distance(event.touches), percent: zoom.current.currentPercent() } : undefined
    }
    const move = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2 || pinch.distance <= 0) return
      event.preventDefault()
      const bounds = node.getBoundingClientRect()
      zoom.current.changeZoom(
        (pinch.percent * distance(event.touches)) / pinch.distance,
        (event.touches[0]!.clientX + event.touches[1]!.clientX) / 2 - bounds.left,
        (event.touches[0]!.clientY + event.touches[1]!.clientY) / 2 - bounds.top,
      )
    }
    const end = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = undefined
    }
    node.addEventListener('wheel', wheel, { passive: false })
    node.addEventListener('touchstart', start, { passive: true })
    node.addEventListener('touchmove', move, { passive: false })
    node.addEventListener('touchend', end)
    node.addEventListener('touchcancel', end)
    return () => {
      node.removeEventListener('wheel', wheel)
      node.removeEventListener('touchstart', start)
      node.removeEventListener('touchmove', move)
      node.removeEventListener('touchend', end)
      node.removeEventListener('touchcancel', end)
    }
  }, [document])
  useEffect(
    () => () => {
      if (resource.current) releasePdf(resource.current)
      resource.current = undefined
    },
    [],
  )
  useLayoutEffect(() => {
    if (!document) return
    virtual.scrollToIndex(Math.min(reading.current.page, document.numPages - 1), { align: 'start' })
    if (scroll.current) scroll.current.scrollTop += reading.current.offset
  }, [document])
  useEffect(() => {
    const controller = new AbortController(),
      nativeWorker = new Worker(trustedScriptUrl(pdfWorkerUrl), { type: 'module' }),
      worker = PDFWorker.create({ port: nativeWorker })
    const entry: PdfResource = { controller, worker, nativeWorker },
      currentGeneration = ++generation.current
    setError('')
    let loading: ReturnType<typeof getDocument> | undefined
    class Ranges extends PDFDataRangeTransport {
      requestDataRange(start: number, end: number) {
        void read(start, end - 1, controller.signal).then(
          data => {
            if (!controller.signal.aborted) this.onDataRange(start, new Uint8Array(data))
          },
          () => {
            if (!controller.signal.aborted && currentGeneration === generation.current) setError('部分 PDF 数据暂时无法读取。')
            releasePdf(entry)
          },
        )
      }
      abort() {
        controller.abort()
      }
    }
    void read(0, Math.min(file.size - 1, 65535), controller.signal)
      .then(initial => {
        if (controller.signal.aborted) return
        const parameters = {
          range: new Ranges(file.size, new Uint8Array(initial), false),
          worker,
          rangeChunkSize: 1024 * 1024,
          disableAutoFetch: true,
          disableStream: true,
          isEvalSupported: false,
          enableXfa: false,
          maxImageSize: 64e6,
          useWasm: false,
          useWorkerFetch: false,
          BinaryDataFactory: SafeBinaryData,
          cMapPacked: true,
          verbosity: 0,
        }
        loading = getDocument(parameters)
        entry.loading = loading
        loading.onPassword = (update: (text: string) => void) => {
          if (currentGeneration === generation.current) setPasswordRequest(() => update)
        }
        return loading.promise
      })
      .then(async pdf => {
        if (!pdf || controller.signal.aborted) return
        if (pdf.numPages > 10_000) throw new Error('too-many-pages')
        if (resource.current && resource.current !== entry) releasePdf(resource.current)
        resource.current = entry
        setLoadedVersion(versionKey)
        setDocument(pdf)
        setError('')
        setPasswordRequest(undefined)
        const tree = await pdf.getOutline()
        const links: Array<{ title: string; page: number }> = []
        const visit = async (items: typeof tree, depth = 0) => {
          if (!items || depth > 10) return
          for (const item of items.slice(0, 500)) {
            if (controller.signal.aborted || links.length >= 500) break
            try {
              const destination = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest
              if (destination && destination.length) {
                const target = typeof destination[0] === 'number' ? destination[0] : await pdf.getPageIndex(destination[0])
                if (Number.isInteger(target) && target >= 0 && target < pdf.numPages)
                  links.push({ title: String(item.title).slice(0, 500), page: target })
              }
            } catch {
              /* A malformed bookmark does not block the PDF. */
            }
            await visit(item.items, depth + 1)
          }
        }
        await visit(tree)
        if (!controller.signal.aborted) setOutline(links)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('无法显示这个 PDF，请下载或在 Mac 上打开。')
        if (resource.current !== entry) releasePdf(entry)
      })
    return () => {
      if (resource.current !== entry) releasePdf(entry)
    }
  }, [read, file.size, versionKey])
  useEffect(() => {
    const element = scroll.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    setWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [document])
  useEffect(() => {
    if (!document || !query.trim()) {
      setMatches([])
      setFinding(false)
      return
    }
    let cancelled = false
    setFinding(true)
    setMatches([])
    const timer = setTimeout(() => {
      void (async () => {
        const found: number[] = []
        for (let index = 0; index < Math.min(document.numPages, 1000) && found.length < 100; index++) {
          const page = await document.getPage(index + 1),
            text = await page.getTextContent()
          if (cancelled) return
          if (text.items.some(item => 'str' in item && item.str.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) found.push(index)
        }
        if (!cancelled) {
          setMatches(found)
          setMatchIndex(0)
          setFinding(false)
          if (found[0] !== undefined) virtual.scrollToIndex(found[0], { align: 'start' })
        }
      })().catch(() => {
        if (!cancelled) setFinding(false)
      })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [document, query, virtual])
  const quoteNow = useRef<() => void>(() => {})
  useViewerQuote(onQuote ? !!document && loadedVersion === versionKey : undefined, () => {
    quoteNow.current()
  })
  if (error && !document) return <InlineNotice tone="error">{error}</InlineNotice>
  if (passwordRequest)
    return (
      <form
        className="document-password"
        onSubmit={event => {
          event.preventDefault()
          passwordRequest(password)
          setPassword('')
        }}>
        <TextField label="PDF 密码" type="password" value={password} onChange={event => setPassword(event.target.value)} />
        <Button type="submit">打开</Button>
      </form>
    )
  if (!document) return <p role="status">正在读取 PDF…</p>
  const index = pdfPageAt(virtual.getVirtualItems(), scroll.current?.scrollTop ?? 0)?.index ?? 0
  const quote = async (source: 'page' | 'selection') => {
    if (!onQuote || loadedVersion !== versionKey) return
    if (source === 'selection') {
      const value = selectedQuote(scroll.current)
      if (value) {
        setQuoteHint('')
        onQuote(value)
        return
      }
    }
    const active = document,
      activeGeneration = generation.current
    try {
      const page = await active.getPage(index + 1),
        content = await page.getTextContent()
      if (activeGeneration !== generation.current) return
      let excerpt = ''
      for (const item of content.items) {
        if ('str' in item) excerpt += item.str.slice(0, 2001 - excerpt.length) + (item.hasEOL ? '\n' : ' ')
        if (excerpt.length >= 2000) break
      }
      const text = boundedQuoteText(excerpt)
      if (text) {
        setQuoteHint('')
        onQuote({ text, page: index })
      } else setQuoteHint('这一页没有可引用的文字。')
    } catch {
      if (activeGeneration === generation.current) setQuoteHint('这一页暂时无法读取，请重试。')
    }
  }
  quoteNow.current = () => {
    void quote('selection')
  }
  return (
    <div
      className="document-preview"
      onKeyDown={event => {
        if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable=true]')) return
        const command = pdfZoomKey({ ...event, isComposing: event.nativeEvent.isComposing })
        if (!command) return
        event.preventDefault()
        event.stopPropagation()
        changeZoom(command === 'fit' ? 'fit' : currentPercent() + (command === 'in' ? 10 : -10))
      }}>
      <div className="document-preview-controls">
        <IconButton label="上一页" icon={ArrowLeft} disabled={index === 0} onClick={() => goToPage(index - 1)} />
        <span role="status">
          {index + 1} / {document.numPages} 页
        </span>
        <IconButton label="下一页" icon={ArrowRight} disabled={index + 1 === document.numPages} onClick={() => goToPage(index + 1)} />
        <Button size="sm" variant="ghost" aria-pressed={fit} onClick={() => changeZoom(fit ? 100 : 'fit')}>
          适应
        </Button>
        <span className="sr-only" role="status" aria-label="PDF 缩放比例">
          {fit ? '适应宽度' : `${percent}%`}
        </span>
        <SearchField label="查找 PDF 文字" value={query} onValueChange={setQuery} />
        {query && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!matches.length}
            onClick={() => {
              const next = (matchIndex + 1) % matches.length
              setMatchIndex(next)
              goToPage(matches[next]!)
            }}>
            {finding ? '正在查找…' : `${matches.length ? matchIndex + 1 : 0}/${matches.length} 匹配页`}
          </Button>
        )}
      </div>
      {outline.length > 0 && (
        <details className="pdf-outline">
          <summary>目录</summary>
          {outline.map((item, i) => (
            <button type="button" key={i} onClick={() => goToPage(item.page)}>
              {item.title}
            </button>
          ))}
        </details>
      )}
      {error && <InlineNotice tone="warn">{error} 之前读到的内容仍保留在这里。</InlineNotice>}
      {quoteHint && (
        <span className="document-preview-caption" role="status">
          {quoteHint}
        </span>
      )}
      {loadedVersion !== versionKey && !error && (
        <span className="document-preview-caption" role="status">
          正在更新 PDF…
        </span>
      )}
      <div
        className="pdf-scroll"
        ref={scroll}
        tabIndex={0}
        aria-label="PDF 页面"
        onScroll={() => {
          const top = scroll.current?.scrollTop ?? 0,
            first = pdfPageAt(virtual.getVirtualItems(), top)
          if (first) reading.current = { page: first.index, offset: Math.max(0, top - first.start) }
        }}>
        <div className="pdf-pages" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map(item => (
            <div
              className="pdf-page-slot"
              key={item.key}
              ref={virtual.measureElement}
              data-index={item.index}
              style={{ transform: `translateY(${item.start}px)` }}>
              <PdfPage
                document={document}
                index={item.index}
                width={width}
                fit={fit}
                percent={percent}
                query={query}
                onRendered={restoreZoomAnchor}
                onDimensions={(width, height) =>
                  setDimensions(previous => (previous.width === width && previous.height === height ? previous : { width, height }))
                }
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
