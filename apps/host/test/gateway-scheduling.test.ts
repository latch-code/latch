import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelFailureClass } from '@latch/protocol'
import type { ModelRoute } from '@latch/sdk'
import { startFakeModels, type FakeModels, type FakeReply } from '@latch/testkit'
import { ModelGatewayServer, type GatewayService } from '../src/model-gateway.ts'
import { ModelRequestQueue } from '../src/model-request-queue.ts'
import { ModelScheduler, type SchedulerClock } from '../src/model-scheduler.ts'
import { manualClock } from './helpers/manual-clock.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

const KEY_A = 'sk-first-service-0123456789abcdefghij'
const KEY_B = 'sk-second-service-0123456789abcdefghi'

async function models(replies: FakeReply[] = [{ text: 'ok' }]): Promise<FakeModels> {
  const fake = await startFakeModels({ replies })
  cleanups.push(() => fake.close())
  return fake
}

type Kind = GatewayService['kind']
const BASE: Record<Kind, string> = { 'openai-responses': '/v1', 'openai-compatible': '/v1', anthropic: '' }
const WIRE = {
  'openai-responses': 'responses',
  'openai-compatible': 'chat-completions',
  anthropic: 'anthropic-messages',
} as const

/**
 * A gateway over two fake services on a clock the test moves: `a` is the session's own, `b` what its model falls back
 * to. Every switch is recorded with how many requests the second service had got by then.
 */
