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
import { EdgeBudget, EdgeDenials } from './storage.ts'

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
  /** Received messages one socket may have queued before the node closes it: there is no send-side back-pressure. */
  maxQueuedMessages: number
  /**
   * Joined pairs one node object carries before it refuses new clients with 4302 (overload: "relay full"). Unmeasured;
   * kept low against the platform's documented soft limit of about 1,000 requests per second per object, where an idle
   * pair costs about 8 messages a second and a streaming one up to about 50.
   */
  maxPairs: number
  /**
   * The share of the daily message cap one address prefix may send, in percent, so that one Host or network cannot spend
   * the whole node's budget (an open relay admits anyone). Over it, that prefix's sockets close with 4304 until the
   * next UTC day.
   */
  prefixDailyPercent: number
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
  maxQueuedMessages: 64,
  maxPairs: 40,
  prefixDailyPercent: 25,
}
function limits(text: string | undefined): EdgeLimits {
  if (!text) return DEFAULT_LIMITS
  const parsed = JSON.parse(text) as Record<string, unknown>
  const out = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in out) || !Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError('Invalid relay limits')
    out[key as keyof EdgeLimits] = value as number
  }
  if (
    out.prefixDailyPercent < 1
    || out.prefixDailyPercent > 100
    || out.minBits > out.maxBits
    || out.maxBits > REGISTRATION_WORK.maxBits
    || out.softRoutesPerPrefix >= out.maxRoutesPerPrefix
  )
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
function positive(text: string | undefined): number | undefined {
  const value = Number(text)
  return text && /^[0-9]{1,15}$/u.test(text) && value > 0 ? value : undefined
}

/**
 * The relay's first three seconds of node-to-client output, as the self-hosted relay pads them: on a 40 ms grid, queued
 * messages go out together with one PAD that fills the batch to a 4 KiB bucket. Afterwards messages go out directly.
 */
class OuterPadding {
  private readonly queue: Uint8Array[] = []
  private readonly started: number
  private timer: unknown
  private stopped = false
  private readonly platform: EdgePlatform
  private readonly write: (payload: Uint8Array) => void
  paddingBytes = 0
  constructor(platform: EdgePlatform, write: (payload: Uint8Array) => void) {
    this.platform = platform
    this.write = write
    this.started = platform.now()
    this.timer = platform.setInterval(() => this.tick(), OUTER_PADDING.tickMs)
  }
  send(payload: Uint8Array): void {
    if (this.stopped) {
      this.write(payload)
      return
    }
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
    }
    for (const payload of chosen) this.write(payload)
    let target = Math.max(OUTER_PADDING.bucketBytes, Math.ceil((size + 3) / OUTER_PADDING.bucketBytes) * OUTER_PADDING.bucketBytes)
    for (;;) {
      const room = target - size
      const payload = room - (room - 2 <= 125 ? 2 : 4)
      if (payload >= 1 && payload - 1 <= 16_384 && frameBytes(payload, false) === room) {
        const pad = encodeMessage({ type: 'pad', data: this.platform.random(payload - 1) }, 2)
        this.write(pad)
        this.paddingBytes += room
        return
      }
      target += OUTER_PADDING.bucketBytes
      if (target > OUTER_PADDING.maximumTickBytes) return
    }
  }
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.platform.clearInterval(this.timer)
    for (const payload of this.queue.splice(0)) this.write(payload)
  }
}

interface Socket {
  peer: RelayPeer
  role: Role
  ws: EdgeWebSocket
  lastSeen: number
  closed: boolean
  queue: Promise<void>
  queued: number
  spliced: boolean
  outer?: OuterPadding
}

/**
 * One relay node: a Durable Object that never hibernates and runs the shared relay core over WebSockets. Routes, route
 * tokens, pending joins and replay records stay in memory only; DENY tags and the spend counters are in SQLite storage.
 * Nothing here logs, and no client address reaches it: the Worker passes only the fairness prefix.
 */
