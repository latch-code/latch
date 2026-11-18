import type { EdgeWebSocket } from './platform.ts'

/**
 * Memory bounds that hold whatever the runtime does with a socket's output and close: they count only what this code
 * holds or hands to `send()`, against clocks and budgets kept here.
 *
 * - Received work and the outer-cover queue are this object's own JavaScript memory: exact byte and message bounds.
 * - Output handed to the runtime is limited per socket by a byte budget that refills with time, so no socket can push
 *   more than `socketSendBytes` plus `socketSendRate` per second into the runtime, read or not.
 * - Output to sockets that have not authenticated (the outer cover and the handshake) also spends a budget of its
 *   /24 or /48 prefix and one of the object, each refilling with time: unauthenticated sockets from one prefix, or from
 *   all prefixes, cannot fill the object. When the budget cannot pay for the cover, the socket is refused or closed
 *   rather than served without it.
 * - A closed socket keeps its connection slot for `closeHoldMs` after the close, by the clock, never by garbage
 *   collection or a runtime signal.
 * - `bufferedAmount`, when the runtime reports a valid number, only closes a socket earlier: a backlog above
 *   `maxBacklogBytes` on one socket, or above `objectBacklogBytes` in sum, closes the largest. It never releases budget.
 */
export const EDGE_BUFFER_LIMITS = {
  socketBytes: 512 * 1024,
  socketMessages: 512,
  objectBytes: 8 * 1024 * 1024,
  objectMessages: 8192,
  /** The active padding grid sends 16 KiB every 40 ms (400 KiB/s); a socket may hand the runtime this much more. */
  socketSendBytes: 1024 * 1024,
  socketSendRate: 768 * 1024,
  preauthPrefixBytes: 256 * 1024,
  preauthPrefixRate: 64 * 1024,
  preauthObjectBytes: 1024 * 1024,
  preauthObjectRate: 256 * 1024,
  /** A new socket needs about a second of cover left in both pre-authentication budgets. */
  preauthMinimum: 32 * 1024,
  maxBacklogBytes: 1024 * 1024,
  objectBacklogBytes: 16 * 1024 * 1024,
  closeHoldMs: 5000,
  /** Open and held slots of one /24 or /48 prefix: a prefix that opens and closes fast cannot hold every slot. */
  maxPerPrefix: 64,
} as const
export type EdgeBufferLimits = { -readonly [Key in keyof typeof EDGE_BUFFER_LIMITS]: number }

/** A byte budget that refills at a fixed rate up to its capacity. */
class Bucket {
  private tokens: number
  private at: number
  private readonly capacity: number
  private readonly rate: number
  constructor(capacity: number, rate: number, now: number) {
    this.capacity = capacity
    this.rate = rate
    this.tokens = capacity
    this.at = now
  }
  level(now: number): number {
    if (now > this.at) {
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.at) * this.rate) / 1000)
      this.at = now
    }
    return this.tokens
  }
  full(now: number): boolean {
    return this.level(now) >= this.capacity
  }
  spend(bytes: number, now: number): boolean {
    if (this.level(now) < bytes) return false
    this.tokens -= bytes
    return true
  }
}

interface Buffered {
  prefix: string
  inputBytes: number
  inputMessages: number
  queuedBytes: number
  queuedMessages: number
  send: Bucket
  /** When the close was seen; the slot is held until `closedAt + closeHoldMs`. */
  closedAt?: number
}
export type WriteResult = 'written' | 'over-budget' | 'backlog' | 'failed'

