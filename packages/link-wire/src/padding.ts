import { concat, uint } from './bytes.ts'

export const PADDING = {
  protocol: 'latch-pad/1',
  small: 1024,
  large: 16384,
  queue: 65536,
  idleMs: 250,
  activeMs: 40,
  holdMs: 15000,
  modeMs: 5000,
  /** A bulk connection keeps the 40 ms grid this long after its padding layer starts, past both outer legs' 3 s cover. */
  bulkDelayMs: 3500,
  /** Sender cap for unclocked bulk cells, in bytes per second, and the bucket it may spend at once. */
  bulkRate: 12 * 1024 * 1024,
  bulkBurst: 4 * 1024 * 1024,
  /** Idle this long, a bulk sender pads what it sent to the next size bucket. */
  bulkQuietMs: 1000,
  bulkBucketBase: 262_144,
} as const

/** The smallest size bucket at or above `bytes`: 256 KiB, then each ×1.25 rounded up to whole large cells. */
export function paddingBucket(bytes: number): number {
  let bucket: number = PADDING.bulkBucketBase
  while (bucket < bytes) bucket = Math.ceil((bucket * 5) / (4 * PADDING.large)) * PADDING.large
  return bucket
}

/** The entire cell, including its zero tail, is authenticated by the inner platform TLS connection. */
export function encodePaddingCell(payload: Uint8Array, large = false): Uint8Array {
  const size = large ? PADDING.large : PADDING.small
  if (payload.length > size - 3) throw new RangeError('Padding payload limit')
  return concat(
    uint((large ? 128 : 0) | (payload.length ? 0 : 1), 1),
    uint(payload.length, 2),
    payload,
    new Uint8Array(size - 3 - payload.length),
  )
}
export class PaddingDecoder {
  private pending: Uint8Array = new Uint8Array()
  feed(bytes: Uint8Array): Uint8Array[] {
    if (bytes.length > PADDING.queue) throw new RangeError('Padding input limit')
    this.pending = concat(this.pending, bytes)
    const out: Uint8Array[] = []
    let offset = 0
    while (this.pending.length - offset >= 3) {
      const kind = this.pending[offset]!,
        size = kind & 128 ? PADDING.large : PADDING.small,
        length = this.pending[offset + 1]! * 256 + this.pending[offset + 2]!
      if ((kind & 127) > 1 || length > size - 3 || Boolean(kind & 1) !== (length === 0)) throw new RangeError('Invalid padding cell')
      if (this.pending.length - offset < size) break
      if (this.pending.subarray(offset + 3 + length, offset + size).some(byte => byte !== 0)) throw new RangeError('Invalid padding tail')
      if (length) out.push(this.pending.slice(offset + 3, offset + 3 + length))
      offset += size
    }
    this.pending = this.pending.slice(offset)
    if (this.pending.length >= PADDING.large) throw new RangeError('Padding pending limit')
    return out
  }
}

/**
 * Monotonic-clock scheduling only. Missed slots are skipped, never replayed as a burst. A bulk connection keeps the
 * 40 ms grid for `bulkDelayMs`, then sends whole large cells as soon as data is queued, capped by a token bucket, with no
 * dummy cells until it falls quiet, when it pads its bulk total to the next size bucket.
 */
export class PaddingClock {
  private readonly role: 'host' | 'client'
  private readonly opened: number
  private activeUntil = 0
  private holdUntil = 0
  private largeUntil = 0
  private bucket: number
  private lastSlot = -1
  private bulk = false
  private tokens = 0
  private refilled = 0
  private bulkBytes = 0
  private busyAt = 0
  constructor(role: 'host' | 'client', now: number) {
    this.role = role
    this.opened = now
    this.bucket = Math.floor(now / PADDING.modeMs)
    this.lastSlot = Math.floor(now / PADDING.activeMs) * PADDING.activeMs
  }
  protect(now: number, deadline = now + PADDING.holdMs): void {
    this.holdUntil = Math.max(this.holdUntil, Math.min(deadline, now + PADDING.holdMs))
  }
  enableBulk(now: number): void {
    if (this.role !== 'host') throw new RangeError('Bulk shaping requires a Host')
    if (this.bulk) return
    this.bulk = true
    this.tokens = PADDING.bulkBurst
    this.refilled = now
    this.busyAt = now
  }
  /** True once a bulk connection sends by backpressure instead of a timer. */
  unclocked(now: number): boolean {
    return this.bulk && now >= this.opened + PADDING.bulkDelayMs
  }
  /** Bytes the bulk total covers, for its size bucket. */
  bulkTotal(): number {
    return this.bulkBytes
  }
  /** A bulk cell went to the transport: it spends tokens and counts towards the size bucket. */
  record(size: number, now: number): void {
    // A small cell still in flight when bulk began stays outside the bulk total, which counts whole large cells.
    if (!this.bulk || size !== PADDING.large) return
    this.refill(now)
    this.tokens -= size
    this.bulkBytes += size
  }
  next(now: number, queued: number, streaming = false): { size: number; wait: number } {
    if (this.bulk && this.unclocked(now)) return this.nextUnclocked(now, queued, streaming)
    if (queued || streaming) this.activeUntil = Math.max(this.activeUntil, now + 2000)
    if (this.bulk && (queued || streaming)) this.busyAt = now
    const active = this.bulk || now < Math.max(this.activeUntil, this.holdUntil, this.largeUntil),
      interval = this.role === 'host' && active ? PADDING.activeMs : PADDING.idleMs,
      slot = Math.floor(now / interval) * interval,
      bucket = Math.floor(now / PADDING.modeMs)
    if (bucket > this.bucket) {
      this.bucket = bucket
      if (now >= this.holdUntil && queued > 4096) this.largeUntil = (bucket + 1) * PADDING.modeMs
    }
    const size = slot > this.lastSlot ? (this.bulk || now < this.largeUntil ? PADDING.large : PADDING.small) : 0
    if (size) this.lastSlot = slot
    return { size, wait: Math.max(1, (Math.floor(now / interval) + 1) * interval - now) }
  }
  private nextUnclocked(now: number, queued: number, streaming: boolean): { size: number; wait: number } {
    this.refill(now)
    if (queued || streaming) this.busyAt = now
    const quietAt = this.busyAt + PADDING.bulkQuietMs,
      owed = !queued && !streaming && now >= quietAt && this.bulkBytes < paddingBucket(this.bulkBytes)
    // Idle waits stay short so the caller keeps checking the window while nothing is sent.
    if (!queued && !owed)
      return { size: 0, wait: streaming || now >= quietAt ? PADDING.idleMs : Math.max(1, Math.min(PADDING.idleMs, quietAt - now)) }
    if (this.tokens < PADDING.large)
      return { size: 0, wait: Math.max(1, Math.ceil(((PADDING.large - this.tokens) * 1000) / PADDING.bulkRate)) }
    return { size: PADDING.large, wait: 0 }
  }
  private refill(now: number): void {
    this.tokens = Math.min(PADDING.bulkBurst, this.tokens + ((now - this.refilled) * PADDING.bulkRate) / 1000)
    this.refilled = now
  }
}
