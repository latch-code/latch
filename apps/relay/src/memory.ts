import { readFile } from 'node:fs/promises'
export interface MemorySample {
  used: number
  limit: number
  includesSockets: boolean
}
/** Linux cgroup v2 includes kernel socket memory; process RSS alone is not a production proxy. */
async function readRelayMemory(configuredLimit: number): Promise<MemorySample> {
  if (process.platform !== 'linux') return { used: process.memoryUsage().rss, limit: configuredLimit, includesSockets: false }
  const [current, maximum] = await Promise.all([
    readFile('/sys/fs/cgroup/memory.current', 'utf8'),
    readFile('/sys/fs/cgroup/memory.max', 'utf8'),
  ])
  const integer = (value: string) => {
    if (!/^\d+\n?$/u.test(value)) throw new Error('Invalid cgroup counter')
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Invalid cgroup limit')
    return n
  }
  const used = integer(current),
    limit = maximum.trim() === 'max' ? configuredLimit : Math.min(configuredLimit, integer(maximum))
  return { used, limit, includesSockets: true }
}
export interface BufferedPeer {
  id: number
  prefix: string
  bufferedBytes: number
  pendingWriteBytes: number
  writtenBytes: number
  spliced: boolean
}
export class MemoryGuard {
  private readonly history = new Map<number, { at: number; written: number }>()
  private state: MemorySample
  private healthy = true
  private bytes = 0
  private readonly options: { bufferBudget: number; memoryLimit: number; read?(): Promise<MemorySample>; now?(): number }
  constructor(options: { bufferBudget: number; memoryLimit: number; read?(): Promise<MemorySample>; now?(): number }) {
    this.options = options
    this.state = { used: 0, limit: options.memoryLimit, includesSockets: false }
  }
  async sample(peers: readonly BufferedPeer[]): Promise<{ evict?: number; stalled: number[] }> {
    const now = (this.options.now ?? Date.now)(),
      live = new Set(peers.map(peer => peer.id)),
      stalled: number[] = []
    this.bytes = peers.reduce((sum, peer) => sum + peer.bufferedBytes, 0)
    for (const id of this.history.keys()) if (!live.has(id)) this.history.delete(id)
    for (const peer of peers) {
      if (!peer.pendingWriteBytes) {
        this.history.delete(peer.id)
        continue
      }
      const old = this.history.get(peer.id)
      if (!old) this.history.set(peer.id, { at: now, written: peer.writtenBytes })
      else if (now - old.at >= 60_000) {
        if ((peer.writtenBytes - old.written) / ((now - old.at) / 1000) < 1024) stalled.push(peer.id)
        this.history.set(peer.id, { at: now, written: peer.writtenBytes })
      }
    }
    try {
      this.state = await (this.options.read?.() ?? readRelayMemory(this.options.memoryLimit))
      this.healthy =
        Number.isSafeInteger(this.state.used) && this.state.used >= 0 && Number.isSafeInteger(this.state.limit) && this.state.limit > 0
    } catch {
      this.healthy = false
    }
    if (!this.healthy || (this.state.used < this.state.limit * 0.9 && this.bytes <= this.options.bufferBudget)) return { stalled }
    const splices = peers.filter(peer => peer.spliced),
      groups = new Map<string, number>()
    for (const peer of splices) groups.set(peer.prefix, (groups.get(peer.prefix) ?? 0) + peer.bufferedBytes)
    const largest = [...groups].sort((a, b) => b[1] - a[1])[0]?.[0]
    const worst = splices.filter(peer => peer.prefix === largest).sort((a, b) => b.bufferedBytes - a.bufferedBytes)[0]
    return { stalled, ...(worst ? { evict: worst.id } : {}) }
  }
  highWaterMark(): number {
    return this.bytes >= this.options.bufferBudget / 2 ? 16 * 1024 : 64 * 1024
  }
  status(): { healthy: boolean; used: number; limit: number; includesSockets: boolean; bufferedBytes: number; highWaterMark: number } {
    return { healthy: this.healthy, ...this.state, bufferedBytes: this.bytes, highWaterMark: this.highWaterMark() }
  }
}