async function setup(
  options: {
    a?: FakeReply[]
    b?: FakeReply[]
    kinds?: [Kind, Kind]
    limit?: (id: string) => number | undefined
    audit?: () => Promise<void>
    fallbackModel?: string
    /** The Host-wide permits, when a test needs fewer than 32. */
    permits?: number
  } = {},
) {
  const [kindA, kindB] = options.kinds ?? ['openai-responses', 'openai-responses']
  const a = await models(options.a)
  const b = await models(options.b)
  const time = manualClock()
  const services: Record<string, GatewayService | undefined> = {
    a: { kind: kindA, baseURL: `${a.origin}${BASE[kindA]}`, apiKey: KEY_A, models: ['fake-model'], fingerprint: 'a1' },
    b: { kind: kindB, baseURL: `${b.origin}${BASE[kindB]}`, apiKey: KEY_B, models: ['fake-model', 'other-model'], fingerprint: 'b1' },
  }
  const queue = new ModelRequestQueue(
    options.permits ? { active: options.permits, waiting: 128, bytes: 64 * 1024 * 1024, waitMs: 30_000 } : undefined,
  )
  const scheduler = new ModelScheduler({
    clock: time.clock as SchedulerClock,
    fingerprint: id => services[id]?.fingerprint,
    ...(options.limit ? { limit: options.limit } : {}),
  })
  const switches: Array<{ providerId: string; candidate: number; reason: ModelFailureClass; sessionId: string; second: number }> = []
  const logs: string[] = []
  const server = new ModelGatewayServer({
    service: id => services[id],
    fetchFor: () => fetch as typeof fetch,
    log: text => void logs.push(text),
    scheduler,
    queue,
    fallback: async event => {
      await options.audit?.()
      switches.push({ ...event, second: b.requests.length })
    },
  })
  await server.start()
  cleanups.push(() => server.close())
  const route: ModelRoute = {
    providerId: 'a',
    model: 'fake-model',
    wire: 'responses',
    ...(WIRE[kindA] !== 'responses' ? { upstream: WIRE[kindA] } : {}),
    origin: a.origin,
    fallbacks: {
      'fake-model': [{ providerId: 'b', model: options.fallbackModel ?? 'fake-model', upstream: WIRE[kindB], origin: b.origin }],
    },
  }
  const lease = server.open({ sessionId: 'session', route })
  const ask = (init: { stream?: boolean; signal?: AbortSignal; body?: Record<string, unknown> } = {}) =>
    fetch(`${lease.baseURL}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-model', input: 'hello', stream: init.stream ?? true, ...init.body }),
      ...(init.signal ? { signal: init.signal } : {}),
    })
  /** Moves the clock through the gateway's pauses until the reply's headers are here. */
  const answered = async (request: Promise<Response>): Promise<Response> => {
    let done = false
    void request.then(
      () => (done = true),
      () => (done = true),
    )
    for (let step = 0; step < 400 && !done; step++) {
      await new Promise(resolve => setTimeout(resolve, 5))
      // Only the gateway's own pauses: a first-byte limit is left to run unless a test moves to it.
      const pause = time.pending().find(ms => ms < 60_000)
      if (!done && pause !== undefined) await time.advance(pause)
    }
    return request
  }
  return { a, b, time, services, scheduler, switches, logs, server, lease, ask, answered, route }
}

const failed = (status: number, retryAfter?: number): FakeReply => ({
  error: { status, message: `status ${status}`, ...(retryAfter !== undefined ? { retryAfter } : {}) },
})

describe('the gateway schedules a session across its candidates', () => {
  it('moves a request the first service fails before its reply begins to the fallback, on record first, and says who answered', async () => {
    const { a, b, ask, answered, switches, lease, scheduler } = await setup({ a: [failed(500)], b: [{ text: 'from the second' }] })
    const response = await answered(ask())
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('from the second')
    // Three tries at the first service, then the second, which got the second service's key and never the first's.
    expect(a.requests).toHaveLength(3)
    expect(b.requests).toMatchObject([{ wire: 'responses', model: 'fake-model', key: KEY_B }])
    // The record was written while the second service had seen nothing.
    expect(switches).toEqual([{ sessionId: 'session', providerId: 'a', candidate: 1, reason: 'server', second: 0 }])
    expect(lease.takeTurn()).toMatchObject({
      requests: 1,
      models: [{ model: 'fake-model', requests: 1, provider: 'b', fallback: 1, measured: 1 }],
    })
    expect(scheduler.health('b')).toBeUndefined()
  })

  it('never moves a reply that began: the stream ends with an error in the harness’s protocol, and the turn failed', async () => {
    const { a, b, ask, switches, lease, scheduler } = await setup({ a: [{ text: 'partial text here', cut: true }] })
    const response = await ask()
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('response.failed')
    expect(text).not.toContain('response.completed')
    expect(a.requests).toHaveLength(1)
    expect(b.requests).toHaveLength(0)
    expect(switches).toEqual([])
    const turn = lease.takeTurn()
    expect(turn.models).toMatchObject([{ model: 'fake-model', requests: 1, failed: 1 }])
    expect(turn.models[0]).not.toHaveProperty('fallback')
    // It counts against the service like any failure of its own.
    for (let count = 0; count < 3; count++) await (await ask()).text()
    expect(scheduler.health('a')).toMatchObject({ state: 'failing', last: 'stream' })
  })

  it('says a converted reply broke off because the service’s connection went, not that converting it failed', async () => {
    const { ask } = await setup({ a: [{ text: 'partial text here', cut: true }], kinds: ['openai-compatible', 'openai-compatible'] })
    const text = await (await ask()).text()
    expect(text).toContain('response.failed')
    expect(text).toContain('模型服务的回复中断了，这一轮没有完成。')
    expect(text).not.toContain('未完整转换')
  })

  it.each([
    { kind: 'anthropic' as const, path: '/v1/messages', expected: 'event: error' },
    { kind: 'openai-compatible' as const, path: '/v1/chat/completions', expected: '"code":"gateway-upstream"' },
  ])('ends a broken $kind stream passed through with that protocol’s own error', async ({ kind, path, expected }) => {
    const fake = await models([{ text: 'partial text here', cut: true }])
    const server = new ModelGatewayServer({
      service: () => ({ kind, baseURL: `${fake.origin}${BASE[kind]}`, apiKey: KEY_A, models: ['fake-model'], fingerprint: 'one' }),
      fetchFor: () => fetch as typeof fetch,
      log: () => {},
    })
    await server.start()
    cleanups.push(() => server.close())
    const lease = server.open({
      sessionId: 'session',
      route: { providerId: 'a', model: 'fake-model', wire: WIRE[kind], origin: fake.origin },
    })
    const response = await fetch(`http://127.0.0.1:${server.listeningPort}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-model', stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain(expected)
  })

  it('answers a 400-class failure as the service wrote it, without another candidate or a mark against the service', async () => {
    const { a, b, ask, switches, scheduler } = await setup({ a: [failed(400), failed(404), failed(413), failed(422)] })
    for (const status of [400, 404, 413, 422]) {
      const response = await ask()
      expect(response.status).toBe(status)
      expect(await response.text()).toContain(`status ${status}`)
    }
    for (let count = 0; count < 8; count++) await (await ask()).text()
    expect(a.requests).toHaveLength(12)
    expect(b.requests).toHaveLength(0)
    expect(switches).toEqual([])
    expect(scheduler.health('a')).toBeUndefined()
  })

  it('moves on from a refused key without trying it again, and says the key is invalid', async () => {
    const { a, b, ask, switches, scheduler } = await setup({ a: [failed(401)], b: [{ text: 'second' }] })
    const response = await ask()
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('second')
    expect(a.requests).toHaveLength(1)
    expect(b.requests).toHaveLength(1)
    expect(switches).toMatchObject([{ providerId: 'a', candidate: 1, reason: 'auth' }])
    expect(scheduler.health('a')).toMatchObject({ state: 'key-invalid', last: 'auth' })
  })

  it('rests a service whose balance ran out, by status or by what its error says', async () => {
    const { a, ask, switches, scheduler, time, lease } = await setup({
      a: [failed(402), { error: { status: 429, message: 'insufficient_quota: add credits' } }],
      b: [{ text: 'second' }],
    })
    await (await ask()).text()
    expect(scheduler.health('a')).toMatchObject({ state: 'quota' })
    expect(Date.parse(scheduler.health('a')!.until!) - time.clock.now()).toBe(30 * 60_000)
    await time.advance(30 * 60_000)
    // A new turn after the rest: the first service is asked first again.
    lease.takeTurn()
    await (await ask()).text()
    expect(a.requests).toHaveLength(2)
    expect(Date.parse(scheduler.health('a')!.until!) - time.clock.now()).toBe(2 * 3_600_000)
    expect(switches.map(event => event.reason)).toEqual(['quota', 'quota'])
  })

  it('moves a 429 to the fallback; with none, waits once for a short retry-after and hands a long one back as it came', async () => {
    const moved = await setup({ a: [failed(429, 2)], b: [{ text: 'second' }] })
    expect(await (await moved.ask()).text()).toContain('second')
    expect(moved.a.requests).toHaveLength(1)
    expect(moved.switches).toMatchObject([{ reason: 'rate' }])

    const alone = await setup({ a: [failed(429, 3), { text: 'after the wait' }, failed(429, 11)] })
    alone.services.b = undefined
    const lease = alone.server.open({ sessionId: 'alone', route: alone.route })
    const ask = () =>
      fetch(`${lease.baseURL}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fake-model', input: 'hello', stream: true }),
      })
    const waiting = ask()
    await vi.waitFor(() => expect(alone.time.pending()).toContain(3000))
    expect(alone.a.requests).toHaveLength(1)
    await alone.time.advance(3000)
    expect(await (await waiting).text()).toContain('after the wait')
    expect(alone.a.requests).toHaveLength(2)
    const long = await ask()
    expect(long.status).toBe(429)
    expect(long.headers.get('retry-after')).toBe('11')
    expect(await long.text()).toContain('status 429')
    expect(alone.a.requests).toHaveLength(3)
    expect(alone.switches).toEqual([])
  })

  it('tries 500, 502, 503, 504 and 529 twice more after 1 and 3 seconds, and answers with the last failure when nothing is left', async () => {
    for (const status of [500, 502, 503, 504, 529]) {
      const { a, ask, time, services, server, route } = await setup({ a: [failed(status)] })
      services.b = undefined
      const lease = server.open({ sessionId: `alone-${status}`, route })
      const request = fetch(`${lease.baseURL}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fake-model', input: 'hello' }),
      })
      await vi.waitFor(() => expect(time.pending()).toEqual([1000]))
      expect(a.requests).toHaveLength(1)
      await time.advance(1000)
      await vi.waitFor(() => expect(time.pending()).toEqual([3000]))
      expect(a.requests).toHaveLength(2)
      await time.advance(3000)
      const response = await request
      expect(response.status).toBe(status)
      expect(await response.text()).toContain(`status ${status}`)
      expect(a.requests).toHaveLength(3)
      void ask
    }
  })

  it('moves on from a service that cannot be reached after its three tries', async () => {
    const down = await setup({ b: [{ text: 'second' }] })
    await down.a.close()
    const response = await down.answered(down.ask())
    expect(await response.text()).toContain('second')
    expect(down.switches).toMatchObject([{ reason: 'network' }])
    expect(down.scheduler.health('a')).toBeUndefined()
  })

  it('leaves a service that accepts and then says nothing for 60 seconds for the fallback, within the first request', async () => {
    const { a, b, time, ask, switches, scheduler } = await setup({ a: [{ text: 'too late', delayMs: 600_000 }], b: [{ text: 'second' }] })
    const started = time.clock.now()
    const request = ask()
    await vi.waitFor(() => expect(time.pending()).toEqual([60_000]))
    await time.advance(60_000)
    // No second try at the silent service: the fallback answers at about 60 seconds, not after the 90 are used up.
    const response = await request
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('second')
    expect(time.clock.now() - started).toBe(60_000)
    expect(a.requests).toHaveLength(1)
    expect(b.requests).toHaveLength(1)
    expect(switches).toMatchObject([{ providerId: 'a', candidate: 1, reason: 'timeout', second: 0 }])
    expect(scheduler.health('a')).toBeUndefined()
  })

  it('never sends a request again to a service that said nothing: with no other candidate the timeout is the answer at 60 seconds', async () => {
    const { a, time, services, server, route } = await setup({ a: [{ text: 'too late', delayMs: 600_000 }] })
    services.b = undefined
    const lease = server.open({ sessionId: 'alone', route })
    const started = time.clock.now()
    const request = fetch(`${lease.baseURL}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-model', input: 'hello', stream: true }),
    })
    await vi.waitFor(() => expect(time.pending()).toEqual([60_000]))
    await time.advance(60_000)
    const response = await request
    // In the harness's own protocol, and at once: the service may still be working on the first copy.
    expect(response.status).toBe(504)
    expect(await response.json()).toMatchObject({ error: { code: 'gateway-timeout' } })
    expect(time.clock.now() - started).toBe(60_000)
    expect(a.requests).toHaveLength(1)
    expect(time.pending()).toEqual([])
  })

  it('puts no first-byte limit on a request that does not stream: a slow whole answer is neither cut, sent twice nor held against the service', async () => {
    const { a, b, time, ask, switches, scheduler } = await setup({ a: [{ text: 'a long answer', delayMs: 400 }] })
    for (let count = 0; count < 5; count++) {
      const request = ask({ stream: false })
      await vi.waitFor(() => expect(a.requests).toHaveLength(count + 1))
      // Nothing counts down beside it; minutes may pass.
      expect(time.pending()).toEqual([])
      await time.advance(300_000)
      const response = await request
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('a long answer')
    }
    expect(a.requests).toHaveLength(5)
    expect(b.requests).toHaveLength(0)
    expect(switches).toEqual([])
    expect(scheduler.health('a')).toBeUndefined()
  })

  it('ends the first-byte limit at the response headers: a model that then thinks silently for minutes is not cut or sent again', async () => {
    const { a, b, time, ask, switches, scheduler } = await setup({
      a: [{ text: 'after thinking', silentMs: 500 }],
      b: [{ text: 'second' }],
    })
    const request = ask()
    // The headers are here: nothing counts down any more, though no event has come yet.
    await vi.waitFor(() => expect(a.requests).toHaveLength(1))
    await vi.waitFor(() => expect(time.pending()).toEqual([]))
    await time.advance(300_000)
    const response = await request
    expect(await response.text()).toContain('after thinking')
    expect(a.requests).toHaveLength(1)
    expect(b.requests).toHaveLength(0)
    expect(switches).toEqual([])
    expect(scheduler.health('a')).toBeUndefined()
  })

  it('keeps the rest of a turn on the fallback, and starts the next turn at the first service again', async () => {
    const { a, b, ask, answered, lease, switches } = await setup({ a: [failed(500), failed(500), failed(500), { text: 'first again' }] })
    await (await answered(ask())).text()
    expect(a.requests).toHaveLength(3)
    // The same turn: straight to the fallback, with no new try at the first service and no new record.
    await (await ask()).text()
    await (await ask()).text()
    expect(a.requests).toHaveLength(3)
    expect(b.requests).toHaveLength(3)
    expect(switches).toHaveLength(1)
    expect(lease.takeTurn().models).toMatchObject([{ requests: 3, fallback: 3, provider: 'b' }])
    // The next turn: three failures in a row did not hold the first service back, so it is asked first.
    expect(await (await ask()).text()).toContain('first again')
    expect(a.requests).toHaveLength(4)
    expect(b.requests).toHaveLength(3)
    const turn = lease.takeTurn().models[0]!
    expect(turn).not.toHaveProperty('fallback')
    expect(turn).not.toHaveProperty('provider')
  })

  it('starts the next turn at the fallback while the first service is held back, on record, and refuses when nothing may be tried', async () => {
    const { a, b, ask, lease, switches, time, services, server, route } = await setup({ a: [failed(401)] })
    for (let count = 0; count < 4; count++) {
      await (await ask()).text()
      lease.takeTurn()
    }
    expect(a.requests).toHaveLength(1)
    // The key was refused once: every later turn starts at the fallback, each on record.
    expect(switches.map(event => event.reason)).toEqual(['auth', 'auth', 'auth', 'auth'])
    expect(b.requests).toHaveLength(4)

    // A session with nowhere else to go, at a service that keeps failing: nothing is sent for a minute.
    services.b = undefined
    const alone = server.open({ sessionId: 'alone', route })
    const direct = () =>
      fetch(`${alone.baseURL}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${alone.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fake-model', input: 'hello' }),
      })
    for (let count = 0; count < 3; count++) expect((await direct()).status).toBe(401)
    expect(a.requests).toHaveLength(4)
    const held = await direct()
    expect(held.status).toBe(503)
    expect(held.headers.get('retry-after')).toBe('60')
    expect(await held.json()).toMatchObject({ error: { code: 'gateway-circuit-open' } })
    expect(a.requests).toHaveLength(4)
    await time.advance(60_000)
    expect((await direct()).status).toBe(401)
    expect(a.requests).toHaveLength(5)
  })

  it('lets one request try a service after its minute, gives the trial back when the harness leaves first, and opens to all once a reply begins', async () => {
    const { a, time, services, server, route } = await setup({
      a: [
        failed(403),
        failed(403),
        failed(403),
        failed(403),
        { text: 'too late', delayMs: 600_000 },
        { text: 'a long reply', lingerMs: 60_000 },
        { text: 'next' },
      ],
    })
    services.b = undefined
    const lease = server.open({ sessionId: 'alone', route })
    const direct = (signal?: AbortSignal) =>
      fetch(`${lease.baseURL}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fake-model', input: 'hello', stream: true }),
        ...(signal ? { signal } : {}),
      })
    for (let count = 0; count < 4; count++) expect((await direct()).status).toBe(403)
    expect((await direct()).status).toBe(503)
    await time.advance(60_000)
    // The trial: under way and silent. No second request goes out meanwhile.
    const leaving = new AbortController()
    const trial = direct(leaving.signal)
    trial.catch(() => {})
    await vi.waitFor(() => expect(a.requests).toHaveLength(5))
    expect((await direct()).status).toBe(503)
    expect(a.requests).toHaveLength(5)
    // The harness gives up before any answer: the trial place is free again for the next real request.
    leaving.abort()
    let begun: Response | undefined
    await vi.waitFor(async () => {
      const next = await direct()
      if (next.status !== 200) await next.text()
      expect(next.status).toBe(200)
      begun = next
    })
    expect(a.requests).toHaveLength(6)
    // That reply began and still runs: the service is open to others at once, not only when it ends.
    const other = await direct()
    expect(other.status).toBe(200)
    expect(await other.text()).toContain('next')
    await begun!.body?.cancel()
  })

  it("names the fallback's own model in a request passed through, and converts for a fallback that speaks another protocol", async () => {
    const renamed = await setup({ a: [failed(401)], b: [{ text: 'second' }], fallbackModel: 'other-model' })
    await (await renamed.ask()).text()
    expect(renamed.b.requests).toMatchObject([{ wire: 'responses', model: 'other-model', key: KEY_B }])
    expect((renamed.b.requests[0]!.body as { input: unknown }).input).toBe('hello')
    expect(renamed.lease.takeTurn().models).toMatchObject([{ model: 'fake-model', provider: 'b', fallback: 1 }])

    const converted = await setup({ a: [failed(401)], b: [{ text: 'from chat' }], kinds: ['openai-responses', 'openai-compatible'] })
    const response = await converted.ask()
    const text = await response.text()
    expect(text).toContain('response.completed')
    expect(text).toContain('from chat')
    expect(converted.b.requests).toMatchObject([{ wire: 'chat-completions', model: 'fake-model', key: KEY_B }])
  })

  it('passes over a fallback that is gone, off or changed without failing the session, and stops only that candidate', async () => {
    const gone = await setup({ a: [failed(401)] })
    gone.services.b = undefined
    const response = await gone.ask()
    // Bound when the token was issued; gone since: the first service's own answer stands.
    expect(response.status).toBe(401)
    // Left out before anything was scheduled: no record says the request went anywhere.
    expect(gone.switches).toEqual([])
    expect(gone.b.requests).toHaveLength(0)

    const changed = await setup({ a: [failed(401), { text: 'first' }], b: [{ text: 'second' }] })
    changed.services.b = { ...changed.services.b!, fingerprint: 'b2' }
    expect((await changed.ask()).status).toBe(401)
    expect(changed.b.requests).toHaveLength(0)
    // The token still works for its own service.
    expect(changed.lease.active()).toBe(true)

    // Not there when the token is issued: the session opens all the same.
    const never = await setup({ a: [{ text: 'first' }] })
    never.services.b = undefined
    const lease = never.server.open({ sessionId: 'late', route: never.route })
    const answer = await fetch(`${lease.baseURL}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-model', input: 'hello' }),
    })
    expect(answer.status).toBe(200)
  })

  it("never sends a request that leans on the service's own state to another service", async () => {
    for (const body of [{ previous_response_id: 'resp_1' }, { store: true }, { conversation: 'conv_1' }]) {
      const kept = await setup({ a: [failed(401)], b: [{ text: 'must not be asked' }] })
      const response = await kept.ask({ body })
      // The first service's own answer: another service knows nothing of what this one stored.
      expect(response.status).toBe(401)
      expect(kept.b.requests).toHaveLength(0)
      expect(kept.switches).toEqual([])
    }
    // Stored state: a 5xx is not tried again in place either.
    const stored = await setup({ a: [failed(500)] })
    expect((await stored.ask({ body: { store: true } })).status).toBe(500)
    expect(stored.a.requests).toHaveLength(1)
  })

  it('never sends a request the service acts on itself a second time after it may have run: not in place, not to the fallback', async () => {
    const tools = [{ type: 'web_search' }]
    // A 5xx after the request was sent: the search may have run. One request in all, and the failure is the answer.
    const failedAfter = await setup({ a: [failed(500)], b: [{ text: 'must not be asked' }] })
    const response = await failedAfter.ask({ body: { tools } })
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('status 500')
    expect(failedAfter.a.requests).toHaveLength(1)
    expect(failedAfter.b.requests).toHaveLength(0)
    expect(failedAfter.switches).toEqual([])
    // The same for a service that accepted it and said nothing for 60 seconds…
    const silent = await setup({ a: [{ text: 'too late', delayMs: 600_000 }], b: [{ text: 'must not be asked' }] })
    const waiting = silent.ask({ body: { tools } })
    await vi.waitFor(() => expect(silent.time.pending()).toEqual([60_000]))
    await silent.time.advance(60_000)
    expect((await waiting).status).toBe(504)
    expect(silent.a.requests).toHaveLength(1)
    expect(silent.b.requests).toHaveLength(0)
    // …and for one that answered 200 and dropped the connection before the first byte of its reply.
    const dropped = await setup({ a: [{ text: 'never arrives', dropped: true }], b: [{ text: 'must not be asked' }] })
    const broken = await dropped.ask({ body: { tools } })
    expect(broken.status).toBe(502)
    expect(dropped.a.requests).toHaveLength(1)
    expect(dropped.b.requests).toHaveLength(0)
    for (const other of [{ mcp_servers: [{ url: 'https://mcp.example' }] }, { tools: [{ type: 'code_interpreter' }] }]) {
      const acted = await setup({ a: [failed(503)], b: [{ text: 'must not be asked' }] })
      expect((await acted.ask({ body: other })).status).toBe(503)
      expect(acted.a.requests).toHaveLength(1)
      expect(acted.b.requests).toHaveLength(0)
    }
  })

  it('still moves such a request on after a failure that proves it never ran, and treats a harness’s own tools as before', async () => {
    const tools = [{ type: 'web_search' }]
    for (const status of [401, 403, 429]) {
      const proven = await setup({ a: [failed(status)], b: [{ text: 'second' }] })
      expect(await (await proven.ask({ body: { tools } })).text()).toContain('second')
      expect(proven.a.requests).toHaveLength(1)
    }
    // No connection was made at all: nothing can have run, so the fallback takes it after the usual tries.
    const down = await setup({ b: [{ text: 'second' }] })
    await down.a.close()
    expect(await (await down.answered(down.ask({ body: { tools } }))).text()).toContain('second')
    expect(down.switches).toMatchObject([{ reason: 'network' }])
    // Function tools run in the harness: a 5xx is tried twice more, then the fallback answers.
    const own = await setup({ a: [failed(500)], b: [{ text: 'second' }] })
    const functions = [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } }]
    expect(await (await own.answered(own.ask({ body: { tools: functions } }))).text()).toContain('second')
    expect(own.a.requests).toHaveLength(3)
    // And a reply that drops before its first byte is tried again in place for a request nothing could run twice.
    const dropped = await setup({ a: [{ text: 'never arrives', dropped: true }, { text: 'second try' }] })
    expect(await (await dropped.answered(dropped.ask())).text()).toContain('second try')
    expect(dropped.a.requests).toHaveLength(2)
  })

  it('tries a converted request again after a 5xx: the service’s own tools it named never go out with it', async () => {
    const tools = [{ type: 'web_search' }, { type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } }]
    // Responses to Chat for both candidates: the search is left out of what each service gets, so nothing runs there twice.
    const converted = await setup({ a: [failed(500)], b: [{ text: 'second' }], kinds: ['openai-compatible', 'openai-compatible'] })
    expect(await (await converted.answered(converted.ask({ body: { tools } }))).text()).toContain('second')
    expect(converted.a.requests).toHaveLength(3)
    expect(JSON.stringify(converted.a.requests[0]?.body)).not.toContain('web_search')
    // A candidate the request would reach as it came still could run the search: then it is sent once, as before.
    const passed = await setup({ a: [failed(500)], b: [{ text: 'must not be asked' }], kinds: ['openai-compatible', 'openai-responses'] })
    expect((await passed.ask({ body: { tools } })).status).toBe(500)
    expect(passed.a.requests).toHaveLength(1)
    expect(passed.b.requests).toHaveLength(0)
  })

  it("answers with the first service's real failure when the fallback refuses the request itself", async () => {
    const { a, b, ask, scheduler } = await setup({ a: [failed(401)], b: [failed(400)] })
    const response = await ask()
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('status 401')
    expect(a.requests).toHaveLength(1)
    expect(b.requests).toHaveLength(1)
    // The fallback's refusal of this request says nothing of its health.
    expect(scheduler.health('b')).toBeUndefined()
  })

  it("takes its key out of what a fallback's error says, in every form, before the harness reads it", async () => {
    const echo = `bad request for key ${KEY_B} and ${encodeURIComponent(KEY_B)}`
    const { a, b, ask, answered } = await setup({ a: [failed(401)], b: [{ error: { status: 500, message: echo } }] })
    const response = await answered(ask())
    const text = await response.text()
    expect(response.status).toBe(500)
    expect(b.requests).toHaveLength(3)
    expect(text).toContain('[redacted]')
    expect(text).not.toContain(KEY_B)
    expect(text).not.toContain(KEY_A)
    void a
  })

  it('leaves out a fallback whose service speaks another protocol or sits at another address than the session fixed', async () => {
    // Bound when the session started to a Responses service at one address: what answers there now must still be that.
    const moved = await setup({ a: [failed(401)], b: [{ text: 'must not be asked' }] })
    const elsewhere = await models([{ text: 'another address' }])
    moved.services.b = { ...moved.services.b!, baseURL: `${elsewhere.origin}/v1` }
    const leaseMoved = moved.server.open({ sessionId: 'moved', route: moved.route })
    const call = (lease: { baseURL: string; token: string }) =>
      fetch(`${lease.baseURL}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fake-model', input: 'hello', stream: true }),
      })
    expect((await call(leaseMoved)).status).toBe(401)
    expect(elsewhere.requests).toHaveLength(0)
    expect(moved.b.requests).toHaveLength(0)
    const other = await setup({ a: [failed(401)], b: [{ text: 'must not be asked' }] })
    other.services.b = { ...other.services.b!, kind: 'openai-compatible' }
    expect((await call(other.server.open({ sessionId: 'other', route: other.route }))).status).toBe(401)
    expect(other.b.requests).toHaveLength(0)
    // Unchanged, the same route does reach it.
    const same = await setup({ a: [failed(401)], b: [{ text: 'second' }] })
    expect(await (await call(same.server.open({ sessionId: 'same', route: same.route }))).text()).toContain('second')
  })

  it("takes a service's place before the Host-wide permit, so a full service never holds permits other services need", async () => {
    // Two permits in all; the first service takes one request at a time.
    const { a, ask, scheduler, time, server, services, b } = await setup({
      a: [{ text: 'held open', lingerMs: 60_000 }],
      b: [{ text: 'second' }],
      limit: id => (id === 'a' ? 1 : undefined),
      permits: 2,
    })
    const first = await ask()
    expect(first.status).toBe(200)
    // Waits for the service's place, and holds no permit while it does.
    const waiting = ask()
    await vi.waitFor(() => expect(scheduler.queueOf('session')).toEqual({ providerId: 'a' }))
    // So a session of another service still gets the second permit at once.
    const other = server.open({ sessionId: 'other', route: { providerId: 'b', model: 'fake-model', wire: 'responses', origin: b.origin } })
    const answer = await fetch(`${other.baseURL}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-model', input: 'hello' }),
    })
    expect(answer.status).toBe(200)
    expect(await answer.text()).toContain('second')
    expect(a.requests).toHaveLength(1)
    await time.advance(30_000)
    expect((await waiting).status).toBe(429)
    await first.body?.cancel()
    void services
  })

  it("says a session waits without naming a service while it waits for the Host's own permit", async () => {
    const { ask, scheduler, a } = await setup({ a: [{ text: 'held open', lingerMs: 60_000 }, { text: 'next' }], permits: 1 })
    const first = await ask()
    const second = ask()
    await vi.waitFor(() => expect(scheduler.queueOf('session')).toEqual({}))
    expect(a.requests).toHaveLength(1)
    await first.body?.cancel()
    expect(await (await second).text()).toContain('next')
    expect(scheduler.queueOf('session')).toBeUndefined()
  })

  it('stays with the failed answer when the switch cannot be put on record', async () => {
    const { a, b, ask } = await setup({ a: [failed(401)], audit: () => Promise.reject(new Error('disk full')) })
    const response = await ask()
    expect(response.status).toBe(401)
    expect(a.requests).toHaveLength(1)
    expect(b.requests).toHaveLength(0)
  })

  it('holds a service to its own limit: a second request waits, the session says so, and gets gateway-busy after 30 seconds', async () => {
    const { ask, scheduler, time } = await setup({
      a: [{ text: 'held open', lingerMs: 60_000 }],
      limit: id => (id === 'a' ? 1 : undefined),
    })
    const first = await ask()
    expect(first.status).toBe(200)
    const second = ask()
    await vi.waitFor(() => expect(scheduler.queueOf('session')).toEqual({ providerId: 'a' }))
    expect(time.pending()).toContain(30_000)
    await time.advance(30_000)
    const refused = await second
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('1')
    expect(await refused.json()).toMatchObject({ error: { code: 'gateway-busy' } })
    expect(scheduler.queueOf('session')).toBeUndefined()
    await first.body?.cancel()
  })

  it('writes the switch into its log as a position and a class, and never a key, a token, a model or anything of a request or reply', async () => {
    const { ask, answered, logs, switches, lease } = await setup({ a: [failed(500)], b: [{ text: 'private reply text' }] })
    await (await answered(ask())).text()
    // The line is there, so the search below reads a real log, not an empty one.
    expect(logs).toEqual(['模型请求改用候选 1（server）'])
    const said = `${logs.join('\n')}\n${JSON.stringify(switches)}`
    for (const secret of [KEY_A, KEY_B, lease.token, 'private reply text', 'hello', 'fake-model', 'status 500'])
      expect(said).not.toContain(secret)
  })
})

