import { connect, type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2'
import type { Duplex } from 'node:stream'
import type { KnockBinding } from '@latch/link-wire'
import { connectNative } from './native.ts'

export class NativeHttpClient {
  private readonly session: ClientHttp2Session
  private readonly stream: Duplex
  private ended = false
  private readonly closeListeners = new Set<() => void>()
  constructor(socket: Duplex) {
    this.stream = socket
    this.session = connect('https://native.latch.invalid', { createConnection: () => socket })
    this.session.on('error', () => {})
    const ended = () => {
      if (this.ended) return
      this.ended = true
      for (const listener of this.closeListeners) {
        try {
          listener()
        } catch {
          /* A consumer cannot prevent the remaining close observers from settling. */
        }
      }
      this.closeListeners.clear()
    }
    this.session.once('close', ended)
    socket.once('close', ended)
  }
  isClosed(): boolean {
    return this.ended
  }
  onClose(listener: () => void): () => void {
    if (this.ended) {
      let cancelled = false
      queueMicrotask(() => {
        if (!cancelled) listener()
      })
      return () => {
        cancelled = true
      }
    }
    if (this.closeListeners.size >= 16) throw new Error('Native connection observer limit')
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }
  events(path: string): ClientHttp2Stream {
    if (!path.startsWith('/link/api/events') || path.length > 4096) throw new RangeError('Invalid native stream path')
    const stream = this.session.request({ ':method': 'GET', ':path': path })
    stream.end()
    return stream
  }
  async request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
    if (!path.startsWith('/link/api/') || path.length > 4096) throw new RangeError('Invalid native request path')
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    if (payload && payload.length > 1_048_576) throw new RangeError('Native request too large')
    return new Promise((resolve, reject) => {
      const request = this.session.request({ ':method': method, ':path': path, ...(payload ? { 'content-type': 'application/json' } : {}) })
      const chunks: Buffer[] = []
      const responseHeaders: Record<string, string> = {}
      let bytes = 0,
        status = 0
      const timer = setTimeout(() => {
        request.close()
        reject(new Error('Native request result unknown; retain the original requestId'))
      }, 15_000)
      timer.unref()
      request.once('response', headers => {
        status = Number(headers[':status'])
        for (const name of ['x-latch-audit', 'retry-after']) if (typeof headers[name] === 'string') responseHeaders[name] = headers[name]
      })
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 1_048_576) {
          request.destroy(new Error('Native response too large'))
          return
        }
        chunks.push(chunk)
      })
      request.once('error', () => {
        clearTimeout(timer)
        reject(new Error('Native request result unknown; retain the original requestId'))
      })
      request.once('end', () => {
        clearTimeout(timer)
        try {
          resolve({ status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, headers: responseHeaders })
        } catch {
          reject(new Error('Invalid native response'))
        }
      })
      request.end(payload)
    })
  }
  close(): void {
    this.session.destroy()
    this.stream.destroy()
  }
}
export async function openNativeHttp(
  stream: Duplex,
  binding: KnockBinding,
  options: Parameters<typeof connectNative>[2],
): Promise<NativeHttpClient> {
  return new NativeHttpClient(await connectNative(stream, binding, options))
}
