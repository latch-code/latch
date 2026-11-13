import { createRuntime } from '@latch/core'
import type { HarnessPlugin } from '@latch/sdk'
import type { TaskDetail } from '@latch/protocol'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TurnReceipts } from '../src/update-window.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})

describe('a retry of an accepted turn', () => {
  it('is answered from the receipt only once the driver resolved, never while the turn is still being made durable', async () => {
    let gate: Promise<void> | undefined
    let calls = 0
    const plugin: HarnessPlugin = {
      id: 'slow-commit',
      name: 'slow',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'slow-commit-model',
          name: 'slow',
          model: 'fixture',
          async *stream() {
            yield { type: 'text', text: 'ok' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
        ctx.registerHarness({
          id: 'slow-commit-harness',
          name: 'slow',
          version: '1',
          capabilities: { models: { owner: 'latch' }, modes: ['chat'] },
          create(options) {
            const bridge = createRuntime(options)
            return new Proxy(bridge, {
              get(target, key, receiver) {
                if (key === 'prompt')
                  return async (...args: Parameters<typeof bridge.prompt>) => {
                    calls++
                    // As a driver whose turn is not yet durable: the answer waits.
                    await gate
                    return target.prompt(...args)
                  }
                const value: unknown = Reflect.get(target, key, receiver)
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
          },
        })
      },
    }
    const host = await startTestHost({ plugins: [plugin] })
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' })
    const model = { providerId: 'slow-commit-model', model: 'fixture' }
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'First', mode: 'chat', harnessId: 'slow-commit-harness', model, requestId: randomUUID() },
    })
    await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'))
    let open!: () => void
    gate = new Promise(resolve => (open = resolve))
    const body = { prompt: 'Second', requestId: randomUUID() }
    const first = owner.request(`tasks/${sessionId}/prompt`, { body })
    await vi.waitFor(() => expect(calls).toBe(1))
    // The retry while the first is still on its way goes to the driver too, which answers both once.
    const retry = owner.request(`tasks/${sessionId}/prompt`, { body })
    await vi.waitFor(() => expect(calls).toBe(2))
    open()
    expect((await first).status).toBe(200)
    expect((await retry).status).toBe(200)
    // Accepted now: a later retry is answered from the receipt, without the driver.
    expect((await owner.request(`tasks/${sessionId}/prompt`, { body })).status).toBe(200)
    expect(calls).toBe(2)
    await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'))
    expect(
      (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.filter(message => message.requestId === body.requestId),
    ).toHaveLength(1)
  })

  it('keeps receipts in memory, newest first out last, so a restarted Host goes through the ordinary checks', () => {
    const receipts = new TurnReceipts(2)
    receipts.set('a', '1')
    receipts.set('b', '2')
    receipts.set('a', '1')
    receipts.set('c', '3')
    expect(['a', 'b', 'c'].map(key => receipts.get(key))).toEqual(['1', undefined, '3'])
    expect(new TurnReceipts().get('a')).toBeUndefined()
  })
})
