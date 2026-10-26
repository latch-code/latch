import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { FileMetadata } from '@latch/protocol'
import { DocumentPreview } from '../src/preview/DocumentPreview.tsx'
import { FileSandbox } from '../src/preview/FileSandbox.tsx'
import '../src/styles/index.css'

export interface DocumentPerformanceRead {
  start?: number
  end?: number
  bytes: number
  durationMs: number
  status: number
}
declare global {
  interface Window {
    openPerformanceDocument: (kind: 'pptx' | 'pdf' | 'xlsx', size: number) => void
    documentPerformance: { startedAt: number; reads: DocumentPerformanceRead[]; events: unknown[] }
    documentFirstVisible?: number
  }
}
function Harness() {
  const [input, setInput] = useState<{
    file: FileMetadata
    read: (start?: number, end?: number, signal?: AbortSignal) => Promise<ArrayBuffer>
    versionKey: string
  }>()
  window.openPerformanceDocument = (kind, size) => {
    window.documentPerformance = { startedAt: performance.timeOrigin + performance.now(), reads: [], events: [] }
    delete window.documentFirstVisible
    setInput({
      file: {
        handle: 'performance',
        root: 'fixture',
        path: `performance.${kind}`,
        name: `performance.${kind}`,
        ext: kind,
        kind,
        mime: 'application/octet-stream',
        size,
        mtime: 0,
        etag: `performance-${kind}`,
        limit: 50 * 1024 * 1024,
        secret: false,
        actions: { preview: true, download: true, open: false, reveal: false, quicklook: false },
      },
      versionKey: crypto.randomUUID(),
      async read(start, end, signal) {
        const started = performance.now(),
          response = await fetch(`/document-performance/input/${kind}`, {
            signal,
            cache: 'no-store',
            headers: start === undefined ? {} : { Range: `bytes=${start}-${end ?? ''}` },
          })
        if (!response.ok) throw new Error('Fixture read failed')
        const bytes = await response.arrayBuffer()
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
        window.documentPerformance.reads.push({
          start,
          end,
          bytes: bytes.byteLength,
          durationMs: performance.now() - started,
          status: response.status,
        })
        return bytes
      },
    })
  }
  return (
    <main style={{ height: 'calc(100dvh - 16px)', padding: 8 }}>
      {input && (
        <DocumentPreview
          {...input}
          renderFrame={value => (
            <FileSandbox
              key={value.versionKey}
              {...value}
              onMessage={(event, origin) => {
                window.documentPerformance.events.push(event)
                value.onMessage?.(event, origin)
              }}
            />
          )}
        />
      )}
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Harness />)
