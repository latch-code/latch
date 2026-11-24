import { describe, expect, it } from 'vitest'
import { FairScheduler } from '../src/fairness.ts'
function fixture(options: { share?: number; factor?: number; maxBytes?: number; count?: 'in+out' | 'out' } = {}) {
  let now = 0,
    rate = 1000,
    healthy = true
  const scheduler = new FairScheduler({
    quota: () => ({ healthy, calibrated: true, rate, burstBytes: 1000, dayEndsAt: 86400000, dailyBudget: 1000000 }),
    maxQueuedBytes: options.maxBytes ?? 100000,
    maxConnections: 100,
    prefixDailyShare: options.share ?? 1,
    overageFactor: options.factor ?? 0.1,
    count: options.count ?? 'out',
    now: () => now,
  })
  return {
    scheduler,
    step(ms = 100) {
      now += ms
      scheduler.tick()
    },
    rate(n: number) {
      rate = n
    },
    healthy(value: boolean) {
      healthy = value
    },
  }
}
describe('asynchronous hierarchical forwarding credits', () => {
  it('charges explicitly observed wire bytes once while retaining the legacy combined payload estimate', async () => {
    const exact = fixture({ count: 'in+out' }),
      legacy = fixture({ count: 'in+out' })
    let finishedExact = false,
      finishedLegacy = false
    const a = exact.scheduler.wait(1, ['192.0.2.0/24'], 'one', 500, true).then(ok => {
      finishedExact = ok
    })
    const b = legacy.scheduler.wait(1, ['192.0.2.0/24'], 'one', 500).then(ok => {
      finishedLegacy = ok
    })
    exact.step(500)
    legacy.step(500)
    await Promise.resolve()
    expect(finishedExact).toBe(true)
    expect(finishedLegacy).toBe(false)
    legacy.step(500)
    await Promise.all([a, b])
    expect(finishedLegacy).toBe(true)
    exact.scheduler.close()
    legacy.scheduler.close()
  })
  it('lets a small independent frame pass while a large frame waits and does not block the event loop', async () => {
    const f = fixture(),
      done: string[] = []
    const large = f.scheduler.wait(1, ['192.0.2.0/24'], 'large', 16384).then(ok => done.push(`large:${ok}`))
    const small = f.scheduler.wait(2, ['198.51.100.0/24'], 'small', 100).then(ok => done.push(`small:${ok}`))
    f.step()
    await Promise.resolve()
    expect(done).toEqual([])
    f.step()
    await small
    expect(done).toEqual(['small:true'])
    expect(f.scheduler.status().waiting).toBe(1)
    f.scheduler.close()
    await large
    expect(done).toContain('large:false')
  })
  it('shares first between prefixes, then routes, regardless of parallel sockets in one route', async () => {
    const f = fixture(),
      done: number[] = []
    for (let id = 1; id <= 8; id++)
      void f.scheduler.wait(id, ['192.0.2.0/24'], 'attacker', 1000).then(ok => {
        if (ok) done.push(id)
      })
    const route = f.scheduler.wait(9, ['192.0.2.0/24'], 'neighbor', 250).then(ok => {
      if (ok) done.push(9)
    })
    const outsider = f.scheduler.wait(10, ['198.51.100.0/24'], 'outsider', 500).then(ok => {
      if (ok) done.push(10)
    })
    for (let i = 0; i < 10; i++) f.step()
    await Promise.all([route, outsider])
    expect(done.sort((a, b) => a - b)).toEqual([9, 10])
    f.scheduler.close()
  })
  it('uses the stricter endpoint prefix, bounds all queued data, cancels independently and fails closed on stale quota', async () => {
    const f = fixture({ maxBytes: 16384 })
    const blocked = f.scheduler.wait(1, ['192.0.2.0/24', '198.51.100.0/24'], 'both', 16000)
    expect(await f.scheduler.wait(2, ['203.0.113.0/24'], 'other', 1000)).toBe(false)
    f.healthy(false)
    for (let i = 0; i < 10; i++) f.step()
    expect(f.scheduler.status()).toMatchObject({ waiting: 1, queuedBytes: 16000 })
    f.scheduler.cancel(1)
    expect(await blocked).toBe(false)
    f.healthy(true)
    const recovered = f.scheduler.wait(3, ['203.0.113.0/24'], 'other', 100)
    f.step()
    expect(await recovered).toBe(true)
    expect(f.scheduler.status().sketchBytes).toBeLessThan(20000)
    f.scheduler.close()
  })
  it('slows an over-share prefix without disconnecting it or imposing an absolute route floor', async () => {
    const f = fixture({ share: 0.001 }),
      done: number[] = []
    const used = f.scheduler.wait(1, ['192.0.2.0/24'], 'first', 1000)
    for (let i = 0; i < 10; i++) f.step()
    await used
    const over = f.scheduler.wait(2, ['192.0.2.0/24'], 'over', 500).then(ok => {
      if (ok) done.push(2)
    })
    const other = f.scheduler.wait(3, ['198.51.100.0/24'], 'other', 500).then(ok => {
      if (ok) done.push(3)
    })
    for (let i = 0; i < 6; i++) {
      f.step()
      await Promise.resolve()
    }
    expect(done).toEqual([3])
    expect(f.scheduler.status().waiting).toBe(1)
    f.rate(0)
    f.step()
    expect(f.scheduler.status().waiting).toBe(1)
    f.scheduler.close()
    await Promise.all([over, other])
  })
})

