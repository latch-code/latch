import { randomBytes } from 'node:crypto'
import { encodeFrame, encodeMessage, OUTER_PADDING } from '@latch/link-wire'

interface PendingFrame {
  bytes: Uint8Array
  resolve(): void
  reject(error: Error): void
}
interface OuterOptions {
  client: boolean
  write(bytes: Uint8Array): Promise<void>
  valid(): boolean
  fail(): void
  maximumTickBytes?(): number
}

/** The first three seconds batch already available frames; a future handshake flight is never awaited. */
export class RelayOuterPadding {
  private readonly options: OuterOptions
  private readonly start = performance.now()
  private readonly queue: PendingFrame[] = []
  private queuedBytes = 0
  private active?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private paddingBytes = 0
  private batches = 0
  private lastGrid = 0
  constructor(options: OuterOptions) {
    this.options = options
    this.schedule()
  }
  write(bytes: Uint8Array): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Relay outer padding closed'))
    if (
      bytes.length > OUTER_PADDING.maximumTickBytes - 16
      || this.queuedBytes + bytes.length > OUTER_PADDING.maximumQueueBytes
      || this.queue.length >= 256
    ) {
      this.options.fail()
      return Promise.reject(new Error('Relay outer padding limit'))
    }
    this.queuedBytes += bytes.length
    const pending = new Promise<void>((resolve, reject) => this.queue.push({ bytes, resolve, reject }))
    if (performance.now() >= this.start + OUTER_PADDING.durationMs) void this.tick()
    return pending
  }
  private schedule(): void {
    if (this.stopped || this.timer) return
    const elapsed = performance.now() - this.start
    if (elapsed >= OUTER_PADDING.durationMs) {
      if (this.queue.length && !this.active) void this.tick()
      return
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        void this.tick()
      },
      Math.max(1, Math.ceil(OUTER_PADDING.tickMs - (elapsed % OUTER_PADDING.tickMs))),
    )
    this.timer.unref()
  }
  private async tick(): Promise<void> {
    if (this.stopped) return
    if (this.active) {
      this.schedule()
      return
    }
    if (!this.options.valid()) {
      this.options.fail()
      return
    }
    const elapsed = performance.now() - this.start,
      cover = elapsed <= OUTER_PADDING.durationMs
    if (cover) {
      const grid = Math.floor(elapsed / OUTER_PADDING.tickMs)
      if (grid <= this.lastGrid) {
        this.schedule()
        return
      }
      this.lastGrid = grid
    }
    const maximum = Math.max(
      4096,
      Math.min(
        OUTER_PADDING.maximumTickBytes,
        Math.floor((this.options.maximumTickBytes?.() ?? OUTER_PADDING.maximumTickBytes) / 4096) * 4096,
      ),
    )
    const chosen: PendingFrame[] = []
    if (!Number.isSafeInteger(maximum) || this.queue.some(frame => frame.bytes.length > maximum - 16)) {
      this.options.fail()
      return
    }
    let size = 0
    while (chosen.length < OUTER_PADDING.maximumFramesPerTick && this.queue.length) {
      const next = this.queue[0]!
      // Reserve a complete PAD header even when real frames end exactly on a bucket edge.
      if (size + next.bytes.length > maximum - 16) break
      this.queue.shift()
      chosen.push(next)
      size += next.bytes.length
    }
    if (!chosen.length && !cover) return
    const chunks: Uint8Array[] = chosen.map(value => value.bytes)
    let paddingSize = 0
    if (cover) {
      const mask = this.options.client ? randomBytes(4) : undefined
      let target = Math.max(
        OUTER_PADDING.bucketBytes,
        Math.ceil((size + (mask ? 7 : 3)) / OUTER_PADDING.bucketBytes) * OUTER_PADDING.bucketBytes,
      )
      let padding: Uint8Array | undefined
      while (!padding) {
        for (const header of [2, 4]) {
          const count = target - size - header - (mask ? 4 : 0) - 1
          if (count < 0 || count > 16_384) continue
          const frame = encodeFrame({ opcode: 2, payload: encodeMessage({ type: 'pad', data: randomBytes(count) }, 2) }, mask)
          if (frame.length === target - size) {
            padding = frame
            break
          }
        }
        if (!padding) target += OUTER_PADDING.bucketBytes
        if (target > maximum) {
          this.options.fail()
          return
        }
      }
      chunks.push(padding)
      paddingSize = padding.length
    }
    const batch = Buffer.concat(chunks)
    const operation = Promise.resolve().then(() => {
      if (this.stopped || !this.options.valid()) throw new Error('Relay outer padding closed')
      return this.options.write(batch)
    })
    this.active = operation
    try {
      await operation
      this.paddingBytes += paddingSize
      if (cover) this.batches++
      for (const item of chosen) item.resolve()
    } catch {
      const error = new Error('Relay outer padding write failed')
      for (const item of chosen) item.reject(error)
      this.options.fail()
    } finally {
      this.queuedBytes -= size
      if (this.active === operation) this.active = undefined
      if (!this.stopped) {
        if (performance.now() >= this.start + OUTER_PADDING.durationMs && this.queue.length) void this.tick()
        else this.schedule()
      }
    }
  }
  bufferedBytes(): number {
    return this.queuedBytes
  }
  statistics(): { paddingBytes: number; batches: number } {
    return { paddingBytes: this.paddingBytes, batches: this.batches }
  }
  close(): void {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    for (const item of this.queue.splice(0)) {
      this.queuedBytes -= item.bytes.length
      item.reject(new Error('Relay outer padding closed'))
    }
  }
  async settled(): Promise<void> {
    await this.active?.catch(() => {})
  }
}
