import type { EdgeWebSocket } from './platform.ts'

/**
 * The node object's bounds, counted only from what this code holds or hands to `send()`, against its own clock.
 *
 * - Received work and the outer-cover queue are this object's own JavaScript memory: exact byte and message bounds.
 * - Each socket's output to the runtime spends a byte budget that refills with time. That bounds the rate, not memory:
 *   a socket whose reader stops can still grow the runtime's buffer at that rate, unless the runtime reports it in
 *   `bufferedAmount` and the socket is closed for it (below). A socket that has authenticated and been joined to its
 *   partner (a phone and its DATA leg) gets a larger budget of its own, so an explicit transfer runs at network speed:
 *   a paired phone that stops reading can grow the runtime's buffer at `joinedSendRate`, and the backlog close is the
 *   earlier stop. Every other socket, the Host's control socket included, keeps the small budget.
 * - Sockets that have not authenticated and get the outer cover (client and DATA legs; Host control sockets get none)
 *   are limited in number object-wide, and each may hand the runtime at most `preauthSocketBytes` before it
 *   authenticates. When the limit is reached a newcomer is not refused: the oldest unauthenticated socket of the prefix
 *   holding the most of them is closed instead, so one or a few prefixes cannot keep everyone else out.
 * - Connection slots: a closed socket keeps its slot for `closeHoldMs` by the clock. One /24 or /48 prefix holds at
 *   most `maxPerPrefix` slots, open or held. When slots run out, the prefix holding the most gives up a held slot or its
 *   oldest unauthenticated socket before a newcomer from a smaller prefix is refused.
 * - `bufferedAmount`, when the runtime reports a valid number, only closes a socket earlier: a backlog above
 *   `maxBacklogBytes` (`joinedBacklogBytes` once joined) on one socket, or above `objectBacklogBytes` in sum, closes
 *   the largest. It never releases budget.
 */
export const EDGE_BUFFER_LIMITS = {
  socketBytes: 512 * 1024,
  socketMessages: 512,
  objectBytes: 8 * 1024 * 1024,
  objectMessages: 8192,
  /** The active padding grid sends 16 KiB every 40 ms (400 KiB/s); a socket may hand the runtime this much more. */
  socketSendBytes: 1024 * 1024,
  socketSendRate: 768 * 1024,
  /** Unauthenticated sockets with cover at once: each draws about 100 KiB/s for at most the 3–4 s window. */
  maxCovered: 16,
  /** About 4 s of cover plus the handshake; past it the socket is closed. */
  preauthSocketBytes: 512 * 1024,
  maxBacklogBytes: 1024 * 1024,
  /** Authenticated and joined: an explicit transfer at up to about 130 Mbit/s, and its bounds. */
  joinedSendBytes: 8 * 1024 * 1024,
  joinedSendRate: 16 * 1024 * 1024,
  /** Above the 4 MiB HTTP/2 connection window a bulk transfer may keep in flight, with its cells and frames. */
  joinedBacklogBytes: 6 * 1024 * 1024,
  objectBacklogBytes: 32 * 1024 * 1024,
  closeHoldMs: 5000,
  maxConnections: 1024,
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
  spend(bytes: number, now: number): boolean {
    if (now > this.at) {
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.at) * this.rate) / 1000)
      this.at = now
    }
    if (this.tokens < bytes) return false
    this.tokens -= bytes
    return true
  }
}

interface Buffered {
  socket: EdgeWebSocket
  prefix: string
  /** Gets the outer cover and has not authenticated yet. */
  covered: boolean
  authenticated: boolean
  /** Joined to its partner; with `authenticated`, the socket spends the joined budget. */
  joined: boolean
  preauthBytes: number
  inputBytes: number
  inputMessages: number
  queuedBytes: number
  queuedMessages: number
  send: Bucket
  /** When the close was seen; the slot is held until `closedAt + closeHoldMs`. */
  closedAt?: number
  released: boolean
}
interface Prefix {
  /** Open and held slots, oldest first. */
  slots: Set<Buffered>
  /** Open unauthenticated sockets, oldest first. */
  unauthenticated: Set<Buffered>
  covered: number
}
export type WriteResult = 'written' | 'over-budget' | 'backlog' | 'failed'

