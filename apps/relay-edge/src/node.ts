import {
  decodeMessage,
  EDGE_RELAY,
  encodeMessage,
  MAX_MESSAGE,
  OUTER_PADDING,
  REGISTRATION_WORK,
  UTC_DAY,
  type LinkCrypto,
  type RelayMessage,
} from '@latch/link-wire'
import { RelayCore, type RegistrationWorkInput, type RegistrationWorkResult, type RelayPeer } from '@latch/relay-core'
import { webLinkCrypto } from './crypto.ts'
import type { EdgeEnv, EdgePlatform, EdgeRequest, EdgeResponse, EdgeState, EdgeWebSocket } from './platform.ts'
import { encodeWorkRequest } from './scrypt.ts'
import { EdgeDenials } from './storage.ts'
import { EdgeBuffers } from './buffers.ts'

export const EDGE_PROTOCOL = 'latch-relay.2'
type Role = 'host' | 'data' | 'client'
const ALARM_MS = 30_000

/** Bytes of one WebSocket frame on the wire for a payload: the node's frames are unmasked, a client's masked. */
export function frameBytes(payload: number, masked: boolean): number {
  return payload + (payload <= 125 ? 2 : payload <= 65_535 ? 4 : 10) + (masked ? 4 : 0)
}

export interface EdgeLimits {
  maxConnections: number
  maxRoutes: number
  maxPerPrefix: number
  maxRoutesPerPrefix: number
  maxPreauthConnections: number
  softRoutesPerPrefix: number
  minBits: number
  maxBits: number
  maxConcurrent: number
  /** Received bytes one socket may have queued for the core before the node closes it (4302). */
  maxQueuedBytes: number
  /**
   * Joined pairs one node object carries; past it new phones are refused with 4302 (more shards are the way to scale).
   * Unmeasured; kept low against the platform's documented soft limit of about 1,000 requests per second per object,
   * where an idle pair costs about 8 received messages a second and a streaming one up to about 50.
   */
  maxPairs: number
  /**
   * A socket whose runtime reports more unsent bytes than this is closed (4302). Only used when the runtime reports a
   * valid `bufferedAmount`; otherwise only the send budget in buffers.ts, a rate, applies.
   */
  maxBacklogBytes: number
}
const DEFAULT_LIMITS: EdgeLimits = {
  maxConnections: 1024,
  maxRoutes: 512,
  maxPerPrefix: 64,
  maxRoutesPerPrefix: 32,
  maxPreauthConnections: 256,
  softRoutesPerPrefix: 4,
  minBits: 8,
  maxBits: 18,
  maxConcurrent: 4,
  maxQueuedBytes: 262_144,
  maxPairs: 40,
  maxBacklogBytes: 1_048_576,
}
/**
 * Messages a socket may send before the node has authenticated it: HELLO and one REGISTER, ADMIT or ATTACH. The one
 * work proof a node asks for (it sent REGISTRATION-WORK) does not count.
 */