it('serves the full connection limit and reuses the drained queue on the next round', async () => {
  let now = 0
  const scheduler = new FairScheduler({
    quota: () => ({ healthy: true, calibrated: true, rate: 1e9, burstBytes: 1e6, dayEndsAt: 86400000, dailyBudget: 1e12 }),
    maxQueuedBytes: 1e6,
    maxConnections: 1024,
    prefixDailyShare: 0.01,
    overageFactor: 0.1,
    count: 'out',
    now: () => now,
  })
  for (let round = 0; round < 2; round++) {
    const pending = Array.from({ length: 1024 }, (_, id) => scheduler.wait(id, [`group-${id}`], `route-${id}`, 1))
    now += 20
    scheduler.tick()
    expect((await Promise.all(pending)).every(Boolean)).toBe(true)
    expect(scheduler.status().queuedBytes).toBe(0)
  }
  scheduler.close()
})

describe('the burst accumulates while idle', () => {
  const MiB = 1024 * 1024
  function idle(burstBytes = 64 * MiB) {
    let now = 0
    const quota = { healthy: true, calibrated: true, rate: MiB, burstBytes, dayEndsAt: 86_400_000, dailyBudget: 1e12, dailyRemaining: 1e12 }
    const scheduler = new FairScheduler({
      quota: () => quota,
      maxQueuedBytes: MiB,
      maxConnections: 100,
      prefixDailyShare: 1,
      overageFactor: 0.1,
      count: 'out',
      now: () => now,
    })
    return {
      scheduler,
      quota,
      step(ms: number) {
        now += ms
        scheduler.tick()
      },
      /** Sequential 16 KiB frames of one route without moving the clock, as one transfer; how many were granted. */
      async burst(frames: number, route = 'transfer') {
        let granted = 0
        for (let index = 0; index < frames; index++) {
          let ok: boolean | undefined
          void scheduler.wait(1, ['192.0.2.0/24'], route, 16_384).then(value => (ok = value))
          await Promise.resolve()
          if (!ok) {
            scheduler.cancel(1)
            break
          }
          granted++
        }
        return granted
      },
    }
  }

  it('lets a transfer after a quiet minute and more spend the whole 64 MiB burst at once, and no more', async () => {
    const f = idle()
    for (let i = 0; i < 700; i++) f.step(100)
    // The first frame of a prefix that was idle waits one tick, which seeds it from what accumulated.
    const first = f.scheduler.wait(1, ['192.0.2.0/24'], 'transfer', 16_384)
    f.step(1)
    expect(await first).toBe(true)
    // The rest go on arrival, four thousand frames with the clock standing still.
    expect(await f.burst(4096)).toBe(4095)
    expect(f.scheduler.status()).toMatchObject({ waiting: 0, queuedBytes: 0 })
    // Spent, a frame waits for the refill again.
    const next = f.scheduler.wait(1, ['192.0.2.0/24'], 'transfer', 16_384)
    let done = false
    void next.then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    f.step(20)
    expect(await next).toBe(true)
    f.scheduler.close()
  })

  it('accumulates no more than the burst, however long it was idle', async () => {
    const f = idle(MiB)
    for (let i = 0; i < 100; i++) f.step(1000)
    const first = f.scheduler.wait(1, ['192.0.2.0/24'], 'transfer', 16_384)
    f.step(1)
    expect(await first).toBe(true)
    expect(await f.burst(1000)).toBe(63)
    f.scheduler.close()
  })

  it('still holds the daily stop: the burst is capped by the day’s remaining budget, and an exhausted day grants nothing', async () => {
    const f = idle()
    for (let i = 0; i < 700; i++) f.step(100)
    f.quota.dailyRemaining = 5 * 16_384
    const first = f.scheduler.wait(1, ['192.0.2.0/24'], 'transfer', 16_384)
    f.step(1)
    expect(await first).toBe(true)
    expect(await f.burst(100)).toBe(4)
    // The day is spent: the quota stops pacing it, and nothing is granted however long it waits.
    f.quota.dailyRemaining = 0
    f.quota.rate = 0
    const blocked = f.scheduler.wait(1, ['192.0.2.0/24'], 'transfer', 16_384)
    for (let i = 0; i < 100; i++) f.step(100)
    expect(f.scheduler.status().waiting).toBe(1)
    f.scheduler.cancel(1)
    expect(await blocked).toBe(false)
    f.scheduler.close()
  })

  it('drops what accumulated when the quota turns unhealthy', async () => {
    const f = idle()
    for (let i = 0; i < 700; i++) f.step(100)
    f.quota.healthy = false
    f.step(100)
    f.quota.healthy = true
    const first = f.scheduler.wait(1, ['192.0.2.0/24'], 'transfer', 16_384)
    f.step(20)
    // About 20 KiB came back in the one tick since: the first frame, not the minute before.
    expect(await first).toBe(true)
    expect(await f.burst(10)).toBe(0)
    f.scheduler.close()
  })
})

