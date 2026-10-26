import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { request } from 'node:https'
import type { Duplex } from 'node:stream'
import { checkServerIdentity } from 'node:tls'
import { isIP, type LookupFunction } from 'node:net'
import {
  decodeMessage,
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
  beforeReceive?(bytes: number): Promise<boolean>
  beforeWrite?(bytes: number): Promise<boolean>
  sendHighWaterMark?(): number
  receiveHighWaterMark?(): number
  sendTimeoutMs?: number
  pingIntervalMs?: number
  deadAfterMs?: number
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
        valid: () => this.validWrite(),
        fail: () => this.close(4302),
        maximumTickBytes: () => this.policy.sendHighWaterMark?.() ?? 32_768,
      })
    }
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeen > (policy.deadAfterMs ?? 60_000)) {
        this.close(1001)
        return
      }
      void this.writeFrame(encodeFrame({ opcode: 9, payload: new Uint8Array() }, client ? randomBytes(4) : undefined)).catch(() =>
        this.close(4302),
      )
    }, policy.pingIntervalMs ?? 20_000)
    this.heartbeat.unref()
    stream.on('data', (chunk: Buffer) => this.feed(chunk))
    stream.on('error', () => this.finish(new Error('Relay transport failed')))
    stream.on('close', () => this.finish(new Error('Relay transport closed')))
    if (head?.length) this.feed(head)
  }
  private feed(chunk: Uint8Array): void {
    try {
      for (const frame of this.parser.feed(chunk)) {
        const frameBytes =
          frame.payload.length + (frame.payload.length <= 125 ? 2 : frame.payload.length <= 65535 ? 4 : 10) + (this.outgoingMask ? 0 : 4)
        this.readWireBytes += frameBytes
        this.lastSeen = Date.now()
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
        if (this.failure || !this.validWrite()) {
          this.close(4302)
          throw this.failure ?? new Error('Relay write unavailable')
        }
        if (this.policy.beforeWrite && !(await this.policy.beforeWrite(frame.length))) {
          this.close(4302)
          throw new Error('Relay traffic unavailable')
        }
        if (this.failure || !this.validWrite()) {
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

export async function connectRelay(options: {
  url: URL
  spki: Uint8Array
  ca?: string | Buffer
  timeoutMs?: number
  signal?: AbortSignal
  address?: string
  profile?: RelayTransportProfile
}): Promise<RelaySocket> {
  const { url } = options
  const version = relayWireVersion(options.profile),
    protocol = `latch-relay.${version}`
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || !['/v1/h', '/v1/d', '/v1/c'].includes(url.pathname)
  )
    throw new RangeError('Invalid relay endpoint')
  const key = randomBytes(16).toString('base64')
  if (options.address !== undefined && !isIP(options.address)) throw new RangeError('Invalid relay dial address')
  const lookup: LookupFunction | undefined = options.address
    ? (_hostname, lookupOptions, callback) => {
        const address = options.address!,
          family = isIP(address)
        if (typeof lookupOptions === 'object' && lookupOptions.all) callback(null, [{ address, family }])
        else callback(null, address, family)
      }
    : undefined
  return new Promise((resolve, reject) => {
    const req = request(url, {
      agent: false,
      signal: options.signal,
      ca: options.ca,
      ...(lookup ? { lookup } : {}),
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      ...{ ALPNProtocols: ['http/1.1'] },
      checkServerIdentity(hostname, certificate) {
        const failure = checkServerIdentity(hostname, certificate)
        if (failure) return failure
        const spki = new X509Certificate(certificate.raw).publicKey.export({ type: 'spki', format: 'der' })
        if (!equal(createHash('sha256').update(spki).digest(), options.spki)) return new Error('Relay certificate identity mismatch')
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
    const timer = setTimeout(() => req.destroy(new Error('Relay upgrade timed out')), options.timeoutMs ?? 5000)
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
        response.statusCode !== 101
        || response.headers['sec-websocket-accept'] !== acceptKey(key)
        || response.headers['sec-websocket-protocol'] !== protocol
        || response.headers['sec-websocket-extensions']
      ) {
        socket.destroy()
        reject(new Error('Invalid relay upgrade'))
        return
      }
      resolve(
        new RelaySocket(socket, true, head, {
          pingIntervalMs: 25_000,
          deadAfterMs: 60_000,
          version,
          outerPadding: version === 2 && url.pathname !== '/v1/h',
        }),
      )
    })
    req.end()
  })
}
