import { constants, createHash, randomBytes, X509Certificate } from 'node:crypto'
import { request } from 'node:https'
import type { Duplex } from 'node:stream'
import { checkServerIdentity, connect as tlsConnect } from 'node:tls'
import { isIP, type LookupFunction } from 'node:net'
import {
  decodeMessage,
  EDGE_RELAY,
  encodeFrame,
  encodeMessage,
  equal,
  relayWireVersion,
  WebSocketParser,
  type RelayMessage,
  type RelayTransportProfile,
  type RelayWireVersion,
} from '@latch/link-wire'
import { RelayOuterPadding } from './relay-outer-padding.ts'

export class RelayClosed extends Error {
  readonly closeCode: number
  constructor(code: number) {
    super('Relay transport closed')
    this.closeCode = code
  }
}

interface RelaySocketPolicy {
  version?: RelayWireVersion
  outerPadding?: boolean
  permitted?(): boolean
  beforeReceive?(bytes: number): Promise<boolean>
  beforeWrite?(bytes: number): Promise<boolean>
  sendHighWaterMark?(): number
  receiveHighWaterMark?(): number
  sendTimeoutMs?: number
  pingIntervalMs?: number
  deadAfterMs?: number
  /**
   * Edge kind: the edge, not the node, answers WebSocket pings. Keep-alive is then an application PING the node answers
   * with PONG, and only relay messages count as signs of life.
   */
  applicationPing?: boolean
}
export class RelaySocket {
  readonly closed: Promise<void>
  private readonly stream: Duplex
  private readonly outgoingMask: boolean
  private readonly parser: WebSocketParser
  private readonly queue: RelayMessage[] = []
  private waiter?: { resolve(value: RelayMessage): void; reject(error: Error): void }
  private failure?: Error
  private bytes = 0
  private readonly heartbeat: ReturnType<typeof setInterval>
  private lastSeen = Date.now()
  private readonly policy: RelaySocketPolicy
  private sends: Promise<void> = Promise.resolve()
  private queuedSendBytes = 0
  private writtenBytes = 0
  private readonly actualWrites = new Set<Promise<void>>()
  private actualWriteBytes = 0
  private readWireBytes = 0
  private readPaddingBytes = 0
  private readonly outer?: RelayOuterPadding
  private readonly receivedBytes = new WeakMap<RelayMessage, number>()
  private receiving = false
  private validWrite: () => boolean = () => true
  constructor(stream: Duplex, client: boolean, head?: Uint8Array, policy: RelaySocketPolicy = {}) {
    this.stream = stream
    this.closed = new Promise(resolve => {
      const settled = () => {
        void Promise.all([this.sends.catch(() => {}), this.outer?.settled()]).then(async () => {
          while (this.actualWrites.size) await Promise.all([...this.actualWrites])
          resolve()
        })
      }
      if (stream.closed) settled()
      else stream.once('close', settled)
    })
    this.policy = policy
    this.outgoingMask = client
    this.parser = new WebSocketParser(!client)
    if (policy.outerPadding) {
      if (policy.version !== 2) throw new RangeError('Outer padding requires relay v2')
      this.outer = new RelayOuterPadding({
        client,
        write: bytes => this.writeFrame(bytes),
        valid: () => this.canWrite(),
        fail: () => this.close(4302),
        maximumTickBytes: () => this.policy.sendHighWaterMark?.() ?? 32_768,
      })
    }
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeen > (policy.deadAfterMs ?? 60_000)) {
        this.close(1001)
        return
      }
      if (policy.applicationPing && !client) return
      void (
        policy.applicationPing
          ? this.send({ type: 'ping' })
          : this.writeFrame(encodeFrame({ opcode: 9, payload: new Uint8Array() }, client ? randomBytes(4) : undefined))
      ).catch(() => this.close(4302))
    }, policy.pingIntervalMs ?? 20_000)
    this.heartbeat.unref()
    stream.on('data', (chunk: Buffer) => this.feed(chunk))
    stream.on('error', () => this.finish(new Error('Relay transport failed')))
    stream.on('close', () => this.finish(new Error('Relay transport closed')))
    if (head?.length) this.feed(head)
  }
  private feed(chunk: Uint8Array): void {
    try {
      if (this.policy.permitted?.() === false) throw new Error('Relay egress unavailable')
      for (const frame of this.parser.feed(chunk)) {
        const frameBytes =
          frame.payload.length + (frame.payload.length <= 125 ? 2 : frame.payload.length <= 65535 ? 4 : 10) + (this.outgoingMask ? 0 : 4)
        this.readWireBytes += frameBytes
        if (!this.policy.applicationPing || frame.opcode === 2 || frame.opcode === 8) this.lastSeen = Date.now()
        if (frame.opcode === 8) {
          if (frame.payload.length === 1) throw new Error('Invalid relay close')
          const code = frame.payload.length ? frame.payload[0]! * 256 + frame.payload[1]! : 1000
          if (!([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code) || (code >= 3000 && code <= 4999)))
            throw new Error('Invalid relay close code')
          new TextDecoder('utf-8', { fatal: true }).decode(frame.payload.slice(2))
          this.close(code)
          return
        }
        if (frame.opcode === 9) {
          void this.writeFrame(encodeFrame({ opcode: 10, payload: frame.payload }, this.outgoingMask ? randomBytes(4) : undefined)).catch(
            () => this.close(4302),
          )
          continue
        }
        if (frame.opcode === 10) continue
        const message = decodeMessage(frame.payload, this.policy.version)
        this.receivedBytes.set(message, frameBytes)
        if (message.type === 'pad') this.readPaddingBytes += frameBytes
        if (message.type === 'pad' && this.outgoingMask && !this.policy.beforeReceive) continue
        if (message.type === 'pong' && this.policy.applicationPing && this.outgoingMask) continue
        if (this.waiter) {
          const waiter = this.waiter
          this.waiter = undefined
          waiter.resolve(message)
        } else {
          this.bytes += frame.payload.length
          if (this.queue.length >= 8 || this.bytes > 131_072) throw new RangeError('Relay receive limit')
          this.queue.push(message)
          if (this.queue.length >= 4 || this.bytes >= (this.policy.receiveHighWaterMark?.() ?? 131_072)) this.stream.pause()
        }
      }
    } catch {
      this.close(4400)
    }
  }
  async receive(timeoutMs = 30_000): Promise<RelayMessage> {
    if (this.receiving) throw new Error('Relay receive already pending')
    this.receiving = true
    const deadline = timeoutMs > 0 ? performance.now() + timeoutMs : Infinity
    try {
      for (;;) {
        const remaining = deadline - performance.now()
        if (remaining <= 0) {
          this.close(4102)
          throw new Error('Relay receive timed out')
        }
        const message = await this.nextMessage(Number.isFinite(remaining) ? remaining : 0)
        if (this.policy.beforeReceive && !(await this.policy.beforeReceive(this.receivedBytes.get(message)!))) {
          this.close(4302)
          throw new Error('Relay traffic unavailable')
        }
        if (this.policy.permitted?.() === false) {
          this.close(4302)
          throw new Error('Relay egress unavailable')
        }
        if (message.type === 'pad' && this.outgoingMask) continue
        return message
      }
    } finally {
      this.receiving = false
    }
  }
  private async nextMessage(timeoutMs: number): Promise<RelayMessage> {
    if (this.waiter) throw new Error('Relay receive already pending')
    const message = this.queue.shift()
    if (message) {
      this.bytes -= encodeMessage(message, this.policy.version).length
      if (this.queue.length <= 2 && this.bytes < (this.policy.receiveHighWaterMark?.() ?? 131_072)) this.stream.resume()
      return message
    }
    if (this.failure) throw this.failure
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.waiter = undefined
              this.close(4102)
              reject(new Error('Relay receive timed out'))
            }, timeoutMs)
          : undefined
      timer?.unref()
      this.waiter = {
        resolve(value) {
          clearTimeout(timer)
          resolve(value)
        },
        reject(error) {
          clearTimeout(timer)
          reject(error)
        },
      }
    })
  }
  async send(message: RelayMessage): Promise<void> {
    if (this.outer && message.type === 'data' && message.data.length > 12_000) {
      if (message.data.length > 16_384) throw new RangeError('DATA too large')
      await Promise.all([
        this.send({ type: 'data', data: message.data.slice(0, 12_000) }),
        this.send({ type: 'data', data: message.data.slice(12_000) }),
      ])
      return
    }
    const frame = encodeFrame(
      { opcode: 2, payload: encodeMessage(message, this.policy.version) },
      this.outgoingMask ? randomBytes(4) : undefined,
    )
    await (this.outer ? this.outer.write(frame) : this.writeFrame(frame))
  }
  private writeFrame(frame: Uint8Array): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    const limit = this.policy.sendHighWaterMark?.() ?? 131_072
    if (this.queuedSendBytes + frame.length > limit + 32 || this.stream.writableLength > limit) {
      this.close(4302)
      return Promise.reject(new Error('Relay send limit'))
    }
    this.queuedSendBytes += frame.length
    const work = this.sends
      .then(async () => {
        if (this.failure || !this.canWrite()) {
          this.close(4302)
          throw this.failure ?? new Error('Relay write unavailable')
        }
        if (this.policy.beforeWrite && !(await this.policy.beforeWrite(frame.length))) {
          this.close(4302)
          throw new Error('Relay traffic unavailable')
        }
        if (this.failure || !this.canWrite()) {
          this.close(4302)
          throw this.failure ?? new Error('Relay write unavailable')
        }
        await new Promise<void>((resolve, reject) => {
          let completed!: () => void
          const actual = new Promise<void>(done => {
            completed = done
          })
          this.actualWrites.add(actual)
          this.actualWriteBytes += frame.length
          void actual.then(() => {
            this.actualWrites.delete(actual)
            this.actualWriteBytes -= frame.length
          })
          const timer = setTimeout(() => {
            this.close(4302)
            reject(new Error('Relay send stalled'))
          }, this.policy.sendTimeoutMs ?? 3000)
          this.stream.write(frame, error => {
            clearTimeout(timer)
            completed()
            if (error) reject(new Error('Relay send failed'))
            else {
              this.writtenBytes += frame.length
              resolve()
            }
          })
        })
      })
      .finally(() => {
        this.queuedSendBytes -= frame.length
      })
    this.sends = work.catch(() => {})
    return work
  }
  metrics(): {
    bufferedBytes: number
    pendingWriteBytes: number
    writtenBytes: number
    readWireBytes: number
    readPaddingBytes: number
    paddingWrittenBytes: number
    coverBatches: number
  } {
    const outer = this.outer?.statistics()
    const pending = Math.max(this.queuedSendBytes, this.actualWriteBytes)
    return {
      bufferedBytes: this.bytes + pending + (this.outer?.bufferedBytes() ?? 0) + this.stream.writableLength,
      pendingWriteBytes: pending + (this.outer?.bufferedBytes() ?? 0),
      writtenBytes: this.writtenBytes,
      readWireBytes: this.readWireBytes,
      readPaddingBytes: this.readPaddingBytes,
      paddingWrittenBytes: outer?.paddingBytes ?? 0,
      coverBatches: outer?.batches ?? 0,
    }
  }
  /** Only the authenticated attach transition may relinquish relay-level idle checks. */
  markSpliced(): void {
    clearInterval(this.heartbeat)
  }
  guardWrites(valid: () => boolean): void {
    this.validWrite = valid
  }
  private canWrite(): boolean {
    return this.policy.permitted?.() !== false && this.validWrite()
  }
  private finish(error: Error): void {
    if (this.failure) return
    this.failure = error
    clearInterval(this.heartbeat)
    this.outer?.close()
    this.waiter?.reject(error)
    this.waiter = undefined
    this.queue.length = 0
    this.bytes = 0
  }
  close(code = 1000): void {
    if (this.failure) return
    this.finish(new RelayClosed(code))
    if (this.policy.permitted?.() === false) {
      this.stream.destroy()
      return
    }
    const payload = new Uint8Array([code >> 8, code & 255])
    this.stream.end(encodeFrame({ opcode: 8, payload }, this.outgoingMask ? randomBytes(4) : undefined))
    const timer = setTimeout(() => this.stream.destroy(), 1000)
    timer.unref()
    this.stream.once('close', () => clearTimeout(timer))
  }
}