describe('grants on arrival in the server’s call shape', () => {
  const MiB = 1024 * 1024
  function shaped() {
    let now = 0
    const quota = { healthy: true, calibrated: true, rate: MiB, burstBytes: 64 * MiB, dayEndsAt: 86_400_000, dailyBudget: 1e12 }
    const scheduler = new FairScheduler({
      quota: () => quota,
      maxQueuedBytes: MiB,
      maxConnections: 100,
      prefixDailyShare: 1,
      overageFactor: 0.1,
      count: 'in+out',
      now: () => now,
    })
    const step = (ms: number) => {
      now += ms
      scheduler.tick()
    }
    /** One frame as server.ts charges it: received on the in id, then written on the out id, both exact. */
    const frame = async (id: number, prefixes: string[], route: string) => {
      let ok = false
      void scheduler.wait(id * 2, prefixes, route, 16_384, true).then(value => (ok = value))
      await Promise.resolve()
      if (!ok) return false
      ok = false
      void scheduler.wait(id * 2 + 1, prefixes, route, 16_384, true).then(value => (ok = value))
      await Promise.resolve()
      return ok
    }
    return { scheduler, step, frame }
  }

  it('moves 32 MiB of payload across two prefixes, in and out, after an idle minute', async () => {
    const f = shaped()
    for (let i = 0; i < 700; i++) f.step(100)
    const prefixes = ['192.0.2.0/24', '198.51.100.0/24']
    // The first frame of idle prefixes waits one tick; it seeds both from what accumulated.
    const first = f.scheduler.wait(2, prefixes, 'transfer', 16_384, true)
    f.step(1)
    expect(await first).toBe(true)
    f.scheduler.wait(3, prefixes, 'transfer', 16_384, true)
    await Promise.resolve()
    let frames = 1
    while (frames < 3000 && (await f.frame(1, prefixes, 'transfer'))) frames++
    // 64 MiB charged twice per frame: about 2048 frames of 16 KiB, no more.
    expect(frames).toBeGreaterThanOrEqual(2040)
    expect(frames).toBeLessThanOrEqual(2048)
    f.scheduler.close()
  })

  it('holds a bursting prefix to its share once another arrives, and serves the newcomer on arrival', async () => {
    const f = shaped()
    for (let i = 0; i < 700; i++) f.step(100)
    const first = f.scheduler.wait(2, ['192.0.2.0/24'], 'a', 16_384, true)
    f.step(1)
    expect(await first).toBe(true)
    // A spends part of the burst, then B arrives and both are given their share at the next tick.
    for (let index = 0; index < 100; index++) expect(await f.frame(1, ['192.0.2.0/24'], 'a')).toBe(true)
    const waiting = f.scheduler.wait(4, ['198.51.100.0/24'], 'b', 16_384, true)
    f.step(1)
    expect(await waiting).toBe(true)
    f.scheduler.wait(5, ['198.51.100.0/24'], 'b', 16_384, true)
    await Promise.resolve()
    let a = 0,
      b = 0
    for (let round = 0; round < 3000; round++) {
      const left = await f.frame(1, ['192.0.2.0/24'], 'a'),
        right = await f.frame(2, ['198.51.100.0/24'], 'b')
      if (left) a++
      if (right) b++
      if (!left && !right) break
    }
    // What is left of the burst splits about evenly, all of it granted on arrival with the clock standing still.
    expect(b).toBeGreaterThan(900)
    expect(Math.abs(a - b)).toBeLessThan(120)
    f.scheduler.close()
  })
})
