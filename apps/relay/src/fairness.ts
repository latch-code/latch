import { randomBytes } from 'node:crypto'
import type { QuotaSnapshot } from './quota.ts'
interface Bucket {
  tokens: number
}
interface Group extends Bucket {
  routes: Map<string, Bucket>
  indices: number[]
  weight: number
}
interface Waiting {
  id: number
  route: string
  groups: Map<string, number>
  remaining: number
  bytes: number
  resolve(value: boolean): void
}
interface FairnessOptions {
  quota(): Pick<QuotaSnapshot, 'healthy' | 'calibrated' | 'rate' | 'burstBytes' | 'dayEndsAt' | 'dailyBudget'> & { dailyRemaining?: number }
  maxQueuedBytes: number
  maxConnections: number
  prefixDailyShare: number
  overageFactor: number
  count: 'in+out' | 'out'
  now?(): number
}
/** Credit reservations are asynchronous and bounded; a large frame never blocks another prefix. */
export class FairScheduler {
  private readonly options: FairnessOptions
  private readonly waiting = new Map<number, Waiting>()
  private readonly groups = new Map<string, Group>()
  private readonly daily: Float64Array
  private readonly seeds = Array.from(randomBytes(16))
  private dayEndsAt = 0
  private global = 0
  private at: number
  private queuedBytes = 0
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  private cursor = 0
  constructor(options: FairnessOptions) {
    if (
      !Number.isSafeInteger(options.maxQueuedBytes)
      || options.maxQueuedBytes < 16384
      || !Number.isInteger(options.maxConnections)
      || options.maxConnections < 1
      || !(options.prefixDailyShare > 0 && options.prefixDailyShare <= 1)
      || !(options.overageFactor > 0 && options.overageFactor < 1)
    )
      throw new Error('Invalid fairness configuration')
    this.options = options
    this.at = (options.now ?? Date.now)()
    // A fixed conservative sketch prevents daily prefix rotation from growing an IP map.
    this.daily = new Float64Array(4 * 2 ** Math.ceil(Math.log2(Math.max(16, options.maxConnections * 2))))
  }
  private indices(prefix: string): number[] {
    const width = this.daily.length / 4
    return Array.from({ length: 4 }, (_, row) => {
      let hash = (2166136261 ^ this.seeds[row]!) >>> 0
      for (let i = 0; i < prefix.length; i++) hash = Math.imul(hash ^ prefix.charCodeAt(i), 16777619) >>> 0
      return row * width + (hash % width)
    })
  }
  wait(id: number, prefixes: readonly string[], route: string, bytes: number): Promise<boolean> {
    if (
      this.closed
      || this.waiting.has(id)
      || !Number.isInteger(bytes)
      || bytes < 0
      || bytes > 16384
      || !prefixes.length
      || prefixes.length > 2
      || this.waiting.size >= this.options.maxConnections
      || this.queuedBytes + bytes > this.options.maxQueuedBytes
    )
      return Promise.resolve(false)
    if (bytes === 0) return Promise.resolve(true)
    const weights = new Map<string, number>()
    for (const prefix of prefixes) {
      if (prefix.length > 64) return Promise.resolve(false)
      weights.set(prefix, (weights.get(prefix) ?? 0) + 1 / prefixes.length)
      if (!this.groups.has(prefix)) this.groups.set(prefix, { tokens: 0, routes: new Map(), indices: this.indices(prefix), weight: 1 })
    }
    this.queuedBytes += bytes
    return new Promise(resolve => {
      this.waiting.set(id, { id, route, groups: weights, remaining: bytes * (this.options.count === 'in+out' ? 2 : 1), bytes, resolve })
    })
  }
  cancel(id: number): void {
    const item = this.waiting.get(id)
    if (!item) return
    this.waiting.delete(id)
    this.queuedBytes -= item.bytes
    item.resolve(false)
  }
  tick(): void {
    if (this.closed) return
    const now = (this.options.now ?? Date.now)(),
      quota = this.options.quota(),
      elapsed = Math.max(0, Math.min(1, (now - this.at) / 1000))
    this.at = now
    if (quota.dayEndsAt !== this.dayEndsAt) {
      this.daily.fill(0)
      this.dayEndsAt = quota.dayEndsAt
      this.global = 0
      for (const group of this.groups.values()) {
        group.tokens = 0
        group.routes.clear()
      }
    }
    const active = new Map<string, Set<string>>()
    for (const item of this.waiting.values())
      for (const prefix of item.groups.keys()) {
        const routes = active.get(prefix) ?? new Set<string>()
        routes.add(item.route)
        active.set(prefix, routes)
      }
    for (const [prefix] of this.groups) if (!active.has(prefix)) this.groups.delete(prefix)
    if (!quota.healthy || !quota.calibrated || quota.rate <= 0 || !active.size) {
      this.global = 0
      return
    }
    const rate = quota.rate,
      burst = Math.min(quota.burstBytes, quota.dailyRemaining ?? quota.dailyBudget)
    this.global = Math.min(burst, this.global + rate * elapsed)
    let normal = 0
    for (const prefix of active.keys()) {
      const group = this.groups.get(prefix)!
      const used = Math.min(...group.indices.map(index => this.daily[index]!))
      group.weight = used >= quota.dailyBudget * this.options.prefixDailyShare ? this.options.overageFactor : 1
      if (group.weight === 1) normal++
    }
    for (const [prefix, routes] of active) {
      const group = this.groups.get(prefix)!,
        share =
          group.weight === 1
            ? (1 - ((active.size - normal) * this.options.overageFactor) / active.size) / normal
            : this.options.overageFactor / active.size
      group.tokens = Math.min(burst * share, group.tokens + rate * share * elapsed)
      for (const route of group.routes.keys()) if (!routes.has(route)) group.routes.delete(route)
      for (const route of routes) {
        const bucket = group.routes.get(route) ?? { tokens: 0 }
        bucket.tokens = Math.min((burst * share) / routes.size, bucket.tokens + ((rate * share) / routes.size) * elapsed)
        group.routes.set(route, bucket)
      }
    }
    const queue = [...this.waiting.values()]
    // Rotate within a shared route so opening parallel sockets cannot multiply its share.
    const start = this.cursor++ % queue.length
    for (let i = 0; i < queue.length; i++) {
      const item = queue[(start + i) % queue.length]!
      let granted = Math.min(item.remaining, this.global)
      for (const [prefix, fraction] of item.groups) {
        const group = this.groups.get(prefix)!
        granted = Math.min(granted, group.tokens / fraction, group.routes.get(item.route)!.tokens / fraction)
      }
      if (granted <= 0) continue
      this.global -= granted
      item.remaining -= granted
      for (const [prefix, fraction] of item.groups) {
        const group = this.groups.get(prefix)!,
          amount = granted * fraction
        group.tokens -= amount
        group.routes.get(item.route)!.tokens -= amount
        for (const index of group.indices) this.daily[index]! += amount
      }
      if (item.remaining < 0.000001) {
        this.waiting.delete(item.id)
        this.queuedBytes -= item.bytes
        item.resolve(true)
      }
    }
  }
  buffered(id: number): number {
    return this.waiting.get(id)?.bytes ?? 0
  }
  start(): void {
    this.timer ??= setInterval(() => this.tick(), 20)
    this.timer.unref()
  }
  status(): { waiting: number; queuedBytes: number; activeGroups: number; sketchBytes: number } {
    return { waiting: this.waiting.size, queuedBytes: this.queuedBytes, activeGroups: this.groups.size, sketchBytes: this.daily.byteLength }
  }
  close(): void {
    this.closed = true
    clearInterval(this.timer)
    for (const id of this.waiting.keys()) this.cancel(id)
    this.groups.clear()
  }
}
