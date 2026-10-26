import type { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { encodeMessage } from '@latch/link-wire'
const state = vi.hoisted(() => ({ workers: [] as unknown[] }))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events'),
    { PassThrough } = await import('node:stream')
  return {
    Worker: class extends EventEmitter {
      stdout = new PassThrough()
      stderr = new PassThrough()
      terminate = vi.fn(async () => 1)
      constructor() {
        super()
        state.workers.push(this)
      }
    },
  }
})
import { solveRegistrationWork } from '../src/registration-work.ts'
type Fake = EventEmitter & { terminate: ReturnType<typeof vi.fn> }
afterEach(() => {
  state.workers.length = 0
  vi.useRealTimers()
})
it('starts termination at the wall-clock deadline but retains capacity and unsettled results until actual thread exit', async () => {
  vi.useFakeTimers()
  const input = {
    relayId: new Uint8Array(16),
    helloNonce: new Uint8Array(32),
    workNonce: new Uint8Array(32),
    register: encodeMessage({
      type: 'register',
      previous: new Uint8Array(32),
      day: 20000,
      routePub: new Uint8Array(32),
      signature: new Uint8Array(64),
      regMac: new Uint8Array(16),
      alternate: false,
    }),
    bits: 22,
    signal: new AbortController().signal,
  }
  const a = solveRegistrationWork(input),
    b = solveRegistrationWork(input)
  let settled = false
  void a.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  const rejectedA = expect(a).rejects.toThrow('unavailable'),
    rejectedB = expect(b).rejects.toThrow('unavailable')
  const workers = state.workers as Fake[]
  await vi.advanceTimersByTimeAsync(2000)
  expect(workers[0]!.terminate).toHaveBeenCalledTimes(1)
  expect(workers[1]!.terminate).toHaveBeenCalledTimes(1)
  expect(settled).toBe(false)
  await expect(solveRegistrationWork(input)).rejects.toThrow('busy')
  workers[0]!.emit('exit', 1)
  workers[1]!.emit('exit', 1)
  await rejectedA
  await rejectedB
  const fresh = solveRegistrationWork({ ...input, bits: 0 }),
    worker = state.workers.at(-1) as Fake
  worker.emit('message', new Uint8Array(8))
  worker.emit('exit', 0)
  expect(await fresh).toHaveLength(8)
})