describe('what a failed request tells the harness', () => {
  /** A lease of the session's own service only, so nothing moves on and each failure is the answer. */
  async function alone(replies: FakeReply[], kinds?: [Kind, Kind]) {
    const setting = await setup({ a: replies, ...(kinds ? { kinds } : {}) })
    setting.services.b = undefined
    const lease = setting.server.open({ sessionId: 'alone', route: setting.route })
    const ask = (body: Record<string, unknown> = {}) =>
      setting.answered(
        fetch(`${lease.baseURL}/responses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'fake-model', input: 'hello', stream: true, ...body }),
        }),
      )
    return { ...setting, lease, ask }
  }

  it('says not to send again what the gateway already tried or what does not heal in seconds, and the service’s own words', async () => {
    const server = await alone([failed(500)])
    const failedServer = await server.ask()
    expect(failedServer.status).toBe(500)
    expect(failedServer.headers.get('x-should-retry')).toBe('false')
    expect(await failedServer.text()).toContain('status 500')
    expect(server.a.requests).toHaveLength(3)
    // The turn keeps what the service said, for a harness that shows only words of its own.
    expect(server.lease.takeTurn().failure).toBe('500 status 500')

    // A short retry-after is waited out here once; a long one is handed back. Neither is sent again by the harness.
    const rate = await alone([failed(429, 2), failed(429, 2), failed(429, 30)])
    const short = await rate.ask()
    expect(short.status).toBe(429)
    expect(short.headers.get('x-should-retry')).toBe('false')
    expect(rate.a.requests).toHaveLength(2)
    const long = await rate.ask()
    expect(long.headers.get('retry-after')).toBe('30')
    expect(long.headers.get('x-should-retry')).toBe('false')
    expect(rate.a.requests).toHaveLength(3)

    // The request's own fault is the service's to mark, as it came.
    const own = await alone([failed(400)])
    const refused = await own.ask()
    expect(refused.status).toBe(400)
    expect(refused.headers.get('x-should-retry')).toBeNull()
  })

  it('leaves a 5xx the gateway would not send again to the harness, since the request may have run at the service', async () => {
    const acted = await alone([failed(500)])
    const response = await acted.ask({ tools: [{ type: 'web_search' }] })
    expect(response.status).toBe(500)
    expect(response.headers.get('x-should-retry')).toBeNull()
    expect(acted.a.requests).toHaveLength(1)
  })

  it('names what the service last said while its breaker keeps requests from it, and clears it once the service answers', async () => {
    const held = await alone([failed(502), failed(502), failed(502), failed(502), { text: 'back again' }])
    expect((await held.ask()).status).toBe(502)
    expect((await held.ask()).status).toBe(502)
    expect(held.a.requests).toHaveLength(4)
    held.lease.takeTurn()
    const open = await held.ask()
    expect(open.status).toBe(503)
    expect(open.headers.get('x-should-retry')).toBe('false')
    const body = (await open.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('gateway-circuit-open')
    expect(body.error.message).toContain('最近一次：502 status 502')
    expect(held.lease.takeTurn().failure).toContain('最近一次：502 status 502')
    expect(held.a.requests).toHaveLength(4)
    // What it said is never part of the service's health, which every device reads.
    expect(JSON.stringify(held.scheduler.health('a'))).not.toContain('status 502')
    expect((await held.ask()).status).toBe(503)
    await held.time.advance(60_000)
    expect(await (await held.ask()).text()).toContain('back again')
    // A reply that began after a failure in the same turn leaves the turn nothing to blame.
    expect(held.lease.takeTurn()).not.toHaveProperty('failure')
  })

  it('keeps a converted 5xx as the service sent it: its status and words, not a code a harness reads as its own message', async () => {
    const converted = await alone([failed(500)], ['openai-compatible', 'openai-compatible'])
    const response = await converted.ask()
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error).toMatchObject({ code: 'server_error', message: 'status 500' })
  })
})

describe('an Anthropic request with the harness’s own tools', () => {
  it('is tried again in place after a 5xx: a tool declared by name and input schema runs in the harness', async () => {
    const setting = await setup({ a: [failed(500)], kinds: ['anthropic', 'anthropic'] })
    setting.services.b = undefined
    const { upstream: _, ...rest } = setting.route
    const lease = setting.server.open({ sessionId: 'anthropic-tools', route: { ...rest, wire: 'anthropic-messages' } })
    const ask = (tools: unknown[]) =>
      setting.answered(
        fetch(`${lease.baseURL}/v1/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'fake-model',
            max_tokens: 64,
            stream: true,
            messages: [{ role: 'user', content: 'hello' }],
            tools,
          }),
        }),
      )
    const own = await ask([{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: {} } }])
    expect(own.status).toBe(500)
    expect(own.headers.get('x-should-retry')).toBe('false')
    expect(setting.a.requests).toHaveLength(3)
    // A search the service runs itself is sent once, and Claude decides.
    await setting.time.advance(60_000)
    const searched = await ask([{ type: 'web_search_20250305', name: 'web_search' }])
    expect(searched.status).toBe(500)
    expect(searched.headers.get('x-should-retry')).toBeNull()
    expect(setting.a.requests).toHaveLength(4)
  })
})

