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
} as const

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

/** Monotonic-clock scheduling only. Missed slots are skipped, never replayed as a burst. */
export class PaddingClock {
  private readonly role: 'host' | 'client'
  private activeUntil = 0
  private holdUntil = 0
  private largeUntil = 0
  private bucket: number
  private lastSlot = -1
  private bulk = false
  constructor(role: 'host' | 'client', now: number) {
    this.role = role
    this.bucket = Math.floor(now / PADDING.modeMs)
    this.lastSlot = Math.floor(now / PADDING.activeMs) * PADDING.activeMs
  }
  protect(now: number, deadline = now + PADDING.holdMs): void {
    this.holdUntil = Math.max(this.holdUntil, Math.min(deadline, now + PADDING.holdMs))
  }
  enableBulk(): void {
    if (this.role !== 'host') throw new RangeError('Bulk shaping requires a Host')
    this.bulk = true
  }
  next(now: number, queued: number, streaming = false): { size: number; wait: number } {
    if (queued || streaming) this.activeUntil = Math.max(this.activeUntil, now + 2000)
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
}