export class EdgeBuffers {
  private readonly sockets = new Map<EdgeWebSocket, Buffered>()
  private readonly prefixes = new Map<string, Prefix>()
  /** Closed sockets in close order, for releasing their slots without scanning. */
  private readonly held: Buffered[] = []
  private covered = 0
  private totalBytes = 0
  private totalMessages = 0
  private readonly limits: EdgeBufferLimits
  private readonly now: () => number
  refused = 0
  evicted = 0
  constructor(now: () => number, limits: Partial<EdgeBufferLimits> = {}) {
    this.now = now
    this.limits = { ...EDGE_BUFFER_LIMITS, ...limits }
  }
  /** Connection slots in use, closed sockets included until their hold has passed. */
  get size(): number {
    this.release()
    return this.sockets.size
  }
  private release(): void {
    const now = this.now()
    while (this.held.length) {
      const first = this.held[0]!
      if (first.released) {
        this.held.shift()
        continue
      }
      if (now - first.closedAt! < this.limits.closeHoldMs || first.inputMessages) break
      this.held.shift()
      this.drop(first)
    }
  }
  private drop(state: Buffered): void {
    if (state.released) return
    state.released = true
    this.sockets.delete(state.socket)
    this.totalBytes -= state.inputBytes + state.queuedBytes
    this.totalMessages -= state.inputMessages + state.queuedMessages
    const group = this.prefixes.get(state.prefix)
    if (!group) return
    group.slots.delete(state)
    this.leaveUnauthenticated(state, group)
    if (!group.slots.size) this.prefixes.delete(state.prefix)
  }
  private leaveUnauthenticated(state: Buffered, group = this.prefixes.get(state.prefix)): void {
    if (!group?.unauthenticated.delete(state)) return
    if (state.covered) {
      group.covered--
      this.covered--
    }
  }
  /** The prefix holding the most of `count`, other than one that holds no more than `own`. */
  private largest(count: (group: Prefix) => number, own: number): Prefix | undefined {
    let best: Prefix | undefined
    for (const group of this.prefixes.values()) if (count(group) > own && (!best || count(group) > count(best))) best = group
    return best
  }
  /** Frees one slot of `group`: a held slot first, else its oldest unauthenticated socket, which the caller closes. */
  private yieldSlot(group: Prefix, evict: EdgeWebSocket[]): boolean {
    for (const state of group.slots)
      if (state.closedAt !== undefined && !state.inputMessages) {
        this.drop(state)
        return true
      }
    const oldest = group.unauthenticated.values().next().value
    if (!oldest) return false
    this.close(oldest.socket)
    this.drop(oldest)
    evict.push(oldest.socket)
    this.evicted++
    return true
  }
  /**
   * A new socket. `evict` are the sockets the caller must close to make room, also when the newcomer is refused: it is
   * refused only when its own prefix already holds its share and has nothing it could give up.
   */
  accept(socket: EdgeWebSocket, prefix: string, covered: boolean): { accepted: boolean; evict: EdgeWebSocket[] } {
    this.release()
    const evict: EdgeWebSocket[] = []
    if (this.sockets.has(socket)) return { accepted: false, evict }
    const own = this.prefixes.get(prefix)
    const ownSlots = own?.slots.size ?? 0
    if (ownSlots >= this.limits.maxPerPrefix && !this.yieldSlot(own!, evict)) return this.refuse(evict)
    if (this.sockets.size >= this.limits.maxConnections) {
      const other = this.largest(group => group.slots.size, (own?.slots.size ?? 0) + 1)
      if (!(other ? this.yieldSlot(other, evict) : own && this.yieldSlot(own, evict))) return this.refuse(evict)
    }
    if (covered && this.covered >= this.limits.maxCovered) {
      const ownCovered = own?.covered ?? 0
      const other = this.largest(group => group.covered, ownCovered + 1) ?? (ownCovered ? own : undefined)
      const oldest = other && [...other.unauthenticated].find(state => state.covered)
      if (!oldest) return this.refuse(evict)
      this.close(oldest.socket)
      evict.push(oldest.socket)
      this.evicted++
    }
    const state: Buffered = {
      socket,
      prefix,
      covered,
      authenticated: false,
      joined: false,
      preauthBytes: 0,
      inputBytes: 0,
      inputMessages: 0,
      queuedBytes: 0,
      queuedMessages: 0,
      send: new Bucket(this.limits.socketSendBytes, this.limits.socketSendRate, this.now()),
      released: false,
    }
    this.sockets.set(socket, state)
    let group = this.prefixes.get(prefix)
    if (!group) this.prefixes.set(prefix, (group = { slots: new Set(), unauthenticated: new Set(), covered: 0 }))
    group.slots.add(state)
    group.unauthenticated.add(state)
    if (covered) {
      group.covered++
      this.covered++
    }
    return { accepted: true, evict }
  }
  private refuse(evict: EdgeWebSocket[]): { accepted: false; evict: EdgeWebSocket[] } {
    this.refused++
    return { accepted: false, evict }
  }
  /** The node sent REGISTERED, ADMITTED or ATTACHED: the socket no longer counts as unauthenticated. */
  authenticate(socket: EdgeWebSocket): void {
    const state = this.sockets.get(socket)
    if (!state || state.authenticated) return
    state.authenticated = true
    this.leaveUnauthenticated(state)
    this.promote(state)
  }
  /**
   * The core joined the socket to its partner. The DATA leg is joined just before it is sent ATTACHED, so the joined
   * budget starts once both have happened, in either order.
   */
  join(socket: EdgeWebSocket): void {
    const state = this.sockets.get(socket)
    if (!state || state.joined) return
    state.joined = true
    this.promote(state)
  }
  private promote(state: Buffered): void {
    if (state.authenticated && state.joined && state.closedAt === undefined)
      state.send = new Bucket(this.limits.joinedSendBytes, this.limits.joinedSendRate, this.now())
  }
  private backlogLimit(state: Buffered): number {
    return state.authenticated && state.joined ? this.limits.joinedBacklogBytes : this.limits.maxBacklogBytes
  }
  status(): { bytes: number; messages: number; backlog: number; slots: number; covered: number; refused: number; evicted: number } {
    let backlog = 0
    for (const socket of this.sockets.keys()) backlog += this.amount(socket) ?? 0
    return {
      bytes: this.totalBytes,
      messages: this.totalMessages,
      backlog,
      slots: this.size,
      covered: this.covered,
      refused: this.refused,
      evicted: this.evicted,
    }
  }
  private reserve(socket: EdgeWebSocket, bytes: number): Buffered | undefined {
    const state = this.sockets.get(socket)
    if (!state || state.closedAt !== undefined || !Number.isSafeInteger(bytes) || bytes <= 0) return undefined
    if (
      state.inputBytes + state.queuedBytes + bytes > this.limits.socketBytes
      || state.inputMessages + state.queuedMessages + 1 > this.limits.socketMessages
      || this.totalBytes + bytes > this.limits.objectBytes
      || this.totalMessages + 1 > this.limits.objectMessages
    )
      return undefined
    this.totalBytes += bytes
    this.totalMessages++
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
    if (!state || state.released) return
    state.inputBytes -= bytes
    state.inputMessages--
    this.totalBytes -= bytes
    this.totalMessages--
  }
  /** Reserves this object's memory for a message held in the outer-cover queue until its tick. */
  queue(socket: EdgeWebSocket, bytes: number): boolean {
    const state = this.reserve(socket, bytes)
    if (!state) return false
    state.queuedBytes += bytes
    state.queuedMessages++
    return true
  }
  /**
   * Hands one message to the runtime, after its queue reservation (`queued`) if it had one. Spends the socket's send
   * budget and, before the socket authenticated, its unauthenticated allowance.
   */
  write(socket: EdgeWebSocket, payload: Uint8Array, options: { queued: boolean }): WriteResult {
    const state = this.sockets.get(socket)
    if (!state || state.closedAt !== undefined) return 'failed'
    const bytes = payload.length
    if (options.queued && state.queuedMessages > 0) {
      const freed = Math.min(state.queuedBytes, bytes)
      state.queuedBytes -= freed
      state.queuedMessages--
      this.totalBytes -= freed
      this.totalMessages--
    }
    if (!state.authenticated && (state.preauthBytes += bytes) > this.limits.preauthSocketBytes) return 'over-budget'
    if (!state.send.spend(bytes, this.now())) return 'over-budget'
    try {
      socket.send(payload)
    } catch {
      return 'failed'
    }
    const backlog = this.amount(socket)
    return backlog !== undefined && backlog > this.backlogLimit(state) ? 'backlog' : 'written'
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
    const open = [...this.sockets.values()]
      .filter(state => state.closedAt === undefined)
      .map(state => ({ socket: state.socket, backlog: this.amount(state.socket) ?? 0, limit: this.backlogLimit(state) }))
      .sort((a, b) => b.backlog - a.backlog)
    const out: EdgeWebSocket[] = []
    let sum = open.reduce((total, item) => total + item.backlog, 0)
    // Bounds differ per socket, so every socket over its own is closed first, then the largest until the sum fits.
    const rest = open.filter(item => {
      if (item.backlog <= item.limit) return true
      out.push(item.socket)
      sum -= item.backlog
      return false
    })
    for (const item of rest) {
      if (sum <= this.limits.objectBacklogBytes) break
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
    this.totalBytes -= state.queuedBytes
    this.totalMessages -= state.queuedMessages
    state.queuedBytes = 0
    state.queuedMessages = 0
    this.leaveUnauthenticated(state)
    this.held.push(state)
  }
}