describe('a context overflow as Claude Code reads it', () => {
  async function claude(kind: Kind, message: string) {
    const setting = await setup({ a: [{ error: { status: 400, message } }], kinds: [kind, kind] })
    setting.services.b = undefined
    const { upstream: _, ...rest } = setting.route
    const route: ModelRoute = { ...rest, wire: 'anthropic-messages', ...(kind === 'anthropic' ? {} : { upstream: WIRE[kind] }) }
    const lease = setting.server.open({ sessionId: 'claude', route })
    const response = await fetch(`${lease.baseURL}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'fake-model', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }),
    })
    return { status: response.status, body: (await response.json()) as { type: string; error: { type: string; message: string } } }
  }

  it('puts the token Claude Code compacts on before the service’s own words, passed through or converted', async () => {
    const words = 'Invalid request: the request exceeds the maximum context of the model'
    for (const kind of ['anthropic', 'openai-compatible'] as const) {
      const { status, body } = await claude(kind, words)
      expect(status).toBe(400)
      expect(body).toEqual({
        type: 'error',
        error: { type: 'invalid_request_error', message: `capability_rejected: prompt_too_long · ${words}` },
      })
    }
  })

  it('leaves wording Claude Code already recognises, and any other refusal, as the service wrote it', async () => {
    const own = await claude('anthropic', 'prompt is too long: 70210 tokens > 64000 maximum')
    expect(own.body.error.message).toBe('prompt is too long: 70210 tokens > 64000 maximum')
    const other = await claude('anthropic', 'input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000')
    expect(other.body.error.message).toBe('input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000')
  })
})
