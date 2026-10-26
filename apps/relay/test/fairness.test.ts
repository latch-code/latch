import { describe, expect, it } from 'vitest'
import { FairScheduler } from '../src/fairness.ts'
function fixture(options: { share?: number; factor?: number; maxBytes?: number } = {}) {
  let now = 0,
    rate = 1000,
    healthy = true
  const scheduler = new FairScheduler({
    quota: () => ({ healthy, calibrated: true, rate, burstBytes: 1000, dayEndsAt: 86400000, dailyBudget: 1000000 }),
    maxQueuedBytes: options.maxBytes ?? 100000,
    maxConnections: 100,
    prefixDailyShare: options.share ?? 1,
    overageFactor: options.factor ?? 0.1,
    count: 'out',
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

it('reports repeatable bounded tick cost without inventing production handshake capacity', async () => {
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
  const durations: number[] = []
  for (let round = 0; round < 20; round++) {
    const pending = Array.from({ length: 1024 }, (_, id) => scheduler.wait(id, [`group-${id}`], `route-${id}`, 1))
    now += 20
    const start = performance.now()
    scheduler.tick()
    durations.push(performance.now() - start)
    expect((await Promise.all(pending)).every(Boolean)).toBe(true)
    expect(scheduler.status().queuedBytes).toBe(0)
  }
  durations.sort((a, b) => a - b)
  console.info(JSON.stringify({ benchmark: 'relay-fair-tick', connections: 1024, samples: 20, p95Ms: durations[18] }))
  scheduler.close()
})