export class EdgeBuffers {
  private readonly sockets = new Map<EdgeWebSocket, Buffered>()
  private readonly prefixes = new Map<string, Bucket>()
  private readonly preauth: Bucket
  private readonly limits: EdgeBufferLimits
  private readonly now: () => number
  refused = 0
  constructor(now: () => number, limits: Partial<EdgeBufferLimits> = {}) {
    this.now = now
    this.limits = { ...EDGE_BUFFER_LIMITS, ...limits }
    this.preauth = new Bucket(this.limits.preauthObjectBytes, this.limits.preauthObjectRate, now())
  }
  /** Connection slots in use, closed sockets included until their hold has passed. */
  get size(): number {
    this.release()
    return this.sockets.size
  }
  private release(): void {
    const now = this.now()
    for (const [socket, state] of this.sockets)
      if (state.closedAt !== undefined && now - state.closedAt >= this.limits.closeHoldMs && !state.inputMessages)
        this.sockets.delete(socket)
    for (const [prefix, bucket] of this.prefixes)
      if (bucket.full(now) && ![...this.sockets.values()].some(state => state.prefix === prefix)) this.prefixes.delete(prefix)
  }
  private prefix(prefix: string): Bucket {
    let bucket = this.prefixes.get(prefix)
    if (!bucket) this.prefixes.set(prefix, (bucket = new Bucket(this.limits.preauthPrefixBytes, this.limits.preauthPrefixRate, this.now())))
    return bucket
  }
  /** A new socket, refused when its prefix or the object cannot pay for about a second of unauthenticated cover. */
  accept(socket: EdgeWebSocket, prefix: string): boolean {
    this.release()
    const now = this.now()
    if (this.sockets.has(socket)) return false
    let slots = 0
    for (const state of this.sockets.values()) if (state.prefix === prefix) slots++
    if (slots >= this.limits.maxPerPrefix) {
      this.refused++
      return false
    }
    if (this.prefix(prefix).level(now) < this.limits.preauthMinimum || this.preauth.level(now) < this.limits.preauthMinimum) {
      this.refused++
      return false
    }
    this.sockets.set(socket, {
      prefix,
      inputBytes: 0,
      inputMessages: 0,
      queuedBytes: 0,
      queuedMessages: 0,
      send: new Bucket(this.limits.socketSendBytes, this.limits.socketSendRate, now),
    })
    return true
  }
  private usage(state: Buffered): { bytes: number; messages: number } {
    return { bytes: state.inputBytes + state.queuedBytes, messages: state.inputMessages + state.queuedMessages }
  }
  status(): { bytes: number; messages: number; backlog: number; slots: number; refused: number } {
    let bytes = 0,
      messages = 0,
      backlog = 0
    for (const [socket, state] of this.sockets) {
      const used = this.usage(state)
      bytes += used.bytes
      messages += used.messages
      backlog += this.amount(socket) ?? 0
    }
    return { bytes, messages, backlog, slots: this.size, refused: this.refused }
  }
  private reserve(socket: EdgeWebSocket, bytes: number): Buffered | undefined {
    const state = this.sockets.get(socket)
    if (!state || state.closedAt !== undefined || !Number.isSafeInteger(bytes) || bytes <= 0) return undefined
    const own = this.usage(state)
    let totalBytes = 0,
      totalMessages = 0
    for (const other of this.sockets.values()) {
      const used = this.usage(other)
      totalBytes += used.bytes
      totalMessages += used.messages
    }
    if (
      own.bytes + bytes > this.limits.socketBytes
      || own.messages + 1 > this.limits.socketMessages
      || totalBytes + bytes > this.limits.objectBytes
      || totalMessages + 1 > this.limits.objectMessages
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
  /** Reserves this object's memory for a message held in the outer-cover queue until its tick. */
  queue(socket: EdgeWebSocket, bytes: number): boolean {
    const state = this.reserve(socket, bytes)
    if (!state) return false
    state.queuedBytes += bytes
    state.queuedMessages++
    return true
  }
  /** Releases a queue reservation without sending (the cover discards its queue). */
  unqueue(socket: EdgeWebSocket, bytes: number): void {
    const state = this.sockets.get(socket)
    if (!state || state.queuedMessages < 1) return
    state.queuedBytes = Math.max(0, state.queuedBytes - bytes)
    state.queuedMessages--
  }
  /**
   * Hands one message to the runtime, after its queue reservation (`queued`) if it had one. Spends the socket's send
   * budget and, before the socket authenticated, its prefix's and the object's unauthenticated budgets.
   */
  write(socket: EdgeWebSocket, payload: Uint8Array, options: { queued: boolean; authenticated: boolean }): WriteResult {
    const state = this.sockets.get(socket)
    if (!state || state.closedAt !== undefined) return 'failed'
    if (options.queued) {
      state.queuedBytes = Math.max(0, state.queuedBytes - payload.length)
      state.queuedMessages = Math.max(0, state.queuedMessages - 1)
    }
    const now = this.now(),
      bytes = payload.length
    if (!options.authenticated) {
      const prefix = this.prefix(state.prefix)
      if (prefix.level(now) < bytes || this.preauth.level(now) < bytes) return 'over-budget'
      prefix.spend(bytes, now)
      this.preauth.spend(bytes, now)
    }
    if (!state.send.spend(bytes, now)) return 'over-budget'
    try {
      socket.send(payload)
    } catch {
      return 'failed'
    }
    const backlog = this.amount(socket)
    return backlog !== undefined && backlog > this.limits.maxBacklogBytes ? 'backlog' : 'written'
  }
  /** The runtime's own count, when it is a valid number; used only to close sockets earlier. */
  private amount(socket: EdgeWebSocket): number | undefined {
    try {
      const amount = socket.bufferedAmount
      return typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined
    } catch {
      return undefined
    }
  }
  /**
   * Sockets to close for their backlog: each above the per-socket bound, then the largest while the reported sum stays
   * above the object bound. Sockets whose runtime reports nothing are bounded by their send budget alone.
   */
  overloaded(): EdgeWebSocket[] {
    const open = [...this.sockets.entries()]
      .filter(([, state]) => state.closedAt === undefined)
      .map(([socket]) => ({ socket, backlog: this.amount(socket) ?? 0 }))
      .sort((a, b) => b.backlog - a.backlog)
    const out: EdgeWebSocket[] = []
    let sum = open.reduce((total, item) => total + item.backlog, 0)
    for (const item of open) {
      if (item.backlog <= this.limits.maxBacklogBytes && sum <= this.limits.objectBacklogBytes) break
      out.push(item.socket)
      sum -= item.backlog
    }
    return out
  }
  /** The socket closed, by this code or the peer: its cover queue is gone, its slot is held for `closeHoldMs`. */
  close(socket: EdgeWebSocket): void {
    const state = this.sockets.get(socket)
    if (!state || state.closedAt !== undefined) return
    state.closedAt = this.now()
    state.queuedBytes = 0
    state.queuedMessages = 0
  }
}
