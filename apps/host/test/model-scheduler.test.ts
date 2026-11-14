import { describe, expect, it } from 'vitest'
import type { ModelFailureClass } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { ModelScheduler, SCHEDULE, classifyStatus, retryAfterMs, type AttemptResult, type SchedulerClock } from '../src/model-scheduler.ts'
import { manualClock } from './helpers/manual-clock.ts'

type Sorted = Exclude<ModelFailureClass, 'unavailable' | 'circuit-open'>
/** `late`: answers after 200 seconds. `headers`: says its reply began, then answers after 200 seconds. `permit`: waits 100 seconds for the Host's permit, then never answers. */
type Script = Array<
  Sorted | 'ok' | 'skip' | 'hang' | 'late' | 'headers' | 'permit' | 'unsent' | 'busy' | { class: Sorted; retryAfterMs: number }
>

const A = { providerId: 'a', fingerprint: 'a1' }
const B = { providerId: 'b', fingerprint: 'b1' }
const C = { providerId: 'c', fingerprint: 'c1' }

/** A scheduler on a clock the test moves, and requests whose tries follow a script per service. */
function setup(
  deps: { limit?: (id: string) => number | undefined; random?: number; fingerprint?: (id: string) => string | undefined } = {},
) {
  const time = manualClock(deps.random ?? 0.5)
  const queued: Array<[string, string | undefined]> = []
  const schedulerRef: { current?: ModelScheduler } = {}
  const scheduler = new ModelScheduler({
    clock: time.clock as SchedulerClock,
    ...(deps.limit ? { limit: deps.limit } : {}),
    ...(deps.fingerprint ? { fingerprint: deps.fingerprint } : {}),
    queued: sessionId => void queued.push([sessionId, schedulerRef.current?.queueOf(sessionId)?.providerId]),
  })
  schedulerRef.current = scheduler
  const scripts = new Map<string, Script>()
  const tried: string[] = []
  const switches: Array<{ from: string; to: string; reason: ModelFailureClass; tried: number }> = []
  const send = (
    candidates = [A, B],
    options: {
      start?: number
      signal?: AbortSignal
      audit?: () => Promise<void>
      sessionId?: string
      firstByte?: boolean
      retryServer?: boolean
    } = {},
  ) =>
    scheduler.dispatch<string, string>({
      sessionId: options.sessionId ?? 'session',
      candidates,
      ...(options.start !== undefined ? { start: options.start } : {}),
      signal: options.signal ?? new AbortController().signal,
      ...(options.firstByte !== undefined ? { firstByte: options.firstByte } : {}),
      ...(options.retryServer !== undefined ? { retryServer: options.retryServer } : {}),
      attempt: async (index, signal, timer): Promise<AttemptResult<string, string>> => {
        const id = candidates[index]!.providerId
        tried.push(id)
        const next = scripts.get(id)?.shift() ?? 'ok'
        if (next === 'ok') return { ok: true, value: id }
        // No connection was made, as against one that broke after the request went out.
        if (next === 'unsent') return { ok: false, class: 'network', unsent: true, reply: `${id}:unsent` }
        if (next === 'busy') throw new AppError(429, 'gateway-busy', 'busy')
        if (next === 'skip') return { skip: true }
        const never = () =>
          new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true }))
        if (next === 'late' || next === 'headers') {
          if (next === 'headers') timer.began()
          await time.clock.sleep(200_000, signal)
          return { ok: true, value: id }
        }
        if (next === 'permit') {
          await timer.waiting(time.clock.sleep(100_000, signal))
          return never()
        }
        if (next === 'hang')
          return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true }))
        return typeof next === 'string'
          ? { ok: false, class: next, reply: `${id}:${next}` }
          : { ok: false, class: next.class, retryAfterMs: next.retryAfterMs, reply: `${id}:${next.class}` }
      },
      timedOut: index => `${candidates[index]!.providerId}:timeout`,
      beforeSwitch: async (from, to, reason) => {
        await options.audit?.()
        switches.push({ from: candidates[from]!.providerId, to: candidates[to]!.providerId, reason, tried: tried.length })
      },
    })
  return { time, scheduler, scripts, tried, switches, queued, send }
}

/** Moves the clock through every pause a request makes until it settles. */
async function settle<T>(time: ReturnType<typeof manualClock>, request: Promise<T>): Promise<T> {
  let done = false
  void request.then(
    () => (done = true),
    () => (done = true),
  )
  for (let step = 0; step < 200 && !done; step++) {
    await time.flush()
    const next = time.pending()[0]
    if (!done && next !== undefined) await time.advance(next)
  }
  return request
}

