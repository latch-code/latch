import { describe, expect, it } from 'vitest'
import type { ModelFailureClass } from '@latch/protocol'
import type { ModelDelta, ModelProvider } from '@latch/sdk'
import { ModelScheduler, type SchedulerClock } from '../src/model-scheduler.ts'
import { ProviderError } from '../src/plugins/providers/http.ts'
import { scheduledProvider, scheduledRequest } from '../src/scheduled-provider.ts'
import { manualClock } from './helpers/manual-clock.ts'

type Step = 'answer' | 'silent' | 'headers-then-think' | 'permit-then-answer' | 'provider-timeout' | { status: number; message?: string }

/** The built-in harness's providers behind the scheduler, on a clock the test moves. */
function setup(steps: Record<string, Step[]>, current: { a: string } = { a: 'a1' }) {
  const time = manualClock()
  const scheduler = new ModelScheduler({ clock: time.clock as SchedulerClock, fingerprint: id => (id === 'a' ? current.a : `${id}1`) })
  const calls: Array<{ id: string; model: string | undefined; effort: string | undefined }> = []
  const switches: Array<{ providerId: string; candidate: number; reason: ModelFailureClass }> = []
  const raw = (id: string): ModelProvider => ({
    id,
    name: id,
    model: 'model',
    modelCapabilities: { model: { thinking: id === 'a' ? ['high'] : [] } },
    async *stream(request): AsyncIterable<ModelDelta> {
      calls.push({ id, model: request.model, effort: request.effort })
      const step = steps[id]?.shift() ?? 'answer'
      const store = scheduledRequest.getStore()
      if (typeof step === 'object')
        throw new ProviderError(`模型服务 HTTP ${step.status}：${step.message ?? ''}`, 'http-error', step.status)
      if (step === 'provider-timeout') throw new ProviderError('模型服务没有在时限内回复。', 'timeout')
      if (step === 'silent') await time.clock.sleep(600_000, request.signal)
      if (step === 'headers-then-think') {
        // What the Host's fetch does when the response arrives.
        store?.timer.began()
        await time.clock.sleep(200_000, request.signal)
      }
      if (step === 'permit-then-answer') await store?.timer.waiting(time.clock.sleep(100_000, request.signal))
      yield { type: 'text', text: `from ${id}` }
      yield { type: 'finish', reason: 'stop' }
    },
  })
  const providers = { a: raw('a'), b: raw('b') }
  const provider = scheduledProvider(providers.a, {
    scheduler,
    fallbacks: () => [{ providerId: 'b', model: 'other', fingerprint: 'b1', provider: () => providers.b }],
    fingerprint: () => current.a,
    fallback: async event => {
      switches.push({ providerId: event.providerId, candidate: event.candidate, reason: event.reason })
    },
  })
  const run = async (options: { runId?: string; effort?: string } = {}) => {
    const deltas: ModelDelta[] = []
    for await (const delta of provider.stream({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      model: 'model',
      ...(options.effort ? { effort: options.effort } : {}),
      run: { sessionId: 'session', runId: options.runId ?? 'run' },
    }))
      deltas.push(delta)
    return deltas
  }
  return { time, scheduler, calls, switches, run, provider }
}

describe("the built-in harness's requests through the scheduler", () => {
  it('answers from the fallback when the first service refuses its key, saying which service answered before its reply', async () => {
    const { run, calls, switches } = setup({ a: [{ status: 401 }] })
    expect(await run({ effort: 'high' })).toEqual([
      { type: 'route', providerId: 'b', model: 'other' },
      { type: 'text', text: 'from b' },
      { type: 'finish', reason: 'stop' },
    ])
    // The fallback is asked for its own model, and without a thinking level it never declared.
    expect(calls).toEqual([
      { id: 'a', model: 'model', effort: 'high' },
      { id: 'b', model: 'other', effort: undefined },
    ])
    expect(switches).toEqual([{ providerId: 'a', candidate: 1, reason: 'auth' }])
    // The rest of the turn stays there; another turn starts at the first service, held back or not by then.
    await run()
    expect(calls.map(call => call.id)).toEqual(['a', 'b', 'b'])
  })

  it("fails with the first service's own error when its request is at fault, and never with another model's answer", async () => {
    const { run, calls } = setup({ a: [{ status: 400, message: 'bad request' }] })
    await expect(run()).rejects.toMatchObject({ code: 'http-error', status: 400 })
    expect(calls.map(call => call.id)).toEqual(['a'])
    const refused = setup({ a: [{ status: 401 }], b: [{ status: 400 }] })
    await expect(refused.run()).rejects.toMatchObject({ code: 'http-error', status: 401 })
  })

  it('leaves a service that says nothing for 60 seconds for the fallback at once', async () => {
    const { time, run, calls, switches } = setup({ a: ['silent'] })
    const started = time.clock.now()
    const request = run()
    await time.flush()
    await time.advance(60_000)
    expect((await request).map(delta => delta.type)).toEqual(['route', 'text', 'finish'])
    expect(time.clock.now() - started).toBe(60_000)
    expect(calls.map(call => call.id)).toEqual(['a', 'b'])
    expect(switches).toEqual([{ providerId: 'a', candidate: 1, reason: 'timeout' }])
  })

  it('does not cut a reply whose response arrived, however long the model thinks before its first event', async () => {
    const { time, run, calls, scheduler } = setup({ a: ['headers-then-think'] })
    const request = run()
    await time.flush()
    // Only the model's own 200 seconds are pending: the first-byte limit ended with the response.
    expect(time.pending()).toEqual([200_000])
    await time.advance(200_000)
    expect(await request).toEqual([
      { type: 'text', text: 'from a' },
      { type: 'finish', reason: 'stop' },
    ])
    expect(calls.map(call => call.id)).toEqual(['a'])
    expect(scheduler.health('a')).toBeUndefined()
  })

  it("does not count the wait for the Host's permit as the service's silence", async () => {
    const { time, run, calls } = setup({ a: ['permit-then-answer'] })
    const request = run()
    await time.flush()
    expect(time.pending()).toEqual([100_000])
    await time.advance(100_000)
    expect((await request).map(delta => delta.type)).toEqual(['text', 'finish'])
    expect(calls.map(call => call.id)).toEqual(['a'])
  })

  it('says the service changed when it was edited while the run was under way: no silent move to the fallback, and no record of one', async () => {
    const current = { a: 'a1' }
    const { run, calls, switches } = setup({}, current)
    // The run's first request fixes its candidates as the service was then.
    await run()
    expect(calls.map(call => call.id)).toEqual(['a'])
    // Someone saves another key for the service; the same run asks again.
    current.a = 'a2'
    await expect(run()).rejects.toMatchObject({ status: 409, code: 'model-route-changed' })
    expect(calls.map(call => call.id)).toEqual(['a'])
    expect(switches).toEqual([])
    // The next run binds the service as it is now.
    await run({ runId: 'next' })
    expect(calls.map(call => call.id)).toEqual(['a', 'a'])
  })

  it("never asks a service again after its provider's own timeout: the fallback at once, or the timeout as the answer", async () => {
    const moved = setup({ a: ['provider-timeout'] })
    expect((await moved.run()).map(delta => delta.type)).toEqual(['route', 'text', 'finish'])
    expect(moved.calls.map(call => call.id)).toEqual(['a', 'b'])
    expect(moved.switches).toEqual([{ providerId: 'a', candidate: 1, reason: 'timeout' }])
    expect(moved.time.pending()).toEqual([])
  })
})
