import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelRequestQueue } from '../src/model-request-queue.ts'

afterEach(() => vi.useRealTimers())

const signal = () => new AbortController().signal
const small = () => new ModelRequestQueue({ active: 1, waiting: 2, bytes: 10, waitMs: 30_000 })

describe('Host model request permits', () => {
  it('keeps the Host at 32 upstream requests and admits waiting requests in order', async () => {
    const queue = new ModelRequestQueue()
    const permits = await Promise.all(Array.from({ length: 32 }, () => queue.acquire(signal(), 1)))
    const order: number[] = []
    const first = queue.acquire(signal(), 1).then(release => {
      order.push(1)
      return release
    })
    const second = queue.acquire(signal(), 1).then(release => {
      order.push(2)
      return release
    })
    await Promise.resolve()
    expect(order).toEqual([])
    permits[0]!()
    const release = await first
    expect(order).toEqual([1])
    // Duplicate finally paths must not create an extra slot.
    permits[0]!()
    await Promise.resolve()
    expect(order).toEqual([1])
    release()
    ;(await second)()
    expect(order).toEqual([1, 2])
    for (const permit of permits) permit()
    queue.close()
  })

  it('expires a waiting request at 30 seconds and removes its reserved bytes', async () => {
    vi.useFakeTimers()
    const queue = small()
    const active = await queue.acquire(signal(), 1)
    const waiting = queue.acquire(signal(), 10)
    const rejected = expect(waiting).rejects.toMatchObject({ status: 429, code: 'gateway-busy' })
    await vi.advanceTimersByTimeAsync(29_999)
    await expect(queue.acquire(signal(), 1)).rejects.toMatchObject({ code: 'gateway-busy' })
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    const next = queue.acquire(signal(), 10)
    active()
    ;(await next)()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a queued request without consuming an upstream permit or blocking the next request', async () => {
    const queue = small()
    const active = await queue.acquire(signal(), 1)
    const cancelled = new AbortController()
    const first = queue.acquire(cancelled.signal, 7)
    const rejected = expect(first).rejects.toThrow('user cancelled')
    cancelled.abort(new Error('user cancelled'))
    await rejected
    const second = queue.acquire(signal(), 10)
    active()
    ;(await second)()
  })

  it('bounds pending request count even when request bodies are empty', async () => {
    const queue = small()
    const active = await queue.acquire(signal(), 0)
    const a = queue.acquire(signal(), 0)
    const b = queue.acquire(signal(), 0)
    await expect(queue.acquire(signal(), 0)).rejects.toMatchObject({ code: 'gateway-busy' })
    active()
    ;(await a)()
    ;(await b)()
  })

  it('closes all pending requests and rejects new work without waiting for active consumers', async () => {
    vi.useFakeTimers()
    const queue = small()
    const active = await queue.acquire(signal(), 0)
    const waiting = queue.acquire(signal(), 10)
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'model-queue-closed' })
    queue.close()
    await rejected
    active()
    await expect(queue.acquire(signal(), 0)).rejects.toMatchObject({ status: 503 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not grant a permit to an already cancelled request', async () => {
    const queue = small()
    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled before admission'))
    await expect(queue.acquire(cancelled.signal, 0)).rejects.toThrow('cancelled before admission')
    ;(await queue.acquire(signal(), 10))()
  })
})
