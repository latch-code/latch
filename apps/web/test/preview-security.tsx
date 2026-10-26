import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { FileMetadata } from '@latch/protocol'
import { DocumentPreview } from '../src/preview/DocumentPreview.tsx'
import { FileSandbox } from '../src/preview/FileSandbox.tsx'
import { Diagram } from '../src/preview/Diagram.tsx'
import type { FrameInput } from '../src/preview/types.ts'
import '../src/styles/index.css'

type DocumentKind = 'pptx' | 'docx' | 'xlsx' | 'pdf'
declare global {
  interface Window {
    openSecurityDocument(kind: DocumentKind | 'html' | 'mermaid', bytes: number[]): void
    securityEvents: unknown[]
    securityChannels: number
  }
}
function Harness() {
  const [input, setInput] = useState<{ kind: DocumentKind | 'html' | 'mermaid'; data: ArrayBuffer; key: string }>()
  window.openSecurityDocument = (kind, bytes) => {
    window.securityEvents = []
    window.securityChannels = 0
    setInput({ kind, data: new Uint8Array(bytes).buffer, key: crypto.randomUUID() })
  }
  const renderFrame = (value: FrameInput) => (
    <FileSandbox
      key={value.versionKey}
      {...value}
      onChannel={send => {
        if (send) window.securityChannels++
        value.onChannel?.(send)
      }}
      onMessage={(event, origin) => {
        window.securityEvents.push(event)
        value.onMessage?.(event, origin)
      }}
    />
  )
  if (!input) return <main>选择测试文档</main>
  const file: FileMetadata = {
    handle: 'fixture',
    root: 'fixture',
    name: `fixture.${input.kind}`,
    path: `fixture.${input.kind}`,
    ext: input.kind,
    kind: input.kind === 'mermaid' ? 'text' : input.kind,
    mime: 'application/octet-stream',
    size: input.data.byteLength,
    mtime: 0,
    etag: 'fixture',
    limit: 50 * 1024 * 1024,
    secret: false,
    actions: { preview: true, download: true, open: false, reveal: false, quicklook: false },
  }
  return (
    <main data-security-kind={input.kind} style={{ height: 'calc(100dvh - 16px)', padding: 8 }}>
      {input.kind === 'mermaid' ? (
        <Diagram key={input.key} source={new TextDecoder().decode(input.data)} renderFrame={renderFrame} />
      ) : input.kind === 'html' ? (
        renderFrame({ kind: 'html', data: input.data, versionKey: input.key })
      ) : (
        <DocumentPreview
          key={input.key}
          file={file}
          versionKey={input.key}
          renderFrame={renderFrame}
          read={async (start, end, signal) => {
            signal?.throwIfAborted()
            return input.data.slice(start ?? 0, end === undefined ? undefined : end + 1)
          }}
        />
      )}
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Harness />)