export function acceptKey(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
}

export interface RelayDialLease {
  readonly origin: string
  readonly address: string
  readonly revoked: AbortSignal
  permitted(): boolean
  release(): void
}

/**
 * Bounded cache of verified self-signed PEM anchors indexed by their pinned 256-bit SPKI SHA-256 hex.
 * Used only for `self` relays (`spki` pinned, `edge` absent) so subsequent connections establish in 1 RTT
 * while OpenSSL (`rejectUnauthorized: true`) still enforces full X.509 signature, SAN and validity checks.
 */
const pinnedSelfSignedAnchors = new Map<string, string>()

function probePinnedSelfSignedAnchor(options: {
  url: URL
  hostname: string
  spki: Uint8Array
  lookup?: LookupFunction
  signal?: AbortSignal
  timeoutMs: number
  permitted(): boolean
  lease?: RelayDialLease
}): Promise<string> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted()
    if (!options.permitted()) {
      reject(new Error('Relay egress unavailable'))
      return
    }
    const port = Number(options.url.port || 443)
    const socket = tlsConnect({
      host: options.hostname,
      port,
      ...(options.lookup ? { lookup: options.lookup } : {}),
      ...(isIP(options.hostname) ? {} : { servername: options.hostname }),
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      ALPNProtocols: ['http/1.1'],
      secureOptions: constants.SSL_OP_NO_TICKET,
      // Zero-payload certificate fetch only; socket is destroyed immediately before any HTTP/WebSocket bytes flow.
      rejectUnauthorized: false,
    })
    const cleanupAbort = () => socket.destroy(new Error('Relay upgrade cancelled'))
    options.signal?.addEventListener('abort', cleanupAbort, { once: true })
    options.lease?.revoked.addEventListener('abort', cleanupAbort, { once: true })
    const timer = setTimeout(() => socket.destroy(new Error('Relay upgrade timed out')), options.timeoutMs)
    timer.unref()
    const finish = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cleanupAbort)
      options.lease?.revoked.removeEventListener('abort', cleanupAbort)
    }
    socket.once('error', error => {
      finish()
      reject(error)
    })
    socket.once('secureConnect', () => {
      try {
        if (options.signal?.aborted || !options.permitted()) throw new Error('Relay egress unavailable')
        const peer = socket.getPeerCertificate(true)
        socket.destroy()
        finish()
        if (!peer?.raw || peer.raw.length === 0 || peer.raw.length > 16_384) throw new Error('Relay certificate identity mismatch')
        const cert = new X509Certificate(peer.raw)
        const spki = cert.publicKey.export({ type: 'spki', format: 'der' })
        if (!equal(createHash('sha256').update(spki).digest(), options.spki)) throw new Error('Relay certificate identity mismatch')
        if (!cert.verify(cert.publicKey)) throw new Error('Relay certificate identity mismatch')
        const idFailure = checkServerIdentity(options.hostname, peer)
        if (idFailure) throw idFailure
        const now = Date.now()
        if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) throw new Error('Relay certificate expired')
        resolve(cert.toString())
      } catch (error) {
        socket.destroy()
        finish()
        reject(error instanceof Error ? error : new Error('Relay certificate identity mismatch'))
      }
    })
  })
}