export class EdgeNode {
  private readonly platform: EdgePlatform
  private readonly sockets = new Map<number, Socket>()
  private readonly configured: boolean
  private core?: RelayCore
  private budget?: EdgeBudget
  private denials?: EdgeDenials
  private sequence = 0
  private working = 0
  private overNotified = false
  private alarmArmed = false
  /** Messages received today per address prefix (memory only; a restart forgives, the node-wide counter does not). */
  private prefixDay = { day: -1, counts: new Map<string, number>() }
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
    const relayId = hexBytes(env.RELAY_ID, 16),
      seed = hexBytes(env.RELAY_SIGNING_SEED, 32)
    const token = env.REGISTRATION_TOKEN ? hexBytes(env.REGISTRATION_TOKEN, 32) : undefined
    const daily = positive(env.DAILY_MESSAGES),
      monthly = positive(env.MONTHLY_MESSAGES)
    const open = env.OPEN_REGISTRATION === 'true'
    this.configured = Boolean(relayId && seed && parsed && (token ? !open : open && !env.REGISTRATION_TOKEN))
    void state.blockConcurrencyWhile(async () => {
      const now = platform.now()
      this.budget = new EdgeBudget(state.storage.sql, daily && monthly ? { day: daily, month: monthly } : undefined)
      this.budget.load(now)
      try {
        this.denials = new EdgeDenials(state.storage.sql)
      } catch {
        this.denials = undefined
      }
      if (this.configured && relayId && seed && this.denials) {
        const denials = this.denials
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
          denials,
          serviceReady: () => !this.budget!.over(),
          canAdmit: () => !this.budget!.over(),
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
    return Boolean(this.core) && !this.core!.status().draining && !this.budget!.over()
  }
  async fetch(request: EdgeRequest): Promise<EdgeResponse> {
    const path = pathOf(request.url)
    const json = (value: unknown, status = 200) =>
      this.platform.respond(status, JSON.stringify(value), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    if (path === '/health') return this.platform.respond(this.ready() ? 200 : 503, 'ok\n', { 'Cache-Control': 'no-store' })
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
    const [client, ws] = this.platform.pair()
    ws.accept()
    const id = ++this.sequence
    const socket: Socket = {
      role,
      ws,
      lastSeen: this.platform.now(),
      closed: false,
      queue: Promise.resolve(),
      queued: 0,
      spliced: false,
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
    if (role !== 'host') socket.outer = new OuterPadding(this.platform, payload => this.write(socket, payload))
    this.sockets.set(id, socket)
    this.armAlarm()
    ws.addEventListener('message', event => this.receive(core, socket, event.data))
    ws.addEventListener('close', () => this.gone(core, socket))
    ws.addEventListener('error', () => this.gone(core, socket))
    // A spent budget refuses Hosts too, with the quota code: the core's own admission check covers only clients and data.
    if (role === 'host' && this.budget!.over()) this.close(socket, 4304)
    else if (role === 'client' && this.pairs() >= this.limits.maxPairs) this.close(socket, 4302)
    else core.connect(socket.peer, role)
    return this.platform.upgrade(client, EDGE_PROTOCOL)
  }
  private withinPrefixShare(prefix: string, now: number): boolean {
    const cap = this.budget!.snapshot().dailyCap
    if (cap === null) return false
    const day = Math.floor(now / 86_400_000)
    if (this.prefixDay.day !== day) this.prefixDay = { day, counts: new Map() }
    const count = (this.prefixDay.counts.get(prefix) ?? 0) + 1
    this.prefixDay.counts.set(prefix, count)
    return count <= Math.floor((cap * this.limits.prefixDailyPercent) / 100)
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
    for (const socket of this.sockets.values()) if (socket.spliced && socket.role === 'client') spliced++
    return spliced
  }
  private write(socket: Socket, payload: Uint8Array): void {
    if (socket.closed) return
    try {
      socket.ws.send(payload)
      this.traffic.bytesOut += frameBytes(payload.length, false)
    } catch {
      this.close(socket, 4302)
    }
  }
  private send(socket: Socket, message: RelayMessage): Promise<void> {
    if (socket.closed) return Promise.reject(new Error('Relay socket closed'))
    const payload = encodeMessage(message, 2)
    if (socket.outer) socket.outer.send(payload)
    else this.write(socket, payload)
    return Promise.resolve()
  }
  private receive(core: RelayCore, socket: Socket, data: unknown): void {
    if (socket.closed) return
    const now = this.platform.now()
    this.budget!.count(now)
    if (!this.withinPrefixShare(socket.peer.prefix, now)) {
      this.close(socket, 4304)
      return
    }
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
      void this.send(socket, { type: 'pong' }).catch(() => {})
      return
    }
    if (message.type === 'pad') return
    if (socket.queued >= this.limits.maxQueuedMessages) {
      this.close(socket, 4302)
      return
    }
    // Messages of one socket reach the core in order, one at a time, as the self-hosted relay's receive loop does.
    socket.queued++
    socket.queue = socket.queue
      .then(() => (socket.closed ? undefined : core.receive(socket.peer.id, message)))
      .catch(() => this.close(socket, 4400))
      .finally(() => {
        socket.queued--
      })
  }
  private close(socket: Socket, code: number): void {
    if (socket.closed) return
    socket.closed = true
    socket.outer?.stop()
    this.sockets.delete(socket.peer.id)
    this.core?.disconnect(socket.peer.id)
    try {
      socket.ws.close(code, '')
    } catch {
      /* Already closed by the peer or the runtime. */
    }
  }
  private gone(core: RelayCore, socket: Socket): void {
    if (!socket.closed) {
      socket.closed = true
      socket.outer?.stop()
      this.sockets.delete(socket.peer.id)
    }
    core.disconnect(socket.peer.id)
  }
  private sweep(): void {
    const core = this.core
    if (!core) return
    const now = this.platform.now()
    core.sweep()
    for (const socket of [...this.sockets.values()]) if (now - socket.lastSeen > EDGE_RELAY.nodeDeadAfterMs) this.close(socket, 1001)
    if (this.budget!.over()) {
      if (!this.overNotified) {
        this.overNotified = true
        core.notify(3, this.budget!.retryAfterMs(now))
        // Every socket goes, Host control sockets included: an open socket keeps the object, and the bill, running.
        for (const socket of [...this.sockets.values()]) this.close(socket, 4304)
      }
    } else this.overNotified = false
  }
  /** The alarm: roll the budget periods over and drop expired denials. Re-arms itself. */
  async alarm(): Promise<void> {
    const now = this.platform.now()
    this.budget?.roll(now)
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
    try {
      const timeout = new Promise<'timeout'>(resolve => {
        timer = this.platform.setTimeout(() => resolve('timeout'), 2000)
      })
      const call = service
        .fetch('https://work/verify', { method: 'POST', body: encodeWorkRequest(request) })
        .then(async response => response.status === 200 && new Uint8Array(await response.arrayBuffer())[0] === 1)
        .catch(() => false)
      return await Promise.race([call, timeout])
    } finally {
      this.platform.clearTimeout(timer)
      this.working--
    }
  }
  status(): Record<string, unknown> {
    return {
      ready: this.ready(),
      configured: this.configured,
      ...(this.core ? this.core.status() : {}),
      sockets: this.sockets.size,
      pairs: this.pairs(),
      budget: this.budget?.snapshot(),
      traffic: { ...this.traffic },
    }
  }
  /** Stops the sweep timer; only tests call it, the runtime discards the object instead. */
  dispose(): void {
    this.platform.clearInterval(this.sweeper)
  }
}
