import { afterEach, expect, it, vi } from 'vitest'
import { NativeReconnect, type ReconnectConnection } from '../src/reconnect.ts'

const owners: NativeReconnect[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    owner.stop()
    await owner.done
  }
  vi.useRealTimers()
})
class Connection implements ReconnectConnection {
  closed = false
  readonly listeners = new Set<() => void>()
  isClosed(): boolean {
    return this.closed
  }
  onClose(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  close(): void {
    this.closed = true
    for (const listener of [...this.listeners]) listener()
  }
}
it('uses one retry owner, waits for real closure, and removes old connection observers after a network wake', async () => {
  vi.useFakeTimers()
  let current: Connection | undefined
  const first = new Connection(),
    second = new Connection(),
    third = new Connection()
  const connections = [first, second, third]
  const migrate = vi.fn(async () => {
      current = connections.shift()
    }),
    cancelPending = vi.fn()
  const owner = new NativeReconnect({ migrate, current: () => current, cancelPending })
  owners.push(owner)
  await vi.advanceTimersByTimeAsync(0)
  expect(migrate).toHaveBeenCalledOnce()
  expect(first.listeners.size).toBe(1)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(migrate).toHaveBeenCalledOnce()
  owner.wake()
  await vi.advanceTimersByTimeAsync(0)
  expect(cancelPending).toHaveBeenCalledOnce()
  expect(first.listeners.size).toBe(0)
  expect(second.listeners.size).toBe(1)
  first.close()
  await vi.advanceTimersByTimeAsync(0)
  expect(migrate).toHaveBeenCalledTimes(2)
  second.close()
  await vi.advanceTimersByTimeAsync(0)
  expect(migrate).toHaveBeenCalledTimes(3)
  owner.stop()
  await owner.done
  expect(third.listeners.size).toBe(0)
})
it('bounds retry backoff and wakes immediately for a changed network', async () => {
  vi.useFakeTimers()
  const migrate = vi.fn(async () => {
    throw new Error('offline fixture')
  })
  const state = vi.fn()
  const owner = new NativeReconnect(
    { migrate, current: () => undefined, cancelPending() {} },
    { baseDelayMs: 100, maxDelayMs: 400, random: () => 1, onState: state },
  )
  owners.push(owner)
  await vi.advanceTimersByTimeAsync(0)
  expect(migrate).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(99)
  expect(migrate).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(migrate).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(200)
  expect(migrate).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(400)
  expect(migrate).toHaveBeenCalledTimes(4)
  owner.wake()
  await vi.advanceTimersByTimeAsync(0)
  expect(migrate).toHaveBeenCalledTimes(5)
  owner.stop()
  await owner.done
  await vi.advanceTimersByTimeAsync(60_000)
  expect(migrate).toHaveBeenCalledTimes(5)
  expect(state).toHaveBeenLastCalledWith('stopped')
})
it('cancels and settles the old round before starting a replacement', async () => {
  vi.useFakeTimers()
  let release!: () => void,
    concurrent = 0,
    peak = 0
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const migrate = vi.fn(async () => {
    peak = Math.max(peak, ++concurrent)
    if (migrate.mock.calls.length === 1) await gate
    concurrent--
  })
  const owner = new NativeReconnect({ migrate, current: () => undefined, cancelPending: release }, { baseDelayMs: 100, maxDelayMs: 100 })
  owners.push(owner)
  owner.wake()
  owner.wake()
  await vi.advanceTimersByTimeAsync(0)
  expect(migrate).toHaveBeenCalledTimes(2)
  expect(peak).toBe(1)
  owner.stop()
  await owner.done
})
