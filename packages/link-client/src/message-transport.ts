import type { ByteTransport } from './byte-transport.ts'

/** One already-routed, bidirectional message conversation. This interface grants no Latch identity. */
export interface MessageCarrier {
  maximumMessageBytes: number
  closed: Promise<void>
  send(message: Uint8Array, signal: AbortSignal): Promise<void>
  subscribe(message: (bytes: Uint8Array) => void, closed: () => void): () => void
  close(): Promise<void>
}
interface Pending {
  packet: Uint8Array
  attempts: number
  sentAt: number
  resolve(): void
  reject(error: Error): void
}
const HEADER = 22
const WINDOW = 4
const QUEUE_BYTES = 65_536

/** Bounded selective ACK, retransmission and ordering for interactive carriers; TLS authenticates the resulting bytes. */
export function messageByteTransport(carrier: MessageCarrier, connectionId: Uint8Array, signal?: AbortSignal): ByteTransport {
  if (
    !Number.isInteger(carrier.maximumMessageBytes)
    || carrier.maximumMessageBytes < 256
    || carrier.maximumMessageBytes > 16_384
    || connectionId.length !== 16
  )
    throw new RangeError('Invalid message carrier limits')
  const messageLimit = carrier.maximumMessageBytes,
    id = Uint8Array.from(connectionId),
    stop = new AbortController(),
    pending = new Map<number, Pending>(),
    reordered = new Map<number, Uint8Array>(),
    chunks: Array<{ sequence: number; data: Uint8Array }> = []
  let sequence = 0,
    expected = 0,
    consumed = 0,
    buffered = 0,
    queuedBytes = 0,
    sending = 0,
    writing = false,
    ending = false,
    wake: (() => void) | undefined,
    tail: Promise<void> = Promise.resolve(),
    closing: Promise<void> | undefined,
    unsubscribe = () => {}
  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => {
    resolveClosed = resolve
  })
  const packet = (type: 1 | 2, seq: number, data?: Uint8Array): Uint8Array => {
    const bytes = new Uint8Array(HEADER + (data?.length ?? 0))
    bytes[0] = 1
    bytes[1] = type
    bytes.set(id, 2)
    new DataView(bytes.buffer).setUint32(18, seq)
    if (data) bytes.set(data, HEADER)
    return bytes
  }
  const fail = (): void => {
    void close()
  }
  const send = (bytes: Uint8Array): Promise<void> => {
    if (ending || sending >= 16) {
      fail()
      return Promise.reject(new Error('Message carrier queue limit'))
    }
    sending++
    const next = tail.then(async () => {
      stop.signal.throwIfAborted()
      await carrier.send(Uint8Array.from(bytes), stop.signal)
    })
    tail = next.catch(fail).finally(() => {
      sending--
    })
    return next
  }
  const receive = (bytes: Uint8Array): void => {
    if (ending) return
    if (
      !(bytes instanceof Uint8Array)
      || bytes.length < HEADER
      || bytes.length > messageLimit
      || bytes[0] !== 1
      || ![1, 2].includes(bytes[1]!)
      || id.some((value, index) => bytes[index + 2] !== value)
    ) {
      fail()
      return
    }
    const seq = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(18)
    if (bytes[1] === 2) {
      if (bytes.length !== HEADER || seq >= sequence) {
        fail()
        return
      }
      const item = pending.get(seq)
      if (item) {
        pending.delete(seq)
        item.resolve()
      }
      return
    }
    const data = bytes.slice(HEADER)
    if (!data.length || seq > expected + WINDOW - 1) {
      fail()
      return
    }
    if (seq >= expected && !reordered.has(seq)) {
      if (buffered + queuedBytes + data.length > QUEUE_BYTES || chunks.length + reordered.size >= 128) {
        fail()
        return
      }
      reordered.set(seq, data)
      buffered += data.length
    }
    while (reordered.has(expected)) {
      const part = reordered.get(expected)!
      reordered.delete(expected++)
      buffered -= part.length
      queuedBytes += part.length
      chunks.push({ sequence: expected - 1, data: part })
    }
    if (seq < consumed) void send(packet(2, seq)).catch(fail)
    wake?.()
    wake = undefined
  }
  const timer = setInterval(() => {
    const now = performance.now()
    for (const item of pending.values()) {
      if (now - item.sentAt < 200) continue
      if (item.attempts >= 8) {
        fail()
        return
      }
      item.attempts++
      item.sentAt = now
      void send(item.packet).catch(fail)
    }
  }, 50)
  timer.unref()
  const aborted = (): void => {
    fail()
  }
  async function close(): Promise<void> {
    if (closing) return closing
    ending = true
    stop.abort()
    clearInterval(timer)
    unsubscribe()
    signal?.removeEventListener('abort', aborted)
    for (const item of pending.values()) item.reject(new Error('Message transport closed'))
    pending.clear()
    reordered.clear()
    chunks.length = 0
    buffered = 0
    queuedBytes = 0
    wake?.()
    wake = undefined
    closing = Promise.resolve().then(async () => {
      await Promise.allSettled([Promise.resolve().then(() => carrier.close()), carrier.closed, tail])
      resolveClosed()
    })
    return closing
  }
  unsubscribe = carrier.subscribe(receive, fail)
  void carrier.closed.then(fail, fail)
  if (ending) unsubscribe()
  signal?.addEventListener('abort', aborted, { once: true })
  if (signal?.aborted) fail()
  return {
    incoming: (async function* () {
      for (;;) {
        if (ending) return
        const next = chunks.shift()
        if (next) {
          queuedBytes -= next.data.length
          consumed = next.sequence + 1
          void send(packet(2, next.sequence)).catch(fail)
          yield next.data
          continue
        }
        await new Promise<void>(resolve => {
          wake = resolve
          if (ending) {
            wake = undefined
            resolve()
          }
        })
      }
    })(),
    async write(bytes, writeSignal) {
      if (writing || ending || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 16_384)
        throw new Error('Message transport write limit')
      writing = true
      const input = Uint8Array.from(bytes)
      const cancel = (): void => {
        fail()
      }
      writeSignal.addEventListener('abort', cancel, { once: true })
      if (writeSignal.aborted) fail()
      try {
        const maximum = messageLimit - HEADER
        for (let offset = 0; offset < input.length;) {
          const batch: Promise<void>[] = []
          for (let count = 0; count < WINDOW && offset < input.length; count++, offset += maximum) {
            if (ending || sequence === 0xffffffff) throw new Error('Message transport closed')
            const seq = sequence++,
              data = packet(1, seq, input.slice(offset, offset + maximum))
            const ack = new Promise<void>((resolve, reject) =>
              pending.set(seq, { packet: data, attempts: 1, sentAt: performance.now(), resolve, reject }),
            )
            batch.push(ack)
            void send(data).catch(fail)
          }
          await Promise.all(batch)
        }
      } finally {
        writing = false
        writeSignal.removeEventListener('abort', cancel)
      }
    },
    closed,
    close,
  }
}
