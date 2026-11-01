import { readPageShape, settleStaticPage, showSlide, type PageShape } from './html-canvas.ts'
import { isFrameCommand } from './types.ts'

/** This entry is bundled only into the opaque HTML frame, never imported by the application. */
const nonce = new URLSearchParams(location.hash.slice(1)).get('nonce')
const scriptMode = location.pathname.endsWith('/html-script.html')
let port: MessagePort | undefined
let blocked = 0
const violations = new Set<string>()
const removedOrigins = new Set<string>()
const removeResource = (reference: string) => {
  blocked++
  try {
    removedOrigins.add(new URL(reference, location.href).origin)
  } catch {
    /* Still a removed declaration. */
  }
}
const send = (value: unknown) => port?.postMessage(value)
let shape: PageShape = { slides: [] }
let scriptsLeftOut = false
let externalLeftOut = false
let settled = false
/** The slide in view of a static deck this frame pages through itself. */
let pageIndex: number | undefined
const report = () =>
  send({
    type: 'html',
    blocked: Math.min(blocked, 100_000),
    ...(shape.canvas ? { canvas: shape.canvas } : {}),
    ...(scriptsLeftOut ? { scripts: true } : {}),
    // Pages that merely lose an external file stay quiet; a deck loses what makes it work, and nothing here would say so.
    ...(externalLeftOut && (shape.canvas || shape.slides.length >= 2) ? { external: true } : {}),
    ...(settled ? { settled: true } : {}),
    ...(pageIndex === undefined ? {} : { pages: { index: pageIndex, count: Math.min(shape.slides.length, 9999) } }),
  })
for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebSocket', 'EventSource']) Reflect.deleteProperty(globalThis, name)
document.addEventListener('securitypolicyviolation', event => {
  if (!event.blockedURI || ['inline', 'eval'].includes(event.blockedURI)) return
  // Cross-origin CSP reports may contain only an origin. Do not count a removed declaration a second time.
  try {
    if (removedOrigins.has(new URL(event.blockedURI, location.href).origin)) return
  } catch {
    /* Unknown blocked resource. */
  }
  const key = `${event.effectiveDirective}:${event.blockedURI}`
  if (violations.size >= 100_000 || violations.has(key)) return
  violations.add(key)
  blocked++
  report()
})
document.addEventListener(
  'click',
  event => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null
    if (!anchor) return
    event.preventDefault()
    if (!event.isTrusted) return
    const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? ''
    if (href.startsWith('#')) {
      try {
        document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView()
      } catch {
        /* Invalid fragment. */
      }
    } else if (/^https?:\/\//u.test(href) && href.length <= 4096) send({ type: 'link', href })
  },
  true,
)
for (const name of ['submit', 'drop', 'dragover']) document.addEventListener(name, event => event.preventDefault(), true)

const PAGE_KEYS = new Map([
  ['ArrowRight', 1],
  ['ArrowDown', 1],
  ['PageDown', 1],
  [' ', 1],
  ['ArrowLeft', -1],
  ['ArrowUp', -1],
  ['PageUp', -1],
])
function goToPage(index: number) {
  if (pageIndex === undefined) return
  const next = Math.max(0, Math.min(Math.min(shape.slides.length, 9999) - 1, index))
  if (next === pageIndex) return
  pageIndex = next
  showSlide(shape.slides, next)
  report()
}
document.addEventListener('keydown', event => {
  if (pageIndex === undefined || event.metaKey || event.ctrlKey || event.altKey) return
  const step = PAGE_KEYS.get(event.key)
  if (step === undefined) return
  event.preventDefault()
  goToPage(pageIndex + step)
})
let touch: { x: number; y: number } | undefined
document.addEventListener(
  'touchstart',
  event => {
    const point = event.touches[0]
    touch = point && event.touches.length === 1 ? { x: point.clientX, y: point.clientY } : undefined
  },
  { passive: true },
)
document.addEventListener(
  'touchend',
  event => {
    const end = event.changedTouches[0]
    // In frame pixels, which a scaled frame shrinks: a fraction of the width is the same swipe at every scale.
    if (
      pageIndex !== undefined
      && touch
      && end
      && Math.abs(end.clientX - touch.x) > innerWidth * 0.08
      && Math.abs(end.clientY - touch.y) < innerHeight * 0.1
    )
      goToPage(pageIndex + (end.clientX < touch.x ? 1 : -1))
    touch = undefined
  },
  { passive: true },
)

const EXECUTABLE_SCRIPT = /^(?:|module|(?:text|application)\/(?:x-)?(?:java|ecma)script)$/iu
const runs = (script: Element) => EXECUTABLE_SCRIPT.test((script.getAttribute('type') ?? '').trim())

