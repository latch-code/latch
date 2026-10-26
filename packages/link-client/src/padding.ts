import { Duplex } from 'node:stream'
import { PADDING, PaddingClock, PaddingDecoder, encodePaddingCell } from '@latch/link-wire'

/** A shallow application transport. TLS, raw sockets and all timers share this connection's lifetime. */
export class PaddedStream extends Duplex {
  private readonly decoder = new PaddingDecoder()
  private readonly clock: PaddingClock
  private pending = Buffer.alloc(0)
  private flushed: ((error?: Error | null) => void) | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly active = new Set<object>()
  private blocked = false
  private permitted = () => true
  private sent = 0
  private useful = 0
  constructor(
    private readonly transport: Duplex,
    private readonly role: 'host' | 'client',
  ) {
    super({ readableHighWaterMark: PADDING.queue, writableHighWaterMark: PADDING.queue, allowHalfOpen: false })
    this.clock = new PaddingClock(role, performance.now())
    transport.on('data', (chunk: Buffer) => {
      try {
        // A TLS/pipe read may contain multiple cells; decoding never assumes record boundaries.
        for (let at = 0; at < chunk.length; at += PADDING.queue) {
          for (const data of this.decoder.feed(chunk.subarray(at, at + PADDING.queue))) if (!this.push(data)) transport.pause()
        }
      } catch {
        this.destroy(new Error('Invalid padded transport'))
      }
    })
    transport.once('error', () => this.destroy(new Error('Padded transport closed')))
    transport.once('end', () => this.destroy())
    transport.once('close', () => this.destroy())
    this.schedule()
  }
  protect(): void {
    this.clock.protect(performance.now())
    this.wake()
  }
  protectUntil(deadline: number): void {
    this.clock.protect(performance.now(), deadline)
    this.wake()
  }
  traffic(): { paddedBytes: number; payloadBytes: number } {
    return { paddedBytes: this.sent, payloadBytes: this.useful }
  }
  enableBulk(): void {
    this.clock.enableBulk()
    this.wake()
  }
  guard(check: () => boolean): void {
    this.permitted = check
  }
  getProtocol(): string | null {
    return 'getProtocol' in this.transport && typeof this.transport.getProtocol === 'function' ? String(this.transport.getProtocol()) : null
  }
  activity(key: object, value: boolean): void {
    if (value && (this.active.has(key) || this.active.size < 32)) this.active.add(key)
    else this.active.delete(key)
    if (value) this.wake()
  }
  isSessionReused(): boolean {
    return 'isSessionReused' in this.transport && typeof this.transport.isSessionReused === 'function'
      ? Boolean(this.transport.isSessionReused())
      : false
  }
  override _read(_size: number): void {
    this.transport.resume()
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (chunk.length + this.pending.length > PADDING.queue) {
      callback(new Error('Padded write limit'))
      return
    }
    this.pending = Buffer.concat([this.pending, chunk])
    if (this.pending.length >= PADDING.queue / 2) this.flushed = callback
    else callback()
    this.wake()
  }
  private wake(): void {
    if (this.destroyed) return
    clearTimeout(this.timer)
    const interval = this.role === 'host' ? PADDING.activeMs : PADDING.idleMs,
      now = performance.now()
    this.timer = setTimeout(() => this.schedule(), (Math.floor(now / interval) + 1) * interval - now)
    this.timer.unref()
  }
  private schedule(): void {
    if (this.destroyed) return
    if (!this.permitted()) {
      this.destroy(new Error('Padded transport expired'))
      return
    }
    const next = this.clock.next(performance.now(), this.pending.length, this.active.size > 0)
    if (next.size && !this.blocked) {
      const length = Math.min(this.pending.length, next.size - 3),
        cell = encodePaddingCell(this.pending.subarray(0, length), next.size === PADDING.large)
      this.blocked = true
      this.transport.write(cell, error => {
        this.blocked = false
        if (this.destroyed) return
        if (error) {
          this.destroy(new Error('Padded write failed'))
          return
        }
        this.sent += cell.length
        this.useful += length
        this.pending = this.pending.subarray(length)
        if (this.pending.length < PADDING.queue / 2) {
          const done = this.flushed
          this.flushed = undefined
          done?.()
        }
      })
    }
    this.timer = setTimeout(() => this.schedule(), next.wait)
    this.timer.unref()
  }
  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    clearTimeout(this.timer)
    this.active.clear()
    this.pending.fill(0)
    this.pending = Buffer.alloc(0)
    const done = this.flushed
    this.flushed = undefined
    done?.(new Error('Padded transport closed'))
    this.transport.destroy()
    callback(error)
  }
}
