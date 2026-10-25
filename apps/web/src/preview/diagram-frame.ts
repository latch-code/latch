import mermaid from 'mermaid'
import { isSafeDiagramSvg, validDiagramSource } from './diagram-svg.ts'
const nonce = new URLSearchParams(location.hash.slice(1)).get('nonce')
let port: MessagePort | undefined
const send = (data: unknown) => port?.postMessage(data)
for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebSocket', 'EventSource']) Reflect.deleteProperty(globalThis, name)
for (const name of ['click', 'submit', 'drop', 'dragover']) document.addEventListener(name, event => event.preventDefault(), true)
const initialize = (event: MessageEvent) => {
  const input = event.data as Record<string, unknown>
  if (
    event.source !== parent
    || port
    || input?.nonce !== nonce
    || input.type !== 'init'
    || input.protocol !== 1
    || input.kind !== 'mermaid'
    || !(input.data instanceof ArrayBuffer)
    || input.data.byteLength > 50_000
    || event.ports.length !== 1
  )
    return
  window.removeEventListener('message', initialize)
  port = event.ports[0]
  port!.start()
  send({ type: 'initialized' })
  const source = new TextDecoder('utf-8', { fatal: true }).decode(input.data)
  if (!validDiagramSource(source)) {
    send({ type: 'error', code: 'invalid-file' })
    return
  }
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    theme: 'neutral',
    look: 'classic',
    fontFamily: 'system-ui,sans-serif',
    maxTextSize: 50_000,
    maxEdges: 500,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
  })
  void mermaid
    .render('latch-diagram', source, document.getElementById('diagram')!)
    .then(result => {
      const parsed = new DOMParser().parseFromString(result.svg, 'image/svg+xml')
      for (const filter of parsed.querySelectorAll('filter')) filter.remove()
      for (const element of parsed.querySelectorAll('*'))
        for (const attr of [...element.attributes]) if (attr.name.startsWith('data-')) element.removeAttribute(attr.name)
      for (const style of parsed.querySelectorAll('style'))
        style.textContent = (style.textContent ?? '').replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\}[^{}]*)*\}/gu, '')
      const svg = new XMLSerializer().serializeToString(parsed.documentElement)
      if (isSafeDiagramSvg(svg)) send({ type: 'diagram', svg })
      else send({ type: 'error', code: 'render-failed' })
    })
    .catch(() => send({ type: 'error', code: 'render-failed' }))
}
if (nonce && /^[A-Za-z0-9_-]{20,128}$/u.test(nonce)) {
  window.addEventListener('message', initialize)
  parent.postMessage({ type: 'ready', protocol: 1, nonce }, '*')
}
window.addEventListener('pagehide', () => port?.close())