describe('how a failed answer is sorted', () => {
  it("reads the status and a balance error's words, and retry-after as seconds or a date", () => {
    expect([400, 404, 405, 413, 422, 501].map(status => classifyStatus(status))).toEqual(Array(6).fill('request'))
    expect(classifyStatus(401)).toBe('auth')
    // A 403 is the key's fault only when the service says so.
    expect(classifyStatus(403, '{"error":{"message":"Invalid API key provided"}}')).toBe('auth')
    expect(classifyStatus(403, '{"error":{"message":"This model is not available in your region"}}')).toBe('forbidden')
    expect(classifyStatus(403)).toBe('forbidden')
    expect(classifyStatus(402)).toBe('quota')
    expect(classifyStatus(429, '{"error":{"code":"insufficient_quota"}}')).toBe('quota')
    expect(classifyStatus(429)).toBe('rate')
    expect([500, 502, 503, 504, 529].map(status => classifyStatus(status))).toEqual(Array(5).fill('server'))
    expect(retryAfterMs('7', 0)).toBe(7000)
    expect(retryAfterMs('Thu, 01 Jan 1970 00:00:09 GMT', 4000)).toBe(5000)
    expect(retryAfterMs('soon', 0)).toBeUndefined()
    expect(retryAfterMs(null, 0)).toBeUndefined()
  })
})

