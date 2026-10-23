import { expect, it, vi } from 'vitest'
import { createShutdown } from '../scripts/shutdown.ts'

it('keeps repeated exit requests waiting for the same complete cleanup', async () => {
  let release!: () => void
  let started!: () => void
  const cleaning = new Promise<void>(resolve => { started = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  const removeHostState = vi.fn()
  const cleanup = vi.fn(async () => {
    started()
    await barrier // Represents pending provider/tool settlement during server.close().
    removeHostState()
  })
  const stop = createShutdown(cleanup)
  const first = stop()
  await cleaning
  const repeated = stop()
  expect(repeated).toBe(first)
  const exit = vi.fn()
  void repeated.then(exit)
  await Promise.resolve()
  expect(exit).not.toHaveBeenCalled()
  expect(removeHostState).not.toHaveBeenCalled()
  expect(cleanup).toHaveBeenCalledOnce()

  release()
  await Promise.all([first, repeated])
  expect(removeHostState).toHaveBeenCalledOnce()
  expect(exit).toHaveBeenCalledOnce()
  expect(stop()).toBe(first)
  expect(cleanup).toHaveBeenCalledOnce()
})

it('preserves a cleanup failure for every caller instead of reporting a later success', async () => {
  const failure = new Error('Cleanup failed')
  const cleanup = vi.fn(() => { throw failure })
  const stop = createShutdown(cleanup)
  const first = stop()
  const repeated = stop()
  expect(repeated).toBe(first)
  await Promise.all([
    expect(first).rejects.toBe(failure),
    expect(repeated).rejects.toBe(failure),
  ])
  await expect(stop()).rejects.toBe(failure)
  expect(cleanup).toHaveBeenCalledOnce()
})
