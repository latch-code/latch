import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from '@aiden0z/pptx-renderer'
import { renderAsync } from 'docx-preview'
import { isFrameCommand, type FrameEvent, type FrameCommand, type OfficeKind } from './types.ts'
import { parseXml, resolvePart, sanitizeOfficeZip, xmlText, ZIP_LIMITS } from './zip.ts'
import { parseXlsx, sheetPage, type ParsedSheet } from './xlsx.ts'
import { boundedQuoteText } from './quote.ts'
const root = document.getElementById('document')!
let port: MessagePort | undefined,
  viewer: PptxViewer | undefined,
  sheets: ParsedSheet[] | undefined,
  observer: IntersectionObserver | undefined,
  pages: HTMLElement[] = [],
  current = 0,
  zoom = 100,
  fit = true
let links: Record<string, string> = {}
let viewRevision = 0,
  changingView = false,
  viewWork: Promise<void> = Promise.resolve()
function resizeViewer(action: (target: PptxViewer) => Promise<void>, index = current) {
  const target = viewer,
    revision = ++viewRevision
  if (!target) return
  changingView = true
  current = Math.min(index, target.slideCount - 1)
  viewWork = viewWork
    .catch(() => {})
    .then(async () => {
      if (target !== viewer || revision !== viewRevision) return
      await action(target)
      if (target !== viewer || revision !== viewRevision) return
      await target.goToSlide(Math.min(index, target.slideCount - 1))
      if (target !== viewer || revision !== viewRevision) return
      page(index, target.slideCount)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (revision === viewRevision) changingView = false
        }),
      )
    })
    .catch(() => {
      if (revision === viewRevision) {
        changingView = false
        send({ type: 'error', code: 'render-failed' })
      }
    })
}
const nonce = new URLSearchParams(location.hash.slice(1)).get('nonce') ?? location.hash.slice(1)
const send = (value: FrameEvent) => port?.postMessage(value)
const page = (index: number, count: number) => {
  if (count > 0) {
    current = Math.max(0, Math.min(count - 1, index))
    send({ type: 'page', index: current, count })
  }
}
for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebSocket', 'EventSource']) {
  try {
    Reflect.deleteProperty(window, name)
  } catch {
    /* CSP is the boundary. */
  }
}
document.addEventListener(
  'click',
  event => {
    const link = event.target instanceof Element ? event.target.closest('a') : null
    if (!link) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!event.isTrusted) return
    const raw = link.getAttribute('href') ?? ''
    const href = raw.startsWith('#') ? (links[raw.slice(1)] ?? '') : raw
    if (/^https?:\/\//iu.test(href) && href.length <= 4096) send({ type: 'link', href })
  },
  true,
)
for (const type of ['submit', 'drop', 'dragover']) document.addEventListener(type, event => event.preventDefault(), true)
function command(value: unknown) {
  if (!isFrameCommand(value)) return
  if (value.type === 'quote') {
    const selected = window.getSelection()
    const selection =
      selected?.anchorNode && selected.focusNode && root.contains(selected.anchorNode) && root.contains(selected.focusNode)
        ? selected.toString()
        : ''
    const element = viewer ? root.querySelector<HTMLElement>('[data-slide-index="' + current + '"]') : pages[current]
    const text = boundedQuoteText(value.source === 'selection' ? selection : element?.innerText || element?.textContent || '')
    const anchor = selected?.anchorNode instanceof Element ? selected.anchorNode : selected?.anchorNode?.parentElement
    const selectedPage = viewer
      ? Number(anchor?.closest<HTMLElement>('[data-slide-index]')?.dataset.slideIndex ?? -1)
      : pages.findIndex(page => !!anchor && page.contains(anchor))
    send({
      type: 'quote',
      id: value.id,
      text,
      page:
        value.source === 'selection' && Number.isInteger(selectedPage) && selectedPage >= 0 && selectedPage <= 9999
          ? selectedPage
          : current,
    })
    return
  }
  if (value.type === 'sheet-page') {
    const sheet = sheets?.[value.sheet]
    if (sheet) send({ type: 'sheet-page', sheet: value.sheet, start: value.start, ...sheetPage(sheet, value.start, value.count) })
    return
  }
  if (value.type === 'zoom') {
    zoom = value.percent
    fit = false
    if (viewer)
      resizeViewer(async target => {
        await target.setFitMode('none')
        await target.setZoom(value.percent)
      })
    else {
      root.dataset.fit = 'false'
      root.style.zoom = String(zoom / 100)
    }
    send({ type: 'view', fit, zoomPercent: zoom })
    return
  }
  if (value.type === 'fit') {
    fit = value.value
    if (fit) zoom = 100
    if (viewer)
      resizeViewer(async target => {
        await target.setZoom(zoom)
        await target.setFitMode(value.value ? 'contain' : 'none')
      })
    else {
      root.dataset.fit = String(value.value)
      root.style.zoom = value.value ? '' : String(zoom / 100)
    }
    send({ type: 'view', fit, zoomPercent: zoom })
    return
  }
  if (viewer) resizeViewer(async () => {}, Math.min(value.index, viewer.slideCount - 1))
  else if (pages[value.index]) {
    pages[value.index]!.scrollIntoView({ block: 'start' })
    page(value.index, pages.length)
  }
}
function notes(files: Record<string, Uint8Array>, slidePath: string): string {
  const relPath = slidePath.replace(/\/([^/]+)$/u, '/_rels/$1.rels'),
    rel = files[relPath]
  if (!rel) return ''
  const doc = parseXml(xmlText(rel)),
    relationship = Array.from(doc.getElementsByTagNameNS('*', 'Relationship')).find(item =>
      item.getAttribute('Type')?.endsWith('/notesSlide'),
    )
  const path = relationship && resolvePart(slidePath, relationship.getAttribute('Target') ?? ''),
    bytes = path && files[path]
  if (!bytes) return ''
  return Array.from(parseXml(xmlText(bytes)).getElementsByTagNameNS('*', 't'))
    .map(item => item.textContent ?? '')
    .join('\n')
    .slice(0, 20_000)
}
async function render(kind: OfficeKind, data: ArrayBuffer, options: Record<string, unknown>) {
  if (data.byteLength > ZIP_LIMITS.input) {
    send({ type: 'error', code: 'file-too-large' })
    return
  }
  document.documentElement.dataset.theme = options.theme === 'dark' ? 'dark' : 'light'
  const sanitized = sanitizeOfficeZip(data)
  links = sanitized.links
  fit = options.fit !== false
  zoom =
    Number.isInteger(options.zoomPercent) && Number(options.zoomPercent) >= 10 && Number(options.zoomPercent) <= 400
      ? Number(options.zoomPercent)
      : 100
  const initialPage = Number.isInteger(options.pageIndex) ? Math.max(0, Math.min(9999, Number(options.pageIndex))) : 0
  if (kind === 'xlsx') {
    const workbook = parseXlsx(sanitized.files)
    sheets = workbook.sheets
    send({ type: 'rendered', kind, sheets: sheets.map(sheet => sheet.info), truncated: workbook.truncated })
    return
  }
  if (kind === 'docx') {
    await renderAsync(sanitized.data, root, undefined, {
      renderAltChunks: false,
      renderComments: false,
      renderChanges: options.showChanges === true,
      useBase64URL: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      ignoreWidth: false,
      ignoreHeight: false,
    })
    pages = Array.from(root.querySelectorAll<HTMLElement>('section.docx')).slice(0, 10_000)
    observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) if (entry.isIntersecting) page(pages.indexOf(entry.target as HTMLElement), pages.length)
      },
      { threshold: 0.25 },
    )
    for (const element of pages) observer.observe(element)
    send({ type: 'rendered', kind })
    command({ type: 'fit', value: fit })
    command({ type: 'page', index: Math.min(initialPage, pages.length - 1) })
    return
  }
  const noteTexts = new Map(
    Object.keys(sanitized.files)
      .filter(path => /^ppt\/slides\/slide\d+\.xml$/u.test(path))
      .map(path => [path, notes(sanitized.files, path)]),
  )
  viewer = new PptxViewer(root, {
    fitMode: fit ? 'contain' : 'none',
    zoomPercent: zoom,
    externalMedia: 'block',
    zipLimits: RECOMMENDED_ZIP_LIMITS,
    lazyMedia: true,
    lazySlides: true,
    pdfjs: false,
    onSlideChange: index => {
      if (!changingView) page(index, viewer?.presentationData?.slides.length ?? 0)
    },
    onSlideUnmounted: index => {
      root.querySelector(`[data-slide-index="${index}"] [data-latch-notes]`)?.remove()
    },
    onSlideRendered: (index, element) => {
      const path = viewer?.presentationData?.slides[index]?.slidePath
      const text = path && noteTexts.get(path)
      if (!text) return
      const wrapper = element.closest<HTMLElement>('[data-slide-index]')
      if (!wrapper || wrapper.querySelector('[data-latch-notes]')) return
      const details = document.createElement('details'),
        summary = document.createElement('summary'),
        body = document.createElement('p')
      details.dataset.latchNotes = ''
      summary.textContent = '备注'
      body.textContent = text
      details.append(summary, body)
      wrapper.append(details)
    },
  })
  await viewer.open(sanitized.data, {
    renderMode: 'list',
    listOptions: { windowed: true, initialSlides: 4, batchSize: 4, overscanViewport: 1.5 },
  })
  send({ type: 'rendered', kind })
  await viewer.goToSlide(Math.min(initialPage, Math.max(0, viewer.slideCount - 1)))
  page(initialPage, viewer.presentationData?.slides.length ?? 0)
}
let accepted = false
function init(event: MessageEvent<unknown>) {
  const value = event.data
  if (accepted || event.source !== parent || !value || typeof value !== 'object' || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some(key => !['type', 'protocol', 'nonce', 'kind', 'data', 'options'].includes(key))
    || input.type !== 'init'
    || input.protocol !== 1
    || input.nonce !== nonce
    || !['pptx', 'docx', 'xlsx'].includes(String(input.kind))
    || !(input.data instanceof ArrayBuffer)
    || event.ports.length !== 1
  )
    return
  accepted = true
  window.removeEventListener('message', init)
  port = event.ports[0]
  port!.onmessage = message => command(message.data)
  port!.start()
  send({ type: 'initialized' })
  const options =
    input.options && typeof input.options === 'object' && !Array.isArray(input.options) ? (input.options as Record<string, unknown>) : {}
  void render(input.kind as OfficeKind, input.data, options).catch(error => {
    const code =
      error instanceof Error && (error.message === 'zip-refused' || error.message === 'document-too-complex')
        ? error.message
        : 'render-failed'
    send({ type: 'error', code })
  })
}
if (/^[A-Za-z0-9_-]{20,128}$/u.test(nonce)) {
  window.addEventListener('message', init)
  parent.postMessage({ type: 'ready', protocol: 1, nonce }, '*')
}
window.addEventListener('pagehide', () => {
  observer?.disconnect()
  viewer?.destroy()
  port?.close()
})
let touch: { x: number; y: number } | undefined
document.addEventListener(
  'touchstart',
  event => {
    const point = event.touches[0]
    if (point && event.touches.length === 1) touch = { x: point.clientX, y: point.clientY }
    else touch = undefined
  },
  { passive: true },
)
document.addEventListener(
  'touchend',
  event => {
    const end = event.changedTouches[0]
    if (touch && end && Math.abs(end.clientX - touch.x) > 60 && Math.abs(end.clientY - touch.y) < 40)
      command({ type: 'page', index: Math.max(0, current + (end.clientX < touch.x ? 1 : -1)) } satisfies FrameCommand)
    touch = undefined
  },
  { passive: true },
)
document.addEventListener('keydown', event => {
  if (event.target instanceof Element && event.target.closest('input,textarea,select,button,summary')) return
  if ((event.metaKey || event.ctrlKey) && ['+', '=', '-', '0'].includes(event.key)) {
    event.preventDefault()
    if (event.key === '0') command({ type: 'fit', value: true })
    else command({ type: 'zoom', percent: Math.min(400, Math.max(10, zoom + (event.key === '-' ? -10 : 10))) })
    return
  }
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault()
    command({ type: 'page', index: Math.max(0, current + (event.key === 'ArrowRight' ? 1 : -1)) })
  }
})

document.addEventListener(
  'wheel',
  event => {
    if (!event.ctrlKey) return
    event.preventDefault()
    command({ type: 'zoom', percent: Math.min(400, Math.max(10, Math.round(zoom + (event.deltaY < 0 ? 10 : -10)))) })
  },
  { passive: false },
)

let pinch: { distance: number; zoom: number } | undefined
const distance = (touches: TouchList) => Math.hypot(touches[0]!.clientX - touches[1]!.clientX, touches[0]!.clientY - touches[1]!.clientY)
document.addEventListener(
  'touchstart',
  event => {
    pinch = event.touches.length === 2 ? { distance: distance(event.touches), zoom } : undefined
  },
  { passive: true },
)
document.addEventListener(
  'touchmove',
  event => {
    if (!pinch || event.touches.length !== 2 || pinch.distance <= 0) return
    event.preventDefault()
    command({ type: 'zoom', percent: Math.min(400, Math.max(10, Math.round((pinch.zoom * distance(event.touches)) / pinch.distance))) })
  },
  { passive: false },
)
document.addEventListener(
  'touchend',
  event => {
    if (event.touches.length < 2) pinch = undefined
  },
  { passive: true },
)
