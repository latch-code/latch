import { afterEach, expect, it } from 'vitest'
import { createRuntime } from '@latch/core'
import type { HarnessPlugin } from '@latch/sdk'
import { startFakeModels } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close()
})

it('makes the shared provider admission guard available when a driver starts during Host initialization', async () => {
  const fake = await startFakeModels({ replies: [{ text: 'Initialization reply' }] })
  cleanups.push(() => fake.close())
  let reply = ''
  const plugin: HarnessPlugin = {
    id: 'startup-model',
    name: 'Startup model',
    version: '1',
    description: '',
    activate(context) {
      context.registerHarness({
        id: 'startup-model',
        name: 'Startup model',
        version: '1',
        create(options) {
          const bridge = createRuntime(options)
          const start = bridge.start.bind(bridge)
          bridge.start = async () => {
            await start()
            const lease = options.registry.acquire('openai-compatible', { tools: false })
            try {
              const stream = lease.provider.stream({
                messages: [{ role: 'user', content: 'Initialization request' }],
                tools: [],
                signal: new AbortController().signal,
              })
              // Consume the real local response before the driver declares initialization complete.
              for await (const delta of stream) if (delta.type === 'text') reply += delta.text
            } finally {
              lease.release()
            }
          }
          return bridge
        },
      })
    },
  }
  const host = await startTestHost({
    demo: false,
    plugins: [plugin],
    harnessId: 'startup-model',
    provider: { baseURL: `${fake.origin}/v1`, apiKey: '', model: 'fake-model' },
    egressAllow: [new URL(fake.origin).host],
  })
  cleanups.push(() => host.close())
  expect(fake.requests).toHaveLength(1)
  expect(reply).toBe('Initialization reply')
})
