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
const report = () => send({ type: 'html', blocked: Math.min(blocked, 100_000) })
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

function render(data: ArrayBuffer) {
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
      }
      element.remove()
      continue
    }
    if (tag === 'script') {
      if (element.hasAttribute('src')) {
        removeResource(element.getAttribute('src')!)
        element.remove()
        continue
      }
      if (scriptMode && element instanceof HTMLScriptElement) scripts.push(element)
      if (!scriptMode) element.remove()
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
  // DOMParser scripts remain inert when moved. Recreate only inline scripts after static content is installed.
  const head = [...parsed.head.childNodes],
    body = [...parsed.body.childNodes]
  document.head.replaceChildren(...head)
  document.body.replaceChildren(...body)
  if (scriptMode)
    for (const original of scripts) {
      if (!original.isConnected) continue
      const script = document.createElement('script')
      if (original.type === 'module') script.type = 'module'
      else if (original.type && !['text/javascript', 'application/javascript'].includes(original.type)) continue
      script.textContent = original.textContent
      original.replaceWith(script)
    }
  report()
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
  port!.start()
  send({ type: 'initialized' })
  try {
    render(input.data)
  } catch {
    send({ type: 'error', code: 'render-failed' })
  }
}
if (nonce && /^[A-Za-z0-9_-]{20,128}$/u.test(nonce)) {
  window.addEventListener('message', initialize)
  parent.postMessage({ type: 'ready', protocol: 1, nonce }, '*')
}
window.addEventListener('pagehide', () => port?.close())
