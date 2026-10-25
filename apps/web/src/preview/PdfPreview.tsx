import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Button, IconButton, InlineNotice, SearchField, TextField } from '@latch/ui'
import { getDocument, PDFDataRangeTransport, PDFWorker, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&url'
import { trustedScriptUrl } from './runtime.ts'
import type { DocumentPreviewProps } from './types.ts'
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
  query,
}: {
  document: PDFDocumentProxy
  index: number
  width: number
  fit: boolean
  query: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null),
    [height, setHeight] = useState(1000),
    [error, setError] = useState('')
  useEffect(() => {
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
          scale = Math.min(
            fit ? Math.max(100, width - 24) / intrinsic.width : 1.3,
            Math.sqrt(16_000_000 / (intrinsic.width * intrinsic.height)) / ratio,
          ),
          viewport = loaded.getViewport({ scale })
        if (!canvas.current || !text.current) return
        setHeight(viewport.height)
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
  }, [pdf, index, width, fit, query])
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
export default function PdfPreview({ file, read }: DocumentPreviewProps) {
  const [document, setDocument] = useState<PDFDocumentProxy>(),
    [error, setError] = useState(''),
    [password, setPassword] = useState(''),
    [passwordRequest, setPasswordRequest] = useState<(text: string) => void>(),
    [fit, setFit] = useState(true),
    [width, setWidth] = useState(480),
    [query, setQuery] = useState(''),
    [matches, setMatches] = useState<number[]>([]),
    [finding, setFinding] = useState(false),
    [matchIndex, setMatchIndex] = useState(0),
    [outline, setOutline] = useState<Array<{ title: string; page: number }>>([])
  const scroll = useRef<HTMLDivElement>(null),
    virtual = useVirtualizer({
      count: document?.numPages ?? 0,
      getScrollElement: () => scroll.current,
      estimateSize: () => 1000,
      overscan: 1,
    })
  useEffect(() => {
    const controller = new AbortController(),
      nativeWorker = new Worker(trustedScriptUrl(pdfWorkerUrl), { type: 'module' }),
      worker = PDFWorker.create({ port: nativeWorker })
    let loading: ReturnType<typeof getDocument> | undefined
    class Ranges extends PDFDataRangeTransport {
      requestDataRange(start: number, end: number) {
        void read(start, end - 1, controller.signal).then(
          data => {
            if (!controller.signal.aborted) this.onDataRange(start, new Uint8Array(data))
          },
          () => {
            if (!controller.signal.aborted) setError('部分 PDF 数据暂时无法读取。')
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
        loading.onPassword = (update: (text: string) => void) => setPasswordRequest(() => update)
        return loading.promise
      })
      .then(async pdf => {
        if (!pdf || controller.signal.aborted) return
        if (pdf.numPages > 10_000) throw new Error('too-many-pages')
        setDocument(pdf)
        setPasswordRequest(undefined)
        const tree = await pdf.getOutline()
        const links: Array<{ title: string; page: number }> = []
        const visit = async (items: typeof tree, depth = 0) => {
          if (!items || depth > 10) return
          for (const item of items.slice(0, 500)) {
            if (links.length >= 500) break
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
        if (!controller.signal.aborted) setError('无法显示这个 PDF，请下载或在执行端电脑上打开。')
      })
    return () => {
      controller.abort()
      void loading?.destroy().catch(() => {})
      worker.destroy()
      nativeWorker.terminate()
    }
  }, [read, file.size])
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
  if (error) return <InlineNotice tone="error">{error}</InlineNotice>
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
  const index = virtual.getVirtualItems()[0]?.index ?? 0
  return (
    <div className="document-preview">
      <div className="document-preview-controls">
        <IconButton
          label="上一页"
          icon={ArrowLeft}
          disabled={index === 0}
          onClick={() => virtual.scrollToIndex(index - 1, { align: 'start' })}
        />
        <span role="status">
          {index + 1} / {document.numPages} 页
        </span>
        <IconButton
          label="下一页"
          icon={ArrowRight}
          disabled={index + 1 === document.numPages}
          onClick={() => virtual.scrollToIndex(index + 1, { align: 'start' })}
        />
        <Button size="sm" variant="ghost" aria-pressed={fit} onClick={() => setFit(!fit)}>
          适应
        </Button>
        <SearchField label="查找 PDF 文字" value={query} onValueChange={setQuery} />
        {query && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!matches.length}
            onClick={() => {
              const next = (matchIndex + 1) % matches.length
              setMatchIndex(next)
              virtual.scrollToIndex(matches[next]!, { align: 'start' })
            }}>
            {finding ? '正在查找…' : `${matches.length ? matchIndex + 1 : 0}/${matches.length} 匹配页`}
          </Button>
        )}
      </div>
      {outline.length > 0 && (
        <details className="pdf-outline">
          <summary>目录</summary>
          {outline.map((item, i) => (
            <button type="button" key={i} onClick={() => virtual.scrollToIndex(item.page, { align: 'start' })}>
              {item.title}
            </button>
          ))}
        </details>
      )}
      <div className="pdf-scroll" ref={scroll}>
        <div className="pdf-pages" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map(item => (
            <div
              className="pdf-page-slot"
              key={item.key}
              ref={virtual.measureElement}
              data-index={item.index}
              style={{ transform: `translateY(${item.start}px)` }}>
              <PdfPage document={document} index={item.index} width={width} fit={fit} query={query} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
