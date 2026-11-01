import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSnapshot, KeepWaitingResult, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelProvider } from '@latch/sdk'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A model that says a word and then stays quiet until the run is stopped. */
async function quietHost(): Promise<TestHost> {
  const provider: ModelProvider = {
    id: 'quiet-model',
    name: 'Quiet fixture',
    model: 'fake',
    async *stream({ signal }) {
      yield { type: 'text', text: 'Working' }
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true }))
    },
  }
  const plugin: HarnessPlugin = {
    id: 'quiet-fixture',
    name: 'Quiet fixture',
    version: '1',
    description: '',
    activate(context) {
      context.registerProvider(provider)
    },
  }
  const host = await startTestHost({ plugins: [plugin], providerId: provider.id })
  cleanups.push(() => host.close())
  return host
}

describe('a live run over HTTP', () => {
  it('does not make other devices read the list again for every word of a stream', async () => {
    let finish = () => {}
    const released = new Promise<void>(resolve => {
      finish = resolve
    })
    const provider: ModelProvider = {
      id: 'chatty-model',
      name: 'Chatty fixture',
      model: 'fake',
      async *stream() {
        for (let word = 0; word < 12; word++) {
          yield { type: 'text', text: `word ${word} ` }
          await delay(60)
        }
        await released
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const plugin: HarnessPlugin = {
      id: 'chatty-fixture',
      name: 'Chatty fixture',
      version: '1',
      description: '',
      activate(context) {
        context.registerProvider(provider)
      },
    }
    const t = await startTestHost({ plugins: [plugin], providerId: provider.id })
    cleanups.push(() => t.close())
    const owner = await t.enroll({ listener: 'unix' })
    const controller = new AbortController()
    const events = await owner.request('events', { signal: controller.signal })
    const reader = events.body!.getReader()
    let seen = ''
    const reading = (async () => {
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        seen += decoder.decode(value)
      }
    })().catch(() => {})
    const response = await owner.confirmed('tasks', { method: 'POST', body: { prompt: 'Go', requestId: randomUUID(), mode: 'agent' } })
    const { sessionId } = (await response.json()) as { sessionId: string }
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).liveText, { timeout: 10_000 }).toContain('word 11')
    expect(seen.split('event: tasks-invalidated').length - 1).toBeLessThanOrEqual(3)
    finish()
    controller.abort()
    await reading
  })

  it('reports what the run is doing, and 继续等 leaves a run that is not silent alone', async () => {
    const t = await quietHost()
    const owner = await t.enroll({ listener: 'unix' })
    const response = await owner.confirmed('tasks', { method: 'POST', body: { prompt: 'Go', requestId: randomUUID(), mode: 'agent' } })
    const { sessionId } = (await response.json()) as { sessionId: string }

    const snapshot = await owner.json<AppSnapshot>('snapshot')
    expect(snapshot.catalog?.features?.runLiveness).toBe(true)
    const row = snapshot.tasks.find(task => task.id === sessionId)
    expect(row?.live).toMatchObject({ activity: 'model', silenceThresholdMs: 120_000, runId: row?.runId })
    // The list carries the whole run's clock, so a row and the conversation read the same time.
    expect(row?.live?.runStartedAt).toEqual(expect.any(String))

    const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    const runId = detail.summary.runId!
    const answer = await owner.json<KeepWaitingResult>(`tasks/${sessionId}/keep-waiting`, {
      method: 'POST',
      body: { runId, thresholdMs: 120_000 },
    })
    expect(answer).toMatchObject({ outcome: 'not-silent', thresholdMs: 120_000 })

    const wrong = await owner.request(`tasks/${sessionId}/keep-waiting`, { method: 'POST', body: { thresholdMs: 0 } })
    expect(wrong.status).toBe(400)

    const other = await owner.json<KeepWaitingResult>(`tasks/${sessionId}/keep-waiting`, {
      method: 'POST',
      body: { runId: randomUUID(), thresholdMs: 120_000 },
    })
    expect(other.outcome).toBe('ended')

    await owner.json(`tasks/${sessionId}/cancel`, { method: 'POST', body: { requestId: randomUUID(), runId } })
    const after = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    expect(after.summary.status).toBe('cancelled')
    expect(after.summary.live).toBeUndefined()
  })
})