async function render(data: ArrayBuffer, fit: boolean, wantedPage: number) {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(data)
  // Parsing and document DOM are confined to this opaque origin. No HTML sink exists in the parent.
  const parsed = new DOMParser().parseFromString(source, 'text/html')
  const elements = parsed.querySelectorAll('*')
  if (elements.length > 50_000) throw new Error('too-many-nodes')
  const scripts: HTMLScriptElement[] = []
  for (const element of elements) {
    const tag = element.localName.toLowerCase()
    if (['base', 'meta', 'iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'fencedframe', 'link'].includes(tag)) {
      if (tag !== 'base' && tag !== 'meta') {
        const resource = element.getAttribute('src') ?? element.getAttribute('href') ?? element.getAttribute('data')
        if (resource) removeResource(resource)
        if (resource && tag === 'link' && /(?:^|\s)stylesheet(?:\s|$)/iu.test(element.getAttribute('rel') ?? '')) externalLeftOut = true
      }
      element.remove()
      continue
    }
    if (tag === 'script') {
      if (element.hasAttribute('src')) {
        removeResource(element.getAttribute('src')!)
        externalLeftOut = true
        element.remove()
        continue
      }
      if (scriptMode && element instanceof HTMLScriptElement) scripts.push(element)
      if (!scriptMode) {
        if (runs(element)) scriptsLeftOut = true
        element.remove()
      }
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if ((!scriptMode && name.startsWith('on')) || ['srcdoc', 'ping', 'action', 'formaction', 'autofocus'].includes(name)) {
        element.removeAttribute(attribute.name)
        continue
      }
      if (['src', 'srcset', 'poster', 'background', 'data', 'href', 'xlink:href'].includes(name) && tag !== 'a') {
        if (name !== 'srcset' && /^(?:data:|blob:)/iu.test(attribute.value)) continue
        removeResource(attribute.value)
        element.removeAttribute(attribute.name)
      }
    }
  }
  // Page rules and handlers commonly hang off these two elements, and the loop above has already filtered their attributes.
  for (const [from, to] of [
    [parsed.documentElement, document.documentElement],
    [parsed.body, document.body],
  ] as const)
    for (const attribute of from.attributes) to.setAttributeNode(attribute.cloneNode() as Attr)
  // DOMParser scripts remain inert when moved. Recreate only inline scripts after static content is installed.
  const head = [...parsed.head.childNodes],
    body = [...parsed.body.childNodes]
  document.head.replaceChildren(...head)
  document.body.replaceChildren(...body)
  shape = readPageShape()
  report()
  // A page's start-up and its one-time measurements must see the viewport it will keep.
  if (shape.canvas && fit) await viewportOf(shape.canvas.width, shape.canvas.height)
  if (scriptMode) {
    await runScripts(scripts)
    try {
      if (!shape.canvas) shape = readPageShape()
    } catch {
      /* A running page may have removed what the reading needs, and it is still running. */
    }
  } else pageIndex = settleStaticPage(shape, wantedPage)
  settled = true
  report()
}
function viewportOf(width: number, height: number) {
  return new Promise<void>(done => {
    const check = () => {
      if (innerWidth !== width || innerHeight !== height) return
      window.removeEventListener('resize', check)
      done()
    }
    window.addEventListener('resize', check)
    setTimeout(() => {
      window.removeEventListener('resize', check)
      done()
    }, 400)
    check()
  })
}
/**
 * This document finished loading before the page arrived, so a page's own start-up never fires by itself. Replay it once
 * the inline scripts ran, modules included: they execute later than the classic ones they sit beside. `readyState` follows
 * along, or a page that checks it as well as listening would start twice.
 */
async function runScripts(scripts: HTMLScriptElement[]) {
  let readyState: DocumentReadyState = 'loading'
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => readyState })
  const advance = (state: DocumentReadyState) => {
    readyState = state
    document.dispatchEvent(new Event('readystatechange'))
  }
  const modules: Array<Promise<unknown>> = []
  for (const original of scripts) {
    if (!original.isConnected || !runs(original)) continue
    const script = document.createElement('script')
    if (original.type.trim().toLowerCase() === 'module') {
      script.type = 'module'
      modules.push(
        new Promise(done => {
          script.addEventListener('load', done, { once: true })
          script.addEventListener('error', done, { once: true })
          setTimeout(done, 1000)
        }),
      )
    }
    script.textContent = original.textContent
    original.replaceWith(script)
  }
  await Promise.all(modules)
  advance('interactive')
  document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }))
  advance('complete')
  window.dispatchEvent(new Event('load'))
  Reflect.deleteProperty(document, 'readyState')
}
const initialize = (event: MessageEvent<unknown>) => {
  const value = event.data
  if (event.source !== parent || port || !value || typeof value !== 'object' || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (
    input.type !== 'init'
    || input.protocol !== 1
    || input.nonce !== nonce
    || input.kind !== (scriptMode ? 'html-script' : 'html')
    || !(input.data instanceof ArrayBuffer)
    || input.data.byteLength > 5 * 1024 * 1024
    || event.ports.length !== 1
  )
    return
  window.removeEventListener('message', initialize)
  port = event.ports[0]
  port!.onmessage = message => {
    if (isFrameCommand(message.data) && message.data.type === 'page') goToPage(message.data.index)
  }
  port!.start()
  send({ type: 'initialized' })
  const options = input.options as { fit?: unknown; pageIndex?: unknown } | undefined
  const wantedPage = Number.isInteger(options?.pageIndex) ? Number(options?.pageIndex) : 0
  render(input.data, options?.fit !== false, wantedPage).catch(() => send({ type: 'error', code: 'render-failed' }))
}
if (nonce && /^[A-Za-z0-9_-]{20,128}$/u.test(nonce)) {
  window.addEventListener('message', initialize)
  parent.postMessage({ type: 'ready', protocol: 1, nonce }, '*')
}
window.addEventListener('pagehide', () => port?.close())
