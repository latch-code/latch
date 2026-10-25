import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from '@aiden0z/pptx-renderer'
import { renderAsync } from 'docx-preview'
import { isFrameCommand, type FrameEvent, type FrameCommand, type OfficeKind } from './types.ts'
import { parseXml, resolvePart, sanitizeOfficeZip, xmlText, ZIP_LIMITS } from './zip.ts'
import { parseXlsx, sheetPage, type ParsedSheet } from './xlsx.ts'
const root = document.getElementById('document')!
let port: MessagePort | undefined,
  viewer: PptxViewer | undefined,
  sheets: ParsedSheet[] | undefined,
  pages: HTMLElement[] = [],
  current = 0
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
    const href = link.getAttribute('href') ?? ''
    if (/^https?:\/\//iu.test(href) && href.length <= 4096) send({ type: 'link', href })
  },
  true,
)
for (const type of ['submit', 'drop', 'dragover']) document.addEventListener(type, event => event.preventDefault(), true)
function command(value: unknown) {
  if (!isFrameCommand(value)) return
  if (value.type === 'sheet-page') {
    const sheet = sheets?.[value.sheet]
    if (sheet) send({ type: 'sheet-page', sheet: value.sheet, start: value.start, ...sheetPage(sheet, value.start, value.count) })
    return
  }
  if (value.type === 'fit') {
    if (viewer) void viewer.setFitMode(value.value ? 'contain' : 'none')
    else root.dataset.fit = String(value.value)
    return
  }
  if (viewer) void viewer.goToSlide(Math.min(value.index, viewer.slideCount - 1))
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
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) if (entry.isIntersecting) page(pages.indexOf(entry.target as HTMLElement), pages.length)
      },
      { threshold: 0.25 },
    )
    for (const element of pages) observer.observe(element)
    send({ type: 'rendered', kind })
    page(0, pages.length)
    return
  }
  const noteTexts = new Map(
    Object.keys(sanitized.files)
      .filter(path => /^ppt\/slides\/slide\d+\.xml$/u.test(path))
      .map(path => [path, notes(sanitized.files, path)]),
  )
  viewer = new PptxViewer(root, {
    fitMode: 'contain',
    zipLimits: RECOMMENDED_ZIP_LIMITS,
    lazyMedia: true,
    lazySlides: true,
    pdfjs: false,
    onSlideChange: index => page(index, viewer?.presentationData?.slides.length ?? 0),
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
  page(0, viewer.presentationData?.slides.length ?? 0)
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
    send({ type: 'error', code: error instanceof Error && error.message === 'zip-refused' ? 'zip-refused' : 'render-failed' })
  })
}
if (/^[A-Za-z0-9_-]{20,128}$/u.test(nonce)) {
  window.addEventListener('message', init)
  parent.postMessage({ type: 'ready', protocol: 1, nonce }, '*')
}
window.addEventListener('pagehide', () => {
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
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault()
    command({ type: 'page', index: Math.max(0, current + (event.key === 'ArrowRight' ? 1 : -1)) })
  }
})
