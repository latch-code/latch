import { useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { FileMetadata } from '@latch/protocol'
import { validMathDom } from '../src/preview/math.ts'
import { MessageContent } from '../src/MessageContent.tsx'
import { DocumentPreview } from '../src/preview/DocumentPreview.tsx'
import { DiffView, type DiffViewFile } from '../src/components/DiffView.tsx'
import { isFrameCommand, type FrameInput, type FrameCommand } from '../src/preview/types.ts'
import type { PreviewQuote } from '../src/preview/quote.ts'
import '../src/styles/index.css'
declare global {
  interface Window {
    startPreview: (kind: FileMetadata['kind'], bytes: number[]) => void
    previewRanges: Array<[number | undefined, number | undefined]>
    startRichPreview: (text: string, streaming?: boolean, files?: boolean) => void
    startFullDiff: (diff: DiffViewFile) => void
    validatePreviewMath: (node: Element) => boolean
    previewOpened: string[]
    previewImages: string[]
    previewEvents: unknown[]
    previewQuotes: PreviewQuote[]
    previewHoldPages: boolean
    previewDeferred: Array<() => void>
  }
}
function Sandbox(input: FrameInput) {
  const iframe = useRef<HTMLIFrameElement>(null),
    callbacks = useRef(input)
  callbacks.current = input
  const nonce = useRef(crypto.randomUUID()).current
  useLayoutEffect(() => {
    let channel: MessageChannel | undefined
    const listener = (event: MessageEvent) => {
      if (
        event.source !== iframe.current?.contentWindow
        || event.origin !== 'null'
        || event.data?.type !== 'ready'
        || event.data?.nonce !== nonce
        || channel
      )
        return
      channel = new MessageChannel()
      channel.port1.onmessage = message => {
        window.previewEvents.push(message.data)
        const deliver = () => callbacks.current.onMessage?.(message.data, { versionKey: input.versionKey, data: input.data })
        if (window.previewHoldPages && message.data?.type === 'page') window.previewDeferred.push(deliver)
        else deliver()
        if (message.data?.type === 'initialized')
          callbacks.current.onChannel?.((command: FrameCommand) => {
            if (isFrameCommand(command)) channel!.port1.postMessage(command)
          })
      }
      const data = input.data.slice(0)
      iframe.current.contentWindow!.postMessage({ type: 'init', protocol: 1, nonce, kind: input.kind, data, options: input.options }, '*', [
        channel.port2,
        data,
      ])
    }
    window.addEventListener('message', listener)
    return () => {
      window.removeEventListener('message', listener)
      channel?.port1.close()
      callbacks.current.onChannel?.(undefined)
    }
  }, [nonce, input.versionKey])
  return (
    <iframe
      ref={iframe}
      title="文档沙箱"
      sandbox="allow-scripts"
      src={`/preview-frame/${input.kind === 'mermaid' ? 'diagram' : 'office'}.html#nonce=${nonce}`}
    />
  )
}
function Harness() {
  const [rich, setRich] = useState<{ text: string; streaming: boolean; files: boolean }>()
  window.startRichPreview = (text, streaming = false, files = false) => {
    setValue(undefined)
    window.previewEvents = []
    window.previewOpened = []
    window.previewImages = []
    setRich({ text, streaming, files })
  }
  const [value, setValue] = useState<{
    file: FileMetadata
    versionKey: string
    read: (start?: number, end?: number, signal?: AbortSignal) => Promise<ArrayBuffer>
  }>()
  window.startPreview = (kind, values) => {
    setRich(undefined)
    const bytes = new Uint8Array(values)
    window.previewRanges = []
    window.previewOpened = []
    window.previewEvents = []
    window.previewQuotes = []
    setValue({
      file: {
        handle: 'test',
        name: `sample.${kind}`,
        root: 'primary',
        path: `sample.${kind}`,
        ext: kind,
        kind,
        mime: 'application/octet-stream',
        size: bytes.length,
        mtime: 0,
        etag: 'test',
        limit: 50 * 1024 * 1024,
        secret: false,
        actions: { reveal: false, quicklook: false, open: false, download: true, preview: true },
      },
      versionKey: crypto.randomUUID(),
      read: async (start, end, signal) => {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
        window.previewRanges.push([start, end])
        return bytes.slice(start ?? 0, end === undefined ? undefined : end + 1).buffer
      },
    })
  }
  return (
    <div style={{ height: 'calc(100dvh - 16px)', padding: 8 }}>
      {rich !== undefined && (
        <MessageContent
          text={rich.text}
          streaming={rich.streaming}
          path={rich.files ? 'docs/read.md' : undefined}
          onOpenFile={
            rich.files
              ? reference => {
                  window.previewOpened.push(reference)
                }
              : undefined
          }
          resolveImage={
            rich.files
              ? async (reference, signal) => {
                  window.previewImages.push(reference)
                  if (signal.aborted) throw new Error('aborted')
                  return {
                    url: URL.createObjectURL(
                      new Blob(
                        [
                          '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="gray"/></svg>',
                        ],
                        { type: 'image/svg+xml' },
                      ),
                    ),
                    width: 100,
                    height: 50,
                  }
                }
              : undefined
          }
          renderFrame={input => <Sandbox key={input.versionKey} {...input} />}
        />
      )}
      {value && (
        <DocumentPreview
          {...value}
          onQuote={quote => window.previewQuotes.push(quote)}
          renderFrame={input => <Sandbox key={input.versionKey} {...input} />}
        />
      )}
    </div>
  )
}
window.validatePreviewMath = validMathDom
window.previewHoldPages = false
window.previewDeferred = []
// The review's own shape: a narrow panel that scrolls, with the diff in full mode.
window.startFullDiff = diff => {
  document.getElementById('diff-panel')?.remove()
  const panel = document.createElement('div')
  panel.id = 'diff-panel'
  panel.style.cssText = 'width:500px;height:300px;overflow:auto'
  document.body.append(panel)
  createRoot(panel).render(<DiffView diffs={[diff]} mode="full" initiallyOpen />)
}
createRoot(document.getElementById('root')!).render(<Harness />)