/**
 * A self-hosted node is reached on `/v1/{h,d,c}` with its TLS key pinned. An edge node is reached on
 * `/v1/{h,d,c}/<shard>` with ordinary WebPKI TLS; its identity is the relay-key signature checked after the upgrade.
 */
export async function connectRelay(options: {
  url: URL
  spki?: Uint8Array
  edge?: { relayKey: Uint8Array; shard: number }
  ca?: string | Buffer
  timeoutMs?: number
  signal?: AbortSignal
  address?: string
  lease?: RelayDialLease
  profile?: RelayTransportProfile
}): Promise<RelaySocket> {
  const { url, lease } = options
  const permitted = () => lease === undefined || (!lease.revoked.aborted && lease.permitted())
  const signal = lease ? (options.signal ? AbortSignal.any([options.signal, lease.revoked]) : lease.revoked) : options.signal
  if ((lease && lease.origin !== url.origin) || !permitted()) throw new Error('Relay egress unavailable')
  signal?.throwIfAborted()
  const version = relayWireVersion(options.profile),
    protocol = `latch-relay.${version}`
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || (options.edge
      ? !/^\/v1\/[hdc]\/([0-9]|1[0-5])$/u.test(url.pathname) || version !== 2
      : !['/v1/h', '/v1/d', '/v1/c'].includes(url.pathname) || options.spki?.length !== 32)
  )
    throw new RangeError('Invalid relay endpoint')
  const address = lease?.address ?? options.address
  if (address !== undefined && !isIP(address)) throw new RangeError('Invalid relay dial address')
  const hostname = url.hostname.replace(/^\[|\]$/gu, '')
  if (lease && isIP(hostname) && hostname !== address) throw new RangeError('Invalid relay dial address')
  const lookup: LookupFunction | undefined = address
    ? (_hostname, lookupOptions, callback) => {
        const family = isIP(address)
        if (typeof lookupOptions === 'object' && lookupOptions.all) callback(null, [{ address, family }])
        else callback(null, address, family)
      }
    : undefined
  const deadline = performance.now() + (options.timeoutMs ?? 5000)
  const remainingMs = () => {
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining <= 0) throw new Error('Relay upgrade timed out')
    return remaining
  }
  const dialOnce = (ca?: string | Buffer): Promise<RelaySocket> =>
    new Promise((resolve, reject) => {
      const timeoutMs = remainingMs()
      const key = randomBytes(16).toString('base64')
      const req = request(url, {
        agent: false,
        signal,
        ca,
        ...(lookup ? { lookup } : {}),
        servername: isIP(hostname) ? undefined : hostname,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        ...{ ALPNProtocols: ['http/1.1'] },
        checkServerIdentity(peerHost, certificate) {
          const failure = checkServerIdentity(peerHost, certificate)
          if (failure) return failure
          if (options.edge) return undefined
          const spki = new X509Certificate(certificate.raw).publicKey.export({ type: 'spki', format: 'der' })
          if (!equal(createHash('sha256').update(spki).digest(), options.spki!)) return new Error('Relay certificate identity mismatch')
          return undefined
        },
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Protocol': protocol,
        },
      })
      const timer = setTimeout(() => req.destroy(new Error('Relay upgrade timed out')), timeoutMs)
      timer.unref()
      req.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      req.once('response', response => {
        clearTimeout(timer)
        response.destroy()
        reject(new Error('Relay upgrade rejected'))
      })
      req.once('upgrade', (response, socket, head) => {
        clearTimeout(timer)
        if (
          signal?.aborted
          || !permitted()
          || response.statusCode !== 101
          || response.headers['sec-websocket-accept'] !== acceptKey(key)
          || response.headers['sec-websocket-protocol'] !== protocol
          || response.headers['sec-websocket-extensions']
        ) {
          socket.destroy()
          reject(new Error('Invalid relay upgrade'))
          return
        }
        if (lease) {
          const revoke = () => socket.destroy()
          lease.revoked.addEventListener('abort', revoke, { once: true })
          socket.once('close', () => lease.revoked.removeEventListener('abort', revoke))
        }
        resolve(
          new RelaySocket(socket, true, head, {
            ...(lease ? { permitted } : {}),
            pingIntervalMs: options.edge ? EDGE_RELAY.pingIntervalMs : 25_000,
            deadAfterMs: options.edge ? EDGE_RELAY.clientDeadAfterMs : 60_000,
            applicationPing: Boolean(options.edge),
            version,
            outerPadding: version === 2 && !url.pathname.startsWith('/v1/h'),
          }),
        )
      })
      req.end()
    })

  const spkiKey = !options.edge && !options.ca && options.spki ? Buffer.from(options.spki).toString('hex') : undefined
  const rememberedAnchor = spkiKey ? pinnedSelfSignedAnchors.get(spkiKey) : undefined
  try {
    return await dialOnce(options.ca ?? rememberedAnchor)
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code
    const canProbeSelfSigned =
      spkiKey !== undefined
      && (code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
        || code === 'SELF_SIGNED_CERT_IN_CHAIN'
        || (rememberedAnchor !== undefined && code === 'CERT_HAS_EXPIRED'))
    if (!canProbeSelfSigned) throw error
    pinnedSelfSignedAnchors.delete(spkiKey)
    const verifiedAnchor = await probePinnedSelfSignedAnchor({
      url,
      hostname,
      spki: options.spki!,
      lookup,
      signal,
      timeoutMs: remainingMs(),
      permitted,
      lease,
    })
    if (pinnedSelfSignedAnchors.size >= 64 && !pinnedSelfSignedAnchors.has(spkiKey)) {
      pinnedSelfSignedAnchors.delete(pinnedSelfSignedAnchors.keys().next().value!)
    }
    pinnedSelfSignedAnchors.set(spkiKey, verifiedAnchor)
    return dialOnce(verifiedAnchor)
  }
}