const PREAUTH_MESSAGES = 2
/** PAD messages are the client's three-second outer cover only: about 75 on the 40 ms grid, with slack. */
const COVER_PADS = 120
const COVER_MS = OUTER_PADDING.durationMs + 500
/** One application PING per this interval at most; clients send one every `EDGE_RELAY.pingIntervalMs`. */
const PING_MIN_MS = 15_000
function limits(text: string | undefined): EdgeLimits {
  if (!text) return DEFAULT_LIMITS
  const parsed = JSON.parse(text) as Record<string, unknown>
  const out = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in out) || !Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError('Invalid relay limits')
    out[key as keyof EdgeLimits] = value as number
  }
  if (out.minBits > out.maxBits || out.maxBits > REGISTRATION_WORK.maxBits || out.softRoutesPerPrefix >= out.maxRoutesPerPrefix)
    throw new RangeError('Invalid relay limits')
  return out
}
export function hexBytes(text: string | undefined, size: number): Uint8Array | undefined {
  if (!text || !new RegExp(`^[a-f0-9]{${size * 2}}$`, 'u').test(text.trim())) return undefined
  return Uint8Array.from(text.trim().match(/../gu)!, byte => Number.parseInt(byte, 16))
}
/** The path of an absolute URL without a query or fragment, or undefined. The ES library has no URL parser. */
export function pathOf(url: string): string | undefined {
  return /^https:\/\/[a-z0-9.-]{1,253}(?::[0-9]{1,5})?(\/[^?#]*)$/u.exec(url)?.[1]
}
/**
 * The relay's first three seconds of node-to-client output, as the self-hosted relay pads them: on a 40 ms grid, queued
 * messages go out together with one PAD that fills the batch to a 4 KiB bucket. Afterwards messages go out directly.
 */
class OuterPadding {
  private readonly queue: Uint8Array[] = []
  private queuedBytes = 0
  private readonly started: number
  private timer: unknown
  stopped = false
  private readonly platform: EdgePlatform
  private readonly write: (payload: Uint8Array, reserved: boolean) => void
  private readonly fail: () => void
  paddingBytes = 0
  constructor(platform: EdgePlatform, write: (payload: Uint8Array, reserved: boolean) => void, fail: () => void) {
    this.platform = platform
    this.write = write
    this.fail = fail
    this.started = platform.now()
    this.timer = platform.setInterval(() => this.tick(), OUTER_PADDING.tickMs)
  }
  /** The bounds of the self-hosted relay's cover (link-client relay-outer-padding.ts): past them the socket closes. */
  send(payload: Uint8Array): void {
    if (this.stopped) {
      this.write(payload, false)
      return
    }
    const bytes = frameBytes(payload.length, false)
    if (
      bytes > OUTER_PADDING.maximumTickBytes - 16
      || this.queuedBytes + bytes > OUTER_PADDING.maximumQueueBytes
      || this.queue.length >= 256
    ) {
      this.stop(false)
      this.fail()
      return
    }
    this.queuedBytes += bytes
    this.queue.push(payload)
  }
  private tick(): void {
    if (this.stopped) return
    if (this.platform.now() - this.started > OUTER_PADDING.durationMs) {
      this.stop()
      return
    }
    let size = 0
    const chosen: Uint8Array[] = []
    while (chosen.length < OUTER_PADDING.maximumFramesPerTick && this.queue.length) {
      const next = frameBytes(this.queue[0]!.length, false)
      if (size + next > OUTER_PADDING.maximumTickBytes - 16) break
      chosen.push(this.queue.shift()!)
      size += next
      this.queuedBytes -= next
    }
    for (const payload of chosen) this.write(payload, true)
    let target = Math.max(OUTER_PADDING.bucketBytes, Math.ceil((size + 3) / OUTER_PADDING.bucketBytes) * OUTER_PADDING.bucketBytes)
    for (;;) {
      const room = target - size
      const payload = room - (room - 2 <= 125 ? 2 : 4)
      if (payload >= 1 && payload - 1 <= 16_384 && frameBytes(payload, false) === room) {
        const pad = encodeMessage({ type: 'pad', data: this.platform.random(payload - 1) }, 2)
        this.write(pad, false)
        this.paddingBytes += room
        return
      }
      target += OUTER_PADDING.bucketBytes
      if (target > OUTER_PADDING.maximumTickBytes) return
    }
  }
  stop(flush = true): void {
    if (this.stopped) return
    this.stopped = true
    this.platform.clearInterval(this.timer)
    const queued = this.queue.splice(0)
    this.queuedBytes = 0
    if (flush) for (const payload of queued) this.write(payload, true)
  }
}

interface Socket {
  peer: RelayPeer
  role: Role
  ws: EdgeWebSocket
  opened: number
  lastSeen: number
  lastPing: number
  closed: boolean
  queue: Promise<void>
  queuedBytes: number
  spliced: boolean
  /** The node sent REGISTERED, ADMITTED or ATTACHED: the protocol's own checks have passed. */
  authenticated: boolean
  preauth: number
  /** The node asked this socket for registration work, so one REGISTRATION-PROOF is expected. */
  workAsked: boolean
  pads: number
  outer?: OuterPadding
}

/**
 * One relay node: a Durable Object that never hibernates and runs the shared relay core over WebSockets. Routes, route
 * tokens, pending joins and replay records stay in memory only; DENY tags are in SQLite storage. There is no spend limit:
 * the operator's billing alert at the provider is the ceiling. Nothing here logs, and no client address reaches it: the
 * Worker passes only the /24 or /48 prefix that the per-prefix connection limit uses.
 */
export class EdgeNode {
  private readonly platform: EdgePlatform
  private readonly sockets = new Map<number, Socket>()
  private readonly byRuntime = new Map<EdgeWebSocket, Socket>()
  private readonly buffers: EdgeBuffers
  private readonly configured: boolean
  /** When this object started: a reset (deploy, runtime update, memory limit) shows as a new value in /admin/status. */
  private readonly startedAt: number
  private core?: RelayCore
  private denials?: EdgeDenials
  private sequence = 0
  private working = 0
  private alarmArmed = false
  private sweeper: unknown
  private readonly limits: EdgeLimits
  private readonly crypto: LinkCrypto
  private readonly state: EdgeState
  private readonly env: EdgeEnv
  traffic = { messagesIn: 0, bytesIn: 0, bytesOut: 0 }
  constructor(state: EdgeState, env: EdgeEnv, platform: EdgePlatform) {
    this.state = state
    this.env = env
    this.platform = platform
    this.crypto = webLinkCrypto(platform.subtle, platform.random)
    let parsed: EdgeLimits | undefined
    try {
      parsed = limits(env.LIMITS)
    } catch {
      parsed = undefined
    }
    this.limits = parsed ?? DEFAULT_LIMITS
    this.startedAt = platform.now()
    this.buffers = new EdgeBuffers(() => platform.now(), {
      maxBacklogBytes: this.limits.maxBacklogBytes,
      maxConnections: this.limits.maxConnections,
      // Open and held slots together: the same number the core applies to open sockets of one prefix.
      maxPerPrefix: this.limits.maxPerPrefix,
    })
    const relayId = hexBytes(env.RELAY_ID, 16),
      seed = hexBytes(env.RELAY_SIGNING_SEED, 32)
    const token = env.REGISTRATION_TOKEN ? hexBytes(env.REGISTRATION_TOKEN, 32) : undefined
    const open = env.OPEN_REGISTRATION === 'true'
    this.configured = Boolean(relayId && seed && parsed && (token ? !open : open && !env.REGISTRATION_TOKEN))
    void state.blockConcurrencyWhile(async () => {
      try {
        this.denials = new EdgeDenials(state.storage.sql)
      } catch {
        this.denials = undefined
      }
      if (this.configured && relayId && seed && this.denials) {
        this.core = new RelayCore({
          crypto: this.crypto,
          relayId,
          edgeIdentity: { seed },
          ...(token ? { registrationToken: token } : { openRegistration: true }),
          now: () => platform.now(),
          maxConnections: this.limits.maxConnections,
          maxRoutes: this.limits.maxRoutes,
          maxPerPrefix: this.limits.maxPerPrefix,
          maxRoutesPerPrefix: this.limits.maxRoutesPerPrefix,
          maxPreauthConnections: this.limits.maxPreauthConnections,
          maxDenialTags: 16_384,
          denials: this.denials,
          registrationWork: {
            softRoutesPerPrefix: this.limits.softRoutesPerPrefix,
            minBits: this.limits.minBits,
            maxBits: this.limits.maxBits,
            maxConcurrent: this.limits.maxConcurrent,
            verify: request => this.verifyWork(request),
          },
        })
      }
    })
    this.sweeper = platform.setInterval(() => this.sweep(), 1000)
  }
  ready(): boolean {
    return Boolean(this.core) && !this.core!.status().draining
  }
  async fetch(request: EdgeRequest): Promise<EdgeResponse> {
    const path = pathOf(request.url)
    const json = (value: unknown, status = 200) =>
      this.platform.respond(status, JSON.stringify(value), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    if (path === '/status' && request.method === 'GET') return json(this.status())
    if (path === '/drain' && request.method === 'POST') {
      this.core?.drain()
      return json({ draining: true })
    }
    if (path !== '/ws' || request.method !== 'GET') return this.platform.respond(404)
    const role = request.headers.get('x-latch-role'),
      prefix = request.headers.get('x-latch-prefix') ?? ''
    if ((role !== 'host' && role !== 'data' && role !== 'client') || !/^[0-9a-f.:]{1,40}\/(24|48)$/u.test(prefix))
      return this.platform.respond(400)
    if (!this.core) return this.platform.respond(503)
    return this.accept(this.core, role, prefix)
  }
  private accept(core: RelayCore, role: Role, prefix: string): EdgeResponse {
    const now = this.platform.now()
    const [client, ws] = this.platform.pair()
    // A full object makes room by closing the oldest unauthenticated socket of the prefix holding the most, as the core
    // does; a newcomer is refused only when its own prefix already holds its share.
    const admission = this.buffers.accept(ws, prefix, role !== 'host')
    for (const evicted of admission.evict) {
      const holder = this.byRuntime.get(evicted)
      if (holder) this.close(holder, 4302)
    }
    if (!admission.accepted) return this.platform.respond(503)
    try {
      ws.binaryType = 'arraybuffer'
      ws.accept()
    } catch {
      this.buffers.close(ws)
      return this.platform.respond(503)
    }
    const id = ++this.sequence
    const socket: Socket = {
      role,
      ws,
      opened: now,
      lastSeen: now,
      lastPing: Number.NEGATIVE_INFINITY,
      closed: false,
      queue: Promise.resolve(),
      queuedBytes: 0,
      spliced: false,
      authenticated: false,
      preauth: 0,
      workAsked: false,
      pads: 0,
      peer: {
        id,
        prefix,
        profile: 'outer-pad-v2',
        send: async message => this.send(socket, message),
        close: code => this.close(socket, code),
        // The cover runs its full three seconds through the inner handshake, as on the self-hosted relay.
        markSpliced: () => {
          socket.spliced = true
        },
      },
    }
    if (role !== 'host')
      socket.outer = new OuterPadding(
        this.platform,
        (payload, queued) => this.write(socket, payload, queued),
        () => this.close(socket, 4302),
      )
    this.sockets.set(id, socket)
    this.byRuntime.set(ws, socket)
    this.armAlarm()
    ws.addEventListener('message', event => this.receive(core, socket, event.data))
    ws.addEventListener('close', () => this.disconnect(socket))
    ws.addEventListener('error', () => this.close(socket, 1001))
    if (role === 'client' && this.pairs() >= this.limits.maxPairs) this.close(socket, 4302)
    else core.connect(socket.peer, role)
    return this.platform.upgrade(client, EDGE_PROTOCOL)
  }
  /** One pending alarm while anything is connected; an idle or orphaned object is not kept awake by its own alarm. */
  private armAlarm(): void {
    if (this.alarmArmed) return
    this.alarmArmed = true
    void this.state.storage.setAlarm(this.platform.now() + ALARM_MS).catch(() => {
      this.alarmArmed = false
    })
  }
  private pairs(): number {
    let spliced = 0
    for (const socket of this.sockets.values()) if (!socket.closed && socket.spliced && socket.role === 'client') spliced++
    return spliced
  }
  /** `queued`: the message held a cover-queue reservation, released as it goes to the runtime. */
  private write(socket: Socket, payload: Uint8Array, queued = false): void {
    if (socket.closed) return
    const result = this.buffers.write(socket.ws, payload, { queued })
    if (result === 'written' || result === 'backlog') this.traffic.bytesOut += frameBytes(payload.length, false)
    if (result !== 'written') this.close(socket, 4302)
  }
  private send(socket: Socket, message: RelayMessage): Promise<void> {
    if (socket.closed) return Promise.reject(new Error('Relay socket closed'))
    if (message.type === 'registered' || message.type === 'admitted' || message.type === 'attached') {
      socket.authenticated = true
      this.buffers.authenticate(socket.ws)
    }
    if (message.type === 'registration-work') socket.workAsked = true
    const payload = encodeMessage(message, 2)
    if (socket.outer && !socket.outer.stopped) {
      if (!this.buffers.queue(socket.ws, payload.length)) {
        this.close(socket, 4302)
        return Promise.reject(new Error('Relay output unavailable'))
      }
      socket.outer.send(payload)
    } else this.write(socket, payload)
    return socket.closed ? Promise.reject(new Error('Relay output unavailable')) : Promise.resolve()
  }
  private receive(core: RelayCore, socket: Socket, data: unknown): void {
    if (socket.closed) return
    const now = this.platform.now()
    if (!(data instanceof ArrayBuffer) || data.byteLength > MAX_MESSAGE) {
      this.close(socket, 4400)
      return
    }
    socket.lastSeen = now
    this.traffic.messagesIn++
    this.traffic.bytesIn += frameBytes(data.byteLength, true)
    let message: RelayMessage
    try {
      message = decodeMessage(new Uint8Array(data), 2)
    } catch {
      this.close(socket, 4400)
      return
    }
    if (message.type === 'ping') {
      if (now - socket.lastPing < PING_MIN_MS) {
        this.close(socket, 4400)
        return
      }
      socket.lastPing = now
      void this.send(socket, { type: 'pong' }).catch(() => {})
      return
    }
    if (message.type === 'pad') {
      // Only a client's or DATA leg's three-second outer cover sends PAD to the node.
      if (socket.role === 'host' || now - socket.opened > COVER_MS || ++socket.pads > COVER_PADS) this.close(socket, 4400)
      return
    }
    const expectedProof = message.type === 'registration-proof' && socket.workAsked
    if (expectedProof) socket.workAsked = false
    if (!socket.authenticated && !expectedProof && ++socket.preauth > PREAUTH_MESSAGES) {
      this.close(socket, 4400)
      return
    }
    if (socket.queuedBytes + data.byteLength > this.limits.maxQueuedBytes || !this.buffers.receive(socket.ws, data.byteLength)) {
      this.close(socket, 4302)
      return
    }
    // Messages of one socket reach the core in order, one at a time, as the self-hosted relay's receive loop does.
    socket.queuedBytes += data.byteLength
    socket.queue = socket.queue
      .then(() => (socket.closed ? undefined : core.receive(socket.peer.id, message)))
      .catch(() => this.close(socket, 4400))
      .finally(() => {
        socket.queuedBytes -= data.byteLength
        this.buffers.received(socket.ws, data.byteLength)
      })
  }
  private close(socket: Socket, code: number): void {
    if (socket.closed) return
    this.disconnect(socket)
    try {
      socket.ws.close(code, '')
    } catch {
      /* Already closed by the peer or the runtime. */
    }
  }
  private disconnect(socket: Socket): void {
    if (socket.closed) return
    socket.closed = true
    socket.outer?.stop(false)
    this.sockets.delete(socket.peer.id)
    this.byRuntime.delete(socket.ws)
    this.buffers.close(socket.ws)
    this.core?.disconnect(socket.peer.id)
  }
  private sweep(): void {
    const core = this.core
    if (!core) return
    const now = this.platform.now()
    core.sweep()
    const overloaded = new Set(this.buffers.overloaded())
    for (const socket of [...this.sockets.values()]) {
      if (overloaded.has(socket.ws)) this.close(socket, 4302)
      else if (now - socket.lastSeen > EDGE_RELAY.nodeDeadAfterMs) this.close(socket, 1001)
    }
  }
  /** The alarm: drop expired denials. Re-arms itself only while sockets are connected. */
  async alarm(): Promise<void> {
    const now = this.platform.now()
    try {
      this.denials?.sweep(Math.floor(now / 1000 / UTC_DAY))
    } catch {
      /* Expired rows are only wasted space; the core never admits with a stale pass. */
    }
    this.sweep()
    this.alarmArmed = false
    if (this.sockets.size) this.armAlarm()
  }
  /** Runs off this object's thread, in the stateless work Worker; bounded here like the self-hosted pool. */
  private async verifyWork(request: RegistrationWorkInput): Promise<RegistrationWorkResult> {
    const service = this.env.WORK
    if (!service || request.input.length < 16 || request.input.length > 512 || request.salt.length !== 32) return false
    if (this.working >= this.limits.maxConcurrent) return 'overloaded'
    this.working++
    let timer: unknown
    // The slot is held until the work Worker answers, also after the 2 s timeout, as the self-hosted pool does.
    const call = service
      .fetch('https://work/verify', { method: 'POST', body: encodeWorkRequest(request) })
      .then(async response => response.status === 200 && new Uint8Array(await response.arrayBuffer())[0] === 1)
      .catch(() => false)
      .finally(() => {
        this.working--
      })
    try {
      const timeout = new Promise<'timeout'>(resolve => {
        timer = this.platform.setTimeout(() => resolve('timeout'), 2000)
      })
      return await Promise.race([call, timeout])
    } finally {
      this.platform.clearTimeout(timer)
    }
  }
  status(): Record<string, unknown> {
    return {
      ready: this.ready(),
      configured: this.configured,
      startedAt: this.startedAt,
      ...(this.core ? this.core.status() : {}),
      sockets: this.sockets.size,
      pairs: this.pairs(),
      buffered: this.buffers.status(),
      traffic: { ...this.traffic },
    }
  }
  /** Stops the sweep timer; only tests call it, the runtime discards the object instead. */
  dispose(): void {
    this.platform.clearInterval(this.sweeper)
  }
}
