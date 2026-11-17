import type { EdgeWebSocket } from './platform.ts'

/** Memory bounds, independent of elapsed time, traffic volume, identity or billing. */
export const EDGE_BUFFER_LIMITS = {
  socketBytes: 512 * 1024,
  socketMessages: 512,
  objectBytes: 8 * 1024 * 1024,
  objectMessages: 8192,
} as const

interface Buffered {
  socket: WeakRef<EdgeWebSocket>
  inputBytes: number
  inputMessages: number
  queuedBytes: number
  queuedMessages: number
  writtenBytes: number
  written: number[]
  failedWriteBytes: number
  closing: boolean
}

/**
 * Accounts for received work, outer-cover queues and workerd's outgoing queue together. The close event can precede
 * the output pump finishing. A zero payload count settles bytes, but gives no evidence of the Close frame. Keep the
 * slot while its runtime socket remains reachable. A supported deployment also needs a native close-settlement signal.
 */
export class EdgeBuffers {
  private readonly sockets = new WeakMap<EdgeWebSocket, Buffered>()
  private readonly active = new Set<Buffered>()
  get size(): number {
    for (const state of this.active) if (state.closing) this.refresh(state)
    return this.active.size
  }
  private amount(socket: EdgeWebSocket): number | undefined {
    try {
      const amount = socket.bufferedAmount
      return typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined
    } catch {
      return undefined
    }
  }
  accept(socket: EdgeWebSocket): boolean {
    // bufferedAmount is available since workerd v1.20261117.1; no unsafe rate-based fallback on older runtimes.
    if (typeof WeakRef !== 'function' || this.sockets.has(socket) || this.amount(socket) !== 0) return false
    const state: Buffered = {
      socket: new WeakRef(socket),
      inputBytes: 0,
      inputMessages: 0,
      queuedBytes: 0,
      queuedMessages: 0,
      writtenBytes: 0,
      written: [],
      failedWriteBytes: 0,
      closing: false,
    }
    this.sockets.set(socket, state)
    this.active.add(state)
    return true
  }
  /** The counter includes the in-flight write; only completed writes reduce the ledger. */
  current(socket: EdgeWebSocket): boolean {
    const state = this.sockets.get(socket)
    if (!state) return false
    const amount = this.amount(socket)
    if (amount === undefined) return false
    if (state.failedWriteBytes) {
      // send() may have thrown on either side of enqueue. The old FIFO's drain cannot be inferred in that case.
      if (amount !== 0) return false
      state.written.length = 0
      state.writtenBytes = 0
      state.failedWriteBytes = 0
      return true
    }
    if (amount > state.writtenBytes) return false
    let drained = state.writtenBytes - amount
    while (drained > 0) {
      const first = state.written[0]
      if (first === undefined) return false
      const consumed = Math.min(first, drained)
      drained -= consumed
      if (consumed === first) state.written.shift()
      else state.written[0] = first - consumed
    }
    state.writtenBytes = amount
    return true
  }
  private refresh(state: Buffered): void {
    const socket = state.socket.deref()
    if (socket) this.current(socket)
    else this.active.delete(state)
  }
  private usage(state: Buffered): { bytes: number; messages: number } {
    return {
      bytes: state.inputBytes + state.queuedBytes + state.writtenBytes + state.failedWriteBytes,
      messages: state.inputMessages + state.queuedMessages + state.written.length + Number(state.failedWriteBytes > 0),
    }
  }
  status(): { bytes: number; messages: number } {
    let bytes = 0,
      messages = 0
    for (const state of this.active) {
      if (state.closing || state.writtenBytes > 0) this.refresh(state)
      if (!this.active.has(state)) continue
      const used = this.usage(state)
      bytes += used.bytes
      messages += used.messages
    }
    return { bytes, messages }
  }
  private reserve(socket: EdgeWebSocket, bytes: number): Buffered | undefined {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || !this.current(socket)) return undefined
    const state = this.sockets.get(socket)!
    if (state.closing) return undefined
    const own = this.usage(state),
      total = this.status()
    if (
      own.bytes + bytes > EDGE_BUFFER_LIMITS.socketBytes
      || own.messages + 1 > EDGE_BUFFER_LIMITS.socketMessages
      || total.bytes + bytes > EDGE_BUFFER_LIMITS.objectBytes
      || total.messages + 1 > EDGE_BUFFER_LIMITS.objectMessages
    )
      return undefined
    return state
  }
  receive(socket: EdgeWebSocket, bytes: number): boolean {
    const state = this.reserve(socket, bytes)
    if (!state) return false
    state.inputBytes += bytes
    state.inputMessages++
    return true
  }
  received(socket: EdgeWebSocket, bytes: number): void {
    const state = this.sockets.get(socket)
    if (!state) return
    state.inputBytes -= bytes
    state.inputMessages--
  }
  queue(socket: EdgeWebSocket, bytes: number): boolean {
    const state = this.reserve(socket, bytes)
    if (!state) return false
    state.queuedBytes += bytes
    state.queuedMessages++
    return true
  }
  /** Moves a reserved message to the runtime queue without releasing its memory reservation. */
  write(socket: EdgeWebSocket, payload: Uint8Array): void {
    const state = this.sockets.get(socket)
    if (!state || state.closing || state.queuedMessages < 1 || state.queuedBytes < payload.length || !this.current(socket))
      throw new Error('Relay output unavailable')
    state.queuedBytes -= payload.length
    state.queuedMessages--
    try {
      socket.send(payload)
    } catch (error) {
      state.failedWriteBytes = payload.length
      throw error
    }
    state.writtenBytes += payload.length
    state.written.push(payload.length)
  }
  close(socket: EdgeWebSocket): void {
    const state = this.sockets.get(socket)
    if (!state) return
    state.closing = true
    // The owner discards its outer-cover queue synchronously with this call.
    state.queuedBytes = 0
    state.queuedMessages = 0
  }
  closed(socket: EdgeWebSocket): void {
    this.close(socket)
    this.current(socket)
  }
}