describe('model scheduler', () => {
  it("answers a request's own fault as it is: no other candidate, and nothing held against the service", async () => {
    const { scripts, send, tried, switches, scheduler } = setup()
    scripts.set('a', Array<Sorted>(12).fill('request'))
    for (let count = 0; count < 12; count++)
      expect(await send()).toMatchObject({ ok: false, index: 0, failure: { class: 'request', reply: 'a:request' } })
    expect(tried).toEqual(Array(12).fill('a'))
    expect(switches).toEqual([])
    expect(scheduler.health('a')).toBeUndefined()
  })

  it('moves on from a refused key at once, says the key is invalid, and prefers other services until it works again', async () => {
    const { scripts, send, tried, switches, scheduler } = setup()
    scripts.set('a', ['auth'])
    const first = await send()
    expect(first).toMatchObject({ ok: true, index: 1, value: 'b' })
    if (first.ok) first.done('complete')
    expect(tried).toEqual(['a', 'b'])
    expect(switches).toEqual([{ from: 'a', to: 'b', reason: 'auth', tried: 1 }])
    expect(scheduler.health('a')).toMatchObject({ state: 'key-invalid', last: 'auth' })
    // The next request starts at the other service, on record as a switch for the same reason.
    const second = await send()
    expect(second).toMatchObject({ ok: true, index: 1 })
    expect(switches.at(-1)).toMatchObject({ from: 'a', to: 'b', reason: 'auth' })
    // Alone, it is still asked: only a real request shows the key works again.
    const alone = await send([A])
    expect(alone).toMatchObject({ ok: true, index: 0 })
    if (alone.ok) alone.done('complete')
    expect(scheduler.health('a')).toBeUndefined()
  })

  it('rests a service that ran out of balance for 30 minutes, then 2 hours, 8 hours and a day', async () => {
    const { time, scripts, send, scheduler } = setup()
    const rests: number[] = []
    for (let round = 0; round < 5; round++) {
      scripts.set('a', ['quota'])
      const result = await send()
      expect(result).toMatchObject({ ok: true, index: 1 })
      const health = scheduler.health('a')
      expect(health).toMatchObject({ state: 'quota', last: 'quota' })
      rests.push(Date.parse(health!.until!) - time.clock.now())
      // While it rests the other service is tried first.
      scripts.set('a', [])
      expect(await send()).toMatchObject({ ok: true, index: 1 })
      await time.advance(rests.at(-1)!)
      expect(scheduler.health('a')?.state).not.toBe('quota')
      await time.advance(SCHEDULE.breaker.openMs)
    }
    expect(rests).toEqual([30 * 60_000, 2 * 3_600_000, 8 * 3_600_000, 24 * 3_600_000, 24 * 3_600_000])
  })

  it('takes one step of the ladder for requests that ran out of balance together, and starts over after one success', async () => {
    const { time, scripts, send, scheduler } = setup()
    // Three requests under way when the balance ran out: one rest of 30 minutes, not three steps.
    scripts.set('a', ['quota', 'quota', 'quota'])
    await Promise.all([send(), send(), send()])
    const rest = () => Date.parse(scheduler.health('a')!.until!) - time.clock.now()
    expect(rest()).toBe(30 * 60_000)
    // Asked as a last resort while it rests and refused again: the rest is neither longer nor a step further.
    await time.advance(10 * 60_000)
    scripts.set('a', ['quota'])
    expect(await send([A])).toMatchObject({ ok: false, failure: { class: 'quota' } })
    expect(rest()).toBe(20 * 60_000)
    await time.advance(20 * 60_000)
    scripts.set('a', ['quota'])
    await send()
    expect(rest()).toBe(2 * 3_600_000)
    // One success, and the next time it runs out it is 30 minutes again.
    await time.advance(2 * 3_600_000)
    const fine = await send([A])
    expect(fine.ok).toBe(true)
    if (fine.ok) fine.done('complete')
    scripts.set('a', ['quota'])
    await send()
    expect(rest()).toBe(30 * 60_000)
  })

  it('moves on from a 429 when there is another candidate', async () => {
    const { scripts, send, tried, switches } = setup()
    scripts.set('a', [{ class: 'rate', retryAfterMs: 2000 }])
    expect(await send()).toMatchObject({ ok: true, index: 1 })
    expect(tried).toEqual(['a', 'b'])
    expect(switches).toMatchObject([{ from: 'a', to: 'b', reason: 'rate' }])
  })

  it('waits once for a 429 that asks for no more than 10 seconds, and hands a longer or a second one back', async () => {
    const { time, scripts, send, tried } = setup()
    scripts.set('a', [{ class: 'rate', retryAfterMs: 10_000 }])
    const waited = send([A])
    await time.flush()
    expect(time.pending()).toContain(10_000)
    expect(tried).toEqual(['a'])
    await time.advance(10_000)
    expect(await waited).toMatchObject({ ok: true, index: 0 })
    expect(tried).toEqual(['a', 'a'])

    scripts.set('a', [{ class: 'rate', retryAfterMs: 10_001 }])
    expect(await send([A])).toMatchObject({ ok: false, failure: { class: 'rate', retryAfterMs: 10_001, reply: 'a:rate' } })
    // A second 429 after the one wait goes back as it is; so does one that names no time.
    const again = setup()
    again.scripts.set('a', [
      { class: 'rate', retryAfterMs: 1000 },
      { class: 'rate', retryAfterMs: 1000 },
    ])
    expect(await settle(again.time, again.send([A]))).toMatchObject({ ok: false, failure: { class: 'rate' } })
    expect(again.tried).toEqual(['a', 'a'])
    again.scripts.set('a', ['rate'])
    expect(await again.send([A])).toMatchObject({ ok: false, failure: { class: 'rate' } })
    expect(again.tried).toEqual(['a', 'a', 'a'])
  })

  it.each([
    { random: 0, pauses: [700, 2100] },
    { random: 0.5, pauses: [1000, 3000] },
    { random: 0.999999, pauses: [1300, 3900] },
  ])("tries a service's own failure twice more after 1 and 3 seconds ±30%, then the next (random $random)", async ({ random, pauses }) => {
    const { time, scripts, send, tried, switches } = setup({ random })
    scripts.set('a', ['server', 'network', 'server'])
    const request = send()
    await time.flush()
    expect(tried).toEqual(['a'])
    expect(time.pending().map(Math.round)).toEqual([pauses[0]])
    await time.advance(time.pending()[0]! - 1)
    expect(tried).toEqual(['a'])
    await time.advance(1)
    expect(tried).toEqual(['a', 'a'])
    expect(time.pending().map(Math.round)).toEqual([pauses[1]])
    await time.advance(time.pending()[0]!)
    expect(await request).toMatchObject({ ok: true, index: 1 })
    expect(tried).toEqual(['a', 'a', 'a', 'b'])
    expect(switches).toEqual([{ from: 'a', to: 'b', reason: 'server', tried: 3 }])
  })

  it('leaves a service that says nothing for 60 seconds at once when there is another candidate, on the first request', async () => {
    const { time, scripts, send, tried, switches, scheduler } = setup()
    scripts.set('a', ['hang'])
    const started = time.clock.now()
    const request = send()
    await time.flush()
    expect(time.pending()).toEqual([60_000])
    await time.advance(60_000)
    // No pause and no second try at the silent service: the next candidate answers within the same request.
    expect(await request).toMatchObject({ ok: true, index: 1, value: 'b' })
    expect(time.clock.now() - started).toBe(60_000)
    expect(tried).toEqual(['a', 'b'])
    expect(switches).toEqual([{ from: 'a', to: 'b', reason: 'timeout', tried: 1 }])
    // The silence still counts against the service.
    scripts.set('a', ['hang', 'hang', 'hang'])
    for (let count = 0; count < 3; count++) {
      const next = send()
      await time.flush()
      await time.advance(60_000)
      expect(await next).toMatchObject({ ok: true, index: 1 })
    }
    expect(scheduler.health('a')).toMatchObject({ state: 'failing', last: 'timeout' })
  })

  it('never asks a silent service again: with no other candidate the timeout is the answer at 60 seconds', async () => {
    const { time, scripts, send, tried } = setup()
    scripts.set('a', ['hang', 'ok'])
    const started = time.clock.now()
    const request = send([A])
    await time.flush()
    expect(time.pending()).toEqual([60_000])
    await time.advance(60_000)
    // Sent again, a request that was only slow would run twice: the failure goes back as it is.
    expect(await request).toMatchObject({ ok: false, index: 0, failure: { class: 'timeout', reply: 'a:timeout' } })
    expect(time.clock.now() - started).toBe(60_000)
    expect(tried).toEqual(['a'])
    expect(time.pending()).toEqual([])
  })

  it('puts no first-byte limit on an answer that comes whole, and holds nothing against a service for taking long', async () => {
    const { time, scripts, send, tried, scheduler } = setup()
    for (let count = 0; count < 5; count++) {
      scripts.set('a', ['late'])
      const request = send([A, B], { firstByte: false })
      await time.flush()
      // Only the answer's own 200 seconds are pending: no limit runs beside it.
      expect(time.pending()).toEqual([200_000])
      await time.advance(200_000)
      const result = await request
      expect(result).toMatchObject({ ok: true, index: 0, value: 'a' })
      if (result.ok) result.done('complete')
    }
    expect(tried).toEqual(Array(5).fill('a'))
    expect(scheduler.health('a')).toBeUndefined()
  })

  it('ends the first-byte limit when the reply begins, however long the model then thinks before it says anything', async () => {
    const { time, scripts, send, tried, scheduler } = setup()
    scripts.set('a', ['headers'])
    const request = send([A, B])
    await time.flush()
    expect(time.pending()).toEqual([200_000])
    await time.advance(200_000)
    const result = await request
    expect(result).toMatchObject({ ok: true, index: 0 })
    if (result.ok) result.done('complete')
    expect(tried).toEqual(['a'])
    expect(scheduler.health('a')).toBeUndefined()
  })

  it("does not count waiting for the Host's own permit as the service's silence", async () => {
    const { time, scripts, send, tried, switches } = setup()
    scripts.set('a', ['permit'])
    const request = send([A, B])
    await time.flush()
    // The limit stands still while the request waits its turn.
    expect(time.pending()).toEqual([100_000])
    await time.advance(100_000)
    expect(tried).toEqual(['a'])
    // Then the service has its whole 60 seconds.
    expect(time.pending()).toEqual([60_000])
    await time.advance(59_999)
    expect(tried).toEqual(['a'])
    await time.advance(1)
    expect(await request).toMatchObject({ ok: true, index: 1 })
    expect(switches).toMatchObject([{ from: 'a', to: 'b', reason: 'timeout' }])
  })

  it.each(['server', 'timeout', 'network'] as const)(
    'answers with a %s failure as it is when the request may already have run there: not again in place, and not at another service',
    async failure => {
      const { time, scripts, send, tried, switches } = setup()
      scripts.set('a', [failure === 'timeout' ? 'hang' : failure, 'ok'])
      const request = send([A, B], { retryServer: false })
      const result = await settle(time, request)
      expect(result).toMatchObject({ ok: false, index: 0, failure: { class: failure } })
      // One try, and nothing on record: the tools the service runs itself cannot have run twice.
      expect(tried).toEqual(['a'])
      expect(switches).toEqual([])
    },
  )

  it('still moves such a request on, or tries it again, after a failure that proves it never ran', async () => {
    for (const proof of ['auth', 'forbidden', 'quota', 'rate'] as const) {
      const { scripts, send, tried } = setup()
      scripts.set('a', [proof])
      expect(await send([A, B], { retryServer: false })).toMatchObject({ ok: true, index: 1 })
      expect(tried).toEqual(['a', 'b'])
    }
    // No connection was ever made: the same service again, as for any request.
    const unreachable = setup()
    unreachable.scripts.set('a', ['unsent', 'unsent'])
    expect(await settle(unreachable.time, unreachable.send([A], { retryServer: false }))).toMatchObject({ ok: true, index: 0 })
    expect(unreachable.tried).toEqual(['a', 'a', 'a'])
  })

  it("answers with the first service's real failure when the candidate after it is full or the Host is busy", async () => {
    // The fallback's own place is taken: 30 seconds on, the answer is the refused key, not gateway-busy.
    const full = setup({ limit: id => (id === 'b' ? 1 : undefined) })
    const holder = await full.send([B], { sessionId: 'holder' })
    full.scripts.set('a', ['auth'])
    const request = full.send([A, B])
    await full.time.flush()
    await full.time.advance(30_000)
    expect(await request).toMatchObject({ ok: false, index: 0, failure: { class: 'auth', reply: 'a:auth' } })
    if (holder.ok) holder.done('complete')
    // The same when the wait that ran out was for the Host's own permit, inside the try.
    const busy = setup()
    busy.scripts.set('a', ['quota'])
    busy.scripts.set('b', ['busy'])
    expect(await busy.send([A, B])).toMatchObject({ ok: false, index: 0, failure: { class: 'quota' } })
    // With nothing failed before it, busy is the answer.
    const first = setup()
    first.scripts.set('a', ['busy'])
    await expect(first.send([A, B])).rejects.toMatchObject({ code: 'gateway-busy' })
  })

  it('does not call a service failing for answering 429 or running out of balance: each has its own state and time', async () => {
    const { time, scripts, send, tried, scheduler } = setup()
    // Six 429s in a row from a service with no other candidate: limited, never 出错中, and still asked.
    for (let count = 0; count < 6; count++) {
      scripts.set('a', [{ class: 'rate', retryAfterMs: 20_000 }])
      expect(await send([A])).toMatchObject({ ok: false, failure: { class: 'rate' } })
    }
    expect(tried).toHaveLength(6)
    expect(scheduler.health('a')).toMatchObject({ state: 'rate', last: 'rate' })
    expect(Date.parse(scheduler.health('a')!.until!) - time.clock.now()).toBe(20_000)
    // Other services come first while it lasts, on record as that.
    const other = setup()
    other.scripts.set('a', [{ class: 'rate', retryAfterMs: 20_000 }])
    await other.send()
    other.tried.length = 0
    expect(await other.send()).toMatchObject({ ok: true, index: 1 })
    expect(other.switches.at(-1)).toMatchObject({ from: 'a', to: 'b', reason: 'rate' })
    await other.time.advance(20_000)
    expect(other.scheduler.health('a')).toBeUndefined()
    other.tried.length = 0
    expect(await other.send()).toMatchObject({ ok: true, index: 0 })
    // A spent balance: resting, not failing, however many requests ran into it.
    const spent = setup()
    spent.scripts.set('a', Array<Sorted>(6).fill('quota'))
    for (let count = 0; count < 6; count++) await spent.send([A])
    expect(spent.tried).toHaveLength(6)
    expect(spent.scheduler.health('a')).toMatchObject({ state: 'quota' })
    await time.flush()
  })

  it("passes over a later candidate that refuses the request itself, and answers with the first service's real failure", async () => {
    const { scripts, send, tried, switches } = setup()
    scripts.set('a', ['auth'])
    scripts.set('b', ['request'])
    scripts.set('c', ['request'])
    expect(await send([A, B, C])).toMatchObject({ ok: false, index: 0, failure: { class: 'auth', reply: 'a:auth' } })
    expect(tried).toEqual(['a', 'b', 'c'])
    expect(switches.map(({ from, to, reason }) => [from, to, reason])).toEqual([
      ['a', 'b', 'auth'],
      ['b', 'c', 'unavailable'],
    ])
    // One that takes it still answers.
    const other = setup()
    other.scripts.set('a', ['auth'])
    other.scripts.set('b', ['request'])
    expect(await other.send([A, B, C])).toMatchObject({ ok: true, index: 2 })
    // A refusal is nothing against the candidate's service.
    expect(other.scheduler.health('b')).toBeUndefined()
  })

  it('moves on from a 403 that is not about the key without calling the key invalid, and lets an invalid key be asked again after a minute', async () => {
    const { time, scripts, send, tried, scheduler } = setup()
    scripts.set('a', ['forbidden'])
    expect(await send()).toMatchObject({ ok: true, index: 1 })
    expect(tried).toEqual(['a', 'b'])
    expect(scheduler.health('a')).toBeUndefined()
    // The next request starts at the first service again: nothing holds it back.
    tried.length = 0
    expect(await send()).toMatchObject({ ok: true, index: 0 })
    scripts.set('a', ['auth'])
    await send()
    expect(scheduler.health('a')).toMatchObject({ state: 'key-invalid', until: expect.any(String) })
    tried.length = 0
    expect(await send()).toMatchObject({ ok: true, index: 1 })
    expect(tried).toEqual(['b'])
    // A minute on, a real request asks it first again: a key fixed at the service shows without anyone saving it anew.
    await time.advance(60_000)
    expect(scheduler.health('a')).toBeUndefined()
    tried.length = 0
    const again = await send()
    expect(again).toMatchObject({ ok: true, index: 0 })
    expect(tried).toEqual(['a'])
  })

  it('stops saying a service is failing once its minute is over, until a real request fails there again', async () => {
    const { time, scripts, send, scheduler } = setup()
    scripts.set('a', ['forbidden', 'forbidden', 'forbidden', 'forbidden'])
    for (let count = 0; count < 4; count++) await send([A])
    expect(scheduler.health('a')).toMatchObject({ state: 'failing', until: expect.any(String) })
    await time.advance(60_000)
    expect(scheduler.health('a')).toBeUndefined()
    scripts.set('a', ['forbidden'])
    await send([A])
    expect(scheduler.health('a')).toMatchObject({ state: 'failing' })
  })

  it('stops sending after four failures in a row, lets one real request try after a minute, and opens to all as soon as it begins to answer', async () => {
    const { time, scripts, send, tried, scheduler } = setup()
    // A plain 403 does not retry, so each request is one failure.
    scripts.set('a', ['forbidden', 'forbidden', 'forbidden', 'forbidden'])
    for (let count = 0; count < 4; count++) expect(await send([A])).toMatchObject({ ok: false, failure: { class: 'forbidden' } })
    expect(tried).toHaveLength(4)
    const held = await send([A])
    expect(held).toMatchObject({ ok: false, retryAfterMs: 60_000 })
    expect(held.ok ? undefined : held.failure).toBeUndefined()
    expect(tried).toHaveLength(4)
    await time.advance(59_999)
    expect((await send([A])).ok).toBe(false)
    expect(tried).toHaveLength(4)
    await time.advance(1)
    // Half open: exactly one request goes while nothing is known yet; another arriving meanwhile does not.
    scripts.set('a', ['late'])
    const trial = send([A], { firstByte: false })
    await time.flush()
    expect(tried).toHaveLength(5)
    expect((await send([A])).ok).toBe(false)
    expect(tried).toHaveLength(5)
    // Its reply begins: the service answers, so others are let through at once, long before that reply ends.
    await time.advance(200_000)
    const began = await trial
    expect(began.ok).toBe(true)
    expect(scheduler.health('a')).toBeUndefined()
    expect(await send([A])).toMatchObject({ ok: true })
    expect(tried).toHaveLength(6)
    // How the trial's reply ends is counted like any reply's: one break is one failure, not a closed door.
    if (began.ok) began.done('broken')
    expect(scheduler.health('a')).toBeUndefined()
    expect(await send([A])).toMatchObject({ ok: true })
  })

  it('gives the trial place back when its request is given up on before any answer, and opens again when the trial fails', async () => {
    const { time, scripts, send, tried, scheduler } = setup()
    scripts.set('a', ['forbidden', 'forbidden', 'forbidden', 'forbidden'])
    for (let count = 0; count < 4; count++) await send([A])
    await time.advance(60_000)
    // The harness goes away before the trial's reply began: the place is free for the next real request.
    scripts.set('a', ['hang'])
    const leaving = new AbortController()
    const left = send([A], { signal: leaving.signal })
    const gone = expect(left).rejects.toThrow('gone')
    await time.flush()
    expect((await send([A])).ok).toBe(false)
    leaving.abort(new Error('gone'))
    await gone
    scripts.set('a', ['server'])
    expect(await send([A])).toMatchObject({ ok: false, failure: { class: 'server' } })
    // A failed trial is not tried again in place, and holds everything back for another minute.
    expect(tried.slice(4)).toEqual(['a', 'a'])
    expect(scheduler.health('a')).toMatchObject({ state: 'failing', last: 'server' })
    expect((await send([A])).ok).toBe(false)
    expect(tried).toHaveLength(6)
    await time.advance(60_000)
    expect((await send([A])).ok).toBe(true)
  })

  it('opens when half of at least ten requests in two minutes failed, though never four in a row', async () => {
    const { time, scripts, send, scheduler } = setup()
    for (let count = 0; count < 5; count++) {
      scripts.set('a', ['forbidden'])
      await send([A])
      const fine = await send([A])
      if (fine.ok) fine.done('complete')
      expect(scheduler.health('a')).toBeUndefined()
      await time.advance(1000)
    }
    // Ten requests, five failed, the last a success: one more failure makes it six of eleven.
    scripts.set('a', ['server'])
    const request = send([A])
    expect(await settle(time, request)).toMatchObject({ ok: false })
    expect(scheduler.health('a')).toMatchObject({ state: 'failing', last: 'server' })
    // Old results fall out of the window: failures two minutes back no longer count.
    const other = setup()
    for (let count = 0; count < 3; count++) {
      other.scripts.set('a', ['forbidden'])
      await other.send([A])
      const fine = await other.send([A])
      if (fine.ok) fine.done('complete')
    }
    await other.time.advance(SCHEDULE.breaker.windowMs + 1)
    for (let count = 0; count < 2; count++) {
      other.scripts.set('a', ['forbidden'])
      await other.send([A])
      const fine = await other.send([A])
      if (fine.ok) fine.done('complete')
    }
    expect(other.scheduler.health('a')).toBeUndefined()
  })

  it('counts a reply that broke after it began against the service, and never one the caller gave up on', async () => {
    const { send, scheduler } = setup()
    for (let count = 0; count < 4; count++) {
      const reply = await send([A])
      if (reply.ok) reply.done('aborted')
    }
    expect(scheduler.health('a')).toBeUndefined()
    for (let count = 0; count < 4; count++) {
      const reply = await send([A])
      if (reply.ok) reply.done('broken')
    }
    expect(scheduler.health('a')).toMatchObject({ state: 'failing', last: 'stream' })
  })

  it("starts where the turn moved to, and at the first candidate again once that one's service is held back", async () => {
    const { time, scripts, send, tried, switches } = setup()
    expect(await send([A, B, C], { start: 1 })).toMatchObject({ ok: true, index: 1 })
    expect(tried).toEqual(['b'])
    // Staying where the turn already is needs no new record.
    expect(switches).toEqual([])
    scripts.set('b', ['auth', 'auth', 'auth', 'auth'])
    for (let count = 0; count < 4; count++) await send([B])
    tried.length = 0
    expect(await send([A, B, C], { start: 1 })).toMatchObject({ ok: true, index: 0 })
    expect(tried).toEqual(['a'])
    // A service that is held back goes last, and is passed over while it is.
    scripts.set('a', ['auth'])
    tried.length = 0
    expect(await send([A, B, C])).toMatchObject({ ok: true, index: 2 })
    expect(tried).toEqual(['a', 'c'])
    await time.advance(60_000)
  })

  it('passes over a candidate that cannot take the request, on record like any other switch', async () => {
    const { scripts, send, tried, switches } = setup()
    scripts.set('a', ['auth'])
    scripts.set('b', ['skip'])
    expect(await send([A, B, C])).toMatchObject({ ok: true, index: 2 })
    expect(tried).toEqual(['a', 'b', 'c'])
    expect(switches.map(({ from, to, reason }) => [from, to, reason])).toEqual([
      ['a', 'b', 'auth'],
      ['b', 'c', 'unavailable'],
    ])
  })

  it('writes the switch before anything goes to the next candidate, and stays put when it cannot be written', async () => {
    const { scripts, send, tried, switches } = setup()
    scripts.set('a', ['auth'])
    await send()
    // One request had been tried when the record was written: the next candidate's came after.
    expect(switches).toEqual([{ from: 'a', to: 'b', reason: 'auth', tried: 1 }])
    const failing = setup()
    failing.scripts.set('a', ['quota'])
    const result = await failing.send([A, B], { audit: () => Promise.reject(new Error('disk full')) })
    expect(result).toMatchObject({ ok: false, index: 0, failure: { class: 'quota', reply: 'a:quota' } })
    expect(failing.tried).toEqual(['a'])
    // Held back and unrecorded: the first candidate is still the one asked.
    failing.tried.length = 0
    failing.scripts.set('a', [])
    expect(await failing.send([A, B], { audit: () => Promise.reject(new Error('disk full')) })).toMatchObject({ ok: true, index: 0 })
    expect(failing.tried).toEqual(['a'])
    expect(tried).toEqual(['a', 'b'])
  })

  it('keeps a service at its own limit, admits waiting requests in order, and says which session waits for which service', async () => {
    const limits = new Map([['a', 1]])
    const { time, send, queued, scheduler } = setup({ limit: id => limits.get(id) })
    const first = await send([A], { sessionId: 'one' })
    expect(first.ok).toBe(true)
    const order: string[] = []
    const second = send([A], { sessionId: 'two' }).then(result => (order.push('two'), result))
    const third = send([A], { sessionId: 'three' }).then(result => (order.push('three'), result))
    await time.flush()
    expect(order).toEqual([])
    expect(scheduler.queueOf('two')).toEqual({ providerId: 'a' })
    expect(queued).toEqual([
      ['two', 'a'],
      ['three', 'a'],
    ])
    // Another service is not held up by this one's limit.
    expect((await send([B], { sessionId: 'four' })).ok).toBe(true)
    if (first.ok) first.done('complete')
    const admitted = await second
    expect(order).toEqual(['two'])
    expect(scheduler.queueOf('two')).toBeUndefined()
    expect(scheduler.queueOf('three')).toEqual({ providerId: 'a' })
    if (admitted.ok) admitted.done('complete')
    const last = await third
    expect(order).toEqual(['two', 'three'])
    expect(queued.slice(2)).toEqual([
      ['two', undefined],
      ['three', undefined],
    ])
    if (last.ok) last.done('complete')
  })

  it('answers gateway-busy when no place frees in 30 seconds, and forgets a waiting request that is given up on', async () => {
    const { time, send, scheduler } = setup({ limit: () => 1 })
    const holding = await send([A])
    const waiting = send([A], { sessionId: 'two' })
    const refused = expect(waiting).rejects.toMatchObject({ status: 429, code: 'gateway-busy' })
    await time.flush()
    await time.advance(29_999)
    expect(scheduler.queueOf('two')).toEqual({ providerId: 'a' })
    await time.advance(1)
    await refused
    expect(scheduler.queueOf('two')).toBeUndefined()
    const leaving = new AbortController()
    const left = send([A], { sessionId: 'three', signal: leaving.signal })
    const gone = expect(left).rejects.toThrow('gone')
    await time.flush()
    leaving.abort(new Error('gone'))
    await gone
    expect(scheduler.queueOf('three')).toBeUndefined()
    // The place it never took is still the holder's alone.
    if (holding.ok) holding.done('complete')
    expect((await send([A])).ok).toBe(true)
    expect(time.pending()).toEqual([])
  })

  it("never tries a candidate bound to a service's older settings, and never lets it clear what is known of the service", async () => {
    let current = 'a2'
    const { time, scripts, send, tried, switches, scheduler } = setup({ fingerprint: id => (id === 'a' ? current : `${id}1`) })
    const OLD = { providerId: 'a', fingerprint: 'a1' }
    const NOW = { providerId: 'a', fingerprint: 'a2' }
    // An older process, still holding the service as it was, and a new session take turns.
    scripts.set('a', ['forbidden', 'forbidden', 'forbidden', 'forbidden'])
    for (let count = 0; count < 4; count++) {
      expect(await send([B, OLD])).toMatchObject({ ok: true, index: 0 })
      expect(await send([NOW])).toMatchObject({ ok: false, failure: { class: 'forbidden' } })
    }
    // Four failures in a row all the same: the stale candidate reset nothing in between, and was never asked.
    expect(tried.filter(id => id === 'a')).toHaveLength(4)
    expect(scheduler.health('a')).toMatchObject({ state: 'failing' })
    expect((await send([NOW])).ok).toBe(false)
    // Half open: one trial, whoever else asks meanwhile.
    await time.advance(60_000)
    scripts.set('a', ['hang'])
    const leaving = new AbortController()
    const trial = send([NOW], { signal: leaving.signal })
    const gone = expect(trial).rejects.toThrow('gone')
    await time.flush()
    expect(await send([B, OLD])).toMatchObject({ ok: true, index: 0 })
    expect((await send([NOW])).ok).toBe(false)
    expect(tried.filter(id => id === 'a')).toHaveLength(5)
    leaving.abort(new Error('gone'))
    await gone
    // Only the service's own new settings start it afresh.
    current = 'a3'
    expect(await send([{ providerId: 'a', fingerprint: 'a3' }])).toMatchObject({ ok: true })
    expect(scheduler.health('a')).toBeUndefined()
    expect(switches).toEqual([])
  })

  it('answers that the service changed when the first candidate is stale: never a move to the next one that nobody recorded', async () => {
    const { send, tried, switches } = setup({ fingerprint: id => `${id}2` })
    // The session's own service was edited while the run was under way; its fallback is as it was bound.
    const result = await send([
      { providerId: 'a', fingerprint: 'a1' },
      { providerId: 'b', fingerprint: 'b2' },
    ])
    expect(result).toEqual({ ok: false, changed: true })
    expect(tried).toEqual([])
    expect(switches).toEqual([])
  })

  it("names no service while a session waits for the Host's own permit, and the service while it waits for that service's place", async () => {
    const { scheduler, queued } = setup()
    const host = scheduler.waiting('one')
    expect(scheduler.queueOf('one')).toEqual({})
    const place = scheduler.waiting('one', 'a')
    expect(scheduler.queueOf('one')).toEqual({ providerId: 'a' })
    place()
    expect(scheduler.queueOf('one')).toEqual({})
    host()
    expect(scheduler.queueOf('one')).toBeUndefined()
    expect(queued).toEqual([
      ['one', undefined],
      ['one', 'a'],
      ['one', undefined],
      ['one', undefined],
    ])
  })

  it('forgets what it held against a service once its key, address or models changed', async () => {
    const { scripts, send, scheduler } = setup()
    scripts.set('a', ['auth'])
    await send([A])
    expect(scheduler.health('a')?.state).toBe('key-invalid')
    expect(await send([{ providerId: 'a', fingerprint: 'a2' }])).toMatchObject({ ok: true })
    expect(scheduler.health('a')).toBeUndefined()
  })

  it('says a service is slow when its latest first bytes take three times what they used to', async () => {
    const { time, scheduler } = setup()
    const timed = async (ms: number) => {
      const result = await scheduler.dispatch<string, string>({
        sessionId: 'session',
        candidates: [A],
        signal: new AbortController().signal,
        attempt: async () => {
          await time.advance(ms)
          return { ok: true, value: 'a' }
        },
        timedOut: () => 'timeout',
        beforeSwitch: async () => {},
      })
      if (result.ok) result.done('complete')
    }
    for (let count = 0; count < 12; count++) await timed(100)
    expect(scheduler.health('a')).toBeUndefined()
    for (let count = 0; count < 3; count++) await timed(300)
    expect(scheduler.health('a')).toEqual({ state: 'slow' })
    for (let count = 0; count < 5; count++) await timed(100)
    expect(scheduler.health('a')).toBeUndefined()
  })
})
