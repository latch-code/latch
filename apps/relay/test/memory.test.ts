import { describe, expect, it } from 'vitest'
import { MemoryGuard, type BufferedPeer } from '../src/memory.ts'
const peer = (id: number, prefix: string, bytes: number, written = 0): BufferedPeer => ({
  id,
  prefix,
  bufferedBytes: bytes,
  pendingWriteBytes: bytes,
  writtenBytes: written,
  spliced: true,
})
describe('bounded relay memory and throughput progress', () => {
  it('adapts64KiB to16KiB at half budget and evicts the largest buffer in the largest prefix group at90%', async () => {
    let memory = 40,
      now = 0
    const guard = new MemoryGuard({
      bufferBudget: 100,
      memoryLimit: 100,
      read: async () => ({ used: memory, limit: 100, includesSockets: true }),
      now: () => now,
    })
    expect(guard.highWaterMark()).toBe(65536)
    const peers = [peer(1, 'a', 30), peer(2, 'a', 25), peer(3, 'b', 40)]
    expect(await guard.sample(peers)).toEqual({ stalled: [] })
    expect(guard.highWaterMark()).toBe(16384)
    memory = 90
    expect(await guard.sample(peers)).toEqual({ stalled: [], evict: 1 })
    now = 60000
    const trickle = await guard.sample([peer(1, 'a', 30, 1), peer(2, 'a', 25, 61440), peer(3, 'b', 40, 61439)])
    expect(trickle.stalled).toEqual([1, 3])
    expect(trickle.evict).toBe(1)
  })
  it('preserves healthy slow transfer above1KiB/s, ignores idle tunnels and fails readiness on unreadable kernel counters', async () => {
    let now = 0,
      fail = false
    const guard = new MemoryGuard({
      bufferBudget: 100000,
      memoryLimit: 100000,
      read: async () => {
        if (fail) throw new Error('fixture')
        return { used: 1, limit: 100000, includesSockets: true }
      },
      now: () => now,
    })
    await guard.sample([peer(1, 'a', 100)])
    now = 60000
    expect((await guard.sample([peer(1, 'a', 100, 120000)])).stalled).toEqual([])
    now = 120000
    expect((await guard.sample([{ ...peer(1, 'a', 0, 120000), pendingWriteBytes: 0 }])).stalled).toEqual([])
    fail = true
    await guard.sample([])
    expect(guard.status().healthy).toBe(false)
  })
})
