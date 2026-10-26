import { Duplex } from 'node:stream'

/** A platform-neutral plugin channel. Node stream and TLS concerns remain in this adapter. */
export interface ByteTransport {
  incoming: AsyncIterable<Uint8Array>
  write(bytes: Uint8Array, signal: AbortSignal): Promise<void>
  closed: Promise<void>
  close(): Promise<void>
}

export class ByteTransportStream extends Duplex {
  readonly settled: Promise<void>
  private readonly stop = new AbortController()
  private reading = false
  private finish!: () => void
  private readonly source: AsyncIterator<Uint8Array>
  private readonly operations = new Set<Promise<unknown>>()
  private observe<Value>(operation: Promise<Value>): Promise<Value> {
    this.operations.add(operation)
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    )
    return operation
  }
  constructor(private readonly transport: ByteTransport) {
    super({ highWaterMark: 16_384 })
    this.source = transport.incoming[Symbol.asyncIterator]()
    this.settled = new Promise(resolve => {
      this.finish = resolve
    })
    this.on('error', () => {})
    void transport.closed.then(
      () => this.destroy(),
      () => this.destroy(new Error('Transport closed')),
    )
  }
  override _read(): void {
    if (this.reading || this.destroyed) return
    this.reading = true
    void (async () => {
      try {
        while (!this.destroyed) {
          const item = await this.observe(this.source.next())
          if (this.destroyed) return
          if (item.done) {
            this.push(null)
            return
          }
          if (!(item.value instanceof Uint8Array) || item.value.length === 0 || item.value.length > 16_384)
            throw new Error('Transport chunk limit')
          if (!this.push(Buffer.from(item.value))) return
        }
      } catch {
        this.destroy(new Error('Transport read failed'))
      } finally {
        this.reading = false
      }
    })()
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.writableLength > 262_144) {
      callback(new Error('Transport write queue limit'))
      return
    }
    void (async () => {
      try {
        for (let offset = 0; offset < chunk.length; offset += 16_384) {
          this.stop.signal.throwIfAborted()
          await this.observe(this.transport.write(Uint8Array.from(chunk.subarray(offset, offset + 16_384)), this.stop.signal))
          this.stop.signal.throwIfAborted()
        }
        callback()
      } catch {
        callback(new Error('Transport write failed'))
      }
    })()
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.stop.abort()
    void (async () => {
      try {
        await Promise.allSettled([Promise.resolve().then(() => this.transport.close()), this.transport.closed])
        await Promise.allSettled([...this.operations])
        await this.source.return?.()
      } finally {
        this.finish()
        callback(error)
      }
    })().catch(() => callback(new Error('Transport close failed')))
  }
}

export function streamByteTransport(stream: Duplex): ByteTransport {
  const closed = new Promise<void>(resolve => {
    if (stream.closed) resolve()
    else stream.once('close', resolve)
  })
  stream.on('error', () => {})
  return {
    incoming: (async function* () {
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk as Uint8Array)
        for (let offset = 0; offset < bytes.length; offset += 16_384) yield Uint8Array.from(bytes.subarray(offset, offset + 16_384))
      }
    })(),
    async write(bytes, signal) {
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          stream.destroy()
          reject(new Error('Transport write cancelled'))
        }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) {
          abort()
          signal.removeEventListener('abort', abort)
          return
        }
        stream.write(bytes, error => {
          signal.removeEventListener('abort', abort)
          if (error) reject(new Error('Transport write failed'))
          else resolve()
        })
      })
    },
    closed,
    async close() {
      stream.destroy()
      await closed
    },
  }
}
